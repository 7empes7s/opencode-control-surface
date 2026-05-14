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

function extractPathCandidates(text: string): string[] {
  const matches = text.match(/(?:\/[\w./@+-]+|[\w.-]+\/[\w./@+-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|sqlite|yaml|yml|toml|sh|mjs|cjs))/g) ?? [];
  return matches.map((item) => item.replace(/[),.;:]+$/, ""));
}

function summarizeMessages(messages: HandoffMessage[] | undefined): {
  transcriptSummary?: string;
  latestUserPrompt?: string;
  touchedFiles?: string[];
} {
  if (!messages || messages.length === 0) return {};
  const firstUser = messages.find((message) => message.role === "user" && cleanText(message.content));
  const lastUser = [...messages].reverse().find((message) => message.role === "user" && cleanText(message.content));
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && cleanText(message.content));
  const touchedFiles = Array.from(new Set(messages.flatMap((message) => [
    ...(message.filePaths ?? []),
    ...extractPathCandidates(`${message.content ?? ""}\n${message.toolText ?? ""}`),
  ]).map((path) => path.trim()).filter(Boolean))).slice(0, 30);
  const parts = [
    firstUser ? `Started: ${truncate(cleanText(firstUser.content), 220)}` : "",
    lastUser ? `Latest ask: ${truncate(cleanText(lastUser.content), 260)}` : "",
    lastAssistant ? `Latest response: ${truncate(cleanText(lastAssistant.content), 320)}` : "",
    touchedFiles.length > 0 ? `Touched files: ${touchedFiles.slice(0, 12).join(", ")}` : "",
  ].filter(Boolean);
  return {
    transcriptSummary: parts.length > 0 ? parts.join("\n") : undefined,
    latestUserPrompt: lastUser ? truncate(cleanText(lastUser.content), 800) : undefined,
    touchedFiles,
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
