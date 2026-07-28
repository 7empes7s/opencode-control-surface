import { useState } from "react";
import { useLocation } from "wouter";
import { useApi, fmtMs } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { ConfirmModal } from "../components/ConfirmModal";
import type { AutopipelineDetail } from "../../server/api/types";
import { AnimatedNumber, Reveal, SectionHead, Stat } from "../components/v5/ui";
import { Activity, Gauge, ListChecks, ListOrdered, Zap } from "lucide-react";

function V5Pill({ children, tone }: { children: React.ReactNode; tone?: "ok" | "warn" | "err" | "info" }) {
  return <span className={`v5-pill${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function StageDurationTable({ durations }: { durations: AutopipelineDetail["stageDurations"] }) {
  const relevant = durations.filter((d) => d.sampleCount > 0);
  if (relevant.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No timing samples yet.</div>;
  }
  return (
    <div className="v5-table-wrap">
      <table className="v5-table responsive">
        <thead><tr>
          <th>Stage</th><th>p50</th><th>p95</th><th>Samples</th>
        </tr></thead>
        <tbody>
          {relevant.map((d) => (
            <tr key={d.stage}>
              <td data-label="Stage" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{d.stage}</td>
              <td data-label="p50" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{fmtMs(d.p50Ms)}</td>
              <td data-label="p95" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{fmtMs(d.p95Ms)}</td>
              <td data-label="Samples" style={{ color: "var(--text-dim)" }}>{d.sampleCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StageBars({ breakdown }: { breakdown: Record<string, number> }) {
  const stageOrder = ["scout", "research", "validate-research", "write", "validate-write", "verify", "publish-prep", "init", "fetch-image", "publish"];
  const approvalStages = new Set(["publish"]);
  const rows = stageOrder
    .filter((s) => breakdown[s] != null)
    .map((s) => ({ stage: s, count: breakdown[s] }));
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((r) => (
        <div
          key={r.stage}
          style={{ display: "grid", gridTemplateColumns: "minmax(96px, 140px) 1fr auto", gap: 10, alignItems: "center" }}
        >
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.stage}
          </span>
          <div style={{ height: 6, borderRadius: 999, background: "var(--bg-sub)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.max(4, Math.round((r.count / max) * 100))}%`,
                borderRadius: 999,
                background: approvalStages.has(r.stage) ? "var(--amber-warn)" : "var(--grad-accent)",
                transition: "width 0.9s var(--ease-out, ease)",
              }}
            />
          </div>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-bright)", minWidth: 18, textAlign: "right" }}>
            {r.count}
          </span>
        </div>
      ))}
    </div>
  );
}

type Modal =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "inject" }
  | { type: "rush"; id: string; slug?: string }
  | { type: "kill"; id: string; slug?: string }
  | { type: "publish"; id: string; slug?: string };

function PageSkeleton() {
  return (
    <div className="dash-page">
      <div className="v5-pagehead">
        <div className="v5-pagehead-title">Pipeline</div>
        <div className="v5-pagehead-sub">Editorial queue, stages, throughput.</div>
      </div>
      <div className="v5-grid stats">
        {[0, 1, 2].map((i) => <div key={i} className="v5-skeleton" style={{ height: 92 }} />)}
      </div>
      <div className="v5-section"><div className="v5-skeleton" style={{ height: 240 }} /></div>
    </div>
  );
}

