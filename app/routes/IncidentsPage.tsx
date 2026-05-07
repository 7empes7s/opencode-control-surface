import { useState } from "react";
import { useApi } from "../hooks/useApi";
import type { IncidentsDetail } from "../../server/api/types";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function relTime(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function errorColor(t: string): string {
  if (t === "transport_timeout" || t === "capacity_rate_limit") return "amber";
  if (t === "quality_garbage") return "amber";
  return "red";
}

export function IncidentsPage() {
  const { data, loading, error } = useApi<IncidentsDetail>("/api/incidents", 30_000);
  const [filterType, setFilterType] = useState("");
  const [filterError, setFilterError] = useState("");
  const [filterStage, setFilterStage] = useState("");
  const window24h = 24 * 60 * 60 * 1000;

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim" style={{ color: "var(--red)" }}>error: {error}</div>;
  if (!data) return null;

  const d = data;

  const filtered = d.entries.filter((e) => {
    if (filterType && e.type !== filterType) return false;
    if (filterError && e.errorType !== filterError) return false;
    if (filterStage && e.stage !== filterStage) return false;
    return true;
  });

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Incidents</div>
        <div className="stat-row">
          <div className="stat-item">
            <div className="stat-val">{d.stats.total}</div>
            <div className="stat-lbl">total</div>
          </div>
          <div className="stat-item">
            <div className="stat-val">{d.stats.last24h}</div>
            <div className="stat-lbl">last 24h</div>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 16 }}>
        {/* Error type breakdown */}
        <div className="section-card">
          <div className="section-card-header"><span className="title">by error type</span></div>
          <div className="section-card-body" style={{ padding: "10px 14px" }}>
            {d.stats.byErrorType.map((e) => (
              <div
                key={e.type}
                className="w-row"
                style={{ marginBottom: 4, cursor: "pointer" }}
                onClick={() => setFilterError(filterError === e.type ? "" : e.type)}
              >
                <span className="w-caption" style={{ flex: 1, color: filterError === e.type ? "var(--text-bright)" : undefined }}>{e.type}</span>
                <span className="w-caption">{e.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stage breakdown */}
        <div className="section-card">
          <div className="section-card-header"><span className="title">by stage</span></div>
          <div className="section-card-body" style={{ padding: "10px 14px" }}>
            {d.stats.byStage.map((s) => (
              <div
                key={s.stage}
                className="w-row"
                style={{ marginBottom: 4, cursor: "pointer" }}
                onClick={() => setFilterStage(filterStage === s.stage ? "" : s.stage)}
              >
                <span className="w-caption" style={{ flex: 1, color: filterStage === s.stage ? "var(--text-bright)" : undefined }}>{s.stage}</span>
                <span className="w-caption">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Active filters */}
      {(filterType || filterError || filterStage) && (
        <div className="action-bar" style={{ marginBottom: 12 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>filters:</span>
          {filterType && <Pill color="blue">{filterType} ×</Pill>}
          {filterError && (
            <span className="pill amber" style={{ cursor: "pointer" }} onClick={() => setFilterError("")}>{filterError} ×</span>
          )}
          {filterStage && (
            <span className="pill gray" style={{ cursor: "pointer" }} onClick={() => setFilterStage("")}>{filterStage} ×</span>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => { setFilterType(""); setFilterError(""); setFilterStage(""); }}>
            clear all
          </button>
        </div>
      )}

      {/* Timeline */}
      <div className="section-card">
        <div className="section-card-header">
          <span className="title">timeline</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>{filtered.length} events</span>
        </div>
        <div className="section-card-body table-wrap">
          {filtered.length === 0 ? (
            <div className="loading-dim">no incidents match filters</div>
          ) : (
            <table className="data-table">
              <thead><tr>
                <th>when</th><th>type</th><th>slug</th><th>stage</th><th>error</th>
              </tr></thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr key={i} style={{ opacity: Date.now() - e.ts > window24h ? 0.6 : 1 }}>
                    <td className="mono dim" style={{ fontSize: 10, whiteSpace: "nowrap" }}>
                      <span title={fmtTs(e.ts)}>{relTime(e.ts)}</span>
                    </td>
                    <td>
                      <Pill color={e.type === "doctor-abandoned" ? "red" : "amber"}>
                        {e.type === "doctor-abandoned" ? "abandoned" : "failed"}
                      </Pill>
                    </td>
                    <td className="mono trunc" style={{ maxWidth: 200, fontSize: 11 }}>{e.slug}</td>
                    <td className="mono dim">{e.stage}</td>
                    <td>
                      <Pill color={errorColor(e.errorType)}>{e.errorType}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
