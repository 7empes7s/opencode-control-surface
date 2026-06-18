import { resolve } from "node:path";
import { createBrainstormSession, runBrainstormLoop } from "../builder/brainstorm-orchestrator.ts";
import { startPreview, stopPreview, getPreview, getPreviewLog, type PreviewTarget } from "../builder/preview-server.ts";
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
  BUILDER_DEFAULT_MAX_PASSES,
  BUILDER_DEFAULT_PASS_TIMEOUT_SECONDS,
  BUILDER_DEFAULT_STALL_TIMEOUT_SECONDS,
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
  setBuilderWorkflowLifecycle,
  provisionProject,
  type BuilderArtifact,
  type BuilderDoctorReport,
  type BuilderLifecycle,
  type BuilderPass,
  type BuilderRun,
  type BuilderValidation,
  type BuilderWorkflow,
  type BuilderWorkflowInput,
  type ProvisionResult,
} from "../builder/store.ts";
import { isDashboardDbEnabled, getDashboardDb } from "../db/dashboard.ts";
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
  classifyFailureDiagnosis,
  updateBuilderRun,
  classifyStopReason,
  type FailureDiagnosis,
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
  const runId = url.searchParams.get("runId");
  const kind = url.searchParams.get("kind");
  const passSeq = url.searchParams.get("pass");
  if (!runId || !kind) return apiError("runId and kind are required");
  const filename = passSeq ? `pass-${passSeq}-${kind}.log` : `pass-1-${kind}.log`;
  const { readFileSync, existsSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  const serve = (p: string) => new Response(readFileSync(p, "utf8"), { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });

  // 1. Legacy flat path
  const flatPath = `/var/lib/control-surface/builder-runs/${runId}/${filename}`;
  if (existsSync(flatPath)) return serve(flatPath);

  // 2. DB-assisted: JOIN runs→workflows to get project_id (isolated, never throws up)
  try {
    const db = getDashboardDb();
    if (db) {
      const row = db.query(
        `SELECT r.tenant_id, w.project_id FROM builder_runs r LEFT JOIN builder_workflows w ON r.workflow_id = w.id WHERE r.id = ?`
      ).get(runId) as { tenant_id: string | null; project_id: string | null } | null;
      if (row) {
        const tid = (row.tenant_id || "mimule").replace(/[^a-zA-Z0-9._-]/g, "_");
        const pid = (row.project_id || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
        const dbPath = `/var/lib/control-surface/tenants/${tid}/projects/${pid}/builder-runs/${runId}/${filename}`;
        if (existsSync(dbPath)) return serve(dbPath);
      }
    }
  } catch { /* fall through to scan */ }

  // 3. Directory scan fallback — works even if DB is unavailable or schema drifts
  const tenantsBase = "/var/lib/control-surface/tenants";
  if (existsSync(tenantsBase)) {
    for (const tid of readdirSync(tenantsBase)) {
      const projectsBase = `${tenantsBase}/${tid}/projects`;
      if (!existsSync(projectsBase)) continue;
      for (const pid of readdirSync(projectsBase)) {
        const candidate = `${projectsBase}/${pid}/builder-runs/${runId}/${filename}`;
        if (existsSync(candidate)) return serve(candidate);
      }
    }
  }

  return apiError("log not found", 404);
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
  const mode = body.mode ?? "once";
  const defaultMaxPasses = mode === "once" ? 1 : BUILDER_DEFAULT_MAX_PASSES;
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
    mode,
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
          : defaultMaxPasses,
        passTimeoutSeconds: Number.isFinite(body.config?.riskPolicy?.passTimeoutSeconds)
          ? Number(body.config?.riskPolicy?.passTimeoutSeconds)
          : BUILDER_DEFAULT_PASS_TIMEOUT_SECONDS,
        stallTimeoutSeconds: Number.isFinite(body.config?.riskPolicy?.stallTimeoutSeconds)
          ? Number(body.config?.riskPolicy?.stallTimeoutSeconds)
          : BUILDER_DEFAULT_STALL_TIMEOUT_SECONDS,
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
    assistantSummary: typeof raw.assistantSummary === "string" ? raw.assistantSummary.slice(0, 1000) : undefined,
    touchedFiles: Array.isArray(raw.touchedFiles)
      ? raw.touchedFiles
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 40)
      : undefined,
    touchedFileSummary: typeof raw.touchedFileSummary === "string" ? raw.touchedFileSummary.slice(0, 1000) : undefined,
    recentTurns: Array.isArray(raw.recentTurns)
      ? raw.recentTurns
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => ({
            role: typeof item.role === "string" ? item.role.slice(0, 24) : "message",
            text: typeof item.text === "string" ? item.text.slice(0, 700) : "",
          }))
          .filter((item) => item.text.trim())
          .slice(0, 8)
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

