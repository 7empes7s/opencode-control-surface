import { Fragment, useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import type { DoctorDetail } from "../../server/api/types";
import { TableControls } from "../components/TableControls";
import { useTableControls, type TableSortValue } from "../hooks/useTableControls";
import { ConfirmModal } from "../components/ConfirmModal";
import { authFetch } from "../lib/authFetch";
import { Bug, ChevronDown, ChevronRight, ListChecks, PieChart as PieChartIcon, Stethoscope } from "lucide-react";
import { AnimatedNumber, Reveal, SectionHead, Stat } from "../components/v5/ui";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";

const V5_TOOLTIP_STYLE = { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 } as const;

// Mirrors server/api/actions.ts DOCTOR_REQUEUE_CLASS_MAX — display only, the
// real cap is enforced server-side regardless of this value.
const DOCTOR_REQUEUE_CLASS_DISPLAY_MAX = 10;

type JobPollRow = { status: string; error: string | null; outputTail: string };

async function fetchJob(jobId: string): Promise<JobPollRow | null> {
  const res = await authFetch(`/api/jobs/${jobId}`);
  if (!res.ok) return null;
  const body = await res.json() as { data?: { jobs?: JobPollRow[] } };
  return body.data?.jobs?.[0] ?? null;
}

// Honest, never-silent description of a finished per-entry requeue job:
// success carries the pipeline doctor's own decision (action/reason); failure
// (including the legitimate "not currently stuck" refusal) surfaces the
// pipeline's message verbatim.
function describeRequeueJob(job: JobPollRow): string {
  if (job.status === "failed") return job.error || "requeue failed";
  try {
    const parsed = JSON.parse(job.outputTail || "{}") as { action?: string; reason?: string; message?: string };
    if (parsed?.action) return `doctor decided: ${parsed.action}${parsed.reason ? ` — ${parsed.reason}` : ""}`;
    if (parsed?.message) return String(parsed.message);
  } catch { /* non-JSON output */ }
  return "requeue completed";
}

function describeClassFixJob(job: JobPollRow): string {
  if (job.status === "failed") return job.error || "fix-all-of-class failed";
  try {
    const summary = JSON.parse(job.outputTail || "{}") as {
      total?: number; acted?: number; dispatched?: number; refused?: number; failed?: number;
    };
    const parts = [`dispatched ${summary.dispatched ?? 0}`];
    if (summary.refused) parts.push(`${summary.refused} not currently stuck`);
    if (summary.failed) parts.push(`${summary.failed} failed`);
    const capped = (summary.total ?? 0) > (summary.acted ?? 0)
      ? ` (acted on ${summary.acted} of ${summary.total} — capped at ${DOCTOR_REQUEUE_CLASS_DISPLAY_MAX})`
      : "";
    return `${parts.join(", ")}${capped}`;
  } catch {
    return "fix-all-of-class completed";
  }
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  const tone = color === "green" ? "ok" : color === "amber" ? "warn" : color === "red" ? "err" : color === "blue" ? "info" : "";
  return <span className={`v5-pill${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function GradientBar({ label, count, max, title }: { label: string; count: number; max: number; title?: string }) {
  return (
    <div
      title={title}
      style={{ display: "grid", gridTemplateColumns: "minmax(90px, 1fr) 2fr auto", gap: 10, alignItems: "center" }}
    >
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <div style={{ height: 6, borderRadius: 999, background: "var(--bg-sub)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${Math.max(4, Math.round((count / Math.max(1, max)) * 100))}%`,
            borderRadius: 999,
            background: "var(--grad-accent)",
            transition: "width 0.9s var(--ease-out, ease)",
          }}
        />
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-bright)", minWidth: 18, textAlign: "right" }}>{count}</span>
    </div>
  );
}

function verdictColor(action: string): string {
  if (["requeued", "promoted", "retry", "retry_escalate", "skip_stage"].includes(action)) return "green";
  if (["kill", "dead-content", "dead_content", "abandoned"].includes(action)) return "red";
  if (["cooldown", "reroute_provider", "escalate", "waiting-quota", "waiting-gpu"].includes(action)) return "amber";
  return "gray";
}

