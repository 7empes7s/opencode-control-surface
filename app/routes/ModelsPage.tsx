import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, ShieldCheck } from "lucide-react";
import { useApi, fmtAge } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { authFetch } from "../lib/authFetch";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import { TableControls } from "../components/TableControls";
import { useTableControls } from "../hooks/useTableControls";
import { RatingsSection } from "./RatingsPage";
import type { ModelsDetail } from "../../server/api/types";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function qualityColor(s: string): string {
  if (s === "healthy") return "green";
  if (s === "blocked") return "red";
  if (s === "degraded" || s === "probation") return "amber";
  return "gray";
}

function fmtContextWindow(ctx: number | null): string {
  if (!ctx) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
  return String(ctx);
}

type Modal =
  | { type: "block"; model: string }
  | { type: "unblock"; model: string }
  | { type: "probation-clear"; model: string }
  | { type: "cooldown-clear"; model: string }
  | { type: "promotion-request"; model: string }
  | { type: "run-check" };

export type ModelsSortKey = "logicalName" | "qualityStatus" | "provider" | "contextWindow" | "latency" | "recentFailures";

interface ModelLifecycle {
  logicalName: string;
  resolvedModel: string | null;
  evalHistory: Array<{ ts: number; score: number | null; latencyMs: number | null; error: string | null }>;
  firstSeen: number | null;
  lastEval: number | null;
  qualityStatus: string;
  recentFailures: number;
  consecutiveGarbage: number;
  routingReliability: {
    totalRequests: number;
    successCount: number;
    fallbackCount: number;
    failedCount: number;
    avgLatencyMs: number | null;
  } | null;
  approval: {
    id: string;
    status: "pending" | "approved" | "rejected" | "expired";
    requestedAt: number;
    requestedBy?: string | null;
    expiresAt?: number | null;
    decidedAt?: number | null;
  } | null;
  promotionReadiness: {
    gate: "ready" | "blocked" | "needs-approval";
    reasons: string[];
    threshold: { minEvalScore: number };
  };
  unavailableCapabilities: string[];
}

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function readinessColor(gate: ModelLifecycle["promotionReadiness"]["gate"]): string {
  if (gate === "ready") return "green";
  if (gate === "blocked") return "red";
  return "amber";
}

