import { Fragment, useState } from "react";
import { useApi } from "../hooks/useApi";
import type { WorkloadEntry, WorkloadResponse } from "../../server/api/workload";
import { TableControls } from "./TableControls";
import { useTableControls, type TableSortValue } from "../hooks/useTableControls";
import { ChevronDown, ChevronRight } from "lucide-react";

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

function SortArrow({ active, dir }: { active: boolean; dir?: "asc" | "desc" }) {
  return <span className="sortable-th-arrow">{active ? (dir === "asc" ? "▲" : "▼") : "⇅"}</span>;
}

function rowSearchText(values: TableSortValue[]) {
  return values.filter((value) => value !== null && value !== undefined).join(" ");
}

function WorkloadEntriesTable({ entries }: { entries: WorkloadEntry[] }) {
  type WorkloadKey = "name" | "type" | "status" | "modelUsed" | "durationMs" | "score" | "startTime";
  const controls = useTableControls<WorkloadEntry, WorkloadKey>({
    rows: entries,
    pageSize: 10,
    rowKey: (entry) => entry.id,
    defaultSort: { key: "startTime", dir: "desc" },
    filterText: (entry) => rowSearchText([
      entry.name,
      entry.type,
      entry.status,
      entry.modelUsed,
      entry.score,
      entry.id,
    ]),
    sortValue: (entry, key) => entry[key],
  });

  return (
    <div className="w-card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <TableControls {...controls.controlsProps} searchPlaceholder="Search workloads..." />
        <table className="data-table">
          <thead>
            <tr>
              <th className="expander-col" aria-label="detail" />
              <th {...controls.sortHeaderProps("name")}>workload <SortArrow active={controls.sort.key === "name"} dir={controls.sort.dir} /></th>
              <th {...controls.sortHeaderProps("type")}>type <SortArrow active={controls.sort.key === "type"} dir={controls.sort.dir} /></th>
              <th {...controls.sortHeaderProps("status")}>status <SortArrow active={controls.sort.key === "status"} dir={controls.sort.dir} /></th>
              <th {...controls.sortHeaderProps("modelUsed")}>model <SortArrow active={controls.sort.key === "modelUsed"} dir={controls.sort.dir} /></th>
              <th {...controls.sortHeaderProps("durationMs")}>duration <SortArrow active={controls.sort.key === "durationMs"} dir={controls.sort.dir} /></th>
              <th {...controls.sortHeaderProps("score")}>score <SortArrow active={controls.sort.key === "score"} dir={controls.sort.dir} /></th>
            </tr>
          </thead>
          <tbody>
            {controls.rows.map((entry, index) => {
              const key = controls.getRowKey(entry, index);
              const expanded = controls.isExpanded(key);
              return (
                <Fragment key={key}>
                  <tr className="data-row-clickable" onClick={() => controls.toggleExpanded(key)}>
                    <td className="expander-col">
                      <button className="table-expander" type="button" aria-label={`${expanded ? "Hide" : "Show"} workload detail`} onClick={(event) => { event.stopPropagation(); controls.toggleExpanded(key); }}>
                        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                    </td>
                    <td className="mono trunc" style={{ maxWidth: 150 }} title={entry.name}>{entry.name}</td>
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
                  {expanded && (
                    <tr className="data-row-detail">
                      <td colSpan={7}>
                        <div className="data-row-detail-inner">
                          <div className="data-row-detail-grid">
                            <div><span>id</span><strong className="mono">{entry.id}</strong></div>
                            <div><span>name</span><strong>{entry.name}</strong></div>
                            <div><span>type</span><strong>{entry.type}</strong></div>
                            <div><span>status</span><strong><span className={`pill ${getStatusColor(entry.status)}`}>{entry.status}</span></strong></div>
                            <div><span>started</span><strong className="mono">{new Date(entry.startTime).toISOString().slice(0, 19).replace("T", " ")}</strong></div>
                            <div><span>ended</span><strong className="mono">{entry.endTime ? new Date(entry.endTime).toISOString().slice(0, 19).replace("T", " ") : "—"}</strong></div>
                            <div><span>duration</span><strong>{entry.durationMs ? `${Math.round(entry.durationMs / 1000)}s` : "—"}</strong></div>
                            <div><span>model</span><strong className="mono">{entry.modelUsed || "—"}</strong></div>
                            <div><span>score</span><strong>{entry.score ? `${entry.score}/100` : "—"}</strong></div>
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

        {controls.filteredCount === 0 && (
          <div className="loading-dim" style={{ padding: 20, textAlign: "center" }}>
            no workload data in selected time range
          </div>
        )}
      </div>
    </div>
  );
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
      <WorkloadEntriesTable entries={filteredData} />
    </div>
  );
}
