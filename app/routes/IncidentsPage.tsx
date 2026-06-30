import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, FileText, Save, ShieldCheck, Sparkles } from "lucide-react";
import { TableControls } from "../components/TableControls";
import { useApi, fmtAge } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { useTableControls } from "../hooks/useTableControls";
import type { IncidentsDetail, IncidentEntry, ReasonerIncidentEntry } from "../../server/api/incidents";

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

function fmtDuration(ms: number | null): string {
  if (ms === null) return "not enough data yet";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function SlaTile({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="stat-card" style={{ minHeight: 108 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)" }}>
        {icon}
        <span>{label}</span>
      </div>
      <strong style={{ display: "block", fontSize: 24, marginTop: 10 }}>{value}</strong>
      <div className="dim" style={{ marginTop: 4 }}>{detail}</div>
    </div>
  );
}

function suggestedActionText(actions: unknown[]): string {
  if (!Array.isArray(actions) || actions.length === 0) return "No suggested action recorded.";
  const first = actions[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    return String(record.title ?? record.action ?? record.description ?? JSON.stringify(record));
  }
  return String(first);
}

function IncidentLifecycleCard({
  incident,
  onChanged,
}: {
  incident: ReasonerIncidentEntry;
  onChanged: () => void;
}) {
  const ack = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/ack`);
  const resolve = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/resolve`);
  const savePostMortem = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/post-mortem`);
  const [note, setNote] = useState(incident.postMortem ?? "");

  useEffect(() => {
    setNote(incident.postMortem ?? "");
  }, [incident.id, incident.postMortem]);

  async function acknowledge() {
    if (await ack.run()) onChanged();
  }

  async function resolveIncident() {
    if (!window.confirm(`Resolve ${incident.title}?`)) return;
    if (await resolve.run({ reason: "Resolved from incidents page" })) onChanged();
  }

  async function saveNote() {
    if (await savePostMortem.run({ postMortem: note })) onChanged();
  }

  return (
    <div className="dash-card" style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong>{incident.title}</strong>
            <Pill color={incident.status === "resolved" ? "green" : "red"}>{incident.status}</Pill>
            <Pill color="blue">{incident.failureClass}</Pill>
          </div>
          <div className="mono dim" style={{ marginTop: 4, fontSize: 11 }}>
            {incident.id} · {incident.occurrenceCount} occurrences · first seen {relTime(incident.firstSeen)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={acknowledge}
            disabled={ack.loading || incident.acknowledgedAt !== null}
            style={{ minHeight: 44 }}
          >
            <CheckCircle2 size={15} />
            {incident.acknowledgedAt ? "Acknowledged" : "Ack"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={resolveIncident}
            disabled={resolve.loading || incident.status === "resolved"}
            style={{ minHeight: 44 }}
          >
            <ShieldCheck size={15} />
            Resolve
          </button>
        </div>
      </div>

      {(ack.error || resolve.error || savePostMortem.error) && (
        <div className="loading-dim error">{ack.error ?? resolve.error ?? savePostMortem.error}</div>
      )}
      {(ack.success || resolve.success || savePostMortem.success) && (
        <div className="loading-dim">{ack.success ?? resolve.success ?? savePostMortem.success}</div>
      )}

      <div className="insights-message" style={{ alignItems: "flex-start" }}>
        <Sparkles size={15} />
        <div>
          <strong>RCA</strong>
          <div style={{ marginTop: 4 }}>{incident.rootCause ?? "No representative diagnosis has been recorded yet."}</div>
          <div className="dim" style={{ marginTop: 6 }}>Next: {suggestedActionText(incident.suggestedActions)}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <a href={incident.diagnosisHref} className="btn btn-sm btn-ghost" style={{ minHeight: 44 }}>
              <ExternalLink size={13} />
              Incident detail
            </a>
            <a href={incident.passEvidenceHref} className="btn btn-sm btn-ghost" style={{ minHeight: 44 }}>
              <ExternalLink size={13} />
              Pass evidence
            </a>
          </div>
        </div>
      </div>

      <label style={{ display: "grid", gap: 8 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700 }}>
          <FileText size={15} />
          Post-mortem note
        </span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          rows={4}
          style={{ width: "100%", resize: "vertical" }}
        />
      </label>
      <div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={saveNote}
          disabled={savePostMortem.loading}
          style={{ minHeight: 44 }}
        >
          <Save size={15} />
          Save note
        </button>
      </div>
    </div>
  );
}

export function IncidentsPage() {
  const { data, loading, error, refresh } = useApi<IncidentsDetail>("/api/incidents", 30_000);
  const entries = data?.entries ?? [];
  const reasonerIncidents = data?.reasonerIncidents ?? [];
  const sla = data?.sla;
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
        <div className="stats-grid" style={{ marginBottom: 12 }}>
          <SlaTile
            icon={<Clock3 size={16} />}
            label="MTTA"
            value={fmtDuration(sla?.meanTimeToAcknowledgeMs ?? null)}
            detail={`${sla?.acknowledgedSamples ?? 0} acknowledged samples`}
          />
          <SlaTile
            icon={<ShieldCheck size={16} />}
            label="MTTR"
            value={fmtDuration(sla?.meanTimeToResolveMs ?? null)}
            detail={`${sla?.resolvedSamples ?? 0} resolved samples`}
          />
          <SlaTile
            icon={<AlertTriangle size={16} />}
            label="Oldest open"
            value={fmtDuration(sla?.oldestOpenAgeMs ?? null)}
            detail={`${sla?.breachingUnacknowledgedCount ?? 0} breaching 24h without ack`}
          />
        </div>

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

      <section className="dash-section">
        <div className="dash-section-title">reasoner incidents · SLA workflow</div>
        {loading && !data ? (
          <div className="loading-dim">loading incident workflow...</div>
        ) : reasonerIncidents.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck size={24} />
            <strong>No durable incident rows.</strong>
            <span>Reasoner and sentinel incidents with lifecycle state appear here after they are detected.</span>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {reasonerIncidents.map((incident) => (
              <IncidentLifecycleCard key={incident.id} incident={incident} onChanged={refresh} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