function Sparkline({
  samples,
  field,
  label,
}: {
  samples: ModelLifecycle["evalHistory"];
  field: "score" | "latencyMs";
  label: string;
}) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) {
    return (
      <div className="model-lifecycle-chart empty">
        <div className="model-lifecycle-chart-label">{label}</div>
        <div className="loading-dim">No {label.toLowerCase()} samples yet</div>
      </div>
    );
  }
  const min = field === "score" ? 0 : Math.min(...values);
  const max = field === "score" ? 1 : Math.max(...values);
  const span = Math.max(0.001, max - min);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 34 - ((value - min) / span) * 28;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const latest = values[values.length - 1];

  return (
    <div className="model-lifecycle-chart">
      <div className="model-lifecycle-chart-head">
        <span>{label}</span>
        <span className="mono dim">{field === "score" ? latest.toFixed(2) : `${Math.round(latest)}ms`}</span>
      </div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-label={`${label} trend`}>
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function ModelLifecyclePanel({
  logicalName,
  refreshNonce,
  onRequestPromotion,
}: {
  logicalName: string;
  refreshNonce: number;
  onRequestPromotion: (model: string) => void;
}) {
  const { data, loading, error, refresh } = useApi<ModelLifecycle>(`/api/models/${encodeURIComponent(logicalName)}/lifecycle?refresh=${refreshNonce}`, 0);

  if (loading && !data) {
    return <div className="model-lifecycle-panel"><div className="loading-dim">Loading model lifecycle…</div></div>;
  }
  if (error && !data) {
    return (
      <div className="model-lifecycle-panel">
        <div className="loading-dim error">Lifecycle did not load: {error}</div>
        <button className="btn btn-sm btn-ghost model-lifecycle-action" onClick={refresh}>Retry</button>
      </div>
    );
  }
  if (!data) return null;

  const gate = data.promotionReadiness.gate;
  const approval = data.approval;

  return (
    <div className="model-lifecycle-panel">
      <div className="model-lifecycle-grid">
        <section className="model-lifecycle-section">
          <div className="model-lifecycle-title"><GitBranch size={15} /> Evaluation timeline</div>
          {data.evalHistory.length === 0 ? (
            <div className="model-lifecycle-empty">No eval history yet for this model</div>
          ) : (
            <>
              <div className="model-lifecycle-charts">
                <Sparkline samples={data.evalHistory} field="score" label="Eval score" />
                <Sparkline samples={data.evalHistory} field="latencyMs" label="Latency" />
              </div>
              <div className="model-lifecycle-samples">
                {data.evalHistory.slice(-5).map((sample) => (
                  <div key={`${sample.ts}-${sample.score}-${sample.latencyMs}`} className="model-lifecycle-sample">
                    <span className="mono">{fmtTs(sample.ts)}</span>
                    <span>score {sample.score == null ? "—" : sample.score.toFixed(2)}</span>
                    <span>{sample.latencyMs == null ? "latency —" : `${Math.round(sample.latencyMs)}ms`}</span>
                    {sample.error ? <Pill color="red">error</Pill> : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="model-lifecycle-section">
          <div className="model-lifecycle-title">Quality and routing</div>
          <div className="model-lifecycle-facts">
            <div><span className="dim">Quality</span><Pill color={qualityColor(data.qualityStatus)}>{data.qualityStatus}</Pill></div>
            <div><span className="dim">Recent failures</span><span className="mono">{data.recentFailures}</span></div>
            <div><span className="dim">Consecutive garbage</span><span className="mono">{data.consecutiveGarbage}</span></div>
            <div><span className="dim">First seen</span><span className="mono">{fmtTs(data.firstSeen)}</span></div>
            <div><span className="dim">Last eval</span><span className="mono">{fmtTs(data.lastEval)}</span></div>
          </div>
          <div className="model-lifecycle-note">
            Quality transitions are not stored in this deployment; current policy state is shown from the model quality file.
          </div>
          {data.routingReliability ? (
            <div className="model-lifecycle-routing">
              <span className="mono">{data.routingReliability.totalRequests}</span> routed calls,
              <span className="mono"> {data.routingReliability.successCount}</span> ok,
              <span className="mono"> {data.routingReliability.failedCount}</span> failed,
              avg latency <span className="mono">{data.routingReliability.avgLatencyMs == null ? "—" : `${Math.round(data.routingReliability.avgLatencyMs)}ms`}</span>
            </div>
          ) : (
            <div className="model-lifecycle-note">Routing reliability is not available because the observability database is not open.</div>
          )}
        </section>

        <section className="model-lifecycle-section model-lifecycle-grc">
          <div className="model-lifecycle-title"><ShieldCheck size={15} /> GRC readiness</div>
          <div className="model-lifecycle-gate">
            <Pill color={readinessColor(gate)}>{gate}</Pill>
            <span className="dim">eval threshold {data.promotionReadiness.threshold.minEvalScore.toFixed(2)}</span>
          </div>
          <ul className="model-lifecycle-reasons">
            {data.promotionReadiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
          {approval ? (
            <div className="model-lifecycle-approval">
              <span>Approval</span>
              <Pill color={approval.status === "approved" ? "green" : approval.status === "pending" ? "amber" : "red"}>{approval.status}</Pill>
              <span className="mono dim">{approval.id}</span>
            </div>
          ) : (
            <div className="model-lifecycle-note">No promotion approval exists for this model.</div>
          )}
          <button
            className="btn btn-sm btn-primary model-lifecycle-action"
            disabled={gate !== "needs-approval"}
            onClick={() => onRequestPromotion(logicalName)}
          >
            Request promotion approval
          </button>
        </section>
      </div>

      <div className="model-lifecycle-unavailable">
        {data.unavailableCapabilities.map((text) => <div key={text}>{text}</div>)}
      </div>
    </div>
  );
}

export function ModelsPage() {
  const { data, loading, error, refresh } = useApi<ModelsDetail>("/api/models", 30_000);
  const [modal, setModal] = useState<Modal | null>(null);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [lifecycleRefreshNonce, setLifecycleRefreshNonce] = useState(0);
  const [promotionState, setPromotionState] = useState<{ loading: boolean; error: string | null; success: string | null }>({
    loading: false,
    error: null,
    success: null,
  });
  const action = useAction("/api/models/action");

  const modelsCtrl = useTableControls<NonNullable<ModelsDetail["models"]>[number], ModelsSortKey>({
    rows: data?.models ?? [],
    pageSize: 25,
    filterText: (row) => [row.logicalName, row.provider, row.providerType, row.qualityStatus].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "logicalName": return row.logicalName;
        case "qualityStatus": return row.qualityStatus ?? "";
        case "provider": return row.provider ?? "";
        case "contextWindow": return row.contextWindow ?? 0;
        case "latency": return row.latency ?? Infinity;
        case "recentFailures": return row.recentFailures ?? 0;
        default: return "";
      }
    },
    defaultSort: { key: "logicalName", dir: "asc" },
  });

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;
  const s = d.summary;

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Models</div>
        <div className="stat-row">
          <div className="stat-item">
            <div className="stat-lbl">best heavy</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent)", marginTop: 2 }}>{s.bestCloudHeavy ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">best fast</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", marginTop: 2 }}>{s.bestCloudFast ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">best local</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", marginTop: 2 }}>{s.bestLocal ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">full check</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{fmtAge(s.lastFullCheckAgo)}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">quick check</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{fmtAge(s.lastQuickCheckAgo)}</div>
          </div>
        </div>
      </div>

      {modal && (
        <ConfirmModal
          title={
            modal.type === "block" ? `Block ${modal.model}?` :
            modal.type === "unblock" ? `Unblock ${modal.model}?` :
            modal.type === "probation-clear" ? `Clear probation for ${modal.model}?` :
            modal.type === "cooldown-clear" ? `Clear cooldown for ${modal.model}?` :
            modal.type === "promotion-request" ? `Request promotion approval for ${modal.model}?` :
            "Run model health check?"
          }
          message={
            modal.type === "block"
              ? `${modal.model} will be marked blocked and excluded from fallback chains.`
              : modal.type === "unblock"
              ? `${modal.model} will be restored to healthy status.`
              : modal.type === "probation-clear"
              ? `${modal.model} will be cleared from probation and restored to healthy status.`
              : modal.type === "cooldown-clear"
              ? `The active cooldown for ${modal.model} will be removed immediately.`
              : modal.type === "promotion-request"
              ? "Creates an auditable governance approval request. It does not promote the model by itself."
              : "Triggers the model-health-check.service immediately."
          }
          confirmLabel={
            modal.type === "block" ? "Block" :
            modal.type === "unblock" ? "Unblock" :
            modal.type === "probation-clear" ? "Clear probation" :
            modal.type === "cooldown-clear" ? "Clear cooldown" :
            modal.type === "promotion-request" ? "Request approval" :
            "Run"
          }
          danger={modal.type === "block"}
          loading={modal.type === "promotion-request" ? promotionState.loading : action.loading}
          error={modal.type === "promotion-request" ? promotionState.error : action.error}
          onCancel={() => {
            setModal(null);
            action.reset();
            setPromotionState({ loading: false, error: null, success: null });
          }}
          onConfirm={async () => {
            if (modal.type === "promotion-request") {
              setPromotionState({ loading: true, error: null, success: null });
              try {
                const res = await authFetch(`/api/models/${encodeURIComponent(modal.model)}/promotion-request`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reason: "Operator requested model promotion approval from /models lifecycle panel." }),
                });
                const json = await res.json().catch(() => ({})) as { error?: string };
                if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
                setPromotionState({ loading: false, error: null, success: "Promotion approval requested" });
                setLifecycleRefreshNonce((n) => n + 1);
                setModal(null);
                return;
              } catch (e) {
                setPromotionState({
                  loading: false,
                  error: e instanceof Error ? e.message : String(e),
                  success: null,
                });
                return;
              }
            }
            let body: unknown;
            if (modal.type === "block") body = { action: "block", model: modal.model };
            else if (modal.type === "unblock") body = { action: "unblock", model: modal.model };
            else if (modal.type === "probation-clear") body = { action: "probation-clear", model: modal.model };
            else if (modal.type === "cooldown-clear") body = { action: "clear-cooldown", model: modal.model };
            else body = { action: "run-quick-check" };
            const ok = await action.run(body);
            if (ok) { setModal(null); refresh(); }
          }}
        />
      )}

      {/* Quality summary */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Pill color="blue">heavy {s.availableByCapability.heavy}</Pill>
        <Pill color="gray">medium {s.availableByCapability.medium}</Pill>
        <Pill color="gray">light {s.availableByCapability.light}</Pill>
        {s.qualitySummary.blocked > 0 && <Pill color="red">blocked {s.qualitySummary.blocked}</Pill>}
        {s.qualitySummary.degraded > 0 && <Pill color="amber">degraded {s.qualitySummary.degraded}</Pill>}
        {s.qualitySummary.probation > 0 && <Pill color="amber">probation {s.qualitySummary.probation}</Pill>}
        {s.newModelsAdded.length > 0 && <Pill color="green">+{s.newModelsAdded.length} new</Pill>}
      </div>

      <div className="action-bar" style={{ marginBottom: 16 }}>
        <button className="btn btn-ghost" onClick={() => setModal({ type: "run-check" })}>
          Run health check
        </button>
        {action.success && <span className="action-feedback ok">{action.success}</span>}
        {action.error && <span className="action-feedback err">{action.error}</span>}
        {promotionState.success && <span className="action-feedback ok">{promotionState.success}</span>}
      </div>

      {/* All models table */}
      <SectionCard
        title="all models"
        id="current"
        defaultOpen={true}
        right={<span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{modelsCtrl.filteredCount} of {data.models.length} shown</span>}
      >
        <div className="section-card-body table-wrap">
          <TableControls {...modelsCtrl.controlsProps} searchPlaceholder="Filter models..." />
          <table className="data-table models-table">
            <colgroup>
              <col className="name-col" />
              <col className="cap-col" />
              <col className="quality-col" />
              <col className="actions-col" />
              <col className="price-col" />
              <col className="type-col" />
              <col className="cli-col" />
              <col className="provider-col" />
              <col className="ctx-col" />
              <col className="rating-col" />
              <col className="latency-col" />
              <col className="json-col" />
              <col className="fails-col" />
            </colgroup>
            <thead><tr>
              <th {...modelsCtrl.sortHeaderProps("logicalName")} className="name-col">Logical model <span className="sortable-th-arrow">{modelsCtrl.sort.key === "logicalName" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th className="cap-col">Capability</th>
              <th {...modelsCtrl.sortHeaderProps("qualityStatus")} className="quality-col">Quality <span className="sortable-th-arrow">{modelsCtrl.sort.key === "qualityStatus" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th className="actions-col">Actions</th>
              <th className="price-col">Pricing</th><th className="type-col">Type</th><th className="cli-col">CLI</th>
              <th {...modelsCtrl.sortHeaderProps("provider")} className="models-col-provider provider-col">provider <span className="sortable-th-arrow">{modelsCtrl.sort.key === "provider" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th {...modelsCtrl.sortHeaderProps("contextWindow")} className="ctx-col">Context <span className="sortable-th-arrow">{modelsCtrl.sort.key === "contextWindow" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th className="rating-col">Rating</th><th {...modelsCtrl.sortHeaderProps("latency")} className="latency-col models-col-latency">Latency <span className="sortable-th-arrow">{modelsCtrl.sort.key === "latency" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th className="models-col-json">JSON</th><th {...modelsCtrl.sortHeaderProps("recentFailures")} className="models-col-failures">Failures <span className="sortable-th-arrow">{modelsCtrl.sort.key === "recentFailures" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
            </tr></thead>
            <tbody>
              {modelsCtrl.rows.map((m) => (
                <Fragment key={m.logicalName}>
                  <tr className={expandedModel === m.logicalName ? "model-row expanded" : "model-row"}>
                    <td className="mono model-name-cell" style={{ color: m.available ? "var(--text-bright)" : "var(--text-dim)" }}>
                      <button
                        className="model-expand-btn"
                        onClick={() => setExpandedModel(expandedModel === m.logicalName ? null : m.logicalName)}
                        aria-expanded={expandedModel === m.logicalName}
                        aria-label={`Toggle lifecycle for ${m.logicalName}`}
                      >
                        {expandedModel === m.logicalName ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                      <span title={m.logicalName}>{m.logicalName}</span>
                    </td>
                    <td><Pill color={m.capability === "heavy" ? "blue" : "gray"}>{m.capability}</Pill></td>
                    <td><Pill color={qualityColor(m.qualityStatus)}>{m.qualityStatus}</Pill></td>
                    <td className="actions-col">
                      <div style={{ display: "flex", gap: 4 }}>
                        {m.qualityStatus === "blocked" ? (
                          <button className="btn btn-sm btn-primary" onClick={() => setModal({ type: "unblock", model: m.logicalName })}>unblock</button>
                        ) : m.qualityStatus === "probation" ? (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => setModal({ type: "probation-clear", model: m.logicalName })}>clear</button>
                            <button className="btn btn-sm btn-danger" onClick={() => setModal({ type: "block", model: m.logicalName })}>block</button>
                          </>
                        ) : (
                          <button className="btn btn-sm btn-danger" onClick={() => setModal({ type: "block", model: m.logicalName })}>block</button>
                        )}
                      </div>
                    </td>
                    <td className="price-col">
                      <div className="model-pricing-cell">
                        {m.isFree && <Pill color="green">free</Pill>}
                        {m.isPaid && !m.isFree && <Pill color="amber">paid</Pill>}
                        {m.isOpenCode && <Pill color="blue">OpenCode</Pill>}
                      </div>
                    </td>
                    <td className="type-col"><Pill>{m.providerType}</Pill></td>
                    <td className="cli-col">{m.isCli ? <Pill color="blue">CLI</Pill> : "—"}</td>
                    <td className="dim mono models-col-provider provider-col">{m.provider}</td>
                    <td className="mono dim ctx-col">{fmtContextWindow(m.contextWindow)}</td>
                    <td className="mono dim rating-col">{(m as any).rating ? (m as any).rating.toFixed(1) : "—"}</td>
                    <td className="mono dim latency-col models-col-latency">{m.latency != null ? `${m.latency}ms` : "—"}</td>
                    <td className="models-col-json"><Pill color={m.jsonOk ? "green" : "red"}>{m.jsonOk ? "✓" : "✗"}</Pill></td>
                    <td className="mono dim models-col-failures">
                      {m.recentFailures > 0 ? <span className="text-red">{m.recentFailures}</span> : "0"}
                    </td>
                  </tr>
                  {expandedModel === m.logicalName ? (
                    <tr className="model-lifecycle-row">
                      <td colSpan={13}>
                        <ModelLifecyclePanel
                          logicalName={m.logicalName}
                          refreshNonce={lifecycleRefreshNonce}
                          onRequestPromotion={(model) => setModal({ type: "promotion-request", model })}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Fallback chains */}
      <SectionCard title="fallback chains" defaultOpen={false}>
        <div className="section-card-body" style={{ padding: "12px 14px" }}>
          <div className="chain-list">
            {Object.entries(d.fallbacks).map(([chain, models]) => (
              <div key={chain} className="chain-item">
                <div className="chain-name">{chain}</div>
                <div className="chain-models">
                  {models.map((m, i) => (
                    <span key={m} className={`chain-model ${i === 0 ? "first" : ""}`}>{i + 1}. {m}</span>
                  ))}
                </div>
              </div>
            ))}
            {Object.keys(d.fallbacks).length === 0 && <div className="loading-dim">no fallback chains in health file</div>}
          </div>
        </div>
      </SectionCard>

      {/* Cooldowns */}
      <SectionCard
        title="active cooldowns"
        id="cooldowns"
        defaultOpen={false}
        right={<span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{d.cooldowns.length}</span>}
      >
        <div className="section-card-body table-wrap">
          {d.cooldowns.length === 0 ? (
            <div className="loading-dim">no active cooldowns</div>
          ) : (
            <table className="data-table">
              <thead><tr><th>model</th><th>expires</th><th>reason</th><th></th></tr></thead>
              <tbody>
                {d.cooldowns.map((c) => (
                  <tr key={c.model}>
                    <td className="mono">{c.model}</td>
                    <td className="mono dim">{new Date(c.expiresAt).toISOString().slice(0, 19).replace("T", " ")} UTC</td>
                    <td className="dim">{c.reason ?? "—"}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ minHeight: 44 }}
                        onClick={() => setModal({ type: "cooldown-clear", model: c.model })}
                      >
                        clear
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SectionCard>

      {/* Discovery log */}
      <SectionCard title="discovery log" id="new" defaultOpen={false}>
        <div className="section-card-body table-wrap">
          {d.discoveryLog.length === 0 ? (
            <div className="loading-dim">discovery log not yet created — will appear after next full model-health-check run</div>
          ) : (
            <table className="data-table">
              <thead><tr><th>time</th><th>new models</th><th>total</th></tr></thead>
              <tbody>
                {[...d.discoveryLog].reverse().map((entry, i) => (
                  <tr key={i}>
                    <td className="mono dim">{entry.ts.slice(0, 19).replace("T", " ")}</td>
                    <td>
                      {entry.newModelsAdded.length > 0
                        ? entry.newModelsAdded.map((m) => <span key={m} className="chain-model" style={{ marginRight: 4 }}>{m}</span>)
                        : <span className="dim">none</span>}
                    </td>
                    <td className="mono dim">{entry.totalModelCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SectionCard>

      <RatingsSection models={d.models} />
    </div>
  );
}
