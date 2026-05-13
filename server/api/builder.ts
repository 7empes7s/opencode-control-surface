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
  readBuilderArtifacts,
  readBuilderDoctorReports,
  readBuilderPasses,
  readBuilderRun,
  readBuilderRuns,
  readBuilderValidations,
  readBuilderWorkflow,
  readBuilderWorkflows,
  updateBuilderWorkflow,
  type BuilderArtifact,
  type BuilderDoctorReport,
  type BuilderPass,
  type BuilderRun,
  type BuilderValidation,
  type BuilderWorkflow,
  type BuilderWorkflowInput,
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
      agentOrder: Array.isArray(body.config?.agentOrder) ? body.config.agentOrder : ["codex", "claude", "opencode"],
      modelPolicy: {
        planner: body.config?.modelPolicy?.planner,
        builder: body.config?.modelPolicy?.builder,
        reviewer: body.config?.modelPolicy?.reviewer,
        fallbackTargets: Array.isArray(body.config?.modelPolicy?.fallbackTargets)
          ? body.config.modelPolicy.fallbackTargets
          : [],
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
      },
    },
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
