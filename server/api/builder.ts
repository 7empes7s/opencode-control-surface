import { resolve } from "node:path";
import {
  discoverBuilderProject,
  getBuilderModelsInventory,
  getBuilderProjects,
  type BuilderDiscovery,
  type BuilderModelsInventory,
  type BuilderProject,
} from "../builder/discovery.ts";
import {
  createBuilderWorkflow,
  deleteBuilderWorkflow,
  readBuilderArtifacts,
  readBuilderDoctorReports,
  readBuilderPasses,
  readBuilderRun,
  readBuilderRuns,
  readBuilderValidations,
  readBuilderWorkflow,
  readBuilderWorkflows,
  updateBuilderWorkflow,
  provisionProject,
  type BuilderArtifact,
  type BuilderDoctorReport,
  type BuilderPass,
  type BuilderRun,
  type BuilderValidation,
  type BuilderWorkflow,
  type BuilderWorkflowInput,
  type ProvisionResult,
} from "../builder/store.ts";
import { isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import {
  startWorkflowRun,
  stopWorkflowRun,
  pauseWorkflow,
  resumeWorkflow,
  retryRun,
  cancelRun,
  reconcileRunStatus,
} from "../builder/runner.ts";
import { getNextRunTime } from "../builder/scheduler.ts";

function json<T>(body: ApiEnvelope<T>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type BuilderProjectsResponse = {
  projects: BuilderProject[];
};

export type BuilderWorkflowsResponse = {
  workflows: BuilderWorkflow[];
  degraded: boolean;
  reason?: string;
};

export type BuilderWorkflowResponse = {
  workflow: BuilderWorkflow | null;
  runs: BuilderRun[];
  degraded: boolean;
  reason?: string;
};

export type BuilderRunsResponse = {
  runs: BuilderRun[];
  degraded: boolean;
  reason?: string;
};

export type BuilderRunResponse = {
  run: BuilderRun | null;
  workflow?: BuilderWorkflow | null;
  passes: BuilderPass[];
  artifacts: BuilderArtifact[];
  validations: BuilderValidation[];
  degraded: boolean;
  reason?: string;
};

export type BuilderArtifactsResponse = {
  artifacts: BuilderArtifact[];
  validations: BuilderValidation[];
  degraded: boolean;
  reason?: string;
};

export function builderProjectsHandler(): Response {
  return json(ok<BuilderProjectsResponse>({ projects: getBuilderProjects() }, { builder: "ok" }));
}

export function builderDiscoverHandler(url: URL): Response {
  const root = url.searchParams.get("root") ?? "/opt/opencode-control-surface";
  const discovered = discoverBuilderProject(root);
  if (discovered.ok === false) return apiError(discovered.error);
  return json<BuilderDiscovery>(ok(discovered.data, { builder: "ok" }));
}

export function builderArtifactContentHandler(url: URL): Response {
  const reason = dbUnavailable();
  if (reason) return apiError(reason, 503);
  const runId = url.searchParams.get("runId");
  const kind = url.searchParams.get("kind");
  const passSeq = url.searchParams.get("pass");
  if (!runId || !kind) return apiError("runId and kind are required");
  const runDir = `/var/lib/control-surface/builder-runs/${runId}`;
  const filename = passSeq ? `pass-${passSeq}-${kind}.log` : `pass-1-${kind}.log`;
  const path = `${runDir}/${filename}`;
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    if (!existsSync(path)) return apiError("log not found", 404);
    const content = readFileSync(path, "utf8");
    return new Response(content, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    return apiError(errorMessage(err), 500);
  }
}

export function builderModelsHandler(): Response {
  return json<BuilderModelsInventory>(ok(getBuilderModelsInventory(), { builder: "ok", models: "ok" }));
}

function dbUnavailable(): string | null {
  return isDashboardDbEnabled() ? null : "DASHBOARD_DB disabled";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function parseWorkflowInput(req: Request): Promise<BuilderWorkflowInput> {
  const body = await req.json() as Partial<BuilderWorkflowInput>;
  const validationProfile = (body.config?.validationProfile ?? { commands: [], internal: [], runtime: [], public: [] }) as {
    commands?: string[];
    internal?: string[];
    runtime?: string[];
    public?: string[];
    playwright?: unknown;
    internalUrl?: string | null;
    publicUrl?: string | null;
  };
  return {
    name: String(body.name ?? ""),
    projectRoot: String(body.projectRoot ?? body.config?.projectRoot ?? ""),
    planFile: String(body.planFile ?? ""),
    mode: body.mode ?? "once",
    status: body.status ?? "draft",
    nextRunAt: body.nextRunAt ?? null,
    pausedReason: body.pausedReason ?? null,
    config: {
      projectRoot: String(body.projectRoot ?? body.config?.projectRoot ?? ""),
      agentOrder: Array.isArray(body.config?.agentOrder) ? body.config.agentOrder : ["opencode", "gemini", "codex", "claude"],
      modelPolicy: {
        planner: body.config?.modelPolicy?.planner,
        builder: body.config?.modelPolicy?.builder,
        reviewer: body.config?.modelPolicy?.reviewer,
        fallbackTargets: Array.isArray(body.config?.modelPolicy?.fallbackTargets)
          ? body.config.modelPolicy.fallbackTargets
          : [
              "opencode-go/minimax-m2.7",
              "opencode-go/kimi-k2.6",
              "opencode-go/kimi-k2.5",
              "opencode-go/minimax-m2.5",
              "opencode/minimax-m2.7",
              "opencode/kimi-k2.6",
              "opencode/kimi-k2.5",
              "opencode/minimax-m2.5",
              "opencode/minimax-m2.5-free",
              "opencode-go/deepseek-v4-pro",
              "opencode-go/qwen3.6-plus",
              "alibaba/qwen-plus",
              "groq-llama4-scout",
              "groq-llama70b",
              "openrouter-nemotron-120b-free",
              "openrouter-gemma4-31b-free",
              "openrouter-qwen3-80b-free",
            ],
      },
      validationProfile: {
        commands: Array.isArray(validationProfile.commands) ? validationProfile.commands : [],
        internal: Array.isArray((validationProfile as { internal?: string[] }).internal) ? (validationProfile as { internal: string[] }).internal : [],
        runtime: Array.isArray((validationProfile as { runtime?: string[] }).runtime) ? (validationProfile as { runtime: string[] }).runtime : [],
        public: Array.isArray((validationProfile as { public?: string[] }).public) ? (validationProfile as { public: string[] }).public : [],
        playwright: (validationProfile as { playwright?: BuilderWorkflowInput["config"]["validationProfile"]["playwright"] }).playwright,
        internalUrl: validationProfile.internalUrl ?? null,
        publicUrl: validationProfile.publicUrl ?? null,
      },
      gitPolicy: {
        commit: body.config?.gitPolicy?.commit ?? "manual",
        push: body.config?.gitPolicy?.push ?? "never",
      },
      backupPolicy: {
        enabled: Boolean(body.config?.backupPolicy?.enabled),
        beforeRun: Boolean(body.config?.backupPolicy?.beforeRun),
      },
      schedule: body.config?.schedule,
      riskPolicy: {
        liveDeploys: body.config?.riskPolicy?.liveDeploys ?? "disabled",
        maxPasses: Number.isFinite(body.config?.riskPolicy?.maxPasses)
          ? Number(body.config?.riskPolicy?.maxPasses)
          : 1,
        passTimeoutSeconds: Number.isFinite(body.config?.riskPolicy?.passTimeoutSeconds)
          ? Number(body.config?.riskPolicy?.passTimeoutSeconds)
          : undefined,
      },
      geminiApprovalMode: ["default", "auto_edit", "plan", "yolo"].includes(body.config?.geminiApprovalMode as string)
        ? (body.config?.geminiApprovalMode as "default" | "auto_edit" | "plan" | "yolo")
        : "auto_edit",
      effortLevel: ["low", "medium", "high"].includes(body.config?.effortLevel as string)
        ? (body.config?.effortLevel as "low" | "medium" | "high")
        : "medium",
      sourceSession: parseSourceSession(body.config?.sourceSession),
    },
  };
}

function parseSourceSession(value: unknown): BuilderWorkflowInput["config"]["sourceSession"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const agent = typeof raw.agent === "string" ? raw.agent : "";
  if (!["claude", "codex", "opencode", "gemini"].includes(agent)) return undefined;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  if (!sessionId) return undefined;
  return {
    agent: agent as "claude" | "codex" | "opencode" | "gemini",
    sessionId,
    title: typeof raw.title === "string" ? raw.title.slice(0, 240) : undefined,
    directory: typeof raw.directory === "string" ? raw.directory.slice(0, 500) : undefined,
    messageCount: Number.isFinite(raw.messageCount) ? Number(raw.messageCount) : undefined,
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt.slice(0, 80) : undefined,
    transcriptSummary: typeof raw.transcriptSummary === "string" ? raw.transcriptSummary.slice(0, 1000) : undefined,
    latestUserPrompt: typeof raw.latestUserPrompt === "string" ? raw.latestUserPrompt.slice(0, 1000) : undefined,
    touchedFiles: Array.isArray(raw.touchedFiles)
      ? raw.touchedFiles
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 40)
      : undefined,
  };
}

export function builderWorkflowsHandler(): Response {
  const reason = dbUnavailable();
  if (reason) {
    return json(ok<BuilderWorkflowsResponse>({ workflows: [], degraded: true, reason }, { builder: "stale" }));
  }
  return json(ok<BuilderWorkflowsResponse>({ workflows: readBuilderWorkflows(), degraded: false }, { builder: "ok" }));
}

export function builderWorkflowHandler(id: string): Response {
  const reason = dbUnavailable();
  if (reason) {
    return json(ok<BuilderWorkflowResponse>({ workflow: null, runs: [], degraded: true, reason }, { builder: "stale" }));
  }

  const workflow = readBuilderWorkflow(id);
  if (!workflow) return apiError("not found", 404);
  return json(ok<BuilderWorkflowResponse>({
    workflow,
    runs: readBuilderRuns(id),
    degraded: false,
  }, { builder: "ok" }));
}

export async function builderCreateWorkflowHandler(req: Request): Promise<Response> {
  try {
    const input = await parseWorkflowInput(req);
    let computedNextRunAt = input.nextRunAt ?? null;
    if (input.mode === "scheduled" && input.config.schedule?.expression) {
      computedNextRunAt = getNextRunTime(
        input.config.schedule.expression,
        input.config.schedule.timezone ?? "UTC"
      );
    }
    if (input.mode !== "scheduled") {
      computedNextRunAt = null;
    }
    const inputWithNextRun = { ...input, nextRunAt: computedNextRunAt };
    const workflow = createBuilderWorkflow(inputWithNextRun);
    writeActionAudit({
      actionKind: "builder.workflow.create",
      actionId: `builder-workflow:create:${workflow.id}`,
      targetType: "builder-workflow",
      targetId: workflow.id,
      risk: "medium",
      request: input,
      result: `created ${workflow.name}`,
      resultStatus: "success",
      evidence: [{ label: "Builder workflow", kind: "db", ref: `builder_workflows:${workflow.id}` }],
      rollbackHint: "Edit the workflow back to draft or cancel it before Phase 3 execution is enabled.",
    });
    return json(ok<BuilderWorkflowResponse>({
      workflow,
      runs: [],
      degraded: false,
    }, { builder: "ok" }), 201);
  } catch (error) {
    writeActionAudit({
      actionKind: "builder.workflow.create",
      targetType: "builder-workflow",
      targetId: "new",
      risk: "medium",
      resultStatus: "failed",
      error: errorMessage(error),
    });
    return apiError(errorMessage(error), 400);
  }
}

export async function builderUpdateWorkflowHandler(req: Request, id: string): Promise<Response> {
  try {
    const input = await parseWorkflowInput(req);
    let computedNextRunAt = input.nextRunAt ?? null;
    if (input.mode === "scheduled" && input.config.schedule?.expression) {
      computedNextRunAt = getNextRunTime(
        input.config.schedule.expression,
        input.config.schedule.timezone ?? "UTC"
      );
    }
    if (input.mode !== "scheduled") {
      computedNextRunAt = null;
    }
    const inputWithNextRun = { ...input, nextRunAt: computedNextRunAt };
    const workflow = updateBuilderWorkflow(id, inputWithNextRun);
    if (!workflow) return apiError("not found", 404);
    writeActionAudit({
      actionKind: "builder.workflow.update",
      actionId: `builder-workflow:update:${workflow.id}`,
      targetType: "builder-workflow",
      targetId: workflow.id,
      risk: "medium",
      request: input,
      result: `updated ${workflow.name}`,
      resultStatus: "success",
      evidence: [{ label: "Builder workflow", kind: "db", ref: `builder_workflows:${workflow.id}` }],
      rollbackHint: "Review the prior audit record and edit this draft workflow again.",
    });
    return json(ok<BuilderWorkflowResponse>({
      workflow,
      runs: readBuilderRuns(id),
      degraded: false,
    }, { builder: "ok" }));
  } catch (error) {
    writeActionAudit({
      actionKind: "builder.workflow.update",
      targetType: "builder-workflow",
      targetId: id,
      risk: "medium",
      resultStatus: "failed",
      error: errorMessage(error),
    });
    return apiError(errorMessage(error), 400);
  }
}

export async function builderDeleteWorkflowHandler(id: string): Promise<Response> {
  try {
    const workflow = readBuilderWorkflow(id);
    if (!workflow) return apiError("not found", 404);

    deleteBuilderWorkflow(id);
    writeActionAudit({
      actionKind: "builder.workflow.delete",
      actionId: `builder-workflow:delete:${id}`,
      targetType: "builder-workflow",
      targetId: id,
      risk: "medium",
      result: `deleted ${workflow.name}`,
      resultStatus: "success",
      evidence: [{ label: "Builder workflow", kind: "db", ref: `builder_workflows:${id}` }],
      rollbackHint: "Cannot undo - workflow and its runs are permanently deleted.",
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    writeActionAudit({
      actionKind: "builder.workflow.delete",
      targetType: "builder-workflow",
      targetId: id,
      risk: "medium",
      resultStatus: "failed",
      error: errorMessage(error),
    });
    return apiError(errorMessage(error), 400);
  }
}

export function builderRunsHandler(url: URL): Response {
  const reason = dbUnavailable();
  if (reason) {
    return json(ok<BuilderRunsResponse>({ runs: [], degraded: true, reason }, { builder: "stale" }));
  }

  return json(ok<BuilderRunsResponse>({
    runs: readBuilderRuns(url.searchParams.get("workflowId") ?? undefined),
    degraded: false,
  }, { builder: "ok" }));
}

export function builderRunHandler(id: string): Response {
  const reason = dbUnavailable();
  if (reason) {
    return json(ok<BuilderRunResponse>({
      run: null,
      workflow: null,
      passes: [],
      artifacts: [],
      validations: [],
      degraded: true,
      reason,
    }, { builder: "stale" }));
  }

  const run = readBuilderRun(id);
  if (!run) return apiError("not found", 404);
  return json(ok<BuilderRunResponse>({
    run,
    workflow: readBuilderWorkflow(run.workflowId),
    passes: readBuilderPasses(id),
    artifacts: readBuilderArtifacts(id),
    validations: readBuilderValidations(id),
    degraded: false,
  }, { builder: "ok" }));
}

export function builderArtifactsHandler(url: URL): Response {
  const reason = dbUnavailable();
  if (reason) {
    return json(ok<BuilderArtifactsResponse>({
      artifacts: [],
      validations: [],
      degraded: true,
      reason,
    }, { builder: "stale" }));
  }

  const runId = url.searchParams.get("runId");
  if (!runId) return apiError("runId required");
  return json(ok<BuilderArtifactsResponse>({
    artifacts: readBuilderArtifacts(runId),
    validations: readBuilderValidations(runId),
    degraded: false,
  }, { builder: "ok" }));
}

export async function builderStartWorkflowHandler(workflowId: string, req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    const run = await startWorkflowRun(workflowId, "manual");
    writeActionAudit({
      actionKind: "builder.workflow.start",
      actionId: `builder-workflow:start:${workflowId}`,
      targetType: "builder-workflow",
      targetId: workflowId,
      risk: "high",
      request: { reason: body.reason },
      result: `started run ${run.id}`,
      resultStatus: "success",
      evidence: [{ label: "Builder run", kind: "db", ref: `builder_runs:${run.id}` }],
      rollbackHint: "Stop the run from the builder page.",
    });
    return json(ok<BuilderRunResponse>({
      run,
      passes: readBuilderPasses(run.id),
      artifacts: readBuilderArtifacts(run.id),
      validations: readBuilderValidations(run.id),
      degraded: false,
    }, { builder: "ok" }), 201);
  } catch (error) {
    writeActionAudit({
      actionKind: "builder.workflow.start",
      targetType: "builder-workflow",
      targetId: workflowId,
      risk: "high",
      resultStatus: "failed",
      error: errorMessage(error),
    });
    return apiError(errorMessage(error), 400);
  }
}

export async function builderStopWorkflowHandler(workflowId: string, req: Request): Promise<Response> {
  try {
    const workflow = readBuilderWorkflow(workflowId);
    if (!workflow) return apiError("not found", 404);
    if (!workflow.lastRunId) return apiError("no active run", 400);

    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    await stopWorkflowRun(workflow.lastRunId, body.reason ?? "operator");

    writeActionAudit({
      actionKind: "builder.workflow.stop",
      actionId: `builder-workflow:stop:${workflowId}`,
      targetType: "builder-workflow",
      targetId: workflowId,
      risk: "medium",
      request: { reason: body.reason },
      result: `stopped run ${workflow.lastRunId}`,
      resultStatus: "success",
      rollbackHint: "Start a new run from the builder page.",
    });

    return json(ok<BuilderWorkflowResponse>({
      workflow: readBuilderWorkflow(workflowId),
      runs: readBuilderRuns(workflowId),
      degraded: false,
    }, { builder: "ok" }));
  } catch (error) {
    return apiError(errorMessage(error), 400);
  }
}

export async function builderPauseWorkflowHandler(workflowId: string): Promise<Response> {
  try {
    await pauseWorkflow(workflowId);
    return json(ok<BuilderWorkflowResponse>({
      workflow: readBuilderWorkflow(workflowId),
      runs: readBuilderRuns(workflowId),
      degraded: false,
    }, { builder: "ok" }));
  } catch (error) {
    return apiError(errorMessage(error), 400);
  }
}

export async function builderResumeWorkflowHandler(workflowId: string): Promise<Response> {
  try {
    await resumeWorkflow(workflowId);
    return json(ok<BuilderWorkflowResponse>({
      workflow: readBuilderWorkflow(workflowId),
      runs: readBuilderRuns(workflowId),
      degraded: false,
    }, { builder: "ok" }));
  } catch (error) {
    return apiError(errorMessage(error), 400);
  }
}

export async function builderRetryRunHandler(runId: string): Promise<Response> {
  try {
    const run = await retryRun(runId);
    return json(ok<BuilderRunResponse>({
      run,
      passes: readBuilderPasses(run.id),
      artifacts: readBuilderArtifacts(run.id),
      validations: readBuilderValidations(run.id),
      degraded: false,
    }, { builder: "ok" }), 201);
  } catch (error) {
    return apiError(errorMessage(error), 400);
  }
}

export async function builderCancelRunHandler(runId: string): Promise<Response> {
  try {
    await cancelRun(runId);
    const run = await reconcileRunStatus(runId);
    return json(ok<BuilderRunResponse>({
      run,
      passes: readBuilderPasses(runId),
      artifacts: readBuilderArtifacts(runId),
      validations: readBuilderValidations(runId),
      degraded: false,
    }, { builder: "ok" }));
  } catch (error) {
    return apiError(errorMessage(error), 400);
  }
}

export async function builderRunReconcileHandler(runId: string): Promise<Response> {
  const run = await reconcileRunStatus(runId);
  if (!run) return apiError("not found", 404);
  return json(ok<BuilderRunResponse>({
    run,
    passes: readBuilderPasses(runId),
    artifacts: readBuilderArtifacts(runId),
    validations: readBuilderValidations(runId),
    degraded: false,
  }, { builder: "ok" }));
}

export function builderRunnerDisabledHandler(action: string): Response {
  return new Response(JSON.stringify({
    error: "builder runner disabled until Phase 3",
    action,
    status: "disabled",
  }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });
}

export type BuilderDoctorReportsResponse = {
  reports: BuilderDoctorReport[];
  degraded: boolean;
  reason?: string;
};

export type BuilderProvisionResponse = {
  result: ProvisionResult;
  degraded: boolean;
  reason?: string;
};

export function builderDoctorReportsHandler(url: URL): Response {
  const reason = dbUnavailable();
  if (reason) {
    return json(ok<BuilderDoctorReportsResponse>({ reports: [], degraded: true, reason }, { builder: "stale" }));
  }

  const workflowId = url.searchParams.get("workflowId") || undefined;
  const runId = url.searchParams.get("runId") || undefined;
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);

  const reports = readBuilderDoctorReports(workflowId, runId, limit || 10);
  return json(ok<BuilderDoctorReportsResponse>({ reports, degraded: false }, { builder: "ok" }));
}

export async function builderTriggerDoctorReviewHandler(workflowId: string): Promise<Response> {
  try {
    const workflow = readBuilderWorkflow(workflowId);
    if (!workflow) return apiError("workflow not found", 404);

    const run = await startWorkflowRun(workflowId, "doctor-review");
    writeActionAudit({
      actionKind: "builder.doctor-review",
      actionId: `builder-doctor-review:${workflowId}`,
      targetType: "builder-workflow",
      targetId: workflowId,
      risk: "medium",
      result: `started doctor run ${run.id}`,
      resultStatus: "success",
      evidence: [{ label: "Doctor review", kind: "doctor", ref: run.id }],
    });

    return json(ok({
      run,
      degraded: false,
    }, { builder: "ok" }), 201);
  } catch (error) {
    writeActionAudit({
      actionKind: "builder.doctor-review",
      targetType: "builder-workflow",
      targetId: workflowId,
      resultStatus: "failed",
      error: errorMessage(error),
    });
    return apiError(errorMessage(error), 400);
  }
}

export async function builderProvisionHandler(req: Request): Promise<Response> {
  const reason = dbUnavailable();
  if (reason) {
    return json(ok<BuilderProvisionResponse>({ result: { id: "", projectRoot: "", name: "", workflowId: "", workflowStatus: "", provisioned: { cloned: false, gitInitialized: false, agentsMd: false, planFile: null, vaultNote: false, skillFile: false }, warnings: [], error: reason }, degraded: true, reason }, { builder: "stale" }));
  }

  try {
    const body = await req.json() as Partial<{
      projectRoot: string;
      name: string;
      repoUrl: string;
      description: string;
      tags: string[];
      owner: string;
      planFile: string;
      agentOrder: string[];
      fallbackTargets: string[];
      validationCommands: string[];
      gitPolicy: { commit: string; push: string };
      internalUrl: string;
      publicUrl: string;
    }>;

    const projectRoot = String(body.projectRoot ?? "").trim();
    if (!projectRoot) return apiError("projectRoot required");
    const name = String(body.name ?? "").trim();
    if (!name) return apiError("name required");
    if (name.length > 120) return apiError("name too long (max 120 chars)");

    // Validate path is outside existing static roots (prevent overwrite of live services)
    const STATIC_ROOTS = ["/opt/opencode-control-surface", "/opt/newsbites", "/opt/mimoun", "/opt/paperclip", "/opt", "/root"];
    const resolved = resolve(projectRoot);
    if (STATIC_ROOTS.some(r => resolved === r || resolved.startsWith(r + "/"))) {
      return apiError(`cannot provision inside protected root: ${projectRoot}`, 403);
    }

    const result = provisionProject({
      projectRoot: resolved,
      name,
      repoUrl: body.repoUrl?.trim() || undefined,
      description: body.description?.trim(),
      tags: Array.isArray(body.tags) ? body.tags : [],
      owner: body.owner?.trim(),
      planFile: String(body.planFile ?? ""),
      agentOrder: Array.isArray(body.agentOrder) ? body.agentOrder : ["codex", "claude", "opencode"],
      fallbackTargets: Array.isArray(body.fallbackTargets) ? body.fallbackTargets : [],
      validationCommands: Array.isArray(body.validationCommands) ? body.validationCommands : [],
      gitPolicy: body.gitPolicy ?? { commit: "manual", push: "never" },
      internalUrl: body.internalUrl?.trim() || undefined,
      publicUrl: body.publicUrl?.trim() || undefined,
    });

    writeActionAudit({
      actionKind: "builder.provision",
      actionId: `builder-provision:${resolved}`,
      targetType: "builder-project",
      targetId: result.id || resolved,
      risk: "medium",
      request: { projectRoot: resolved, name, repoUrl: body.repoUrl },
      result: result.error
        ? `provision failed: ${result.error}`
        : `provisioned ${name} at ${resolved}, workflow ${result.workflowId}`,
      resultStatus: result.error ? "failed" : "success",
      evidence: [
        { label: "projectRoot", kind: "file" as const, ref: resolved },
        { label: "workflow", kind: "db" as const, ref: `builder_workflows:${result.workflowId}` },
      ],
      rollbackHint: result.error ? undefined : "Delete the provisioned workflow from /builder and remove the project directory.",
    });

    return json(ok<BuilderProvisionResponse>({ result, degraded: false }, { builder: "ok" }), 201);
  } catch (error) {
    writeActionAudit({
      actionKind: "builder.provision",
      targetType: "builder-project",
      targetId: "new",
      risk: "medium",
      resultStatus: "failed",
      error: errorMessage(error),
    });
    return apiError(errorMessage(error), 400);
  }
}
