import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import pdf from "npm:pdf-parse/lib/pdf-parse.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── Text chunking ───────────────────────────────────────────────
function chunkText(text: string, minLen = 400, maxLen = 700): string[] {
  // Normalize whitespace
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();

  // Split on paragraph breaks first
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
        // Allow slight overflow to keep chunk above min
        current += (current ? "\n\n" : "") + trimmed;
      } else {
        if (current) chunks.push(current);
        current = trimmed;
      }
    }
  }
  if (current) chunks.push(current);

  // If a chunk is still too long, split by sentences
  const final: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLen) {
      final.push(chunk);
      continue;
    }
    const sentences = chunk.split(/(?<=[.!?])\s+/);
    let buf = "";
    for (const s of sentences) {
      if (buf.length + s.length + 1 <= maxLen) {
        buf += (buf ? " " : "") + s;
      } else {
        if (buf) final.push(buf);
        buf = s;
      }
    }
    if (buf) final.push(buf);
  }

  return final;
}

// ─── Simple BM25-like keyword scoring (no embeddings API needed) ─
function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length > 2);
}

function scoreBM25(query: string, chunks: string[], k = 5): string[] {
  const qTokens = tokenize(query);
  const N = chunks.length;
  const avgDl = chunks.reduce((s, c) => s + tokenize(c).length, 0) / N;

  // Document frequency
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

  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => chunks[s.index]);
}

// ─── Helpers ─────────────────────────────────────────────────────
const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MAX_NOTES_CHARS = 15000;
const MAX_GUIDELINE_CHARS = 80000;

function errorResponse(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function handleAIStatus(status: number) {
  if (status === 429) return errorResponse("Rate limit exceeded, please try again later.", 429);
  if (status === 402) return errorResponse("Payment required. Please add credits.", 402);
  return null;
}

async function callAI(apiKey: string, messages: Array<{role: string; content: string}>, temperature = 0.2) {
  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages,
      temperature,
    }),
  });
  return resp;
}

