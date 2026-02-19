import { createContext, useContext, useState, ReactNode } from "react";

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

interface ClinicalContextType {
  result: ClinicalResult | null;
  setResult: (r: ClinicalResult | null) => void;
  isProcessing: boolean;
  setIsProcessing: (v: boolean) => void;
  progressStep: number;
  setProgressStep: (v: number | ((prev: number) => number)) => void;
}

const ClinicalContext = createContext<ClinicalContextType>({
  result: null,
  setResult: () => {},
  isProcessing: false,
  setIsProcessing: () => {},
  progressStep: 0,
  setProgressStep: () => {},
});

export const ClinicalProvider = ({ children }: { children: ReactNode }) => {
  // Initialize from localStorage if available
  const [result, setResultState] = useState<ClinicalResult | null>(() => {
    try {
      const stored = localStorage.getItem("clinical_result");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.revised_hpi && Array.isArray(parsed?.missing_criteria) && parsed?.mapping_explanation) {
          return parsed;
        }
      }
    } catch {}
    return null;
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStep, setProgressStep] = useState(0);

  const setResult = (r: ClinicalResult | null) => {
    setResultState(r);
    if (r) {
      localStorage.setItem("clinical_result", JSON.stringify(r));
    } else {
      localStorage.removeItem("clinical_result");
    }
  };

  return (
    <ClinicalContext.Provider value={{ result, setResult, isProcessing, setIsProcessing, progressStep, setProgressStep }}>
      {children}
    </ClinicalContext.Provider>
  );
};

export const useClinical = () => useContext(ClinicalContext);
