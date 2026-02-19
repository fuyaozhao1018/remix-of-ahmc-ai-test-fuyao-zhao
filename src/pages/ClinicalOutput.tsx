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
  const [copiedHPI, setCopiedHPI] = useState(false);
  const [copiedList, setCopiedList] = useState(false);

  useEffect(() => {
    const saved = getSavedResult();
    if (saved) {
      setResult(saved);
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
  if (!result) return <Navigate to="/clinical-input" replace />;

  const copyToClipboard = async (text: string, type: "hpi" | "list") => {
    await navigator.clipboard.writeText(text);
    if (type === "hpi") {
      setCopiedHPI(true);
      setTimeout(() => setCopiedHPI(false), 2000);
    } else {
      setCopiedList(true);
      setTimeout(() => setCopiedList(false), 2000);
    }
    toast({ title: "Copied to clipboard" });
  };

  const missingListText = result.missing_criteria
    .map((item, i) => `${i + 1}. [${item.status}] ${item.criterion}\n   → ${item.what_to_document}`)
    .join("\n\n");

  const statusVariant = (status: string) => {
    switch (status) {
      case "Not mentioned": return "destructive";
      case "Insufficient detail": return "secondary";
      default: return "outline";
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6">
          <Button variant="ghost" size="sm" onClick={() => navigate("/clinical-input")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Edit
          </Button>
        </div>

        <h1 className="mb-8 text-3xl font-bold text-foreground">Results</h1>

        <div className="space-y-6">
          {/* Revised HPI */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-lg">Revised HPI</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(result.revised_hpi, "hpi")}
              >
                {copiedHPI ? (
                  <><Check className="mr-1 h-3 w-3" /> Copied</>
                ) : (
                  <><Copy className="mr-1 h-3 w-3" /> Copy</>
                )}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
                {result.revised_hpi}
              </div>
            </CardContent>
          </Card>

          {/* Missing Criteria List */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-lg">Missing Criteria List</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(missingListText, "list")}
              >
                {copiedList ? (
                  <><Check className="mr-1 h-3 w-3" /> Copied</>
                ) : (
                  <><Copy className="mr-1 h-3 w-3" /> Copy</>
                )}
              </Button>
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
                          {index + 1}. {item.criterion}
                        </span>
                        <Badge variant={statusVariant(item.status) as any} className="shrink-0 text-xs">
                          {item.status}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium">Document:</span> {item.what_to_document}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default ClinicalOutput;
