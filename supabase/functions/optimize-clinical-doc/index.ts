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

// ─── Main handler ────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { notes, pdfBase64, pdfFileName } = await req.json();

    if (!notes || !pdfBase64) {
      return new Response(
        JSON.stringify({ error: "notes and pdfBase64 are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
      return new Response(
        JSON.stringify({ error: "Unable to extract text from PDF." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!guidelineText) {
      return new Response(
        JSON.stringify({ error: "Unable to extract text from PDF." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2) Chunk guideline text
    const chunks = chunkText(guidelineText);

    // 3) Retrieve top-K chunks via BM25 scoring
    const topK = scoreBM25(notes, chunks, 5);
    const guidelineExcerpts = topK.join("\n\n---\n\n");

    // 4A) Call A: Generate Revised HPI
    const hpiPrompt = `You are a clinical documentation improvement specialist.

STRICT RULES:
- Only use facts EXPLICITLY stated in the doctor's notes below.
- Do NOT add, infer, or fabricate any clinical findings, diagnoses, or details not present in the notes.
- Do NOT introduce new diagnoses.
- Restructure and enhance the language for clinical completeness, using the guideline excerpts to inform structure and emphasis.
- Output ONLY the revised HPI text. No preamble, no explanation.

DOCTOR NOTES:
${notes}

RELEVANT GUIDELINE EXCERPTS:
${guidelineExcerpts}

Respond with ONLY the revised HPI text.`;

    // 4B) Call B: Generate Missing Criteria List
    // Use full guideline text if under 30k chars, otherwise use chunks
    const criteriaContext = guidelineText.length < 30000 ? guidelineText : guidelineExcerpts;
    const criteriaPrompt = `You are a clinical documentation gap analyst.

Analyze the doctor's notes against the MCG guideline and identify criteria that are NOT documented or INSUFFICIENTLY documented.

RULES:
- Only list criteria that are relevant to the patient's condition as described in the notes.
- "what_to_document" must be guidance for the physician on WHAT to document—it must NOT claim the patient has or doesn't have a condition.
- "status" must be exactly one of: "Not mentioned", "Insufficient detail", "Unable to determine"
- Return ONLY valid JSON, no other text.

DOCTOR NOTES:
${notes}

MCG GUIDELINE:
${criteriaContext}

Respond with ONLY this JSON format:
{"missing_criteria":[{"criterion":"...","status":"Not mentioned","what_to_document":"..."}]}`;

    const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // Run both LLM calls in parallel
    const [hpiResponse, criteriaResponse] = await Promise.all([
      fetch(AI_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: hpiPrompt }],
          temperature: 0.2,
        }),
      }),
      fetch(AI_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: criteriaPrompt }],
          temperature: 0.1,
        }),
      }),
    ]);

    if (!hpiResponse.ok) {
      const status = hpiResponse.status;
      if (status === 429) return new Response(JSON.stringify({ error: "Rate limit exceeded, please try again later." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (status === 402) return new Response(JSON.stringify({ error: "Payment required. Please add credits." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const errText = await hpiResponse.text();
      console.error("HPI call error:", errText);
      throw new Error(`AI Gateway returned ${status} for HPI call`);
    }

    if (!criteriaResponse.ok) {
      const status = criteriaResponse.status;
      if (status === 429) return new Response(JSON.stringify({ error: "Rate limit exceeded, please try again later." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (status === 402) return new Response(JSON.stringify({ error: "Payment required. Please add credits." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const errText = await criteriaResponse.text();
      console.error("Criteria call error:", errText);
      throw new Error(`AI Gateway returned ${status} for criteria call`);
    }

    const hpiData = await hpiResponse.json();
    const revisedHPI = hpiData.choices?.[0]?.message?.content?.trim() || "";

    const criteriaData = await criteriaResponse.json();
    const criteriaContent = criteriaData.choices?.[0]?.message?.content?.trim() || "";

    // Parse missing criteria JSON
    let missingCriteria: Array<{ criterion: string; status: string; what_to_document: string }> = [];
    try {
      const jsonMatch = criteriaContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        missingCriteria = parsed.missing_criteria || [];
      }
    } catch (e) {
      console.error("Failed to parse criteria JSON:", criteriaContent);
    }

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
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
