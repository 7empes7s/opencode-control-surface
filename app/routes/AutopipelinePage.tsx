import { useState } from "react";
import { useApi, fmtMs } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { ConfirmModal } from "../components/ConfirmModal";
import type { AutopipelineDetail } from "../../server/api/types";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { AnimatedNumber } from "../components/AnimatedCharts";
import { SectionCard } from "../components/SectionCard";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function StageDurationTable({ durations }: { durations: AutopipelineDetail["stageDurations"] }) {
  const relevant = durations.filter((d) => d.sampleCount > 0);
  if (relevant.length === 0) return <div className="loading-dim">no timing samples yet</div>;
  return (
    <table className="data-table">
      <thead><tr>
        <th>stage</th><th>p50</th><th>p95</th><th>samples</th>
      </tr></thead>
      <tbody>
        {relevant.map((d) => (
          <tr key={d.stage}>
            <td className="mono">{d.stage}</td>
            <td className="mono">{fmtMs(d.p50Ms)}</td>
            <td className="mono">{fmtMs(d.p95Ms)}</td>
            <td className="dim">{d.sampleCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Modal =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "inject" }
  | { type: "rush"; id: string; slug?: string }
  | { type: "kill"; id: string; slug?: string }
  | { type: "publish"; id: string; slug?: string };

export function AutopipelinePage() {
  const { data, loading, error, refresh } = useApi<AutopipelineDetail>("/api/autopipeline", 10_000);
  const [modal, setModal] = useState<Modal | null>(null);
  const [showFullQueue, setShowFullQueue] = useState(false);
  const [showFullApprovals, setShowFullApprovals] = useState(false);
  const [showFullDurations, setShowFullDurations] = useState(false);
  const cmd = useAction("/api/autopipeline/command");

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
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
      <div className="page-header">
        <div className="page-title">Autopipeline</div>
        <div className="stat-row">
          <div className="stat-item">
            <div className="stat-val"><AnimatedNumber value={d.stats.queueDepth} /></div>
            <div className="stat-lbl">queued</div>
          </div>
          <div className="stat-item">
            <div className="stat-val"><AnimatedNumber value={d.stats.approvalsWaiting} /></div>
            <div className="stat-lbl">waiting approval</div>
          </div>
          <div className="stat-item" style={{ display: "flex", alignItems: "flex-start", flexDirection: "column", gap: 2 }}>
            <Pill color={d.paused ? "amber" : "green"}>{d.paused ? "paused" : "running"}</Pill>
            {d.pauseReason && <div className="stat-lbl">{d.pauseReason}</div>}
          </div>
        </div>
        <div className="action-bar" style={{ marginTop: 12 }}>
          <button
            className={`btn ${d.paused ? "btn-primary" : "btn-amber"}`}
            onClick={() => setModal(d.paused ? { type: "resume" } : { type: "pause" })}
          >
            {d.paused ? "Resume" : "Pause"}
          </button>
          <button className="btn btn-ghost" onClick={() => setModal({ type: "inject" })}>
            + Inject topic
          </button>
          {cmd.success && <span className="action-feedback ok">{cmd.success}</span>}
          {cmd.error && <span className="action-feedback err">{cmd.error}</span>}
        </div>
      </div>

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
            else if (modal.type === "rush") body = { cmd: "rush", storyId: modal.id };
            else if (modal.type === "kill") body = { cmd: "kill", storyId: modal.id };
            else if (modal.type === "publish") body = { cmd: "publish", storyId: modal.id };
            const ok = await cmd.run(body);
            if (ok) { setModal(null); refresh(); }
          }}
        />
      )}

      {/* Current story */}
      {d.current && (
        <SectionCard title="current story" id="current" defaultOpen={true}>
          <div className="section-card-body" style={{ padding: "12px 14px" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-bright)", marginBottom: 6 }}>
              {d.current.slug ?? d.current.id}
            </div>
            <Pill color="amber">{d.current.stage}</Pill>
          </div>
        </SectionCard>
      )}

      {/* Queue */}
      <SectionCard
        title="queue"
        id="queue"
        defaultOpen={true}
        right={
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(d.stats.stageBreakdown).map(([stage, count]) => (
              <Pill key={stage} color="gray">{stage} {count}</Pill>
            ))}
          </div>
        }
      >
        <div className="section-card-body table-wrap">
          {d.queue.length === 0 ? (
            <div className="loading-dim">queue empty</div>
          ) : (
            <table className="data-table">
              <thead><tr>
                <th>slug / id</th><th>stage</th><th></th><th className="queue-col-priority">priority</th><th className="queue-col-elapsed">elapsed</th><th className="queue-col-flags">flags</th>
              </tr></thead>
              <tbody>
                {queueRows.map((item) => (
                  <tr key={item.id}>
                    <td className="mono trunc">{item.slug ?? item.id}</td>
                    <td className="mono">{item.stage}</td>
                    <td><div style={{ display: "flex", gap: 4 }} className="queue-actions">
                        <button className="btn btn-sm btn-ghost" onClick={() => {
                          if (!item.dossierDate || !item.dossierSlug) return;
                          window.location.hash = `#/autopipeline/dossier/${item.dossierDate}/${item.dossierSlug}`;
                        }} disabled={!item.dossierDate || !item.dossierSlug}>inspect</button>
                        {item.stage === "publish" && item.waitingApproval && (
                          <button className="btn btn-sm btn-primary" onClick={() => setModal({ type: "publish", id: item.id, slug: item.slug })}>publish</button>
                        )}
                        {!item.running && (
                          <button className="btn btn-sm btn-ghost" onClick={() => setModal({ type: "rush", id: item.id, slug: item.slug })}>rush</button>
                        )}
                        <button className="btn btn-sm btn-danger" onClick={() => setModal({ type: "kill", id: item.id, slug: item.slug })}>kill</button>
                      </div></td>
                    <td className="dim queue-col-priority">{item.priority}</td>
                    <td className="dim queue-col-elapsed">{item.elapsedMs != null ? fmtMs(item.elapsedMs) : "—"}</td>
                    <td className="queue-col-flags">
                      {item.running && <Pill color="amber">running</Pill>}
                      {item.waitingApproval && <Pill color="red">approval</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.queue.length > MAX_BODY_ROWS && (
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowFullQueue((v) => !v)}>
                {showFullQueue ? "Show less" : `Show all (${d.queue.length})`}
              </button>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Approvals */}
      {d.stats.approvalsWaiting > 0 && (
        <SectionCard title="approvals waiting" id="approvals" defaultOpen={true}>
          <div className="section-card-body table-wrap">
            <table className="data-table">
              <thead><tr><th>slug / id</th><th>stage</th><th>age</th></tr></thead>
              <tbody>
                {approvalRows.map((item) => (
                  <tr key={item.id}>
                    <td className="mono trunc">{item.slug ?? item.id}</td>
                    <td className="mono">{item.stage}</td>
                    <td className="dim">{item.elapsedMs != null ? fmtMs(item.elapsedMs) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {approvals.length > MAX_BODY_ROWS && (
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowFullApprovals((v) => !v)}>
                  {showFullApprovals ? "Show less" : `Show all (${approvals.length})`}
                </button>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* Stage breakdown chart */}
      {Object.keys(d.stats.stageBreakdown).length > 0 && (
        <SectionCard title="queue by stage" id="stages" defaultOpen={false}>
          <div className="section-card-body" style={{ padding: "10px 14px" }}>
            {(() => {
              const stageOrder = ["scout", "research", "validate-research", "write", "validate-write", "verify", "publish-prep", "init", "fetch-image", "publish"];
              const data = stageOrder
                .filter((s) => d.stats.stageBreakdown[s] != null)
                .map((s) => ({ stage: s, count: d.stats.stageBreakdown[s] }));
              const APPROVAL_STAGES = new Set(["publish"]);
              return (
                <ResponsiveContainer width="100%" height={Math.max(60, data.length * 26)}>
                  <BarChart layout="vertical" data={data} margin={{ top: 0, right: 36, bottom: 0, left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis
                      type="category" dataKey="stage" width={140}
                      tick={{ fontFamily: "var(--mono)", fontSize: 10, fill: "#666" }}
                      axisLine={false} tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{ background: "#111", border: "1px solid #222", borderRadius: 3, fontFamily: "var(--mono)", fontSize: 11 }}
                      itemStyle={{ color: "#4ade80" }}
                      formatter={(v: number) => [v, "stories"]}
                    />
                    <Bar dataKey="count" radius={[0, 2, 2, 0]} maxBarSize={16}>
                      {data.map((entry) => (
                        <Cell
                          key={entry.stage}
                          fill={APPROVAL_STAGES.has(entry.stage) ? "#f59e0b" : "#4ade80"}
                          opacity={0.7}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              );
            })()}
          </div>
        </SectionCard>
      )}

      {/* Stage durations */}
      <SectionCard title="stage durations" id="throughput" defaultOpen={false}>
        <div className="section-card-body table-wrap">
          <StageDurationTable durations={durationRowsVisible} />
          {durationRows.length > MAX_BODY_ROWS && (
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowFullDurations((v) => !v)}>
                {showFullDurations ? "Show less" : `Show all (${durationRows.length})`}
              </button>
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
