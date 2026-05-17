import { useState } from "react";
import { RefreshCw, Zap, AlertCircle, CheckCircle2 } from "lucide-react";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { SectionCard } from "../components/SectionCard";

type CircuitState = "closed" | "open" | "half-open";

type GatewayStatus = {
  version: number;
  litellmUrl: string;
  modelCount: number;
  circuits: Record<string, { state: CircuitState; failures: number; openedAt: number | null }>;
};

type GatewayStats = {
  totalCalls: number;
  successRate: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byModel: Record<string, { calls: number; errors: number; costUsd: number }>;
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

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function GatewayPage() {
  const [sinceHours, setSinceHours] = useState(24);
  const since = Date.now() - sinceHours * 3_600_000;

  const { data: statusData, refresh: refreshStatus } = useAuthenticatedApi<GatewayStatus>("/api/gateway/status", 15_000);
  const { data: statsData, refresh: refreshStats } = useAuthenticatedApi<GatewayStats>(`/api/gateway/stats?since=${since}`, 30_000);
  const { data: ledgerData, refresh: refreshLedger } = useAuthenticatedApi<{ rows: LedgerRow[] }>("/api/gateway/ledger?limit=100", 30_000);

  const status = statusData;
  const stats = statsData;
  const rows = ledgerData?.rows ?? [];

  const refresh = () => { refreshStatus(); refreshStats(); refreshLedger(); };

  const circuitEntries = Object.entries(status?.circuits ?? {});

  return (
    <div className="dash-page">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Gateway</h1>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>
          {status ? `v${status.version} · LiteLLM @ ${status.litellmUrl} · ${status.modelCount} models` : "loading…"}
        </span>
        <button onClick={refresh} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", cursor: "pointer", color: "var(--text-dim)" }}>
          <RefreshCw size={12} /> refresh
        </button>
      </div>

      {/* Stats strip */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
          {[
            { label: "Total calls", val: String(stats.totalCalls) },
            { label: "Success rate", val: pct(stats.successRate) },
            { label: "Avg latency", val: fmtLatency(Math.round(stats.avgLatencyMs)) },
            { label: "Est. cost", val: fmtCost(stats.totalCostUsd) },
          ].map(({ label, val }) => (
            <div key={label} style={{ background: "var(--bg-card-start)", borderRadius: 10, padding: "12px 16px", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--mono)" }}>{val}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        {/* Circuit breaker panel */}
        <SectionCard title="Circuit Breakers">
          {circuitEntries.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--text-dim)" }}>No circuits active — all models in closed state.</p>
          )}
          {circuitEntries.map(([model, c]) => (
            <div key={model} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
              {circuitIcon(c.state)}
              <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11 }}>{model}</span>
              <span className={`pill ${circuitColor(c.state)}`}>{c.state}</span>
              {c.failures > 0 && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{c.failures} fail{c.failures !== 1 ? "s" : ""}</span>}
              {c.openedAt && <span style={{ fontSize: 10, color: "var(--text-dim)" }} title={fmtTs(c.openedAt)}>opened {Math.round((Date.now() - c.openedAt) / 1000)}s ago</span>}
            </div>
          ))}
        </SectionCard>

        {/* Per-model stats */}
        <SectionCard title="Model Usage">
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Last</span>
            {[1, 6, 24, 168].map((h) => (
              <button key={h} onClick={() => setSinceHours(h)} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", background: h === sinceHours ? "var(--accent)" : "transparent", color: h === sinceHours ? "#fff" : "var(--text-dim)", cursor: "pointer" }}>
                {h < 24 ? `${h}h` : h === 24 ? "24h" : "7d"}
              </button>
            ))}
          </div>
          {!stats || Object.keys(stats.byModel).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-dim)" }}>No calls recorded in this period.</p>
          ) : (
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "2px 0 4px" }}>Model</th>
                  <th style={{ textAlign: "right", padding: "2px 0 4px" }}>Calls</th>
                  <th style={{ textAlign: "right", padding: "2px 0 4px" }}>Errors</th>
                  <th style={{ textAlign: "right", padding: "2px 0 4px" }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(stats.byModel).sort(([, a], [, b]) => b.calls - a.calls).map(([model, s]) => (
                  <tr key={model}>
                    <td style={{ fontFamily: "var(--mono)", padding: "3px 0" }}>{model}</td>
                    <td style={{ textAlign: "right" }}>{s.calls}</td>
                    <td style={{ textAlign: "right", color: s.errors > 0 ? "var(--text-red, red)" : undefined }}>{s.errors || "—"}</td>
                    <td style={{ textAlign: "right" }}>{fmtCost(s.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>
      </div>

      {/* Call ledger */}
      <SectionCard title="Recent Calls">
        {rows.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--text-dim)" }}>No gateway calls recorded yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px 4px 0" }}>Time</th>
                  <th style={{ textAlign: "left", padding: "4px 8px 4px 0" }}>Model</th>
                  <th style={{ textAlign: "left", padding: "4px 8px 4px 0" }}>Resolved</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 4px 0" }}>Tokens</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 4px 0" }}>Latency</th>
                  <th style={{ textAlign: "right", padding: "4px 8px 4px 0" }}>Cost</th>
                  <th style={{ textAlign: "left", padding: "4px 0 4px 8px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} style={{ borderBottom: "1px solid color-mix(in oklch, var(--border) 40%, transparent)" }}>
                    <td style={{ color: "var(--text-dim)", padding: "3px 8px 3px 0", fontFamily: "var(--mono)" }}>{fmtTs(row.ts)}</td>
                    <td style={{ fontFamily: "var(--mono)", padding: "3px 8px 3px 0" }}>{row.logical_model}</td>
                    <td style={{ fontFamily: "var(--mono)", padding: "3px 8px 3px 0", color: "var(--text-dim)" }}>{row.resolved_model !== row.logical_model ? row.resolved_model : "—"}</td>
                    <td style={{ textAlign: "right", padding: "3px 8px 3px 0" }}>
                      {row.prompt_tokens != null ? `${row.prompt_tokens}+${row.completion_tokens ?? 0}` : "—"}
                    </td>
                    <td style={{ textAlign: "right", padding: "3px 8px 3px 0" }}>{fmtLatency(row.latency_ms)}</td>
                    <td style={{ textAlign: "right", padding: "3px 8px 3px 0" }}>{fmtCost(row.cost_estimate_usd)}</td>
                    <td style={{ padding: "3px 0 3px 8px" }}>
                      {row.success ? (
                        <span className="pill green">ok</span>
                      ) : (
                        <span className="pill red" title={row.error_class ?? ""}>{row.error_class ?? "error"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
