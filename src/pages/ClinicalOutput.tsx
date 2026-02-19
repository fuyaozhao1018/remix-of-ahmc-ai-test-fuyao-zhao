import { useEffect } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useClinical } from "@/contexts/ClinicalContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Copy, Check, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import AppHeader from "@/components/AppHeader";

const ClinicalOutput = () => {
  const { user, loading } = useAuth();
  const { result } = useClinical();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [copied, setCopied] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Auto-scroll to top on mount
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (result) {
      toast({ title: "Results generated successfully" });
    }
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  if (!result) {
    return (
      <div className="min-h-screen bg-background">
        <AppHeader />
        <div className="flex flex-col items-center justify-center gap-4 py-20">
          <p className="text-muted-foreground">No results yet. Please generate a clinical document first.</p>
          <Button variant="outline" onClick={() => navigate("/clinical-input")}>
            Go to Input
          </Button>
        </div>
      </div>
    );
  }

  const copyToClipboard = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(prev => ({ ...prev, [key]: true }));
    setTimeout(() => setCopied(prev => ({ ...prev, [key]: false })), 2000);
    toast({ title: "Copied to clipboard" });
  };

  const CopyBtn = ({ textKey, text }: { textKey: string; text: string }) => (
    <Button variant="outline" size="sm" onClick={() => copyToClipboard(text, textKey)}>
      {copied[textKey] ? (
        <><Check className="mr-1 h-3 w-3" /> Copied</>
      ) : (
        <><Copy className="mr-1 h-3 w-3" /> Copy</>
      )}
    </Button>
  );

  const missingListText = result.missing_criteria
    .map(
      (item, i) =>
        `${i + 1}. [${item.status}] ${item.mcg_clause}\n   Evidence: ${item.evidence_in_notes}\n   Required: ${item.required_documentation}`
    )
    .join("\n\n");

  const statusVariant = (status: string) => {
    switch (status) {
      case "Not documented": return "destructive";
      case "Insufficient detail": return "secondary";
      default: return "outline";
    }
  };

  const handleDownload = async () => {
    const { default: jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const margin = 50;
    const pageWidth = doc.internal.pageSize.getWidth() - margin * 2;
    let y = margin;

    const addText = (text: string, fontSize: number, bold = false) => {
      doc.setFontSize(fontSize);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      const lines = doc.splitTextToSize(text, pageWidth);
      for (const line of lines) {
        if (y + fontSize * 1.4 > doc.internal.pageSize.getHeight() - margin) {
          doc.addPage();
          y = margin;
        }
        doc.text(line, margin, y);
        y += fontSize * 1.4;
      }
    };

    const addSpacing = (pts: number) => { y += pts; };

    // Title
    addText("Clinical Documentation Optimization Report", 16, true);
    addSpacing(8);
    addText(`Generated: ${new Date().toLocaleDateString()}`, 9);
    addSpacing(16);

    // Section 1: Revised HPI
    addText("REVISED HPI", 13, true);
    addSpacing(6);
    addText(result.revised_hpi, 10);
    addSpacing(20);

    // Section 2: Missing Criteria
    addText("MISSING CRITERIA", 13, true);
    addSpacing(6);
    result.missing_criteria.forEach((item, i) => {
      addText(`${i + 1}. [${item.status}] ${item.mcg_clause}`, 10, true);
      addText(`   Evidence: ${item.evidence_in_notes}`, 9);
      addText(`   Required: ${item.required_documentation}`, 9);
      addSpacing(8);
    });
    addSpacing(12);

    // Section 3: Mapping Explanation
    addText("MAPPING EXPLANATION", 13, true);
    addSpacing(6);
    result.mapping_explanation.split("---").forEach(block => {
      const trimmed = block.trim();
      if (!trimmed) return;
      addText(trimmed, 10);
      addSpacing(10);
    });

    doc.save("clinical-output.pdf");
    toast({ title: "Downloaded clinical-output.pdf" });
  };

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate("/clinical-input")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Edit
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
        </div>

        <h1 className="mb-8 text-3xl font-bold text-foreground">Results</h1>

        <div className="space-y-6">
          {/* 1) Revised HPI */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-lg">Revised HPI</CardTitle>
              <CopyBtn textKey="hpi" text={result.revised_hpi} />
            </CardHeader>
            <CardContent>
              <div className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
                {result.revised_hpi}
              </div>
            </CardContent>
          </Card>

          {/* 2) Missing Criteria */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-lg">Missing Criteria List</CardTitle>
              <CopyBtn textKey="criteria" text={missingListText} />
            </CardHeader>
            <CardContent>
              {result.missing_criteria.length === 0 ? (
                <p className="text-sm text-muted-foreground">No missing criteria found.</p>
              ) : (
                <ul className="space-y-4">
                  {result.missing_criteria.map((item, index) => (
                    <li key={index} className="rounded-md border border-border p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {index + 1}. {item.mcg_clause}
                        </span>
                        <Badge variant={statusVariant(item.status) as any} className="shrink-0 text-xs">
                          {item.status}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium">Evidence:</span> {item.evidence_in_notes}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium">Required:</span> {item.required_documentation}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* 3) Mapping Explanation */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-lg">Explanation / Mapping</CardTitle>
              <CopyBtn textKey="explanation" text={result.mapping_explanation} />
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {result.mapping_explanation.split("---").map((block, i, arr) => {
                  const trimmed = block.trim();
                  if (!trimmed) return null;
                  return (
                    <div key={i}>
                      <div className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
                        {trimmed}
                      </div>
                      {i < arr.length - 1 && arr[i + 1]?.trim() && (
                        <hr className="mt-4 border-border" />
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default ClinicalOutput;
