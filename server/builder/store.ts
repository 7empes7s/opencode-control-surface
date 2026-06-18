import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { redactForDashboard } from "../db/writer.ts";
import { getBuilderProjects, type BuilderProject } from "./discovery.ts";
import { isProjectRootAllowlisted } from "./provision.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant } from "../db/tenantScope.ts";

export type BuilderWorkflowMode = "once" | "auto-continue" | "scheduled" | "permanent" | "doctor" | "plan";
export type BuilderWorkflowStatus = "draft" | "ready" | "running" | "paused" | "blocked" | "done" | "failed" | "canceled";
export type BuilderRunStatus = "queued" | "running" | "blocked" | "pending-approval" | "success" | "failed" | "canceled";
export type BuilderPassStatus = "queued" | "running" | "success" | "failed" | "blocked" | "canceled";

export type BuilderAgentEntry = {
  raw: string;
  agent: string;
  model?: string;
  effort?: string;
};

// Effort keywords that may appear as a trailing `:effort` segment (e.g.
// `codex:gpt-5:high`). Anything else after the agent is treated as part of the
// model id so colon-tagged ids survive (e.g. `openrouter/openai/gpt-oss-120b:free`).
const AGENT_EFFORTS = new Set(["low", "medium", "high", "minimal", "none", "max"]);

export function parseAgentEntry(entry: string): BuilderAgentEntry {
  const firstColon = entry.indexOf(":");
  if (firstColon === -1) {
    return { raw: entry, agent: entry.trim(), model: undefined, effort: undefined };
  }
  const agent = entry.slice(0, firstColon).trim();
  let rest = entry.slice(firstColon + 1).trim();
  let effort: string | undefined;
  const lastColon = rest.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = rest.slice(lastColon + 1).trim();
    if (AGENT_EFFORTS.has(tail.toLowerCase())) {
      effort = tail;
      rest = rest.slice(0, lastColon).trim();
    }
  }
  return { raw: entry, agent, model: rest || undefined, effort };
}

export type BuilderWorkflowConfig = {
  projectRoot: string;
  agentOrder: string[];
  modelPolicy: {
    planner?: string;
    builder?: string;
    reviewer?: string;
    fallbackTargets: string[];
  };
  validationProfile: {
    commands: string[]; // deprecated: use internal instead
    internal: string[];
    runtime: string[];
    public: string[];
    playwright?: {
      enabled: boolean;
      config?: string;
      targets?: string[];
    };
    internalUrl?: string | null;
    publicUrl?: string | null;
  };
  gitPolicy: {
    commit: "manual" | "after-validation";
    push: "never" | "workflow-branch" | "current-branch";
  };
  backupPolicy: {
    enabled: boolean;
    beforeRun: boolean;
  };
  schedule?: {
    expression?: string;
    timezone?: string;
  };
  riskPolicy: {
    liveDeploys: "disabled" | "manual-approval";
    maxPasses: number;
    passTimeoutSeconds?: number;
    stallTimeoutSeconds?: number;
  };
  geminiApprovalMode?: "default" | "auto_edit" | "plan" | "yolo";
  effortLevel?: "low" | "medium" | "high";
  sourceSession?: {
    agent: "claude" | "codex" | "opencode" | "gemini";
    sessionId: string;
    title?: string;
    directory?: string;
    messageCount?: number;
    capturedAt?: string;
    transcriptSummary?: string;
    latestUserPrompt?: string;
    assistantSummary?: string;
    touchedFiles?: string[];
    touchedFileSummary?: string;
    recentTurns?: Array<{
      role: string;
      text: string;
    }>;
  };
  secretNames?: string[];
  requiresApproval?: boolean;
  requiresTwoApprovers?: boolean;
  requiredApproverCount?: number;
  approvalExpiresAtMs?: number;
  autoApplySafePlaybooks?: boolean;
};

export type BuilderWorkflowInput = {
  name: string;
  projectRoot: string;
  planFile: string;
  mode: BuilderWorkflowMode;
  status: Extract<BuilderWorkflowStatus, "draft" | "ready">;
  config: BuilderWorkflowConfig;
  nextRunAt?: number | null;
  pausedReason?: string | null;
};

// High-level lifecycle, independent of the granular operational `status`.
// `lifecycle` is the effective value (manual override if set, else derived from
// run history); `lifecycleStatus` is the raw manual override (null = automatic).
export type BuilderLifecycle = "new" | "in-progress" | "done";

export type BuilderWorkflow = {
  id: string;
  projectId: string;
  tenantId: string;
  name: string;
  projectRoot: string;
  planFile: string;
  mode: BuilderWorkflowMode;
  status: BuilderWorkflowStatus;
  lifecycle: BuilderLifecycle;
  lifecycleStatus: BuilderLifecycle | null;
  config: BuilderWorkflowConfig;
  createdAt: number;
  updatedAt: number;
  lastRunId: string | null;
  nextRunAt?: number | null;
  pausedReason?: string | null;
};

