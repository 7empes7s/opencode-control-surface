import { useState } from "react";
import { FilePlus2, Loader2, Play } from "lucide-react";
import { authFetch } from "../lib/authFetch";
import type { BuilderDiscovery } from "../../server/builder/discovery";

type AgentId = "claude" | "codex" | "opencode" | "gemini";

type Props = {
  agent: AgentId;
  sessionId: string;
  title: string;
  directory: string;
  messageCount: number;
  messages?: HandoffMessage[];
};

export type HandoffMessage = {
  role: string;
  content?: string;
  toolText?: string;
  filePaths?: string[];
};

type HandoffTurn = {
  role: string;
  text: string;
};

type ApiEnvelope<T> = {
  data?: T;
  error?: string;
};

const AGENT_LABELS: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini",
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (!body.data) throw new Error("empty API response");
  return body.data;
}

function orderedAgents(discovery: BuilderDiscovery, agent: AgentId): string[] {
  const available = discovery.agents.options
    .filter((option) => option.status === "ok")
    .map((option) => option.id);
  return [agent, ...available.filter((item) => item !== agent)];
}

function pickPlan(discovery: BuilderDiscovery): string | null {
  return discovery.planCandidates.find((plan) => plan.exists && plan.kind === "builder")?.path
    ?? discovery.planCandidates.find((plan) => plan.exists && plan.kind === "canonical")?.path
    ?? discovery.planCandidates.find((plan) => plan.exists && plan.kind === "project")?.path
    ?? discovery.planCandidates.find((plan) => plan.exists)?.path
    ?? null;
}

function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function normalizeRole(role: string): string {
  const value = role.toLowerCase();
  if (["user", "assistant", "system", "tool"].includes(value)) return value;
  return value.slice(0, 24) || "message";
}

