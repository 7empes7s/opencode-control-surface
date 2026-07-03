import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useApi, fmtAge } from "../hooks/useApi";
import { SectionCard } from "../components/SectionCard";
import { ConfirmModal } from "../components/ConfirmModal";
import { TableControls } from "../components/TableControls";
import { useTableControls } from "../hooks/useTableControls";
import { authFetch } from "../lib/authFetch";

interface CostData {
  headline?: {
    monthToDateCents: number | null;
    projectedMonthEndCents: number | null;
    savedVsPaidBaselineCents: number | null;
    freeShare: number | null;
  };
  budgets: Array<{
    id: string;
    scope: string;
    project_id: string | null;
    daily_cap_usd: number | null;
    monthly_cap_usd: number | null;
    warn_pct: number;
    created_at: number;
    updated_at: number;
    cap_cents?: number;
    used_cents?: number;
    daily_used_cents?: number;
    monthly_used_cents?: number;
    usage_pct?: number;
  }>;
  spend: {
    totals: Array<{
      total_cents: number;
      event_count: number;
    }>;
    groups: Array<{
      total_cents: number;
      event_count: number;
      group_value: string;
    }>;
  };
  runway: {
    hourly_cents: number | null;
    balance_cents: number;
    hours_remaining: number | null;
    days_remaining: number | null;
    last_checked_at: number;
    instance_status?: string | null;
  };
  fallbacks: Array<{
    id: number;
    ts: number;
    logical_model: string;
    resolved_model: string;
    backend: string;
    tier: string;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    latency_ms: number | null;
    cost_estimate_usd: number | null;
    success: number;
    error_class: string | null;
    trace_id: string | null;
    caller: string | null;
  }>;
  anomalies: Array<{
    id: string;
    ts: number;
    kind: string;
    severity: string;
    entityType: string | null;
    entityId: string | null;
    summary: string;
    payload: unknown;
  }>;
  discoveryHistory: Array<{
    ts: number;
    event_ts: string;
    new_models_added: string[];
    total_model_count: number | null;
    source: string;
  }>;
}

type BudgetRow = CostData["budgets"][number];
type AnomalyRow = CostData["anomalies"][number];
type DiscoveryRow = CostData["discoveryHistory"][number];
type SpendRow = CostData["spend"]["groups"][number];
type FallbackRow = CostData["fallbacks"][number];

type BudgetSortKey = "scope" | "period" | "budget" | "used" | "status" | "updated";
type AnomalySortKey = "ts" | "severity" | "kind" | "target";
type DiscoverySortKey = "ts" | "newModels" | "total" | "source";
type SpendSortKey = "group" | "spend" | "events";
type FallbackSortKey = "ts" | "logical" | "resolved" | "backend" | "cost" | "error";

function budgetPeriod(budget: BudgetRow): string {
  if (budget.daily_cap_usd && budget.monthly_cap_usd) return "Daily / Monthly";
  if (budget.daily_cap_usd) return "Daily";
  return "Monthly";
}

function budgetCapCents(budget: BudgetRow): number {
  return budget.cap_cents ?? Math.round((budget.daily_cap_usd ?? budget.monthly_cap_usd ?? 0) * 100);
}

function budgetUsedCents(budget: BudgetRow): number {
  return budget.used_cents ?? 0;
}

function budgetUsagePct(budget: BudgetRow): number {
  const capCents = budgetCapCents(budget);
  return budget.usage_pct ?? (capCents > 0 ? budgetUsedCents(budget) / capCents : 0);
}

function budgetStatus(budget: BudgetRow): { color: string; label: string; rank: number } {
  const usagePct = budgetUsagePct(budget);
  if (usagePct >= 1.0) return { color: "critical", label: "Over budget", rank: 2 };
  if (usagePct >= budget.warn_pct) return { color: "warning", label: "Warning", rank: 1 };
  return { color: "normal", label: "Normal", rank: 0 };
}

