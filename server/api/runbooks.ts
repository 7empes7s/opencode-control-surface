import { randomUUID } from "node:crypto";
import { getCurrentAuthenticatedUser } from "../auth/session.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import {
  RunbookValidationError,
  startRunbookRun,
  validateSteps,
  type RunbookStep,
} from "../runbooks/engine.ts";
import { ok } from "./types.ts";

type DefinitionRow = {
  id: string;
  name: string;
  description: string | null;
  steps_json: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requiredDb() {
  const db = getDashboardDb();
  if (!db) return null;
  return db;
}

function unavailable(): Response {
  return json({ ok: false, error: "dashboard database is unavailable", code: "DB_UNAVAILABLE" }, 503);
}

function actor(): string {
  const user = getCurrentAuthenticatedUser();
  return user?.email ?? user?.name ?? user?.userId ?? "operator";
}

function parseStoredSteps(row: Pick<DefinitionRow, "id" | "steps_json">): RunbookStep[] {
  try {
    const parsed = JSON.parse(row.steps_json);
    return Array.isArray(parsed) ? parsed as RunbookStep[] : [];
  } catch {
    return [];
  }
}

async function readDefinitionInput(req: Request): Promise<{
  name: string;
  description: string | null;
  steps: RunbookStep[];
  risk: "medium" | "high";
} | Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid JSON body", code: "BAD_REQUEST" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ ok: false, error: "name is required", code: "BAD_REQUEST" }, 400);
  if (body.description !== undefined && typeof body.description !== "string") {
    return json({ ok: false, error: "description must be a string", code: "BAD_REQUEST" }, 400);
  }
  try {
    const validated = validateSteps(body.steps);
    return {
      name,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      steps: validated.steps,
      risk: validated.risk,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message, code: "BAD_REQUEST" }, 400);
  }
}

export function runbooksListHandler(): Response {
  const db = requiredDb();
  if (!db) return unavailable();
  const rows = db.query(`
    SELECT d.*,
      (SELECT r.status FROM runbook_runs r WHERE r.runbook_id = d.id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
      (SELECT r.started_at FROM runbook_runs r WHERE r.runbook_id = d.id ORDER BY r.started_at DESC LIMIT 1) AS last_run_started_at
    FROM runbook_definitions d
    WHERE d.archived_at IS NULL
    ORDER BY d.updated_at DESC, d.name ASC
  `).all() as Array<DefinitionRow & { last_run_status: string | null; last_run_started_at: number | null }>;

  const runbooks = rows.map((row) => {
    const steps = parseStoredSteps(row);
    let risk: "medium" | "high" = "medium";
    let validationError: string | null = null;
    try {
      risk = validateSteps(steps).risk;
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      steps,
      stepCount: steps.length,
      risk,
      validationError,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRun: row.last_run_status ? { status: row.last_run_status, startedAt: row.last_run_started_at } : null,
    };
  });
  return json(ok({ runbooks }));
}

