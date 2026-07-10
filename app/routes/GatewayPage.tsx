import { useState } from "react";
import { ChevronRight, Copy, Download, RefreshCw, Route, Zap, AlertCircle, CheckCircle2 } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { SectionCard } from "../components/SectionCard";
import { TableControls } from "../components/TableControls";
import { DetailDrawer } from "../components/DetailDrawer";
import { useTableControls } from "../hooks/useTableControls";

type CircuitState = "closed" | "open" | "half-open";

type GatewayStatus = {
  version: number;
  litellmUrl: string;
  modelCount: number;
  models: string[];
  circuits: Record<string, { state: CircuitState; failures: number; openedAt: number | null }>;
  routeOverride: {
    targetModel: string;
    resolvedModel: string;
    tier: string;
    setAt: string;
    setBy: string;
    expiresAt: string;
    reason?: string;
  } | null;
  lastUpdatedAt: string;
  degraded: boolean;
  recommendations: Array<{
    kind: "open_circuit" | "high_error_rate" | "high_latency";
    severity: "warn" | "critical";
    title: string;
    message: string;
    targetId?: string;
    recommendedAction: "half-open-circuit" | "reset-circuit" | "run-probe" | "route-healthiest";
  }>;
  costHeadline?: {
    totalCalls: number;
    freeShareCalls: number;
    freeSharePct: number;
    estimatedSpendUsd: number;
    freeModelsAvailable: number;
    modelsDiscovered: number;
    headline: string;
  };
};

type GatewayStats = {
  totalCalls: number;
  successRate: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byModel: Record<string, { calls: number; errors: number; costUsd: number }>;
  lastUpdatedAt: string;
};

type LedgerRow = {
  id: number;
  ts: number;
  logical_model: string;
  resolved_model: string;
  tier: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  cost_estimate_usd: number | null;
  success: number;
  error_class: string | null;
  trace_id: string | null;
};

type GatewayKeyRecord = {
  id: string;
  agentId: string;
  name: string;
  modelAllowlist: string[];
  dailyCapUsd: number | null;
  status: "active" | "revoked";
  createdAt: number;
  lastUsedAt: number | null;
  tenantId: string | null;
  rotatedFromKeyId: string | null;
  rotationRevokeAt: number | null;
};

type GatewayShowback = {
  window: string;
  byModel: Array<{ model: string; calls: number; costUsd: number }>;
  byCaller: Array<{ caller: string; calls: number; costUsd: number }>;
  byBasis: Array<{ basis: string; events: number; costUsd: number }>;
  totalCostUsd: number;
  totalEvents: number;
  counterfactual: {
    availableTokens: boolean;
    estimatedPaidUsd: number | null;
    tier?: string;
    explanation: string;
  };
  lastUpdatedAt: string;
};

type ActionFeedback = { type: "success" | "error"; message: string } | null;
type OneTimeGatewayKey = { key: string; record: GatewayKeyRecord; rotationRevokeAt: number | null } | null;

function circuitColor(state: CircuitState): string {
  if (state === "closed") return "green";
  if (state === "open") return "red";
  return "amber";
}

function circuitIcon(state: CircuitState) {
  if (state === "closed") return <CheckCircle2 size={12} style={{ color: "var(--green)" }} />;
  if (state === "open") return <AlertCircle size={12} style={{ color: "var(--red)" }} />;
  return <Zap size={12} style={{ color: "var(--amber-warn)" }} />;
}

function fmtTs(ms: number) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtCost(usd: number | null): string {
  if (usd == null || usd === 0) return "$0";
  return `$${usd.toFixed(6)}`;
}

