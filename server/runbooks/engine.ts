import { randomUUID } from "node:crypto";
import { getDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { buildActionCatalog } from "../api/actionDescriptors.ts";
import { executeCatalogAction, parseActionId } from "../api/execute.ts";
import type { ActionDescriptor } from "../api/types.ts";

export type RunbookStep = {
  actionId: string;
  params?: Record<string, unknown>;
};

export type ValidatedSteps = {
  steps: RunbookStep[];
  descriptors: ActionDescriptor[];
  risk: "medium" | "high";
};

export class RunbookValidationError extends Error {
  readonly code = "INVALID_STEPS";

  constructor(message: string) {
    super(message);
    this.name = "RunbookValidationError";
  }
}

type CatalogProvider = () => ActionDescriptor[];
let catalogProvider: CatalogProvider = () => buildActionCatalog({});

export function setRunbookCatalogProviderForTests(provider?: CatalogProvider): void {
  catalogProvider = provider ?? (() => buildActionCatalog({}));
}

export function validateSteps(steps: unknown): ValidatedSteps {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) {
    throw new RunbookValidationError("steps must contain between 1 and 20 actions");
  }

  const catalog = catalogProvider();
  const descriptorsById = new Map(catalog.map((descriptor) => [descriptor.id, descriptor]));
  const normalized = steps.map((candidate, index): RunbookStep => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new RunbookValidationError(`step ${index + 1} must be an object`);
    }
    const step = candidate as Record<string, unknown>;
    if (typeof step.actionId !== "string" || !parseActionId(step.actionId)) {
      throw new RunbookValidationError(`step ${index + 1} has an invalid actionId`);
    }
    if (!descriptorsById.has(step.actionId)) {
      throw new RunbookValidationError(`step ${index + 1} actionId is not in the current action catalog: ${step.actionId}`);
    }
    if (step.params !== undefined && (!step.params || typeof step.params !== "object" || Array.isArray(step.params))) {
      throw new RunbookValidationError(`step ${index + 1} params must be an object when provided`);
    }
    return {
      actionId: step.actionId,
      ...(step.params === undefined ? {} : { params: step.params as Record<string, unknown> }),
    };
  });

  const descriptors = normalized.map((step) => descriptorsById.get(step.actionId)!);
  const risk = descriptors.some((descriptor) => descriptor.risk === "high") ? "high" : "medium";
  return { steps: normalized, descriptors, risk };
}

type StartRunbookInput = {
  actor?: string;
  reason: string;
};

type RunbookDefinitionRow = {
  id: string;
  name: string;
  steps_json: string;
  archived_at: number | null;
};

type StoredStep = {
  id: string;
  stepIndex: number;
  actionId: string;
  params?: Record<string, unknown>;
};

function requiredDb() {
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard database is unavailable");
  return db;
}

function resultMessage(result: Awaited<ReturnType<typeof executeCatalogAction>>): string | null {
  if (!result.ok) return null;
  return result.message ?? result.text ?? result.path ?? result.url ?? result.route ?? null;
}

