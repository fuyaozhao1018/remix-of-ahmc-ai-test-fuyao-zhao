import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import pdf from "npm:pdf-parse/lib/pdf-parse.js";

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

// ─── Helpers ─────────────────────────────────────────────────────
const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MAX_NOTES_CHARS = 15000;
const MAX_GUIDELINE_CHARS = 80000;

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
  return fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "google/gemini-2.5-flash", messages, temperature }),
  });
}

async function extractAIText(resp: Response): Promise<string> {
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
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
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    // 1) Acquire ER Notes text
    let erNotesText = "";
    if (erText) {
      erNotesText = erText.trim();
    } else {
      erNotesText = await parsePdfBase64(erPdfBase64, "ER Notes");
    }

    // 2) Extract H&P text
    const hpText = await parsePdfBase64(hpPdfBase64, "H&P");

    // 3) Extract MCG text
    let mcgText = await parsePdfBase64(mcgPdfBase64, "MCG Guideline");

    // Enforce limits
    const sourceNotes = (erNotesText + "\n\n" + hpText).slice(0, MAX_NOTES_CHARS);
    if (mcgText.length > MAX_GUIDELINE_CHARS) {
      mcgText = mcgText.slice(0, MAX_GUIDELINE_CHARS);
      console.warn("MCG text truncated to", MAX_GUIDELINE_CHARS, "chars");
    }

    // 4) Chunk MCG & retrieve topK
    const mcgChunks = chunkText(mcgText);
    const topK = scoreBM25(sourceNotes, mcgChunks, 6);
    const mcgExcerpts = topK.join("\n\n---\n\n");
    const mcgForCriteria = mcgText.length < 30000 ? mcgText : mcgExcerpts;

    // ═══ Prompt A: Revised HPI ═══
    const hpiPrompt = `MCG excerpts:
<<<
${mcgExcerpts}
>>>

SOURCE NOTES (ER + H&P):
<<<
${sourceNotes}
>>>

Task:
Rewrite the History of Present Illness (HPI) into a clear, professional, logically organized narrative.

Requirements:
- Preserve all documented facts.
- Improve structure and clarity.
- Align wording with relevant MCG terms when appropriate.
- Emphasize documented severity indicators (only if explicitly documented).
- Do NOT add new facts, symptoms, labs, imaging, diagnoses, or assumptions.

Output ONLY the revised HPI text.`;

    // ═══ Prompt B: Missing Criteria (strict JSON) ═══
    const criteriaPrompt = `MCG criteria clauses:
<<<
${mcgForCriteria}
>>>

SOURCE NOTES (ER + H&P):
<<<
${sourceNotes}
>>>

Task:
Compare SOURCE NOTES against the MCG criteria.
For each MCG clause that is NOT fully supported by the notes, create an entry.

Statuses:
- Not documented: not mentioned at all
- Insufficient detail: mentioned but missing objective specifics
- Unable to determine: cannot be concluded from the notes

Return VALID JSON ONLY in this schema:
{"missing_criteria":[{"mcg_clause":"...","status":"Not documented","evidence_in_notes":"Quote snippet from notes or 'None'","required_documentation":"What objective documentation is needed (do not claim it exists)"}]}

Rules:
- Evidence must come directly from SOURCE NOTES or be 'None'.
- Do NOT invent facts.
- Do NOT claim the patient meets missing criteria.`;

    // Run HPI + Criteria in parallel
    const [hpiResp, criteriaResp] = await Promise.all([
      callAI(apiKey, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: hpiPrompt }], 0.2),
      callAI(apiKey, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: criteriaPrompt }], 0.1),
    ]);

    for (const resp of [hpiResp, criteriaResp]) {
      if (!resp.ok) {
        const handled = handleAIStatus(resp.status);
        if (handled) return handled;
        const errText = await resp.text();
        console.error("AI error:", resp.status, errText);
        throw new Error(`AI Gateway returned ${resp.status}`);
      }
    }

    let revisedHPI = await extractAIText(hpiResp);
    const criteriaContent = await extractAIText(criteriaResp);

    // ── Parse missing criteria with retry ──
    let missingCriteria: Array<{
      mcg_clause: string; status: string;
      evidence_in_notes: string; required_documentation: string;
    }> = [];
    let criteriaParsed = false;

    try {
      const m = criteriaContent.match(/\{[\s\S]*\}/);
      if (m) {
        const obj = JSON.parse(m[0]);
        if (Array.isArray(obj.missing_criteria)) { missingCriteria = obj.missing_criteria; criteriaParsed = true; }
      }
    } catch { console.warn("First criteria parse failed, retrying..."); }

    if (!criteriaParsed) {
      const retryPrompt = `Your previous response was not valid JSON. Respond with ONLY a JSON object.
DOCTOR NOTES:\n${sourceNotes}\nMCG GUIDELINE:\n${mcgForCriteria}
Respond EXACTLY: {"missing_criteria":[{"mcg_clause":"...","status":"Not documented","evidence_in_notes":"...","required_documentation":"..."}]}`;
      const retryResp = await callAI(apiKey, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: retryPrompt }], 0.0);
      if (retryResp.ok) {
        const retryText = await extractAIText(retryResp);
        try {
          const m = retryText.match(/\{[\s\S]*\}/);
          if (m) { const obj = JSON.parse(m[0]); if (Array.isArray(obj.missing_criteria)) missingCriteria = obj.missing_criteria; }
        } catch { console.error("Retry parse also failed"); }
      }
    }

    // Validate statuses
    const validStatuses = new Set(["Not documented", "Insufficient detail", "Unable to determine"]);
    missingCriteria = missingCriteria.filter(c => c.mcg_clause && validStatuses.has(c.status));

    // ═══ Prompt C: Mapping Explanation ═══
    const mappingPrompt = `MCG criteria clauses:
<<<
${mcgForCriteria}
>>>

SOURCE NOTES (ER + H&P):
<<<
${sourceNotes}
>>>

Missing criteria JSON:
<<<
${JSON.stringify(missingCriteria)}
>>>

Task:
Write a clear explanation that maps MCG clauses to documentation evidence.

Requirements:
- For each missing item, explain:
  (1) the MCG clause,
  (2) whether there is any supporting evidence in the notes (or explicitly state 'not documented'),
  (3) why it is missing/insufficient,
  (4) what documentation would be needed.
- Keep it audit-ready and traceable.
- Do NOT invent facts.

Output only the explanation text.`;

    const mappingResp = await callAI(apiKey, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: mappingPrompt }], 0.2);
    if (!mappingResp.ok) {
      const handled = handleAIStatus(mappingResp.status);
      if (handled) return handled;
      throw new Error(`AI Gateway returned ${mappingResp.status}`);
    }
    const mappingExplanation = await extractAIText(mappingResp);

    // ═══ Prompt D: Self-Audit ═══
    const auditPrompt = `SOURCE NOTES:
<<<
${sourceNotes}
>>>

Generated Revised HPI:
<<<
${revisedHPI}
>>>

Generated Missing Criteria JSON:
<<<
${JSON.stringify(missingCriteria)}
>>>

Generated Explanation:
<<<
${mappingExplanation}
>>>

Task:
Remove or revise any statement that is not explicitly supported by SOURCE NOTES.
If unsupported, either delete it or replace it with 'not documented' language.

Return corrected outputs in JSON:
{"revised_hpi":"...","missing_criteria":[...],"mapping_explanation":"..."}

Return JSON only.`;

    const auditResp = await callAI(apiKey, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: auditPrompt }], 0.1);
    if (auditResp.ok) {
      const auditText = await extractAIText(auditResp);
      try {
        const m = auditText.match(/\{[\s\S]*\}/);
        if (m) {
          const audited = JSON.parse(m[0]);
          if (audited.revised_hpi) revisedHPI = audited.revised_hpi;
          if (Array.isArray(audited.missing_criteria)) {
            missingCriteria = audited.missing_criteria.filter(
              (c: any) => c.mcg_clause && validStatuses.has(c.status)
            );
          }
          if (audited.mapping_explanation) {
            return new Response(JSON.stringify({
              revised_hpi: revisedHPI,
              missing_criteria: missingCriteria,
              mapping_explanation: audited.mapping_explanation,
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
      } catch { console.warn("Self-audit JSON parse failed, using pre-audit outputs"); }
    }

    return new Response(JSON.stringify({
      revised_hpi: revisedHPI,
      missing_criteria: missingCriteria,
      mapping_explanation: mappingExplanation,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Error in optimize-clinical-doc:", error);
    return new Response(
      JSON.stringify({ error: error.message || "An unexpected error occurred." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
