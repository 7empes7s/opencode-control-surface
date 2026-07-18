import { Fragment, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Copy, GitBranch, ShieldCheck } from "lucide-react";
import { useApi, fmtAge } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { authFetch } from "../lib/authFetch";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import { TableControls } from "../components/TableControls";
import { useTableControls } from "../hooks/useTableControls";
import { RatingsSection } from "./RatingsPage";
import {
  credentialHealthView,
  groupVisibleModels,
  healthSummaryItems,
  modelHealthFilterText,
  modelHealthSortValue,
  modelHealthView,
  type ModelHealthPresentation,
  type ModelsSortKey,
} from "./modelsHealthView";
import type { ChainDiff, ModelChainSyncDetail, ModelsDetail } from "../../server/api/types";

export type { ModelsSortKey } from "./modelsHealthView";

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
  health,
  refreshNonce,
  onRequestPromotion,
}: {
  logicalName: string;
  health: ModelHealthPresentation;
  refreshNonce: number;
  onRequestPromotion: (model: string) => void;
}) {
  const { data, loading, error, refresh } = useApi<ModelLifecycle>(`/api/models/${encodeURIComponent(logicalName)}/lifecycle?refresh=${refreshNonce}`, 0);

  const healthEvidence = (
    <div className="model-health-evidence">
      <div className="model-health-evidence-main">
        <span className="model-health-evidence-label">Health signal</span>
        <Pill color={health.badge.color}>{health.badge.label}</Pill>
        <span className="model-health-reason">{health.reason}</span>
      </div>
      {health.recoveryCallout ? (
        <div className="model-health-recovery" role="note">
          <AlertTriangle size={15} aria-hidden="true" />
          <span><strong>{health.recoveryCallout.lead}</strong> {health.recoveryCallout.detail}</span>
        </div>
      ) : null}
    </div>
  );

  if (loading && !data) {
    return <div className="model-lifecycle-panel">{healthEvidence}<div className="loading-dim">Loading model lifecycle…</div></div>;
  }
  if (error && !data) {
    return (
      <div className="model-lifecycle-panel">
        {healthEvidence}
        <div className="loading-dim error">Lifecycle did not load: {error}</div>
        <button className="btn btn-sm btn-ghost model-lifecycle-action" onClick={refresh}>Retry</button>
      </div>
    );
  }
  if (!data) return <div className="model-lifecycle-panel">{healthEvidence}</div>;

  const gate = data.promotionReadiness.gate;
  const approval = data.approval;

  return (
    <div className="model-lifecycle-panel">
      {healthEvidence}
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

function ChainModelChip({
  model,
  index,
  status,
}: {
  model: string;
  index?: number;
  status?: "added" | "removed";
}) {
  const className = [
    "chain-model",
    index === 0 ? "first" : "",
    status ? `chain-model-${status}` : "",
  ].filter(Boolean).join(" ");
  return <span className={className}>{index != null ? `${index + 1}. ` : ""}{model}</span>;
}

function ChainDiffRow({ chain }: { chain: ChainDiff }) {
  const removed = new Set(chain.removed);
  const added = new Set(chain.added);
  return (
    <div className="chain-sync-row">
      <div className="chain-sync-row-head">
        <div>
          <div className="chain-sync-role">{chain.role}</div>
          <div className="chain-sync-logical mono">{chain.logicalName}</div>
        </div>
        <div className="chain-sync-badges">
          {chain.inSync ? <Pill color="green">in sync</Pill> : null}
          {chain.added.length > 0 ? <Pill color="green">+{chain.added.length}</Pill> : null}
          {chain.removed.length > 0 ? <Pill color="red">-{chain.removed.length}</Pill> : null}
          {chain.reordered ? <Pill color="amber">reordered</Pill> : null}
          {!chain.current ? <Pill color="amber">new</Pill> : null}
        </div>
      </div>
      <div className="chain-sync-cols">
        <div className="chain-sync-col">
          <div className="chain-sync-label">current</div>
          <div className="chain-models">
            {chain.current ? chain.current.map((model, index) => (
              <ChainModelChip key={`${model}-${index}`} model={model} index={index} status={removed.has(model) ? "removed" : undefined} />
            )) : <span className="loading-dim">absent from LiteLLM config</span>}
          </div>
        </div>
        <div className="chain-sync-col">
          <div className="chain-sync-label">proposed</div>
          <div className="chain-models">
            {chain.proposed.map((model, index) => (
              <ChainModelChip key={`${model}-${index}`} model={model} index={index} status={added.has(model) ? "added" : undefined} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FallbackChainSyncSection() {
  const { data, loading, error, refresh } = useApi<ModelChainSyncDetail>("/api/models/chain-sync", 30_000);
  const [copied, setCopied] = useState<"block" | "command" | null>(null);

  async function copyText(kind: "block" | "command", text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1800);
  }

  const changedCount = data?.chains.filter((chain) => !chain.inSync).length ?? 0;

  return (
    <SectionCard
      title="fallback chain sync"
      defaultOpen={true}
      right={data ? (
        <div className="chain-sync-summary">
          <Pill color={data.anyChanges ? "amber" : "green"}>
            {data.anyChanges ? `${changedCount} chain${changedCount === 1 ? "" : "s"} differ` : "All chains in sync"}
          </Pill>
          <span className={data.stale ? "chain-sync-age stale" : "chain-sync-age"}>health checked {fmtAge(data.healthAgeSec)}</span>
        </div>
      ) : null}
    >
      <div className="section-card-body chain-sync-body">
        {loading && !data ? <div className="loading-dim">loading chain sync preview...</div> : null}
        {error && !data ? (
          <div className="chain-sync-error">
            <span>Chain sync preview did not load: {error}</span>
            <button className="btn btn-sm btn-ghost" onClick={refresh}>Retry</button>
          </div>
        ) : null}
        {data ? (
          <>
            {data.configReadError ? (
              <div className="chain-sync-warning">couldn't read /etc/litellm/config.yaml — showing proposed only</div>
            ) : null}
            <div className="chain-sync-list">
              {data.chains.map((chain) => <ChainDiffRow key={chain.role} chain={chain} />)}
              {data.chains.length === 0 ? <div className="loading-dim">no editorial fallback chains in health file</div> : null}
            </div>
            <div className="chain-sync-copy">
              <div className="chain-sync-instruction">1) paste the block into <span className="mono">router_settings.fallbacks</span> in /etc/litellm/config.yaml, 2) run the apply command (backs up + reloads)</div>
              <div className="chain-sync-actions">
                <button className="btn btn-sm btn-ghost" onClick={() => copyText("block", data.correctedYamlBlock)}>
                  <Copy size={14} /> Copy corrected block
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => copyText("command", data.applyCommand)}>
                  <Copy size={14} /> Copy apply command
                </button>
                {copied ? <span className="action-feedback ok">copied {copied === "block" ? "block" : "command"}</span> : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}

function CredentialsSection({ credentials }: { credentials: ModelsDetail["credentials"] }) {
  const rows = credentials.map((credential) => credentialHealthView(credential));

  const gatedModels = (models: string[]) => {
    if (models.length === 0) return <span className="dim">None</span>;
    if (models.length <= 3) return <span className="credential-model-list">{models.join(", ")}</span>;
    return (
      <details className="credential-model-details">
        <summary>{models.slice(0, 2).join(", ")} +{models.length - 2} more</summary>
        <div className="credential-model-list">{models.join(", ")}</div>
      </details>
    );
  };

  return (
    <SectionCard
      title="Credentials / API keys"
      defaultOpen={true}
      right={<span className="models-row-count">{rows.length} fresh observation{rows.length === 1 ? "" : "s"}</span>}
    >
      <div className="section-card-body table-wrap">
        <table className="data-table credential-health-table">
          <colgroup>
            <col className="credential-env-col" />
            <col className="credential-status-col" />
            <col className="credential-freshness-col" />
            <col className="credential-checked-col" />
            <col className="credential-models-col" />
            <col className="credential-guidance-col" />
          </colgroup>
          <thead>
            <tr>
              <th>Environment name</th>
              <th>Status</th>
              <th>Freshness</th>
              <th>Checked</th>
              <th>Gated models</th>
              <th>Operator guidance</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="model-health-empty">No fresh credential-health evidence is available.</td></tr>
            ) : rows.map((credential) => (
              <tr key={credential.envName}>
                <td className="mono">{credential.envName}</td>
                <td><Pill color={credential.statusColor}>{credential.statusLabel}</Pill></td>
                <td><Pill color={credential.freshnessColor}>{credential.freshnessLabel}</Pill></td>
                <td className="mono dim">{credential.checkedAge}</td>
                <td className="mono credential-models-cell">{gatedModels(credential.gatedModels)}</td>
                <td className="credential-guidance-cell">{credential.guidance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
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
    filterText: modelHealthFilterText,
    sortValue: modelHealthSortValue,
    defaultSort: { key: "logicalName", dir: "asc" },
  });

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;
  const s = d.summary;
  const groupedModels = groupVisibleModels(modelsCtrl.rows);

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Models</div>
        <div className="stat-row">
          <div className="stat-item">
            <div className="stat-lbl">best heavy</div>
            <div className="models-stat-value accent">{s.bestCloudHeavy ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">best fast</div>
            <div className="models-stat-value">{s.bestCloudFast ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">best local</div>
            <div className="models-stat-value">{s.bestLocal ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">full check</div>
            <div className="models-stat-value dim">{fmtAge(s.lastFullCheckAgo)}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">quick check</div>
            <div className="models-stat-value dim">{fmtAge(s.lastQuickCheckAgo)}</div>
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

      <div className="models-summary-bar">
        <div className="models-summary-group" aria-label="Health summary">
          {healthSummaryItems(s.healthBucketSummary).map((item) => (
            <Pill key={item.bucket} color={item.color}>{item.label} {item.count}</Pill>
          ))}
        </div>
        <div className="models-summary-group models-summary-inventory" aria-label="Inventory and quality summary">
          <Pill color="blue">heavy {s.availableByCapability.heavy}</Pill>
          <Pill color="gray">medium {s.availableByCapability.medium}</Pill>
          <Pill color="gray">light {s.availableByCapability.light}</Pill>
          {s.qualitySummary.blocked > 0 && <Pill color="red">blocked {s.qualitySummary.blocked}</Pill>}
          {s.qualitySummary.degraded > 0 && <Pill color="amber">degraded {s.qualitySummary.degraded}</Pill>}
          {s.qualitySummary.probation > 0 && <Pill color="amber">probation {s.qualitySummary.probation}</Pill>}
          {s.newModelsAdded.length > 0 && <Pill color="green">+{s.newModelsAdded.length} new</Pill>}
        </div>
      </div>

      <div className="action-bar models-action-bar">
        <button className="btn btn-ghost" onClick={() => setModal({ type: "run-check" })}>
          Run health check
        </button>
        {action.success && <span className="action-feedback ok">{action.success}</span>}
        {action.error && <span className="action-feedback err">{action.error}</span>}
        {promotionState.success && <span className="action-feedback ok">{promotionState.success}</span>}
      </div>

      <CredentialsSection credentials={d.credentials ?? []} />

      {/* All models table */}
      <SectionCard
        title="all models"
        id="current"
        defaultOpen={true}
        right={<span className="models-row-count">{modelsCtrl.rows.length} on page · {modelsCtrl.filteredCount} match</span>}
      >
        <div className="section-card-body table-wrap">
          <TableControls {...modelsCtrl.controlsProps} searchPlaceholder="Filter by model, provider, or health..." />
          <table className="data-table models-table">
            <colgroup>
              <col className="name-col" />
              <col className="health-col" />
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
              <th {...modelsCtrl.sortHeaderProps("logicalName")} className={`name-col ${modelsCtrl.sortHeaderProps("logicalName").className}`}>Logical model <span className="sortable-th-arrow">{modelsCtrl.sort.key === "logicalName" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th {...modelsCtrl.sortHeaderProps("healthState")} className={`health-col ${modelsCtrl.sortHeaderProps("healthState").className}`}>Health <span className="sortable-th-arrow">{modelsCtrl.sort.key === "healthState" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th className="cap-col">Capability</th>
              <th {...modelsCtrl.sortHeaderProps("qualityStatus")} className={`quality-col ${modelsCtrl.sortHeaderProps("qualityStatus").className}`}>Quality <span className="sortable-th-arrow">{modelsCtrl.sort.key === "qualityStatus" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th className="actions-col">Actions</th>
              <th className="price-col">Pricing</th><th className="type-col">Type</th><th className="cli-col">CLI</th>
              <th {...modelsCtrl.sortHeaderProps("provider")} className={`models-col-provider provider-col ${modelsCtrl.sortHeaderProps("provider").className}`}>provider <span className="sortable-th-arrow">{modelsCtrl.sort.key === "provider" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th {...modelsCtrl.sortHeaderProps("contextWindow")} className={`ctx-col ${modelsCtrl.sortHeaderProps("contextWindow").className}`}>Context <span className="sortable-th-arrow">{modelsCtrl.sort.key === "contextWindow" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th className="rating-col">Rating</th><th {...modelsCtrl.sortHeaderProps("latency")} className={`latency-col models-col-latency ${modelsCtrl.sortHeaderProps("latency").className}`}>Latency <span className="sortable-th-arrow">{modelsCtrl.sort.key === "latency" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
              <th className="models-col-json">JSON</th><th {...modelsCtrl.sortHeaderProps("recentFailures")} className={`models-col-failures ${modelsCtrl.sortHeaderProps("recentFailures").className}`}>Failures <span className="sortable-th-arrow">{modelsCtrl.sort.key === "recentFailures" ? (modelsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
            </tr></thead>
            {modelsCtrl.rows.length === 0 ? (
              <tbody>
                <tr>
                  <td className="model-health-empty" colSpan={14}>
                    {modelsCtrl.query.trim() ? "No models match this filter." : "No model evidence is available yet."}
                  </td>
                </tr>
              </tbody>
            ) : groupedModels.map((group) => (
              <tbody key={group.bucket} className={`model-health-group model-health-group-${group.bucket}`}>
                <tr className="model-health-group-row">
                  <th colSpan={14} scope="rowgroup">
                    <div className="model-health-group-heading">
                      <span className="model-health-group-label">{group.label}</span>
                      <span className="model-health-group-states">{group.statesLabel}</span>
                      <span className="model-health-group-count">{group.rows.length} on this page</span>
                    </div>
                  </th>
                </tr>
                {group.rows.map((m) => {
                  const health = modelHealthView(m);
                  return <Fragment key={m.logicalName}>
                    <tr className={expandedModel === m.logicalName ? "model-row expanded" : "model-row"}>
                    <td className={`mono model-name-cell ${m.available ? "available" : "unavailable"}`}>
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
                    <td className="health-col"><Pill color={health.badge.color}>{health.badge.label}</Pill></td>
                    <td><Pill color={m.capability === "heavy" ? "blue" : "gray"}>{m.capability}</Pill></td>
                    <td className="quality-col"><Pill color={qualityColor(m.qualityStatus)}>{m.qualityStatus}</Pill></td>
                    <td className="actions-col">
                      <div className="model-row-actions">
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
                        <td colSpan={14}>
                          <ModelLifecyclePanel
                            logicalName={m.logicalName}
                            health={health}
                            refreshNonce={lifecycleRefreshNonce}
                            onRequestPromotion={(model) => setModal({ type: "promotion-request", model })}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>;
                })}
              </tbody>
            ))}
          </table>
        </div>
      </SectionCard>

      <FallbackChainSyncSection />

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