// Serves a workflow's plan markdown plus the configured live-preview URL so the
// operator can review the plan AND the built app directly in the builder page.
export function builderWorkflowPlanHandler(id: string): Response {
  const reason = dbUnavailable();
  if (reason) return apiError(reason, 503);
  const workflow = readBuilderWorkflow(id);
  if (!workflow) return apiError("not found", 404);

  const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
  let content = "";
  let exists = false;
  if (workflow.planFile && existsSync(workflow.planFile)) {
    exists = true;
    try { content = readFileSync(workflow.planFile, "utf8").slice(0, 200_000); } catch { /* unreadable */ }
  }
  // Count checklist progress so the preview can show "X of Y items done".
  const totalItems = (content.match(/^\s*- \[[ xX]\]/gm) ?? []).length;
  const doneItems = (content.match(/^\s*- \[[xX]\]/gm) ?? []).length;

  const vp = workflow.config.validationProfile ?? ({} as Record<string, unknown>);
  const previewUrl = (vp.publicUrl as string) || (vp.internalUrl as string) || null;

  return json(ok({
    planFile: workflow.planFile,
    exists,
    content,
    previewUrl,
    projectRoot: workflow.projectRoot,
    status: workflow.status,
    checklist: { total: totalItems, done: doneItems },
  }, { builder: "ok" }));
}

// "Add features / iterate" — starts a NEW planner run that builds on top of the
// existing built application. Creates a brainstorm session in 'existing' mode
// pointed at the workflow's project root (so the planner runs a codebase-analyst
// pre-pass and preserves current conventions), then kicks off the planner loop.
// Returns the new sessionId so the UI can deep-link to the brainstorm session.
export async function builderWorkflowIterateHandler(id: string, req: Request): Promise<Response> {
  const reason = dbUnavailable();
  if (reason) return apiError(reason, 503);
  const workflow = readBuilderWorkflow(id);
  if (!workflow) return apiError("not found", 404);

  let body: { message?: unknown } = {};
  try { body = await req.json(); } catch { /* tolerate empty body */ }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return apiError("message is required");
  if (!workflow.projectRoot) return apiError("workflow has no project root to iterate on");

  const db = getDashboardDb();
  if (!db) return apiError("database unavailable", 503);

  const sessionId = crypto.randomUUID().replace(/-/g, "");
  const tenantId = workflow.tenantId || "mimule";
  try {
    await createBrainstormSession({
      id: sessionId,
      name: `${workflow.name} — add features`,
      description: message,
      specs: `Iterate on the EXISTING application at ${workflow.projectRoot}. Add the requested feature(s) on top of the current codebase, preserving existing conventions and not breaking current functionality.`,
      tenantId,
      project_mode: "existing",
      codebase_path: workflow.projectRoot,
    });
    // Move straight to running and launch the planner loop in the background.
    db.prepare("UPDATE brainstorm_sessions SET status = 'running', updated_at = ? WHERE id = ?")
      .run(Date.now(), sessionId);
    void runBrainstormLoop(sessionId).catch((e) => console.error("[builder.iterate] planner loop failed", e));
  } catch (e) {
    return apiError(`couldn't start iteration: ${e instanceof Error ? e.message : String(e)}`, 500);
  }

  return json(ok({ sessionId, tenantId }, { builder: "ok" }));
}

