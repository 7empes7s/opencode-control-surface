import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, GripVertical, Pause, Pencil, Play, Plus, RefreshCw, Save, Square, Trash2, XCircle } from "lucide-react";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { authFetch } from "../lib/authFetch";
import { SectionCard } from "../components/SectionCard";
import type {
  BuilderDiscovery,
  BuilderModelsInventory,
  BuilderProject,
  BuilderSkillStatus,
} from "../../server/builder/discovery";
import type { BuilderWorkflow, BuilderWorkflowInput, BuilderDoctorReport } from "../../server/builder/store";
import type {
  BuilderProjectsResponse,
  BuilderDoctorReportsResponse,
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

function ModeBadge({ mode }: { mode: string }) {
  const colors: Record<string, string> = {
    "once": "gray", "auto-continue": "blue", "scheduled": "amber",
    "permanent": "green", "doctor": "purple", "plan": "blue",
  };
  return <Pill color={colors[mode] ?? "gray"}>{mode}</Pill>;
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

function fmtCtx(ctx: number | null): string {
  if (!ctx) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
  return String(ctx);
}

function ButtonGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="modal-input-row">
      <span className="modal-input-label">{label}</span>
      <div className="builder-btn-group">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`builder-btn-group-item${value === opt.value ? " active" : ""}`}
            title={opt.title}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModelSelect({
  label,
  value,
  onChange,
  models,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  models: BuilderModelsInventory;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const allModels = useMemo(() => [
    { label: "heavy", items: models.heavy },
    { label: "medium", items: models.medium },
    { label: "light", items: models.light },
    { label: "OpenCode native", items: models.opencode },
    { label: "Zen", items: models.zen ?? [] },
    { label: "Alibaba", items: models.alibaba ?? [] },
  ], [models]);

  const selectedModel = useMemo(() => {
    for (const group of allModels) {
      const found = group.items.find((m) => m.name === value);
      if (found) return found;
    }
    return null;
  }, [allModels, value]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return allModels
      .map((group) => ({
        label: group.label,
        items: q
          ? group.items.filter((m) =>
              m.name.toLowerCase().includes(q) ||
              m.label.toLowerCase().includes(q) ||
              m.provider.toLowerCase().includes(q)
            )
          : group.items,
      }))
      .filter((group) => group.items.length > 0);
  }, [allModels, filter]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="modal-input-row" ref={containerRef}>
      <span className="modal-input-label">{label}</span>
      <button
        type="button"
        className="builder-model-select-trigger"
        onClick={() => { setOpen((o) => !o); setFilter(""); }}
      >
        {value ? (
          <span className="builder-model-select-current">
            {selectedModel ? (
              <>
                <span className="builder-model-select-name">{selectedModel.name}</span>
                <span className="builder-model-select-meta">
                  {selectedModel.isFree && <span className="pill green">free</span>}
                  {selectedModel.isPaid && !selectedModel.isFree && <span className="pill amber">paid</span>}
                  {selectedModel.supportsImage && <span className="pill blue">img</span>}
                  {selectedModel.supportsVideo && <span className="pill blue">vid</span>}
                  {selectedModel.rating != null && <span className="pill gray">{selectedModel.rating.toFixed(0)}/100</span>}
                </span>
              </>
            ) : (
              value
            )}
          </span>
        ) : (
          <span className="builder-model-select-placeholder">auto (health-based)</span>
        )}
        <ChevronDown size={14} className={open ? "rotated" : ""} />
      </button>

      {open && (
        <div className="builder-model-select-dropdown">
          <input
            className="modal-input builder-model-select-filter"
            placeholder="Filter models…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <div className="builder-model-select-list">
            <button
              type="button"
              className={`builder-model-select-row${!value ? " active" : ""}`}
              onClick={() => { onChange(""); setOpen(false); }}
            >
              <span className="builder-model-select-row-name">auto (health-based)</span>
            </button>
            {filtered.map((group) => (
              <div key={group.label} className="builder-model-select-group">
                <div className="builder-model-select-group-label">{group.label}</div>
                {group.items.map((m) => (
                  <button
                    type="button"
                    key={m.name}
                    className={`builder-model-select-row${value === m.name ? " active" : ""}`}
                    onClick={() => { onChange(m.name); setOpen(false); }}
                  >
                    <div className="builder-model-select-row-main">
                      <span className="builder-model-select-row-name">{m.name}</span>
                      <span className="builder-model-select-row-badges">
                        {m.isFree && <span className="pill green">free</span>}
                        {m.isPaid && !m.isFree && <span className="pill amber">paid</span>}
                        {m.supportsImage && <span className="pill blue" title="image">img</span>}
                        {m.supportsVideo && <span className="pill blue" title="video">vid</span>}
                        {m.supportsText && <span className="pill gray" title="text">txt</span>}
                      </span>
                    </div>
                    <div className="builder-model-select-row-meta">
                      <span>ctx {fmtCtx(m.contextWindow)}</span>
                      {m.rating != null && <span>rating {m.rating.toFixed(0)}/100</span>}
                      {m.latency != null && <span>{m.latency}ms</span>}
                      <span className={`pill ${m.qualityStatus === "healthy" ? "green" : m.qualityStatus === "blocked" ? "red" : "amber"}`}>{m.qualityStatus}</span>
                    </div>
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="builder-model-select-empty">no models match</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type PickerOption = {
  id: string;
  label: string;
  status?: string;
};

function uniqueList(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function OrderedPicker({
  label,
  value,
  onChange,
  options,
  emptyText = "none selected",
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  options: PickerOption[];
  emptyText?: string;
}) {
  const normalized = uniqueList(value);
  const known = new Map(options.map((option) => [option.id, option]));
  const mergedOptions = [
    ...options,
    ...normalized.filter((id) => !known.has(id)).map((id) => ({ id, label: id, status: "saved" })),
  ];
  const [selectedToAdd, setSelectedToAdd] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const addable = mergedOptions.filter((option) => !normalized.includes(option.id));

  function move(id: string, direction: -1 | 1) {
    const index = normalized.indexOf(id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= normalized.length) return;
    const next = [...normalized];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onChange(next);
  }

  function remove(id: string) {
    onChange(normalized.filter((item) => item !== id));
  }

  function add(id: string) {
    if (!id) return;
    onChange(uniqueList([...normalized, id]));
    setSelectedToAdd("");
  }

  function dropOn(target: string) {
    if (!dragged || dragged === target) return;
    const sourceIndex = normalized.indexOf(dragged);
    const targetIndex = normalized.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...normalized];
    const [item] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, item);
    onChange(next);
    setDragged(null);
  }

  return (
    <div className="modal-input-row builder-form-wide">
      <span className="modal-input-label">{label}</span>
      <div className="builder-ordered-picker">
        {normalized.length === 0 ? (
          <div className="builder-picker-empty">{emptyText}</div>
        ) : normalized.map((id, index) => {
          const option = mergedOptions.find((item) => item.id === id) ?? { id, label: id };
          return (
            <div
              key={id}
              className="builder-picker-row"
              draggable
              onDragStart={() => setDragged(id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => dropOn(id)}
            >
              <GripVertical size={14} className="builder-picker-grip" />
              <div className="builder-picker-main">
                <span>{option.label}</span>
                <code>{id}</code>
              </div>
              {option.status && <Pill color={statusColor(option.status)}>{option.status}</Pill>}
              <button className="btn btn-xs btn-ghost" type="button" title="move up" disabled={index === 0} onClick={() => move(id, -1)}>
                <ArrowUp size={12} />
              </button>
              <button className="btn btn-xs btn-ghost" type="button" title="move down" disabled={index === normalized.length - 1} onClick={() => move(id, 1)}>
                <ArrowDown size={12} />
              </button>
              <button className="btn btn-xs btn-danger" type="button" title="remove" onClick={() => remove(id)}>
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
        <div className="builder-picker-add">
          <select className="audit-select" value={selectedToAdd} onChange={(event) => setSelectedToAdd(event.target.value)}>
            <option value="">add...</option>
            {addable.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <button className="btn btn-sm btn-ghost" type="button" disabled={!selectedToAdd} onClick={() => add(selectedToAdd)}>
            <Plus size={14} /> add
          </button>
        </div>
      </div>
    </div>
  );
}

function workflowDefaults(data: BuilderDiscovery, projectRoot: string): BuilderWorkflowInput {
  const plan = data.planCandidates.find((item) => item.exists && item.kind === "builder")
    ?? data.planCandidates.find((item) => item.exists && item.kind === "canonical")
    ?? data.planCandidates.find((item) => item.exists);
  const healthyAgents = data.agents.options.filter((agent) => agent.status === "ok").map((agent) => agent.id);
  return {
    name: `${data.project.label} builder pass`,
    projectRoot,
    planFile: plan?.path ?? "",
    mode: "once",
    status: "draft",
    config: {
      projectRoot,
      agentOrder: healthyAgents.length > 0
        ? [
            ...healthyAgents.filter((a) => a === "opencode"),
            ...healthyAgents.filter((a) => a !== "opencode").map((a) => {
              if (a === "gemini") return "gemini:gemini-2.5-flash:high";
              if (a === "codex") return "codex:o4-mini:medium";
              if (a === "claude") return "claude:claude-sonnet-4:medium";
              return a;
            }),
          ]
        : data.agents.options.map((agent) => agent.id),
      modelPolicy: {
        planner: data.models.bestCloudHeavy ?? undefined,
        builder: data.models.bestCloudFast ?? data.models.bestCloudHeavy ?? undefined,
        reviewer: data.models.bestCloudHeavy ?? undefined,
        fallbackTargets: data.models.fallbackTargets.slice(0, 8),
      },
      validationProfile: {
        commands: data.validation.commands,
        internal: data.validation.commands,
        runtime: [],
        public: [],
        playwright: { enabled: false },
        internalUrl: data.urls.internal,
        publicUrl: data.urls.public,
      },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: true, beforeRun: true },
      riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
      geminiApprovalMode: "auto_edit",
    },
  };
}

function workflowInputFromExisting(workflow: BuilderWorkflow): BuilderWorkflowInput {
  return {
    name: workflow.name,
    projectRoot: workflow.projectRoot,
    planFile: workflow.planFile,
    mode: workflow.mode,
    status: workflow.status === "ready" ? "ready" : "draft",
    nextRunAt: workflow.nextRunAt,
    pausedReason: workflow.pausedReason,
    config: workflow.config,
  };
}

function WorkflowModal({
  data,
  selectedRoot,
  workflow,
  onClose,
  onSaved,
}: {
  data: BuilderDiscovery;
  selectedRoot: string;
  workflow?: BuilderWorkflow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<BuilderWorkflowInput>(() => workflow ? workflowInputFromExisting(workflow) : workflowDefaults(data, selectedRoot));
  const [agentOrder, setAgentOrder] = useState<string[]>(draft.config.agentOrder);
  const [fallbackTargets, setFallbackTargets] = useState<string[]>(draft.config.modelPolicy.fallbackTargets);
  const [internalCommands, setInternalCommands] = useState(draft.config.validationProfile.internal.join("\n"));
  const [runtimeCommands, setRuntimeCommands] = useState(draft.config.validationProfile.runtime.join("\n"));
  const [publicCommands, setPublicCommands] = useState(draft.config.validationProfile.public.join("\n"));
  const [playwrightEnabled, setPlaywrightEnabled] = useState(draft.config.validationProfile.playwright?.enabled ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelOptions: PickerOption[] = [...data.models.heavy, ...data.models.medium, ...data.models.light, ...data.models.opencode, ...(data.models.zen ?? []), ...(data.models.alibaba ?? [])]
    .map((model) => ({ id: model.name, label: model.label, status: model.qualityStatus }));
  const agentOptions: PickerOption[] = data.agents.options
    .map((agent) => ({ id: agent.id, label: agent.label, status: agent.status }));
  const selectablePlans = data.planCandidates.filter((plan) => plan.exists || draft.mode === "plan");

  async function save() {
    setSaving(true);
    setError(null);
    const effectiveRoot = workflow?.projectRoot ?? selectedRoot;
    const payload: BuilderWorkflowInput = {
      ...draft,
      projectRoot: effectiveRoot,
      config: {
        ...draft.config,
        projectRoot: effectiveRoot,
        agentOrder: uniqueList(agentOrder),
        modelPolicy: {
          ...draft.config.modelPolicy,
          fallbackTargets: uniqueList(fallbackTargets),
        },
        validationProfile: {
          ...draft.config.validationProfile,
          commands: internalCommands.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
          internal: internalCommands.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
          runtime: runtimeCommands.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
          public: publicCommands.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
          playwright: { enabled: playwrightEnabled },
        },
      },
    };

    try {
      const response = await authFetch(workflow ? `/api/builder/workflows/${workflow.id}` : "/api/builder/workflows", {
        method: workflow ? "PUT" : "POST",
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
      <div className="modal-box builder-workflow-modal structured" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{workflow ? "Edit workflow" : "New workflow"}</div>
          <button className="btn btn-xs btn-ghost modal-close" onClick={onClose} disabled={saving} aria-label="close">✕</button>
        </div>
        <div className="modal-body">
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
              {selectablePlans.map((plan) => (
                <option key={plan.path} value={plan.path} disabled={!plan.exists && draft.mode !== "plan"}>
                  {plan.exists ? "" : "create: "}{plan.title} - {plan.path}
                </option>
              ))}
            </select>
          </label>
          <ButtonGroup
            label="Mode"
            value={draft.mode}
            onChange={(v) => setDraft((prev) => ({ ...prev, mode: v as BuilderWorkflowInput["mode"] }))}
            options={[
              { value: "once", label: "once" },
              { value: "plan", label: "plan" },
              { value: "auto-continue", label: "auto" },
              { value: "scheduled", label: "sched" },
              { value: "permanent", label: "perm" },
              { value: "doctor", label: "doctor" },
            ]}
          />
          {(draft.mode === "scheduled" || draft.mode === "permanent") && (
            <>
              <label className="modal-input-row">
                <span className="modal-input-label">Cron expression</span>
                <input
                  className="modal-input"
                  placeholder="*/5 * * * *"
                  value={draft.config.schedule?.expression ?? ""}
                  onChange={(event) => setDraft((prev) => ({
                    ...prev,
                    config: { ...prev.config, schedule: { ...prev.config.schedule, expression: event.target.value } },
                  }))}
                />
              </label>
              <label className="modal-input-row">
                <span className="modal-input-label">Timezone</span>
                <select
                  className="audit-select"
                  value={draft.config.schedule?.timezone ?? "UTC"}
                  onChange={(event) => setDraft((prev) => ({
                    ...prev,
                    config: { ...prev.config, schedule: { ...prev.config.schedule, timezone: event.target.value } },
                  }))}
                >
                  <option value="UTC">UTC</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="Europe/Paris">Europe/Paris</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                </select>
              </label>
            </>
          )}
          <ButtonGroup
            label="Status"
            value={draft.status}
            onChange={(v) => setDraft((prev) => ({ ...prev, status: v as BuilderWorkflowInput["status"] }))}
            options={[
              { value: "draft", label: "draft" },
              { value: "ready", label: "ready" },
            ]}
          />
          <OrderedPicker label="Agent order" value={agentOrder} onChange={setAgentOrder} options={agentOptions} />
          <OrderedPicker label="Fallback targets" value={fallbackTargets} onChange={setFallbackTargets} options={modelOptions} />
          <ModelSelect
            label="Planner"
            value={draft.config.modelPolicy.planner ?? ""}
            onChange={(value) => setDraft((prev) => ({
              ...prev,
              config: { ...prev.config, modelPolicy: { ...prev.config.modelPolicy, planner: value || undefined } },
            }))}
            models={data.models}
          />
          <ModelSelect
            label="Builder"
            value={draft.config.modelPolicy.builder ?? ""}
            onChange={(value) => setDraft((prev) => ({
              ...prev,
              config: { ...prev.config, modelPolicy: { ...prev.config.modelPolicy, builder: value || undefined } },
            }))}
            models={data.models}
          />
          <ModelSelect
            label="Reviewer"
            value={draft.config.modelPolicy.reviewer ?? ""}
            onChange={(value) => setDraft((prev) => ({
              ...prev,
              config: { ...prev.config, modelPolicy: { ...prev.config.modelPolicy, reviewer: value || undefined } },
            }))}
            models={data.models}
          />
          <label className="modal-input-row builder-form-wide">
            <span className="modal-input-label">internal</span>
            <textarea
              className="modal-input builder-textarea"
              value={internalCommands}
              onChange={(event) => setInternalCommands(event.target.value)}
              placeholder="bun run typecheck&#10;bun run build&#10;bun test server/db/"
            />
          </label>
          <label className="modal-input-row builder-form-wide">
            <span className="modal-input-label">runtime</span>
            <textarea
              className="modal-input builder-textarea"
              value={runtimeCommands}
              onChange={(event) => setRuntimeCommands(event.target.value)}
              placeholder="ephemeral DB smoke, targeted API checks"
            />
          </label>
          <label className="modal-input-row builder-form-wide">
            <span className="modal-input-label">public</span>
            <textarea
              className="modal-input builder-textarea"
              value={publicCommands}
              onChange={(event) => setPublicCommands(event.target.value)}
              placeholder="Playwright desktop/tablet/iPhone checks"
            />
          </label>
          <label className="builder-checkbox builder-form-wide">
            <input
              type="checkbox"
              checked={playwrightEnabled}
              onChange={(event) => setPlaywrightEnabled(event.target.checked)}
            />
            playwright
          </label>
          <ButtonGroup
            label="Commit"
            value={draft.config.gitPolicy.commit}
            onChange={(v) => setDraft((prev) => ({
              ...prev,
              config: { ...prev.config, gitPolicy: { ...prev.config.gitPolicy, commit: v as BuilderWorkflowInput["config"]["gitPolicy"]["commit"] } },
            }))}
            options={[
              { value: "manual", label: "manual" },
              { value: "after-validation", label: "auto" },
            ]}
          />
          <ButtonGroup
            label="Push"
            value={draft.config.gitPolicy.push}
            onChange={(v) => setDraft((prev) => ({
              ...prev,
              config: { ...prev.config, gitPolicy: { ...prev.config.gitPolicy, push: v as BuilderWorkflowInput["config"]["gitPolicy"]["push"] } },
            }))}
            options={[
              { value: "never", label: "never" },
              { value: "workflow-branch", label: "wf branch" },
              { value: "current-branch", label: "curr branch" },
            ]}
          />
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
          <ButtonGroup
            label="Live deploys"
            value={draft.config.riskPolicy.liveDeploys}
            onChange={(v) => setDraft((prev) => ({
              ...prev,
              config: { ...prev.config, riskPolicy: { ...prev.config.riskPolicy, liveDeploys: v as BuilderWorkflowInput["config"]["riskPolicy"]["liveDeploys"] } },
            }))}
            options={[
              { value: "disabled", label: "disabled" },
              { value: "manual-approval", label: "manual" },
            ]}
          />
          <ButtonGroup
            label="Approval mode"
            value={(draft.config as { geminiApprovalMode?: string }).geminiApprovalMode ?? "auto_edit"}
            onChange={(v) => setDraft((prev) => ({
              ...prev,
              config: { ...prev.config, geminiApprovalMode: v as "default" | "auto_edit" | "plan" | "yolo" },
            }))}
            options={[
              { value: "auto_edit", label: "safe", title: "auto_edit — safe (Gemini)" },
              { value: "plan", label: "plan", title: "plan — read-only (Gemini)" },
              { value: "default", label: "default", title: "default agent behavior" },
              { value: "yolo", label: "yolo", title: "yolo — unrestricted (Gemini)" },
            ]}
          />
          <ButtonGroup
            label="Effort"
            value={(draft.config as { effortLevel?: string }).effortLevel ?? "medium"}
            onChange={(v) => setDraft((prev) => ({
              ...prev,
              config: { ...prev.config, effortLevel: v as "low" | "medium" | "high" },
            }))}
            options={[
              { value: "low", label: "low", title: "Low effort — faster, cheaper (not all models support this)" },
              { value: "medium", label: "med", title: "Medium effort — balanced (default)" },
              { value: "high", label: "high", title: "High effort — deeper reasoning (not all models support this)" },
            ]}
          />
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
        </div>
        <div className="modal-footer">
          {error && <div className="modal-error">{error}</div>}
          <div className="modal-actions">
            <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
              <Save size={14} /> Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkflowActions({
  workflow,
  onMutated,
  onEdit,
  onDoctorReview,
}: {
  workflow: { id: string; status: string };
  onMutated: () => void;
  onEdit: () => void;
  onDoctorReview: () => void;
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

  const canStart = workflow.status === "ready" || workflow.status === "draft" || workflow.status === "done" || workflow.status === "failed";
  const canStop = workflow.status === "running";
  const canPause = workflow.status === "running" || workflow.status === "ready";
  const canResume = workflow.status === "paused" || workflow.status === "blocked";
  const canEdit = workflow.status !== "running";
  const canDelete = workflow.status !== "running";

  async function deleteWorkflow() {
    if (!confirm(`Delete workflow? This will remove the workflow but keep the project files.`)) return;
    setLoading(true);
    try {
      const response = await authFetch(`/api/builder/workflows/${workflow.id}`, { method: "DELETE" });
      if (!response.ok) {
        const text = await response.text();
        console.error("delete failed", text);
      }
    } finally {
      setLoading(false);
      onMutated();
    }
  }

  return (
    <div className="builder-action-row">
      {canEdit && (
        <button className="btn btn-xs btn-ghost" onClick={onEdit} disabled={loading} title="edit workflow">
          <Pencil size={12} />
        </button>
      )}
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
      <button className="btn btn-xs btn-ghost" onClick={onDoctorReview} disabled={loading} title="run doctor review" style={{ marginLeft: 4 }}>
        <RefreshCw size={12} />
      </button>
      {canDelete && (
        <button className="btn btn-xs btn-danger" onClick={deleteWorkflow} disabled={loading} title="delete workflow" style={{ marginLeft: 4 }}>
          <Trash2 size={12} />
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
      <td className="val-status-col"><Pill color={statusColor(validation.status)}>{validation.status}</Pill></td>
      <td className="val-kind-col"><Pill>{validation.kind}</Pill></td>
      <td className="mono trunc val-cmd-col">{validation.command ?? (validation.url ?? "-")}</td>
      <td className="mono dim val-started-col">{validation.startedAt ? fmtTs(validation.startedAt) : "-"}</td>
      <td className="mono dim val-finished-col">{validation.finishedAt ? fmtTs(validation.finishedAt) : "-"}</td>
      <td className="mono trunc val-error-col">
        {validation.error ? <span className="text-red">{validation.error.slice(0, 80)}</span> : ""}
      </td>
    </tr>
  );
}

type BuilderSourceSession = NonNullable<BuilderWorkflow["config"]["sourceSession"]>;

function SourceSessionMini({ source }: { source?: BuilderSourceSession }) {
  if (!source) return <span className="mono dim">-</span>;
  return (
    <div>
      <Pill color="blue">{source.agent}</Pill>
      <div className="mono dim" style={{ marginTop: 4 }}>{source.title || source.sessionId}</div>
      {source.messageCount !== undefined && (
        <div className="text-xs text-dim">{source.messageCount} messages</div>
      )}
    </div>
  );
}

function SourceSessionDetail({ source }: { source?: BuilderSourceSession }) {
  if (!source) return null;
  return (
    <div className="builder-detail-section">
      <div className="builder-detail-section-title">source session</div>
      <div className="builder-kv-grid">
        <div><span>agent</span><strong><Pill color="blue">{source.agent}</Pill></strong></div>
        <div><span>session</span><strong className="mono">{source.sessionId}</strong></div>
        <div><span>title</span><strong>{source.title ?? "-"}</strong></div>
        <div><span>messages</span><strong>{source.messageCount ?? "-"}</strong></div>
        <div><span>directory</span><strong className="mono">{source.directory ?? "-"}</strong></div>
        <div><span>captured</span><strong className="mono">{source.capturedAt ?? "-"}</strong></div>
      </div>
      {source.latestUserPrompt && (
        <div className="builder-detail-log" style={{ marginTop: 10 }}>
          <div className="builder-detail-log-header"><span>latest ask</span></div>
          <div className="builder-detail-log-content"><pre>{source.latestUserPrompt}</pre></div>
        </div>
      )}
      {source.transcriptSummary && (
        <div className="builder-detail-log" style={{ marginTop: 10 }}>
          <div className="builder-detail-log-header"><span>handoff summary</span></div>
          <div className="builder-detail-log-content"><pre>{source.transcriptSummary}</pre></div>
        </div>
      )}
      {source.touchedFiles && source.touchedFiles.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {source.touchedFiles.slice(0, 30).map((file) => (
            <span className="pill gray mono" key={file}>{file}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function CollapsibleLog({ label, content }: { label: string; content: string }) {
  const [open, setOpen] = useState(false);
  if (!content) return null;
  return (
    <div className="builder-detail-log">
      <div className="builder-detail-log-header" onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <span className="builder-log-toggle">{open ? "▲ collapse" : "▼ expand"}</span>
      </div>
      {open && (
        <div className="builder-detail-log-content">
          <pre>{content}</pre>
        </div>
      )}
    </div>
  );
}

function RunDetailPanel({
  runDetail,
  loading,
  error,
  onClose,
  onOpen,
}: {
  runDetail: BuilderRunResponse | undefined;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpen: () => void;
}) {
  const run = runDetail?.run;
  const workflow = runDetail?.workflow;
  const passes = runDetail?.passes ?? [];
  const artifacts = runDetail?.artifacts ?? [];
  const validations = runDetail?.validations ?? [];
  const [passLogs, setPassLogs] = useState<Record<string, { stdout: string; stderr: string }>>({});
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!runDetail?.run) return;
    onOpen();
    const runId = runDetail.run.id;
    const fetchLogs = async () => {
      const logs: Record<string, { stdout: string; stderr: string }> = {};
      for (const pass of passes) {
        try {
          const params = new URLSearchParams({ runId, kind: "stdout", pass: String(pass.sequence) });
          const stdoutRes = await authFetch(`/api/builder/log?${params}`);
          const stderrParams = new URLSearchParams({ runId, kind: "stderr", pass: String(pass.sequence) });
          const stderrRes = await authFetch(`/api/builder/log?${stderrParams}`);
          logs[pass.id] = {
            stdout: stdoutRes.ok ? await stdoutRes.text() : "",
            stderr: stderrRes.ok ? await stderrRes.text() : "",
          };
        } catch {
          logs[pass.id] = { stdout: "", stderr: "" };
        }
      }
      setPassLogs(logs);
    };
    fetchLogs();
    setExpandedLogs({});
  }, [runDetail?.run, passes]);

  function toggleLog(passId: string) {
    setExpandedLogs((prev) => ({ ...prev, [passId]: !prev[passId] }));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box builder-detail-panel structured" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            Run detail
            {run && <span className="mono dim" style={{ marginLeft: 8, fontSize: 11 }}>{run.id.slice(0, 16)}…</span>}
          </div>
          <button className="btn btn-xs btn-ghost modal-close" onClick={onClose} aria-label="close">✕</button>
        </div>
        <div className="modal-body">

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

            <SourceSessionDetail source={workflow?.config.sourceSession} />

            {passes.length > 0 && (
              <div className="builder-detail-section">
                <div className="builder-detail-section-title">passes</div>
                {passes.length > 1 && (
                  <div className="builder-pass-steps">
                    {passes.map((pass: BuilderPass, i: number) => {
                      const isCurrent = pass.status === "running";
                      const isDone = pass.status === "success" || pass.status === "failed" || pass.status === "canceled";
                      return (
                        <div key={pass.id} style={{ display: "flex", alignItems: "center", flex: i < passes.length - 1 ? 1 : "none" }}>
                          <div className="builder-pass-step">
                            <div className={`builder-pass-step-dot ${isCurrent ? "current" : isDone && pass.status === "success" ? "success" : isDone ? "failed" : ""}`}>
                              {pass.sequence}
                            </div>
                            <div className="builder-pass-step-label">{pass.phase ?? pass.agent ?? `pass ${pass.sequence}`}</div>
                          </div>
                          {i < passes.length - 1 && (
                            <div className={`builder-pass-step-connector ${pass.status === "success" ? "done" : ""}`} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="table-wrap">
                <table className="data-table run-passes-table">
                  <colgroup>
                    <col className="seq-col" />
                    <col className="phase-col" />
                    <col className="agent-col" />
                    <col className="model-col" />
                    <col className="status-col" />
                    <col className="started-col" />
                    <col className="finished-col" />
                  </colgroup>
                  <thead><tr><th className="seq-col">seq</th><th>phase</th><th>agent</th><th className="model-col">model</th><th>status</th><th className="started-col">started</th><th className="finished-col">finished</th></tr></thead>
                  <tbody>
                    {passes.map((pass: BuilderPass) => (
                      <tr key={pass.id}>
                        <td className="seq-col">{pass.sequence}</td>
                        <td><Pill>{pass.phase}</Pill></td>
                        <td><Pill>{pass.agent ?? "-"}</Pill></td>
                        <td className="mono dim model-col">{pass.model ?? "-"}</td>
                        <td><Pill color={statusColor(pass.status)}>{pass.status}</Pill></td>
                        <td className="mono dim started-col">{fmtTs(pass.startedAt)}</td>
                        <td className="mono dim finished-col">{fmtTs(pass.finishedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {passes.map((pass: BuilderPass) => {
              const logs = passLogs[pass.id];
              const isOpen = expandedLogs[pass.id] ?? false;
              return (
                <div key={pass.id} style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", cursor: "pointer", background: isOpen ? "var(--bg-card-start)" : "transparent" }}
                    onClick={() => toggleLog(pass.id)}
                  >
                    <Pill color={statusColor(pass.status)}>pass {pass.sequence}</Pill>
                    <span className="mono dim" style={{ fontSize: 11 }}>{pass.agent ?? "-"} / {pass.model ?? "-"}</span>
                    <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>
                      {logs ? (logs.stdout.length + logs.stderr.length) + " chars" : "loading..."}
                    </span>
                    <span style={{ color: "var(--text-dim)" }}>{isOpen ? "▲" : "▼"}</span>
                  </div>
                  {isOpen && logs && (
                    <div style={{ borderTop: "1px solid var(--border)" }}>
                      {logs.stdout && (
                        <div>
                          <div style={{ padding: "6px 14px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", background: "color-mix(in oklch, white 2%, transparent)", borderBottom: "1px solid var(--border)" }}>
                            stdout
                          </div>
                          <pre style={{ padding: "10px 14px", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-all", background: "color-mix(in oklch, black 15%, transparent)", maxHeight: 200, overflowY: "auto", margin: 0 }}>{logs.stdout}</pre>
                        </div>
                      )}
                      {logs.stderr && (
                        <div>
                          <div style={{ padding: "6px 14px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", background: "color-mix(in oklch, white 2%, transparent)", borderBottom: "1px solid var(--border)" }}>
                            stderr
                          </div>
                          <pre style={{ padding: "10px 14px", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-all", background: "color-mix(in oklch, black 15%, transparent)", maxHeight: 200, overflowY: "auto", margin: 0 }}>{logs.stderr}</pre>
                        </div>
                      )}
                      {!logs.stdout && !logs.stderr && (
                        <div style={{ padding: "12px 14px", color: "var(--text-dim)", fontSize: 12 }}>no logs captured</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {artifacts.length > 0 && (
              <div className="builder-detail-section">
                <div className="builder-detail-section-title">artifacts</div>
                <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>kind</th><th>path</th><th>created</th></tr></thead>
                  <tbody>
                    {artifacts.map((artifact: BuilderArtifact) => (
                      <ArtifactRow key={artifact.id} artifact={artifact} />
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {validations.length > 0 && (
              <div className="builder-detail-section">
                <div className="builder-detail-section-title">validation results</div>
                <div className="table-wrap">
                <table className="data-table run-validations-table">
                  <colgroup>
                    <col className="status-col" />
                    <col className="kind-col" />
                    <col className="command-col" />
                    <col className="started-col" />
                    <col className="finished-col" />
                    <col className="error-col" />
                  </colgroup>
                  <thead><tr><th className="val-status-col">status</th><th className="val-kind-col">kind</th><th className="val-cmd-col">command/url</th><th className="val-started-col">started</th><th className="val-finished-col">finished</th><th className="val-error-col">error</th></tr></thead>
                  <tbody>
                    {validations.map((validation: BuilderValidation) => (
                      <ValidationRow key={validation.id} validation={validation} />
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {validations.length === 0 && passes.length === 0 && artifacts.length === 0 && (
              <div className="loading-dim">no passes, artifacts, or validations yet</div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function CollapsibleSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`builder-detail-section${open ? "" : " closed"}${open ? " open" : ""}`} style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div
        style={{ display: "flex", alignItems: "center", padding: "10px 14px", cursor: "pointer", background: open ? "var(--bg-card-start)" : "transparent", borderBottom: open ? "1px solid var(--border)" : "none" }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" }}>{title}</span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && <div style={{ padding: "12px 14px" }}>{children}</div>}
    </div>
  );
}

function ProvisionModal({
  data,
  onClose,
  onProvisioned,
}: {
  data: BuilderDiscovery;
  onClose: () => void;
  onProvisioned: () => void;
}) {
  const [projectRoot, setProjectRoot] = useState("/opt/provisioned/");
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [owner, setOwner] = useState("");
  const [planFile, setPlanFile] = useState("");
  const [agentOrder, setAgentOrder] = useState<string[]>(
    data.agents.options.filter((agent) => agent.status === "ok").map((agent) => agent.id),
  );
  const [fallbackTargets, setFallbackTargets] = useState<string[]>(data.models.fallbackTargets.slice(0, 5));
  const [internalUrl, setInternalUrl] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agentOptions: PickerOption[] = data.agents.options.map((agent) => ({ id: agent.id, label: agent.label, status: agent.status }));
  const modelOptions: PickerOption[] = [...data.models.heavy, ...data.models.medium, ...data.models.light, ...data.models.opencode, ...(data.models.zen ?? []), ...(data.models.alibaba ?? [])]
    .map((model) => ({ id: model.name, label: model.label, status: model.qualityStatus }));

  async function provision() {
    if (!name.trim()) { setError("name required"); return; }
    if (!projectRoot.trim()) { setError("project root required"); return; }
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const response = await authFetch("/api/builder/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          projectRoot: projectRoot.trim(),
          repoUrl: repoUrl.trim() || undefined,
          description: description.trim() || undefined,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          owner: owner.trim() || undefined,
          planFile: planFile.trim() || undefined,
          agentOrder: uniqueList(agentOrder),
          fallbackTargets: uniqueList(fallbackTargets),
          internalUrl: internalUrl.trim() || undefined,
          publicUrl: publicUrl.trim() || undefined,
          gitPolicy: { commit: "manual", push: "never" },
        }),
      });
      const data = await response.json() as { result?: { ok: boolean; name: string; projectRoot: string; warnings?: string[]; error?: string }; error?: string };
      if (!response.ok || data.error) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      if (data.result?.error) {
        setError(data.result.error);
        return;
      }
      setResult({ ok: true, message: `Provisioned ${data.result?.name} at ${data.result?.projectRoot}` });
      setTimeout(() => {
        onProvisioned();
        onClose();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div className="modal-box builder-workflow-modal structured" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Bootstrap New Project</div>
          <button className="btn btn-xs btn-ghost modal-close" onClick={onClose} disabled={saving} aria-label="close">✕</button>
        </div>
        <div className="modal-body">
        <div className="builder-form-grid">
          <label className="modal-input-row">
            <span className="modal-input-label">Project name <span className="text-red">*</span></span>
            <input className="modal-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My New Project" />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Project root <span className="text-red">*</span></span>
            <input className="modal-input" value={projectRoot} onChange={(e) => setProjectRoot(e.target.value)} placeholder="/opt/provisioned/" />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Git repo URL</span>
            <input className="modal-input" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/user/repo.git (optional)" />
          </label>
          <label className="modal-input-row builder-form-wide">
            <span className="modal-input-label">Description</span>
            <textarea className="modal-input builder-textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this project do?" rows={2} />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Tags</span>
            <input className="modal-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="node, typescript, dashboard (comma-separated)" />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Owner</span>
            <input className="modal-input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="operator" />
          </label>
          <label className="modal-input-row builder-form-wide">
            <span className="modal-input-label">Plan file path</span>
            <input className="modal-input" value={planFile} onChange={(e) => setPlanFile(e.target.value)} placeholder="Leave blank to auto-detect or create stub PLAN.md" />
          </label>
          <OrderedPicker label="Agent order" value={agentOrder} onChange={setAgentOrder} options={agentOptions} />
          <OrderedPicker label="Fallback targets" value={fallbackTargets} onChange={setFallbackTargets} options={modelOptions} />
          <label className="modal-input-row">
            <span className="modal-input-label">Internal URL</span>
            <input className="modal-input" value={internalUrl} onChange={(e) => setInternalUrl(e.target.value)} placeholder="http://127.0.0.1:3000 (optional)" />
          </label>
          <label className="modal-input-row">
            <span className="modal-input-label">Public URL</span>
            <input className="modal-input" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://myapp.example.com (optional)" />
          </label>
        </div>
        </div>
        <div className="modal-footer">
          {result && <div className="modal-success">{result.message}</div>}
          {error && <div className="modal-error">{error}</div>}
          <div className="modal-actions">
            <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-primary" onClick={provision} disabled={saving || Boolean(result)}>
              {saving ? "Provisioning..." : "Bootstrap Project"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DoctorReportModal({
  report,
  onClose,
}: {
  report: BuilderDoctorReport;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box builder-detail-panel structured" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900 }}>
        <div className="modal-header">
          <div className="modal-title">Doctor Report</div>
          <button className="btn btn-xs btn-ghost modal-close" onClick={onClose} aria-label="close">✕</button>
        </div>
        <div className="modal-body">
        <div className="builder-detail-body">
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
            <div style={{ position: "relative", width: 80, height: 80 }}>
              <svg viewBox="0 0 36 36" style={{ width: 80, height: 80 }}>
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke="#e5e7eb" strokeWidth="3" />
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke={report.overallScore >= 80 ? "#22c55e" : report.overallScore >= 50 ? "#f59e0b" : "#ef4444"}
                  strokeWidth="3"
                  strokeDasharray={`${report.overallScore}, 100`}
                  strokeLinecap="round" />
              </svg>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700 }}>
                {report.overallScore}
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Overall Score</div>
              <Pill color={report.verdict === "ready" ? "green" : report.verdict === "needs-work" ? "amber" : "red"}>
                {report.verdict.replace("-", " ")}
              </Pill>
              <div className="text-xs dim" style={{ marginTop: 4 }}>
                {report.createdAt ? fmtTs(report.createdAt) : "—"}
              </div>
            </div>
          </div>

          <CollapsibleSection title={`Code Review — ${report.codeReview?.issues.length ?? 0} issues`} defaultOpen={true}>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              {[
                { label: "error", count: report.codeReview?.issues.filter(i => i.severity === "error").length ?? 0, color: "red" },
                { label: "warning", count: report.codeReview?.issues.filter(i => i.severity === "warning").length ?? 0, color: "amber" },
                { label: "info", count: report.codeReview?.issues.filter(i => i.severity === "info").length ?? 0, color: "gray" },
              ].map(({ label, count, color }) => (
                count > 0 && <Pill key={label} color={color}>{count} {label}</Pill>
              ))}
            </div>
            {report.codeReview?.issues.map((issue, i) => (
              <div key={i} style={{ marginBottom: 8, padding: "8px 10px", background: "var(--bg-card-start)", borderRadius: 6, border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Pill color={issue.severity === "error" ? "red" : issue.severity === "warning" ? "amber" : "gray"}>{issue.severity}</Pill>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{issue.file}{issue.line ? `:${issue.line}` : ""}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 13 }}>{issue.message}</div>
              </div>
            ))}
          </CollapsibleSection>

          <CollapsibleSection title={`Accessibility — ${report.accessibility?.length ?? 0} URLs`} defaultOpen={true}>
            {report.accessibility?.map((a, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span className="mono trunc" style={{ fontSize: 12 }}>{a.url}</span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12 }}>score</span>
                    <span style={{ fontWeight: 600, color: a.score >= 80 ? "#22c55e" : a.score >= 50 ? "#f59e0b" : "#ef4444" }}>{a.score}</span>
                  </div>
                </div>
                {a.issues.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {a.issues.map((issue, j) => (
                      <div key={j} style={{ fontSize: 12, padding: "4px 8px", background: "var(--bg-card-start)", borderRadius: 4, borderLeft: "3px solid #f59e0b" }}>
                        {issue}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs" style={{ color: "#22c55e" }}>✓ no issues</span>
                )}
              </div>
            ))}
          </CollapsibleSection>

          <CollapsibleSection title={`Performance — ${report.performance?.length ?? 0} URLs`} defaultOpen={true}>
            {report.performance?.map((p, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div className="mono" style={{ fontSize: 12, marginBottom: 8 }}>{p.url}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
                  {p.metrics.lcp !== undefined && (
                    <div style={{ padding: 8, background: "var(--bg-card-start)", borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase" }}>LCP</div>
                      <div style={{ fontWeight: 600, fontSize: 16, color: p.metrics.lcp < 2500 ? "#22c55e" : p.metrics.lcp < 4000 ? "#f59e0b" : "#ef4444" }}>{p.metrics.lcp}ms</div>
                    </div>
                  )}
                  {p.metrics.cls !== undefined && (
                    <div style={{ padding: 8, background: "var(--bg-card-start)", borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase" }}>CLS</div>
                      <div style={{ fontWeight: 600, fontSize: 16, color: p.metrics.cls < 0.1 ? "#22c55e" : p.metrics.cls < 0.25 ? "#f59e0b" : "#ef4444" }}>{p.metrics.cls.toFixed(3)}</div>
                    </div>
                  )}
                  {p.metrics.ttfb !== undefined && (
                    <div style={{ padding: 8, background: "var(--bg-card-start)", borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase" }}>TTFB</div>
                      <div style={{ fontWeight: 600, fontSize: 16, color: p.metrics.ttfb < 800 ? "#22c55e" : p.metrics.ttfb < 1800 ? "#f59e0b" : "#ef4444" }}>{p.metrics.ttfb}ms</div>
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 6 }}>
                  <Pill color={p.score >= 80 ? "green" : p.score >= 50 ? "amber" : "red"}>{p.score} score</Pill>
                </div>
              </div>
            ))}
          </CollapsibleSection>

          <CollapsibleSection title={`Security — ${report.security?.filter(s => s.passed).length ?? 0}/${report.security?.length ?? 0} passed`} defaultOpen={true}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {report.security?.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: s.passed ? "rgba(34,197,94,0.05)" : "rgba(239,68,68,0.05)", borderRadius: 6, border: `1px solid ${s.passed ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}` }}>
                  <span style={{ fontSize: 16 }}>{s.passed ? "✓" : "✗"}</span>
                  <span style={{ fontWeight: 500, fontSize: 13 }}>{s.check}</span>
                  <span className="text-xs dim" style={{ marginLeft: "auto" }}>{s.details}</span>
                </div>
              ))}
            </div>
          </CollapsibleSection>

          <CollapsibleSection title={`Runtime — ${report.runtime?.filter(r => r.ok).length ?? 0}/${report.runtime?.length ?? 0} ok`} defaultOpen={true}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
              {report.runtime?.map((r, i) => (
                <div key={i} style={{ padding: 10, background: r.ok ? "rgba(34,197,94,0.05)" : "rgba(239,68,68,0.05)", borderRadius: 6, border: `1px solid ${r.ok ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}` }}>
                  <div className="mono" style={{ fontSize: 12, marginBottom: 4 }}>{r.endpoint}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Pill color={r.ok ? "green" : "red"}>{r.ok ? "ok" : "failed"}</Pill>
                    <span className="text-xs dim">{r.statusCode || "timeout"}</span>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        </div>
        </div>
      </div>
    </div>
  );
}

export function BuilderPage() {
  const [selectedRoot, setSelectedRoot] = useState("/opt/opencode-control-surface");
  const [creating, setCreating] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<BuilderWorkflow | null>(null);
  const [showProvision, setShowProvision] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [viewingRunDetail, setViewingRunDetail] = useState(false);
  const [selectedDoctorReport, setSelectedDoctorReport] = useState<BuilderDoctorReport | null>(null);
  const projectsApi = useAuthenticatedApi<BuilderProjectsResponse>("/api/builder/projects", 60_000);
  const discoverApi = useAuthenticatedApi<BuilderDiscovery>(
    `/api/builder/discover?root=${encodeURIComponent(selectedRoot)}`,
    30_000,
  );
  const workflowsApi = useAuthenticatedApi<BuilderWorkflowsResponse>("/api/builder/workflows", 30_000);
  const runsApi = useAuthenticatedApi<BuilderRunsResponse>("/api/builder/runs", 15_000);
  const doctorReportsApi = useAuthenticatedApi<BuilderDoctorReportsResponse>("/api/builder/doctor-reports?limit=100", 30_000);
  const runDetailUrl = selectedRunId ? `/api/builder/runs/${selectedRunId}` : "";
  const runDetailApi = useAuthenticatedApi<BuilderRunResponse>(runDetailUrl, 15_000);

  const projects = projectsApi.data?.projects ?? [];
  const data = discoverApi.data;
  const workflows = workflowsApi.data?.workflows ?? [];
  const runs = runsApi.data?.runs ?? [];
  const doctorReports = doctorReportsApi.data?.reports ?? [];

  async function triggerDoctorReview(workflowId: string) {
    try {
      const response = await authFetch(`/api/builder/workflows/${workflowId}/doctor-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const text = await response.text();
        console.error("doctor review failed", text);
      }
      runsApi.refresh();
      workflowsApi.refresh();
    } catch (err) {
      console.error("trigger doctor review error", err);
    }
  }

  function hasDoctorReportsForWorkflow(workflowId: string): boolean {
    return doctorReports.some((r) => r.workflowId === workflowId);
  }

  function getLatestDoctorReport(workflowId: string): BuilderDoctorReport | undefined {
    return doctorReports.find((r) => r.workflowId === workflowId);
  }

  useEffect(() => {
    if (!projects.length) return;
    if (!projects.some((project) => project.root === selectedRoot)) {
      setSelectedRoot(projects[0].root);
    }
  }, [projects, selectedRoot]);

  // Poll runs when any workflow is running — but skip while user is reading run detail
  useEffect(() => {
    const anyRunning = workflows.some((w) => w.status === "running");
    if (!anyRunning) return;
    if (viewingRunDetail) return;
    const interval = setInterval(() => {
      runsApi.refresh();
      workflowsApi.refresh();
    }, 5000);
    return () => clearInterval(interval);
  }, [workflows, runsApi, workflowsApi, viewingRunDetail]);

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
        <button className="btn btn-sm btn-secondary" onClick={() => setShowProvision(true)} disabled={!data}>
          <Plus size={14} /> bootstrap
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
          {showProvision && (
            <ProvisionModal
              data={data}
              onClose={() => setShowProvision(false)}
              onProvisioned={() => {
                setShowProvision(false);
                projectsApi.refresh();
                discoverApi.refresh();
              }}
            />
          )}
          {creating && (
            <WorkflowModal
              data={data}
              selectedRoot={selectedRoot}
              workflow={null}
              onClose={() => setCreating(false)}
              onSaved={() => {
                setCreating(false);
                workflowsApi.refresh();
              }}
            />
          )}
          {editingWorkflow && (
            <WorkflowModal
              data={data}
              selectedRoot={editingWorkflow.projectRoot}
              workflow={editingWorkflow}
              onClose={() => setEditingWorkflow(null)}
              onSaved={() => {
                setEditingWorkflow(null);
                workflowsApi.refresh();
                runsApi.refresh();
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
                <table className="data-table workflows-table">
                  <thead>
                    <tr>
                      <th>status</th><th>mode</th><th>name</th><th>source</th><th>project</th><th>plan</th><th>agents</th><th>validation</th><th>doctor</th><th>actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workflows.map((workflow) => {
                      const hasDoctor = hasDoctorReportsForWorkflow(workflow.id);
                      const latestReport = getLatestDoctorReport(workflow.id);
                      return (
                        <tr key={workflow.id}>
                          <td><Pill color={statusColor(workflow.status)}>{workflow.status}</Pill></td>
                          <td>
                            <ModeBadge mode={workflow.mode} />
                            {workflow.mode === "scheduled" && workflow.nextRunAt && (
                              <div className="text-xs text-dim">next: {new Date(workflow.nextRunAt).toLocaleString()}</div>
                            )}
                          </td>
                          <td>{workflow.name}</td>
                          <td><SourceSessionMini source={workflow.config.sourceSession} /></td>
                          <td className="mono trunc">{workflow.projectRoot}</td>
                          <td className="mono trunc">{workflow.planFile}</td>
                          <td>{workflow.config.agentOrder.join(" -> ")}</td>
                          <td>{workflow.config.validationProfile.commands.length} checks</td>
                          <td>
                            {hasDoctor && latestReport ? (
                              <button
                                className="btn btn-xs btn-ghost"
                                onClick={() => setSelectedDoctorReport(latestReport)}
                                title="view doctor report"
                              >
                                <Pill color={latestReport.verdict === "ready" ? "green" : latestReport.verdict === "needs-work" ? "amber" : "red"}>
                                  {latestReport.overallScore}
                                </Pill>
                              </button>
                            ) : (
                              <span className="mono dim">-</span>
                            )}
                          </td>
                          <td>
                            <WorkflowActions
                              workflow={workflow}
                              onMutated={() => { workflowsApi.refresh(); runsApi.refresh(); }}
                              onEdit={() => setEditingWorkflow(workflow)}
                              onDoctorReview={() => triggerDoctorReview(workflow.id)}
                            />
                          </td>
                        </tr>
                      );
                    })}
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
                <table className="data-table runs-table">
                  <thead>
                    <tr>
                      <th>status</th><th>trigger</th><th>started</th><th className="finished-col">finished</th><th className="pass-col">pass</th><th>error</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run: BuilderRun) => (
                      <tr key={run.id} className="clickable-row" onClick={() => setSelectedRunId(run.id)}>
                        <td><Pill color={statusColor(run.status)}>{run.status}</Pill></td>
                        <td><Pill>{run.trigger}</Pill></td>
                        <td className="mono dim">{fmtTs(run.startedAt)}</td>
                        <td className="mono dim finished-col">{fmtTs(run.finishedAt)}</td>
                        <td className="mono trunc pass-col">{run.currentPassId ?? "-"}</td>
                        <td className="mono trunc">{run.error ? run.error.slice(0, 60) : "-"}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {(run.status === "failed" || run.status === "success" || run.status === "canceled") && (
                            <button
                              className="btn btn-xs btn-ghost"
                              onClick={async () => {
                                try {
                                  await authFetch(`/api/builder/runs/${run.id}/retry`, { method: "POST" });
                                  runsApi.refresh();
                                  workflowsApi.refresh();
                                } catch (err) {
                                  console.error("retry failed", err);
                                }
                              }}
                              title="retry run"
                            >
                              <RefreshCw size={12} />
                            </button>
                          )}
                          <ChevronRight size={14} className="row-chevron" />
                        </td>
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
                  {data.agents.options.map((agent) => (
                    <AgentPill key={agent.id} label={agent.id} status={agent.status} />
                  ))}
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
            setViewingRunDetail(false);
            runsApi.refresh();
            workflowsApi.refresh();
          }}
          onOpen={() => setViewingRunDetail(true)}
        />
      )}

      {selectedDoctorReport && (
        <DoctorReportModal
          report={selectedDoctorReport}
          onClose={() => {
            setSelectedDoctorReport(null);
            doctorReportsApi.refresh();
          }}
        />
      )}
    </div>
  );
}
