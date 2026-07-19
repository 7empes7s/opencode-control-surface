export const AGENT_ADAPTER_CONTRACT_VERSION = 1 as const;

export type AgentHarness = "terminal" | "codex" | "opencode" | "claude" | "gemini";
export type AgentAccessMode = "reader" | "writer";
export type AgentRunState = "queued" | "running" | "restored" | "stale" | "unreachable" | "stopped" | "failed";

export type AgentLaunchRequest = {
  contractVersion: typeof AGENT_ADAPTER_CONTRACT_VERSION;
  idempotencyKey: string;
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  workspaceRoot: string;
  repositoryRoot?: string | null;
  accessMode: AgentAccessMode;
  requestedConfig: Record<string, unknown>;
};

export type AgentLaunchResult = {
  adapterRunId: string;
  effectiveConfig: Record<string, unknown>;
  supervisor: {
    kind: "process-group" | "tmux" | "remote" | "upstream";
    reference: string;
  };
};

export type AgentAdapterEvent = {
  kind: string;
  payload: Record<string, unknown>;
  occurredAt: number;
};

/**
 * Versioned boundary for Slice 1. Existing launchers are not moved onto this
 * contract until the later adapter migration slice; the durable registry and
 * event spool can already reconstruct independently of their process maps.
 */
export interface AgentAdapterV1 {
  readonly contractVersion: typeof AGENT_ADAPTER_CONTRACT_VERSION;
  readonly harness: AgentHarness;
  launch(request: AgentLaunchRequest): Promise<AgentLaunchResult>;
  inspect(adapterRunId: string): Promise<{ state: AgentRunState; detail?: string }>;
  stop(adapterRunId: string, fenceEpoch: number): Promise<{ stopped: boolean; descendantsRemaining: number }>;
}
