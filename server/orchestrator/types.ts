export type StepKind =
  | "spawn-pass"
  | "run-validation"
  | "wait-signal"
  | "wait-timer"
  | "spawn-child"
  | "log-vault"
  | "pause-approval";

export type StepRequest = {
  kind: StepKind;
  payload: unknown;
};

export type StepResult = {
  status: "complete" | "failed" | "blocked" | "cancelled";
  output?: unknown;
  error?: string;
};

export interface WorkflowCtx {
  spawnPass(payload: { sequence?: number; [key: string]: unknown }): StepRequest;
  runValidation(payload?: { commands?: string[] }): StepRequest;
  waitSignal(payload: { name: string; timeoutMs?: number }): StepRequest;
  waitTimer(payload: { fireAt: number }): StepRequest;
  spawnChild(payload: { definitionName: string; input?: unknown }): StepRequest;
  pauseForApproval(payload: { message: string }): StepRequest;
  logToVault(payload: { data: unknown }): StepRequest;
}

export type WorkflowDef = (ctx: WorkflowCtx) => Generator<StepRequest, void, StepResult>;

export type HistoryEntry = {
  id: string;
  workflowInstanceId: string;
  stepIndex: number;
  kind: StepKind;
  payload_json: string;
  result_json: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: StepResult["status"] | "running";
};

export type WorkflowInstance = {
  id: string;
  definitionName: string;
  runId: string;
  workflowId: string;
  status: "running" | "complete" | "failed" | "blocked" | "cancelled";
  currentStepIndex: number;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  parentInstanceId: string | null;
};
