import { useEffect, useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Copy, Check } from "lucide-react";
import { getSavedResult, ClinicalResult } from "./ClinicalInput";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";

const ClinicalOutput = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [result, setResult] = useState<ClinicalResult | null>(null);
  const [copied, setCopied] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const saved = getSavedResult();
    if (saved) setResult(saved);
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;
  if (!result) return <Navigate to="/clinical-input" replace />;

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

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <Button variant="ghost" size="sm" onClick={() => navigate("/clinical-input")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Edit
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
              <div className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
                {result.mapping_explanation}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default ClinicalOutput;
