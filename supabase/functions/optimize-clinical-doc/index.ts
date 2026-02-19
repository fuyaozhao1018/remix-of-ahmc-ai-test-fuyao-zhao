import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import pdf from "npm:pdf-parse@1.1.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ─── Text chunking ───────────────────────────────────────────────
function chunkText(text: string, minLen = 400, maxLen = 700): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (current.length + trimmed.length + 1 <= maxLen) {
      current += (current ? "\n\n" : "") + trimmed;
    } else {
      if (current.length >= minLen) {
        chunks.push(current);
        current = trimmed;
      } else if (current.length + trimmed.length + 1 <= maxLen * 1.2) {
        current += (current ? "\n\n" : "") + trimmed;
      } else {
        if (current) chunks.push(current);
        current = trimmed;
      }
    }
  }
  if (current) chunks.push(current);

  const final: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLen) { final.push(chunk); continue; }
    const sentences = chunk.split(/(?<=[.!?])\s+/);
    let buf = "";
    for (const s of sentences) {
      if (buf.length + s.length + 1 <= maxLen) { buf += (buf ? " " : "") + s; }
      else { if (buf) final.push(buf); buf = s; }
    }
    if (buf) final.push(buf);
  }
  return final;
}

// ─── BM25-like scoring ──────────────────────────────────────────
function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length > 2);
}

function scoreBM25(query: string, chunks: string[], k = 6): string[] {
  const qTokens = tokenize(query);
  const N = chunks.length;
  if (N === 0) return [];
  const avgDl = chunks.reduce((s, c) => s + tokenize(c).length, 0) / N;
  const df: Record<string, number> = {};
  const chunkTokensList = chunks.map(c => tokenize(c));
  for (const tokens of chunkTokensList) {
    const seen = new Set(tokens);
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  const k1 = 1.5, b = 0.75;
  const scores = chunkTokensList.map((tokens, i) => {
    const dl = tokens.length;
    const tf: Record<string, number> = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const qt of qTokens) {
      if (!tf[qt]) continue;
      const idf = Math.log((N - (df[qt] || 0) + 0.5) / ((df[qt] || 0) + 0.5) + 1);
      const tfNorm = (tf[qt] * (k1 + 1)) / (tf[qt] + k1 * (1 - b + b * dl / avgDl));
      score += idf * tfNorm;
    }
    return { index: i, score };
  });
  return scores.sort((a, b) => b.score - a.score).slice(0, k).map(s => chunks[s.index]);
}

