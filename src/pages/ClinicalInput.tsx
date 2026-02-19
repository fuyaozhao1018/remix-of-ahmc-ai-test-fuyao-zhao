import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, Upload, FileText, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export interface MissingCriterion {
  mcg_clause: string;
  status: "Not documented" | "Insufficient detail" | "Unable to determine";
  evidence_in_notes: string;
  required_documentation: string;
}

export interface ClinicalResult {
  revised_hpi: string;
  missing_criteria: MissingCriterion[];
  mapping_explanation: string;
}

// Shared state to preserve inputs and results across navigation
let savedErMode: "upload" | "text" = "upload";
let savedErText = "";
let savedErFile: File | null = null;
let savedErFileName = "";
let savedHpFile: File | null = null;
let savedHpFileName = "";
let savedMcgFile: File | null = null;
let savedMcgFileName = "";
let savedResult: ClinicalResult | null = null;

export const getSavedResult = () => savedResult;
export const clearSavedResult = () => { savedResult = null; };
export const setSavedResult = (r: ClinicalResult) => { savedResult = r; };

async function fileToBase64(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  return btoa(
    new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
  );
}

const PROGRESS_STEPS = [
  "Extracting PDF text...",
  "Analyzing criteria...",
  "Generating revised HPI...",
  "Generating missing criteria...",
  "Generating mapping explanation...",
  "Running self-audit...",
];

const ClinicalInput = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const erFileRef = useRef<HTMLInputElement>(null);
  const hpFileRef = useRef<HTMLInputElement>(null);
  const mcgFileRef = useRef<HTMLInputElement>(null);

  const [erMode, setErMode] = useState<"upload" | "text">(savedErMode);
  const [erText, setErText] = useState(savedErText);
  const [erFile, setErFile] = useState<File | null>(savedErFile);
  const [erFileName, setErFileName] = useState(savedErFileName);
  const [hpFile, setHpFile] = useState<File | null>(savedHpFile);
  const [hpFileName, setHpFileName] = useState(savedHpFileName);
  const [mcgFile, setMcgFile] = useState<File | null>(savedMcgFile);
  const [mcgFileName, setMcgFileName] = useState(savedMcgFileName);
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStep, setProgressStep] = useState(0);

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
    setName: (n: string) => void,
    saveFn: (f: File | null, n: string) => void
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
    saveFn(selected, selected.name);
  };

  const handleGenerate = async () => {
    console.log("handleGenerate called", { erMode, erFile: !!erFile, erText: erText.length, hpFile: !!hpFile, mcgFile: !!mcgFile });
    // Validate
    if (erMode === "upload" && !erFile) {
      setError("ER Notes PDF is required.");
      return;
    }
    if (erMode === "text" && !erText.trim()) {
      setError("ER Notes text is required.");
      return;
    }
    if (!hpFile) {
      setError("Inpatient H&P PDF is required.");
      return;
    }
    if (!mcgFile) {
      setError("MCG Guideline PDF is required.");
      return;
    }

    setError("");
    setIsProcessing(true);
    setProgressStep(0);

    // Save state
    savedErMode = erMode;
    savedErText = erText;

    try {
      const progressInterval = setInterval(() => {
        setProgressStep(prev => Math.min(prev + 1, PROGRESS_STEPS.length - 1));
      }, 4000);

      const body: Record<string, string> = {};

      if (erMode === "text") {
        body.erText = erText;
      } else {
        body.erPdfBase64 = await fileToBase64(erFile!);
      }
      body.hpPdfBase64 = await fileToBase64(hpFile!);
      body.mcgPdfBase64 = await fileToBase64(mcgFile!);

      const { data, error: fnError } = await supabase.functions.invoke("optimize-clinical-doc", {
        body,
      });

      clearInterval(progressInterval);

      if (fnError) throw fnError;

      // Handle case where data comes back as string
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      if (parsed?.error) throw new Error(parsed.error);

      // Validate response shape
      if (!parsed?.revised_hpi || !Array.isArray(parsed?.missing_criteria) || !parsed?.mapping_explanation) {
        throw new Error("Invalid response shape from backend.");
      }

      const result: ClinicalResult = parsed;
      savedResult = result;
      localStorage.setItem("clinical_result", JSON.stringify(result));
      navigate("/clinical-output");
    } catch (err: any) {
      setError(err.message || "An error occurred while processing.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Link>
          </Button>
        </div>

        <h1 className="mb-8 text-3xl font-bold text-foreground">Clinical Document Optimizer</h1>

        <div className="space-y-6">
          {/* ── A) ER Notes ── */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">
              ER Notes <span className="text-destructive">*</span>
            </Label>
            <RadioGroup
              value={erMode}
              onValueChange={(v) => {
                const mode = v as "upload" | "text";
                setErMode(mode);
                savedErMode = mode;
              }}
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
                    onChange={(e) =>
                      handlePdfSelect(e, setErFile, setErFileName, (f, n) => {
                        savedErFile = f;
                        savedErFileName = n;
                      })
                    }
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
                onChange={(e) => {
                  setErText(e.target.value);
                  savedErText = e.target.value;
                }}
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
                onChange={(e) =>
                  handlePdfSelect(e, setHpFile, setHpFileName, (f, n) => {
                    savedHpFile = f;
                    savedHpFileName = n;
                  })
                }
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
                onChange={(e) =>
                  handlePdfSelect(e, setMcgFile, setMcgFileName, (f, n) => {
                    savedMcgFile = f;
                    savedMcgFileName = n;
                  })
                }
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
            <div className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
              {PROGRESS_STEPS[progressStep]}
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