export type BuilderRun = {
  id: string;
  workflowId: string;
  tenantId: string;
  trigger: string;
  status: BuilderRunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  currentPassId: string | null;
  stopRequestedAt: number | null;
  stopRequestedBy: string | null;
  result: unknown;
  error: string | null;
  traceId: string | null;
  orchestratorInstanceId: string | null;
  githubIssueUrl: string | null;
  githubBranchName: string | null;
  githubCommitHash: string | null;
  githubPullRequestUrl: string | null;
  githubPullRequestStatus: string | null;
};

export type BuilderPass = {
  id: string;
  runId: string;
  workflowId: string;
  sequence: number;
  phase: string;
  status: BuilderPassStatus;
  agent: string | null;
  provider: string | null;
  model: string | null;
  modelReason: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  jobIds: string[];
  validationIds: string[];
  artifactIds: string[];
  summary: string | null;
  nextInstruction: string | null;
  failureClass: string | null;
  error: string | null;
  analyticsJson: string | null;
  planItemsDone: number | null;
  planItemsRemaining: number | null;
  completionPercent: number | null;
  traceId: string | null;
};

export type BuilderArtifact = {
  id: string;
  workflowId: string;
  runId: string;
  passId: string | null;
  kind: string;
  path: string;
  sha256: string | null;
  createdAt: number;
  metadata: unknown;
};

export type BuilderValidation = {
  id: string;
  workflowId: string;
  runId: string;
  passId: string | null;
  kind: string;
  status: string;
  command: string | null;
  url: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  outputTail: string | null;
  artifactId: string | null;
  error: string | null;
};

const MODES: BuilderWorkflowMode[] = ["once", "auto-continue", "scheduled", "permanent", "doctor", "plan"];
const DRAFT_STATUSES: BuilderWorkflowInput["status"][] = ["draft", "ready"];
export const BUILDER_DEFAULT_PASS_TIMEOUT_SECONDS = 1500;
export const BUILDER_DEFAULT_STALL_TIMEOUT_SECONDS = 2700;
export const BUILDER_DEFAULT_MAX_PASSES = 120;
const AGENTIC_MODELS_PATH = "/var/lib/control-surface/agentic-models.json";
const LONG_RUNNING_WORKFLOW_MODES = new Set<BuilderWorkflowMode>(["auto-continue", "scheduled", "permanent", "doctor", "plan"]);

export const DEFAULT_WORKFLOW_CONFIG: BuilderWorkflowConfig = {
  projectRoot: "",
  agentOrder: [],
  modelPolicy: { fallbackTargets: [] },
  validationProfile: { commands: [], internal: [], runtime: [], public: [] },
  gitPolicy: { commit: "manual", push: "never" },
  backupPolicy: { enabled: false, beforeRun: false },
  riskPolicy: {
    liveDeploys: "disabled",
    maxPasses: 1,
    passTimeoutSeconds: BUILDER_DEFAULT_PASS_TIMEOUT_SECONDS,
    stallTimeoutSeconds: BUILDER_DEFAULT_STALL_TIMEOUT_SECONDS,
  },
  geminiApprovalMode: "auto_edit",
};

function agenticModelsPath(): string {
  return process.env.BUILDER_AGENTIC_MODELS_PATH || AGENTIC_MODELS_PATH;
}

function readAgenticModelGroup(groupName: string): string[] {
  try {
    const raw = readFileSync(agenticModelsPath(), "utf8");
    const parsed = JSON.parse(raw) as { groups?: Record<string, unknown> };
    const group = parsed.groups?.[groupName];
    if (!Array.isArray(group)) return [];
    return uniqueStrings(group);
  } catch {
    return [];
  }
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function groupNameFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("group:")) return trimmed.slice("group:".length);
  if (trimmed.startsWith("opencode:group:")) {
    const parsed = parseAgentEntry(trimmed);
    return parsed.agent === "opencode" && parsed.model?.startsWith("group:")
      ? parsed.model.slice("group:".length)
      : null;
  }
  return null;
}

function expandAgentOrderGroups(entries: string[]): string[] {
  const expanded: string[] = [];
  for (const entry of entries) {
    const parsed = parseAgentEntry(entry);
    const groupName = parsed.agent === "opencode" && parsed.model?.startsWith("group:")
      ? parsed.model.slice("group:".length)
      : null;
    const groupModels = groupName ? readAgenticModelGroup(groupName) : [];
    if (!groupName || groupModels.length === 0) {
      expanded.push(entry);
      continue;
    }
    for (const model of groupModels) {
      expanded.push(`opencode:${model}${parsed.effort ? `:${parsed.effort}` : ""}`);
    }
  }
  return uniqueStrings(expanded);
}