export async function runbookCreateHandler(req: Request): Promise<Response> {
  const db = requiredDb();
  if (!db) return unavailable();
  const input = await readDefinitionInput(req);
  if (input instanceof Response) return input;
  const id = randomUUID();
  const now = Date.now();
  const createdBy = actor();
  db.query(`
    INSERT INTO runbook_definitions (id, name, description, steps_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.name, input.description, JSON.stringify(input.steps), createdBy, now, now);
  writeActionAudit({
    actor: createdBy,
    actionKind: "runbook.create",
    actionId: `runbook:create:${id}`,
    targetType: "runbook",
    targetId: id,
    risk: "low",
    request: { name: input.name, description: input.description, stepCount: input.steps.length },
    resultStatus: "success",
    result: `created runbook ${input.name}`,
  });
  return json({ ok: true, data: { id, risk: input.risk } }, 201);
}

export async function runbookUpdateHandler(req: Request, id: string): Promise<Response> {
  const db = requiredDb();
  if (!db) return unavailable();
  const existing = db.query(`SELECT * FROM runbook_definitions WHERE id = ?`).get(id) as DefinitionRow | null;
  if (!existing) return json({ ok: false, error: "runbook not found", code: "NOT_FOUND" }, 404);
  const input = await readDefinitionInput(req);
  if (input instanceof Response) return input;
  const beforeStepCount = parseStoredSteps(existing).length;
  db.query(`
    UPDATE runbook_definitions
    SET name = ?, description = ?, steps_json = ?, updated_at = ?
    WHERE id = ?
  `).run(input.name, input.description, JSON.stringify(input.steps), Date.now(), id);
  writeActionAudit({
    actionKind: "runbook.update",
    actionId: `runbook:update:${id}`,
    targetType: "runbook",
    targetId: id,
    risk: "low",
    request: { name: input.name, beforeStepCount, afterStepCount: input.steps.length },
    resultStatus: "success",
    result: `updated runbook ${input.name}`,
  });
  return json({ ok: true, data: { id, risk: input.risk } });
}

export function runbookArchiveHandler(id: string): Response {
  const db = requiredDb();
  if (!db) return unavailable();
  const existing = db.query(`SELECT * FROM runbook_definitions WHERE id = ?`).get(id) as DefinitionRow | null;
  if (!existing) return json({ ok: false, error: "runbook not found", code: "NOT_FOUND" }, 404);
  const archivedAt = existing.archived_at ?? Date.now();
  db.query(`UPDATE runbook_definitions SET archived_at = ?, updated_at = ? WHERE id = ?`)
    .run(archivedAt, archivedAt, id);
  writeActionAudit({
    actionKind: "runbook.archive",
    actionId: `runbook:archive:${id}`,
    targetType: "runbook",
    targetId: id,
    risk: "low",
    request: { name: existing.name },
    resultStatus: "success",
    result: `archived runbook ${existing.name}`,
  });
  return json({ ok: true, data: { id, archivedAt } });
}

export async function runbookStartHandler(req: Request, id: string): Promise<Response> {
  const db = requiredDb();
  if (!db) return unavailable();
  const definition = db.query(`SELECT * FROM runbook_definitions WHERE id = ?`).get(id) as DefinitionRow | null;
  if (!definition) return json({ ok: false, error: "runbook not found", code: "NOT_FOUND" }, 404);
  if (definition.archived_at !== null) return json({ ok: false, error: "runbook is archived", code: "ARCHIVED" }, 409);

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (body.confirmed !== true) {
    writeActionAudit({
      actionKind: "runbook.run",
      actionId: `runbook:run:${id}`,
      targetType: "runbook",
      targetId: id,
      risk: "medium",
      reason,
      request: { confirmed: body.confirmed },
      resultStatus: "failed",
      error: "confirmation required",
    });
    return json({ ok: false, error: "confirmation required", code: "CONFIRM_REQUIRED" }, 400);
  }
  if (!reason) {
    writeActionAudit({
      actionKind: "runbook.run",
      actionId: `runbook:run:${id}`,
      targetType: "runbook",
      targetId: id,
      risk: "medium",
      request: { confirmed: true },
      resultStatus: "failed",
      error: "reason required",
    });
    return json({ ok: false, error: "reason required", code: "REASON_REQUIRED" }, 400);
  }

  try {
    const { runId } = startRunbookRun(id, { actor: actor(), reason }, req);
    return json({
      runId,
      status: "running",
      pollUrl: `/api/runbooks/runs/${runId}`,
    }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof RunbookValidationError ? 400 : 500;
    writeActionAudit({
      actionKind: "runbook.run",
      actionId: `runbook:run:${id}`,
      targetType: "runbook",
      targetId: id,
      risk: "medium",
      reason,
      request: { confirmed: true },
      resultStatus: "failed",
      error: message,
    });
    return json({ ok: false, error: message, code: status === 400 ? "BAD_REQUEST" : "EXEC_ERROR" }, status);
  }
}

export function runbookRunGetHandler(runId: string): Response {
  const db = requiredDb();
  if (!db) return unavailable();
  const run = db.query(`SELECT * FROM runbook_runs WHERE id = ?`).get(runId);
  if (!run) return json({ ok: false, error: "runbook run not found", code: "NOT_FOUND" }, 404);
  const steps = db.query(`SELECT * FROM runbook_run_steps WHERE run_id = ? ORDER BY step_index ASC`).all(runId);
  return json(ok({ run, steps }));
}

export function runbookRunsHandler(id: string, url: URL): Response {
  const db = requiredDb();
  if (!db) return unavailable();
  const definition = db.query(`SELECT id FROM runbook_definitions WHERE id = ?`).get(id);
  if (!definition) return json({ ok: false, error: "runbook not found", code: "NOT_FOUND" }, 404);
  const requested = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 50;
  const runs = db.query(`SELECT * FROM runbook_runs WHERE runbook_id = ? ORDER BY started_at DESC LIMIT ?`).all(id, limit);
  return json(ok({ runs }));
}
