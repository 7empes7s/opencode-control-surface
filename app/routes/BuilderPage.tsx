import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { CheckCircle2, ChevronRight, ExternalLink, Pause, Play, Plus, RefreshCw, Save, Square, XCircle } from "lucide-react";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { authFetch } from "../lib/authFetch";
import { SectionCard } from "../components/SectionCard";
import type {
  BuilderDiscovery,
  BuilderModelsInventory,
  BuilderProject,
  BuilderSkillStatus,
} from "../../server/builder/discovery";
import type { BuilderWorkflowInput } from "../../server/builder/store";
import type {
  BuilderProjectsResponse,
  BuilderRunResponse,
  BuilderRunsResponse,
  BuilderWorkflowResponse,
  BuilderWorkflowsResponse,
} from "../../server/api/builder";
import type {
  BuilderArtifact,
  BuilderPass,
  BuilderRun,
  BuilderValidation,
} from "../../server/builder/store";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function statusColor(status: string | boolean | null | undefined): string {
  if (status === true || status === "ok" || status === "active" || status === "clean") return "green";
  if (status === "missing" || status === "error" || status === false) return "red";
  if (status === "degraded" || status === "dirty") return "amber";
  return "gray";
}

function fmtTs(ts: number | null): string {
  if (!ts) return "-";
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function AgentPill({ label, status }: { label: string; status: string }) {
  return <Pill color={statusColor(status)}>{label}: {status}</Pill>;
}

function SkillRow({ skill }: { skill: BuilderSkillStatus }) {
  return (
    <tr>
      <td><Pill color={statusColor(skill.status)}>{skill.status}</Pill></td>
      <td className="mono">{skill.name}</td>
      <td className="mono trunc">{skill.path}</td>
      <td>{skill.description || "-"}</td>
    </tr>
  );
}

function ModelSummary({ models }: { models: BuilderModelsInventory }) {
  return (
    <div className="builder-kv-grid">
      <div><span>best local</span><strong>{models.bestLocal ?? "-"}</strong></div>
      <div><span>cloud heavy</span><strong>{models.bestCloudHeavy ?? "-"}</strong></div>
      <div><span>cloud fast</span><strong>{models.bestCloudFast ?? "-"}</strong></div>
      <div><span>available</span><strong>{models.available}</strong></div>
      <div><span>blocked</span><strong>{models.blocked}</strong></div>
      <div><span>fallback targets</span><strong>{models.fallbackTargets.length}</strong></div>
    </div>
  );
}

function workflowDefaults(data: BuilderDiscovery, projectRoot: string): BuilderWorkflowInput {
  const plan = data.planCandidates.find((item) => item.exists && item.kind === "builder")
    ?? data.planCandidates.find((item) => item.exists && item.kind === "canonical")
    ?? data.planCandidates.find((item) => item.exists);
  return {
    name: `${data.project.label} builder pass`,
    projectRoot,
    planFile: plan?.path ?? "",
    mode: "once",
    status: "draft",
    config: {
      projectRoot,
      agentOrder: ["codex", "claude", "opencode"],
      modelPolicy: {
        planner: data.models.bestCloudHeavy ?? undefined,
        builder: data.models.bestCloudFast ?? data.models.bestCloudHeavy ?? undefined,
        reviewer: data.models.bestCloudHeavy ?? undefined,
        fallbackTargets: data.models.fallbackTargets.slice(0, 5),
      },
      validationProfile: {
        commands: data.validation.commands,
        internalUrl: data.urls.internal,
        publicUrl: data.urls.public,
      },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: true, beforeRun: true },
      riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
    },
  };
}

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function WorkflowModal({
  data,
  selectedRoot,
  onClose,
  onSaved,
}: {
  data: BuilderDiscovery;
  selectedRoot: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<BuilderWorkflowInput>(() => workflowDefaults(data, selectedRoot));
  const [agentOrder, setAgentOrder] = useState(draft.config.agentOrder.join(", "));
  const [fallbackTargets, setFallbackTargets] = useState(draft.config.modelPolicy.fallbackTargets.join(", "));
  const [commands, setCommands] = useState(draft.config.validationProfile.commands.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const payload: BuilderWorkflowInput = {
      ...draft,
      config: {
        ...draft.config,
        projectRoot: selectedRoot,
        agentOrder: splitCsv(agentOrder),
        modelPolicy: {
          ...draft.config.modelPolicy,
          fallbackTargets: splitCsv(fallbackTargets),
        },
        validationProfile: {
          ...draft.config.validationProfile,
          commands: commands.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        },
      },
    };

    try {
      const response = await authFetch("/api/builder/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      await response.json() as BuilderWorkflowResponse;
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div className="modal-box builder-workflow-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">New workflow</div>
        <div className="builder-form-grid">
          <label className="modal-input-row">
            <span className="modal-input-label">Name</span>
            <input
              className="modal-input"
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Plan</span>
            <select
              className="audit-select"
              value={draft.planFile}
              onChange={(event) => setDraft((prev) => ({ ...prev, planFile: event.target.value }))}
            >
              {data.planCandidates.filter((plan) => plan.exists).map((plan) => (
                <option key={plan.path} value={plan.path}>{plan.title} - {plan.path}</option>
              ))}
            </select>
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Mode</span>
            <select
              className="audit-select"
              value={draft.mode}
              onChange={(event) => setDraft((prev) => ({ ...prev, mode: event.target.value as BuilderWorkflowInput["mode"] }))}
            >
              <option value="once">once</option>
              <option value="auto-continue">auto-continue</option>
              <option value="scheduled">scheduled</option>
              <option value="permanent">permanent</option>
              <option value="doctor">doctor</option>
            </select>
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Status</span>
            <select
              className="audit-select"
              value={draft.status}
              onChange={(event) => setDraft((prev) => ({ ...prev, status: event.target.value as BuilderWorkflowInput["status"] }))}
            >
              <option value="draft">draft</option>
              <option value="ready">ready</option>
            </select>
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Agent order</span>
            <input className="modal-input" value={agentOrder} onChange={(event) => setAgentOrder(event.target.value)} />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Fallback targets</span>
            <input className="modal-input" value={fallbackTargets} onChange={(event) => setFallbackTargets(event.target.value)} />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Planner</span>
            <input
              className="modal-input"
              value={draft.config.modelPolicy.planner ?? ""}
              onChange={(event) => setDraft((prev) => ({
                ...prev,
                config: { ...prev.config, modelPolicy: { ...prev.config.modelPolicy, planner: event.target.value || undefined } },
              }))}
            />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Builder</span>
            <input
              className="modal-input"
              value={draft.config.modelPolicy.builder ?? ""}
              onChange={(event) => setDraft((prev) => ({
                ...prev,
                config: { ...prev.config, modelPolicy: { ...prev.config.modelPolicy, builder: event.target.value || undefined } },
              }))}
            />
          </label>
          <label className="modal-input-row builder-form-wide">
            <span className="modal-input-label">Validation</span>
            <textarea className="modal-input builder-textarea" value={commands} onChange={(event) => setCommands(event.target.value)} />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Commit</span>
            <select
              className="audit-select"
              value={draft.config.gitPolicy.commit}
              onChange={(event) => setDraft((prev) => ({
                ...prev,
                config: {
                  ...prev.config,
                  gitPolicy: { ...prev.config.gitPolicy, commit: event.target.value as BuilderWorkflowInput["config"]["gitPolicy"]["commit"] },
                },
              }))}
            >
              <option value="manual">manual</option>
              <option value="after-validation">after-validation</option>
            </select>
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Push</span>
            <select
              className="audit-select"
              value={draft.config.gitPolicy.push}
              onChange={(event) => setDraft((prev) => ({
                ...prev,
                config: {
                  ...prev.config,
                  gitPolicy: { ...prev.config.gitPolicy, push: event.target.value as BuilderWorkflowInput["config"]["gitPolicy"]["push"] },
                },
              }))}
            >
              <option value="never">never</option>
              <option value="workflow-branch">workflow-branch</option>
              <option value="current-branch">current-branch</option>
            </select>
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Max passes</span>
            <input
              className="modal-input"
              type="number"
              min={1}
              max={50}
              value={draft.config.riskPolicy.maxPasses}
              onChange={(event) => setDraft((prev) => ({
                ...prev,
                config: {
                  ...prev.config,
                  riskPolicy: { ...prev.config.riskPolicy, maxPasses: Number(event.target.value) || 1 },
                },
              }))}
            />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Live deploys</span>
            <select
              className="audit-select"
              value={draft.config.riskPolicy.liveDeploys}
              onChange={(event) => setDraft((prev) => ({
                ...prev,
                config: {
                  ...prev.config,
                  riskPolicy: { ...prev.config.riskPolicy, liveDeploys: event.target.value as BuilderWorkflowInput["config"]["riskPolicy"]["liveDeploys"] },
                },
              }))}
            >
              <option value="disabled">disabled</option>
              <option value="manual-approval">manual-approval</option>
            </select>
          </label>
          <label className="builder-checkbox">
            <input
              type="checkbox"
              checked={draft.config.backupPolicy.enabled}
              onChange={(event) => setDraft((prev) => ({
                ...prev,
                config: {
                  ...prev.config,
                  backupPolicy: { ...prev.config.backupPolicy, enabled: event.target.checked },
                },
              }))}
            />
            backup
          </label>
          <label className="builder-checkbox">
            <input
              type="checkbox"
              checked={draft.config.backupPolicy.beforeRun}
              onChange={(event) => setDraft((prev) => ({
                ...prev,
                config: {
                  ...prev.config,
                  backupPolicy: { ...prev.config.backupPolicy, beforeRun: event.target.checked },
                },
              }))}
            />
            before run
          </label>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            <Save size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkflowActions({
  workflow,
  onMutated,
}: {
  workflow: { id: string; status: string };
  onMutated: () => void;
}) {
  const [loading, setLoading] = useState(false);

  async function act(action: string) {
    setLoading(true);
    try {
      const response = await authFetch(`/api/builder/workflows/${workflow.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const text = await response.text();
        console.error(`builder ${action} failed`, text);
      }
    } finally {
      setLoading(false);
      onMutated();
    }
  }

  const canStart = workflow.status === "ready" || workflow.status === "draft";
  const canStop = workflow.status === "running";
  const canPause = workflow.status === "running" || workflow.status === "ready";
  const canResume = workflow.status === "paused";

  return (
    <div className="builder-action-row">
      {canStart && (
        <button className="btn btn-xs btn-primary" onClick={() => act("start")} disabled={loading} title="start run">
          <Play size={12} />
        </button>
      )}
      {canStop && (
        <button className="btn btn-xs btn-danger" onClick={() => act("stop")} disabled={loading} title="stop run">
          <Square size={12} />
        </button>
      )}
      {canPause && (
        <button className="btn btn-xs btn-ghost" onClick={() => act("pause")} disabled={loading} title="pause">
          <Pause size={12} />
        </button>
      )}
      {canResume && (
        <button className="btn btn-xs btn-ghost" onClick={() => act("resume")} disabled={loading} title="resume">
          <Play size={12} />
        </button>
      )}
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: BuilderArtifact }) {
  return (
    <tr>
      <td><Pill>{artifact.kind}</Pill></td>
      <td className="mono trunc">{artifact.path}</td>
      <td className="mono dim">{artifact.createdAt ? fmtTs(artifact.createdAt) : "-"}</td>
    </tr>
  );
}

function ValidationRow({ validation }: { validation: BuilderValidation }) {
  return (
    <tr>
      <td><Pill color={statusColor(validation.status)}>{validation.status}</Pill></td>
      <td><Pill>{validation.kind}</Pill></td>
      <td className="mono trunc">{validation.command ?? (validation.url ?? "-")}</td>
      <td className="mono dim">{validation.startedAt ? fmtTs(validation.startedAt) : "-"}</td>
      <td className="mono dim">{validation.finishedAt ? fmtTs(validation.finishedAt) : "-"}</td>
      <td className="mono trunc">
        {validation.error ? <span className="text-red">{validation.error.slice(0, 80)}</span> : "-"}
      </td>
    </tr>
  );
}

function RunDetailPanel({
  runDetail,
  loading,
  error,
  onClose,
}: {
  runDetail: BuilderRunResponse | undefined;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const run = runDetail?.run;
  const passes = runDetail?.passes ?? [];
  const artifacts = runDetail?.artifacts ?? [];
  const validations = runDetail?.validations ?? [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box builder-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Run detail
          {run && <span className="mono dim" style={{ marginLeft: 12 }}>{run.id}</span>}
          <button className="btn btn-xs btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose}>✕</button>
        </div>

        {loading && !runDetail && <div className="loading-dim">loading...</div>}
        {error && !runDetail && <div className="loading-dim error">error: {error}</div>}

        {runDetail && (
          <div className="builder-detail-body">
            {run && (
              <div className="builder-detail-meta builder-kv-grid">
                <div><span>status</span><strong><Pill color={statusColor(run.status)}>{run.status}</Pill></strong></div>
                <div><span>trigger</span><strong><Pill>{run.trigger}</Pill></strong></div>
                <div><span>started</span><strong className="mono">{fmtTs(run.startedAt)}</strong></div>
                <div><span>finished</span><strong className="mono">{fmtTs(run.finishedAt)}</strong></div>
                {run.error && <div><span>error</span><strong className="text-red mono">{run.error.slice(0, 120)}</strong></div>}
              </div>
            )}

            {passes.length > 0 && (
              <div className="builder-detail-section">
                <div className="builder-detail-section-title">passes</div>
                <table className="data-table">
                  <thead><tr><th>seq</th><th>phase</th><th>agent</th><th>model</th><th>status</th><th>started</th><th>finished</th></tr></thead>
                  <tbody>
                    {passes.map((pass: BuilderPass) => (
                      <tr key={pass.id}>
                        <td>{pass.sequence}</td>
                        <td><Pill>{pass.phase}</Pill></td>
                        <td><Pill>{pass.agent ?? "-"}</Pill></td>
                        <td className="mono dim">{pass.model ?? "-"}</td>
                        <td><Pill color={statusColor(pass.status)}>{pass.status}</Pill></td>
                        <td className="mono dim">{fmtTs(pass.startedAt)}</td>
                        <td className="mono dim">{fmtTs(pass.finishedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {artifacts.length > 0 && (
              <div className="builder-detail-section">
                <div className="builder-detail-section-title">artifacts</div>
                <table className="data-table">
                  <thead><tr><th>kind</th><th>path</th><th>created</th></tr></thead>
                  <tbody>
                    {artifacts.map((artifact: BuilderArtifact) => (
                      <ArtifactRow key={artifact.id} artifact={artifact} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {validations.length > 0 && (
              <div className="builder-detail-section">
                <div className="builder-detail-section-title">validation results</div>
                <table className="data-table">
                  <thead><tr><th>status</th><th>kind</th><th>command/url</th><th>started</th><th>finished</th><th>error</th></tr></thead>
                  <tbody>
                    {validations.map((validation: BuilderValidation) => (
                      <ValidationRow key={validation.id} validation={validation} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {validations.length === 0 && passes.length === 0 && artifacts.length === 0 && (
              <div className="loading-dim">no passes, artifacts, or validations yet</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function BuilderPage() {
  const [selectedRoot, setSelectedRoot] = useState("/opt/opencode-control-surface");
  const [creating, setCreating] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const projectsApi = useAuthenticatedApi<BuilderProjectsResponse>("/api/builder/projects", 60_000);
  const discoverApi = useAuthenticatedApi<BuilderDiscovery>(
    `/api/builder/discover?root=${encodeURIComponent(selectedRoot)}`,
    30_000,
  );
  const workflowsApi = useAuthenticatedApi<BuilderWorkflowsResponse>("/api/builder/workflows", 30_000);
  const runsApi = useAuthenticatedApi<BuilderRunsResponse>("/api/builder/runs", 15_000);
  const runDetailUrl = selectedRunId ? `/api/builder/runs/${selectedRunId}` : "";
  const runDetailApi = useAuthenticatedApi<BuilderRunResponse>(runDetailUrl, 15_000);

  const projects = projectsApi.data?.projects ?? [];
  const data = discoverApi.data;
  const workflows = workflowsApi.data?.workflows ?? [];
  const runs = runsApi.data?.runs ?? [];

  useEffect(() => {
    if (!projects.length) return;
    if (!projects.some((project) => project.root === selectedRoot)) {
      setSelectedRoot(projects[0].root);
    }
  }, [projects, selectedRoot]);

  // Poll runs when any workflow is running
  useEffect(() => {
    const anyRunning = workflows.some((w) => w.status === "running");
    if (!anyRunning) return;
    const interval = setInterval(() => {
      runsApi.refresh();
      workflowsApi.refresh();
    }, 5000);
    return () => clearInterval(interval);
  }, [workflows, runsApi, workflowsApi]);

  const stats = useMemo(() => ({
    plans: data?.planCandidates.filter((plan) => plan.exists).length ?? 0,
    skillsOk: data?.skills.filter((skill) => skill.status === "ok").length ?? 0,
    missing: data?.missingPrerequisites.length ?? 0,
    dirty: data?.git.dirty ?? false,
    runningRuns: runs.filter((r) => r.status === "running").length,
  }), [data, runs]);

  if ((projectsApi.loading || discoverApi.loading) && !data) {
    return <div className="loading-dim">loading...</div>;
  }

  if ((projectsApi.error || discoverApi.error) && !data) {
    return <div className="loading-dim error">error: {projectsApi.error ?? discoverApi.error}</div>;
  }

  return (
    <div className="dash-page">
      <div className="page-header builder-header">
        <div>
          <div className="page-title">Builder</div>
          <div className="page-subtitle">One-pass runner with tmux isolation. Start, stop, and inspect agent runs.</div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={() => { discoverApi.refresh(); workflowsApi.refresh(); runsApi.refresh(); }} disabled={discoverApi.loading}>
          <RefreshCw size={14} /> refresh
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)} disabled={!data}>
          <Plus size={14} /> workflow
        </button>
      </div>

      <div className="action-bar audit-filter-bar">
        <select
          className="audit-select builder-project-select"
          value={selectedRoot}
          onChange={(event) => setSelectedRoot(event.target.value)}
        >
          {projects.map((project: BuilderProject) => (
            <option key={project.root} value={project.root}>{project.label} - {project.root}</option>
          ))}
        </select>
      </div>

      <div className="stat-row">
        <div className="stat-item"><div className="stat-val">{stats.plans}</div><div className="stat-lbl">plans</div></div>
        <div className="stat-item"><div className="stat-val">{stats.skillsOk}</div><div className="stat-lbl">skills ok</div></div>
        <div className="stat-item"><div className="stat-val">{stats.missing}</div><div className="stat-lbl">missing</div></div>
        <div className="stat-item"><div className="stat-val">{stats.dirty ? "dirty" : "clean"}</div><div className="stat-lbl">git</div></div>
        <div className="stat-item"><div className="stat-val">{stats.runningRuns}</div><div className="stat-lbl">running</div></div>
      </div>

      {data && (
        <>
          {creating && (
            <WorkflowModal
              data={data}
              selectedRoot={selectedRoot}
              onClose={() => setCreating(false)}
              onSaved={() => {
                setCreating(false);
                workflowsApi.refresh();
              }}
            />
          )}

          {data.missingPrerequisites.length > 0 ? (
            <div className="builder-prereq warn">
              <XCircle size={16} />
              <span>Missing prerequisites: {data.missingPrerequisites.join(", ")}</span>
            </div>
          ) : (
            <div className="builder-prereq ok">
              <CheckCircle2 size={16} />
              <span>Phase 1 prerequisites found for this project.</span>
            </div>
          )}

          <SectionCard
            title="workflows"
            defaultOpen={true}
            right={<span className="mono dim">{workflows.length} saved</span>}
          >
            <div className="section-card-body table-wrap">
              {workflowsApi.data?.degraded ? (
                <div className="loading-dim">degraded: {workflowsApi.data.reason}</div>
              ) : workflows.length === 0 ? (
                <div className="loading-dim">no workflows</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>status</th><th>mode</th><th>name</th><th>project</th><th>plan</th><th>agents</th><th>validation</th><th>actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workflows.map((workflow) => (
                      <tr key={workflow.id}>
                        <td><Pill color={statusColor(workflow.status)}>{workflow.status}</Pill></td>
                        <td><Pill>{workflow.mode}</Pill></td>
                        <td>{workflow.name}</td>
                        <td className="mono trunc">{workflow.projectRoot}</td>
                        <td className="mono trunc">{workflow.planFile}</td>
                        <td>{workflow.config.agentOrder.join(" -> ")}</td>
                        <td>{workflow.config.validationProfile.commands.length} checks</td>
                        <td>
                          <WorkflowActions
                            workflow={workflow}
                            onMutated={() => { workflowsApi.refresh(); runsApi.refresh(); }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="runs"
            defaultOpen={true}
            right={<span className="mono dim">{runs.length} total</span>}
          >
            <div className="section-card-body table-wrap">
              {runsApi.data?.degraded ? (
                <div className="loading-dim">degraded: {runsApi.data.reason}</div>
              ) : runs.length === 0 ? (
                <div className="loading-dim">no runs yet</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>status</th><th>trigger</th><th>started</th><th>finished</th><th>pass</th><th>error</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run: BuilderRun) => (
                      <tr key={run.id} className="clickable-row" onClick={() => setSelectedRunId(run.id)}>
                        <td><Pill color={statusColor(run.status)}>{run.status}</Pill></td>
                        <td><Pill>{run.trigger}</Pill></td>
                        <td className="mono dim">{fmtTs(run.startedAt)}</td>
                        <td className="mono dim">{fmtTs(run.finishedAt)}</td>
                        <td className="mono trunc">{run.currentPassId ?? "-"}</td>
                        <td className="mono trunc">{run.error ? run.error.slice(0, 60) : "-"}</td>
                        <td><ChevronRight size={14} className="row-chevron" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </SectionCard>

          <div className="widget-grid wide">
            <SectionCard title="project" defaultOpen={true}>
              <div className="section-card-body builder-kv-grid">
                <div><span>root</span><strong>{data.project.root}</strong></div>
                <div><span>service</span><strong>{data.project.service ?? "-"}</strong></div>
                <div><span>risk</span><strong>{data.project.risk}</strong></div>
                <div><span>internal</span><strong>{data.urls.internal ?? "-"}</strong></div>
                <div><span>public</span><strong>{data.urls.public ?? "-"}</strong></div>
                <div><span>health</span><strong>{data.urls.health ?? "-"}</strong></div>
              </div>
            </SectionCard>

            <SectionCard title="git state" defaultOpen={true}>
              <div className="section-card-body">
                <div className="builder-pill-row">
                  <Pill color={statusColor(data.git.status)}>{data.git.status}</Pill>
                  <Pill color={statusColor(data.git.dirty ? "dirty" : "clean")}>{data.git.dirty ? "dirty" : "clean"}</Pill>
                  <Pill>{data.git.changed} changed</Pill>
                  <Pill>{data.git.untracked} untracked</Pill>
                </div>
                <div className="builder-kv-grid">
                  <div><span>root</span><strong>{data.git.root ?? "-"}</strong></div>
                  <div><span>branch</span><strong>{data.git.branch ?? "-"}</strong></div>
                  <div><span>head</span><strong>{data.git.head ?? "-"}</strong></div>
                  <div><span>evidence</span><strong>{data.git.evidence}</strong></div>
                </div>
                {data.git.statusLines.length > 0 && (
                  <pre className="audit-pre builder-status-pre">{data.git.statusLines.join("\n")}</pre>
                )}
              </div>
            </SectionCard>
          </div>

          <SectionCard
            title="plan candidates"
            defaultOpen={true}
            right={<span className="mono dim">{data.planCandidates.length} files</span>}
          >
            <div className="section-card-body table-wrap">
              <table className="data-table">
                <thead><tr><th>status</th><th>kind</th><th>title</th><th>path</th><th>modified</th></tr></thead>
                <tbody>
                  {data.planCandidates.map((plan) => (
                    <tr key={plan.path}>
                      <td><Pill color={statusColor(plan.exists)}>{plan.exists ? "found" : "missing"}</Pill></td>
                      <td><Pill>{plan.kind}</Pill></td>
                      <td>{plan.title}</td>
                      <td className="mono trunc">{plan.path}</td>
                      <td className="mono dim">{fmtTs(plan.modifiedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <div className="widget-grid wide">
            <SectionCard title="validation profile" defaultOpen={true}>
              <div className="section-card-body">
                <div className="builder-pill-row">
                  <Pill color={statusColor(data.validation.status)}>{data.validation.status}</Pill>
                  <Pill>{data.validation.packageManager}</Pill>
                </div>
                <div className="builder-command-list">
                  {data.validation.commands.length === 0 ? (
                    <div className="loading-dim">no commands inferred</div>
                  ) : data.validation.commands.map((command) => (
                    <code key={command}>{command}</code>
                  ))}
                </div>
              </div>
            </SectionCard>

            <SectionCard title="agents and models" defaultOpen={true}>
              <div className="section-card-body">
                <div className="builder-pill-row">
                  <AgentPill label="codex" status={data.agents.codex} />
                  <AgentPill label="claude" status={data.agents.claude} />
                  <AgentPill label="opencode" status={data.agents.opencode} />
                </div>
                <ModelSummary models={data.models} />
                {data.models.sample.length > 0 && (
                  <div className="builder-command-list compact">
                    {data.models.sample.map((model) => <code key={model}>{model}</code>)}
                  </div>
                )}
              </div>
            </SectionCard>
          </div>

          <SectionCard
            title="skills"
            defaultOpen={true}
            right={<span className="mono dim">{data.skills.length} checked</span>}
          >
            <div className="section-card-body table-wrap">
              <table className="data-table">
                <thead><tr><th>status</th><th>name</th><th>path</th><th>description</th></tr></thead>
                <tbody>
                  {data.skills.map((skill) => <SkillRow key={skill.path} skill={skill} />)}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}

      {selectedRunId && (
        <RunDetailPanel
          runDetail={runDetailApi.data}
          loading={runDetailApi.loading}
          error={runDetailApi.error}
          onClose={() => {
            setSelectedRunId(null);
            runsApi.refresh();
            workflowsApi.refresh();
          }}
        />
      )}
    </div>
  );
}
