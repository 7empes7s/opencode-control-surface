import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { redactForDashboard } from "../db/writer.ts";
import { getBuilderProjects, type BuilderProject } from "./discovery.ts";

export type BuilderWorkflowMode = "once" | "auto-continue" | "scheduled" | "permanent" | "doctor";
export type BuilderWorkflowStatus = "draft" | "ready" | "running" | "paused" | "blocked" | "done" | "failed" | "canceled";
export type BuilderRunStatus = "queued" | "running" | "blocked" | "success" | "failed" | "canceled";
export type BuilderPassStatus = "queued" | "running" | "success" | "failed" | "blocked" | "canceled";

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
    commands: string[];
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
  };
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

export type BuilderWorkflow = {
  id: string;
  projectId: string;
  name: string;
  projectRoot: string;
  planFile: string;
  mode: BuilderWorkflowMode;
  status: BuilderWorkflowStatus;
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
  trigger: string;
  status: BuilderRunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  currentPassId: string | null;
  stopRequestedAt: number | null;
  stopRequestedBy: string | null;
  result: unknown;
  error: string | null;
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
  startedAt: number | null;
  finishedAt: number | null;
  jobIds: string[];
  validationIds: string[];
  artifactIds: string[];
  summary: string | null;
  nextInstruction: string | null;
  failureClass: string | null;
  error: string | null;
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

const MODES: BuilderWorkflowMode[] = ["once", "auto-continue", "scheduled", "permanent", "doctor"];
const DRAFT_STATUSES: Array<BuilderWorkflowInput["status"]> = ["draft", "ready"];

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
  return getBuilderProjects().find((project) => project.root === root) ?? null;
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
  if (!input.planFile || !existsSync(input.planFile)) throw new Error("PLAN_FILE_NOT_FOUND");
  if (!input.config.validationProfile.commands.length) throw new Error("at least one validation command required");
}

function upsertBuilderProject(project: BuilderProject): string {
  const db = requireDb();
  const now = Date.now();
  const id = projectIdForRoot(project.root);
  db.query(`
    INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET
      name = excluded.name,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run(
    id,
    project.label,
    project.root,
    stringifyJson(project),
    now,
    now,
  );
  return id;
}

type DbWorkflowRow = {
  id: string;
  project_id: string;
  name: string;
  mode: BuilderWorkflowMode;
  status: BuilderWorkflowStatus;
  plan_file: string;
  config_json: string;
  created_at: number;
  updated_at: number;
  last_run_id: string | null;
  next_run_at: number | null;
  paused_reason: string | null;
};

function mapWorkflow(row: DbWorkflowRow): BuilderWorkflow {
  const config = parseJson<BuilderWorkflowConfig>(row.config_json, {
    projectRoot: "",
    agentOrder: [],
    modelPolicy: { fallbackTargets: [] },
    validationProfile: { commands: [] },
    gitPolicy: { commit: "manual", push: "never" },
    backupPolicy: { enabled: false, beforeRun: false },
    riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
  });
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    projectRoot: config.projectRoot,
    planFile: row.plan_file,
    mode: row.mode,
    status: row.status,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id,
    nextRunAt: row.next_run_at,
    pausedReason: row.paused_reason,
  };
}

export function createBuilderWorkflow(input: BuilderWorkflowInput): BuilderWorkflow {
  validateWorkflowInput(input);
  const project = getAllowedProject(input.projectRoot);
  if (!project) throw new Error("project root is not allowlisted");

  const db = requireDb();
  const now = Date.now();
  const id = `bw_${randomUUID()}`;
  const projectId = upsertBuilderProject(project);

  db.query(`
    INSERT INTO builder_workflows
      (id, project_id, name, mode, status, plan_file, config_json, created_at, updated_at, next_run_at, paused_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    input.name.trim(),
    input.mode,
    input.status,
    input.planFile,
    stringifyJson({ ...input.config, projectRoot: input.projectRoot }),
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
    stringifyJson({ ...input.config, projectRoot: input.projectRoot }),
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
    return (getDashboardDb()!.query(`
      SELECT id, project_id, name, mode, status, plan_file, config_json, created_at,
        updated_at, last_run_id, next_run_at, paused_reason
      FROM builder_workflows
      ORDER BY updated_at DESC
    `).all() as DbWorkflowRow[]).map(mapWorkflow);
  } catch (error) {
    console.error("[control-surface] readBuilderWorkflows failed", error);
    return [];
  }
}

export function readBuilderWorkflow(id: string): BuilderWorkflow | null {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return null;
  try {
    const row = getDashboardDb()!.query(`
      SELECT id, project_id, name, mode, status, plan_file, config_json, created_at,
        updated_at, last_run_id, next_run_at, paused_reason
      FROM builder_workflows
      WHERE id = ?
    `).get(id) as DbWorkflowRow | null;
    return row ? mapWorkflow(row) : null;
  } catch (error) {
    console.error("[control-surface] readBuilderWorkflow failed", error);
    return null;
  }
}

type DbRunRow = {
  id: string;
  workflow_id: string;
  trigger: string;
  status: BuilderRunStatus;
  started_at: number | null;
  finished_at: number | null;
  current_pass_id: string | null;
  stop_requested_at: number | null;
  stop_requested_by: string | null;
  result_json: string | null;
  error: string | null;
};

function mapRun(row: DbRunRow): BuilderRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    currentPassId: row.current_pass_id,
    stopRequestedAt: row.stop_requested_at,
    stopRequestedBy: row.stop_requested_by,
    result: parseJson(row.result_json, null),
    error: row.error,
  };
}