function expandFallbackTargets(targets: string[], agentOrder: string[]): string[] {
  const groupNames = new Set<string>();
  for (const entry of agentOrder) {
    const parsed = parseAgentEntry(entry);
    if (parsed.agent === "opencode" && parsed.model?.startsWith("group:")) {
      groupNames.add(parsed.model.slice("group:".length));
    }
  }

  const expanded: string[] = [];
  for (const target of targets) {
    const groupName = groupNameFromModelRef(target);
    if (groupName) {
      groupNames.add(groupName);
      expanded.push(...readAgenticModelGroup(groupName));
    } else {
      expanded.push(target);
    }
  }

  if (targets.length === 0) {
    for (const groupName of groupNames) expanded.push(...readAgenticModelGroup(groupName));
  }

  return uniqueStrings(expanded);
}

function normalizeWorkflowConfig(parsed: Partial<BuilderWorkflowConfig>, mode: BuilderWorkflowMode): BuilderWorkflowConfig {
  const rawAgentOrder = Array.isArray(parsed.agentOrder) ? parsed.agentOrder : DEFAULT_WORKFLOW_CONFIG.agentOrder;
  const rawFallbackTargets = Array.isArray(parsed.modelPolicy?.fallbackTargets)
    ? parsed.modelPolicy.fallbackTargets
    : DEFAULT_WORKFLOW_CONFIG.modelPolicy.fallbackTargets;
  const riskPolicy = { ...DEFAULT_WORKFLOW_CONFIG.riskPolicy, ...(parsed.riskPolicy ?? {}) };
  if (LONG_RUNNING_WORKFLOW_MODES.has(mode)) {
    riskPolicy.maxPasses = Math.max(riskPolicy.maxPasses ?? 1, BUILDER_DEFAULT_MAX_PASSES);
    riskPolicy.passTimeoutSeconds = Math.max(riskPolicy.passTimeoutSeconds ?? 0, BUILDER_DEFAULT_PASS_TIMEOUT_SECONDS);
    riskPolicy.stallTimeoutSeconds = Math.max(riskPolicy.stallTimeoutSeconds ?? 0, BUILDER_DEFAULT_STALL_TIMEOUT_SECONDS);
  }
  return {
    ...DEFAULT_WORKFLOW_CONFIG,
    ...parsed,
    agentOrder: expandAgentOrderGroups(rawAgentOrder),
    modelPolicy: {
      ...DEFAULT_WORKFLOW_CONFIG.modelPolicy,
      ...(parsed.modelPolicy ?? {}),
      fallbackTargets: expandFallbackTargets(rawFallbackTargets, rawAgentOrder),
    },
    validationProfile: { ...DEFAULT_WORKFLOW_CONFIG.validationProfile, ...(parsed.validationProfile ?? {}) },
    gitPolicy: { ...DEFAULT_WORKFLOW_CONFIG.gitPolicy, ...(parsed.gitPolicy ?? {}) },
    backupPolicy: { ...DEFAULT_WORKFLOW_CONFIG.backupPolicy, ...(parsed.backupPolicy ?? {}) },
    riskPolicy,
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(redactForDashboard(value)) ?? "null";
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function projectIdForRoot(root: string): string {
  return `project:${root}`;
}

function getAllowedProject(root: string): BuilderProject | null {
  const normalizedRoot = resolve(root);
  const discovered = getBuilderProjects().find((project) => project.root === normalizedRoot);
  if (discovered) return discovered;

  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query(`
    SELECT name, root, config_json
    FROM builder_projects
    WHERE root = ?
    LIMIT 1
  `).get(normalizedRoot) as { name: string; root: string; config_json: string } | null;
  if (!row) return null;

  const stored = parseJson<Partial<BuilderProject>>(row.config_json, {});
  return {
    root: row.root,
    label: stored.label ?? row.name ?? basename(row.root),
    risk: stored.risk ?? "medium",
    writable: stored.writable ?? true,
    note: stored.note ?? "Registered Builder project",
    service: stored.service,
    internalUrl: stored.internalUrl,
    publicUrl: stored.publicUrl,
    defaultPlan: stored.defaultPlan,
  };
}

export function isBuilderProjectRootAllowlisted(root: string): boolean {
  return Boolean(getAllowedProject(root)) || isProjectRootAllowlisted(resolve(root));
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isPlanModePlanPathAllowed(input: BuilderWorkflowInput): boolean {
  if (!input.planFile.endsWith(".md")) return false;
  const planPath = resolve(input.planFile);
  const projectRoot = resolve(input.projectRoot);
  return isWithin(planPath, projectRoot) || isWithin(planPath, "/root");
}

function requireDb() {
  if (!isDashboardDbEnabled()) {
    throw new Error("DASHBOARD_DB disabled");
  }
  const db = getDashboardDb();
  if (!db) {
    throw new Error("dashboard SQLite unavailable");
  }
  return db;
}

function validateWorkflowInput(input: BuilderWorkflowInput): void {
  const name = input.name.trim();
  if (!name) throw new Error("workflow name required");
  if (name.length > 120) throw new Error("workflow name too long");
  if (!MODES.includes(input.mode)) throw new Error("invalid workflow mode");
  if (!DRAFT_STATUSES.includes(input.status)) throw new Error("invalid draft workflow status");
  if (!getAllowedProject(input.projectRoot)) throw new Error("project root is not allowlisted");
  if (!input.planFile) throw new Error("PLAN_FILE_NOT_FOUND");
  if (!existsSync(input.planFile) && !(input.mode === "plan" && isPlanModePlanPathAllowed(input))) {
    throw new Error("PLAN_FILE_NOT_FOUND");
  }
  const hasCommands = input.config.validationProfile.commands.length > 0;
  const hasInternal = input.config.validationProfile.internal.length > 0;
  if (input.mode !== "plan" && !hasCommands && !hasInternal) {
    throw new Error("at least one validation command required (internal or commands field)");
  }
}

function upsertBuilderProject(project: BuilderProject): string {
  const db = requireDb();
  const now = Date.now();
  const id = projectIdForRoot(project.root);
  const tenantId = getCurrentTenantContext().tenantId;
  db.query(`
    INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET
      name = excluded.name,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at,
      tenant_id = excluded.tenant_id
  `).run(
    id,
    project.label,
    project.root,
    stringifyJson(project),
    now,
    now,
    tenantId,
  );
  const row = db.query(`SELECT id FROM builder_projects WHERE root = ? LIMIT 1`)
    .get(project.root) as { id: string } | null;
  return row?.id ?? id;
}

type DbWorkflowRow = {
  id: string;
  project_id: string;
  tenant_id: string | null;
  name: string;
  mode: BuilderWorkflowMode;
  status: BuilderWorkflowStatus;
  lifecycle_status: string | null;
  plan_file: string;
  config_json: string;
  created_at: number;
  updated_at: number;
  last_run_id: string | null;
  next_run_at: number | null;
  paused_reason: string | null;
};

function normalizeLifecycle(value: unknown): BuilderLifecycle | null {
  return value === "new" || value === "in-progress" || value === "done" ? value : null;
}

// Effective lifecycle: a manual override always wins; otherwise derive from run
// history — no runs = new, latest run succeeded = done, anything else = in-progress.
function deriveLifecycle(row: DbWorkflowRow): BuilderLifecycle {
  const manual = normalizeLifecycle(row.lifecycle_status);
  if (manual) return manual;
  const db = getDashboardDb();
  if (!db) return "new";
  const latest = db
    .query(`SELECT status FROM builder_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(row.id) as { status?: string } | null;
  if (!latest) return "new";
  return latest.status === "success" ? "done" : "in-progress";
}

function mapWorkflow(row: DbWorkflowRow): BuilderWorkflow {
  const parsed = parseJson<Partial<BuilderWorkflowConfig>>(row.config_json, {});
  const config = normalizeWorkflowConfig(parsed, row.mode);
  return {
    id: row.id,
    projectId: row.project_id,
    tenantId: row.tenant_id ?? "mimule",
    name: row.name,
    projectRoot: config.projectRoot,
    planFile: row.plan_file,
    mode: row.mode,
    status: row.status,
    lifecycle: deriveLifecycle(row),
    lifecycleStatus: normalizeLifecycle(row.lifecycle_status),
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id,
    nextRunAt: row.next_run_at,
    pausedReason: row.paused_reason,
  };
}

export function reconcileBuilderWorkflowConfigs(id?: string): number {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return 0;
  const db = getDashboardDb()!;
  try {
    const tenantWhere = whereTenant();
    const rows = id
      ? db.query(`
          SELECT id, mode, config_json
          FROM builder_workflows
          WHERE id = ?${tenantWhere.clause}
        `).all(id, ...tenantWhere.params)
      : db.query(`
          SELECT id, mode, config_json
          FROM builder_workflows
          WHERE tenant_id = ? OR tenant_id IS NULL
        `).all(getCurrentTenantContext().tenantId);
    let updated = 0;
    for (const row of rows as Array<{ id: string; mode: BuilderWorkflowMode; config_json: string }>) {
      const parsed = parseJson<Partial<BuilderWorkflowConfig>>(row.config_json, {});
      const normalized = normalizeWorkflowConfig(parsed, row.mode);
      const nextJson = stringifyJson(normalized);
      if (nextJson === row.config_json) continue;
      db.query(`UPDATE builder_workflows SET config_json = ?, updated_at = ? WHERE id = ?`)
        .run(nextJson, Date.now(), row.id);
      updated += 1;
    }
    return updated;
  } catch (error) {
    console.error("[control-surface] reconcileBuilderWorkflowConfigs failed", error);
    return 0;
  }
}

export function createBuilderWorkflow(input: BuilderWorkflowInput): BuilderWorkflow {
  validateWorkflowInput(input);
  const project = getAllowedProject(input.projectRoot);
  if (!project) throw new Error("project root is not allowlisted");
  const config = normalizeWorkflowConfig({ ...input.config, projectRoot: input.projectRoot }, input.mode);

  const db = requireDb();
  const now = Date.now();
  const id = `bw_${randomUUID()}`;
  const projectId = upsertBuilderProject(project);

  const ctx = getCurrentTenantContext();
  const tenantId = ctx.tenantId;
  db.query(`
    INSERT INTO builder_workflows
      (id, project_id, tenant_id, name, mode, status, lifecycle_status, plan_file, config_json, created_at, updated_at, next_run_at, paused_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    tenantId,
    input.name.trim(),
    input.mode,
    input.status,
    null,
    input.planFile,
    stringifyJson(config),
    now,
    now,
    input.nextRunAt ?? null,
    input.pausedReason ?? null,
  );

  const workflow = readBuilderWorkflow(id);
  if (!workflow) throw new Error("created workflow could not be read");
  return workflow;
}

export function updateBuilderWorkflow(id: string, input: BuilderWorkflowInput): BuilderWorkflow | null {
  validateWorkflowInput(input);
  const existing = readBuilderWorkflow(id);
  if (!existing) return null;
  if (existing.status !== "draft" && existing.status !== "ready") {
    throw new Error("only draft or ready workflows can be edited in Phase 2");
  }

  const project = getAllowedProject(input.projectRoot);
  if (!project) throw new Error("project root is not allowlisted");

  const db = requireDb();
  const projectId = upsertBuilderProject(project);
  const now = Date.now();
  const config = normalizeWorkflowConfig({ ...input.config, projectRoot: input.projectRoot }, input.mode);

  db.query(`
    UPDATE builder_workflows
    SET project_id = ?, name = ?, mode = ?, status = ?, plan_file = ?, config_json = ?,
      updated_at = ?, next_run_at = ?, paused_reason = ?
    WHERE id = ?
  `).run(
    projectId,
    input.name.trim(),
    input.mode,
    input.status,
    input.planFile,
    stringifyJson(config),
    now,
    input.nextRunAt ?? null,
    input.pausedReason ?? null,
    id,
  );

  return readBuilderWorkflow(id);
}

export function readBuilderWorkflows(): BuilderWorkflow[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  try {
    reconcileBuilderWorkflowConfigs();
    const ctx = getCurrentTenantContext();
    const { tenantId } = ctx;
    return (getDashboardDb()!.query(`
      SELECT id, project_id, tenant_id, name, mode, status, lifecycle_status, plan_file, config_json, created_at,
        updated_at, last_run_id, next_run_at, paused_reason
      FROM builder_workflows
      WHERE tenant_id = ? OR tenant_id IS NULL
      ORDER BY updated_at DESC
    `).all(tenantId) as DbWorkflowRow[]).map(mapWorkflow);
  } catch (error) {
    console.error("[control-surface] readBuilderWorkflows failed", error);
    return [];
  }
}

export function readBuilderWorkflow(id: string): BuilderWorkflow | null {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return null;
  try {
    reconcileBuilderWorkflowConfigs(id);
    const tenantWhere = whereTenant();
    const row = getDashboardDb()!.query(`
      SELECT id, project_id, tenant_id, name, mode, status, lifecycle_status, plan_file, config_json, created_at,
        updated_at, last_run_id, next_run_at, paused_reason
      FROM builder_workflows
      WHERE id = ?${tenantWhere.clause}
    `).get(id, ...tenantWhere.params) as DbWorkflowRow | null;
    return row ? mapWorkflow(row) : null;
  } catch (error) {
    console.error("[control-surface] readBuilderWorkflow failed", error);
    return null;
  }
}

// Set or clear the manual lifecycle override (null = revert to automatic).
export function setBuilderWorkflowLifecycle(id: string, lifecycle: BuilderLifecycle | null): BuilderWorkflow | null {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return null;
  const db = getDashboardDb()!;
  const tenantWhere = whereTenant();
  db.query(`UPDATE builder_workflows SET lifecycle_status = ? WHERE id = ?${tenantWhere.clause}`)
    .run(lifecycle, id, ...tenantWhere.params);
  return readBuilderWorkflow(id);
}

type DbRunRow = {
  id: string;
  workflow_id: string;
  tenant_id: string | null;
  trigger: string;
  status: BuilderRunStatus;
  started_at: number | null;
  finished_at: number | null;
  current_pass_id: string | null;
  stop_requested_at: number | null;
  stop_requested_by: string | null;
  result_json: string | null;
  error: string | null;
  trace_id: string | null;
  orchestrator_instance_id: string | null;
  github_issue_url: string | null;
  github_branch_name: string | null;
  github_commit_hash: string | null;
  github_pull_request_url: string | null;
  github_pull_request_status: string | null;
};

function mapRun(row: DbRunRow): BuilderRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    tenantId: row.tenant_id ?? "mimule",
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    currentPassId: row.current_pass_id,
    stopRequestedAt: row.stop_requested_at,
    stopRequestedBy: row.stop_requested_by,
    result: parseJson(row.result_json, null),
    error: row.error,
    traceId: row.trace_id ?? null,
    orchestratorInstanceId: row.orchestrator_instance_id ?? null,
    githubIssueUrl: row.github_issue_url ?? null,
    githubBranchName: row.github_branch_name ?? null,
    githubCommitHash: row.github_commit_hash ?? null,
    githubPullRequestUrl: row.github_pull_request_url ?? null,
    githubPullRequestStatus: row.github_pull_request_status ?? null,
  };
}

export function readBuilderRuns(workflowId?: string): BuilderRun[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  const ctx = getCurrentTenantContext();
  const { tenantId } = ctx;
  const params: (string)[] = [tenantId];
  let sql = `
    SELECT id, workflow_id, trigger, status, started_at, finished_at, current_pass_id,
      stop_requested_at, stop_requested_by, result_json, error, trace_id, orchestrator_instance_id
    FROM builder_runs
    WHERE (tenant_id = ? OR tenant_id IS NULL)
  `;
  if (workflowId) {
    sql += " AND workflow_id = ?";
    params.push(workflowId);
  }
  sql += " ORDER BY COALESCE(started_at, 0) DESC LIMIT 100";

  try {
    return (getDashboardDb()!.query(sql).all(...params) as DbRunRow[]).map(mapRun);
  } catch (error) {
    console.error("[control-surface] readBuilderRuns failed", error);
    return [];
  }
}

export function readBuilderRun(id: string): BuilderRun | null {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return null;
  try {
    const tenantWhere = whereTenant();
    const row = getDashboardDb()!.query(`
      SELECT id, workflow_id, tenant_id, trigger, status, started_at, finished_at, current_pass_id,
        stop_requested_at, stop_requested_by, result_json, error, trace_id, orchestrator_instance_id
      FROM builder_runs
      WHERE id = ?${tenantWhere.clause}
    `).get(id, ...tenantWhere.params) as DbRunRow | null;
    return row ? mapRun(row) : null;
  } catch (error) {
    console.error("[control-surface] readBuilderRun failed", error);
    return null;
  }
}

type DbPassRow = {
  id: string;
  run_id: string;
  workflow_id: string;
  sequence: number;
  phase: string;
  status: BuilderPassStatus;
  agent: string | null;
  provider: string | null;
  model: string | null;
  model_reason: string | null;
  started_at: number | null;
  finished_at: number | null;
  job_ids_json: string | null;
  validation_ids_json: string | null;
  artifact_ids_json: string | null;
  summary: string | null;
  next_instruction: string | null;
  failure_class: string | null;
  error: string | null;
  analytics_json: string | null;
  plan_items_done: number | null;
  plan_items_remaining: number | null;
  completion_percent: number | null;
  trace_id: string | null;
};

function parseStringArray(value: string | null): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function mapPass(row: DbPassRow): BuilderPass {
  return {
    id: row.id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    sequence: row.sequence,
    phase: row.phase,
    status: row.status,
    agent: row.agent,
    provider: row.provider,
    model: row.model,
    modelReason: row.model_reason,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    jobIds: parseStringArray(row.job_ids_json),
    validationIds: parseStringArray(row.validation_ids_json),
    artifactIds: parseStringArray(row.artifact_ids_json),
    summary: row.summary,
    nextInstruction: row.next_instruction,
    failureClass: row.failure_class,
    error: row.error,
    analyticsJson: row.analytics_json ?? null,
    planItemsDone: row.plan_items_done ?? null,
    planItemsRemaining: row.plan_items_remaining ?? null,
    completionPercent: row.completion_percent ?? null,
    traceId: row.trace_id ?? null,
  };
}

export function readBuilderPasses(runId: string): BuilderPass[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  try {
    const tenantWhere = whereTenant();
    return (getDashboardDb()!.query(`
      SELECT id, run_id, workflow_id, sequence, phase, status, agent, provider, model,
        model_reason, started_at, finished_at, job_ids_json, validation_ids_json, artifact_ids_json,
        summary, next_instruction, failure_class, error, analytics_json, plan_items_done, plan_items_remaining, completion_percent, trace_id
      FROM builder_passes
      WHERE run_id = ?${tenantWhere.clause}
      ORDER BY sequence ASC
    `).all(runId, ...tenantWhere.params) as DbPassRow[]).map(mapPass);
  } catch (error) {
    console.error("[control-surface] readBuilderPasses failed", error);
    return [];
  }
}

export function readBuilderArtifacts(runId: string): BuilderArtifact[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  try {
    const tenantWhere = whereTenant();
    const rows = getDashboardDb()!.query(`
      SELECT id, workflow_id, run_id, pass_id, kind, path, sha256, created_at, metadata_json
      FROM builder_artifacts
      WHERE run_id = ?${tenantWhere.clause}
      ORDER BY created_at DESC
    `).all(runId, ...tenantWhere.params) as Array<{
      id: string;
      workflow_id: string;
      run_id: string;
      pass_id: string | null;
      kind: string;
      path: string;
      sha256: string | null;
      created_at: number;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      runId: row.run_id,
      passId: row.pass_id,
      kind: row.kind,
      path: row.path,
      sha256: row.sha256,
      createdAt: row.created_at,
      metadata: parseJson(row.metadata_json, null),
    }));
  } catch (error) {
    console.error("[control-surface] readBuilderArtifacts failed", error);
    return [];
  }
}

