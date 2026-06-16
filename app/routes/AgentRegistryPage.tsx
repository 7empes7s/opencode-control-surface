import { useState } from "react";
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Clock, DollarSign, RefreshCw, ShieldAlert, ShieldCheck, AlertTriangle, Activity, Users } from "lucide-react";
import { useApi, fmtAge } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";

type AgentStatus = "active" | "paused" | "retired";
type AgentRiskTier = "low" | "medium" | "high";
type AgentKind = "runner" | "service" | "pipeline" | "workflow";

type RegisteredAgent = {
  id: string;
  name: string;
  kind: AgentKind;
  owner: string;
  purpose: string;
  riskTier: AgentRiskTier;
  status: AgentStatus;
  modelAccess: string[];
  aliases: string[];
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
  audit7d: number;
  spend30dUsd: number;
};

type AgentRecentAuditRow = {
  ts: number;
  action: string;
  targetType: string | null;
  targetId: string | null;
  resultStatus: string | null;
  reason: string | null;
};

type AgentPassport = {
  agent: RegisteredAgent;
  recentAudit: AgentRecentAuditRow[];
  gateway: { calls30d: number; spend30dUsd: number; lastCallAt: number | null };
};

type AgentRegistryPayload = {
  agents: RegisteredAgent[];
  counts: { total: number; active: number; paused: number; retired: number };
};

function statusPillClass(status: AgentStatus): string {
  if (status === "active") return "green";
  if (status === "paused") return "amber";
  return "gray";
}

function riskPillClass(tier: AgentRiskTier): string {
  if (tier === "high") return "red";
  if (tier === "medium") return "amber";
  return "blue";
}

function fmtUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function fmtLastSeen(ts: number | null): string {
  if (ts == null) return "never";
  return `${fmtAge(Math.floor((Date.now() - ts) / 1000))}`;
}

function StatusPill({ status }: { status: AgentStatus }) {
  return <span className={`pill ${statusPillClass(status)}`}>{status}</span>;
}

function RiskPill({ tier }: { tier: AgentRiskTier }) {
  return <span className={`pill ${riskPillClass(tier)}`}>{tier} risk</span>;
}

function KindBadge({ kind }: { kind: AgentKind }) {
  return <span className="pill gray">{kind}</span>;
}

function PassportPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { data, loading, error, refresh } = useApi<AgentPassport>(`/api/agent-registry/${encodeURIComponent(agentId)}`, 0);
  const [touched, setTouched] = useState(false);

  if (loading && !data) {
    return (
      <div className="agent-passport loading-dim">
        <div className="agent-passport-head">
          <strong>Loading agent passport…</strong>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="agent-passport loading-dim error">
        <div className="agent-passport-head">
          <span>The agent passport did not load. {error}</span>
          <div>
            <button type="button" className="btn" onClick={() => { setTouched(true); refresh(); }}>Retry</button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { agent, recentAudit, gateway } = data;
  const lastCallRel = gateway.lastCallAt ? fmtAge(Math.floor((Date.now() - gateway.lastCallAt) / 1000)) : "never";

  return (
    <div className="agent-passport">
      <div className="agent-passport-head">
        <div>
          <div className="dash-section-title">agent passport</div>
          <strong>{agent.name}</strong>
          <span style={{ marginLeft: 8, color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 11 }}>{agent.id}</span>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>

      <div className="agent-passport-grid">
        <div className="agent-passport-cell">
          <div className="dash-section-title">purpose</div>
          <p>{agent.purpose || "No purpose recorded."}</p>
        </div>
        <div className="agent-passport-cell">
          <div className="dash-section-title">owner</div>
          <p>{agent.owner || "Unowned"}</p>
        </div>
        <div className="agent-passport-cell">
          <div className="dash-section-title">aliases</div>
          {agent.aliases.length === 0 ? (
            <p>No aliases registered.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {agent.aliases.map((alias) => <span key={alias} className="pill gray">{alias}</span>)}
            </div>
          )}
        </div>
        <div className="agent-passport-cell">
          <div className="dash-section-title">models it may use</div>
          {agent.modelAccess.length === 0 ? (
            <p>No model access recorded.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {agent.modelAccess.map((m) => <span key={m} className="pill blue">{m}</span>)}
            </div>
          )}
        </div>
      </div>

      <div className="agent-passport-section">
        <div className="dash-section-title">gateway activity (30 days)</div>
        <div className="agent-passport-stats">
          <div className="stat-item">
            <div className="stat-lbl">calls</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 14 }}>{gateway.calls30d}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">spend</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 14 }}>{fmtUsd(gateway.spend30dUsd)}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">last call</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 14 }}>{lastCallRel}</div>
          </div>
        </div>
      </div>

      <div className="agent-passport-section">
        <div className="dash-section-title">everything this agent did</div>
        {recentAudit.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck size={16} />
            <span>This agent has not taken any recorded actions yet.</span>
          </div>
        ) : (
          <table className="data-table agent-audit-table">
            <thead>
              <tr>
                <th>time</th>
                <th>action</th>
                <th>target</th>
                <th>result</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {recentAudit.map((row, idx) => {
                const t = new Date(row.ts);
                const timeRel = `${fmtAge(Math.floor((Date.now() - row.ts) / 1000))}`;
                const target = [row.targetType, row.targetId].filter(Boolean).join(":") || "—";
                const resultClass = row.resultStatus === "ok" || row.resultStatus === "success" ? "green" :
                  row.resultStatus === "failed" || row.resultStatus === "error" ? "red" : "gray";
                return (
                  <tr key={`${row.ts}-${idx}`}>
                    <td title={t.toISOString()}>
                      <Clock size={11} style={{ verticalAlign: "middle", marginRight: 4 }} />
                      {timeRel}
                    </td>
                    <td>{row.action}</td>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{target}</td>
                    <td><span className={`pill ${resultClass}`}>{row.resultStatus ?? "unknown"}</span></td>
                    <td style={{ color: "var(--text-dim)" }}>{row.reason ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AgentCard({ agent, isOpen, onToggle }: { agent: RegisteredAgent; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className={`agent-card${isOpen ? " agent-card-open" : ""}`}>
      <div className="agent-card-head">
        <span className="agent-card-name"><Bot size={14} /><strong>{agent.name}</strong></span>
        <StatusPill status={agent.status} />
      </div>
      <div className="agent-card-meta">
        <KindBadge kind={agent.kind} />
        <RiskPill tier={agent.riskTier} />
        <span className="agent-card-owner">{agent.owner || "unowned"}</span>
      </div>
      <div className="agent-card-summary">
        {agent.audit7d} action{agent.audit7d === 1 ? "" : "s"} this week · {fmtUsd(agent.spend30dUsd)} spent · seen {fmtLastSeen(agent.lastSeenAt)}
      </div>
      <details className="agent-card-details">
        <summary>details</summary>
        <div className="agent-card-detail-block">
          <div className="dash-section-title">models it may use</div>
          {agent.modelAccess.length === 0
            ? <p>No model access recorded.</p>
            : agent.modelAccess.map((m) => <div key={m} className="agent-card-model">{m}</div>)}
        </div>
        <div className="agent-card-detail-block">
          <div className="dash-section-title">aliases</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {agent.aliases.length === 0 ? <p>None.</p> : agent.aliases.map((a) => <span key={a} className="pill gray">{a}</span>)}
          </div>
        </div>
        <button type="button" className="btn" onClick={onToggle}>
          {isOpen ? "Close passport" : "Open passport"}
        </button>
      </details>
      {isOpen && <PassportPanel agentId={agent.id} onClose={onToggle} />}
    </div>
  );
}

function AgentRow({ agent, isOpen, onToggle }: { agent: RegisteredAgent; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`agent-row${isOpen ? " agent-row-open" : ""}`} onClick={onToggle} style={{ cursor: "pointer" }}>
        <td>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Bot size={13} />
            <strong>{agent.name}</strong>
          </span>
        </td>
        <td><KindBadge kind={agent.kind} /></td>
        <td><StatusPill status={agent.status} /></td>
        <td>{agent.owner || <span style={{ color: "var(--text-dim)" }}>unowned</span>}</td>
        <td><RiskPill tier={agent.riskTier} /></td>
        <td style={{ color: "var(--text-dim)" }}>{fmtLastSeen(agent.lastSeenAt)}</td>
        <td style={{ fontFamily: "var(--mono)" }}>{agent.audit7d}</td>
        <td style={{ fontFamily: "var(--mono)" }}>{fmtUsd(agent.spend30dUsd)}</td>
        <td style={{ color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--mono)" }}>
          {agent.modelAccess.slice(0, 2).join(", ")}{agent.modelAccess.length > 2 ? ` +${agent.modelAccess.length - 2}` : ""}
        </td>
      </tr>
      {isOpen && (
        <tr className="agent-row-detail">
          <td colSpan={9}>
            <PassportPanel agentId={agent.id} onClose={onToggle} />
          </td>
        </tr>
      )}
    </>
  );
}

export function AgentRegistryPage() {
  const { data, loading, error, refresh } = useApi<AgentRegistryPayload>(`/api/agent-registry`, 15_000);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  if (loading && !data) return <div className="loading-panel">Loading the agent registry.</div>;
  if (error && !data) {
    return (
      <div className="loading-panel error">
        <p>The agent registry did not load. {error}</p>
        <button type="button" className="btn" onClick={refresh}>Retry</button>
      </div>
    );
  }
  if (!data) return null;

  const { agents, counts } = data;
  const subtitle = `Your AI workforce: ${counts.total} registered agent${counts.total === 1 ? "" : "s"} — ${counts.active} active, ${counts.paused} paused, ${counts.retired} retired.`;

  return (
    <div className="dash-page agents-page">
      <section className="insights-hero">
        <div>
          <div className="dash-section-title">agents</div>
          <h1>{counts.total === 0 ? "No agents have been registered yet." : subtitle}</h1>
          <p>
            The full inventory of AI workers that may act on your behalf — what they do, who owns them, what they may touch, and everything they have done.
          </p>
        </div>
        <div className="insights-hero-actions">
          <div className="insights-count">
            <Bot size={18} />
            <span>{counts.total}</span>
            <small>total</small>
          </div>
          <div className="insights-count">
            <CheckCircle2 size={18} />
            <span>{counts.active}</span>
            <small>active</small>
          </div>
          <div className="insights-count">
            <Activity size={18} />
            <span>{counts.paused}</span>
            <small>paused</small>
          </div>
          <div className="insights-count">
            <ShieldCheck size={18} />
            <span>{counts.retired}</span>
            <small>retired</small>
          </div>
        </div>
      </section>

      <section className="dash-section">
        {agents.length === 0 ? (
          <div className="empty-state">
            <Bot size={24} />
            <strong>No agents are registered. New agents will appear here as they are introduced.</strong>
          </div>
        ) : (
          <>
            <table className="data-table agents-table">
              <thead>
                <tr>
                  <th>name</th>
                  <th>kind</th>
                  <th>status</th>
                  <th>owner</th>
                  <th>risk</th>
                  <th>last seen</th>
                  <th>actions / 7d</th>
                  <th>spend / 30d</th>
                  <th>models</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    isOpen={openAgentId === agent.id}
                    onToggle={() => setOpenAgentId((curr) => curr === agent.id ? null : agent.id)}
                  />
                ))}
              </tbody>
            </table>
            <div className="agents-cards">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isOpen={openAgentId === agent.id}
                  onToggle={() => setOpenAgentId((curr) => curr === agent.id ? null : agent.id)}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