function SortArrow({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  return <span className="sortable-th-arrow">{active ? (dir === "asc" ? "▲" : "▼") : "⇅"}</span>;
}

function GlobalCapEditor({
  defaultDaily,
  defaultMonthly,
  onSubmit,
}: {
  defaultDaily: number;
  defaultMonthly: number;
  onSubmit: (daily: number, monthly: number) => void;
}) {
  const [daily, setDaily] = useState(String(defaultDaily));
  const [monthly, setMonthly] = useState(String(defaultMonthly));

  const dailyNum = parseFloat(daily);
  const monthlyNum = parseFloat(monthly);
  const valid = isFinite(dailyNum) && dailyNum > 0 && isFinite(monthlyNum) && monthlyNum > 0;

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
        Set the global AI spend cap. Gateway calls are blocked when the cap is reached. Change is audited.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div>
          <label className="modal-input-label" style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Daily cap (USD)</label>
          <input
            className="modal-input"
            type="number"
            min="0.1"
            step="0.5"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            style={{ width: 100, minHeight: 44 }}
          />
        </div>
        <div>
          <label className="modal-input-label" style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Monthly cap (USD)</label>
          <input
            className="modal-input"
            type="number"
            min="1"
            step="1"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            style={{ width: 100, minHeight: 44 }}
          />
        </div>
        <button
          className="btn btn-primary"
          style={{ minHeight: 44 }}
          disabled={!valid}
          onClick={() => valid && onSubmit(dailyNum, monthlyNum)}
        >
          Update cap
        </button>
      </div>
    </div>
  );
}

function ProjectCapEditor({
  onSubmit,
}: {
  onSubmit: (projectId: string, daily: number, monthly: number, warnPct: number) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [daily, setDaily] = useState("2");
  const [monthly, setMonthly] = useState("20");
  const [warnPct, setWarnPct] = useState("80");

  const dailyNum = parseFloat(daily);
  const monthlyNum = parseFloat(monthly);
  const warnNum = parseFloat(warnPct);
  const cleanProjectId = projectId.trim();
  const valid = cleanProjectId.length > 0
    && isFinite(dailyNum) && dailyNum > 0
    && isFinite(monthlyNum) && monthlyNum > 0
    && isFinite(warnNum) && warnNum >= 10 && warnNum <= 100;

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
        Set a per-project spend cap. Project spend is read from cost attribution events and the change is audited.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div>
          <label className="modal-input-label" style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Project</label>
          <input
            className="modal-input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="project id"
            style={{ width: 180, minHeight: 44 }}
          />
        </div>
        <div>
          <label className="modal-input-label" style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Daily cap</label>
          <input className="modal-input" type="number" min="0.1" step="0.5" value={daily} onChange={(e) => setDaily(e.target.value)} style={{ width: 100, minHeight: 44 }} />
        </div>
        <div>
          <label className="modal-input-label" style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Monthly cap</label>
          <input className="modal-input" type="number" min="1" step="1" value={monthly} onChange={(e) => setMonthly(e.target.value)} style={{ width: 100, minHeight: 44 }} />
        </div>
        <div>
          <label className="modal-input-label" style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Warn %</label>
          <input className="modal-input" type="number" min="10" max="100" step="5" value={warnPct} onChange={(e) => setWarnPct(e.target.value)} style={{ width: 88, minHeight: 44 }} />
        </div>
        <button
          className="btn btn-primary"
          style={{ minHeight: 44 }}
          disabled={!valid}
          onClick={() => valid && onSubmit(cleanProjectId, dailyNum, monthlyNum, warnNum / 100)}
        >
          Set project cap
        </button>
      </div>
    </div>
  );
}

