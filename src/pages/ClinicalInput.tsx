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

export interface MissingCriterion {
  criterion: string;
  status: "Not mentioned" | "Insufficient detail" | "Unable to determine";
  what_to_document: string;
}

export interface ClinicalResult {
  revised_hpi: string;
  missing_criteria: MissingCriterion[];
  debug?: { top_k_chunks?: string[] };
}

// Shared state to preserve inputs and results across navigation
let savedNotes = "";
let savedFileName = "";
let savedFile: File | null = null;
let savedResult: ClinicalResult | null = null;

export const getSavedResult = () => savedResult;
export const clearSavedResult = () => { savedResult = null; };
export const setSavedResult = (r: ClinicalResult) => { savedResult = r; };

const ClinicalInput = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [notes, setNotes] = useState(savedNotes);
  const [file, setFile] = useState<File | null>(savedFile);
  const [fileName, setFileName] = useState(savedFileName);
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    if (selected.type !== "application/pdf") {
      setError("Only PDF files are accepted.");
      setFile(null);
      setFileName("");
      return;
    }

    setError("");
    setFile(selected);
    setFileName(selected.name);
    savedFile = selected;
    savedFileName = selected.name;
  };

  const handleGenerate = async () => {
    if (!notes.trim()) {
      setError("Doctor Raw Notes are required.");
      return;
    }
    if (!file) {
      setError("MCG Guideline PDF is required.");
      return;
    }

    setError("");
    setIsProcessing(true);

    // Save notes for back navigation
    savedNotes = notes;

    try {
      // Convert file to base64
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
      );

      const { data, error: fnError } = await supabase.functions.invoke("optimize-clinical-doc", {
        body: { notes, pdfBase64: base64, pdfFileName: file.name },
      });

      if (fnError) throw fnError;

      const result: ClinicalResult = data;
      savedResult = result;
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
          {/* Doctor Raw Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes" className="text-base font-semibold">
              Doctor Raw Notes <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="notes"
              placeholder="Paste the doctor's raw clinical notes here..."
              className="min-h-[200px] resize-y"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                savedNotes = e.target.value;
              }}
              disabled={isProcessing}
            />
          </div>

          {/* PDF Upload */}
          <div className="space-y-2">
            <Label className="text-base font-semibold">
              MCG Guideline PDF <span className="text-destructive">*</span>
            </Label>
            <div
              className="flex cursor-pointer items-center gap-3 rounded-md border border-input bg-background px-4 py-3 transition-colors hover:bg-accent"
              onClick={() => !isProcessing && fileInputRef.current?.click()}
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {fileName || "Click to upload a PDF file"}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={handleFileChange}
                disabled={isProcessing}
              />
            </div>
            {fileName && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                <span>{fileName}</span>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Generate Button */}
          <Button
            onClick={handleGenerate}
            disabled={isProcessing}
            className="w-full"
            size="lg"
          >
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
