import { useState } from "react";
import { useApi } from "../hooks/useApi";
import type { WorkloadResponse } from "../../server/api/workload";

function getStatusColor(status: string) {
  switch (status) {
    case "success": return "green";
    case "failed": return "red";
    case "running": return "amber";
    case "queued": return "blue";
    case "pending": return "gray";
    default: return "gray";
  }
}

export function WorkloadGraphTable() {
  const { data, loading, error } = useApi<WorkloadResponse>("/api/workload", 60_000);
  const [timeRange, setTimeRange] = useState<"1h" | "24h" | "7d">("24h");

  if (loading && !data) return <div className="loading-dim">loading workload data…</div>;
  if (error && !data) return <div className="loading-dim error">failed to load workload data</div>;
  if (!data) return null;

  // Filter by time range
  const filteredData = data.entries.filter(entry => {
    const now = Date.now();
    const entryAgeMs = now - entry.startTime;
    
    switch (timeRange) {
      case "1h": return entryAgeMs <= 3600000;
      case "24h": return entryAgeMs <= 86400000;
      case "7d": return entryAgeMs <= 604800000;
      default: return true;
    }
  });

  return (
    <div className="dash-section">
      <div className="dash-section-title">
        workload graph
        <div style={{ float: "right", display: "flex", gap: 8 }}>
          <select 
            className="form-select" 
            value={timeRange} 
            onChange={(e) => setTimeRange(e.target.value as any)}
            style={{ fontSize: 11, padding: "2px 6px" }}
          >
            <option value="1h">1h</option>
            <option value="24h">24h</option>
            <option value="7d">7d</option>
          </select>
        </div>
      </div>
      
      {/* Summary cards */}
      <div className="widget-grid" style={{ marginBottom: 12 }}>
        <div className="w-card" style={{ padding: "8px 12px" }}>
          <div className="w-label">newsbites</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <span className="pill green" style={{ fontSize: 10 }}>{data.summary.newsbites.success} success</span>
            <span className="pill red" style={{ fontSize: 10 }}>{data.summary.newsbites.failed} failed</span>
            <span className="pill amber" style={{ fontSize: 10 }}>{data.summary.newsbites.running} running</span>
          </div>
        </div>
        <div className="w-card" style={{ padding: "8px 12px" }}>
          <div className="w-label">autopipeline</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <span className="pill green" style={{ fontSize: 10 }}>{data.summary.autopipeline.success} success</span>
            <span className="pill red" style={{ fontSize: 10 }}>{data.summary.autopipeline.failed} failed</span>
            <span className="pill amber" style={{ fontSize: 10 }}>{data.summary.autopipeline.running} running</span>
          </div>
        </div>
        <div className="w-card" style={{ padding: "8px 12px" }}>
          <div className="w-label">builder</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <span className="pill green" style={{ fontSize: 10 }}>{data.summary.builder.success} success</span>
            <span className="pill red" style={{ fontSize: 10 }}>{data.summary.builder.failed} failed</span>
            <span className="pill amber" style={{ fontSize: 10 }}>{data.summary.builder.running} running</span>
          </div>
        </div>
        <div className="w-card" style={{ padding: "8px 12px" }}>
          <div className="w-label">agents</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <span className="pill green" style={{ fontSize: 10 }}>{data.summary.agent.success} success</span>
            <span className="pill red" style={{ fontSize: 10 }}>{data.summary.agent.failed} failed</span>
            <span className="pill amber" style={{ fontSize: 10 }}>{data.summary.agent.running} running</span>
          </div>
        </div>
      </div>
      
      {/* Detailed table */}
      <div className="w-card" style={{ padding: 0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>workload</th>
              <th>type</th>
              <th>status</th>
              <th>model</th>
              <th>duration</th>
              <th>score</th>
            </tr>
          </thead>
          <tbody>
            {filteredData.map(entry => (
              <tr key={entry.id}>
                <td className="mono trunc" style={{ maxWidth: 150 }}>{entry.name}</td>
                <td>
                  <span className="pill gray" style={{ fontSize: 9 }}>
                    {entry.type}
                  </span>
                </td>
                <td>
                  <span className={`pill ${getStatusColor(entry.status)}`} style={{ fontSize: 9 }}>
                    {entry.status}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: 10 }}>{entry.modelUsed || "—"}</td>
                <td className="mono" style={{ fontSize: 10 }}>
                  {entry.durationMs ? `${Math.round(entry.durationMs / 1000)}s` : "—"}
                </td>
                <td style={{ fontSize: 10 }}>
                  {entry.score ? `${entry.score}/100` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {filteredData.length === 0 && (
          <div className="loading-dim" style={{ padding: 20, textAlign: "center" }}>
            no workload data in selected time range
          </div>
        )}
      </div>
    </div>
  );
}