function fmtDailyCap(usd: number | null): string {
  return usd == null ? "uncapped" : `$${usd.toFixed(2)}/day`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function lastUpdated(status?: GatewayStatus | null, stats?: GatewayStats | null, ledger?: { lastUpdatedAt: string } | null): string {
  return status?.lastUpdatedAt ?? stats?.lastUpdatedAt ?? ledger?.lastUpdatedAt ?? "";
}

export function GatewayPage() {
  const [sinceHours, setSinceHours] = useState(24);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback>(null);
  const [oneTimeKey, setOneTimeKey] = useState<OneTimeGatewayKey>(null);
  const [selectedCall, setSelectedCall] = useState<LedgerRow | null>(null);
  const [pinModel, setPinModel] = useState("");
  const [pinTtlHours, setPinTtlHours] = useState("4");
  const since = Date.now() - sinceHours * 3_600_000;

  const { data: statusData, loading: statusLoading, error: statusError, refresh: refreshStatus } = useApi<GatewayStatus>("/api/gateway/status", 15_000);
  const { data: statsData, loading: statsLoading, error: statsError, refresh: refreshStats } = useApi<GatewayStats>(`/api/gateway/stats?since=${since}`, 30_000);
  const { data: ledgerData, loading: ledgerLoading, error: ledgerError, refresh: refreshLedger } = useApi<{ rows: LedgerRow[]; lastUpdatedAt: string }>("/api/gateway/ledger?limit=100", 30_000);
  const { data: showbackData } = useAuthenticatedApi<GatewayShowback>("/api/gateway/showback", 60_000);
  const { data: keysData, loading: keysLoading, error: keysError, refresh: refreshKeys } = useAuthenticatedApi<{ keys: GatewayKeyRecord[] }>("/api/gateway/keys", 30_000);
  const gatewayActions = useAuthenticatedApi<never>("", 0);

  const status = statusData;
  const stats = statsData;
  const rows = ledgerData?.rows ?? [];
  const gatewayKeys = keysData?.keys ?? [];
  const callsCtrl = useTableControls<LedgerRow, "ts" | "logical_model" | "resolved_model" | "tokens" | "latency_ms" | "cost_estimate_usd" | "success" | "tier">({
    rows,
    pageSize: 25,
    pageSizeOptions: [10, 25, 50, 100],
    rowKey: (row) => String(row.id),
    defaultSort: { key: "ts", dir: "desc" },
    filterText: (row) => [
      row.id,
      row.logical_model,
      row.resolved_model,
      row.tier,
      row.error_class,
      row.trace_id,
      row.success ? "ok success" : "error failed",
    ],
    sortValue: (row, key) => {
      switch (key) {
        case "ts": return row.ts;
        case "logical_model": return row.logical_model;
        case "resolved_model": return row.resolved_model;
        case "tokens": return (row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0);
        case "latency_ms": return row.latency_ms ?? 0;
        case "cost_estimate_usd": return row.cost_estimate_usd ?? 0;
        case "success": return row.success;
        case "tier": return row.tier;
        default: return "";
      }
    },
  });
  const loading = statusLoading || statsLoading || ledgerLoading || keysLoading;
  const initialLoading = loading && !status && !stats && !ledgerData;
  const refreshing = loading && !initialLoading;
  const error = statusError || statsError || ledgerError || keysError;
  const recommendation = status?.recommendations?.[0] ?? null;
  const updatedAt = lastUpdated(status, stats, ledgerData);

  const refresh = () => { refreshStatus(); refreshStats(); refreshLedger(); };
  const refreshAll = () => { refresh(); refreshKeys(); };
  const refreshAfterAction = () => {
    refreshAll();
  };

  async function runAction(actionId: string, path: string, body: Record<string, unknown> = {}) {
    setPendingAction(actionId);
    setFeedback(null);
    try {
      const res = await gatewayActions.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "gateway admin action", ...body }),
      });
      const parsed = await res.json().catch(() => ({})) as { data?: { message?: string; ok?: boolean; error?: string }; error?: string };
      if (!res.ok) throw new Error(parsed.error ?? parsed.data?.error ?? `HTTP ${res.status}`);
      setFeedback({ type: "success", message: parsed.data?.message ?? "Gateway action completed." });
      refreshAfterAction();
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPendingAction(null);
    }
  }

  async function pinGatewayModel(model: string) {
    const ttlHours = Number(pinTtlHours);
    if (!model) {
      setFeedback({ type: "error", message: "Choose a gateway model to pin." });
      return;
    }
    if (!Number.isFinite(ttlHours) || ttlHours < 1 / 60 || ttlHours > 168) {
      setFeedback({ type: "error", message: "TTL must be between 1 minute and 168 hours." });
      return;
    }

    const confirmed = window.confirm(`Pin all gateway routing to "${model}" for ${ttlHours} hour${ttlHours === 1 ? "" : "s"}?`);
    if (!confirmed) return;
    const reason = window.prompt("Reason for pinning this gateway model");
    if (!reason?.trim()) {
      setFeedback({ type: "error", message: "A reason is required to pin a gateway model." });
      return;
    }

    await runAction("pin-route", "/api/gateway/route-override", {
      model,
      ttlMs: ttlHours * 3_600_000,
      reason: reason.trim(),
      confirmed: true,
    });
  }

  async function clearGatewayRouteOverride() {
    const targetModel = status?.routeOverride?.targetModel;
    if (!targetModel) return;
    const confirmed = window.confirm(`Clear the gateway route override for "${targetModel}"?`);
    if (!confirmed) return;
    const reason = window.prompt("Reason for clearing this route override (optional)");

    setPendingAction("clear-route-override");
    setFeedback(null);
    try {
      const res = await gatewayActions.request("/api/gateway/route-override", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason?.trim() || undefined }),
      });
      const parsed = await res.json().catch(() => ({})) as { data?: { message?: string; error?: string }; error?: string };
      if (!res.ok) throw new Error(parsed.error ?? parsed.data?.error ?? `HTTP ${res.status}`);
      setFeedback({ type: "success", message: parsed.data?.message ?? "Gateway route override cleared." });
      refreshAfterAction();
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPendingAction(null);
    }
  }

  async function rotateGatewayKey(key: GatewayKeyRecord) {
    const confirmed = window.confirm(`Rotate gateway key "${key.name}"? The old key remains valid during the grace period.`);
    if (!confirmed) return;
    const reason = window.prompt("Reason for rotating this gateway key");
    if (!reason?.trim()) {
      setFeedback({ type: "error", message: "A reason is required to rotate a gateway key." });
      return;
    }

    setPendingAction(`rotate:${key.id}`);
    setFeedback(null);
    setOneTimeKey(null);
    try {
      const res = await gatewayActions.request(`/api/gateway/keys/${encodeURIComponent(key.id)}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, reason: reason.trim() }),
      });
      const parsed = await res.json().catch(() => ({})) as {
        data?: { key?: string; record?: GatewayKeyRecord; rotationRevokeAt?: number | null };
        error?: string;
      };
      if (!res.ok || !parsed.data?.key || !parsed.data.record) {
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      setOneTimeKey({
        key: parsed.data.key,
        record: parsed.data.record,
        rotationRevokeAt: parsed.data.rotationRevokeAt ?? null,
      });
      setFeedback({ type: "success", message: `Gateway key rotated. Copy the replacement key now; it will not be shown again.` });
      refreshAfterAction();
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPendingAction(null);
    }
  }

  async function copyOneTimeKey() {
    if (!oneTimeKey) return;
    await navigator.clipboard.writeText(oneTimeKey.key);
    setFeedback({ type: "success", message: "Replacement key copied." });
  }

  function exportCsv() {
    const headers = ["id", "ts", "logical_model", "resolved_model", "tier", "prompt_tokens", "completion_tokens", "latency_ms", "cost_estimate_usd", "success", "error_class", "trace_id"];
    const lines = [
      headers.join(","),
      ...rows.map((row) => headers.map((key) => csvCell(row[key as keyof LedgerRow])).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gateway-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const circuitEntries = Object.entries(status?.circuits ?? {});
  const pinModelOptions = Array.from(new Set([
    ...(status?.models ?? []),
    ...(status?.routeOverride ? [status.routeOverride.targetModel] : []),
    ...circuitEntries.map(([model]) => model),
  ])).sort();
  const selectedPinModel = pinModel || pinModelOptions[0] || "";
  const statsCards = [
    { label: "Total calls", val: stats ? String(stats.totalCalls) : "—" },
    { label: "Success rate", val: stats ? pct(stats.successRate) : "—" },
    { label: "Avg latency", val: stats ? fmtLatency(Math.round(stats.avgLatencyMs)) : "—" },
    { label: "Est. cost", val: stats ? fmtCost(stats.totalCostUsd) : "—" },
  ];

  return (
    <div className="dash-page">
      <DetailDrawer
        open={selectedCall !== null}
        onClose={() => {
          callsCtrl.collapseAll();
          setSelectedCall(null);
        }}
        kicker="gateway call"
        title={selectedCall ? `${selectedCall.logical_model} · #${selectedCall.id}` : "Gateway call"}
        summary={selectedCall && (
          <>
            {selectedCall.success ? <span className="pill green">ok</span> : <span className="pill red">{selectedCall.error_class ?? "error"}</span>}
            <span className="pill">{fmtLatency(selectedCall.latency_ms)}</span>
            <span className="pill">{fmtCost(selectedCall.cost_estimate_usd)}</span>
            {selectedCall.trace_id && <span className="pill">{selectedCall.trace_id}</span>}
          </>
        )}
      >
        {selectedCall && (
          <>
            <div className="data-row-detail-grid">
              <div><span>Time</span><strong>{fmtTs(selectedCall.ts)}</strong></div>
              <div><span>Logical model</span><strong>{selectedCall.logical_model}</strong></div>
              <div><span>Resolved model</span><strong>{selectedCall.resolved_model}</strong></div>
              <div><span>Tier</span><strong>{selectedCall.tier}</strong></div>
              <div><span>Tokens</span><strong>{selectedCall.prompt_tokens != null ? `${selectedCall.prompt_tokens}+${selectedCall.completion_tokens ?? 0}` : "—"}</strong></div>
              <div><span>Latency</span><strong>{fmtLatency(selectedCall.latency_ms)}</strong></div>
              <div><span>Cost</span><strong>{fmtCost(selectedCall.cost_estimate_usd)}</strong></div>
              <div><span>Trace ID</span><strong>{selectedCall.trace_id ?? "—"}</strong></div>
            </div>
            <div className="evidence-block">
              <div className="evidence-block-title">Raw call</div>
              <pre className="audit-pre detail-json">{JSON.stringify(selectedCall, null, 2)}</pre>
            </div>
          </>
        )}
      </DetailDrawer>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Gateway</h1>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>
          {status ? `v${status.version} · ${status.modelCount} models` : "waiting for gateway status"}
        </span>
        <button onClick={refreshAll} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", cursor: "pointer", color: "var(--text-dim)" }}>
          <RefreshCw size={12} /> refresh
        </button>
      </div>

      {status?.costHeadline && (
        <SectionCard title="Cost Performance" style={{ marginBottom: 20 }}>
          <div style={{ padding: "16px 20px" }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, lineHeight: 1.4, maxWidth: 800 }}>
              {status.costHeadline.headline}
            </div>
            <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4, letterSpacing: "0.05em" }}>Free Share</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: "var(--accent)" }}>{status.costHeadline.freeSharePct}%</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4, letterSpacing: "0.05em" }}>Est. 30d Spend</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>${status.costHeadline.estimatedSpendUsd.toFixed(2)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4, letterSpacing: "0.05em" }}>Free Models</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: "var(--green)" }}>{status.costHeadline.freeModelsAvailable}</div>
              </div>
            </div>
          </div>
        </SectionCard>
      )}

      {showbackData && (
        <SectionCard title="Where the money (doesn't) go" style={{ marginBottom: 20 }}>
          <div className="section-card-body" style={{ padding: "14px 20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 20, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>By model</div>
                {showbackData.byModel.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>No calls recorded.</p>
                ) : (
                  <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                        <th style={{ textAlign: "left", padding: "4px 8px 6px 0" }}>Model</th>
                        <th style={{ textAlign: "right", padding: "4px 8px 6px" }}>Calls</th>
                        <th style={{ textAlign: "right", padding: "4px 0 6px 8px" }}>Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {showbackData.byModel.map((row) => (
                        <tr key={row.model}>
                          <td style={{ fontFamily: "var(--mono)", padding: "5px 8px 5px 0", overflowWrap: "anywhere" }}>{row.model}</td>
                          <td style={{ textAlign: "right", padding: "5px 8px" }}>{row.calls}</td>
                          <td style={{ textAlign: "right", padding: "5px 0 5px 8px" }}>${row.costUsd.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>By caller</div>
                {showbackData.byCaller.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>No calls recorded.</p>
                ) : (
                  <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                        <th style={{ textAlign: "left", padding: "4px 8px 6px 0" }}>Caller</th>
                        <th style={{ textAlign: "right", padding: "4px 8px 6px" }}>Calls</th>
                        <th style={{ textAlign: "right", padding: "4px 0 6px 8px" }}>Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {showbackData.byCaller.map((row) => (
                        <tr key={row.caller}>
                          <td style={{ fontFamily: "var(--mono)", padding: "5px 8px 5px 0", overflowWrap: "anywhere" }}>{row.caller}</td>
                          <td style={{ textAlign: "right", padding: "5px 8px" }}>{row.calls}</td>
                          <td style={{ textAlign: "right", padding: "5px 0 5px 8px" }}>${row.costUsd.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Cost basis</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {showbackData.byBasis.length === 0 ? (
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}>No cost events recorded yet.</span>
                ) : (
                  showbackData.byBasis.map((row) => (
                    <span key={row.basis} className="pill" title={`${row.events} events · $${row.costUsd.toFixed(2)}`} style={{ fontSize: 11 }}>
                      {row.basis === "unpriced"
                        ? `${row.events} calls unpriced — recorded before cost tracking began`
                        : row.basis === "free-tier"
                          ? `${row.events} free-tier (free models, $0)`
                          : row.basis === "litellm-cost-estimate"
                            ? `${row.events} priced via LiteLLM estimate · $${row.costUsd.toFixed(2)}`
                            : `${row.events} ${row.basis} · $${row.costUsd.toFixed(2)}`}
                    </span>
                  ))
                )}
              </div>
            </div>

            <div style={{ fontSize: 12, color: "var(--text-dim)", borderTop: "1px solid var(--border)", paddingTop: 12, lineHeight: 1.5 }}>
              <span style={{ color: "var(--text)", fontWeight: 600 }}>Counterfactual: </span>
              {showbackData.counterfactual.explanation}
              {showbackData.counterfactual.availableTokens && showbackData.counterfactual.estimatedPaidUsd != null && (
                <span> Estimated paid: <strong style={{ color: "var(--text)" }}>${showbackData.counterfactual.estimatedPaidUsd.toFixed(2)}</strong>.</span>
              )}
            </div>
          </div>
        </SectionCard>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14, fontSize: 11, color: "var(--text-dim)" }}>
        {initialLoading ? (
          <span className="pill amber">loading</span>
        ) : error && !status ? (
          <span className="pill red">error</span>
        ) : status?.degraded ? (
          <span className="pill red">degraded</span>
        ) : status ? (
          <span className="pill green">healthy</span>
        ) : (
          <span className="pill amber">pending</span>
        )}
        {status?.routeOverride && (
          <>
            <span
              className="pill amber"
              title={`Expires ${new Date(status.routeOverride.expiresAt).toLocaleString()}${status.routeOverride.reason ? ` — ${status.routeOverride.reason}` : ""}`}
            >
              routing via {status.routeOverride.targetModel}
            </span>
            <span>set by {status.routeOverride.setBy}</span>
            {status.routeOverride.reason && (
              // The operator's typed reason (required by the apply gate this
              // override came from) was previously only visible in a hover
              // tooltip -- easy to miss when narrating why the route changed.
              // Surfaced as plain text so it's visible without hovering.
              <span>&ldquo;{status.routeOverride.reason}&rdquo;</span>
            )}
            <button
              type="button"
              disabled={pendingAction !== null}
              onClick={clearGatewayRouteOverride}
              style={{ fontSize: 10, padding: "3px 7px", borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", cursor: pendingAction ? "wait" : "pointer" }}
            >
              Clear override
            </button>
          </>
        )}
        {updatedAt ? <span>Last updated {new Date(updatedAt).toLocaleString()}</span> : <span>Last updated after first response</span>}
        {refreshing && <span>refreshing data...</span>}
      </div>

      {error && (
        <div style={{ border: "1px solid color-mix(in oklch, var(--red) 45%, var(--border))", background: "color-mix(in oklch, var(--red) 10%, transparent)", borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12 }}>
          Could not load gateway data: {error}
          <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
            Check the gateway API and operator session, then retry. Existing data remains visible when available.
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={refreshAll} style={{ marginTop: 8 }}>
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      )}

      {initialLoading && !error && (
        <div style={{ border: "1px solid color-mix(in oklch, var(--amber-warn) 45%, var(--border))", background: "color-mix(in oklch, var(--amber-warn) 9%, transparent)", borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12 }}>
          Waiting for gateway status, stats, and recent calls.
          <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
            If this stays empty, use refresh after verifying the gateway service and API session.
          </div>
        </div>
      )}

      {recommendation && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, border: "1px solid color-mix(in oklch, var(--amber-warn) 55%, var(--border))", background: "color-mix(in oklch, var(--amber-warn) 12%, transparent)", borderRadius: 8, padding: 14, marginBottom: 16, flexWrap: "wrap" }}>
          <AlertCircle size={18} style={{ color: recommendation.severity === "critical" ? "var(--red)" : "var(--amber-warn)", flex: "0 0 auto" }} />
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{recommendation.title}</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{recommendation.message}</div>
          </div>
          {recommendation.targetId && (
            <button
              disabled={pendingAction !== null}
              onClick={() => runAction(`half-open:${recommendation.targetId}`, `/api/gateway/circuits/${encodeURIComponent(recommendation.targetId)}/half-open`)}
              style={{ fontSize: 11, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card-start)", cursor: pendingAction ? "wait" : "pointer", color: "var(--text)" }}
            >
              half-open circuit
            </button>
          )}
          <button
            disabled={pendingAction !== null}
            onClick={() => runAction("route-healthiest", "/api/gateway/route-healthiest")}
            style={{ fontSize: 11, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--accent)", cursor: pendingAction ? "wait" : "pointer", color: "#fff" }}
          >
            route healthiest
          </button>
        </div>
      )}

      {feedback && (
        <div style={{ border: `1px solid ${feedback.type === "success" ? "color-mix(in oklch, var(--green) 45%, var(--border))" : "color-mix(in oklch, var(--red) 45%, var(--border))"}`, borderRadius: 8, padding: 10, marginBottom: 14, fontSize: 12, color: feedback.type === "success" ? "var(--green)" : "var(--red)" }}>
          {feedback.message}
        </div>
      )}

      {oneTimeKey && (
        <div style={{ border: "1px solid color-mix(in oklch, var(--green) 45%, var(--border))", borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <strong>Replacement key for {oneTimeKey.record.name}</strong>
            {oneTimeKey.rotationRevokeAt && <span className="pill amber">old key grace until {new Date(oneTimeKey.rotationRevokeAt).toLocaleString()}</span>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={copyOneTimeKey}>
              <Copy size={13} /> Copy
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOneTimeKey(null)}>
              Dismiss
            </button>
          </div>
          <code style={{ display: "block", fontFamily: "var(--mono)", fontSize: 12, overflowWrap: "anywhere", background: "var(--bg-card-start)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
            {oneTimeKey.key}
          </code>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <button disabled={pendingAction !== null} onClick={() => runAction("probe", "/api/gateway/probe")} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card-start)", color: "var(--text)", cursor: pendingAction ? "wait" : "pointer" }}>
          <Zap size={13} /> run probe
        </button>
        <button disabled={pendingAction !== null} onClick={() => runAction("route-healthiest", "/api/gateway/route-healthiest")} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card-start)", color: "var(--text)", cursor: pendingAction ? "wait" : "pointer" }}>
          <Route size={13} /> route to healthiest
        </button>
        <select
          aria-label="Gateway model to pin"
          value={selectedPinModel}
          onChange={(event) => setPinModel(event.target.value)}
          disabled={pendingAction !== null || pinModelOptions.length === 0}
          style={{ minWidth: 180, fontSize: 11, padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card-start)", color: "var(--text)" }}
        >
          {pinModelOptions.length === 0 && <option value="">No observed models</option>}
          {pinModelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
          TTL hours
          <input
            aria-label="Route override TTL in hours"
            type="number"
            min={1 / 60}
            max={168}
            step="any"
            value={pinTtlHours}
            onChange={(event) => setPinTtlHours(event.target.value)}
            style={{ width: 76, fontSize: 11, padding: "7px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card-start)", color: "var(--text)" }}
          />
        </label>
        <button
          type="button"
          disabled={pendingAction !== null || !selectedPinModel}
          onClick={() => pinGatewayModel(selectedPinModel)}
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-card-start)", color: "var(--text)", cursor: pendingAction || !selectedPinModel ? "not-allowed" : "pointer" }}
        >
          <Route size={13} /> Pin model
        </button>
        <button disabled={rows.length === 0} onClick={exportCsv} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: rows.length === 0 ? "var(--text-dim)" : "var(--text)", cursor: rows.length === 0 ? "not-allowed" : "pointer" }}>
          <Download size={13} /> export CSV
        </button>
      </div>

      <SectionCard title="Gateway Keys" style={{ marginBottom: 20 }}>
        <div className="section-card-body" style={{ padding: "12px 16px" }}>
          {gatewayKeys.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>No gateway keys issued.</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Scope</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th className="cell-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayKeys.map((key) => {
                    const canRotate = key.status === "active" && key.rotationRevokeAt == null;
                    return (
                      <tr key={key.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{key.name}</div>
                          <div className="mono dim" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{key.id}</div>
                        </td>
                        <td className="mono cell-ellipsis" title={key.agentId}>{key.agentId}</td>
                        <td>
                          <span className={`pill ${key.status === "active" ? "green" : "red"}`}>{key.status}</span>
                          {key.rotationRevokeAt != null && (
                            <span className="pill amber" title={new Date(key.rotationRevokeAt).toLocaleString()} style={{ marginLeft: 6 }}>
                              grace until {new Date(key.rotationRevokeAt).toLocaleString()}
                            </span>
                          )}
                          {key.rotatedFromKeyId && (
                            <span className="pill" title={key.rotatedFromKeyId} style={{ marginLeft: 6 }}>replacement</span>
                          )}
                        </td>
                        <td>
                          <span className="pill">{fmtDailyCap(key.dailyCapUsd)}</span>
                          {key.modelAllowlist.length > 0 ? (
                            key.modelAllowlist.slice(0, 3).map((model) => <span key={model} className="pill" title={model} style={{ marginLeft: 6 }}>{model}</span>)
                          ) : (
                            <span className="pill" style={{ marginLeft: 6 }}>all models</span>
                          )}
                        </td>
                        <td className="mono dim">{fmtTs(key.createdAt)}</td>
                        <td className="mono dim">{key.lastUsedAt == null ? "—" : fmtTs(key.lastUsedAt)}</td>
                        <td className="cell-right">
                          {canRotate && (
                            <button
                              type="button"
                              disabled={pendingAction !== null}
                              onClick={() => rotateGatewayKey(key)}
                              style={{ fontSize: 10, padding: "3px 7px", borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", cursor: pendingAction ? "wait" : "pointer" }}
                            >
                              Rotate
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Stats strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
          {statsCards.map(({ label, val }) => (
            <div key={label} style={{ background: "var(--bg-card-start)", borderRadius: 10, padding: "12px 16px", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--mono)" }}>{val}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{label}</div>
            </div>
          ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 20, marginBottom: 20 }}>
        {/* Circuit breaker panel */}
        <SectionCard title="Circuit Breakers">
          <div className="section-card-body" style={{ padding: "12px 16px" }}>
            {circuitEntries.length === 0 && initialLoading && (
              <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>Loading circuit states...</p>
            )}
            {circuitEntries.length === 0 && !initialLoading && (
              <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>No circuits active - all models in closed state.</p>
            )}
            {circuitEntries.map(([model, c]) => (
              <div key={model} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 12, flexWrap: "wrap" }}>
                {circuitIcon(c.state)}
                <span style={{ flex: "1 1 180px", fontFamily: "var(--mono)", fontSize: 11, overflowWrap: "anywhere" }}>{model}</span>
                <span className={`pill ${circuitColor(c.state)}`}>{c.state}</span>
                {c.failures > 0 && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{c.failures} fail{c.failures !== 1 ? "s" : ""}</span>}
                {c.openedAt && <span style={{ fontSize: 10, color: "var(--text-dim)" }} title={fmtTs(c.openedAt)}>opened {Math.round((Date.now() - c.openedAt) / 1000)}s ago</span>}
                <button disabled={pendingAction !== null} onClick={() => runAction(`reset:${model}`, `/api/gateway/circuits/${encodeURIComponent(model)}/reset`)} style={{ fontSize: 10, padding: "3px 7px", borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", cursor: pendingAction ? "wait" : "pointer" }}>
                  reset
                </button>
                <button disabled={pendingAction !== null} onClick={() => runAction(`half-open:${model}`, `/api/gateway/circuits/${encodeURIComponent(model)}/half-open`)} style={{ fontSize: 10, padding: "3px 7px", borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)", cursor: pendingAction ? "wait" : "pointer" }}>
                  half-open
                </button>
              </div>
            ))}
          </div>
        </SectionCard>

        {/* Per-model stats */}
        <SectionCard title="Model Usage">
          <div className="section-card-body" style={{ padding: "12px 16px" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Last</span>
              {[1, 6, 24, 168].map((h) => (
                <button key={h} onClick={() => setSinceHours(h)} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", background: h === sinceHours ? "var(--accent)" : "transparent", color: h === sinceHours ? "#fff" : "var(--text-dim)", cursor: "pointer" }}>
                  {h < 24 ? `${h}h` : h === 24 ? "24h" : "7d"}
                </button>
              ))}
            </div>
            {!stats || Object.keys(stats.byModel).length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>No calls recorded in this period.</p>
            ) : (
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px 6px 0" }}>Model</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 6px" }}>Calls</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 6px" }}>Errors</th>
                  <th style={{ textAlign: "right", padding: "4px 0 6px 8px" }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(stats.byModel).sort(([, a], [, b]) => b.calls - a.calls).map(([model, s]) => (
                  <tr key={model}>
                    <td style={{ fontFamily: "var(--mono)", padding: "5px 8px 5px 0", overflowWrap: "anywhere" }}>{model}</td>
                    <td style={{ textAlign: "right", padding: "5px 8px" }}>{s.calls}</td>
                    <td style={{ textAlign: "right", padding: "5px 8px", color: s.errors > 0 ? "var(--text-red, red)" : undefined }}>{s.errors || "—"}</td>
                    <td style={{ textAlign: "right", padding: "5px 0 5px 8px" }}>{fmtCost(s.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            )}
          </div>
        </SectionCard>
      </div>

      {/* Call ledger */}
      <SectionCard title={`Recent Calls${ledgerData?.lastUpdatedAt ? ` · ${new Date(ledgerData.lastUpdatedAt).toLocaleTimeString()}` : ""}`}>
        <div className="section-card-body" style={{ padding: "12px 16px" }}>
          {rows.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>No gateway calls recorded yet.</p>
          ) : (
            <div className="table-wrap">
            <TableControls {...callsCtrl.controlsProps} searchPlaceholder="Search model, tier, trace ID, status, or error..." />
            <table className="data-table">
              <thead>
                <tr>
                  <th className="expander-col" aria-label="Details" />
                  <th {...callsCtrl.sortHeaderProps("ts")}>Time <span className="sortable-th-arrow">{callsCtrl.sort.key === "ts" ? (callsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...callsCtrl.sortHeaderProps("logical_model")}>Model <span className="sortable-th-arrow">{callsCtrl.sort.key === "logical_model" ? (callsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...callsCtrl.sortHeaderProps("resolved_model")}>Resolved <span className="sortable-th-arrow">{callsCtrl.sort.key === "resolved_model" ? (callsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...callsCtrl.sortHeaderProps("tokens")} className="cell-right">Tokens <span className="sortable-th-arrow">{callsCtrl.sort.key === "tokens" ? (callsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...callsCtrl.sortHeaderProps("latency_ms")} className="cell-right">Latency <span className="sortable-th-arrow">{callsCtrl.sort.key === "latency_ms" ? (callsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...callsCtrl.sortHeaderProps("cost_estimate_usd")} className="cell-right">Cost <span className="sortable-th-arrow">{callsCtrl.sort.key === "cost_estimate_usd" ? (callsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...callsCtrl.sortHeaderProps("success")}>Status <span className="sortable-th-arrow">{callsCtrl.sort.key === "success" ? (callsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                </tr>
              </thead>
              <tbody>
                {callsCtrl.rows.map((row, index) => {
                  const key = callsCtrl.getRowKey(row, index);
                  const expanded = callsCtrl.isExpanded(key);
                  const openCall = () => {
                    if (!expanded) callsCtrl.toggleExpanded(key);
                    setSelectedCall(row);
                  };
                  return (
                  <tr key={row.id} className="data-row-clickable" onClick={openCall}>
                    <td className="expander-col">
                      <button
                        type="button"
                        className="table-expander"
                        aria-label="Open call detail"
                        aria-expanded={expanded}
                        onClick={(event) => {
                          event.stopPropagation();
                          openCall();
                        }}
                      >
                        <ChevronRight size={15} />
                      </button>
                    </td>
                    <td className="mono cell-ellipsis dim" title={fmtTs(row.ts)}>{fmtTs(row.ts)}</td>
                    <td className="mono cell-ellipsis cell-wide" title={row.logical_model}>{row.logical_model}</td>
                    <td className="mono cell-ellipsis dim" title={row.resolved_model}>{row.resolved_model !== row.logical_model ? row.resolved_model : "—"}</td>
                    <td className="cell-right mono">
                      {row.prompt_tokens != null ? `${row.prompt_tokens}+${row.completion_tokens ?? 0}` : "—"}
                    </td>
                    <td className="cell-right mono">{fmtLatency(row.latency_ms)}</td>
                    <td className="cell-right mono">{fmtCost(row.cost_estimate_usd)}</td>
                    <td>
                      {row.success ? (
                        <span className="pill green">ok</span>
                      ) : (
                        <span className="pill red" title={row.error_class ?? ""}>{row.error_class ?? "error"}</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