// ─── Main handler ────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { notes, pdfBase64 } = await req.json();

    if (!notes || !pdfBase64) {
      return errorResponse("notes and pdfBase64 are required");
    }

    if (notes.length > MAX_NOTES_CHARS) {
      return errorResponse(`Notes exceed maximum length of ${MAX_NOTES_CHARS} characters.`);
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    // 1) Extract text from PDF
    const pdfBuffer = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
    let guidelineText: string;
    try {
      const parsed = await pdf(pdfBuffer);
      guidelineText = parsed.text?.trim();
    } catch (e) {
      console.error("PDF parse error:", e);
      return errorResponse("Unable to extract text from PDF. The file may be corrupted or password-protected.");
    }

    if (!guidelineText) {
      return errorResponse("Unable to extract text from PDF. The file may contain only images (OCR not supported).");
    }

    if (guidelineText.length > MAX_GUIDELINE_CHARS) {
      guidelineText = guidelineText.slice(0, MAX_GUIDELINE_CHARS);
      console.warn("Guideline text truncated to", MAX_GUIDELINE_CHARS, "chars");
    }

    // 2) Chunk guideline text
    const chunks = chunkText(guidelineText);

    // 3) Retrieve top-K chunks via BM25 scoring
    const topK = scoreBM25(notes, chunks, 5);
    const guidelineExcerpts = topK.join("\n\n---\n\n");

    // 4A) Call A: Generate Revised HPI
    const hpiPrompt = `You are a clinical documentation improvement specialist.

STRICT RULES — VIOLATION OF ANY RULE INVALIDATES YOUR OUTPUT:
- ONLY use facts EXPLICITLY stated in the doctor's notes below. Every clinical statement must be directly traceable to the notes.
- Do NOT add, infer, assume, or fabricate ANY clinical findings, diagnoses, lab values, vital signs, symptoms, or details not present in the notes.
- Do NOT introduce new diagnoses or conditions.
- Do NOT speculate about patient history, timeline, or severity beyond what is explicitly stated.
- Restructure and enhance the language for clinical completeness, using the guideline excerpts to inform structure and emphasis ONLY.
- Output ONLY the revised HPI text. No preamble, no explanation, no headers.

DOCTOR NOTES:
${notes}

RELEVANT GUIDELINE EXCERPTS:
${guidelineExcerpts}

Respond with ONLY the revised HPI text.`;

    // 4B) Call B: Generate Missing Criteria List
    const criteriaContext = guidelineText.length < 30000 ? guidelineText : guidelineExcerpts;
    const criteriaPrompt = `You are a clinical documentation gap analyst. Your output MUST be valid JSON and nothing else.

Analyze the doctor's notes against the MCG guideline and identify criteria that are NOT documented or INSUFFICIENTLY documented.

RULES:
- Only list criteria relevant to the patient's condition as described in the notes.
- "what_to_document" must be guidance for the physician on WHAT to document—it must NOT claim the patient has or doesn't have a condition.
- "status" must be EXACTLY one of: "Not mentioned", "Insufficient detail", "Unable to determine"
- Your entire response must be a single JSON object. No markdown, no code fences, no explanation.

DOCTOR NOTES:
${notes}

MCG GUIDELINE:
${criteriaContext}

OUTPUT FORMAT (respond with ONLY this JSON, nothing else):
{"missing_criteria":[{"criterion":"...","status":"Not mentioned","what_to_document":"..."}]}`;

    // Run both LLM calls in parallel
    const [hpiResponse, criteriaResponse] = await Promise.all([
      callAI(apiKey, [{ role: "user", content: hpiPrompt }], 0.2),
      callAI(apiKey, [{ role: "user", content: criteriaPrompt }], 0.1),
    ]);

    // Check rate limit / payment errors
    for (const resp of [hpiResponse, criteriaResponse]) {
      if (!resp.ok) {
        const handled = handleAIStatus(resp.status);
        if (handled) return handled;
        const errText = await resp.text();
        console.error("AI call error:", resp.status, errText);
        throw new Error(`AI Gateway returned ${resp.status}`);
      }
    }

    const hpiData = await hpiResponse.json();
    let revisedHPI = hpiData.choices?.[0]?.message?.content?.trim() || "";

    // ── Self-audit guardrail: verify HPI fidelity ──
    if (revisedHPI) {
      const auditPrompt = `You are a strict clinical documentation auditor.

Compare the REVISED HPI below against the ORIGINAL DOCTOR NOTES. 
Remove or correct ANY statement in the revised HPI that is NOT explicitly supported by the original notes.
Do not add anything new. Only remove unsupported statements and return the cleaned HPI.

If the revised HPI is faithful to the notes, return it unchanged.

ORIGINAL DOCTOR NOTES:
${notes}

REVISED HPI TO AUDIT:
${revisedHPI}

Respond with ONLY the cleaned revised HPI text. No preamble, no explanation.`;

      const auditResp = await callAI(apiKey, [{ role: "user", content: auditPrompt }], 0.1);
      if (auditResp.ok) {
        const auditData = await auditResp.json();
        const audited = auditData.choices?.[0]?.message?.content?.trim();
        if (audited) revisedHPI = audited;
      } else {
        console.warn("Self-audit call failed, using unaudited HPI. Status:", auditResp.status);
      }
    }

    // ── Parse missing criteria JSON with retry guardrail ──
    const criteriaData = await criteriaResponse.json();
    const criteriaContent = criteriaData.choices?.[0]?.message?.content?.trim() || "";

    let missingCriteria: Array<{ criterion: string; status: string; what_to_document: string }> = [];
    let parsed = false;

    try {
      const jsonMatch = criteriaContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const obj = JSON.parse(jsonMatch[0]);
        if (Array.isArray(obj.missing_criteria)) {
          missingCriteria = obj.missing_criteria;
          parsed = true;
        }
      }
    } catch (e) {
      console.warn("First criteria parse failed, retrying...");
    }

    // Retry once with stricter instruction if parse failed
    if (!parsed) {
      console.log("Retrying missing criteria with stricter prompt...");
      const retryPrompt = `Your previous response was not valid JSON. You MUST respond with ONLY a JSON object. No markdown code fences. No explanation. No text before or after.

Given these doctor notes and guideline, return missing criteria.

DOCTOR NOTES:
${notes}

MCG GUIDELINE:
${criteriaContext}

Respond with EXACTLY this structure and nothing else:
{"missing_criteria":[{"criterion":"string","status":"Not mentioned","what_to_document":"string"}]}

Your ENTIRE response must start with { and end with }. No other characters.`;

      const retryResp = await callAI(apiKey, [{ role: "user", content: retryPrompt }], 0.0);
      if (retryResp.ok) {
        const retryData = await retryResp.json();
        const retryContent = retryData.choices?.[0]?.message?.content?.trim() || "";
        try {
          const jsonMatch = retryContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const obj = JSON.parse(jsonMatch[0]);
            if (Array.isArray(obj.missing_criteria)) {
              missingCriteria = obj.missing_criteria;
            }
          }
        } catch (e) {
          console.error("Retry criteria parse also failed:", retryContent);
        }
      }
    }

    // Validate status values
    const validStatuses = new Set(["Not mentioned", "Insufficient detail", "Unable to determine"]);
    missingCriteria = missingCriteria
      .filter(c => c.criterion && c.what_to_document && validStatuses.has(c.status));

    // 5) Return combined payload
    const payload = {
      revised_hpi: revisedHPI,
      missing_criteria: missingCriteria,
      debug: { top_k_chunks: topK },
    };

    return new Response(JSON.stringify(payload), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in optimize-clinical-doc:", error);
    return new Response(
      JSON.stringify({ error: error.message || "An unexpected error occurred. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