export function readBuilderRuns(workflowId?: string): BuilderRun[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  const params: string[] = [];
  let sql = `
    SELECT id, workflow_id, trigger, status, started_at, finished_at, current_pass_id,
      stop_requested_at, stop_requested_by, result_json, error
    FROM builder_runs
  `;
  if (workflowId) {
    sql += " WHERE workflow_id = ?";
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
    const row = getDashboardDb()!.query(`
      SELECT id, workflow_id, trigger, status, started_at, finished_at, current_pass_id,
        stop_requested_at, stop_requested_by, result_json, error
      FROM builder_runs
      WHERE id = ?
    `).get(id) as DbRunRow | null;
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
  started_at: number | null;
  finished_at: number | null;
  job_ids_json: string | null;
  validation_ids_json: string | null;
  artifact_ids_json: string | null;
  summary: string | null;
  next_instruction: string | null;
  failure_class: string | null;
  error: string | null;
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
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    jobIds: parseStringArray(row.job_ids_json),
    validationIds: parseStringArray(row.validation_ids_json),
    artifactIds: parseStringArray(row.artifact_ids_json),
    summary: row.summary,
    nextInstruction: row.next_instruction,
    failureClass: row.failure_class,
    error: row.error,
  };
}

export function readBuilderPasses(runId: string): BuilderPass[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  try {
    return (getDashboardDb()!.query(`
      SELECT id, run_id, workflow_id, sequence, phase, status, agent, provider, model,
        started_at, finished_at, job_ids_json, validation_ids_json, artifact_ids_json,
        summary, next_instruction, failure_class, error
      FROM builder_passes
      WHERE run_id = ?
      ORDER BY sequence ASC
    `).all(runId) as DbPassRow[]).map(mapPass);
  } catch (error) {
    console.error("[control-surface] readBuilderPasses failed", error);
    return [];
  }
}

export function readBuilderArtifacts(runId: string): BuilderArtifact[] {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return [];
  try {
    const rows = getDashboardDb()!.query(`
      SELECT id, workflow_id, run_id, pass_id, kind, path, sha256, created_at, metadata_json
      FROM builder_artifacts
      WHERE run_id = ?
      ORDER BY created_at DESC
    `).all(runId) as Array<{
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
    const rows = getDashboardDb()!.query(`
      SELECT id, workflow_id, run_id, pass_id, kind, status, command, url, started_at,
        finished_at, output_tail, artifact_id, error
      FROM builder_validations
      WHERE run_id = ?
      ORDER BY COALESCE(started_at, 0) DESC
    `).all(runId) as Array<{
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
