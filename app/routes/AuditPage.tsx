import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { SectionCard } from "../components/SectionCard";
import { useTableControls } from "../hooks/useTableControls";
import { TableControls } from "../components/TableControls";
import type { ActionAuditRow } from "../../server/db/writer";
import type { EventRow } from "../../server/api/events";

interface AuditData {
  audit: ActionAuditRow[];
  degraded: boolean;
  reason?: string;
}

interface EventsData {
  events: EventRow[];
  degraded: boolean;
  reason?: string;
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function statusColor(status: string | null): string {
  if (status === "success" || status === "accepted") return "green";
  if (status === "failed" || status === "error" || status === "denied") return "red";
  if (status === "running" || status === "started") return "blue";
  return "amber";
}

function riskColor(risk: string | null): string {
  if (risk === "high" || risk === "destructive") return "red";
  if (risk === "medium") return "amber";
  if (risk === "low") return "green";
  return "gray";
}

function severityColor(severity: string): string {
  if (severity === "error") return "red";
  if (severity === "warn") return "amber";
  if (severity === "info") return "blue";
  return "gray";
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

type ChainStatus = { ok: boolean; checkedCount: number; firstBadId?: number; headHash: string | null; headTs: number | null };

function ChainStatusBadge() {
  const { data, refresh } = useAuthenticatedApi<ChainStatus>("/api/audit/chain-status", 60_000);
  if (!data) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 14px", borderRadius: 8, background: data.ok ? "color-mix(in oklch, green 15%, transparent)" : "color-mix(in oklch, red 15%, transparent)", border: `1px solid ${data.ok ? "green" : "red"}`, fontSize: 12, marginBottom: 16 }}>
      <span style={{ fontWeight: 700, color: data.ok ? "green" : "red" }}>
        {data.ok ? "✓ Chain OK" : "✗ Chain BROKEN"}
      </span>
      <span style={{ color: "var(--text-dim)" }}>
        {data.checkedCount} row{data.checkedCount !== 1 ? "s" : ""} verified
        {data.firstBadId ? ` · first bad row: #${data.firstBadId}` : ""}
      </span>
      {data.headHash && (
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }} title={data.headHash}>
          head: {data.headHash.slice(0, 12)}…
        </span>
      )}
      <button onClick={refresh} style={{ marginLeft: "auto", fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "transparent", cursor: "pointer", color: "var(--text-dim)" }}>Verify</button>
    </div>
  );
}

function EventDrawer({ event, onClose }: { event: EventRow; onClose: () => void }) {
  return (
    <div className="evidence-drawer-overlay" onClick={onClose}>
      <aside className="evidence-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="evidence-drawer-head">
          <div>
            <div className="evidence-drawer-kicker">system event</div>
            <div className="evidence-drawer-title">#{event.id} · {event.kind}</div>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close event drawer">×</button>
        </div>

        <div className="evidence-drawer-summary">
          <Pill color={severityColor(event.severity)}>{event.severity}</Pill>
          {event.entityType && <Pill color="gray">{event.entityType}</Pill>}
        </div>

        <div className="audit-detail-grid">
          <div><span>time</span><strong>{fmtTs(event.ts)}</strong></div>
          <div><span>kind</span><strong>{event.kind}</strong></div>
          {event.entityType && <div><span>entity</span><strong>{event.entityType}</strong></div>}
          {event.entityId && <div><span>entity id</span><strong className="mono trunc">{event.entityId}</strong></div>}
          <div><span>summary</span><strong>{event.summary}</strong></div>
        </div>

        {event.payload && (
          <div className="evidence-block">
            <div className="evidence-block-title">Payload</div>
            <pre className="audit-pre">{stringify(event.payload)}</pre>
          </div>
        )}
      </aside>
    </div>
  );
}