export function readBuilderValidations(runId: string): BuilderValidation[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  try {
    const tenantWhere = whereTenant();
    const rows = getDashboardDb()!.query(`
      SELECT id, workflow_id, run_id, pass_id, kind, status, command, url, started_at,
        finished_at, output_tail, artifact_id, error
      FROM builder_validations
      WHERE run_id = ?${tenantWhere.clause}
      ORDER BY COALESCE(started_at, 0) DESC
    `).all(runId, ...tenantWhere.params) as Array<{
      id: string;
      workflow_id: string;
      run_id: string;
      pass_id: string | null;
      kind: string;
      status: string;
      command: string | null;
      url: string | null;
      started_at: number | null;
      finished_at: number | null;
      output_tail: string | null;
      artifact_id: string | null;
      error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      runId: row.run_id,
      passId: row.pass_id,
      kind: row.kind,
      status: row.status,
      command: row.command,
      url: row.url,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outputTail: row.output_tail,
      artifactId: row.artifact_id,
      error: row.error,
    }));
  } catch (error) {
    console.error("[control-surface] readBuilderValidations failed", error);
    return [];
  }
}

export type BuilderDoctorReport = {
  id: string;
  workflowId: string;
  runId: string | null;
  passId: string | null;
  createdAt: number;
  projectRoot: string;
  planFile: string;
  codeReview: { changedFiles: number; issues: { severity: string; file: string; line?: number; message: string }[]; score: number } | null;
  accessibility: { url: string; score: number; issues: string[] }[] | null;
  performance: { url: string; metrics: Record<string, number>; score: number }[] | null;
  security: { check: string; passed: boolean; details: string }[] | null;
  runtime: { endpoint: string; statusCode: number; ok: boolean }[] | null;
  overallScore: number;
  verdict: string;
  evidence: { label: string; kind: string; ref: string }[];
};

