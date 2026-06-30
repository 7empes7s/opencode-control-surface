import { Link } from "wouter";
import { AlertTriangle, ExternalLink, ShieldCheck, Sparkles } from "lucide-react";
import { TableControls } from "../components/TableControls";
import { useApi, fmtAge } from "../hooks/useApi";
import { useTableControls } from "../hooks/useTableControls";
import type { IncidentsDetail, IncidentEntry } from "../../server/api/incidents";

type IncidentsSortKey = "ts" | "severity" | "stage";

function severityRank(entry: IncidentEntry): number {
  if (entry.severity === "error" && entry.errorType === "critical") return 3;
  if (entry.severity === "error") return 2;
  return 1;
}

function stageColor(stage: string): string {
  if (stage === "ops") return "red";
  if (stage === "security") return "amber";
  if (stage === "build") return "blue";
  return "gray";
}

function relTime(ts: number): string {
  return fmtAge(Math.max(0, Math.round((Date.now() - ts) / 1000)));
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

export function IncidentsPage() {
  const { data, loading, error, refresh } = useApi<IncidentsDetail>("/api/incidents", 30_000);
  const entries = data?.entries ?? [];
  const openCriticals = entries.filter((entry) => entry.errorType === "critical").length;
  const controls = useTableControls<IncidentEntry, IncidentsSortKey>({
    rows: entries,
    pageSize: 25,
    filterText: (row) => [
      row.title ?? "",
      row.slug,
      row.stage,
      row.errorType,
      row.sourceKey ?? "",
    ],
    sortValue: (row, key) => {
      if (key === "ts") return row.ts;
      if (key === "severity") return severityRank(row);
      return row.stage;
    },
    defaultSort: { key: "severity", dir: "desc" },
    tieBreak: ["ts"],
  });

  if (loading && !data) return <div className="loading-dim">loading incidents…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;

  return (
    <div className="dash-page">
      <div className="page-header" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div className="dash-section-title">saved view · detections</div>
          <div className="page-title">Incidents</div>
        </div>
        <Pill color={entries.length > 0 ? "red" : "green"}>{entries.length} incident-grade</Pill>
        {openCriticals > 0 && <Pill color="red">{openCriticals} critical</Pill>}
        <button type="button" className="btn btn-ghost" onClick={refresh} style={{ minHeight: 44 }}>
          Refresh
        </button>
      </div>

      <section className="dash-section">
        <div className="insights-message" style={{ marginBottom: 12 }}>
          <Sparkles size={15} />
          Incidents is a saved view of high-severity Detections across operations, security, and build failures.
          <Link href="/insights" className="btn btn-ghost" style={{ marginLeft: "auto", minHeight: 44 }}>
            <ExternalLink size={14} />
            Open Detections
          </Link>
        </div>

        {entries.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck size={24} />
            <strong>No incident-grade detections.</strong>
            <span>High and critical operations, security, and build findings appear here automatically.</span>
          </div>
        ) : (
          <div className="table-wrap">
            <TableControls {...controls.controlsProps} searchPlaceholder="Filter incidents..." />
            <table className="data-table">
              <thead>
                <tr>
                  <th {...controls.sortHeaderProps("severity")} style={{ width: 150 }}>severity</th>
                  <th {...controls.sortHeaderProps("stage")} style={{ width: 150 }}>domain</th>
                  <th>incident</th>
                  <th {...controls.sortHeaderProps("ts")} style={{ width: 160 }}>detected</th>
                  <th style={{ width: 170 }}></th>
                </tr>
              </thead>
              <tbody>
                {controls.rows.map((entry) => {
                  const focus = entry.sourceKey ?? entry.insightId ?? entry.slug;
                  const href = entry.detectionsHref ?? `/insights?focus=${encodeURIComponent(focus)}`;
                  return (
                    <tr key={`${entry.type}:${entry.slug}:${entry.ts}`}>
                      <td>
                        <Pill color={entry.severity === "error" ? "red" : "amber"}>
                          {entry.errorType}
                        </Pill>
                      </td>
                      <td><Pill color={stageColor(entry.stage)}>{entry.stage}</Pill></td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {entry.severity === "error" ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
                          <strong>{entry.title ?? entry.slug}</strong>
                        </div>
                        <div className="mono dim" style={{ fontSize: 11, marginTop: 3 }}>{focus}</div>
                      </td>
                      <td className="mono dim">{relTime(entry.ts)}</td>
                      <td style={{ textAlign: "right" }}>
                        <Link href={href} className="btn btn-sm btn-ghost" style={{ minHeight: 44 }}>
                          <ExternalLink size={13} />
                          View detection
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {controls.filteredCount === 0 && (
                  <tr>
                    <td colSpan={5} className="loading-dim">no incidents match the current filter</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