function SortArrow({ active, dir }: { active: boolean; dir?: "asc" | "desc" }) {
  return <span className="sortable-th-arrow">{active ? (dir === "asc" ? "▲" : "▼") : "⇅"}</span>;
}

function rowSearchText(values: TableSortValue[]) {
  return values.filter((value) => value !== null && value !== undefined).join(" ");
}

type DoctorEntry = DoctorDetail["entries"][number];

interface RowRunState {
  loading: boolean;
  jobId?: string;
  status?: "running" | "success" | "failed";
  message?: string;
  error?: string;
}

function DecisionLogTable({ entries, onAfterAction }: { entries: DoctorEntry[]; onAfterAction?: () => void }) {
  type DecisionKey = "ts" | "slug" | "stage" | "errorType" | "failedModel" | "action" | "reason";
  const controls = useTableControls<DoctorEntry, DecisionKey>({
    rows: entries,
    pageSize: 25,
    rowKey: (entry) => `${entry.ts}:${entry.slug}:${entry.stage}:${entry.action}:${entry.errorType}`,
    defaultSort: { key: "ts", dir: "desc" },
    filterText: (entry) => rowSearchText([
      entry.ts,
      entry.slug,
      entry.stage,
      entry.action,
      entry.reason,
      entry.errorType,
      entry.failedModel,
      entry.nextStage,
      entry.cooldownMs,
    ]),
    sortValue: (entry, key) => entry[key],
  });

  const [confirmRow, setConfirmRow] = useState<{ key: string; entry: DoctorEntry } | null>(null);
  const [rowRuns, setRowRuns] = useState<Record<string, RowRunState>>({});
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  // Per-row poll: job-then-poll (the immediate POST response is only "started",
  // not the pipeline's actual decision) — recursive self-scheduling instead of
  // an interval so concurrent per-row requeues never step on each other.
  const pollRow = async (jobId: string, key: string): Promise<void> => {
    if (unmountedRef.current) return;
    const job = await fetchJob(jobId);
    if (job && (job.status === "success" || job.status === "failed")) {
      if (!unmountedRef.current) {
        setRowRuns((prev) => ({ ...prev, [key]: { loading: false, jobId, status: job.status as "success" | "failed", message: describeRequeueJob(job) } }));
      }
      onAfterAction?.();
      return;
    }
    if (unmountedRef.current) return;
    setTimeout(() => { void pollRow(jobId, key); }, 2_000);
  };

  const startRequeue = async (key: string, slug: string): Promise<void> => {
    setRowRuns((prev) => ({ ...prev, [key]: { loading: true } }));
    try {
      const res = await authFetch("/api/doctor/requeue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const resBody = await res.json() as { ok?: boolean; jobId?: string; message?: string; error?: string };
      if (!res.ok || !resBody.jobId) throw new Error(resBody.error ?? `HTTP ${res.status}`);
      setRowRuns((prev) => ({ ...prev, [key]: { loading: true, jobId: resBody.jobId, status: "running" } }));
      setConfirmRow(null);
      void pollRow(resBody.jobId, key);
    } catch (e) {
      setRowRuns((prev) => ({ ...prev, [key]: { loading: false, error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  return (
    <div>
      {confirmRow && (
        <ConfirmModal
          title="Requeue doctor for this story?"
          message={`Re-runs the doctor for "${confirmRow.entry.slug}". This only takes effect if the story is currently stuck in the autopipeline queue — otherwise the pipeline refuses and nothing changes.`}
          confirmLabel="Requeue"
          loading={rowRuns[confirmRow.key]?.loading}
          error={rowRuns[confirmRow.key]?.error ?? null}
          onCancel={() => setConfirmRow(null)}
          onConfirm={() => { void startRequeue(confirmRow.key, confirmRow.entry.slug); }}
        />
      )}
      <TableControls {...controls.controlsProps} searchPlaceholder="Search decision log..." />
      <div className="v5-table-wrap" style={{ marginTop: 10 }}>
      <table className="v5-table responsive">
        <thead><tr>
          <th className="expander-col" aria-label="detail" />
          <th {...controls.sortHeaderProps("ts")}>time <SortArrow active={controls.sort.key === "ts"} dir={controls.sort.dir} /></th>
          <th {...controls.sortHeaderProps("slug")}>slug <SortArrow active={controls.sort.key === "slug"} dir={controls.sort.dir} /></th>
          <th {...controls.sortHeaderProps("stage")}>stage <SortArrow active={controls.sort.key === "stage"} dir={controls.sort.dir} /></th>
          <th {...controls.sortHeaderProps("errorType")}>error <SortArrow active={controls.sort.key === "errorType"} dir={controls.sort.dir} /></th>
          <th {...controls.sortHeaderProps("failedModel")}>model <SortArrow active={controls.sort.key === "failedModel"} dir={controls.sort.dir} /></th>
          <th {...controls.sortHeaderProps("action")}>verdict <SortArrow active={controls.sort.key === "action"} dir={controls.sort.dir} /></th>
          <th {...controls.sortHeaderProps("reason")}>reason <SortArrow active={controls.sort.key === "reason"} dir={controls.sort.dir} /></th>
        </tr></thead>
        <tbody>
          {controls.rows.map((entry, index) => {
            const key = controls.getRowKey(entry, index);
            const expanded = controls.isExpanded(key);
            return (
              <Fragment key={key}>
                <tr className="data-row-clickable" onClick={() => controls.toggleExpanded(key)}>
                  <td className="expander-col" data-no-label>
                    <button className="table-expander" type="button" aria-label={`${expanded ? "Hide" : "Show"} doctor decision detail`} onClick={(event) => { event.stopPropagation(); controls.toggleExpanded(key); }}>
                      {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </button>
                  </td>
                  <td data-label="Time" className="mono dim" style={{ whiteSpace: "nowrap" }}>{entry.ts.slice(0, 19).replace("T", " ")}</td>
                  <td data-label="Slug" className="mono trunc" style={{ maxWidth: 160 }} title={entry.slug}>{entry.slug}</td>
                  <td data-label="Stage" className="mono">{entry.stage}</td>
                  <td data-label="Error" className="mono dim" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.errorType}>{entry.errorType}</td>
                  <td data-label="Model" className="mono dim trunc" style={{ maxWidth: 140 }} title={entry.failedModel}>{entry.failedModel}</td>
                  <td data-label="Verdict"><Pill color={verdictColor(entry.action)}>{entry.action}</Pill></td>
                  <td data-label="Reason" className="dim" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }} title={entry.reason}>{entry.reason}</td>
                </tr>
                {expanded && (
                  <tr className="data-row-detail">
                    <td colSpan={8} data-no-label>
                      <div className="data-row-detail-inner">
                        <div className="data-row-detail-grid">
                          <div><span>time</span><strong className="mono">{entry.ts}</strong></div>
                          <div><span>slug</span><strong className="mono">{entry.slug || "—"}</strong></div>
                          <div><span>stage</span><strong>{entry.stage || "—"}</strong></div>
                          <div><span>verdict</span><strong><Pill color={verdictColor(entry.action)}>{entry.action}</Pill></strong></div>
                          <div><span>error type</span><strong>{entry.errorType || "—"}</strong></div>
                          <div><span>failed model</span><strong className="mono">{entry.failedModel || "—"}</strong></div>
                          <div><span>next stage</span><strong>{entry.nextStage || "—"}</strong></div>
                          <div><span>cooldown</span><strong>{entry.cooldownMs ? `${Math.round(entry.cooldownMs / 1000)}s` : "—"}</strong></div>
                        </div>
                        {entry.reason && <pre className="audit-pre">{entry.reason}</pre>}
                        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <button
                            className="v5-btn ghost"
                            style={{ minHeight: 34, padding: "6px 12px", fontSize: 12 }}
                            disabled={rowRuns[key]?.loading}
                            title="Re-runs the doctor for this story only if it is still stuck in the autopipeline queue; refuses otherwise."
                            onClick={(event) => { event.stopPropagation(); setConfirmRow({ key, entry }); }}
                          >
                            {rowRuns[key]?.loading ? "Requeuing…" : "Requeue / re-run doctor"}
                          </button>
                          <span className="dim" style={{ fontSize: 11 }}>Only acts if this story is still stuck.</span>
                          {rowRuns[key]?.status === "success" && <span className="action-feedback ok">{rowRuns[key]?.message}</span>}
                          {rowRuns[key]?.status === "failed" && <span className="action-feedback err">{rowRuns[key]?.message}</span>}
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
      </div>
      {controls.filteredCount === 0 && <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 10 }}>No matching doctor decisions.</div>}
    </div>
  );
}

function DoctorLoadingState({ error }: { error?: string | null }) {
  return (
    <div className="dash-page">
      <div className="v5-pagehead">
        <div className="v5-pagehead-title">Doctor</div>
        <div className="v5-pagehead-sub">Auto-repair history & error analysis.</div>
      </div>
      {error ? (
        <div className="v5-card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>Doctor data did not load</div>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>The API returned: {error}</div>
        </div>
      ) : (
        <>
          <div className="v5-grid stats" style={{ marginBottom: 14 }}>
            {[0, 1, 2].map((i) => <div key={i} className="v5-skeleton" style={{ height: 92 }} />)}
          </div>
          <div className="v5-grid cards" style={{ marginBottom: 14 }}>
            {[0, 1, 2].map((i) => <div key={i} className="v5-skeleton" style={{ height: 150 }} />)}
          </div>
          <div className="v5-skeleton" style={{ height: 260 }} />
        </>
      )}
    </div>
  );
}

export function DoctorPage() {
  const { data, loading, error, refresh } = useApi<DoctorDetail>("/api/doctor", 15_000);
  const scan = useAction("/api/doctor/scan");
  const [filterStage, setFilterStage] = useState("");
  const [filterError, setFilterError] = useState("");
  const [filterModel, setFilterModel] = useState("");

  // Fix-all-of-class state (Deliverable 2). classFixTarget is the errorType
  // pending confirmation; classFixRun tracks the in-flight/finished batch job.
  const [classFixTarget, setClassFixTarget] = useState<string | null>(null);
  const [classFixRun, setClassFixRun] = useState<RowRunState>({ loading: false });
  const classFixUnmountedRef = useRef(false);
  useEffect(() => () => { classFixUnmountedRef.current = true; }, []);

  const pollClassFix = async (jobId: string): Promise<void> => {
    if (classFixUnmountedRef.current) return;
    const job = await fetchJob(jobId);
    if (job && (job.status === "success" || job.status === "failed")) {
      if (!classFixUnmountedRef.current) {
        setClassFixRun({ loading: false, jobId, status: job.status as "success" | "failed", message: describeClassFixJob(job) });
      }
      refresh();
      return;
    }
    if (classFixUnmountedRef.current) return;
    setTimeout(() => { void pollClassFix(jobId); }, 2_000);
  };

  const runClassFix = async (errorType: string): Promise<void> => {
    setClassFixRun({ loading: true });
    try {
      const res = await authFetch("/api/doctor/requeue-class", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ errorType }),
      });
      const resBody = await res.json() as { ok?: boolean; jobId?: string; message?: string; error?: string };
      if (!res.ok || !resBody.jobId) throw new Error(resBody.error ?? `HTTP ${res.status}`);
      setClassFixRun({ loading: false, jobId: resBody.jobId, status: "running", message: resBody.message });
      setClassFixTarget(null);
      void pollClassFix(resBody.jobId);
    } catch (e) {
      setClassFixRun({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (loading && !data) return <DoctorLoadingState />;
  if (error && !data) return <DoctorLoadingState error={error} />;
  if (!data) return <DoctorLoadingState error="No doctor data is available yet." />;

  const d = data;
  const successPct = d.stats.total > 0 ? Math.round(d.stats.successRate * 100) : null;

  const filtered = d.entries.filter((e) => {
    if (filterStage && e.stage !== filterStage) return false;
    if (filterError && e.errorType !== filterError) return false;
    if (filterModel && e.failedModel !== filterModel) return false;
    return true;
  }).slice().reverse(); // newest first

  // Unique values for filters
  const stages = [...new Set(d.entries.map((e) => e.stage).filter(Boolean))].sort();
  const errorTypes = [...new Set(d.entries.map((e) => e.errorType).filter(Boolean))].sort();
  const models = [...new Set(d.entries.map((e) => e.failedModel).filter(Boolean))].sort();

  // Client-side estimate only (for the confirm dialog's candidate count) — the
  // server re-derives the authoritative, currently-stuck candidate set at
  // dispatch time and reports the real acted-vs-total count never-silently.
  const classFixCandidateCount = filterError
    ? new Set(d.entries.filter((e) => e.errorType === filterError).map((e) => e.slug).filter(Boolean)).size
    : 0;

  return (
    <div className="dash-page">
      <div className="v5-pagehead">
        <div className="v5-pagehead-row">
          <div>
            <div className="v5-pagehead-title">Doctor</div>
            <div className="v5-pagehead-sub">Auto-repair history & error analysis.</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              className="v5-btn"
              disabled={scan.loading}
              onClick={async () => {
                const ok = await scan.run();
                if (ok) refresh();
              }}
            >
              <Stethoscope size={15} />
              {scan.loading ? "Running scan..." : "Run doctor scan"}
            </button>
          </div>
        </div>
        {(scan.success || scan.error) && (
          <div style={{ marginTop: 10, fontSize: 12 }}>
            {scan.success && <span className="action-feedback ok">{scan.success}</span>}
            {scan.error && <span className="action-feedback err">{scan.error}</span>}
          </div>
        )}
      </div>

      <Reveal delay={0.02}>
        <div className="v5-grid stats">
          <Stat label="repairs 24h" value={<AnimatedNumber value={d.stats.total} />} gradient />
          {successPct !== null && (
            <Stat
              label="success rate"
              value={<AnimatedNumber value={successPct} suffix="%" />}
              tone={successPct >= 80 ? "ok" : successPct >= 50 ? "warn" : "err"}
            />
          )}
          {d.lastDecision && (
            <div className="v5-card flat-hover v5-stat">
              <div className="v5-card-label">last decision</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", wordBreak: "break-all" }}>
                {d.lastDecision.slug}
              </div>
              <div style={{ marginTop: 4 }}><Pill color={verdictColor(d.lastDecision.action)}>{d.lastDecision.action}</Pill></div>
            </div>
          )}
        </div>
      </Reveal>

      {/* Stats charts */}
      <Reveal delay={0.06}>
        <div className="v5-grid cards" style={{ marginTop: 18 }}>
          <div className="v5-card flat-hover" id="errors">
            <div className="v5-card-label"><Bug size={13} /> error classes (24h)</div>
            {d.stats.errorClasses.length === 0 ? <div style={{ color: "var(--text-muted)", fontSize: 13 }}>None.</div> : (
              <ResponsiveContainer width="100%" height={Math.max(60, d.stats.errorClasses.length * 22)}>
                <BarChart
                  layout="vertical"
                  data={d.stats.errorClasses}
                  margin={{ top: 0, right: 30, bottom: 0, left: 0 }}
                >
                  <XAxis type="number" hide />
                  <YAxis
                    type="category" dataKey="type" width={130}
                    tick={{ fontFamily: "var(--mono)", fontSize: 10, fill: "var(--text-muted)" }}
                    axisLine={false} tickLine={false}
                  />
                  <Tooltip
                    contentStyle={V5_TOOLTIP_STYLE}
                    itemStyle={{ color: "var(--red)" }}
                    formatter={(v: number) => [v, "events"]}
                  />
                  <Bar dataKey="count" fill="var(--red)" opacity={0.75} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="v5-card flat-hover" id="models">
            <div className="v5-card-label">top failing models</div>
            {d.stats.topFailingModels.length === 0 ? <div style={{ color: "var(--text-muted)", fontSize: 13 }}>None.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {d.stats.topFailingModels.map((m) => (
                  <GradientBar
                    key={m.model}
                    label={m.model}
                    title={m.model}
                    count={m.count}
                    max={Math.max(...d.stats.topFailingModels.map((x) => x.count))}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="v5-card flat-hover" id="verdicts">
            <div className="v5-card-label"><PieChartIcon size={13} /> verdict mix</div>
            {d.stats.verdictMix.length === 0 ? <div style={{ color: "var(--text-muted)", fontSize: 13 }}>None.</div> : (() => {
              const COLORS: Record<string, string> = {
                retry: "var(--green)", requeued: "var(--green)",
                "dead-content": "var(--red)", kill: "var(--red)",
                cooldown: "var(--amber-warn)", no_action: "var(--text-muted)",
              };
              return (
                <ResponsiveContainer width="100%" height={140}>
                  <PieChart>
                    <Pie
                      data={d.stats.verdictMix} dataKey="count" nameKey="action"
                      cx="50%" cy="50%" outerRadius={52} innerRadius={26}
                    >
                      {d.stats.verdictMix.map((v) => (
                        <Cell key={v.action} fill={COLORS[v.action] ?? "var(--text-muted)"} opacity={0.85} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={V5_TOOLTIP_STYLE} />
                    <Legend
                      iconType="circle" iconSize={7}
                      formatter={(value: string) => <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              );
            })()}
          </div>
        </div>
      </Reveal>

      {/* Full log */}
      {classFixTarget && (
        <ConfirmModal
          title="Fix all of class?"
          message={`Re-dispatches up to ${DOCTOR_REQUEUE_CLASS_DISPLAY_MAX} of the ${classFixCandidateCount} distinct "${classFixTarget}" stories in the current decision log to the doctor. Only stories still stuck in the autopipeline actually requeue — others are refused, never silently skipped, and the outcome breakdown is reported after the run.`}
          confirmLabel="Fix all of class"
          loading={classFixRun.loading}
          error={classFixRun.error ?? null}
          onCancel={() => setClassFixTarget(null)}
          onConfirm={() => { void runClassFix(classFixTarget); }}
        />
      )}
      <Reveal delay={0.1}>
        <div className="v5-section">
          <SectionHead
            title="Decision log"
            icon={<ListChecks size={16} />}
          />
          <div className="v5-card flat-hover">
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)" }}>{d.entries.length} entries</span>
            </div>
            <div style={{ paddingBottom: 12, marginBottom: 12, borderBottom: "1px solid var(--border)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={filterStage} onChange={(e) => setFilterStage(e.target.value)}
            style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "3px 8px", borderRadius: 3 }}>
            <option value="">all stages</option>
            {stages.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterError} onChange={(e) => { setFilterError(e.target.value); setClassFixRun({ loading: false }); }}
            style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "3px 8px", borderRadius: 3 }}>
            <option value="">all errors</option>
            {errorTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)}
            style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "3px 8px", borderRadius: 3 }}>
            <option value="">all models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {(filterStage || filterError || filterModel) && (
            <button onClick={() => { setFilterStage(""); setFilterError(""); setFilterModel(""); }}
              style={{ fontFamily: "var(--mono)", fontSize: 11, background: "none", border: "1px solid var(--border)", color: "var(--text-dim)", padding: "3px 8px", borderRadius: 3, cursor: "pointer" }}>
              clear
            </button>
          )}
          {filterError && (
            <button
              className="v5-btn ghost"
              style={{ minHeight: 34, padding: "6px 12px", fontSize: 12 }}
              disabled={classFixRun.loading}
              title={`Re-dispatch up to ${DOCTOR_REQUEUE_CLASS_DISPLAY_MAX} stuck "${filterError}" stories to the doctor.`}
              onClick={() => setClassFixTarget(filterError)}
            >
              Fix all of class ({classFixCandidateCount})
            </button>
          )}
          {classFixRun.status === "success" && <span className="action-feedback ok">{classFixRun.message}</span>}
          {classFixRun.status === "failed" && <span className="action-feedback err">{classFixRun.message}</span>}
            </div>
        <DecisionLogTable entries={filtered} onAfterAction={refresh} />
          </div>
        </div>
      </Reveal>
    </div>
  );
}
