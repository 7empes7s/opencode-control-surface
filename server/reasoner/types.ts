export interface DiagnosisResult {
  passId: string;
  runId: string;
  workflowId: string;
  failureClass: string;
  rootCauseHypothesis: string;
  evidence: string[];
  suggestedActions: string[];
  confidence: "high" | "medium" | "low";
  diagnosedAt: number;
}

export interface ReasonerJob {
  id: string;
  passId: string;
  runId: string;
  workflowId: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  createdAt: number;
  finishedAt?: number;
}