export function extractPathCandidates(text: string): string[] {
  const matches = text.match(/(?:\/[\w./@+-]+|(?:\.{1,2}\/)?[\w.@+-]+\/[\w./@+-]+\.(?:test\.tsx|test\.ts|tsx|ts|jsx|js|json|md|scss|css|html|sqlite|sql|yaml|yml|toml|sh|mjs|cjs|py|go|rs))/g) ?? [];
  return matches
    .map((item) => item.replace(/^[`'"(]+|[`'"),.;:]+$/g, ""))
    .filter((item) => !item.startsWith("http://") && !item.startsWith("https://") && !item.startsWith("//"));
}

export function summarizeMessages(messages: HandoffMessage[] | undefined): {
  transcriptSummary?: string;
  latestUserPrompt?: string;
  assistantSummary?: string;
  touchedFiles?: string[];
  touchedFileSummary?: string;
  recentTurns?: HandoffTurn[];
} {
  if (!messages || messages.length === 0) return {};
  const turns = messages
    .map((message) => ({
      role: normalizeRole(message.role),
      text: cleanText([message.content, message.toolText].filter(Boolean).join("\n")),
    }))
    .filter((turn) => turn.text);
  const userTurns = turns.filter((turn) => turn.role === "user");
  const assistantTurns = turns.filter((turn) => turn.role === "assistant");
  const firstUser = userTurns[0];
  const lastUser = userTurns.at(-1);
  const lastAssistant = assistantTurns.at(-1);
  const recentTurns = turns.slice(-8).map((turn) => ({
    role: turn.role,
    text: truncate(turn.text, 520),
  }));
  const touchedFiles = Array.from(new Set(messages.flatMap((message) => [
    ...(message.filePaths ?? []),
    ...extractPathCandidates(`${message.content ?? ""}\n${message.toolText ?? ""}`),
  ]).map((path) => path.trim()).filter(Boolean))).slice(0, 30);
  const parts = [
    `Messages: ${messages.length} captured (${userTurns.length} user, ${assistantTurns.length} assistant).`,
    firstUser ? `Started: ${truncate(firstUser.text, 220)}` : "",
    lastUser ? `Latest ask: ${truncate(lastUser.text, 300)}` : "",
    lastAssistant ? `Latest response: ${truncate(lastAssistant.text, 360)}` : "",
    recentTurns.length > 0
      ? `Recent turns:\n${recentTurns.slice(-4).map((turn) => `${turn.role}: ${truncate(turn.text, 180)}`).join("\n")}`
      : "",
    touchedFiles.length > 0 ? `Touched files: ${touchedFiles.slice(0, 16).join(", ")}` : "",
  ].filter(Boolean);
  return {
    transcriptSummary: parts.length > 0 ? parts.join("\n") : undefined,
    latestUserPrompt: lastUser ? truncate(lastUser.text, 1000) : undefined,
    assistantSummary: lastAssistant ? truncate(lastAssistant.text, 1000) : undefined,
    touchedFiles,
    touchedFileSummary: touchedFiles.length > 0
      ? `${touchedFiles.length} file${touchedFiles.length === 1 ? "" : "s"} referenced: ${touchedFiles.slice(0, 16).join(", ")}`
      : undefined,
    recentTurns,
  };
}

export function AgentBuilderHandoffButton({
  agent,
  sessionId,
  title,
  directory,
  messageCount,
  messages,
}: Props) {
  const [busy, setBusy] = useState<"draft" | "start" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function createWorkflow(startNow: boolean) {
    if (!directory || busy) return;
    const action = startNow ? "start" : "draft";
    setBusy(action);
    setStatus(null);

    try {
      const discoveryResponse = await authFetch(`/api/builder/discover?root=${encodeURIComponent(directory)}`);
      const discovery = await readJson<BuilderDiscovery>(discoveryResponse);
      const planFile = pickPlan(discovery);
      if (!planFile) throw new Error("PLAN_FILE_NOT_FOUND");

      const internal = discovery.validation.commands;
      if (internal.length === 0 && startNow) {
        throw new Error("no validation commands inferred");
      }
      const mode = internal.length === 0 ? "plan" : startNow ? "auto-continue" : "once";
      const handoffContext = summarizeMessages(messages);

      const workflowResponse = await authFetch("/api/builder/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${AGENT_LABELS[agent]} handoff: ${title || sessionId}`,
          projectRoot: discovery.project.root,
          planFile,
          mode,
          status: startNow ? "ready" : "draft",
          config: {
            projectRoot: discovery.project.root,
            agentOrder: orderedAgents(discovery, agent),
            modelPolicy: {
              fallbackTargets: discovery.models.fallbackTargets.slice(0, 8),
            },
            validationProfile: {
              commands: internal,
              internal,
              runtime: [],
              public: [],
              playwright: { enabled: false },
              internalUrl: discovery.urls.internal,
              publicUrl: discovery.urls.public,
            },
            gitPolicy: { commit: "manual", push: "never" },
            backupPolicy: { enabled: false, beforeRun: false },
            riskPolicy: { liveDeploys: "disabled", maxPasses: startNow ? 3 : 1 },
            sourceSession: {
              agent,
              sessionId,
              title,
              directory,
              messageCount,
              capturedAt: new Date().toISOString(),
              ...handoffContext,
            },
          },
        }),
      });
      const created = await readJson<{ workflow: { id: string } }>(workflowResponse);

      if (startNow) {
        const startResponse = await authFetch(`/api/builder/workflows/${created.workflow.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "agent-page" }),
        });
        if (!startResponse.ok) {
          const body = await startResponse.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `HTTP ${startResponse.status}`);
        }
      }

      setStatus(startNow ? "started" : "created");
      window.setTimeout(() => {
        window.location.assign("/builder");
      }, 350);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="agent-builder-actions">
      <button
        type="button"
        className="oc-model-btn agent-builder-action"
        title="Create Builder workflow"
        aria-label="Create Builder workflow"
        onClick={() => createWorkflow(false)}
        disabled={Boolean(busy)}
      >
        {busy === "draft" ? <Loader2 size={13} className="oc-spin" /> : <FilePlus2 size={13} strokeWidth={1.75} />}
        <span className="agent-builder-action-label">workflow</span>
      </button>
      <button
        type="button"
        className="oc-model-btn agent-builder-action"
        title="Continue with Builder Pipeline"
        aria-label="Continue with Builder Pipeline"
        onClick={() => createWorkflow(true)}
        disabled={Boolean(busy)}
      >
        {busy === "start" ? <Loader2 size={13} className="oc-spin" /> : <Play size={13} strokeWidth={1.75} />}
        <span className="agent-builder-action-label">builder</span>
      </button>
      {status && <span className="agent-builder-status" title={status}>{status}</span>}
    </div>
  );
}
