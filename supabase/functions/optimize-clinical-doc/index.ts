import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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
    if (!apiKey) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    const systemPrompt = `You are a clinical documentation optimization assistant. You will be given:
1. Raw doctor notes (HPI - History of Present Illness)
2. Content from an MCG (Milliman Care Guidelines) PDF

Your task:
- Revise the HPI to be more complete, structured, and aligned with the MCG criteria.
- Identify any missing criteria from the MCG guideline that are not addressed in the doctor's notes.

Respond ONLY with valid JSON in this exact format:
{
  "revisedHPI": "The revised, improved HPI text...",
  "missingCriteria": ["Missing criterion 1", "Missing criterion 2"]
}

Do not include any text outside the JSON object.`;

    const userMessage = `Doctor Raw Notes:
${notes}

MCG Guideline PDF content (base64-encoded, filename: ${pdfFileName}):
The PDF has been provided. Please analyze its content along with the notes above.`;

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: userMessage },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:application/pdf;base64,${pdfBase64}`,
                  },
                },
              ],
            },
          ],
          temperature: 0.3,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI Gateway error:", errText);
      throw new Error(`AI Gateway returned ${response.status}`);
    }

    const aiData = await response.json();
    const content = aiData.choices?.[0]?.message?.content || "";

    // Parse the JSON from the AI response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Failed to parse AI response as JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return new Response(JSON.stringify(parsed), {
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
