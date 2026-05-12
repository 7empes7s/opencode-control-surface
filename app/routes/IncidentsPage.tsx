import { useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import type { ActionDescriptor, EvidenceRef, IncidentsDetail } from "../../server/api/types";
import { AnimatedNumber, IncidentHeatmap } from "../components/AnimatedCharts";

type IncidentEntry = IncidentsDetail["entries"][number];

interface ActionCatalogData {
  actions: ActionDescriptor[];
  degraded: boolean;
  sources: Record<string, "ok" | "error">;
}

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

function riskColor(risk: ActionDescriptor["risk"]): string {
  if (risk === "high" || risk === "destructive") return "red";
  if (risk === "medium") return "amber";
  return "green";
}

function incidentTargetId(e: IncidentEntry): string {
  return `${e.type}:${e.slug}:${e.stage}:${e.errorType}`;
}

function uniqEvidence(actions: ActionDescriptor[], selected: IncidentEntry | null): EvidenceRef[] {
  const refs = actions.flatMap((action) => action.evidenceRefs);
  if (refs.length === 0 && selected) {
    return [
      {
        label: selected.type === "doctor-abandoned" ? "Doctor log" : "Pipeline alerts",
        kind: "file",
        ref: selected.type === "doctor-abandoned" ? "/var/lib/mimule/doctor-log.jsonl" : "/var/lib/mimule/pipeline-alerts.json",
      },
      { label: "Incidents detail", kind: "api", ref: "/api/incidents" },
    ];
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.label}:${ref.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function IncidentTimeline({ entries }: { entries: IncidentsDetail["entries"] }) {
  const buckets = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries) {
      const d = new Date(e.ts);
      const day = d.toISOString().slice(0, 10);
      const hour = d.getUTCHours();
      const key = `${day}:${hour}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([k, count]) => {
      const [day, hour] = k.split(":");
      return { day, hour: Number(hour), count };
    });
  }, [entries]);

  return (
    <div className="section-card" style={{ marginBottom: 16 }}>
      <div className="section-card-header"><span className="title">7-day error heatmap</span></div>
      <div className="section-card-body" style={{ padding: "10px 14px" }}>
        <IncidentHeatmap buckets={buckets} />
      </div>
    </div>
  );
}

export function IncidentsPage() {
  const { data, loading, error } = useApi<IncidentsDetail>("/api/incidents", 30_000);
  const { data: catalog } = useApi<ActionCatalogData>("/api/actions/catalog?targetType=incident", 60_000);
  const [filterType, setFilterType] = useState("");
  const [filterError, setFilterError] = useState("");
  const [filterStage, setFilterStage] = useState("");
  const [selected, setSelected] = useState<IncidentEntry | null>(null);
  const window24h = 24 * 60 * 60 * 1000;

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;

  const filtered = d.entries.filter((e) => {
    if (filterType && e.type !== filterType) return false;
    if (filterError && e.errorType !== filterError) return false;
    if (filterStage && e.stage !== filterStage) return false;
    return true;
  });
  const selectedActions = selected
    ? (catalog?.actions ?? []).filter((action) => action.targetId === incidentTargetId(selected))
    : [];
  const selectedEvidence = uniqEvidence(selectedActions, selected);

  return (
    <div className="dash-page">
      {selected && (
        <div className="evidence-drawer-overlay" onClick={() => setSelected(null)}>
          <aside className="evidence-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="evidence-drawer-head">
              <div>
                <div className="evidence-drawer-kicker">incident evidence</div>
                <div className="evidence-drawer-title">{selected.slug || "unknown story"}</div>
              </div>
              <button className="drawer-close" onClick={() => setSelected(null)} aria-label="Close evidence drawer">×</button>
            </div>

            <div className="evidence-drawer-summary">
              <Pill color={selected.type === "doctor-abandoned" ? "red" : "amber"}>
                {selected.type === "doctor-abandoned" ? "abandoned" : "failed"}
              </Pill>
              <Pill color="gray">{selected.stage || "unknown stage"}</Pill>
              <Pill color={errorColor(selected.errorType)}>{selected.errorType}</Pill>
              <span className="mono dim" title={fmtTs(selected.ts)}>{relTime(selected.ts)}</span>
            </div>

            <div className="evidence-block">
              <div className="evidence-block-title">Actions</div>
              {selectedActions.length === 0 ? (
                <div className="evidence-empty">
                  No catalog actions matched this incident yet. Evidence is still shown below for inspection.
                </div>
              ) : (
                <div className="evidence-action-list">
                  {selectedActions.map((action) => (
                    <div key={action.id} className={`evidence-action ${action.disabled ? "disabled" : ""}`}>
                      <div className="evidence-action-main">
                        <div className="evidence-action-label">{action.label}</div>
                        <div className="evidence-action-meta">
                          <Pill color={riskColor(action.risk)}>{action.risk}</Pill>
                          {action.reasonRequired && <Pill color="gray">reason</Pill>}
                          {action.confirm && <Pill color="gray">confirm</Pill>}
                        </div>
                      </div>
                      {action.impactPreview && <div className="evidence-copy">{action.impactPreview}</div>}
                      {action.rollbackHint && <div className="evidence-muted">Rollback: {action.rollbackHint}</div>}
                      {action.disabled && action.disabledReason && (
                        <div className="evidence-disabled">{action.disabledReason}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="evidence-block">
              <div className="evidence-block-title">Evidence</div>
              <div className="evidence-ref-list">
                {selectedEvidence.map((ref) => (
                  <div key={`${ref.kind}:${ref.label}:${ref.ref}`} className="evidence-ref">
                    <span className="pill gray">{ref.kind}</span>
                    <div>
                      <div className="evidence-ref-label">{ref.label}</div>
                      <div className="evidence-ref-path">{ref.ref}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}

      <div className="page-header">
        <div className="page-title">Incidents</div>
        <div className="stat-row">
          <div className="stat-item">
            <div className="stat-val"><AnimatedNumber value={d.stats.total} /></div>
            <div className="stat-lbl">total</div>
          </div>
          <div className="stat-item">
            <div className="stat-val"><AnimatedNumber value={d.stats.last24h} /></div>
            <div className="stat-lbl">last 24h</div>
          </div>
        </div>
      </div>

      {d.entries.length > 0 && <IncidentTimeline entries={d.entries} />}

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
                <th>when</th><th>type</th><th>slug</th><th>stage</th><th>error</th><th></th>
              </tr></thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr
                    key={`${e.type}:${e.ts}:${e.slug}:${e.stage}:${e.errorType}:${i}`}
                    style={{ opacity: Date.now() - e.ts > window24h ? 0.6 : 1 }}
                  >
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
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setSelected(e)}>
                        evidence
                      </button>
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