export function CostPage() {
  const { data, loading, error, refresh } = useApi<CostData>("/api/cost/summary", 30_000);
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d">("30d");
  const [capModal, setCapModal] = useState<{ scope: "global" | "project"; projectId?: string; dailyCap: string; monthlyCap: string; warnPct?: string } | null>(null);
  const [capLoading, setCapLoading] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const [capSuccess, setCapSuccess] = useState<string | null>(null);

  const anomalyControls = useTableControls<AnomalyRow, AnomalySortKey>({
    rows: data?.anomalies ?? [],
    pageSize: 10,
    rowKey: (row) => row.id,
    defaultSort: { key: "ts", dir: "desc" },
    filterText: (row) => [row.summary, row.kind, row.severity, row.entityType, row.entityId],
    sortValue: (row, key) => {
      if (key === "ts") return row.ts;
      if (key === "target") return row.entityId || row.entityType || "cost";
      return row[key];
    },
  });
  const budgetControls = useTableControls<BudgetRow, BudgetSortKey>({
    rows: data?.budgets ?? [],
    pageSize: 10,
    rowKey: (row) => row.id,
    defaultSort: { key: "scope", dir: "asc" },
    filterText: (row) => [row.scope, row.project_id, budgetPeriod(row), budgetStatus(row).label],
    sortValue: (row, key) => {
      if (key === "period") return budgetPeriod(row);
      if (key === "budget") return budgetCapCents(row);
      if (key === "used") return budgetUsedCents(row);
      if (key === "status") return budgetStatus(row).rank;
      if (key === "updated") return row.updated_at;
      return row.scope;
    },
  });
  const discoveryControls = useTableControls<DiscoveryRow, DiscoverySortKey>({
    rows: data?.discoveryHistory ?? [],
    pageSize: 10,
    rowKey: (row) => `${row.event_ts}-${row.source}`,
    defaultSort: { key: "ts", dir: "desc" },
    filterText: (row) => [row.source, row.event_ts, row.new_models_added.join(" "), row.total_model_count],
    sortValue: (row, key) => {
      if (key === "newModels") return row.new_models_added.length;
      if (key === "total") return row.total_model_count ?? 0;
      if (key === "source") return row.source;
      return row.ts;
    },
  });
  const spendControls = useTableControls<SpendRow, SpendSortKey>({
    rows: data?.spend.groups ?? [],
    pageSize: 10,
    rowKey: (row) => row.group_value || "uncategorized",
    defaultSort: { key: "spend", dir: "desc" },
    filterText: (row) => [row.group_value || "Uncategorized", row.total_cents, row.event_count],
    sortValue: (row, key) => {
      if (key === "group") return row.group_value || "Uncategorized";
      if (key === "events") return row.event_count;
      return row.total_cents;
    },
  });
  const fallbackControls = useTableControls<FallbackRow, FallbackSortKey>({
    rows: data?.fallbacks ?? [],
    pageSize: 10,
    rowKey: (row) => String(row.id),
    defaultSort: { key: "ts", dir: "desc" },
    filterText: (row) => [row.logical_model, row.resolved_model, row.backend, row.tier, row.error_class, row.trace_id, row.caller],
    sortValue: (row, key) => {
      if (key === "logical") return row.logical_model;
      if (key === "resolved") return row.resolved_model;
      if (key === "backend") return row.backend;
      if (key === "cost") return row.cost_estimate_usd ?? 0;
      if (key === "error") return row.error_class ?? "";
      return row.ts;
    },
  });

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;
  const headline = d.headline ?? {
    monthToDateCents: null,
    projectedMonthEndCents: null,
    savedVsPaidBaselineCents: null,
    freeShare: null,
  };

  // Format currency
  const fmtCurrency = (cents: number | null): string => {
    if (cents === null) return "—";
    return `$${(cents / 100).toFixed(2)}`;
  };

  // Format percentage
  const fmtPct = (value: number): string => {
    return `${(value * 100).toFixed(0)}%`;
  };

  async function applyCapChange(reason: string) {
    if (!capModal) return;
    const dailyCapUsd = parseFloat(capModal.dailyCap);
    const monthlyCapUsd = parseFloat(capModal.monthlyCap);
    const warnPct = capModal.warnPct ? parseFloat(capModal.warnPct) : 0.8;
    if (!isFinite(dailyCapUsd) || dailyCapUsd <= 0) { setCapError("Invalid daily cap"); return; }
    if (!isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) { setCapError("Invalid monthly cap"); return; }
    if (!isFinite(warnPct) || warnPct < 0.1 || warnPct > 1) { setCapError("Invalid warn threshold"); return; }
    const encodedProjectId = capModal.projectId ? encodeURIComponent(capModal.projectId) : "";
    const actionId = capModal.scope === "project"
      ? `mutate-policy:budget:project:${encodedProjectId}:set-cap`
      : "mutate-policy:budget:global:set-cap";
    setCapLoading(true);
    setCapError(null);
    try {
      const res = await authFetch("/api/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId,
          confirmed: true,
          reason,
          params: { dailyCapUsd, monthlyCapUsd, warnPct },
        }),
      });
      const json = await res.json() as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !json.ok) { setCapError(json.error ?? `HTTP ${res.status}`); return; }
      setCapSuccess(json.message ?? "Cap updated");
      setCapModal(null);
      refresh();
    } catch (e) {
      setCapError(e instanceof Error ? e.message : String(e));
    } finally {
      setCapLoading(false);
    }
  }

  return (
    <div className="dash-page">
      {capModal && (
        <ConfirmModal
          title={capModal.scope === "project" ? "Set project cost cap" : "Set global cost cap"}
          message={capModal.scope === "project"
            ? `Update the ${capModal.projectId} budget cap to $${capModal.dailyCap}/day and $${capModal.monthlyCap}/month. Warn threshold: ${Math.round((parseFloat(capModal.warnPct ?? "0.8") || 0.8) * 100)}%.`
            : `Update the global budget cap to $${capModal.dailyCap}/day and $${capModal.monthlyCap}/month. Gateway calls will be blocked when the cap is reached.`}
          inputLabel="Reason"
          inputPlaceholder="Why are you changing the cap?"
          loading={capLoading}
          error={capError}
          onCancel={() => { setCapModal(null); setCapError(null); }}
          onConfirm={(reason) => applyCapChange(reason ?? "")}
        />
      )}
      <div className="page-header">
        <div className="page-title">Cost Management</div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {/* CFO Headline Band */}
      <div className="dash-section">
        <div className="dash-section-title">This Month at a Glance</div>
        <div className="widget-grid">
          <div className="w-card">
            <div className="w-label">Spend (MTD)</div>
            <div className="w-headline">{fmtCurrency(headline.monthToDateCents)}</div>
            {headline.monthToDateCents === null && (
              <div className="w-caption" title="No priced gateway calls recorded this month yet">needs gateway ledger data</div>
            )}
          </div>
          <div className="w-card">
            <div className="w-label">Projected Month-End</div>
            <div className="w-headline">{fmtCurrency(headline.projectedMonthEndCents)}</div>
            {headline.projectedMonthEndCents === null && (
              <div className="w-caption" title="Projection needs at least 2 elapsed days of priced spend this month">needs 2+ days of spend data</div>
            )}
          </div>
          <div className="w-card">
            <div className="w-label">Saved by Free-First</div>
            <div className="w-headline">{fmtCurrency(headline.savedVsPaidBaselineCents)}</div>
            {headline.savedVsPaidBaselineCents === null && (
              <div className="w-caption" title="Savings need a cloud-paid price catalog entry and token counts on free-routed calls">needs price catalog / token data</div>
            )}
          </div>
          <div className="w-card">
            <div className="w-label">Free-Routed Share</div>
            <div className="w-headline">{headline.freeShare !== null ? fmtPct(headline.freeShare) : "—"}</div>
            {headline.freeShare === null && (
              <div className="w-caption" title="No gateway calls recorded this month yet">needs gateway ledger data</div>
            )}
          </div>
        </div>
      </div>

      {/* Vast Runway Card */}
      <div className="dash-section">
        <div className="dash-section-title">Vast GPU Runway</div>
        <div className="widget-grid">
          <div className="w-card">
            <div className="w-label">Current Balance</div>
            <div className="w-headline">{fmtCurrency(d.runway.balance_cents)}</div>
          </div>
          <div className="w-card">
            <div className="w-label">Hourly Burn Rate</div>
            <div className="w-headline sm">{d.runway.hourly_cents !== null ? `${fmtCurrency(d.runway.hourly_cents)}/hr` : "—"}</div>
          </div>
          <div className="w-card">
            <div className="w-label">Runway Remaining</div>
            <div className="w-headline">{d.runway.days_remaining !== null ? `${d.runway.days_remaining.toFixed(1)} days` : "—"}</div>
            <div className="w-caption">{d.runway.hours_remaining !== null ? `${d.runway.hours_remaining.toFixed(0)} hours` : ""}</div>
          </div>
        </div>
        <div className="w-caption" style={{ marginTop: 8 }}>
          Last checked {fmtAge(d.runway.last_checked_at)}
        </div>
      </div>

      {/* Cost Anomalies */}
      <div className="dash-section">
        <div className="dash-section-title">Cost Anomalies</div>
        <SectionCard
          title="Recent Detector Findings"
          id="cost-anomalies"
          defaultOpen={true}
        >
          <div className="section-card-body table-wrap">
            {d.anomalies.length === 0 ? (
              <div className="loading-dim">No cost anomalies detected in the last 30 days</div>
            ) : (
              <>
              <TableControls {...anomalyControls.controlsProps} searchPlaceholder="Search anomaly, kind, severity, or target..." />
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="expander-col" aria-label="Details"></th>
                    <th {...anomalyControls.sortHeaderProps("ts")}>Time <SortArrow active={anomalyControls.sort.key === "ts"} dir={anomalyControls.sort.dir} /></th>
                    <th {...anomalyControls.sortHeaderProps("severity")}>Severity <SortArrow active={anomalyControls.sort.key === "severity"} dir={anomalyControls.sort.dir} /></th>
                    <th {...anomalyControls.sortHeaderProps("kind")}>Finding <SortArrow active={anomalyControls.sort.key === "kind"} dir={anomalyControls.sort.dir} /></th>
                    <th {...anomalyControls.sortHeaderProps("target")}>Target <SortArrow active={anomalyControls.sort.key === "target"} dir={anomalyControls.sort.dir} /></th>
                  </tr>
                </thead>
                <tbody>
                  {anomalyControls.rows.map((anomaly) => {
                    const rowKey = anomalyControls.getRowKey(anomaly);
                    const expanded = anomalyControls.isExpanded(rowKey);
                    return (
                      <Fragment key={anomaly.id}>
                        <tr>
                          <td className="expander-col">
                            <button className="table-expander" type="button" onClick={() => anomalyControls.toggleExpanded(rowKey)} aria-expanded={expanded} aria-label={`Toggle details for ${anomaly.summary}`}>
                              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td className="mono">{fmtAge(anomaly.ts)}</td>
                          <td>
                            <span className={`pill ${anomaly.severity === "error" ? "critical" : "warning"}`}>
                              {anomaly.severity}
                            </span>
                          </td>
                          <td>
                            <div className="cell-wrap">{anomaly.summary}</div>
                            <div className="w-caption mono">{anomaly.kind}</div>
                          </td>
                          <td>{anomaly.entityId || anomaly.entityType || "cost"}</td>
                        </tr>
                        {expanded && (
                          <tr className="data-row-detail">
                            <td colSpan={5}>
                              <div className="data-row-detail-inner">
                                <div className="data-row-detail-grid">
                                  <div><span>Kind</span><strong>{anomaly.kind}</strong></div>
                                  <div><span>Entity type</span><strong>{anomaly.entityType ?? "cost"}</strong></div>
                                  <div><span>Entity ID</span><strong>{anomaly.entityId ?? "—"}</strong></div>
                                  <div><span>Timestamp</span><strong>{new Date(anomaly.ts).toLocaleString()}</strong></div>
                                </div>
                                <pre className="detail-json">{JSON.stringify(anomaly.payload, null, 2)}</pre>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </>
            )}
          </div>
        </SectionCard>
      </div>

      {/* Budgets Section */}
      <div className="dash-section">
        <div className="dash-section-title">Budgets</div>
        <SectionCard
          title="Active Budgets"
          id="budgets"
          defaultOpen={true}
        >
          <div className="section-card-body table-wrap">
            {d.budgets.length === 0 ? (
              <div className="loading-dim">No budgets defined — use the editor below to set a global cap.</div>
            ) : (
              <>
              <TableControls {...budgetControls.controlsProps} searchPlaceholder="Search scope, project, period, or status..." />
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="expander-col" aria-label="Details"></th>
                    <th {...budgetControls.sortHeaderProps("scope")}>Scope <SortArrow active={budgetControls.sort.key === "scope"} dir={budgetControls.sort.dir} /></th>
                    <th {...budgetControls.sortHeaderProps("period")}>Period <SortArrow active={budgetControls.sort.key === "period"} dir={budgetControls.sort.dir} /></th>
                    <th {...budgetControls.sortHeaderProps("budget")}>Budget <SortArrow active={budgetControls.sort.key === "budget"} dir={budgetControls.sort.dir} /></th>
                    <th {...budgetControls.sortHeaderProps("used")}>Used <SortArrow active={budgetControls.sort.key === "used"} dir={budgetControls.sort.dir} /></th>
                    <th {...budgetControls.sortHeaderProps("status")}>Status <SortArrow active={budgetControls.sort.key === "status"} dir={budgetControls.sort.dir} /></th>
                  </tr>
                </thead>
                <tbody>
                  {budgetControls.rows.map((budget) => {
                    const period = budgetPeriod(budget);
                    const capCents = budgetCapCents(budget);
                    const usedCents = budgetUsedCents(budget);
                    const usagePct = budgetUsagePct(budget);
                    const budgetText = budget.daily_cap_usd && budget.monthly_cap_usd
                      ? `${fmtCurrency(Math.round(budget.daily_cap_usd * 100))} / ${fmtCurrency(Math.round(budget.monthly_cap_usd * 100))}`
                      : fmtCurrency(capCents);
                    const usedText = budget.daily_cap_usd && budget.monthly_cap_usd
                      ? `${fmtCurrency(budget.daily_used_cents ?? 0)} / ${fmtCurrency(budget.monthly_used_cents ?? 0)}`
                      : fmtCurrency(usedCents);
                    const status = budgetStatus(budget);
                    const rowKey = budgetControls.getRowKey(budget);
                    const expanded = budgetControls.isExpanded(rowKey);

                    return (
                      <Fragment key={budget.id}>
                        <tr>
                          <td className="expander-col">
                            <button className="table-expander" type="button" onClick={() => budgetControls.toggleExpanded(rowKey)} aria-expanded={expanded} aria-label={`Toggle details for ${budget.scope} budget`}>
                              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td>{budget.scope}{budget.project_id ? ` (${budget.project_id})` : ""}</td>
                          <td>{period}</td>
                          <td>{budgetText}</td>
                          <td>{usedText} ({fmtPct(usagePct)})</td>
                          <td>
                            <span className={`pill ${status.color}`}>
                              {status.label}
                            </span>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="data-row-detail">
                            <td colSpan={6}>
                              <div className="data-row-detail-inner">
                                <div className="data-row-detail-grid">
                                  <div><span>Daily cap</span><strong>{budget.daily_cap_usd == null ? "—" : fmtCurrency(Math.round(budget.daily_cap_usd * 100))}</strong></div>
                                  <div><span>Monthly cap</span><strong>{budget.monthly_cap_usd == null ? "—" : fmtCurrency(Math.round(budget.monthly_cap_usd * 100))}</strong></div>
                                  <div><span>Daily used</span><strong>{fmtCurrency(budget.daily_used_cents ?? 0)}</strong></div>
                                  <div><span>Monthly used</span><strong>{fmtCurrency(budget.monthly_used_cents ?? 0)}</strong></div>
                                  <div><span>Warn threshold</span><strong>{fmtPct(budget.warn_pct)}</strong></div>
                                  <div><span>Updated</span><strong>{new Date(budget.updated_at).toLocaleString()}</strong></div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </>
            )}
          </div>
        </SectionCard>

        {/* Cost cap editor */}
        <SectionCard title="Set global cap" id="cap-editor" defaultOpen={true}>
          <div className="section-card-body" style={{ padding: "14px 16px" }}>
            {capSuccess && <div className="action-feedback ok" style={{ marginBottom: 10, fontSize: 12 }}>{capSuccess}</div>}
            <GlobalCapEditor
              defaultDaily={d.budgets.find((b) => b.scope === "global")?.daily_cap_usd ?? 5}
              defaultMonthly={d.budgets.find((b) => b.scope === "global")?.monthly_cap_usd ?? 50}
              onSubmit={(daily, monthly) => {
                setCapSuccess(null);
                setCapError(null);
                setCapModal({ scope: "global", dailyCap: String(daily), monthlyCap: String(monthly) });
              }}
            />
          </div>
        </SectionCard>

        <SectionCard title="Set project cap" id="project-cap-editor" defaultOpen={true}>
          <div className="section-card-body" style={{ padding: "14px 16px" }}>
            <ProjectCapEditor
              onSubmit={(projectId, daily, monthly, warnPct) => {
                setCapSuccess(null);
                setCapError(null);
                setCapModal({ scope: "project", projectId, dailyCap: String(daily), monthlyCap: String(monthly), warnPct: String(warnPct) });
              }}
            />
          </div>
        </SectionCard>
      </div>

      <div className="dash-section">
        <div className="dash-section-title">Model Discovery History</div>
        <SectionCard title="Last discovery events" id="model-discovery-history" defaultOpen={false}>
          <div className="section-card-body table-wrap">
            {d.discoveryHistory.length === 0 ? (
              <div className="loading-dim">No model discovery history has been recorded yet.</div>
            ) : (
              <>
              <TableControls {...discoveryControls.controlsProps} searchPlaceholder="Search source, timestamp, or discovered model..." />
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="expander-col" aria-label="Details"></th>
                    <th {...discoveryControls.sortHeaderProps("ts")}>Time <SortArrow active={discoveryControls.sort.key === "ts"} dir={discoveryControls.sort.dir} /></th>
                    <th {...discoveryControls.sortHeaderProps("newModels")}>New models <SortArrow active={discoveryControls.sort.key === "newModels"} dir={discoveryControls.sort.dir} /></th>
                    <th {...discoveryControls.sortHeaderProps("total")}>Total <SortArrow active={discoveryControls.sort.key === "total"} dir={discoveryControls.sort.dir} /></th>
                    <th {...discoveryControls.sortHeaderProps("source")}>Source <SortArrow active={discoveryControls.sort.key === "source"} dir={discoveryControls.sort.dir} /></th>
                  </tr>
                </thead>
                <tbody>
                  {discoveryControls.rows.map((event) => {
                    const rowKey = discoveryControls.getRowKey(event);
                    const expanded = discoveryControls.isExpanded(rowKey);
                    return (
                      <Fragment key={`${event.event_ts}-${event.source}`}>
                        <tr>
                          <td className="expander-col">
                            <button className="table-expander" type="button" onClick={() => discoveryControls.toggleExpanded(rowKey)} aria-expanded={expanded} aria-label={`Toggle details for discovery event ${event.event_ts}`}>
                              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td className="mono">{fmtAge(event.ts)}</td>
                          <td className="cell-ellipsis" title={event.new_models_added.join(", ")}>{event.new_models_added.length > 0 ? event.new_models_added.join(", ") : "—"}</td>
                          <td>{event.total_model_count ?? "—"}</td>
                          <td className="mono">{event.source}</td>
                        </tr>
                        {expanded && (
                          <tr className="data-row-detail">
                            <td colSpan={5}>
                              <div className="data-row-detail-inner">
                                <div className="data-row-detail-grid">
                                  <div><span>Event time</span><strong>{event.event_ts}</strong></div>
                                  <div><span>Source</span><strong>{event.source}</strong></div>
                                  <div><span>Total model count</span><strong>{event.total_model_count ?? "—"}</strong></div>
                                  <div><span>New model count</span><strong>{event.new_models_added.length}</strong></div>
                                </div>
                                <div className="cell-wrap">{event.new_models_added.length > 0 ? event.new_models_added.join(", ") : "No new models were added in this event."}</div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </>
            )}
          </div>
        </SectionCard>
      </div>

      {/* Spend Analysis */}
      <div className="dash-section">
        <div className="dash-section-title">Spend Analysis</div>
        <div className="filters" style={{ marginBottom: 16 }}>
          <div className="filter-group">
            <label>Time Range:</label>
            <select 
              value={timeRange} 
              onChange={(e) => setTimeRange(e.target.value as any)}
              className="form-select"
            >
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
              <option value="90d">Last 90 Days</option>
            </select>
          </div>
        </div>

        <SectionCard
          title="Spend by Category"
          id="spend-category"
          defaultOpen={true}
        >
          <div className="section-card-body table-wrap">
            <TableControls {...spendControls.controlsProps} searchPlaceholder="Search category..." />
            <table className="data-table">
              <thead>
                <tr>
                  <th {...spendControls.sortHeaderProps("group")}>Category <SortArrow active={spendControls.sort.key === "group"} dir={spendControls.sort.dir} /></th>
                  <th {...spendControls.sortHeaderProps("spend")} className="cell-right">Spend <SortArrow active={spendControls.sort.key === "spend"} dir={spendControls.sort.dir} /></th>
                  <th {...spendControls.sortHeaderProps("events")} className="cell-right">Events <SortArrow active={spendControls.sort.key === "events"} dir={spendControls.sort.dir} /></th>
                </tr>
              </thead>
              <tbody>
                {spendControls.rows.map((group) => (
                  <tr key={group.group_value || "uncategorized"}>
                    <td>{group.group_value || "Uncategorized"}</td>
                    <td className="cell-right">{fmtCurrency(group.total_cents)}</td>
                    <td className="cell-right">{group.event_count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      {/* Fallback Analysis */}
      <div className="dash-section">
        <div className="dash-section-title">Fallback Usage</div>
        <SectionCard
          title="Recent Fallbacks"
          id="fallbacks"
          defaultOpen={false}
        >
          <div className="section-card-body table-wrap">
            {d.fallbacks.length === 0 ? (
              <div className="loading-dim">No fallbacks detected</div>
            ) : (
              <>
              <TableControls {...fallbackControls.controlsProps} searchPlaceholder="Search logical model, fallback, backend, tier, trace, or error..." />
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="expander-col" aria-label="Details"></th>
                    <th {...fallbackControls.sortHeaderProps("ts")}>Time <SortArrow active={fallbackControls.sort.key === "ts"} dir={fallbackControls.sort.dir} /></th>
                    <th {...fallbackControls.sortHeaderProps("logical")}>Logical model <SortArrow active={fallbackControls.sort.key === "logical"} dir={fallbackControls.sort.dir} /></th>
                    <th {...fallbackControls.sortHeaderProps("resolved")}>Fallback model <SortArrow active={fallbackControls.sort.key === "resolved"} dir={fallbackControls.sort.dir} /></th>
                    <th {...fallbackControls.sortHeaderProps("backend")}>Backend <SortArrow active={fallbackControls.sort.key === "backend"} dir={fallbackControls.sort.dir} /></th>
                    <th {...fallbackControls.sortHeaderProps("cost")} className="cell-right">Cost estimate <SortArrow active={fallbackControls.sort.key === "cost"} dir={fallbackControls.sort.dir} /></th>
                    <th {...fallbackControls.sortHeaderProps("error")}>Error <SortArrow active={fallbackControls.sort.key === "error"} dir={fallbackControls.sort.dir} /></th>
                  </tr>
                </thead>
                <tbody>
                  {fallbackControls.rows.map((fallback) => {
                    const rowKey = fallbackControls.getRowKey(fallback);
                    const expanded = fallbackControls.isExpanded(rowKey);
                    return (
                      <Fragment key={fallback.id}>
                        <tr>
                          <td className="expander-col">
                            <button className="table-expander" type="button" onClick={() => fallbackControls.toggleExpanded(rowKey)} aria-expanded={expanded} aria-label={`Toggle details for fallback ${fallback.id}`}>
                              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td className="mono">{new Date(fallback.ts).toLocaleTimeString()}</td>
                          <td className="cell-ellipsis" title={fallback.logical_model}>{fallback.logical_model}</td>
                          <td className="cell-ellipsis" title={fallback.resolved_model}>{fallback.resolved_model}</td>
                          <td>{fallback.backend}</td>
                          <td className="cell-right">{fallback.cost_estimate_usd ? `$${fallback.cost_estimate_usd.toFixed(4)}` : "—"}</td>
                          <td>{fallback.error_class || "—"}</td>
                        </tr>
                        {expanded && (
                          <tr className="data-row-detail">
                            <td colSpan={7}>
                              <div className="data-row-detail-inner">
                                <div className="data-row-detail-grid">
                                  <div><span>Tier</span><strong>{fallback.tier}</strong></div>
                                  <div><span>Prompt tokens</span><strong>{fallback.prompt_tokens ?? "—"}</strong></div>
                                  <div><span>Completion tokens</span><strong>{fallback.completion_tokens ?? "—"}</strong></div>
                                  <div><span>Latency</span><strong>{fallback.latency_ms == null ? "—" : `${fallback.latency_ms}ms`}</strong></div>
                                  <div><span>Trace ID</span><strong>{fallback.trace_id ?? "—"}</strong></div>
                                  <div><span>Caller</span><strong>{fallback.caller ?? "—"}</strong></div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