export function AutopipelinePage() {
  const { data, loading, error, refresh } = useApi<AutopipelineDetail>("/api/autopipeline", 10_000);
  const [modal, setModal] = useState<Modal | null>(null);
  const [showFullQueue, setShowFullQueue] = useState(false);
  const [showFullApprovals, setShowFullApprovals] = useState(false);
  const [showFullDurations, setShowFullDurations] = useState(false);
  const cmd = useAction("/api/autopipeline/command");
  const [, navigate] = useLocation();

  if (loading && !data) return <PageSkeleton />;
  if (error && !data) {
    return (
      <div className="dash-page">
        <div className="v5-pagehead">
          <div className="v5-pagehead-title">Pipeline</div>
          <div className="v5-pagehead-sub">Editorial queue, stages, throughput.</div>
        </div>
        <div className="v5-card" style={{ color: "var(--red)", fontSize: 13 }}>Pipeline data did not load: {error}</div>
      </div>
    );
  }
  if (!data) return null;

  const d = data;
  const MAX_ROWS_WITH_HEADER = 8;
  const MAX_BODY_ROWS = MAX_ROWS_WITH_HEADER - 1;
  const approvals = d.queue.filter((i) => i.waitingApproval);
  const queueRows = showFullQueue ? d.queue : d.queue.slice(0, MAX_BODY_ROWS);
  const approvalRows = showFullApprovals ? approvals : approvals.slice(0, MAX_BODY_ROWS);
  const durationRows = d.stageDurations.filter((row) => row.sampleCount > 0);
  const durationRowsVisible = showFullDurations ? durationRows : durationRows.slice(0, MAX_BODY_ROWS);

  return (
    <div className="dash-page">
      <div className="v5-pagehead">
        <div className="v5-pagehead-row">
          <div>
            <div className="v5-pagehead-title">Pipeline</div>
            <div className="v5-pagehead-sub">Editorial queue, stages, throughput.</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              className={`v5-btn${d.paused ? " primary" : ""}`}
              onClick={() => setModal(d.paused ? { type: "resume" } : { type: "pause" })}
            >
              {d.paused ? "Resume" : "Pause"}
            </button>
            <button className="v5-btn ghost" onClick={() => setModal({ type: "inject" })}>
              + Inject topic
            </button>
          </div>
        </div>
        {(cmd.success || cmd.error) && (
          <div style={{ marginTop: 10, fontSize: 12 }}>
            {cmd.success && <span className="action-feedback ok">{cmd.success}</span>}
            {cmd.error && <span className="action-feedback err">{cmd.error}</span>}
          </div>
        )}
      </div>

      <Reveal delay={0.02}>
        <div className="v5-grid stats">
          <Stat label="queued" value={<AnimatedNumber value={d.stats.queueDepth} />} gradient tone="idle" />
          <Stat
            label="waiting approval"
            value={<AnimatedNumber value={d.stats.approvalsWaiting} />}
            tone={d.stats.approvalsWaiting > 0 ? "warn" : "ok"}
            caption={d.stats.approvalsWaiting > 0 ? "needs an operator" : "nothing blocked"}
          />
          <Stat
            label="pipeline"
            value={d.paused ? "Paused" : "Running"}
            tone={d.paused ? "warn" : "ok"}
            caption={d.pauseReason ?? (d.paused ? undefined : "processing stories")}
          />
        </div>
      </Reveal>

      {modal && (
        <ConfirmModal
          title={
            modal.type === "pause" ? "Pause autopipeline?" :
            modal.type === "resume" ? "Resume autopipeline?" :
            modal.type === "inject" ? "Inject topic" :
            modal.type === "rush" ? `Rush story` :
            modal.type === "kill" ? `Kill story` :
            "Publish story"
          }
          message={
            modal.type === "pause" ? "The pipeline will stop processing new stories after the current stage completes." :
            modal.type === "resume" ? "The pipeline will resume processing stories from the queue." :
            modal.type === "rush" ? `Raise priority for: ${modal.slug ?? modal.id}` :
            modal.type === "kill" ? `Remove from queue: ${modal.slug ?? modal.id}` :
            modal.type === "publish" ? `Publish immediately: ${modal.slug ?? modal.id}` :
            undefined
          }
          inputLabel={modal.type === "inject" ? "topic" : undefined}
          inputPlaceholder="e.g. UK inflation March 2026"
          confirmLabel={
            modal.type === "pause" ? "Pause" :
            modal.type === "resume" ? "Resume" :
            modal.type === "inject" ? "Inject" :
            modal.type === "rush" ? "Rush" :
            modal.type === "kill" ? "Kill" :
            "Publish"
          }
          danger={modal.type === "kill"}
          loading={cmd.loading}
          error={cmd.error}
          onCancel={() => { setModal(null); cmd.reset(); }}
          onConfirm={async (val) => {
            let body: unknown;
            if (modal.type === "pause") body = { cmd: "pause" };
            else if (modal.type === "resume") body = { cmd: "resume" };
            else if (modal.type === "inject") body = { cmd: "add", topic: val, vertical: "ai" };
            else if (modal.type === "rush") body = { cmd: "rush", slug: modal.slug ?? modal.id };
            else if (modal.type === "kill") body = { cmd: "kill", slug: modal.slug ?? modal.id };
            else if (modal.type === "publish") body = { cmd: "publish", slug: modal.slug ?? modal.id };
            const ok = await cmd.run(body);
            if (ok) { setModal(null); refresh(); }
          }}
        />
      )}

      {/* Current story */}
      {d.current && (
        <Reveal delay={0.06}>
          <div className="v5-section" id="current">
            <SectionHead title="Current story" icon={<Zap size={16} />} />
            <div className="v5-card">
              <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-bright)", marginBottom: 8, wordBreak: "break-all" }}>
                {d.current.slug ?? d.current.id}
              </div>
              <V5Pill tone="warn">{d.current.stage}</V5Pill>
            </div>
          </div>
        </Reveal>
      )}

      {/* Queue */}
      <Reveal delay={0.1}>
        <div className="v5-section" id="queue">
          <SectionHead title="Queue" icon={<ListOrdered size={16} />} />
          <div className="v5-card flat-hover">
            {Object.keys(d.stats.stageBreakdown).length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
                {Object.entries(d.stats.stageBreakdown).map(([stage, count]) => (
                  <V5Pill key={stage}>{stage} {count}</V5Pill>
                ))}
              </div>
            )}
            {d.queue.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Queue is empty.</div>
            ) : (
              <div className="v5-table-wrap">
                <table className="v5-table responsive">
                  <thead><tr>
                    <th>Slug / id</th><th>Stage</th><th>Actions</th><th>Priority</th><th>Elapsed</th><th>Flags</th>
                  </tr></thead>
                  <tbody>
                    {queueRows.map((item) => (
                      <tr key={item.id}>
                        <td data-label="Slug / id" style={{ fontFamily: "var(--mono)", fontSize: 12, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.slug ?? item.id}</td>
                        <td data-label="Stage" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{item.stage}</td>
                        <td data-label="Actions">
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            <button className="v5-btn ghost" style={{ minHeight: 32, padding: "5px 10px", fontSize: 12 }} onClick={() => {
                              if (!item.dossierDate || !item.dossierSlug) return;
                              navigate(`/autopipeline/dossier/${item.dossierDate}/${item.dossierSlug}`);
                            }} disabled={!item.dossierDate || !item.dossierSlug}>inspect</button>
                            {item.stage === "publish" && item.waitingApproval && (
                              <button className="v5-btn primary" style={{ minHeight: 32, padding: "5px 10px", fontSize: 12 }} onClick={() => setModal({ type: "publish", id: item.id, slug: item.slug })}>publish</button>
                            )}
                            {!item.running && (
                              <button className="v5-btn ghost" style={{ minHeight: 32, padding: "5px 10px", fontSize: 12 }} onClick={() => setModal({ type: "rush", id: item.id, slug: item.slug })}>rush</button>
                            )}
                            <button
                              className="v5-btn ghost"
                              style={{ minHeight: 32, padding: "5px 10px", fontSize: 12, color: "var(--red)" }}
                              onClick={() => setModal({ type: "kill", id: item.id, slug: item.slug })}
                            >kill</button>
                          </div>
                        </td>
                        <td data-label="Priority" style={{ color: "var(--text-dim)" }}>{item.priority}</td>
                        <td data-label="Elapsed" style={{ color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>{item.elapsedMs != null ? fmtMs(item.elapsedMs) : "—"}</td>
                        <td data-label="Flags">
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {item.running && <V5Pill tone="warn">running</V5Pill>}
                            {item.waitingApproval && <V5Pill tone="err">approval</V5Pill>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.queue.length > MAX_BODY_ROWS && (
              <div style={{ marginTop: 12 }}>
                <button className="v5-btn ghost" style={{ minHeight: 34, padding: "6px 12px", fontSize: 12 }} onClick={() => setShowFullQueue((v) => !v)}>
                  {showFullQueue ? "Show less" : `Show all (${d.queue.length})`}
                </button>
              </div>
            )}
          </div>
        </div>
      </Reveal>

      {/* Approvals */}
      {d.stats.approvalsWaiting > 0 && (
        <Reveal delay={0.14}>
          <div className="v5-section" id="approvals">
            <SectionHead title="Approvals waiting" icon={<ListChecks size={16} />} />
            <div className="v5-card flat-hover">
              <div className="v5-table-wrap">
                <table className="v5-table responsive">
                  <thead><tr><th>Slug / id</th><th>Stage</th><th>Age</th></tr></thead>
                  <tbody>
                    {approvalRows.map((item) => (
                      <tr key={item.id}>
                        <td data-label="Slug / id" style={{ fontFamily: "var(--mono)", fontSize: 12, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.slug ?? item.id}</td>
                        <td data-label="Stage" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{item.stage}</td>
                        <td data-label="Age" style={{ color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>{item.elapsedMs != null ? fmtMs(item.elapsedMs) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {approvals.length > MAX_BODY_ROWS && (
                <div style={{ marginTop: 12 }}>
                  <button className="v5-btn ghost" style={{ minHeight: 34, padding: "6px 12px", fontSize: 12 }} onClick={() => setShowFullApprovals((v) => !v)}>
                    {showFullApprovals ? "Show less" : `Show all (${approvals.length})`}
                  </button>
                </div>
              )}
            </div>
          </div>
        </Reveal>
      )}

      {/* Queue by stage */}
      {Object.keys(d.stats.stageBreakdown).length > 0 && (
        <Reveal delay={0.18}>
          <div className="v5-section" id="stages">
            <SectionHead title="Queue by stage" icon={<Activity size={16} />} />
            <div className="v5-card flat-hover">
              <StageBars breakdown={d.stats.stageBreakdown} />
            </div>
          </div>
        </Reveal>
      )}

      {/* Stage durations */}
      <Reveal delay={0.22}>
        <div className="v5-section" id="throughput">
          <SectionHead title="Stage durations" icon={<Gauge size={16} />} />
          <div className="v5-card flat-hover">
            <StageDurationTable durations={durationRowsVisible} />
            {durationRows.length > MAX_BODY_ROWS && (
              <div style={{ marginTop: 12 }}>
                <button className="v5-btn ghost" style={{ minHeight: 34, padding: "6px 12px", fontSize: 12 }} onClick={() => setShowFullDurations((v) => !v)}>
                  {showFullDurations ? "Show less" : `Show all (${durationRows.length})`}
                </button>
              </div>
            )}
          </div>
        </div>
      </Reveal>
    </div>
  );
}
