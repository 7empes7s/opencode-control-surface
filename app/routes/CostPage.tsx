import { useState } from "react";
import { useApi, fmtAge } from "../hooks/useApi";
import { SectionCard } from "../components/SectionCard";
import { ConfirmModal } from "../components/ConfirmModal";
import { authFetch } from "../lib/authFetch";

interface CostData {
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

export function CostPage() {
  const { data, loading, error, refresh } = useApi<CostData>("/api/cost/summary", 30_000);
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d">("30d");
  const [capModal, setCapModal] = useState<{ dailyCap: string; monthlyCap: string } | null>(null);
  const [capLoading, setCapLoading] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const [capSuccess, setCapSuccess] = useState<string | null>(null);

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;

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
    if (!isFinite(dailyCapUsd) || dailyCapUsd <= 0) { setCapError("Invalid daily cap"); return; }
    if (!isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) { setCapError("Invalid monthly cap"); return; }
    setCapLoading(true);
    setCapError(null);
    try {
      const res = await authFetch("/api/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "mutate-policy:budget:global:set-cap",
          confirmed: true,
          reason,
          params: { dailyCapUsd, monthlyCapUsd },
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
          title="Set global cost cap"
          message={`Update the global budget cap to $${capModal.dailyCap}/day and $${capModal.monthlyCap}/month. Gateway calls will be blocked when the cap is reached.`}
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
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Severity</th>
                    <th>Finding</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {d.anomalies.map((anomaly) => (
                    <tr key={anomaly.id}>
                      <td className="mono">{fmtAge(anomaly.ts)}</td>
                      <td>
                        <span className={`pill ${anomaly.severity === "error" ? "critical" : "warning"}`}>
                          {anomaly.severity}
                        </span>
                      </td>
                      <td>
                        <div>{anomaly.summary}</div>
                        <div className="w-caption mono">{anomaly.kind}</div>
                      </td>
                      <td>{anomaly.entityId || anomaly.entityType || "cost"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Period</th>
                    <th>Budget</th>
                    <th>Used</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.budgets.map((budget) => {
                    const period = budget.daily_cap_usd ? "Daily" : "Monthly";
                    const capCents = budget.cap_cents ?? Math.round((budget.daily_cap_usd ?? budget.monthly_cap_usd ?? 0) * 100);
                    const usedCents = budget.used_cents ?? 0;
                    const usagePct = budget.usage_pct ?? (capCents > 0 ? usedCents / capCents : 0);

                    let status = "normal";
                    let statusText = "Normal";
                    if (usagePct >= 1.0) {
                      status = "critical";
                      statusText = "Over budget";
                    } else if (usagePct >= budget.warn_pct) {
                      status = "warning";
                      statusText = "Warning";
                    }

                    return (
                      <tr key={budget.id}>
                        <td>{budget.scope}{budget.project_id ? ` (${budget.project_id})` : ""}</td>
                        <td>{period}</td>
                        <td>{fmtCurrency(capCents)}</td>
                        <td>{fmtCurrency(usedCents)} ({fmtPct(usagePct)})</td>
                        <td>
                          <span className={`pill ${status}`}>
                            {statusText}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
                setCapModal({ dailyCap: String(daily), monthlyCap: String(monthly) });
              }}
            />
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
            <table className="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Spend</th>
                  <th>Events</th>
                </tr>
              </thead>
              <tbody>
                {d.spend.groups.slice(0, 10).map((group, i) => (
                  <tr key={i}>
                    <td>{group.group_value || "Uncategorized"}</td>
                    <td>{fmtCurrency(group.total_cents)}</td>
                    <td>{group.event_count.toLocaleString()}</td>
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
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Logical Model</th>
                    <th>Fallback Model</th>
                    <th>Backend</th>
                    <th>Cost Estimate</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {d.fallbacks.slice(0, 10).map((fallback) => (
                    <tr key={fallback.id}>
                      <td className="mono">{new Date(fallback.ts).toLocaleTimeString()}</td>
                      <td>{fallback.logical_model}</td>
                      <td>{fallback.resolved_model}</td>
                      <td>{fallback.backend}</td>
                      <td>{fallback.cost_estimate_usd ? `$${fallback.cost_estimate_usd.toFixed(4)}` : "—"}</td>
                      <td>{fallback.error_class || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
