import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { useAction } from "../hooks/useAction";
import { SectionCard } from "../components/SectionCard";
import { TableControls } from "../components/TableControls";
import { AnimatedNumber, Reveal, Stat } from "../components/v5/ui";
import { useTableControls } from "../hooks/useTableControls";
import type { JobRow } from "../../server/db/writer";

interface JobsData {
  jobs: JobRow[];
  degraded: boolean;
  reason?: string;
}

const V5_TONE: Record<string, string> = { green: "ok", amber: "warn", red: "err", blue: "info", gray: "" };

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  const tone = V5_TONE[color] ?? "";
  return <span className={`v5-pill${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function statusColor(status: string): string {
  if (status === "success" || status === "succeeded" || status === "completed") return "green";
  if (status === "running" || status === "pending") return "blue";
  if (status === "failed" || status === "error") return "red";
  return "amber";
}

function fmtTs(ts: number | null): string {
  if (!ts) return "-";
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function fmtDuration(startedAt: number | null, finishedAt: number | null): string {
  if (!startedAt) return "-";
  const end = finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export type JobsSortKey = "startedAt" | "status" | "kind" | "targetId" | "finishedAt";

function JobActions({ job, onDone }: { job: JobRow; onDone: () => void }) {
  const cancel = useAction(`/api/jobs/${job.id}/cancel`);
  const retry = useAction(`/api/jobs/${job.id}/retry`);

  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
      {job.status === "running" && (
        <button
          type="button"
          className="v5-btn"
          style={{ color: "var(--red)", borderColor: "oklch(72% 0.19 25 / 0.35)" }}
          disabled={cancel.loading}
          onClick={() => cancel.run({}).then((ok) => { if (ok) onDone(); })}
        >
          {cancel.loading ? "canceling…" : "Cancel"}
        </button>
      )}
      {(job.status === "failed" || job.status === "canceled") && job.retryCount < job.maxRetries && (
        <button
          type="button"
          className="v5-btn"
          disabled={retry.loading}
          onClick={() => retry.run({}).then((ok) => { if (ok) onDone(); })}
        >
          {retry.loading ? "retrying…" : `Retry (${job.retryCount}/${job.maxRetries})`}
        </button>
      )}
      {cancel.error && <span style={{ fontSize: 12, color: "var(--red)" }}>{cancel.error}</span>}
      {retry.error && <span style={{ fontSize: 12, color: "var(--red)" }}>{retry.error}</span>}
    </div>
  );
}

export function JobsPage() {
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [selected, setSelected] = useState<JobRow | null>(null);
  const query = new URLSearchParams({ limit: "100" });
  if (status) query.set("status", status);
  if (kind) query.set("kind", kind);
  const { data, loading, error, refresh } = useAuthenticatedApi<JobsData>(`/api/jobs?${query.toString()}`, 20_000);

  const jobs = data?.jobs ?? [];
  const kinds = useMemo(() => Array.from(new Set(jobs.map((job) => job.kind))).sort(), [jobs]);
  const counts = useMemo(() => ({
    running: jobs.filter((job) => job.status === "running").length,
    success: jobs.filter((job) => String(job.status) === "success" || String(job.status) === "succeeded" || String(job.status) === "completed").length,
    failed: jobs.filter((job) => String(job.status) === "failed" || String(job.status) === "error").length,
  }), [jobs]);

  const jobsCtrl = useTableControls<JobRow, JobsSortKey>({
    rows: jobs,
    pageSize: 25,
    filterText: (row) => [row.kind, row.status, row.targetId ?? "", row.actor ?? "", row.targetType ?? ""].join(" "),
    sortValue: (row, key) => {
      switch (key) {
        case "startedAt": return row.startedAt ?? 0;
        case "status": return row.status ?? "";
        case "kind": return row.kind ?? "";
        case "targetId": return row.targetId ?? "";
        case "finishedAt": return row.finishedAt ?? 0;
        default: return "";
      }
    },
    defaultSort: { key: "startedAt", dir: "desc" },
  });

  if (loading && !data) {
    return (
      <div className="dash-page">
        <div className="v5-skeleton" style={{ height: 30, width: 160, marginBottom: 16 }} />
        <div className="v5-grid stats" style={{ marginBottom: 14 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="v5-skeleton" style={{ height: 96 }} />)}
        </div>
        <div className="v5-skeleton" style={{ height: 300 }} />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="dash-page">
        <div className="v5-card flat-hover" style={{ fontSize: 13, color: "var(--red)" }}>Jobs did not load: {error}</div>
      </div>
    );
  }

  return (
    <div className="dash-page">
      {selected && (
        <div className="evidence-drawer-overlay" onClick={() => setSelected(null)}>
          <aside className="evidence-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="evidence-drawer-head">
              <div>
                <div className="evidence-drawer-kicker">job</div>
                <div className="evidence-drawer-title">{selected.id}</div>
              </div>
              <button className="drawer-close" onClick={() => setSelected(null)} aria-label="Close job drawer">×</button>
            </div>

            <div className="evidence-drawer-summary">
              <Pill color={statusColor(selected.status)}>{selected.status}</Pill>
              <Pill color="gray">{selected.kind}</Pill>
              {selected.targetType && <Pill color="gray">{selected.targetType}</Pill>}
            </div>

            <div className="audit-detail-grid">
              <div><span>started</span><strong>{fmtTs(selected.startedAt)}</strong></div>
              <div><span>finished</span><strong>{fmtTs(selected.finishedAt)}</strong></div>
              <div><span>duration</span><strong>{fmtDuration(selected.startedAt, selected.finishedAt)}</strong></div>
              <div><span>actor</span><strong>{selected.actor ?? "-"}</strong></div>
              <div><span>target</span><strong>{selected.targetId ?? "-"}</strong></div>
              <div><span>exit</span><strong>{selected.exitCode ?? "-"}</strong></div>
            </div>

            {selected.reason && (
              <div className="evidence-block">
                <div className="evidence-block-title">Reason</div>
                <div className="audit-pre">{selected.reason}</div>
              </div>
            )}
            {selected.command && (
              <div className="evidence-block">
                <div className="evidence-block-title">Command</div>
                <div className="audit-pre">{selected.command}</div>
              </div>
            )}
            {selected.error && (
              <div className="evidence-block">
                <div className="evidence-block-title">Error</div>
                <div className="audit-pre error">{selected.error}</div>
              </div>
            )}
            {selected.outputTail && (
              <div className="evidence-block">
                <div className="evidence-block-title">Output</div>
                <pre className="audit-pre">{selected.outputTail}</pre>
              </div>
            )}
            {stringify(selected.request) && (
              <div className="evidence-block">
                <div className="evidence-block-title">Request</div>
                <pre className="audit-pre">{stringify(selected.request)}</pre>
              </div>
            )}
            {stringify(selected.evidence) && (
              <div className="evidence-block">
                <div className="evidence-block-title">Evidence</div>
                <pre className="audit-pre">{stringify(selected.evidence)}</pre>
              </div>
            )}

            <div className="evidence-block">
              <div className="evidence-block-title">Actions</div>
              <JobActions job={selected} onDone={() => { setSelected(null); refresh(); }} />
            </div>
          </aside>
        </div>
      )}

      <Reveal>
        <header className="v5-pagehead">
          <div className="v5-pagehead-row">
            <div>
              <div className="v5-pagehead-title">Jobs</div>
              <p className="v5-pagehead-sub">Background job execution — starts, finishes, durations, and retry/cancel controls.</p>
            </div>
            <button type="button" className="v5-btn" onClick={refresh} disabled={loading}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </header>
      </Reveal>

      <Reveal delay={0.04}>
        <div className="v5-grid stats">
          <Stat label="Loaded" value={<AnimatedNumber value={jobs.length} />} />
          <Stat label="Running" value={<AnimatedNumber value={counts.running} />} />
          <Stat label="Success" value={<AnimatedNumber value={counts.success} />} tone="ok" />
          <Stat label="Failed" value={<AnimatedNumber value={counts.failed} />} tone={counts.failed > 0 ? "err" : "idle"} />
        </div>
      </Reveal>

      {data?.degraded && (
        <div className="v5-card flat-hover" style={{ marginTop: 14, fontSize: 13, color: "var(--amber-warn)" }}>degraded: {data.reason}</div>
      )}

      <Reveal delay={0.08}>
        <div className="v5-card flat-hover" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <span className="v5-card-label" style={{ marginRight: 2 }}>Filters</span>
          <select className="audit-select" defaultValue="" onChange={(event) => setStatus(event.target.value)} style={{ minHeight: 40 }}>
            <option value="">all statuses</option>
            <option value="running">running</option>
            <option value="success">success</option>
            <option value="failed">failed</option>
          </select>
          <select className="audit-select" defaultValue="" onChange={(event) => setKind(event.target.value)} style={{ minHeight: 40 }}>
            <option value="">all kinds</option>
            {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
      </Reveal>

      <Reveal delay={0.12}>
        <div className="v5-section">
          <SectionCard
            title="recent jobs"
            defaultOpen={true}
            right={<span className="mono dim">{jobsCtrl.filteredCount} of {jobs.length} shown</span>}
          >
            <div className="section-card-body">
              {jobs.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No jobs have run yet.</p>
              ) : (
                <>
                <div className="v5-card flat-hover" style={{ padding: "8px 12px", marginBottom: 12 }}>
                  <TableControls {...jobsCtrl.controlsProps} searchPlaceholder="Filter jobs..." />
                </div>
                <div className="v5-table-wrap">
                  <table className="v5-table responsive jobs-table">
                    <thead><tr><th {...jobsCtrl.sortHeaderProps("startedAt")} className="job-date-col">started <span className="sortable-th-arrow">{jobsCtrl.sort.key === "startedAt" ? (jobsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th><th {...jobsCtrl.sortHeaderProps("status")}>status <span className="sortable-th-arrow">{jobsCtrl.sort.key === "status" ? (jobsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th><th {...jobsCtrl.sortHeaderProps("kind")}>kind <span className="sortable-th-arrow">{jobsCtrl.sort.key === "kind" ? (jobsCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th><th>target</th><th className="job-dur-col">duration</th><th className="job-actor-col">actor</th><th></th></tr></thead>
                    <tbody>
                      {jobsCtrl.rows.map((job) => (
                        <tr key={job.id}>
                          <td data-label="Started" className="mono dim job-date-col">{fmtTs(job.startedAt)}</td>
                          <td data-label="Status"><Pill color={statusColor(job.status)}>{job.status}</Pill></td>
                          <td data-label="Kind" className="mono">{job.kind}</td>
                          <td data-label="Target" className="mono trunc">{job.targetId ?? job.targetType ?? "-"}</td>
                          <td data-label="Duration" className="mono dim job-dur-col">{fmtDuration(job.startedAt, job.finishedAt)}</td>
                          <td data-label="Actor" className="mono dim job-actor-col">{job.actor ?? "-"}</td>
                          <td data-no-label style={{ textAlign: "right" }}>
                            <button type="button" className="v5-btn ghost" onClick={() => setSelected(job)}>details</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </>
              )}
            </div>
          </SectionCard>
        </div>
      </Reveal>
    </div>
  );
}
