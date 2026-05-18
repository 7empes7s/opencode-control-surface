import { useState } from "react";
import { Link } from "wouter";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";

interface ReasonerIncident {
  id: string;
  clusterKey: string;
  failureClass: string;
  title: string;
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  representativePassId: string;
  representativeDiagnosisId: string;
  status: "open" | "resolved";
}

interface IncidentDetail extends ReasonerIncident {
  members: Array<{
    id: string;
    passId: string;
    diagnosisId: string;
    addedAt: number;
    failureClass: string;
    rootCause: string;
    confidence: string;
  }>;
}

interface ReasonerDiagnosis {
  id: string;
  passId: string;
  failureClass: string;
  rootCauseHypothesis: string;
  evidence: string[];
  suggestedActions: string[];
  confidence: string;
}

interface Playbook {
  id: string;
  name: string;
  failureClass: string;
  description: string;
}

function failureClassColor(fc: string): string {
  if (fc === "lm_quality") return "amber";
  if (fc === "transport_timeout" || fc === "capacity_rate_limit") return "amber";
  if (fc === "infra_crash" || fc === "config_error") return "red";
  if (fc === "test_regression") return "amber";
  return "gray";
}

function confidenceColor(c: string): string {
  if (c === "high") return "green";
  if (c === "medium") return "amber";
  return "gray";
}

function relTime(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function ExpandedIncidentCard({
  incidentId,
  onResolve,
}: {
  incidentId: string;
  onResolve: () => void;
}) {
  const { data: detail } = useApi<IncidentDetail>(`/api/reasoner/incidents/${incidentId}`, 0);
  const repPassId = detail?.representativePassId ?? "";
  const { data: diag } = useApi<ReasonerDiagnosis>(
    repPassId ? `/api/reasoner/diagnoses/${repPassId}` : `/api/reasoner/diagnoses/__none__`,
    0
  );
  const { data: playbooks } = useApi<Playbook[]>("/api/reasoner/playbooks", 0);
  const [applying, setApplying] = useState(false);
  const [resolving, setResolving] = useState(false);

  const matchingPlaybook = playbooks?.find((p) => p.failureClass === detail?.failureClass);

  async function applyPlaybook() {
    if (!matchingPlaybook || !detail) return;
    setApplying(true);
    try {
      await authFetch(`/api/reasoner/playbooks/${matchingPlaybook.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId: detail.id }),
      });
    } finally {
      setApplying(false);
    }
  }

  async function resolveIncident() {
    if (!detail) return;
    setResolving(true);
    try {
      await authFetch(`/api/reasoner/incidents/${detail.id}`, { method: "POST" });
      onResolve();
    } finally {
      setResolving(false);
    }
  }

  if (!detail) return <div style={{ padding: "12px 16px", color: "var(--text-dim)", fontSize: 12 }}>loading detail…</div>;

  return (
    <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-sub)" }}>
      {diag && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--amber, #c8882a)" }}>AI hypothesis — not verified</span>
            <Pill color={confidenceColor(diag.confidence)}>{diag.confidence} confidence</Pill>
          </div>
          <div style={{ fontSize: 12, marginBottom: 6 }}>
            <strong>Root cause:</strong> {diag.rootCauseHypothesis}
          </div>
          {Array.isArray(diag.evidence) && diag.evidence.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4 }}>Evidence</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "var(--text-dim)" }}>
                {diag.evidence.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}
          {Array.isArray(diag.suggestedActions) && diag.suggestedActions.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4 }}>Suggested actions</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "var(--text-dim)" }}>
                {diag.suggestedActions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {matchingPlaybook && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Playbook: <strong>{matchingPlaybook.name}</strong></span>
          <button
            className="btn btn-sm"
            onClick={applyPlaybook}
            disabled={applying}
            style={{ fontSize: 11 }}
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Link href={`/builder?pass=${detail.representativePassId}`} className="btn btn-sm btn-ghost" style={{ fontSize: 11 }}>
          View pass →
        </Link>
        {detail.status === "open" && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={resolveIncident}
            disabled={resolving}
            style={{ fontSize: 11 }}
          >
            {resolving ? "Resolving…" : "Resolve"}
          </button>
        )}
      </div>
    </div>
  );
}

function IncidentCard({
  incident,
  onResolved,
}: {
  incident: ReasonerIncident;
  onResolved: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", marginBottom: 10 }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 16px", cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{incident.title}</span>
            <Pill color={failureClassColor(incident.failureClass)}>{incident.failureClass}</Pill>
            <Pill color={incident.status === "open" ? "red" : "green"}>{incident.status}</Pill>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
            <span>happened <strong>{incident.occurrenceCount}</strong> {incident.occurrenceCount === 1 ? "time" : "times"}</span>
            <span>first seen {fmtDate(incident.firstSeen)}</span>
            <span>last seen {relTime(incident.lastSeen)}</span>
          </div>
        </div>
        <span style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 2 }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <ExpandedIncidentCard incidentId={incident.id} onResolve={onResolved} />
      )}
    </div>
  );
}

export function IncidentsPage() {
  const [statusFilter, setStatusFilter] = useState<"open" | "resolved" | "all">("open");
  const [classFilter, setClassFilter] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const endpoint = `/api/reasoner/incidents?status=${statusFilter}&_k=${refreshKey}`;
  const { data: incidents, loading, error } = useApi<ReasonerIncident[]>(endpoint, 30_000);

  const failureClasses = Array.from(new Set((incidents ?? []).map((i) => i.failureClass))).sort();
  const filtered = classFilter ? (incidents ?? []).filter((i) => i.failureClass === classFilter) : (incidents ?? []);
  const openCount = (incidents ?? []).filter((i) => i.status === "open").length;

  if (loading && !incidents) return <div className="loading-dim">loading…</div>;
  if (error && !incidents) return <div className="loading-dim error">error: {error}</div>;

  return (
    <div className="dash-page">
      <div className="page-header" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div className="page-title">Incidents</div>
        {statusFilter !== "resolved" && openCount > 0 && (
          <span className="pill red" style={{ fontSize: 13 }}>{openCount} open</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          {(["open", "resolved", "all"] as const).map((s, i, arr) => (
            <button
              key={s}
              className={`btn btn-sm ${statusFilter === s ? "" : "btn-ghost"}`}
              style={{ borderRadius: 0, borderRight: i < arr.length - 1 ? "1px solid var(--border)" : undefined, fontSize: 11 }}
              onClick={() => { setStatusFilter(s); setRefreshKey((k) => k + 1); }}
            >
              {s}
            </button>
          ))}
        </div>

        {failureClasses.length > 1 && (
          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            style={{ fontSize: 11, padding: "4px 8px", background: "var(--bg-sub)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" }}
          >
            <option value="">all classes</option>
            {failureClasses.map((fc) => (
              <option key={fc} value={fc}>{fc}</option>
            ))}
          </select>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="loading-dim" style={{ marginTop: 40 }}>
          No incidents yet — diagnoses queue as passes fail
        </div>
      ) : (
        <div>
          {filtered.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              onResolved={() => setRefreshKey((k) => k + 1)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