// ── Live preview: launch the built app's dev server + public tunnel ──────────
const PREVIEW_TARGETS: PreviewTarget[] = ["web", "mobile-web", "mobile-device", "fullstack"];

export async function builderWorkflowPreviewStartHandler(id: string, req: Request): Promise<Response> {
  const reason = dbUnavailable();
  if (reason) return apiError(reason, 503);
  const workflow = readBuilderWorkflow(id);
  if (!workflow) return apiError("not found", 404);
  if (!workflow.projectRoot) return apiError("workflow has no project root to preview");

  let body: { target?: unknown } = {};
  try { body = await req.json(); } catch { /* default below */ }
  const target = (PREVIEW_TARGETS.includes(body.target as PreviewTarget) ? body.target : "web") as PreviewTarget;

  try {
    const record = await startPreview(id, workflow.projectRoot, target);
    return json(ok({ preview: record }, { builder: "ok" }));
  } catch (e) {
    return apiError(`couldn't start preview: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}

export function builderWorkflowPreviewStatusHandler(id: string): Response {
  const record = getPreview(id);
  return json(ok({ preview: record, log: record ? getPreviewLog(id).slice(-2000) : "" }, { builder: "ok" }));
}

export async function builderWorkflowPreviewStopHandler(id: string): Promise<Response> {
  await stopPreview(id);
  return json(ok({ stopped: true }, { builder: "ok" }));
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

export async function builderSetLifecycleHandler(workflowId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({})) as { lifecycle?: unknown };
    const raw = body.lifecycle;
    const valid: Array<BuilderLifecycle | null> = ["new", "in-progress", "done", null];
    const lifecycle = (raw === null || raw === "new" || raw === "in-progress" || raw === "done")
      ? raw as (BuilderLifecycle | null)
      : undefined;
    if (lifecycle === undefined) {
      return apiError(`Invalid lifecycle. Expected one of: ${valid.map(v => v ?? "null").join(", ")}`, 400);
    }
    const workflow = setBuilderWorkflowLifecycle(workflowId, lifecycle);
    if (!workflow) return apiError("Workflow not found", 404);
    writeActionAudit({
      actionKind: "builder.workflow.lifecycle",
      actionId: `builder-workflow:lifecycle:${workflowId}`,
      targetType: "builder-workflow",
      targetId: workflowId,
      risk: "low",
      result: `lifecycle set to ${lifecycle ?? "auto"}`,
      resultStatus: "success",
    });
    return json(ok<BuilderWorkflowResponse>({
      workflow,
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

export async function builderStopAfterPassHandler(runId: string): Promise<Response> {
  try {
    const run = readBuilderRun(runId);
    if (!run) return apiError("not found", 404);
    const resultObj = typeof run.result === "object" && run.result ? run.result as Record<string, unknown> : {};
    updateBuilderRun(runId, { result: { ...resultObj, stopAfterPass: true, stopAfterPassAt: Date.now() } });
    const updated = readBuilderRun(runId);
    return json(ok<BuilderRunResponse>({
      run: updated,
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

const DEFAULT_PROVISION_ROOTS = ["/opt/provisioned", "/var/lib/control-surface/projects"];
const PROTECTED_PROVISION_ROOTS = [
  "/opt/opencode-control-surface",
  "/opt/newsbites",
  "/opt/mimoun",
  "/opt/paperclip",
  "/root",
];

function parseProvisionRoots(): string[] {
  const extra = (process.env.BUILDER_PROVISION_ROOTS_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...DEFAULT_PROVISION_ROOTS, ...extra].map((entry) => resolve(entry));
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

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
    return json(ok<BuilderProvisionResponse>({ result: { id: "", projectRoot: "", name: "", workflowId: "", workflowStatus: "", provisioned: { cloned: false, gitInitialized: false, agentsMd: false, planFile: null, vaultNote: false, skillFile: false, validationProfileFile: null, runtimeScaffoldFiles: [] }, validationCommands: [], warnings: [], error: reason }, degraded: true, reason }, { builder: "stale" }));
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
      runtimeScaffold: boolean;
    }>;

    const projectRoot = String(body.projectRoot ?? "").trim();
    if (!projectRoot) return apiError("projectRoot required");
    const name = String(body.name ?? "").trim();
    if (!name) return apiError("name required");
    if (name.length > 120) return apiError("name too long (max 120 chars)");

    const resolved = resolve(projectRoot);
    if (PROTECTED_PROVISION_ROOTS.some((root) => isPathWithin(resolved, root))) {
      return apiError(`cannot provision inside protected root: ${projectRoot}`, 403);
    }
    if (!parseProvisionRoots().some((root) => isPathWithin(resolved, root))) {
      return apiError(`projectRoot must be under ${parseProvisionRoots().join(" or ")}`, 403);
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
      runtimeScaffold: body.runtimeScaffold === true,
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

export type BuilderPassDiagnosisResponse = {
  diagnosis: FailureDiagnosis;
  degraded: boolean;
  reason?: string;
};

export function builderPassDiagnosisHandler(passId: string): Response {
  const reason = dbUnavailable();
  if (reason) {
    return json(ok<BuilderPassDiagnosisResponse>({ diagnosis: {} as FailureDiagnosis, degraded: true, reason }, { builder: "stale" }));
  }

  // Find the pass by iterating through runs
  const runs = readBuilderRuns();
  let foundPass: BuilderPass | null = null;
  let foundRunId: string | null = null;

  for (const run of runs) {
    const passes = readBuilderPasses(run.id);
    const pass = passes.find(p => p.id === passId);
    if (pass) {
      foundPass = pass;
      foundRunId = run.id;
      break;
    }
  }

  if (!foundPass || !foundRunId) {
    return apiError("Pass not found", 404);
  }

  // Read stdout artifact for context
  const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const artifacts = readBuilderArtifacts(foundRunId);
  const stdoutArtifact = artifacts.find(a => a.passId === passId && a.kind === "stdout");
  let stdoutTail = "";
  if (stdoutArtifact && existsSync(stdoutArtifact.path)) {
    try { stdoutTail = readFileSync(stdoutArtifact.path, "utf8").slice(-3000); } catch {}
  }

  const diagnosis = classifyFailureDiagnosis(foundPass, stdoutTail);
  return json(ok<BuilderPassDiagnosisResponse>({ diagnosis, degraded: false }, { builder: "ok" }));
}

export type BuilderRunSummaryResponse = {
  runId: string;
  status: string;
  trigger: string;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  passCount: number;
  successPasses: number;
  failedPasses: number;
  lastAgent: string | null;
  lastModel: string | null;
  planItemsDone: number | null;
  planItemsRemaining: number | null;
  completionPercent: number | null;
  filesEdited: string[];
  filesCreated: string[];
  unresolvedErrors: number | null;
};

export function builderRunSummaryHandler(runId: string): Response {
  const reason = dbUnavailable();
  if (reason) {
    return apiError("db unavailable", 503);
  }

  const runs = readBuilderRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) {
    return apiError("Run not found", 404);
  }

  const passes = readBuilderPasses(runId);
  const lastPass = passes.length > 0 ? passes[passes.length - 1] : null;

  let planItemsDone: number | null = null;
  let planItemsRemaining: number | null = null;
  let completionPercent: number | null = null;
  const filesEdited: string[] = [];
  const filesCreated: string[] = [];
  let unresolvedErrors: number | null = null;

  // Aggregate analytics from passes (analyticsJson is written to DB by runner.ts but not yet typed on BuilderPass)
  for (const pass of passes) {
    const aj = (pass as Record<string, unknown>).analyticsJson;
    if (typeof aj === "string") {
      try {
        const a = JSON.parse(aj) as Record<string, unknown>;
        if (typeof a.planItemsDone === "number") planItemsDone = (planItemsDone ?? 0) + a.planItemsDone;
        if (typeof a.planItemsRemaining === "number") planItemsRemaining = a.planItemsRemaining;
        if (typeof a.completionPercent === "number") completionPercent = a.completionPercent;
        if (Array.isArray(a.filesEdited)) for (const f of a.filesEdited) if (typeof f === "string" && !filesEdited.includes(f)) filesEdited.push(f);
        if (Array.isArray(a.filesCreated)) for (const f of a.filesCreated) if (typeof f === "string" && !filesCreated.includes(f)) filesCreated.push(f);
        if (typeof a.unresolvedErrors === "number") unresolvedErrors = a.unresolvedErrors;
      } catch { /* ignore */ }
    }
  }

  const durationMs = run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : null;

  const summary: BuilderRunSummaryResponse = {
    runId: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs,
    passCount: passes.length,
    successPasses: passes.filter((p) => p.status === "success").length,
    failedPasses: passes.filter((p) => p.status === "failed").length,
    lastAgent: lastPass?.agent ?? null,
    lastModel: lastPass?.model ?? null,
    planItemsDone,
    planItemsRemaining,
    completionPercent,
    filesEdited,
    filesCreated,
    unresolvedErrors,
  };

  return json(ok(summary, { builder: "ok" }));
}

export type PlanProgressSection = {
  title: string;
  done: number;
  total: number;
};

export type PlanNextStep = {
  text: string;
  section: string;
};

export type PlanProgressResponse = {
  planFile: string;
  sections: PlanProgressSection[];
  totalDone: number;
  totalItems: number;
  percentDone: number;
  lastParsedAt: number;
  nextSteps: PlanNextStep[];
  content?: string;
  error?: string;
};

const planProgressCache = new Map<string, { data: PlanProgressResponse; cachedAt: number }>();

export function builderWorkflowPlanProgressHandler(workflowId: string): Response {
  const reason = dbUnavailable();
  if (reason) {
    return apiError("db unavailable", 503);
  }

  const workflow = readBuilderWorkflow(workflowId);
  if (!workflow) {
    return apiError("Workflow not found", 404);
  }

  const planFile = workflow.planFile;
  const cached = planProgressCache.get(workflowId);
  if (cached && Date.now() - cached.cachedAt < 30_000) {
    return json(ok(cached.data, { builder: "ok" }));
  }

  const { existsSync: fsExists, readFileSync: fsRead } = require("node:fs") as typeof import("node:fs");

  if (!planFile || !fsExists(planFile)) {
    const result: PlanProgressResponse = {
      planFile: planFile ?? "",
      sections: [],
      totalDone: 0,
      totalItems: 0,
      percentDone: 0,
      lastParsedAt: Date.now(),
      nextSteps: [],
      error: "Plan file not found",
    };
    return json(ok(result, { builder: "ok" }));
  }

  try {
    const text = fsRead(planFile, "utf8");
    const lines = text.split("\n");
    const sections: PlanProgressSection[] = [];
    let currentSection: PlanProgressSection | null = null;
    let currentSectionTitle = "";
    const nextSteps: PlanNextStep[] = [];

    for (const line of lines) {
      if (line.startsWith("## ")) {
        if (currentSection) sections.push(currentSection);
        currentSectionTitle = line.slice(3).trim();
        currentSection = { title: currentSectionTitle, done: 0, total: 0 };
      } else if (currentSection) {
        if (line.includes("- [x]") || line.includes("- [X]")) {
          currentSection.done++;
          currentSection.total++;
        } else if (line.includes("- [ ]")) {
          currentSection.total++;
          const textMatch = line.match(/^\s*- \[ \]\s*(.+)$/);
          if (textMatch && nextSteps.length < 4) {
            nextSteps.push({ text: textMatch[1].trim(), section: currentSectionTitle });
          }
        }
      }
    }
    if (currentSection) sections.push(currentSection);

    const activeSections = sections.filter((s) => s.total > 0);
    const totalDone = activeSections.reduce((sum, s) => sum + s.done, 0);
    const totalItems = activeSections.reduce((sum, s) => sum + s.total, 0);
    const percentDone = totalItems > 0 ? Math.round((totalDone / totalItems) * 100) : 0;

    const MAX_CONTENT_LEN = 12_000;
    const result: PlanProgressResponse = {
      planFile,
      sections: activeSections,
      totalDone,
      totalItems,
      percentDone,
      lastParsedAt: Date.now(),
      nextSteps,
      content: text.length > MAX_CONTENT_LEN ? text.slice(0, MAX_CONTENT_LEN) + "\n\n[…truncated]" : text,
    };

    planProgressCache.set(workflowId, { data: result, cachedAt: Date.now() });
    return json(ok(result, { builder: "ok" }));
  } catch (err) {
    const result: PlanProgressResponse = {
      planFile,
      sections: [],
      totalDone: 0,
      totalItems: 0,
      percentDone: 0,
      lastParsedAt: Date.now(),
      nextSteps: [],
      error: String(err),
    };
    return json(ok(result, { builder: "ok" }));
  }
}

// Convert a single stream-json line from claude --output-format stream-json into
// a human-readable string. Returns null to suppress the line entirely.
function formatClaudeStreamLine(line: string): string | null {
  if (!line.startsWith("{")) return line; // pass-through for [builder] prefix lines
  try {
    const ev = JSON.parse(line) as Record<string, unknown>;
    switch (ev.type) {
      case "system":
        return null; // suppress init metadata
      case "user":
        return null; // suppress tool-result feedback payloads
      case "assistant": {
        const content = (ev.message as { content?: unknown[] } | undefined)?.content ?? [];
        const parts: string[] = [];
        for (const block of content) {
          const b = block as { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
          if (b.type === "text" && b.text?.trim()) {
            parts.push(b.text.trim());
          } else if (b.type === "tool_use") {
            const name = b.name ?? "tool";
            const inp = b.input ?? {};
            let detail = "";
            if (name === "Bash") detail = String(inp.command ?? "").split("\n")[0].slice(0, 120);
            else if (name === "Read") detail = String(inp.file_path ?? inp.path ?? "");
            else if (name === "Write" || name === "Edit") detail = String(inp.file_path ?? "");
            else if (name === "Grep") detail = `"${String(inp.pattern ?? "")}" in ${String(inp.path ?? "")}`;
            else if (name === "WebSearch") detail = String(inp.query ?? "");
            else if (name === "WebFetch") detail = String(inp.url ?? "").slice(0, 80);
            else detail = JSON.stringify(inp).slice(0, 80);
            parts.push(`  ▶ ${name}: ${detail}`);
          }
        }
        return parts.length ? parts.join("\n") : null;
      }
      case "tool_result": {
        const content = ev.content as Array<{ type?: string; text?: string }> | undefined;
        const text = Array.isArray(content) ? content.find((c) => c.type === "text")?.text ?? "" : String(content ?? "");
        const firstLine = text.split("\n")[0].trim().slice(0, 200);
        return firstLine ? `    ${firstLine}` : null;
      }
      case "result": {
        if (typeof ev.result === "string") return `\n✓ ${ev.result.trim().slice(0, 500)}`;
        if (ev.subtype === "error_max_turns") return `\n✗ max turns reached`;
        if (typeof ev.error === "string") return `\n✗ ${String(ev.error).slice(0, 200)}`;
        return null;
      }
      default:
        return null;
    }
  } catch {
    return line; // not JSON — return raw
  }
}

export function builderPassLiveHandler(runId: string): Response {
  const { existsSync, statSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const POLL_MS = 2000;
  const MAX_INIT_BYTES = 8000;

  const findCurrentPass = (): { passSeq: number; logPath: string; agent: string } | null => {
    try {
      const passes = readBuilderPasses(runId);
      const running = passes.find((p) => p.status === "running");
      if (!running) return null;
      const { existsSync: fsExists, readdirSync } = require("node:fs") as typeof import("node:fs");
      const filename = `pass-${running.sequence}-stdout.log`;
      // 1. flat legacy path
      const flat = `/var/lib/control-surface/builder-runs/${runId}/${filename}`;
      if (fsExists(flat)) return { passSeq: running.sequence, logPath: flat, agent: running.agent ?? "" };
      // 2. tenant-aware scan (same pattern as builderArtifactContentHandler)
      const tenantsBase = "/var/lib/control-surface/tenants";
      if (fsExists(tenantsBase)) {
        for (const tid of readdirSync(tenantsBase)) {
          const projectsBase = `${tenantsBase}/${tid}/projects`;
          if (!fsExists(projectsBase)) continue;
          for (const pid of readdirSync(projectsBase)) {
            const candidate = `${projectsBase}/${pid}/builder-runs/${runId}/${filename}`;
            if (fsExists(candidate)) return { passSeq: running.sequence, logPath: candidate, agent: running.agent ?? "" };
          }
        }
      }
      // return with flat path anyway so polling continues while log is created
      return { passSeq: running.sequence, logPath: flat, agent: running.agent ?? "" };
    } catch { return null; }
  };

  const encoder = new TextEncoder();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let offset = 0;
      let lastPassSeq: number | null = null;
      let currentAgent = "";

      const sendEvent = (text: string) => {
        try {
          const lines = text.split("\n").filter((l) => l.trim());
          for (const raw of lines) {
            const formatted = currentAgent === "claude" ? formatClaudeStreamLine(raw) : raw;
            if (formatted === null) continue;
            for (const line of formatted.split("\n").filter((l) => l.trim())) {
              controller.enqueue(encoder.encode(`event: line\ndata: ${JSON.stringify({ text: line, ts: Date.now() })}\n\n`));
            }
          }
        } catch { /* client disconnected */ }
      };

      const poll = () => {
        const current = findCurrentPass();
        if (!current) {
          try {
            controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
            controller.close();
          } catch { /* already closed */ }
          if (intervalId) clearInterval(intervalId);
          return;
        }

        if (current.passSeq !== lastPassSeq) {
          offset = 0;
          lastPassSeq = current.passSeq;
          currentAgent = current.agent;
        }

        if (!existsSync(current.logPath)) return;

        try {
          const size = statSync(current.logPath).size;
          if (size <= offset) return;

          if (offset === 0 && size > MAX_INIT_BYTES) {
            offset = size - MAX_INIT_BYTES;
          }

          const buf = Buffer.alloc(size - offset);
          const fd = require("node:fs").openSync(current.logPath, "r");
          require("node:fs").readSync(fd, buf, 0, buf.length, offset);
          require("node:fs").closeSync(fd);
          offset = size;
          sendEvent(buf.toString("utf8"));
        } catch { /* file read error, skip */ }
      };

      poll();
      intervalId = setInterval(poll, POLL_MS);
    },
    cancel() {
      if (intervalId) clearInterval(intervalId);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ── Trace endpoints ───────────────────────────────────────────────────────────

export function traceListDatesHandler(): Response {
  const { listTraceDates } = require("../tracing/exporter.ts") as typeof import("../tracing/exporter.ts");
  return json(ok({ dates: listTraceDates() }));
}

export function traceByDateHandler(date: string): Response {
  const { readTraces } = require("../tracing/exporter.ts") as typeof import("../tracing/exporter.ts");
  return json(ok({ date, spans: readTraces(date) }));
}

// ── Audit chain-status endpoint ───────────────────────────────────────────────

export function auditChainStatusHandler(): Response {
  const { verifyChain, getChainHead } = require("../db/audit/chain.ts") as typeof import("../db/audit/chain.ts");
  const { getDashboardDb } = require("../db/dashboard.ts") as typeof import("../db/dashboard.ts");
  const db = getDashboardDb();
  if (!db) return apiError("DB not available", 503);
  const result = verifyChain(db, 500);
  const head = getChainHead(db);
  return json(ok({ ...result, headHash: head?.rowHash ?? null, headTs: head?.ts ?? null }));
}
