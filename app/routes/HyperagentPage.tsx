import { useState } from "react";
import { AlertCircle, Send, Users } from "lucide-react";
import { useAuthApi } from "../hooks/useAuthApi";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { useAction } from "../hooks/useAction";
import { SectionCard } from "../components/SectionCard";
import { authFetch } from "../lib/authFetch";

type HyperagentStatus = {
  configured: boolean;
  spendConfigured?: boolean;
  phase?: string | null;
  budget?: {
    hardCapUsd: number;
    alertUsd: number;
    maxPerTaskUsd: number;
    spentUsd: number;
    reservedUsd: number;
    committedUsd: number;
    tasks: number;
    attempts: number;
    overCap: boolean;
  } | null;
  disabled?: boolean | null;
  error?: string;
  attributionCaveat: string;
};

type HyperagentAgent = { id: string; name: string | null };

type HyperagentThread = {
  threadId: string | null;
  status: string | null;
  costUsd: number | null;
  messageCount: number | null;
  urls: string[];
};

type RbacMe = { role: "owner" | "operator" | "auditor" | "viewer"; allowedActions: string[] };

function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toFixed(2)}`;
}

export function HyperagentPage() {
  const { data: status, loading: statusLoading, refresh: refreshStatus } = useAuthenticatedApi<HyperagentStatus>("/api/hyperagent/status", 20_000);
  const { data: agentsData, loading: agentsLoading, error: agentsError } = useAuthenticatedApi<{ agents: HyperagentAgent[]; count: number }>("/api/hyperagent/agents", 60_000);
  const { data: me } = useAuthApi<RbacMe>("/api/governance/rbac/me", 60_000);

  const createAction = useAction("/api/hyperagent/create-thread");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [maxCostUsd, setMaxCostUsd] = useState("1.00");
  const [reason, setReason] = useState("");
  const [lastThread, setLastThread] = useState<HyperagentThread | null>(null);

  const [threadLookupId, setThreadLookupId] = useState("");

  const canSpend = me?.role === "owner" || me?.role === "operator";
  const spendConfigured = status?.spendConfigured ?? false;
  const brokerDisabled = status?.disabled === true;

  async function handleCreateThread() {
    if (!agentId.trim() || !prompt.trim()) {
      return;
    }
    if (!reason.trim()) {
      return;
    }
    const cost = Number(maxCostUsd);
    const confirmed = window.confirm(
      `Start one Hyperagent task with agent "${agentId.trim()}"?\n\n` +
      `This spends real Hyperagent task credit, reserved up to ${fmtUsd(cost)}. ` +
      `Broker caller attribution is advisory only — see the notice below.`,
    );
    if (!confirmed) return;

    setLastThread(null);
    const ok = await createAction.run({
      agentId: agentId.trim(),
      prompt,
      maxCostUsd: cost,
      reason: reason.trim(),
      confirmed: true,
    });
    if (ok) {
      refreshStatus();
    }
  }

  return (
    <div className="dash-page">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Hyperagent</h1>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>
          {status?.phase ? `phase ${status.phase}` : statusLoading ? "loading…" : "not configured"}
        </span>
        {me?.role && <span className={`role-badge role-${me.role}`}>your role: {me.role}</span>}
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          marginBottom: 16,
          padding: 12,
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "color-mix(in oklch, var(--warn, orange) 8%, transparent)",
        }}
      >
        <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          {status?.attributionCaveat ?? "Broker caller attribution is advisory only — it is not a security boundary. Access control for this panel is this app's own sign-in and role check."}
        </div>
      </div>

      {!status?.configured && (
        <SectionCard title="Not configured">
          <div style={{ padding: 12, fontSize: 13, color: "var(--text-dim)" }}>
            The Hyperagent broker token is not configured for this Control Surface instance. Read-only status and the
            spending action are both unavailable until it is provisioned.
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Ledger & budget"
        right={<span style={{ fontSize: 11, color: "var(--text-dim)" }}>from the broker — never a second copy</span>}
      >
        {status?.error && (
          <div className="pill red" style={{ margin: 12 }}>{status.error}</div>
        )}
        {status?.budget && (
          <div className="data-row-detail-grid" style={{ padding: 12 }}>
            <div><span>Spent</span><strong>{fmtUsd(status.budget.spentUsd)}</strong></div>
            <div><span>Reserved</span><strong>{fmtUsd(status.budget.reservedUsd)}</strong></div>
            <div><span>Committed</span><strong>{fmtUsd(status.budget.committedUsd)}</strong></div>
            <div><span>Hard cap</span><strong>{fmtUsd(status.budget.hardCapUsd)}</strong></div>
            <div><span>Max per task</span><strong>{fmtUsd(status.budget.maxPerTaskUsd)}</strong></div>
            <div><span>Tasks created</span><strong>{status.budget.tasks}</strong></div>
            <div><span>Attempts</span><strong>{status.budget.attempts}</strong></div>
            <div><span>Kill switch</span><strong>{brokerDisabled ? "disabled (503 on gated routes)" : "armed"}</strong></div>
          </div>
        )}
      </SectionCard>

      <SectionCard title={<span style={{ display: "flex", alignItems: "center", gap: 6 }}><Users size={14} /> Agents</span>}>
        <div style={{ padding: 12 }}>
          {agentsLoading && <div style={{ fontSize: 13, color: "var(--text-dim)" }}>Loading…</div>}
          {agentsError && <div className="pill red">{agentsError}</div>}
          {agentsData && agentsData.agents.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>No agents returned by the broker.</div>
          )}
          {agentsData && agentsData.agents.length > 0 && (
            <table className="data-table">
              <thead><tr><th>Agent ID</th><th>Name</th></tr></thead>
              <tbody>
                {agentsData.agents.map((agent) => (
                  <tr key={agent.id}>
                    <td style={{ fontFamily: "var(--mono)" }}>{agent.id}</td>
                    <td>{agent.name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SectionCard>

      <SectionCard title={<span style={{ display: "flex", alignItems: "center", gap: 6 }}><Send size={14} /> Start a task (spends real credit)</span>}>
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 }}>
          <label style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Agent ID
            <input
              className="modal-input"
              style={{ width: "100%", marginTop: 4 }}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="agent id from the list above"
              disabled={!canSpend || !spendConfigured}
            />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Prompt (synthetic / public content only — the broker rejects credentials, secrets, and private data)
            <textarea
              className="modal-input"
              style={{ width: "100%", marginTop: 4, minHeight: 80 }}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={4000}
              disabled={!canSpend || !spendConfigured}
            />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Max reservation (USD, up to {fmtUsd(status?.budget?.maxPerTaskUsd ?? 25)})
            <input
              className="modal-input"
              style={{ width: 140, marginTop: 4 }}
              type="number"
              min={0.01}
              max={status?.budget?.maxPerTaskUsd ?? 25}
              step={0.01}
              value={maxCostUsd}
              onChange={(e) => setMaxCostUsd(e.target.value)}
              disabled={!canSpend || !spendConfigured}
            />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Reason (required, recorded in the audit log)
            <input
              className="modal-input"
              style={{ width: "100%", marginTop: 4 }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="why this task is being started"
              disabled={!canSpend || !spendConfigured}
            />
          </label>
          <div>
            <button
              className="btn btn-primary"
              onClick={handleCreateThread}
              disabled={!canSpend || !spendConfigured || createAction.loading || !agentId.trim() || !prompt.trim() || !reason.trim()}
            >
              {createAction.loading ? "Starting…" : "Start task"}
            </button>
          </div>
          {!canSpend && me && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Your role ({me.role}) cannot start tasks. Only operator or owner roles can spend Hyperagent credit.
            </div>
          )}
          {!spendConfigured && status?.configured && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              This action is unavailable: the broker confirmation credential is not configured for this instance.
            </div>
          )}
          {createAction.error && <div className="pill red">{createAction.error}</div>}
          {createAction.success && !createAction.error && (
            <div className="pill green">{createAction.success}</div>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Check a thread" defaultOpen={false}>
        <div style={{ padding: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="modal-input"
            style={{ width: 320 }}
            value={threadLookupId}
            onChange={(e) => setThreadLookupId(e.target.value)}
            placeholder="threadId"
          />
          <ThreadLookupButton
            threadId={threadLookupId}
            onResult={(thread) => setLastThread(thread)}
          />
        </div>
        {lastThread && (
          <div className="data-row-detail-grid" style={{ padding: 12 }}>
            <div><span>Thread ID</span><strong>{lastThread.threadId ?? "—"}</strong></div>
            <div><span>Status</span><strong>{lastThread.status ?? "—"}</strong></div>
            <div><span>Cost</span><strong>{fmtUsd(lastThread.costUsd)}</strong></div>
            <div><span>Messages</span><strong>{lastThread.messageCount ?? "—"}</strong></div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function ThreadLookupButton({ threadId, onResult }: { threadId: string; onResult: (thread: HyperagentThread) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!threadId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/hyperagent/threads/${encodeURIComponent(threadId.trim())}`);
      const json = await res.json().catch(() => ({})) as { data?: { thread?: HyperagentThread }; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.data?.thread) onResult(json.data.thread);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button className="btn btn-ghost" onClick={run} disabled={loading || !threadId.trim()}>
        {loading ? "Checking…" : "Check status"}
      </button>
      {error && <span className="pill red">{error}</span>}
    </>
  );
}