// ─── Sanitization helpers ────────────────────────────────────────
function stripMarkdown(text: string): string {
  return text.replace(/###?\s*/g, "").replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "").replace(/^[-•]\s*/gm, "");
}

function sanitizeHPI(hpi: string): string {
  return stripMarkdown(hpi).replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function sanitizeMapping(mapping: string): string {
  let text = stripMarkdown(mapping);
  // Normalize separator lines to consistent format
  text = text.replace(/\n*-{3,}\n*/g, "\n---\n");
  // If no separators exist, try to insert them between items based on "Clause:" pattern
  if (!text.includes("---")) {
    text = text.replace(/\n(?=Clause:)/g, "\n---\n");
  }
  // Ensure each item ends with separator (except last)
  const items = text.split("\n---\n").map(s => s.trim()).filter(Boolean);
  return items.join("\n---\n");
}

function sanitizeCriteria(criteria: any[]): any[] {
  return criteria.map(c => ({
    ...c,
    mcg_clause: stripMarkdown(c.mcg_clause || "").trim(),
    evidence_in_notes: stripMarkdown(c.evidence_in_notes || "").trim(),
    required_documentation: stripMarkdown(c.required_documentation || "").trim(),
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────
const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MAX_NOTES_CHARS = 15000;
const MAX_GUIDELINE_CHARS = 80000;
const AI_TIMEOUT_MS = 60000;

function errorResponse(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function handleAIStatus(status: number) {
  if (status === 429) return errorResponse("Rate limit exceeded, please try again later.", 429);
  if (status === 402) return errorResponse("Payment required. Please add credits.", 402);
  return null;
}

async function callAI(apiKey: string, messages: Array<{ role: string; content: string }>, temperature = 0.2) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const resp = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-2.5-flash", messages, temperature }),
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

async function extractAIText(resp: Response): Promise<string> {
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function extractJSON(text: string): any {
  // Try to find JSON in markdown code blocks first
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }
  // Fall back to finding raw JSON object
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

async function parsePdfBase64(base64: string, label: string): Promise<string> {
  const buf = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  try {
    const parsed = await pdf(buf);
    const text = parsed.text?.trim();
    if (!text) throw new Error("empty");
    return text;
  } catch (e) {
    throw new Error(`Unable to extract text from ${label} PDF. The file may be corrupted, password-protected, or image-only.`);
  }
}

const SYSTEM_PROMPT = `You are a clinical documentation optimization and compliance auditing assistant.
You are NOT a diagnostic system.
Use ONLY information explicitly present in the provided source notes.
Do NOT invent, infer, assume, or add medical facts.
Do NOT introduce new diagnoses or contradict the notes.
If a detail is missing, mark it as not documented or unable to determine.
Treat the MCG guideline clauses as mandatory admission documentation criteria.`;

// ─── Stage prompts ───────────────────────────────────────────────

function factsExtractionPrompt(sourceNotes: string): string {
  return `SOURCE NOTES (ER + H&P):
<<<
${sourceNotes}
>>>

Task: Extract structured facts from the source notes ONLY. Output STRICT JSON matching this schema exactly. If a field is not documented, use an empty string "" or empty array []. NEVER invent facts.

{
  "patient": { "age": "", "sex": "", "language": "", "pmh": [] },
  "timeline": [],
  "symptoms_positive": [],
  "symptoms_negative": [],
  "outpatient_tx": [],
  "vitals": {
    "bp": "", "hr": "", "rr": "", "temp": "",
    "spo2_ra": "", "spo2_on_o2": "",
    "o2_device": "", "o2_flow": ""
  },
  "exam": [],
  "imaging": [],
  "labs": [],
  "workup": [],
  "treatments_in_ed": [],
  "assessment_terms_documented": [],
  "disposition": {
    "admitted": false,
    "reason_documented": []
  }
}

Rules:
- Use ONLY source notes. If missing → empty string / empty array.
- Never invent facts.
- Return ONLY the JSON object, no other text.`;
}

function hpiFromFactsPrompt(factsJSON: string, mcgExcerpts: string): string {
  return `EXTRACTED FACTS (JSON):
<<<
${factsJSON}
>>>

MCG GUIDELINE EXCERPTS:
<<<
${mcgExcerpts}
>>>

Task: Generate a CONCISE, payer-friendly Revised History of Present Illness (HPI) using ONLY the extracted facts above.

LENGTH: 6-10 sentences total, under 1500 characters. Every sentence must support medical necessity.

REQUIRED CONTENT (weave into a single narrative paragraph):
- Chief complaint and duration
- Key associated symptoms directly relevant to the primary diagnosis
- Outpatient treatment and its failure (if documented)
- Objective ED findings relevant to severity (SpO2, oxygen requirement, RR if abnormal)
- Clinical INTERPRETATIONS supported by the notes:
  * Imaging interpretation (e.g., "CXR findings suggest right lower lobe pneumonia" if notes show infiltrate)
  * Lab interpretation (e.g., "leukocytosis with neutrophilic predominance suggests acute bacterial infection" if labs show WBC elevation + neutrophilia)
  * Oxygen interpretation (e.g., "documented hypoxemia requiring supplemental oxygen" if SpO2 drops and O2 is given)
  IMPORTANT: Only write interpretations directly supported by the provided notes. Never invent.
- ED treatments that support need for admission
- End with a concise "In summary" or "Therefore" sentence tying risks + objective findings to inpatient-level need. Example pattern: "In summary, [patient description] with [progressive symptoms], [failed outpatient therapy], [documented objective findings], and [evidence of acute condition] warrants inpatient-level management."

MUST EXCLUDE:
- Negative ROS or denial statements (no "denies chest pain", "denies fever") UNLESS they directly support medical necessity for the primary diagnosis
- Normal exam checklists or laundry lists of unremarkable findings (no "no cervical tenderness, no AROM pain, no CVAT, no murmur" etc.)
- If needed, use ONE short sentence: "Other exam findings were unremarkable as documented."
- Any facts not explicitly present in the extracted JSON

FORMAT RULES:
- Return ONE PARAGRAPH of continuous narrative text only.
- No headings, no section labels, no bullet points, no Markdown, no asterisks, no bold, no line breaks.
- Plain text only.
- Use smooth sentence transitions to connect the content naturally.

Output ONLY the revised HPI text as one paragraph.`;
}

function missingCriteriaPrompt(mcgForCriteria: string, factsJSON: string, sourceNotes: string): string {
  return `MCG CRITERIA CLAUSES:
<<<
${mcgForCriteria}
>>>

EXTRACTED FACTS (JSON):
<<<
${factsJSON}
>>>

SOURCE NOTES (for evidence quoting):
<<<
${sourceNotes}
>>>

Task: Compare each MCG guideline clause against the extracted facts AND source notes. For each clause NOT fully supported, create an entry.

Return VALID JSON ONLY in this schema:
{"missing_criteria":[{"mcg_clause":"...","status":"Not documented","evidence_in_notes":"Direct quote from source notes or 'None'","required_documentation":"What objective documentation is needed"}]}

Status values (use exactly):
- "Not documented" — not mentioned at all
- "Insufficient detail" — mentioned but missing objective specifics
- "Unable to determine" — cannot be concluded from the notes

Rules:
- evidence_in_notes must be a direct quote from SOURCE NOTES, or "None".
- Never claim criteria is met unless explicitly documented.
- Never invent facts.
- Return ONLY the JSON object.`;
}

function mappingExplanationPrompt(mcgForCriteria: string, sourceNotes: string, missingCriteriaJSON: string): string {
  return `MCG CRITERIA CLAUSES:
<<<
${mcgForCriteria}
>>>

SOURCE NOTES (ER + H&P):
<<<
${sourceNotes}
>>>

MISSING CRITERIA JSON:
<<<
${missingCriteriaJSON}
>>>

Task: Write a clear, audit-ready explanation for EACH missing criterion, in the SAME ORDER and SAME NUMBERING as the missing_criteria JSON array.

Use this EXACT template for each item (number them 1, 2, 3... matching the array order):

[number]. Clause: <mcg_clause text>
Status: <status value>
Evidence from notes: "<direct quote from source notes>" (or "None")
Why missing/insufficient: <1-2 sentences explaining the gap>
Needed documentation: <1 sentence stating what is required>

Separate each item with a line containing only three dashes: ---

Rules:
- Number each item sequentially (1, 2, 3...) matching the missing_criteria array index.
- Follow the template exactly for every item. Do not skip any field.
- Evidence must be a direct quote from the source notes in quotes, or exactly "None".
- Do not fabricate numeric thresholds unless they appear in the MCG text.
- Every statement must be traceable to source notes or the missing criteria list.
- Plain text only. No Markdown. No bullets. No asterisks. No bold. No headings. No backticks.
- Keep each explanation concise: 3-4 sentences per item maximum.

Output ONLY the explanation text.`;
}

function selfAuditPrompt(sourceNotes: string, revisedHPI: string, missingCriteriaJSON: string, mappingExplanation: string): string {
  return `SOURCE NOTES:
<<<
${sourceNotes}
>>>

Generated Revised HPI:
<<<
${revisedHPI}
>>>

Generated Missing Criteria JSON:
<<<
${missingCriteriaJSON}
>>>

Generated Explanation:
<<<
${mappingExplanation}
>>>

Task: Self-audit all generated outputs against the source notes.

Verify:
- No unsupported claims exist in the HPI or explanation
- No invented facts or diagnoses
- No contradictions with source notes
- Missing criteria statuses are accurate

Remove or revise any statement not explicitly supported by SOURCE NOTES.
If unsupported, either delete it or replace with "not documented" language.

Return corrected outputs in JSON:
{"revised_hpi":"...","missing_criteria":[...],"mapping_explanation":"..."}

Return ONLY the JSON object.`;
}

// ─── Main handler ────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { erText, erPdfBase64, hpPdfBase64, mcgPdfBase64 } = body;

    // Validate inputs
    if (!erText && !erPdfBase64) return errorResponse("ER Notes (text or PDF) are required.");
    if (!hpPdfBase64) return errorResponse("Inpatient H&P PDF is required.");
    if (!mcgPdfBase64) return errorResponse("MCG Guideline PDF is required.");

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      console.error("LOVABLE_API_KEY is not configured");
      return errorResponse("AI API key is not configured. Please contact support.", 500);
    }
    console.log("API key validated, starting processing...");

    // ── Extract text from inputs ──
    let erNotesText = "";
    if (erText) {
      erNotesText = erText.trim();
    } else {
      erNotesText = await parsePdfBase64(erPdfBase64, "ER Notes");
    }
    console.log("ER Notes extracted:", erNotesText.length, "chars");

    const hpText = await parsePdfBase64(hpPdfBase64, "H&P");
    console.log("H&P extracted:", hpText.length, "chars");

    let mcgText = await parsePdfBase64(mcgPdfBase64, "MCG Guideline");
    console.log("MCG extracted:", mcgText.length, "chars");

    // Enforce limits
    const sourceNotes = (erNotesText + "\n\n" + hpText).slice(0, MAX_NOTES_CHARS);
    if (mcgText.length > MAX_GUIDELINE_CHARS) {
      mcgText = mcgText.slice(0, MAX_GUIDELINE_CHARS);
      console.warn("MCG text truncated to", MAX_GUIDELINE_CHARS, "chars");
    }

    // ═══════════════════════════════════════════════════════════════
    // STAGE 0: Facts Extraction
    // ═══════════════════════════════════════════════════════════════
    console.log("Stage 0: Extracting structured facts...");
    const factsResp = await callAI(
      apiKey,
      [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: factsExtractionPrompt(sourceNotes) }],
      0.0
    );
    if (!factsResp.ok) {
      const handled = handleAIStatus(factsResp.status);
      if (handled) return handled;
      const errText = await factsResp.text();
      console.error("Stage 0 AI error:", factsResp.status, errText);
      throw new Error(`AI Gateway returned ${factsResp.status} during facts extraction`);
    }
    const factsRaw = await extractAIText(factsResp);
    const factsObj = extractJSON(factsRaw);
    if (!factsObj || !factsObj.patient) {
      console.error("Stage 0: Failed to parse facts JSON. Raw:", factsRaw.slice(0, 500));
      throw new Error("Failed to extract structured facts from notes. Please try again.");
    }
    const factsJSON = JSON.stringify(factsObj, null, 2);
    console.log("Stage 0 complete. Facts extracted:", factsJSON.length, "chars");

    // ═══════════════════════════════════════════════════════════════
    // STAGE 2: BM25 Guideline Retrieval
    // ═══════════════════════════════════════════════════════════════
    console.log("Stage 2: BM25 guideline retrieval...");
    const mcgChunks = chunkText(mcgText);
    console.log("MCG chunked into", mcgChunks.length, "chunks");
    const topK = scoreBM25(sourceNotes, mcgChunks, 6);
    const mcgExcerpts = topK.join("\n\n---\n\n");
    const mcgForCriteria = mcgText.length < 30000 ? mcgText : mcgExcerpts;
    console.log("Stage 2 complete. Retrieved", topK.length, "chunks");

    // ═══════════════════════════════════════════════════════════════
    // STAGE 1 + 3: HPI Generation + Missing Criteria (parallel)
    // ═══════════════════════════════════════════════════════════════
    console.log("Stage 1+3: Generating HPI and Missing Criteria in parallel...");
    const [hpiResp, criteriaResp] = await Promise.all([
      callAI(apiKey, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: hpiFromFactsPrompt(factsJSON, mcgExcerpts) }], 0.2),
      callAI(apiKey, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: missingCriteriaPrompt(mcgForCriteria, factsJSON, sourceNotes) }], 0.1),
    ]);

    for (const resp of [hpiResp, criteriaResp]) {
      if (!resp.ok) {
        const handled = handleAIStatus(resp.status);
        if (handled) return handled;
        const errText = await resp.text();
        console.error("Stage 1/3 AI error:", resp.status, errText);
        throw new Error(`AI Gateway returned ${resp.status}`);
      }
    }

    let revisedHPI = await extractAIText(hpiResp);
    const criteriaContent = await extractAIText(criteriaResp);
    console.log("Stage 1 complete. HPI:", revisedHPI.length, "chars");
    console.log("Stage 3 complete. Criteria response:", criteriaContent.length, "chars");

    // ── Parse missing criteria with retry ──
    const validStatuses = new Set(["Not documented", "Insufficient detail", "Unable to determine"]);
    let missingCriteria: Array<{
      mcg_clause: string; status: string;
      evidence_in_notes: string; required_documentation: string;
    }> = [];
    let criteriaParsed = false;

    const criteriaObj = extractJSON(criteriaContent);
    if (criteriaObj && Array.isArray(criteriaObj.missing_criteria)) {
      missingCriteria = criteriaObj.missing_criteria;
      criteriaParsed = true;
    }

    if (!criteriaParsed) {
      console.warn("Stage 3: First criteria parse failed, retrying...");
      const retryPrompt = `Your previous response was not valid JSON. Respond with ONLY a JSON object.
EXTRACTED FACTS:\n${factsJSON}\nMCG GUIDELINE:\n${mcgForCriteria}
Respond EXACTLY: {"missing_criteria":[{"mcg_clause":"...","status":"Not documented","evidence_in_notes":"...","required_documentation":"..."}]}`;
      const retryResp = await callAI(apiKey, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: retryPrompt }], 0.0);
      if (retryResp.ok) {
        const retryText = await extractAIText(retryResp);
        const retryObj = extractJSON(retryText);
        if (retryObj && Array.isArray(retryObj.missing_criteria)) {
          missingCriteria = retryObj.missing_criteria;
        }
      }
    }

    // Validate statuses
    missingCriteria = missingCriteria.filter(c => c.mcg_clause && validStatuses.has(c.status));
    console.log("Stage 3: Validated", missingCriteria.length, "missing criteria items");

    // ═══════════════════════════════════════════════════════════════
    // STAGE 4: Mapping Explanation
    // ═══════════════════════════════════════════════════════════════
    console.log("Stage 4: Generating mapping explanation...");
    const mappingResp = await callAI(
      apiKey,
      [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: mappingExplanationPrompt(mcgForCriteria, sourceNotes, JSON.stringify(missingCriteria)) }],
      0.2
    );
    if (!mappingResp.ok) {
      const handled = handleAIStatus(mappingResp.status);
      if (handled) return handled;
      throw new Error(`AI Gateway returned ${mappingResp.status}`);
    }
    const mappingExplanation = await extractAIText(mappingResp);
    console.log("Stage 4 complete. Mapping:", mappingExplanation.length, "chars");

    // ═══════════════════════════════════════════════════════════════
    // STAGE 5: Self-Audit
    // ═══════════════════════════════════════════════════════════════
    console.log("Stage 5: Running self-audit...");
    const auditResp = await callAI(
      apiKey,
      [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: selfAuditPrompt(sourceNotes, revisedHPI, JSON.stringify(missingCriteria), mappingExplanation) }],
      0.1
    );
    if (auditResp.ok) {
      const auditText = await extractAIText(auditResp);
      const audited = extractJSON(auditText);
      if (audited) {
        if (audited.revised_hpi) revisedHPI = audited.revised_hpi;
        if (Array.isArray(audited.missing_criteria)) {
          missingCriteria = audited.missing_criteria.filter(
            (c: any) => c.mcg_clause && validStatuses.has(c.status)
          );
        }
        if (audited.mapping_explanation) {
          revisedHPI = sanitizeHPI(revisedHPI);
          const sanitizedMapping = sanitizeMapping(audited.mapping_explanation);
          missingCriteria = sanitizeCriteria(missingCriteria);
          console.log("Stage 5 complete. Self-audit applied. Output sizes:", {
            hpi: revisedHPI.length,
            criteria: missingCriteria.length,
            mapping: sanitizedMapping.length,
          });
          return new Response(JSON.stringify({
            revised_hpi: revisedHPI,
            missing_criteria: missingCriteria,
            mapping_explanation: sanitizedMapping,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
      console.warn("Stage 5: Self-audit JSON parse failed, using pre-audit outputs");
    } else {
      console.warn("Stage 5: Self-audit call failed, using pre-audit outputs");
    }

    // ── Final validation ──
    if (!revisedHPI || !mappingExplanation) {
      console.error("Incomplete AI output", { hpi: !!revisedHPI, criteria: missingCriteria.length, mapping: !!mappingExplanation });
      throw new Error("Incomplete AI output. Please try again.");
    }

    // ── Sanitize all outputs ──
    revisedHPI = sanitizeHPI(revisedHPI);
    let finalMapping = sanitizeMapping(mappingExplanation);
    missingCriteria = sanitizeCriteria(missingCriteria);

    console.log("AI success (pre-audit). Output sizes:", {
      hpi: revisedHPI.length,
      criteria: missingCriteria.length,
      mapping: finalMapping.length,
    });

    return new Response(JSON.stringify({
      revised_hpi: revisedHPI,
      missing_criteria: missingCriteria,
      mapping_explanation: finalMapping,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    if (error.name === "AbortError") {
      console.error("AI call timed out after", AI_TIMEOUT_MS, "ms");
      return errorResponse("AI processing timed out. Please try again with shorter documents.", 504);
    }
    console.error("Error in optimize-clinical-doc:", error);
    return new Response(
      JSON.stringify({ error: error.message || "An unexpected error occurred." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