async function executeWithTimeout(
  step: StoredStep,
  reason: string,
  runId: string,
  req: Request,
): Promise<Awaited<ReturnType<typeof executeCatalogAction>>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`step timed out after 120 seconds: ${step.actionId}`)), 120_000);
  });
  try {
    return await Promise.race([
      executeCatalogAction(step.actionId, {
        params: step.params,
        reason,
        confirmed: true,
        runbookRunId: runId,
      }, req),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeRunbookLoop(
  definition: RunbookDefinitionRow,
  runId: string,
  steps: StoredStep[],
  risk: "medium" | "high",
  input: StartRunbookInput,
  req: Request,
): Promise<void> {
  const db = requiredDb();
  const summary: Array<{ stepIndex: number; actionId: string; status: string; message?: string; error?: string }> = [];
  let runError: string | null = null;

  for (const step of steps) {
    const startedAt = Date.now();
    db.query(`UPDATE runbook_run_steps SET status = 'running', started_at = ? WHERE id = ?`).run(startedAt, step.id);
    try {
      const result = await executeWithTimeout(step, input.reason, runId, req);
      const finishedAt = Date.now();
      if (!result.ok) {
        runError = (result as { ok: false; error: string }).error;
        db.query(`UPDATE runbook_run_steps SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
          .run(runError, finishedAt, step.id);
        summary.push({ stepIndex: step.stepIndex, actionId: step.actionId, status: "failed", error: runError });
        break;
      }
      const message = resultMessage(result);
      db.query(`UPDATE runbook_run_steps SET status = 'success', message = ?, finished_at = ? WHERE id = ?`)
        .run(message, finishedAt, step.id);
      summary.push({ stepIndex: step.stepIndex, actionId: step.actionId, status: "success", ...(message ? { message } : {}) });
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      db.query(`UPDATE runbook_run_steps SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(runError, Date.now(), step.id);
      summary.push({ stepIndex: step.stepIndex, actionId: step.actionId, status: "failed", error: runError });
      break;
    }
  }

  if (runError) {
    const skipped = steps.filter((step) => !summary.some((item) => item.stepIndex === step.stepIndex));
    for (const step of skipped) {
      db.query(`UPDATE runbook_run_steps SET status = 'skipped', finished_at = ? WHERE id = ?`).run(Date.now(), step.id);
      summary.push({ stepIndex: step.stepIndex, actionId: step.actionId, status: "skipped" });
    }
  }

  summary.sort((a, b) => a.stepIndex - b.stepIndex);
  const status = runError ? "failed" : "success";
  const finishedAt = Date.now();
  db.query(`UPDATE runbook_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?`)
    .run(status, finishedAt, runError, runId);
  writeActionAudit({
    actor: input.actor,
    actionKind: "runbook.run",
    actionId: `runbook:run:${definition.id}`,
    targetType: "runbook",
    targetId: definition.id,
    risk,
    reason: input.reason,
    request: { runbookId: definition.id, runbookRunId: runId },
    resultStatus: status,
    result: status === "success" ? `Runbook ${definition.name} completed` : undefined,
    error: runError ?? undefined,
    resultJson: { runId, steps: summary },
  });
}

export function startRunbookRun(
  runbookId: string,
  input: StartRunbookInput,
  req: Request,
): { runId: string } {
  const db = requiredDb();
  const definition = db.query(`
    SELECT id, name, steps_json, archived_at
    FROM runbook_definitions
    WHERE id = ?
  `).get(runbookId) as RunbookDefinitionRow | null;
  if (!definition) throw new Error(`runbook not found: ${runbookId}`);
  if (definition.archived_at !== null) throw new Error(`runbook is archived: ${runbookId}`);

  let parsedSteps: unknown;
  try {
    parsedSteps = JSON.parse(definition.steps_json);
  } catch {
    throw new RunbookValidationError(`runbook ${runbookId} has invalid stored steps JSON`);
  }
  const validated = validateSteps(parsedSteps);
  const runId = randomUUID();
  const now = Date.now();
  const storedSteps: StoredStep[] = validated.steps.map((step, stepIndex) => ({
    id: randomUUID(),
    stepIndex,
    ...step,
  }));

  const transaction = db.transaction(() => {
    db.query(`
      INSERT INTO runbook_runs (id, runbook_id, status, actor, reason, risk, started_at)
      VALUES (?, ?, 'running', ?, ?, ?, ?)
    `).run(runId, runbookId, input.actor ?? "operator", input.reason, validated.risk, now);
    const insertStep = db.query(`
      INSERT INTO runbook_run_steps (id, run_id, step_index, action_id, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    for (const step of storedSteps) insertStep.run(step.id, runId, step.stepIndex, step.actionId);
  });
  transaction();

  void executeRunbookLoop(definition, runId, storedSteps, validated.risk, input, req).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      db.query(`UPDATE runbook_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`)
        .run(Date.now(), message, runId);
      db.query(`UPDATE runbook_run_steps SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status = 'pending'`)
        .run(Date.now(), runId);
    } catch (persistError) {
      console.error("[runbooks] failed to persist detached loop error", persistError);
    }
  });

  return { runId };
}
