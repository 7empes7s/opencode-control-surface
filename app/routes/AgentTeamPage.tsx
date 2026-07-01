import { useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Bot,
  Boxes,
  CheckCircle2,
  Clock,
  Cpu,
  GitBranch,
  History,
  Play,
  Radar,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useApi, fmtAge } from "../hooks/useApi";
import { SectionCard } from "../components/SectionCard";
import { authFetch } from "../lib/authFetch";
import type { AgentTeamDetail } from "../../server/api/types";

// "codex:" -> "codex" ; "gemini:gemini-2.5-flash" -> "gemini/gemini-2.5-flash"
function chainLabel(e: string): string {
  return e.endsWith(":") ? e.slice(0, -1) : e.replace(":", "/");
}

// "orchestrator-2026-06-09T08-45-25Z.md" -> epoch ms (time dashes restored to colons)
function reportTime(file: string | undefined): number | null {
  if (!file) return null;
  const m = file.match(/orchestrator-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(t) ? null : t;
}

function HealthTile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="stat-item" style={{ minWidth: 110 }}>
      <div className="stat-lbl">{label}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}

type OpenJob = { id: string; type: string; goal: string; dir: string; created: number; state: string };
type AgentStatus = "active" | "idle" | "cooldown" | "failing";

function statusClass(status: AgentStatus) {
  if (status === "active") return "green";
  if (status === "cooldown") return "amber";
  if (status === "failing") return "red";
  return "gray";
}

function normalizeProvider(chainEntry: string) {
  const raw = chainEntry.endsWith(":") ? chainEntry.slice(0, -1) : chainEntry.split(":")[0];
  return raw.toLowerCase();
}

function statusFromRole(
  role: string,
  chain: string[],
  jobs: AgentTeamDetail["jobs"],
  cooldowns: AgentTeamDetail["cooldowns"],
): AgentStatus {
  const providerSet = new Set(chain.map(normalizeProvider).filter(Boolean));
  const hasCooldown = cooldowns.some((cooldown) => providerSet.has(cooldown.provider.toLowerCase()));
  if (hasCooldown) return "cooldown";

  const roleNeedle = role.toLowerCase();
  const failed = jobs
    .filter((lane) => lane.state === "failed" || lane.state === "rejected")
    .some((lane) => lane.items.some((item) => `${item.type} ${item.goal} ${item.dir}`.toLowerCase().includes(roleNeedle)));
  if (failed) return "failing";

  const active = jobs
    .filter((lane) => lane.state === "running" || lane.state === "queue")
    .some((lane) => lane.items.some((item) => `${item.type} ${item.goal} ${item.dir}`.toLowerCase().includes(roleNeedle)));
  return active ? "active" : "idle";
}

function jobStatePill(state: string) {
  if (state === "done") return "green";
  if (state === "running" || state === "queue") return "amber";
  if (state === "failed" || state === "rejected") return "red";
  return "gray";
}

function pct(part: number, total: number) {
  return total > 0 ? Math.max(3, Math.round((part / total) * 100)) : 0;
}

