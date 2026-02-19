import { useState, useRef } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useClinical, ClinicalResult } from "@/contexts/ClinicalContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, FileText, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import AppHeader from "@/components/AppHeader";

// Re-export types for backward compat
export type { MissingCriterion, ClinicalResult } from "@/contexts/ClinicalContext";

async function fileToBase64(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  return btoa(
    new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
  );
}

const PROGRESS_STEPS = [
  "Extracting text from uploaded PDFs...",
  "Extracting key clinical facts from notes...",
  "Retrieving relevant MCG guideline criteria...",
  "Generating payer-friendly HPI & analyzing missing criteria...",
  "Building mapping explanation for each criterion...",
  "Running self-audit against source notes...",
];

const ClinicalInput = () => {
  const { user, loading } = useAuth();
  const { setResult, isProcessing, setIsProcessing, progressStep, setProgressStep } = useClinical();
  const navigate = useNavigate();
  const erFileRef = useRef<HTMLInputElement>(null);
  const hpFileRef = useRef<HTMLInputElement>(null);
  const mcgFileRef = useRef<HTMLInputElement>(null);

  const [erMode, setErMode] = useState<"upload" | "text">("upload");
  const [erText, setErText] = useState("");
  const [erFile, setErFile] = useState<File | null>(null);
  const [erFileName, setErFileName] = useState("");
  const [hpFile, setHpFile] = useState<File | null>(null);
  const [hpFileName, setHpFileName] = useState("");
  const [mcgFile, setMcgFile] = useState<File | null>(null);
  const [mcgFileName, setMcgFileName] = useState("");
  const [error, setError] = useState("");

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  const handlePdfSelect = (
    e: React.ChangeEvent<HTMLInputElement>,
    setFile: (f: File | null) => void,
    setName: (n: string) => void
  ) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (selected.type !== "application/pdf") {
      setError("Only PDF files are accepted.");
      return;
    }
    setError("");
    setFile(selected);
    setName(selected.name);
  };

  const handleGenerate = async () => {
    console.log("handleGenerate called", { erMode, erFile: !!erFile, erText: erText.length, hpFile: !!hpFile, mcgFile: !!mcgFile });

    if (erMode === "upload" && !erFile) { setError("ER Notes PDF is required."); return; }
    if (erMode === "text" && !erText.trim()) { setError("ER Notes text is required."); return; }
    if (!hpFile) { setError("Inpatient H&P PDF is required."); return; }
    if (!mcgFile) { setError("MCG Guideline PDF is required."); return; }

    setError("");
    setIsProcessing(true);
    setProgressStep(0);

    try {
      const progressInterval = setInterval(() => {
        setProgressStep((prev: number) => Math.min(prev + 1, PROGRESS_STEPS.length - 1));
      }, 4000);

      const body: Record<string, string> = {};
      if (erMode === "text") {
        body.erText = erText;
      } else {
        body.erPdfBase64 = await fileToBase64(erFile!);
      }
      body.hpPdfBase64 = await fileToBase64(hpFile!);
      body.mcgPdfBase64 = await fileToBase64(mcgFile!);

      const { data, error: fnError } = await supabase.functions.invoke("optimize-clinical-doc", { body });

      clearInterval(progressInterval);

      if (fnError) throw fnError;

      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      if (parsed?.error) throw new Error(parsed.error);

      if (!parsed?.revised_hpi || !Array.isArray(parsed?.missing_criteria) || !parsed?.mapping_explanation) {
        throw new Error("Invalid response shape from backend.");
      }

      const result: ClinicalResult = parsed;
      setResult(result);

      // Only navigate after result is confirmed set
      if (result?.revised_hpi) {
        navigate("/clinical-output", { replace: true });
      }
    } catch (err: any) {
      setError(err.message || "An error occurred while processing.");
    } finally {
      setIsProcessing(false);
    }
  };

  const progressPercent = ((progressStep + 1) / PROGRESS_STEPS.length) * 100;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-8 text-3xl font-bold text-foreground">Clinical Document Optimizer</h1>

        <div className="space-y-6">
          {/* ── A) ER Notes ── */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">
              ER Notes <span className="text-destructive">*</span>
            </Label>
            <RadioGroup
              value={erMode}
              onValueChange={(v) => setErMode(v as "upload" | "text")}
              className="flex gap-4"
              disabled={isProcessing}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="upload" id="er-upload" />
                <Label htmlFor="er-upload" className="cursor-pointer text-sm">Upload PDF</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="text" id="er-text" />
                <Label htmlFor="er-text" className="cursor-pointer text-sm">Paste Text</Label>
              </div>
            </RadioGroup>

            {erMode === "upload" ? (
              <div>
                <div
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-input bg-background px-4 py-3 transition-colors hover:bg-accent"
                  onClick={() => !isProcessing && erFileRef.current?.click()}
                >
                  <Upload className="h-5 w-5 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {erFileName || "Click to upload ER Notes PDF"}
                  </span>
                  <input
                    ref={erFileRef}
                    type="file"
                    accept=".pdf,application/pdf"
                    className="hidden"
                    onChange={(e) => handlePdfSelect(e, setErFile, setErFileName)}
                    disabled={isProcessing}
                  />
                </div>
                {erFileName && (
                  <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                    <FileText className="h-4 w-4" /> <span>{erFileName}</span>
                  </div>
                )}
              </div>
            ) : (
              <Textarea
                placeholder="Paste the ER notes here..."
                className="min-h-[180px] resize-y"
                value={erText}
                onChange={(e) => setErText(e.target.value)}
                disabled={isProcessing}
              />
            )}
          </div>

          {/* ── B) Inpatient H&P ── */}
          <div className="space-y-2">
            <Label className="text-base font-semibold">
              Inpatient H&P PDF <span className="text-destructive">*</span>
            </Label>
            <div
              className="flex cursor-pointer items-center gap-3 rounded-md border border-input bg-background px-4 py-3 transition-colors hover:bg-accent"
              onClick={() => !isProcessing && hpFileRef.current?.click()}
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {hpFileName || "Click to upload H&P PDF"}
              </span>
              <input
                ref={hpFileRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => handlePdfSelect(e, setHpFile, setHpFileName)}
                disabled={isProcessing}
              />
            </div>
            {hpFileName && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" /> <span>{hpFileName}</span>
              </div>
            )}
          </div>

          {/* ── C) MCG Guideline ── */}
          <div className="space-y-2">
            <Label className="text-base font-semibold">
              MCG Guideline PDF <span className="text-destructive">*</span>
            </Label>
            <div
              className="flex cursor-pointer items-center gap-3 rounded-md border border-input bg-background px-4 py-3 transition-colors hover:bg-accent"
              onClick={() => !isProcessing && mcgFileRef.current?.click()}
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {mcgFileName || "Click to upload MCG Guideline PDF"}
              </span>
              <input
                ref={mcgFileRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => handlePdfSelect(e, setMcgFile, setMcgFileName)}
                disabled={isProcessing}
              />
            </div>
            {mcgFileName && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" /> <span>{mcgFileName}</span>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Progress */}
          {isProcessing && (
            <div className="space-y-2 rounded-md border border-border bg-muted/50 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {PROGRESS_STEPS[progressStep]}
              </div>
              <Progress value={progressPercent} className="h-2" />
              <p className="text-xs text-muted-foreground">
                Step {progressStep + 1} of {PROGRESS_STEPS.length}
              </p>
            </div>
          )}

          {/* Generate Button */}
          <Button onClick={handleGenerate} disabled={isProcessing} className="w-full" size="lg">
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              "Generate"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ClinicalInput;
