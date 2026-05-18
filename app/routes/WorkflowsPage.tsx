import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import { ChevronDown, ChevronRight, GitBranch, Play, Radio, RefreshCw, X } from "lucide-react";

interface WorkflowInstance {
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
}

interface HistoryEntry {
  id: string;
  stepIndex: number;
  kind: string;
  payload: unknown;
  result: unknown;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
}

interface InstanceDetail {
  instance: WorkflowInstance;
  history: HistoryEntry[];
}

interface SignalRow {
  id: string;
  instanceId: string;
  signalName: string;
  payload: unknown;
  delivered: boolean;
  createdAt: number;
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "blue";
    case "complete": return "green";
    case "failed": return "red";
    case "blocked": return "amber";
    case "cancelled": return "gray";
    default: return "gray";
  }
}

function fmtTs(ts: number | null): string {
  if (!ts) return "-";
  return new Date(ts).toISOString().slice(5, 19).replace("T", " ");
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function fmtAge(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function SignalModal({
  instanceId,
  onClose,
  onSent,
}: {
  instanceId: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [signalName, setSignalName] = useState("");
  const [payload, setPayload] = useState("{}");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSend = async () => {
    if (!signalName.trim()) return;
    setSending(true);
    setErr(null);
    try {
      const parsed = JSON.parse(payload);
      const res = await authFetch("/api/orchestrator/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId, signalName: signalName.trim(), payload: parsed }),
      });
      const json = await res.json();
      if (json.error) {
        setErr(json.error);
      } else {
        onSent();
        onClose();
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="drawer-head">
          <span className="drawer-head-title">Emit Signal</span>
          <button type="button" className="drawer-close" onClick={onClose}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <label className="w-label" style={{ display: "block", marginBottom: 4 }}>Signal name</label>
            <input
              className="w-input"
              value={signalName}
              onChange={(e) => setSignalName(e.target.value)}
              placeholder="e.g. user-approved"
              style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 13 }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="w-label" style={{ display: "block", marginBottom: 4 }}>Payload (JSON)</label>
            <textarea
              className="w-input"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={4}
              style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 12, resize: "vertical" }}
            />
          </div>
          {err && <div className="w-caption" style={{ color: "var(--red)", marginBottom: 8 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={handleSend} disabled={sending || !signalName.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InstanceRow({
  instance,
  detail,
  onExpand,
  onSignal,
}: {
  instance: WorkflowInstance;
  detail: InstanceDetail | null;
  onExpand: () => void;
  onSignal: () => void;
}) {
  const expanded = detail !== null;
  const duration = instance.finishedAt
    ? instance.finishedAt - instance.createdAt
    : Date.now() - instance.createdAt;
  const history = detail?.history ?? [];
  const totalSteps = history.length;
  const lastSignal = detail
    ? history.filter((h) => h.kind === "wait-signal").pop()
    : null;

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "24px 1fr 100px 90px 100px 80px 1fr 80px",
          gap: 8,
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          cursor: "pointer",
          fontSize: 12,
        }}
        onClick={onExpand}
      >
        <button className="btn btn-ghost" style={{ padding: 2, minWidth: 24 }} onClick={(e) => { e.stopPropagation(); onExpand(); }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div>
          <div className="mono" style={{ fontSize: 11, color: "var(--text)" }}>{instance.definitionName}</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>{instance.id.slice(0, 22)}…</div>
        </div>
        <Pill color={statusColor(instance.status)}>{instance.status}</Pill>
        <div className="mono" style={{ fontSize: 11 }}>
          {totalSteps > 0 ? `step ${instance.currentStepIndex} of ${totalSteps}` : `step ${instance.currentStepIndex}`}
        </div>
        <div className="mono" style={{ fontSize: 11 }}>{fmtDuration(duration)}</div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>{fmtAge(instance.createdAt)}</div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>
          {lastSignal ? `signal: ${lastSignal.kind}` : "-"}
        </div>
        <button
          className="btn btn-ghost"
          style={{ padding: "2px 6px", fontSize: 11 }}
          onClick={(e) => { e.stopPropagation(); onSignal(); }}
          title="Emit signal"
        >
          <Radio size={13} />
        </button>
      </div>
      {expanded && (
        <div style={{ background: "var(--bg-sub)", padding: "8px 12px 12px 48px" }}>
          {instance.error && (
            <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 8, fontFamily: "var(--mono)" }}>
              Error: {instance.error}
            </div>
          )}
          {instance.parentInstanceId && (
            <div style={{ fontSize: 11, marginBottom: 8, color: "var(--text-dim)" }}>
              <GitBranch size={11} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
              child of <span className="mono">{instance.parentInstanceId.slice(0, 22)}…</span>
            </div>
          )}
          <div className="w-label" style={{ marginBottom: 6 }}>History</div>
          {history.length === 0 && <div className="w-caption">No history yet</div>}
          {history.length > 0 && (
            <table style={{ width: "100%", fontSize: 11, fontFamily: "var(--mono)" }}>
              <thead>
                <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>#</th>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>kind</th>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>status</th>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>duration</th>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>payload</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "4px 8px" }}>{h.stepIndex}</td>
                    <td style={{ padding: "4px 8px" }}>{h.kind}</td>
                    <td style={{ padding: "4px 8px" }}>
                      <Pill color={statusColor(h.status)}>{h.status}</Pill>
                    </td>
                    <td style={{ padding: "4px 8px" }}>{fmtDuration(h.durationMs)}</td>
                    <td style={{ padding: "4px 8px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {h.payload ? JSON.stringify(h.payload).slice(0, 80) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {detail && detail.history.length > 0 && (
            <>
              <div className="w-label" style={{ marginTop: 12, marginBottom: 6 }}>Signals</div>
              <SignalLog instanceId={instance.id} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function SignalLog({ instanceId }: { instanceId: string }) {
  const { data } = useApi<{ signals: SignalRow[] }>(`/api/orchestrator/signals?instanceId=${instanceId}&limit=20`, 30_000);
  const signals = data?.signals ?? [];
  if (signals.length === 0) return <div className="w-caption">No signals</div>;
  return (
    <div style={{ fontSize: 11, fontFamily: "var(--mono)" }}>
      {signals.map((s) => (
        <div key={s.id} style={{ display: "flex", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
          <Pill color={s.delivered ? "green" : "amber"}>{s.delivered ? "delivered" : "pending"}</Pill>
          <span>{s.signalName}</span>
          <span style={{ color: "var(--text-dim)" }}>{fmtTs(s.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

export function WorkflowsPage() {
  const { data, loading, refresh } = useApi<{ instances: WorkflowInstance[] }>("/api/orchestrator/instances", 15_000);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [signalTarget, setSignalTarget] = useState<string | null>(null);
  const [detailMap, setDetailMap] = useState<Record<string, InstanceDetail | null>>({});

  const instances = data?.instances ?? [];
  const activeCount = instances.filter((i) => i.status === "running").length;
  const blockedCount = instances.filter((i) => i.status === "blocked").length;

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!detailMap[id]) {
      try {
        const res = await authFetch(`/api/orchestrator/instances/${id}`);
        const json = await res.json();
        setDetailMap((m) => ({ ...m, [id]: json.data ?? null }));
      } catch {
        setDetailMap((m) => ({ ...m, [id]: null }));
      }
    }
  };

  if (loading && instances.length === 0) return <div className="loading-dim">loading…</div>;

  return (
    <div className="dash-page">
      <div className="dash-section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="dash-section-title" style={{ marginBottom: 0 }}>Workflows</span>
            {activeCount > 0 && <Pill color="blue">{activeCount} active</Pill>}
            {blockedCount > 0 && <Pill color="amber">{blockedCount} blocked</Pill>}
          </div>
          <button className="btn btn-ghost" style={{ padding: "4px 8px", fontSize: 11 }} onClick={() => refresh()}>
            <RefreshCw size={13} style={{ marginRight: 4 }} /> Refresh
          </button>
        </div>

        {instances.length === 0 ? (
          <div style={{
            padding: 32,
            textAlign: "center",
            color: "var(--text-dim)",
            fontSize: 13,
            background: "var(--bg-sub)",
            borderRadius: 6,
          }}>
            <Play size={24} style={{ marginBottom: 8, opacity: 0.4 }} />
            <div>No workflow instances yet</div>
            <div className="w-caption" style={{ marginTop: 4 }}>Start a builder run to create one</div>
          </div>
        ) : (
          <>
            <div style={{
              display: "grid",
              gridTemplateColumns: "24px 1fr 100px 90px 100px 80px 1fr 80px",
              gap: 8,
              padding: "6px 12px",
              borderBottom: "1px solid var(--border)",
              fontSize: 10,
              color: "var(--text-dim)",
              fontFamily: "var(--mono)",
            }}>
              <span></span>
              <span>definition</span>
              <span>status</span>
              <span>progress</span>
              <span>duration</span>
              <span>created</span>
              <span>last signal</span>
              <span></span>
            </div>
            {instances.map((inst) => (
              <InstanceRow
                key={inst.id}
                instance={inst}
                detail={expandedId === inst.id ? (detailMap[inst.id] ?? null) : null}
                onExpand={() => handleExpand(inst.id)}
                onSignal={() => setSignalTarget(inst.id)}
              />
            ))}
          </>
        )}
      </div>

      {signalTarget && (
        <SignalModal
          instanceId={signalTarget}
          onClose={() => setSignalTarget(null)}
          onSent={() => {
            refresh();
            if (expandedId === signalTarget) {
              setDetailMap((m) => ({ ...m, [signalTarget]: null }));
            }
          }}
        />
      )}
    </div>
  );
}
