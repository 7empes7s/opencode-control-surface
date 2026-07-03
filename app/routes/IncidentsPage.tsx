import { Fragment, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, BellOff, BellRing, CheckCircle2, ChevronDown, ChevronRight, Clock3, ExternalLink, FileText, Hammer, LoaderCircle, Save, ShieldCheck, Sparkles } from "lucide-react";
import { TableControls } from "../components/TableControls";
import { useApi, fmtAge } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { useTableControls } from "../hooks/useTableControls";
import { authFetch } from "../lib/authFetch";
import type { IncidentsDetail, IncidentEntry, ReasonerIncidentEntry } from "../../server/api/incidents";

type IncidentsSortKey = "ts" | "severity" | "stage";
type ReasonerIncidentSortKey = "lastSeen" | "status" | "count" | "failureClass";

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

const MUTE_DURATIONS: { ms: number; label: string }[] = [
  { ms: 0, label: "until unmuted" },
  { ms: 60 * 60 * 1000, label: "1 hour" },
  { ms: 4 * 60 * 60 * 1000, label: "4 hours" },
  { ms: 24 * 60 * 60 * 1000, label: "24 hours" },
  { ms: 7 * 24 * 60 * 60 * 1000, label: "7 days" },
];

function IncidentLifecycleCard({
  incident,
  onChanged,
}: {
  incident: ReasonerIncidentEntry;
  onChanged: () => void;
}) {
  const ack = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/ack`);
  const mitigate = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/mitigate`);
  const mute = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/mute`);
  const unmute = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/unmute`);
  const resolve = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/resolve`);
  const escalate = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/escalate`);
  const savePostMortem = useAction(`/api/incidents/${encodeURIComponent(incident.id)}/post-mortem`);
  const [note, setNote] = useState(incident.postMortem ?? "");
  const [resolveReason, setResolveReason] = useState("Resolved from incidents page");
  const [muteReason, setMuteReason] = useState("Muted from incidents page");
  const [muteDuration, setMuteDuration] = useState<string>("0");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionNote, setSuggestionNote] = useState<string | null>(null);

  useEffect(() => {
    setNote(incident.postMortem ?? "");
    setSuggestionNote(null);
  }, [incident.id, incident.postMortem]);

  async function acknowledge() {
    if (await ack.run()) onChanged();
  }

  async function mitigateIncident() {
    if (await mitigate.run()) onChanged();
  }

  async function resolveIncident() {
    if (!window.confirm(`Resolve ${incident.title}?`)) return;
    if (await resolve.run({ reason: resolveReason })) onChanged();
  }

  async function escalateIncident() {
    if (await escalate.run({ reason: "Escalated from incidents page" })) onChanged();
  }

  async function muteIncident() {
    const ms = Number(muteDuration);
    const label = ms > 0 ? `Snooze ${incident.title} for ${MUTE_DURATIONS.find((d) => d.ms === ms)?.label ?? "a while"}?` : `Mute ${incident.title} until unmuted?`;
    if (!window.confirm(label)) return;
    const params: { reason: string; durationMs?: number } = { reason: muteReason };
    if (ms > 0) params.durationMs = ms;
    if (await mute.run(params)) onChanged();
  }

  async function unmuteIncident() {
    if (await unmute.run()) onChanged();
  }

  async function saveNote() {
    if (await savePostMortem.run({ postMortem: note })) onChanged();
  }

  async function suggestPostMortem() {
    setSuggesting(true);
    setSuggestionNote(null);
    try {
      const res = await authFetch(`/api/incidents/${encodeURIComponent(incident.id)}/suggest-postmortem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json() as { data?: { suggestion?: string }; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const suggestion = json.data?.suggestion ?? "";
      if (suggestion.trim()) {
        setNote(suggestion);
        setSuggestionNote("AI draft inserted. Review or edit before saving.");
      } else {
        setSuggestionNote("No draft was available; the note remains editable.");
      }
    } catch (err) {
      setSuggestionNote(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <div className="dash-card" style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong>{incident.title}</strong>
            <Pill color={incident.status === "resolved" ? "green" : "red"}>{incident.status}</Pill>
            <Pill color="blue">{incident.failureClass}</Pill>
            {incident.escalatedWorkflowId && <Pill color="amber">escalated</Pill>}
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
            onClick={mitigateIncident}
            disabled={mitigate.loading || incident.status === "resolved" || incident.mitigatedAt !== null}
            style={{ minHeight: 44 }}
          >
            <ShieldCheck size={15} />
            {incident.mitigatedAt ? "Mitigating" : "Mitigate"}
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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={escalateIncident}
            disabled={escalate.loading || incident.escalatedWorkflowId !== null}
            style={{ minHeight: 44 }}
          >
            <Hammer size={15} />
            {incident.escalatedWorkflowId ? "Escalated" : "Escalate to workflow"}
          </button>
          {incident.muteActive ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={unmuteIncident}
              disabled={unmute.loading}
              style={{ minHeight: 44 }}
            >
              <BellRing size={15} />
              Unmute
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={muteIncident}
              disabled={mute.loading || incident.status === "resolved"}
              style={{ minHeight: 44 }}
            >
              <BellOff size={15} />
              Mute
            </button>
          )}
        </div>
      </div>

      {(ack.error || mitigate.error || resolve.error || escalate.error || mute.error || unmute.error || savePostMortem.error) && (
        <div className="loading-dim error">{ack.error ?? mitigate.error ?? resolve.error ?? escalate.error ?? mute.error ?? unmute.error ?? savePostMortem.error}</div>
      )}
      {(ack.success || mitigate.success || resolve.success || escalate.success || mute.success || unmute.success || savePostMortem.success) && (
        <div className="loading-dim">{ack.success ?? mitigate.success ?? resolve.success ?? escalate.success ?? mute.success ?? unmute.success ?? savePostMortem.success}</div>
      )}

      {incident.autoClosed && (
        <div className="insights-message" style={{ alignItems: "flex-start" }}>
          <CheckCircle2 size={15} />
          <div>
            <strong>Auto-closed by system</strong>
            <div style={{ marginTop: 4 }}>
              {incident.autoCloseReason ?? "The underlying condition cleared in a product-health scan."}
            </div>
            {incident.autoCloseAt !== null && (
              <div className="dim" style={{ marginTop: 6 }}>
                Closed {relTime(incident.autoCloseAt)} · sentinel scan · no operator action required
              </div>
            )}
          </div>
        </div>
      )}

      {incident.escalatedWorkflowId && (
        <div className="insights-message" style={{ alignItems: "flex-start" }}>
          <Hammer size={15} />
          <div>
            <strong>Escalated to workflow</strong>
            <div className="mono dim" style={{ marginTop: 4, fontSize: 11 }}>{incident.escalatedWorkflowId}</div>
            <div style={{ marginTop: 6 }}>
              <Link href="/builder" className="btn btn-sm btn-ghost" style={{ minHeight: 44 }}>
                <ExternalLink size={13} />
                Open in Builder
              </Link>
            </div>
          </div>
        </div>
      )}

      {incident.muteActive && incident.mutedAt !== null && (
        <div className="insights-message" style={{ alignItems: "flex-start" }}>
          <BellOff size={15} />
          <div>
            <strong>Muted</strong>
            <div style={{ marginTop: 4 }}>{incident.muteReason ?? "No mute reason recorded."}</div>
            <div className="dim" style={{ marginTop: 6 }}>
              Muted {relTime(incident.mutedAt)}{incident.mutedBy ? ` by ${incident.mutedBy}` : ""}
              {incident.mutedUntil !== null
                ? ` · snoozed until ${new Date(incident.mutedUntil).toLocaleString()}`
                : " · until unmuted"}
            </div>
          </div>
        </div>
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

      <label className="incident-field">
        <span>Resolve reason</span>
        <input
          value={resolveReason}
          onChange={(event) => setResolveReason(event.currentTarget.value)}
          className="incident-text-input"
          placeholder="Reason recorded when resolving"
        />
      </label>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label className="incident-field" style={{ flex: "1 1 220px" }}>
          <span>Mute reason</span>
          <input
            value={muteReason}
            onChange={(event) => setMuteReason(event.currentTarget.value)}
            className="incident-text-input"
            placeholder="Reason recorded when muting"
            disabled={incident.muteActive}
          />
        </label>
        <label className="incident-field" style={{ flex: "0 1 180px" }}>
          <span>Snooze for</span>
          <select
            value={muteDuration}
            onChange={(event) => setMuteDuration(event.currentTarget.value)}
            className="incident-text-input"
            disabled={incident.muteActive}
            style={{ minHeight: 44 }}
          >
            {MUTE_DURATIONS.map((d) => (
              <option key={d.ms} value={String(d.ms)}>{d.label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="incident-field">
        <span style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700 }}>
          <FileText size={15} />
          Post-mortem note
        </span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          rows={4}
          className="incident-textarea"
        />
      </label>
      {suggestionNote && (
        <div className={`loading-dim${suggestionNote.toLowerCase().includes("http") ? " error" : ""}`}>
          {suggestionNote}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={suggestPostMortem}
          disabled={suggesting}
          style={{ minHeight: 44 }}
        >
          {suggesting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
          Suggest with AI
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={saveNote}
          disabled={savePostMortem.loading || suggesting}
          style={{ minHeight: 44 }}
        >
          <Save size={15} />
          Save note
        </button>
      </div>
    </div>
  );
}

type LoopStats = {
  openCount: number;
  resolved7d: number;
  autoClosed7d: number;
  autoResolved7d: number;
  autoShare: number | null;
  meanTimeToResolveMs: number | null;
  recurrenceFlagged: number;
};

export function IncidentsPage() {
  const { data, loading, error, refresh } = useApi<IncidentsDetail>("/api/incidents", 30_000);
  const { data: loopStats } = useApi<LoopStats | null>("/api/reasoner/loop-stats", 60_000);
  const entries = data?.entries ?? [];
  const reasonerIncidents = data?.reasonerIncidents ?? [];
  const sla = data?.sla;
  const openCriticals = entries.filter((entry) => entry.errorType === "critical").length;
  const controls = useTableControls<IncidentEntry, IncidentsSortKey>({
    rows: entries,
    pageSize: 25,
    rowKey: (row) => `${row.type}:${row.slug}:${row.ts}`,
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
  const reasonerControls = useTableControls<ReasonerIncidentEntry, ReasonerIncidentSortKey>({
    rows: reasonerIncidents,
    pageSize: 10,
    rowKey: (row) => row.id,
    filterText: (row) => [
      row.title,
      row.id,
      row.failureClass,
      row.status,
      row.rootCause ?? "",
      suggestedActionText(row.suggestedActions),
      row.autoClosed ? "auto-closed system" : "",
      row.muteActive ? "muted snoozed" : "",
      row.escalatedWorkflowId ? "escalated workflow" : "",
    ],
    sortValue: (row, key) => {
      if (key === "lastSeen") return row.lastSeen;
      if (key === "status") return row.status;
      if (key === "count") return row.occurrenceCount;
      return row.failureClass;
    },
    defaultSort: { key: "lastSeen", dir: "desc" },
    tieBreak: ["count"],
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
          <SlaTile
            icon={<CheckCircle2 size={16} />}
            label="Auto-remediated (7d)"
            value={loopStats ? String(loopStats.autoClosed7d + loopStats.autoResolved7d) : "—"}
            detail={loopStats
              ? `${loopStats.autoClosed7d} condition-cleared · ${loopStats.autoResolved7d} idle-swept` +
                (loopStats.autoShare !== null ? ` · ${Math.round(loopStats.autoShare * 100)}% of closes` : "")
              : "loop stats unavailable"}
          />
          <SlaTile
            icon={<BellRing size={16} />}
            label="Recurring conditions"
            value={loopStats ? String(loopStats.recurrenceFlagged) : "—"}
            detail={loopStats && loopStats.recurrenceFlagged > 0
              ? "auto-close is masking a flapping root cause — see Detections"
              : "nothing keeps coming back"}
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
                  <th className="expander-col" aria-label="details"></th>
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
                  const key = controls.getRowKey(entry);
                  const expanded = controls.isExpanded(key);
                  return (
                    <Fragment key={key}>
                      <tr className="data-row-clickable" onClick={() => controls.toggleExpanded(key)}>
                        <td className="expander-col">
                          <button type="button" className="table-expander" aria-label={expanded ? "Collapse details" : "Expand details"}>
                            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </td>
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
                        <td style={{ textAlign: "right" }} onClick={(event) => event.stopPropagation()}>
                          <Link href={href} className="btn btn-sm btn-ghost" style={{ minHeight: 44 }}>
                            <ExternalLink size={13} />
                            View detection
                          </Link>
                        </td>
                      </tr>
                      {expanded && (
                        <tr key={`${key}:detail`} className="data-row-detail">
                          <td colSpan={6}>
                            <div className="data-row-detail-inner">
                              <div className="data-row-detail-grid">
                                <div><span>source</span><strong>{focus}</strong></div>
                                <div><span>manual page</span><strong>{entry.manualPageHref ?? "/insights"}</strong></div>
                                <div><span>detected</span><strong>{new Date(entry.ts).toISOString()}</strong></div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {controls.filteredCount === 0 && (
                  <tr>
                    <td colSpan={6} className="loading-dim">no incidents match the current filter</td>
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
          <div className="table-wrap incidents-workflow-table">
            <TableControls {...reasonerControls.controlsProps} searchPlaceholder="Filter workflow incidents..." />
            <table className="data-table">
              <thead>
                <tr>
                  <th className="expander-col" aria-label="details"></th>
                  <th {...reasonerControls.sortHeaderProps("status")} style={{ width: 140 }}>status</th>
                  <th>incident</th>
                  <th {...reasonerControls.sortHeaderProps("failureClass")} style={{ width: 160 }}>class</th>
                  <th {...reasonerControls.sortHeaderProps("count")} style={{ width: 120 }}>count</th>
                  <th {...reasonerControls.sortHeaderProps("lastSeen")} style={{ width: 150 }}>last seen</th>
                </tr>
              </thead>
              <tbody>
                {reasonerControls.rows.map((incident) => {
                  const key = reasonerControls.getRowKey(incident);
                  const expanded = reasonerControls.isExpanded(key);
                  return (
                    <Fragment key={key}>
                      <tr className="data-row-clickable" onClick={() => reasonerControls.toggleExpanded(key)}>
                        <td className="expander-col">
                          <button type="button" className="table-expander" aria-label={expanded ? "Collapse lifecycle" : "Expand lifecycle"}>
                            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </td>
                        <td>
                          <Pill color={incident.status === "resolved" ? "green" : "red"}>{incident.status}</Pill>
                          {incident.autoClosed && <Pill color="gray">auto-closed</Pill>}
                          {incident.muteActive && <Pill color="gray">muted</Pill>}
                        </td>
                        <td>
                          <strong>{incident.title}</strong>
                          <div className="mono dim" style={{ marginTop: 3, fontSize: 11 }}>{incident.id}</div>
                        </td>
                        <td><Pill color="blue">{incident.failureClass}</Pill></td>
                        <td className="mono">{incident.occurrenceCount}</td>
                        <td className="mono dim">{relTime(incident.lastSeen)}</td>
                      </tr>
                      {expanded && (
                        <tr key={`${key}:detail`} className="data-row-detail">
                          <td colSpan={6}>
                            <div className="data-row-detail-inner">
                              <IncidentLifecycleCard incident={incident} onChanged={refresh} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {reasonerControls.filteredCount === 0 && (
                  <tr>
                    <td colSpan={6} className="loading-dim">no workflow incidents match the current filter</td>
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