export function AuditPage() {
  const [resultStatus, setResultStatus] = useState("");
  const [targetType, setTargetType] = useState("");
  const [actionKind, setActionKind] = useState("");
  const [selected, setSelected] = useState<ActionAuditRow | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);
  const [activeTab, setActiveTab] = useState<"actions" | "events">("events");

  const auditQuery = new URLSearchParams({ limit: "100" });
  if (resultStatus) auditQuery.set("resultStatus", resultStatus);
  if (targetType) auditQuery.set("targetType", targetType);
  if (actionKind) auditQuery.set("actionKind", actionKind);

  const { data, loading, error, refresh } = useAuthenticatedApi<AuditData>(`/api/actions/audit?${auditQuery.toString()}`, 20_000);
  const { data: eventsData, loading: eventsLoading, error: eventsError, refresh: refreshEvents } = useAuthenticatedApi<EventsData>("/api/events?limit=100", 20_000);

  const rows = data?.audit ?? [];
  const events = eventsData?.events ?? [];
  const targetTypes = useMemo(() => Array.from(new Set(rows.map((row) => row.targetType).filter(Boolean) as string[])).sort(), [rows]);
  const actionKinds = useMemo(() => Array.from(new Set(rows.map((row) => row.actionKind))).sort(), [rows]);
  const counts = useMemo(() => ({
    success: rows.filter((row) => row.resultStatus === "success" || row.resultStatus === "accepted").length,
    failed: rows.filter((row) => row.resultStatus === "failed" || row.resultStatus === "error" || row.resultStatus === "denied").length,
    highRisk: rows.filter((row) => row.risk === "high" || row.risk === "destructive").length,
  }), [rows]);

  type AuditSortKey = "ts" | "resultStatus" | "risk" | "actionKind" | "actor";
  const auditCtrl = useTableControls<ActionAuditRow, AuditSortKey>({
    rows,
    defaultSort: { key: "ts", dir: "desc" },
    filterText: (row) => [row.actionKind, row.targetType, row.targetId, row.actor, row.resultStatus, row.risk],
    sortValue: (row, key) => {
      if (key === "ts") return row.ts;
      if (key === "resultStatus") return row.resultStatus;
      if (key === "risk") return row.risk;
      if (key === "actionKind") return row.actionKind;
      if (key === "actor") return row.actor;
      return null;
    },
  });

  type EventSortKey = "ts" | "kind" | "severity" | "entityType" | "entityId";
  const eventsCtrl = useTableControls<EventRow, EventSortKey>({
    rows: events,
    defaultSort: { key: "ts", dir: "desc" },
    filterText: (row) => [row.kind, row.severity, row.entityType ?? "", row.entityId ?? "", row.summary],
    sortValue: (row, key) => {
      if (key === "ts") return row.ts;
      if (key === "kind") return row.kind;
      if (key === "severity") return row.severity;
      if (key === "entityType") return row.entityType ?? "";
      if (key === "entityId") return row.entityId ?? "";
      return null;
    },
  });

  if (loading && !data) return <div className="loading-dim">loading...</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;

  const combinedLoading = loading || eventsLoading;
  const combinedError = error || eventsError;

  return (
    <div className="dash-page">
      {selected && (
        <div className="evidence-drawer-overlay" onClick={() => setSelected(null)}>
          <aside className="evidence-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="evidence-drawer-head">
              <div>
                <div className="evidence-drawer-kicker">audit record</div>
                <div className="evidence-drawer-title">#{selected.id} · {selected.actionKind}</div>
              </div>
              <button className="drawer-close" onClick={() => setSelected(null)} aria-label="Close audit drawer">×</button>
            </div>

            <div className="evidence-drawer-summary">
              <Pill color={statusColor(selected.resultStatus)}>{selected.resultStatus ?? "unknown"}</Pill>
              <Pill color={riskColor(selected.risk)}>{selected.risk ?? "unknown"}</Pill>
              {selected.targetType && <Pill color="gray">{selected.targetType}</Pill>}
            </div>

            <div className="audit-detail-grid">
              <div><span>time</span><strong>{fmtTs(selected.ts)}</strong></div>
              <div><span>actor</span><strong>{selected.actor ?? "-"}</strong></div>
              <div><span>source</span><strong>{selected.actorSource ?? "-"}</strong></div>
              <div><span>target</span><strong>{selected.targetId ?? selected.target ?? "-"}</strong></div>
              <div><span>job</span><strong>{selected.jobId ?? "-"}</strong></div>
              <div><span>event</span><strong>{selected.eventId ?? "-"}</strong></div>
            </div>

            {selected.reason && (
              <div className="evidence-block">
                <div className="evidence-block-title">Reason</div>
                <div className="audit-pre">{selected.reason}</div>
              </div>
            )}
            {selected.error && (
              <div className="evidence-block">
                <div className="evidence-block-title">Error</div>
                <div className="audit-pre error">{selected.error}</div>
              </div>
            )}
            {selected.rollbackHint && (
              <div className="evidence-block">
                <div className="evidence-block-title">Rollback</div>
                <div className="audit-pre">{selected.rollbackHint}</div>
              </div>
            )}
            {stringify(selected.request) && (
              <div className="evidence-block">
                <div className="evidence-block-title">Request</div>
                <pre className="audit-pre">{stringify(selected.request)}</pre>
              </div>
            )}
            {stringify(selected.resultJson) && (
              <div className="evidence-block">
                <div className="evidence-block-title">Result</div>
                <pre className="audit-pre">{stringify(selected.resultJson)}</pre>
              </div>
            )}
            {stringify(selected.evidence) && (
              <div className="evidence-block">
                <div className="evidence-block-title">Evidence</div>
                <pre className="audit-pre">{stringify(selected.evidence)}</pre>
              </div>
            )}
          </aside>
        </div>
      )}

      {selectedEvent && (
        <EventDrawer event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}

      <div className="page-header">
        <div className="page-title">Audit</div>
        <button className="btn btn-sm btn-ghost" onClick={activeTab === "actions" ? refresh : refreshEvents} disabled={combinedLoading}>
          <RefreshCw size={14} /> refresh
        </button>
      </div>

      <div className="audit-tabs" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${activeTab === "actions" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setActiveTab("actions")}
        >
          Operator Actions
        </button>
        <button
          className={`btn btn-sm ${activeTab === "events" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setActiveTab("events")}
        >
          System Events
        </button>
      </div>

      <ChainStatusBadge />

      <div className="stat-row">
        <div className="stat-item"><div className="stat-val">{rows.length}</div><div className="stat-lbl">loaded</div></div>
        <div className="stat-item"><div className="stat-val">{counts.success}</div><div className="stat-lbl">success</div></div>
        <div className="stat-item"><div className="stat-val">{counts.failed}</div><div className="stat-lbl">failed</div></div>
        <div className="stat-item"><div className="stat-val">{counts.highRisk}</div><div className="stat-lbl">high risk</div></div>
      </div>

      {data?.degraded && <div className="loading-dim error">degraded: {data.reason}</div>}

      <div className="action-bar audit-filter-bar">
        <select className="audit-select" value={resultStatus} onChange={(event) => setResultStatus(event.target.value)}>
          <option value="">all results</option>
          <option value="success">success</option>
          <option value="failed">failed</option>
        </select>
        <select className="audit-select" value={targetType} onChange={(event) => setTargetType(event.target.value)}>
          <option value="">all targets</option>
          {targetTypes.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select className="audit-select" value={actionKind} onChange={(event) => setActionKind(event.target.value)}>
          <option value="">all actions</option>
          {actionKinds.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <SectionCard
        title="recent audit"
        defaultOpen={true}
        right={<span className="mono dim">{rows.length} rows</span>}
      >
        <div className="section-card-body table-wrap">
          <TableControls {...auditCtrl.controlsProps} searchPlaceholder="Filter by action, target, actor…" />
          {rows.length === 0 ? (
            <div className="empty-state" style={{ padding: "18px 14px", lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No operator actions in this period</div>
              <div className="dim">
                This log records <strong>manual operator actions</strong> (apply/approve button clicks), and is hash-chained for tamper-evidence.
                The platform has been running autonomously, so there are none recently — this is expected, not an error.
                Live, ongoing system activity is in the <strong>System Events</strong> tab above.
              </div>
            </div>
          ) : (
            <table className="data-table audit-entries-table">
              <thead>
                <tr>
                  <th {...auditCtrl.sortHeaderProps("ts")} className="audit-when-col">when <span className="sortable-th-arrow">{auditCtrl.sort.key === "ts" ? (auditCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...auditCtrl.sortHeaderProps("resultStatus")}>result <span className="sortable-th-arrow">{auditCtrl.sort.key === "resultStatus" ? (auditCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...auditCtrl.sortHeaderProps("risk")}>risk <span className="sortable-th-arrow">{auditCtrl.sort.key === "risk" ? (auditCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...auditCtrl.sortHeaderProps("actionKind")}>action <span className="sortable-th-arrow">{auditCtrl.sort.key === "actionKind" ? (auditCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th>target</th>
                  <th {...auditCtrl.sortHeaderProps("actor")} className="audit-actor-col">actor <span className="sortable-th-arrow">{auditCtrl.sort.key === "actor" ? (auditCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {auditCtrl.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="mono dim audit-when-col">{fmtTs(row.ts)}</td>
                    <td><Pill color={statusColor(row.resultStatus)}>{row.resultStatus ?? "-"}</Pill></td>
                    <td><Pill color={riskColor(row.risk)}>{row.risk ?? "-"}</Pill></td>
                    <td className="mono">{row.actionKind}</td>
                    <td className="mono trunc">{row.targetId ?? row.target ?? row.targetType ?? "-"}</td>
                    <td className="mono dim audit-actor-col">{row.actor ?? "-"}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setSelected(row)}>details</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SectionCard>

      {activeTab === "events" && (
        <SectionCard
          title="system events"
          defaultOpen={true}
          right={<span className="mono dim">{events.length} rows</span>}
        >
          <div className="section-card-body table-wrap">
            <TableControls {...eventsCtrl.controlsProps} searchPlaceholder="Filter by kind, entity, summary…" />
            {events.length === 0 ? (
              <div className="loading-dim">no system events</div>
            ) : (
              <table className="data-table audit-entries-table">
                <thead>
                  <tr>
                    <th {...eventsCtrl.sortHeaderProps("ts")} className="audit-when-col">when <span className="sortable-th-arrow">{eventsCtrl.sort.key === "ts" ? (eventsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...eventsCtrl.sortHeaderProps("kind")}>kind <span className="sortable-th-arrow">{eventsCtrl.sort.key === "kind" ? (eventsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...eventsCtrl.sortHeaderProps("severity")}>severity <span className="sortable-th-arrow">{eventsCtrl.sort.key === "severity" ? (eventsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th {...eventsCtrl.sortHeaderProps("entityType")}>entity <span className="sortable-th-arrow">{eventsCtrl.sort.key === "entityType" ? (eventsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                    <th>summary</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {eventsCtrl.rows.map((row) => (
                    <tr key={row.id} onClick={() => setSelectedEvent(row)} style={{ cursor: "pointer" }}>
                      <td className="mono dim audit-when-col">{fmtTs(row.ts)}</td>
                      <td className="mono">{row.kind}</td>
                      <td><Pill color={severityColor(row.severity)}>{row.severity}</Pill></td>
                      <td className="mono trunc">{row.entityType ?? "-"}{row.entityId ? ` · #{row.entityId}` : ""}</td>
                      <td className="trunc" style={{ maxWidth: 400 }}>{row.summary}</td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn btn-sm btn-ghost" onClick={(event) => { event.stopPropagation(); setSelectedEvent(row); }}>details</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