export function readBuilderDoctorReports(workflowId?: string, runId?: string, limit = 10): BuilderDoctorReport[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  try {
    const db = getDashboardDb()!;
    const tenantWhere = whereTenant();
    let sql = `SELECT id, workflow_id, run_id, pass_id, created_at, project_root, plan_file,
      code_review_json, accessibility_json, performance_json, security_json, runtime_json,
      overall_score, verdict, evidence_json
      FROM builder_doctor_reports`;
    const params: (string | number)[] = [];
    const conditions: string[] = [];
    if (workflowId) {
      conditions.push("workflow_id = ?");
      params.push(workflowId);
    }
    if (runId) {
      conditions.push("run_id = ?");
      params.push(runId);
    }
    const clauseStr = tenantWhere.clause.replace(/^\s*AND\s+/i, "").trim();
    if (clauseStr) conditions.push(clauseStr);
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
      params.push(...tenantWhere.params);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(String(limit));

    return db.query(sql).all(...params) as BuilderDoctorReport[];
  } catch (error) {
    console.error("[control-surface] readBuilderDoctorReports failed", error);
    return [];
  }
}

export type ProvisionResult = {
  id: string;
  projectRoot: string;
  name: string;
  workflowId: string;
  workflowStatus: string;
  provisioned: {
    cloned: boolean;
    gitInitialized: boolean;
    agentsMd: boolean;
    planFile: string | null;
    vaultNote: boolean;
    skillFile: boolean;
    validationProfileFile: string | null;
    runtimeScaffoldFiles: string[];
  };
  validationCommands: string[];
  warnings: string[];
  error?: string;
};