function MiniMetric({ icon, label, value, tone = "gray" }: { icon: ReactNode; label: string; value: string; tone?: string }) {
  return (
    <div className={`agent-metric-card ${tone}`}>
      <div className="agent-metric-icon">{icon}</div>
      <span className="agent-metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function JobDistribution({ jobs }: { jobs: AgentTeamDetail["jobs"] }) {
  const total = jobs.reduce((sum, lane) => sum + lane.count, 0);
  return (
    <div className="agent-chart-panel">
      <div className="agent-panel-title"><Boxes size={15} /> Job status distribution</div>
      {total === 0 ? (
        <div className="loading-dim">No job files found in the team queues.</div>
      ) : (
        <div className="agent-bars">
          {jobs.map((lane) => (
            <div className="agent-bar-row" key={lane.state}>
              <span className={`pill ${jobStatePill(lane.state)}`}>{lane.state}</span>
              <div className="agent-bar-track" aria-label={`${lane.state}: ${lane.count}`}>
                <div className={`agent-bar-fill ${jobStatePill(lane.state)}`} style={{ width: `${pct(lane.count, total)}%` }} />
              </div>
              <strong className="mono">{lane.count}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelUsageBreakdown({ roles }: { roles: AgentTeamDetail["roles"] }) {
  const providers = roles.reduce<Record<string, number>>((acc, role) => {
    for (const entry of role.chain) {
      const provider = normalizeProvider(entry) || "unknown";
      acc[provider] = (acc[provider] ?? 0) + 1;
    }
    return acc;
  }, {});
  const rows = Object.entries(providers).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="agent-chart-panel">
      <div className="agent-panel-title"><Cpu size={15} /> Model usage by roster chain</div>
      {rows.length === 0 ? (
        <div className="loading-dim">No role chains configured.</div>
      ) : (
        <div className="agent-model-bars">
          {rows.map(([provider, count]) => (
            <div className="agent-model-bar" key={provider}>
              <div>
                <span className="mono">{provider}</span>
                <strong>{count}</strong>
              </div>
              <div className="agent-bar-track">
                <div className="agent-bar-fill blue" style={{ width: `${pct(count, total)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityTimeline({ activity }: { activity: string[] }) {
  const points = activity.slice(-12);
  return (
    <div className="agent-chart-panel agent-activity-panel">
      <div className="agent-panel-title"><History size={15} /> Recent activity timeline</div>
      {points.length === 0 ? (
        <div className="loading-dim">No activity log found.</div>
      ) : (
        <div className="agent-timeline">
          {points.map((line, index) => (
            <div className="agent-timeline-item" key={`${index}-${line}`}>
              <span className="agent-timeline-dot" />
              <span className="mono">{String(index + 1).padStart(2, "0")}</span>
              <p>{line}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SelfCorrectionRing({ selfCorrection }: { selfCorrection: AgentTeamDetail["selfCorrection"] }) {
  const summary = selfCorrection?.summary;
  const audited = summary?.audited ?? 0;
  const shipped = summary?.shipped ?? 0;
  const rolledBack = summary?.rolledBack ?? 0;
  const shippedPct = audited > 0 ? shipped / audited : 0;
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const shippedOffset = circumference - shippedPct * circumference;
  return (
    <div className="agent-chart-panel agent-self-panel">
      <div className="agent-panel-title"><ShieldCheck size={15} /> Self-correction summary</div>
      {audited === 0 ? (
        <div className="loading-dim">No audited team changes recorded.</div>
      ) : (
        <div className="agent-ring-row">
          <svg className="agent-ring" viewBox="0 0 96 96" role="img" aria-label={`${shipped} shipped, ${rolledBack} rolled back`}>
            <circle className="agent-ring-track" cx="48" cy="48" r={radius} />
            <circle
              className="agent-ring-fill"
              cx="48"
              cy="48"
              r={radius}
              strokeDasharray={circumference}
              strokeDashoffset={shippedOffset}
            />
            <text x="48" y="45" textAnchor="middle">{Math.round(shippedPct * 100)}%</text>
            <text x="48" y="60" textAnchor="middle">ship</text>
          </svg>
          <div className="agent-ring-copy">
            <span><CheckCircle2 size={14} /> {shipped} shipped</span>
            <span><RotateCcw size={14} /> {rolledBack} rolled back</span>
            <span><Radar size={14} /> {audited} audited</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentTeamPage() {
  const { data, loading, error, refresh } = useApi<AgentTeamDetail>("/api/agent-team", 30_000);
  const [openJob, setOpenJob] = useState<OpenJob | null>(null);
  const [jobFiles, setJobFiles] = useState<{ name: string; content: string }[] | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newName, setNewName] = useState("");
  const [customProject, setCustomProject] = useState("");
  const [customGoal, setCustomGoal] = useState("");
  const [candidates, setCandidates] = useState<{ path: string; name: string; marker: string }[] | null>(null);

  async function scanProjects() {
    setActionBusy(true);
    try {
      const r = await authFetch("/api/agent-team/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "scan-projects" }) });
      const j = (await r.json()) as { data?: { candidates?: { path: string; name: string; marker: string }[] } };
      setCandidates(j.data?.candidates ?? []);
    } catch { setCandidates([]); } finally { setActionBusy(false); }
  }

  async function postAction(reqBody: Record<string, string>, confirmMsg?: string): Promise<boolean> {
    if (confirmMsg && !window.confirm(confirmMsg)) return false;
    setActionBusy(true);
    let ok = false;
    try {
      const r = await authFetch("/api/agent-team/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        alert("Action failed: " + (e.error || r.status));
      } else { ok = true; }
    } catch (e) {
      alert("Action error: " + String(e));
    } finally {
      setActionBusy(false);
      setTimeout(refresh, 1200);
    }
    return ok;
  }
  function doAction(action: string, jobId: string | undefined, confirmMsg: string) {
    return postAction({ action, jobId: jobId ?? "" }, confirmMsg);
  }

  async function viewJob(j: OpenJob) {
    setOpenJob(j);
    setJobFiles(null);
    try {
      const r = await authFetch("/api/agent-team/job/" + encodeURIComponent(j.id));
      const res = (await r.json()) as { data?: { files?: { name: string; content: string }[] } };
      setJobFiles(res.data?.files ?? []);
    } catch {
      setJobFiles([]);
    }
  }
  function closeJob() { setOpenJob(null); setJobFiles(null); }

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;
  const stateCount = (s: string) => d.jobs.find((j) => j.state === s)?.count ?? 0;
  const inFlight = stateCount("running") + stateCount("queue");
  const lastPass = reportTime(d.latestReport?.file);
  const generatedMs = new Date(d.generatedAt).getTime();
  const updatedAgo = Number.isNaN(generatedMs) ? "unknown" : fmtAge(Math.floor((Date.now() - generatedMs) / 1000));
  const latestActivity = d.recentActivity[d.recentActivity.length - 1] ?? "";
  const roster = d.roles.map((role) => {
    const status = statusFromRole(role.role, role.chain, d.jobs, d.cooldowns);
    const activityLine = d.recentActivity.slice().reverse().find((line) => line.toLowerCase().includes(role.role.toLowerCase())) ?? latestActivity;
    return {
      ...role,
      status,
      currentModel: role.chain[0] ? chainLabel(role.chain[0]) : "not configured",
      lastActivity: activityLine || "No activity recorded",
    };
  });
  const attentionCount = stateCount("failed") + stateCount("rejected") + d.cooldowns.length;

  return (
    <div className="dash-page agent-team-page">
      <div className="page-header agent-team-header">
        <div>
          <div className="page-title">Agent Team</div>
          <p className="agent-team-subtitle">
            Live roster, queue pressure, cooldowns, model chains, activity, and self-correction evidence from the improvement team.
          </p>
          <div className="agent-header-meta">
            <span className="mono"><Clock size={13} /> Updated {updatedAgo}</span>
            <span className={`pill ${attentionCount > 0 ? "amber" : "green"}`}>{attentionCount} need attention</span>
          </div>
        </div>
        <div className="agent-header-actions">
          <button
            className="pill agent-action-pill"
            disabled={actionBusy}
            onClick={() => doAction("run-orchestrator", undefined, "Run an orchestrator pass now? It will analyze the stack and may enqueue safe improvement jobs.")}
          >
            <Play size={14} />
            Run orchestrator pass
          </button>
        </div>
      </div>

      <section className="agent-metrics-grid" aria-label="Agent team summary">
        <MiniMetric icon={<Activity size={17} />} label="in flight" value={String(inFlight)} tone={inFlight > 0 ? "amber" : "gray"} />
        <MiniMetric icon={<CheckCircle2 size={17} />} label="done" value={String(stateCount("done"))} tone="green" />
        <MiniMetric icon={<XCircle size={17} />} label="failed / rejected" value={String(stateCount("failed") + stateCount("rejected"))} tone={stateCount("failed") + stateCount("rejected") > 0 ? "red" : "gray"} />
        <MiniMetric icon={<Cpu size={17} />} label="models" value={`${d.models.usableFree}/${d.models.count} free`} tone="blue" />
        <MiniMetric icon={<GitBranch size={17} />} label="projects" value={String(d.projects.length)} tone="gray" />
        <MiniMetric icon={<Radar size={17} />} label="last pass" value={lastPass ? fmtAge(Math.floor((Date.now() - lastPass) / 1000)) : "-"} tone="gray" />
      </section>

      <SectionCard title={<><Bot size={16} /> Agent roster</>} defaultOpen={true}>
        <div className="section-card-body">
          {roster.length === 0 ? (
            <div className="loading-dim">No agent roles configured yet.</div>
          ) : (
            <div className="agent-roster-grid">
              {roster.map((agent) => (
                <article className={`agent-roster-card ${agent.status}`} key={agent.role}>
                  <div className="agent-roster-head">
                    <span className={`agent-status-dot ${agent.status}`} aria-hidden="true" />
                    <div>
                      <h3>{agent.role}</h3>
                      <span className={`pill ${statusClass(agent.status)}`}>{agent.status}</span>
                    </div>
                  </div>
                  <dl className="agent-roster-facts">
                    <div><dt>mode</dt><dd>{agent.mode}</dd></div>
                    <div><dt>model</dt><dd className="mono">{agent.currentModel}</dd></div>
                    <div><dt>chain</dt><dd>{agent.chain.length ? agent.chain.map(chainLabel).join(" -> ") : "none"}</dd></div>
                  </dl>
                  <p className="agent-last-activity">{agent.lastActivity}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      <section className="agent-infographic-grid" aria-label="Agent team infographics">
        <JobDistribution jobs={d.jobs} />
        <ModelUsageBreakdown roles={d.roles} />
        <SelfCorrectionRing selfCorrection={d.selfCorrection} />
        <ActivityTimeline activity={d.recentActivity} />
      </section>

      {/* Self-correction — the trust centerpiece: build → audit → rollback */}
      {d.selfCorrection && d.selfCorrection.summary.audited > 0 && (
        <SectionCard title="Self-correction — every change is audited & reversible" defaultOpen={true}>
          <div className="section-card-body tib-chip-grid" style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
            <HealthTile label="Builds audited" value={String(d.selfCorrection.summary.audited)} />
            <HealthTile label="Shipped" value={String(d.selfCorrection.summary.shipped)} color="var(--green)" />
            <HealthTile label="Rolled back" value={String(d.selfCorrection.summary.rolledBack)} color="var(--amber-warn)" />
          </div>
          <div className="dim section-card-body" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.55 }}>
            The team reviews its own work. Every build is audited by an independent agent, and when the auditor
            finds a real issue the change is <strong>rolled back automatically</strong> — nothing broken ships.
            This is the QA layer working as designed; rollbacks are a feature, not a failure.
          </div>
          <div className="section-card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {d.selfCorrection.events.map((e) => (
              <div key={e.jobId} className={`agent-self-event ${e.outcome === "shipped" ? "shipped" : "rolled-back"}`}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className={`pill ${e.outcome === "shipped" ? "green" : "amber"}`}>{e.outcome === "shipped" ? "shipped ✓" : "rolled back ↩"}</span>
                  <span style={{ fontSize: 12 }}>{e.goal || e.jobId}</span>
                  <span className="dim" style={{ fontSize: 11, marginLeft: "auto" }}>{fmtAge(Math.floor((Date.now() - e.ts) / 1000))}</span>
                </div>
                {e.finding && (
                  <div className="dim mono sc-finding" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
                    auditor: <span className="sc-finding-text">{e.finding}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Registered projects (continuous improvement) */}
      {d.projects && (
        <SectionCard title="Projects — continuous improvement" defaultOpen={true}>
          <div className="section-card-body">
            {/* Add a project — no shell needed */}
            <div className="at-register-form" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, alignItems: "center" }}>
              <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/abs/path/to/project"
                className="at-register-input"
                style={{ flex: "2 1 220px", minWidth: 0, fontFamily: "var(--mono)", fontSize: 12, padding: "6px 8px", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4 }} />
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="name (optional)"
                className="at-register-input"
                style={{ flex: "1 1 120px", minWidth: 0, fontFamily: "var(--mono)", fontSize: 12, padding: "6px 8px", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4 }} />
              <div className="at-register-btns" style={{ display: "contents" }}>
                <button className="pill at-register-btn" disabled={actionBusy || !newPath.trim()} style={{ cursor: "pointer" }}
                  onClick={async () => { const ok = await postAction({ action: "register-project", path: newPath.trim(), name: newName.trim() }); if (ok) { setNewPath(""); setNewName(""); } }}>
                  + register project
                </button>
                <button className="pill at-register-btn" disabled={actionBusy} style={{ cursor: "pointer" }} onClick={scanProjects}>
                  🔍 scan for projects
                </button>
              </div>
            </div>

            {/* Detected projects (one-click add — no path typing) */}
            {candidates !== null && (
              <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
                <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
                  Detected {candidates.length} project{candidates.length === 1 ? "" : "s"} {candidates.length ? "(not yet registered):" : "— nothing new found under /opt, /root, /home."}
                </div>
                {candidates.map((c) => (
                  <div key={c.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", flexWrap: "wrap" }}>
                    <span className="mono" style={{ fontSize: 12 }}>{c.name}</span>
                    <span className="dim mono" style={{ fontSize: 11, flex: "1 1 160px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.path}</span>
                    <span className="pill" style={{ fontSize: 10 }}>{c.marker}</span>
                    <button className="pill" disabled={actionBusy} style={{ cursor: "pointer" }}
                      onClick={async () => { const ok = await postAction({ action: "register-project", path: c.path, name: c.name }); if (ok) setCandidates((prev) => (prev ?? []).filter((x) => x.path !== c.path)); }}>
                      add
                    </button>
                  </div>
                ))}
              </div>
            )}

            {d.projects.length === 0 ? (
              <div className="loading-dim" style={{ fontSize: 12 }}>No projects registered yet — add an absolute path above to start improving it.</div>
            ) : (<>
              {/* Desktop table */}
              <div className="at-projects-table-wrap" style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                <table className="data-table" style={{ fontSize: 12, minWidth: 560 }}>
                  <thead><tr>
                    <th>project</th><th style={{ width: "80px" }}>capability</th>
                    <th style={{ width: "90px" }}>last improve</th><th style={{ width: "120px" }}>jobs q/run/done/rej</th>
                    <th style={{ width: "150px" }}>actions</th>
                  </tr></thead>
                  <tbody>
                    {d.projects.map((p) => (
                      <tr key={p.path}>
                        <td className="mono" title={p.path}>{p.name}</td>
                        <td><span className="pill">{p.capability}</span></td>
                        <td className="mono dim">{p.lastImprove ? fmtAge(Math.floor(Date.now() / 1000 - p.lastImprove)) : "never"}</td>
                        <td className="mono dim">{p.counts.queue}/{p.counts.running}/{p.counts.done}/{p.counts.rejected}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button className="pill" disabled={actionBusy} style={{ cursor: "pointer", marginRight: 6 }}
                            onClick={() => doAction("improve-project", p.name, `Run an auto improvement pass on '${p.name}'?`)}>improve</button>
                          <button className="pill" disabled={actionBusy} style={{ cursor: "pointer" }}
                            onClick={() => postAction({ action: "unregister-project", name: p.name }, `Remove '${p.name}' from managed projects? (does not delete the project files)`)}>remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile stacked cards */}
              <div className="at-projects-cards">
                {d.projects.map((p) => (
                  <div key={p.path} className="at-project-card">
                    <div className="at-project-card-head">
                      <span className="mono" style={{ fontWeight: 600, fontSize: 13, color: "var(--text-bright)" }}>{p.name}</span>
                      <span className="pill" style={{ fontSize: 10 }}>{p.capability}</span>
                    </div>
                    <div className="at-project-card-meta dim" style={{ fontSize: 11, lineHeight: 1.6 }}>
                      {p.capability} · improved {p.lastImprove ? fmtAge(Math.floor(Date.now() / 1000 - p.lastImprove)) : "never"} · jobs {p.counts.queue}/{p.counts.running}/{p.counts.done}/{p.counts.rejected}
                    </div>
                    <div className="at-project-card-actions" style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <button className="pill" disabled={actionBusy} style={{ cursor: "pointer", fontSize: 10 }}
                        onClick={() => doAction("improve-project", p.name, `Run an auto improvement pass on '${p.name}'?`)}>improve</button>
                      <button className="pill" disabled={actionBusy} style={{ cursor: "pointer", fontSize: 10 }}
                        onClick={() => postAction({ action: "unregister-project", name: p.name }, `Remove '${p.name}' from managed projects?`)}>remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </>)}

            {/* Run a CUSTOM improvement (e.g. "fix the mobile style") — fully from the portal */}
            {d.projects.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>Run a custom improvement</div>
                <div className="at-custom-form" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <select value={customProject} onChange={(e) => setCustomProject(e.target.value)}
                    className="at-custom-select"
                    style={{ flex: "1 1 150px", fontSize: 12, padding: "6px 8px", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4 }}>
                    <option value="">project…</option>
                    {d.projects.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
                  </select>
                  <textarea value={customGoal} onChange={(e) => setCustomGoal(e.target.value)} placeholder='e.g. "fix the mobile layout & dark-mode contrast on the agent-team page"'
                    className="at-custom-goal"
                    rows={2}
                    style={{ flex: "3 1 280px", minWidth: 0, fontSize: 12, padding: "6px 8px", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, resize: "vertical", fontFamily: "inherit" }} />
                  <button className="pill at-custom-run-btn" disabled={actionBusy || !customProject || customGoal.trim().length < 5} style={{ cursor: "pointer" }}
                    onClick={async () => { const ok = await postAction({ action: "enqueue-team", dir: customProject, goal: customGoal.trim() }, "Queue this improvement for the selected project?"); if (ok) setCustomGoal(""); }}>
                    run improvement
                  </button>
                </div>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* Jobs */}
      <SectionCard title="Jobs" defaultOpen={true}>
        <div className="section-card-body">
          {d.jobs.map((js) => (
            <div key={js.state} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span className="pill" style={{ textTransform: "capitalize" }}>{js.state}</span>
                <span className="dim mono">{js.count} items</span>
              </div>
              {js.items.length === 0 ? (
                <div className="loading-dim" style={{ fontSize: 12 }}>no jobs</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {js.items.map((item) => {
                    const c = js.state === "done" ? "var(--green)"
                      : js.state === "running" ? "var(--amber-warn)"
                      : (js.state === "rejected" || js.state === "failed") ? "var(--red, #e5534b)"
                      : "var(--border)";
                    return (
                      <div
                        key={item.id}
                        onClick={() => viewJob({ ...item, state: js.state })}
                        title="click to view transcript"
                        className={`at-job-item agent-job-state-${js.state}`}
                        style={{
                          cursor: "pointer", background: "var(--bg-base)", border: "1px solid var(--border)",
                          borderColor: c, borderRadius: 6, padding: "10px 14px",
                          display: "flex", flexDirection: "column", gap: 5,
                        }}
                      >
                        <div className="at-job-line1" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span className="pill at-job-type" style={{ fontSize: 10, fontFamily: "var(--mono)" }}>{item.type}</span>
                          <span className="mono dim at-job-id" style={{ fontSize: 10, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.id}</span>
                          <span className="dim at-job-date" style={{ fontSize: 10 }}>{item.created ? new Date(item.created * 1000).toISOString().slice(5, 16).replace("T", " ") : "—"}</span>
                          <span className="dim mono at-job-transcript" style={{ fontSize: 10 }}>▸ transcript</span>
                          {js.state === "queue" && (
                            <button className="pill at-job-action-btn" disabled={actionBusy} style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); doAction("cancel", item.id, `Cancel queued job ${item.id}?`); }}>cancel</button>
                          )}
                          {(js.state === "rejected" || js.state === "failed") && (
                            <button className="pill at-job-action-btn" disabled={actionBusy} style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); doAction("requeue", item.id, `Requeue job ${item.id}?`); }}>requeue</button>
                          )}
                        </div>
                        <div className="dim at-job-goal" style={{ fontSize: 12, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>{item.goal || "(no goal recorded)"}</div>
                        {item.dir && <div className="mono dim at-job-dir" style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.dir}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Provider Cooldowns */}
      <SectionCard title="Provider Cooldowns" defaultOpen={true}>
        <div className="section-card-body">
          {d.cooldowns.length === 0 ? (
            <div className="loading-dim" style={{ color: "var(--green)" }}>all providers available</div>
          ) : (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}><table className="data-table" style={{ fontSize: 12, minWidth: 480 }}>
              <thead>
                <tr>
                  <th>provider</th>
                  <th>scope</th>
                  <th>resets in</th>
                  <th>message</th>
                  <th>actions</th>
                </tr>
              </thead>
              <tbody>
                {d.cooldowns.map((c) => (
                  <tr key={c.provider}>
                    <td className="mono">{c.provider}</td>
                    <td className="dim">{c.scope}</td>
                    <td className="mono dim">{fmtAge(c.until - Math.floor(Date.now() / 1000))}</td>
                    <td className="dim" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.msg}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="pill"
                        disabled={actionBusy}
                        style={{ cursor: "pointer" }}
                        onClick={() => postAction({ action: "clear-cooldown", provider: c.provider }, "Clear cooldown for " + c.provider + "?")}
                      >
                        clear
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      </SectionCard>

      {/* Model Chains per Role */}
      <SectionCard title="Model Chains per Role" defaultOpen={true}>
        <div className="section-card-body">
          {d.roles.length === 0 ? (
            <div className="loading-dim">No agent roles configured yet.</div>
          ) : (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}><table className="data-table" style={{ fontSize: 12, minWidth: 480 }}>
              <thead>
                <tr>
                  <th style={{ width: "120px" }}>role</th>
                  <th style={{ width: "80px" }}>mode</th>
                  <th>chain</th>
                </tr>
              </thead>
              <tbody>
                {d.roles.map((r) => (
                  <tr key={r.role}>
                    <td className="mono">{r.role}</td>
                    <td><span className="pill">{r.mode}</span></td>
                    <td className="mono dim">{r.chain.map(chainLabel).join(" → ")}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      </SectionCard>

      {/* Models Discovered */}
      <SectionCard title="Models Discovered" defaultOpen={true}>
        <div className="section-card-body">
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
            <div className="stat-item">
              <div className="stat-lbl">total</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)" }}>{d.models.count}</div>
            </div>
            <div className="stat-item">
              <div className="stat-lbl">usable free</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--green)" }}>{d.models.usableFree}</div>
            </div>
            <div className="stat-item">
              <div className="stat-lbl">providers</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)" }}>{d.models.providers.length}</div>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {d.models.providers.map((p) => (
              <span key={p} className="pill" style={{ fontSize: 11 }}>{p}</span>
            ))}
          </div>
        </div>
      </SectionCard>

      {/* Latest Orchestrator Report */}
      <SectionCard title="Latest Orchestrator Report" defaultOpen={true}>
        <div className="section-card-body">
          {d.latestReport ? (
            <>
              <div style={{ marginBottom: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
                {d.latestReport.file}
              </div>
              <pre style={{ fontSize: 11, lineHeight: 1.5, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
                {d.latestReport.head}
              </pre>
            </>
          ) : (
            <div className="loading-dim">No orchestrator reports yet — the team hasn't run a review.</div>
          )}
        </div>
      </SectionCard>

      {/* Recent Activity */}
      <SectionCard title="Recent Activity (last 30 lines)" defaultOpen={true}>
        <div className="section-card-body">
          {d.recentActivity.length === 0 ? (
            <div className="loading-dim">no activity log found</div>
          ) : (
            <pre style={{ fontSize: 11, lineHeight: 1.5, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
              {d.recentActivity.join("\n")}
            </pre>
          )}
        </div>
      </SectionCard>

      {/* Job transcript drill-down (read-only) */}
      {openJob && (
        <div onClick={closeJob} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 99999, padding: 12, overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, width: "min(900px, 94vw)", maxHeight: "86dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* sticky header so Close is ALWAYS reachable (above the top menu, even on mobile) */}
            <div style={{ position: "sticky", top: 0, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
              <div className="mono" style={{ fontSize: 13, wordBreak: "break-all", overflow: "hidden" }}>{openJob.id}</div>
              <button onClick={closeJob} className="pill" style={{ cursor: "pointer", flexShrink: 0, fontSize: 14, padding: "6px 16px" }}>✕ close</button>
            </div>
            <div style={{ overflow: "auto", padding: 14 }}>
            {/* Always-present job metadata */}
            <div style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.7 }}>
              <span className="pill" style={{ textTransform: "capitalize" }}>{openJob.state}</span>
              <span className="dim mono" style={{ marginLeft: 8 }}>{openJob.type}</span>
              {openJob.created ? <span className="dim mono" style={{ marginLeft: 8 }}>{new Date(openJob.created * 1000).toISOString().slice(0, 19).replace("T", " ")}</span> : null}
              <div style={{ marginTop: 6 }}><span className="dim">goal:</span> {openJob.goal || "—"}</div>
              {openJob.dir ? <div style={{ marginTop: 2 }}><span className="dim">dir:</span> <span className="mono" style={{ wordBreak: "break-all" }}>{openJob.dir}</span></div> : null}
            </div>
            {jobFiles === null ? (
              <div className="loading-dim">loading transcript…</div>
            ) : jobFiles.length === 0 ? (
              <div className="loading-dim" style={{ fontSize: 12, lineHeight: 1.6 }}>
                No plan/build/audit transcript for this job. Single-step (dispatch) jobs and jobs
                rejected early by a guardrail don't produce one — see "Recent Activity" for what happened.
              </div>
            ) : (
              jobFiles.map((f) => (
                <div key={f.name} style={{ marginBottom: 14 }}>
                  <div className="dim mono" style={{ fontSize: 12, marginBottom: 4 }}>{f.name}</div>
                  <pre style={{ fontSize: 11, lineHeight: 1.5, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>{f.content}</pre>
                </div>
              ))
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