export function provisionProject(input: {
  projectRoot: string;
  name: string;
  repoUrl?: string;
  description?: string;
  tags?: string[];
  owner?: string;
  planFile: string;
  agentOrder: string[];
  fallbackTargets: string[];
  validationCommands: string[];
  gitPolicy: { commit: string; push: string };
  internalUrl?: string;
  publicUrl?: string;
  runtimeScaffold?: boolean;
}): ProvisionResult {
  // Import provision module lazily to avoid circular dependency at module init
  const { provisionProject: doScaffold } = require("./provision.ts") as typeof import("./provision.ts");

  const scaffoldResult = doScaffold({
    repoUrl: input.repoUrl,
    projectRoot: input.projectRoot,
    name: input.name,
    description: input.description,
    tags: input.tags,
    owner: input.owner,
    defaultPlanPath: input.planFile,
    validationCommands: input.validationCommands,
    runtimeScaffold: input.runtimeScaffold,
  });

  if (!scaffoldResult.ok) {
    return {
      id: "",
      projectRoot: input.projectRoot,
      name: input.name,
      workflowId: "",
      workflowStatus: "",
      provisioned: scaffoldResult.provisioned,
      validationCommands: scaffoldResult.validationCommands,
      warnings: scaffoldResult.warnings,
      error: scaffoldResult.error,
    };
  }

  // Register the new project root in SQLite
  const db = requireDb();
  const now = Date.now();
  const projectId = `project:${input.projectRoot}`;

  const effectivePlanFile = scaffoldResult.provisioned.planFile ?? input.planFile;
  const effectiveValidationCommands = input.validationCommands.length > 0
    ? input.validationCommands
    : scaffoldResult.validationCommands;

  const projectConfig = {
    root: input.projectRoot,
    label: input.name,
    risk: "medium" as const,
    writable: true,
    note: input.description ?? "",
    service: undefined as string | undefined,
    internalUrl: input.internalUrl,
    publicUrl: input.publicUrl,
    defaultPlan: effectivePlanFile,
  };

  const tenantId = getCurrentTenantContext().tenantId;
  db.query(`
    INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET
      name = excluded.name,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at,
      tenant_id = excluded.tenant_id
  `).run(
    projectId,
    input.name,
    input.projectRoot,
    JSON.stringify(projectConfig),
    now,
    now,
    tenantId,
  );

  // Create a draft workflow linked to the new project
  const workflowId = `bw_${randomUUID()}`;
  const workflowConfig = {
    projectRoot: input.projectRoot,
    agentOrder: input.agentOrder,
    modelPolicy: { fallbackTargets: input.fallbackTargets },
    validationProfile: {
      commands: effectiveValidationCommands,
      internal: effectiveValidationCommands,
      runtime: [],
      public: [],
      playwright: { enabled: false },
      internalUrl: input.internalUrl ?? null,
      publicUrl: input.publicUrl ?? null,
    },
    gitPolicy: input.gitPolicy,
    backupPolicy: { enabled: true, beforeRun: true },
    riskPolicy: { liveDeploys: "disabled" as const, maxPasses: 1, passTimeoutSeconds: 900, stallTimeoutSeconds: 900 },
    geminiApprovalMode: "auto_edit",
  };

  db.query(`
    INSERT INTO builder_workflows
      (id, project_id, tenant_id, name, mode, status, lifecycle_status, plan_file, config_json, created_at, updated_at, next_run_at, paused_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workflowId,
    projectId,
    tenantId,
    `${input.name} initial build`,
    "auto-continue",
    "draft",
    null,
    effectivePlanFile,
    JSON.stringify(workflowConfig),
    now,
    now,
    null,
    null,
  );

  return {
    id: projectId,
    projectRoot: input.projectRoot,
    name: input.name,
    workflowId,
    workflowStatus: "draft",
    provisioned: scaffoldResult.provisioned,
    validationCommands: effectiveValidationCommands,
    warnings: scaffoldResult.warnings,
  };
}

export function deleteBuilderWorkflow(id: string): boolean {
  const db = requireDb();
  const existing = readBuilderWorkflow(id);
  if (!existing) return false;

  if (existing.status === "running") {
    throw new Error("cannot delete workflow while running");
  }

  db.query(`DELETE FROM builder_runs WHERE workflow_id = ?`).run(id);
  db.query(`DELETE FROM builder_workflows WHERE id = ?`).run(id);
  return true;
}
