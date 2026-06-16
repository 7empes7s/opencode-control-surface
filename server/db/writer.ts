import { getDashboardDb, isDashboardDbEnabled } from "./dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import type { TenantContext } from "../tenancy/context.ts";
import { whereTenant } from "./tenantScope.ts";
import { getCurrentAuthenticatedUser } from "../auth/session.ts";
import { markAuditWritten } from "../api/auditFlag.ts";

type MetricSampleInput = {
  source: string;
  key: string;
  value: unknown;
};

type EventInput = {
  ts?: number;
  kind: string;
  severity: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  payload?: unknown;
  dedupeKey?: string;
};

type ActionAuditInput = {
  userId?: string | null;
  actor?: string;
  actorSource?: string;
  actionKind: string;
  actionId?: string;
  reason?: string;
  target?: string;
  targetType?: string;
  targetId?: string;
  risk?: string;
  args?: unknown;
  request?: unknown;
  result?: string;
  resultStatus?: string;
  resultJson?: unknown;
  evidence?: unknown;
  jobId?: string;
  eventId?: string;
  rollbackHint?: string;
  error?: string;
};

type ChannelLogInput = {
  ts?: number;
  channel?: string;
  direction: "in" | "out" | "event";
  summary: string;
  payload?: unknown;
};

export type ChannelLogRow = {
  id: number;
  ts: number;
  channel: string;
  direction: string;
  summary: string;
  payload: unknown;
};

type NotificationRuleInput = {
  id?: number;
  kind: string;
  enabled: boolean;
  threshold?: unknown;
  channels?: unknown;
};

export type NotificationRuleRow = {
  id: number;
  kind: string;
  enabled: boolean;
  threshold: unknown;
  channels: unknown;
  updatedAt: number;
};

export type JobStatus = "queued" | "running" | "success" | "failed" | "canceled";

type JobInput = {
  id: string;
  kind: string;
  status?: JobStatus;
  actor?: string;
  reason?: string;
  targetType?: string;
  targetId?: string;
  command?: string;
  request?: unknown;
  evidence?: unknown;
  retryOfJobId?: string;
  maxRetries?: number;
};

export type JobRow = {
  id: string;
  kind: string;
  status: JobStatus;
  state: string;
  actor: string | null;
  reason: string | null;
  targetType: string | null;
  targetId: string | null;
  command: string | null;
  request: unknown;
  evidence: unknown;
  outputTail: string;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  exitCode: number | null;
  retryOfJobId: string | null;
  maxRetries: number;
  retryCount: number;
  tenantId?: string | null;
};

export type ActionAuditRow = {
  id: number;
  ts: number;
  userId: string | null;
  actor: string | null;
  actorSource: string | null;
  actionKind: string;
  actionId: string | null;
  reason: string | null;
  target: string | null;
  targetType: string | null;
  targetId: string | null;
  risk: string | null;
  request: unknown;
  resultStatus: string | null;
  result: string | null;
  resultJson: unknown;
  evidence: unknown;
  jobId: string | null;
  eventId: string | null;
  rollbackHint: string | null;
  error: string | null;
  tenantId?: string | null;
};

const MAX_OUTPUT_TAIL = 16_000;

function stringifyJson(value: unknown): string {
  return JSON.stringify(redactForDashboard(value)) ?? "null";
}

function stringifyOptionalJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return stringifyJson(value);
}

function logDbWriteError(operation: string, error: unknown): void {
  console.error(`[control-surface] dashboard SQLite ${operation} failed`, error);
}

function redactString(value: string): string {
  let redacted = value;
  const token = process.env.OPERATOR_TOKEN;
  if (token) {
    redacted = redacted.split(token).join("[REDACTED_OPERATOR_TOKEN]");
  }

  return redacted
    .replace(/(api[_-]?key|token|secret|password)=([^\s"'&]+)/gi, "$1=[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[REDACTED]");
}

export function redactForDashboard<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForDashboard(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|secret|password|apiKey|api_key/i.test(key) ? "[REDACTED]" : redactForDashboard(item),
      ]),
    ) as T;
  }

  return value;
}

export function writeMetricSample(input: MetricSampleInput): void {
  if (!isDashboardDbEnabled()) {
    return;
  }

  const db = getDashboardDb();
  if (!db) {
    return;
  }

  const tenantId = getCurrentTenantContext().tenantId;

  try {
    db.query(`
      INSERT INTO metric_samples (ts, source, key, value_json, tenant_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(Date.now(), input.source, input.key, stringifyJson(input.value), tenantId);
  } catch (error) {
    logDbWriteError("writeMetricSample", error);
  }
}

export function writeEvent(input: EventInput): void {
  if (!isDashboardDbEnabled()) {
    return;
  }

  const db = getDashboardDb();
  if (!db) {
    return;
  }

  const tenantId = getCurrentTenantContext().tenantId;

  try {
    const sql = input.dedupeKey
      ? `
        INSERT OR IGNORE INTO events
          (ts, kind, severity, entity_type, entity_id, summary, payload_json, dedupe_key, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      : `
        INSERT INTO events
          (ts, kind, severity, entity_type, entity_id, summary, payload_json, dedupe_key, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

    db.query(sql).run(
      input.ts ?? Date.now(),
      input.kind,
      input.severity,
      input.entityType ?? null,
      input.entityId ?? null,
      input.summary,
      stringifyOptionalJson(input.payload),
      input.dedupeKey ?? null,
      tenantId,
    );
  } catch (error) {
    logDbWriteError("writeEvent", error);
  }
}

export function writeActionAudit(input: ActionAuditInput): void {
  if (!isDashboardDbEnabled()) {
    return;
  }

  const db = getDashboardDb();
  if (!db) {
    return;
  }

  markAuditWritten();

  const tenantId = getCurrentTenantContext().tenantId;
  const currentUser = getCurrentAuthenticatedUser();
  const userId = input.userId ?? currentUser?.userId ?? null;
  const actor = input.actor ?? currentUser?.email ?? currentUser?.name ?? userId ?? "operator";

  try {
    db.query(`
      INSERT INTO action_audit
        (
          ts, user_id, actor, actor_source, action_kind, action, action_id, reason,
          target, target_type, target_id, risk, args_json, request_json,
          result, result_status, result_json, evidence_json, job_id, event_id,
          rollback_hint, error, tenant_id
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      userId,
      actor,
      input.actorSource ?? currentUser?.source ?? "dashboard",
      input.actionKind,
      input.actionKind,
      input.actionId ?? null,
      input.reason ?? null,
      input.target ?? null,
      input.targetType ?? null,
      input.targetId ?? null,
      input.risk ?? null,
      stringifyOptionalJson(input.args),
      stringifyOptionalJson(input.request ?? input.args),
      input.result ?? null,
      input.resultStatus ?? (input.error ? "failed" : "success"),
      stringifyOptionalJson(input.resultJson),
      stringifyOptionalJson(input.evidence),
      input.jobId ?? null,
      input.eventId ?? null,
      input.rollbackHint ?? null,
      input.error ?? null,
      tenantId,
    );
  } catch (error) {
    logDbWriteError("writeActionAudit", error);
  }
}

export function writeChannelLog(input: ChannelLogInput): boolean {
  if (!isDashboardDbEnabled()) {
    return false;
  }

  const db = getDashboardDb();
  if (!db) {
    return false;
  }

  try {
    db.query(`
      INSERT INTO channels_log (ts, channel, direction, summary, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.ts ?? Date.now(),
      input.channel ?? "telegram",
      input.direction,
      redactForDashboard(input.summary).slice(0, 500),
      stringifyOptionalJson(input.payload),
    );
    return true;
  } catch (error) {
    logDbWriteError("writeChannelLog", error);
    return false;
  }
}

export function createJob(input: JobInput): boolean {
  if (!isDashboardDbEnabled()) {
    return false;
  }

  const db = getDashboardDb();
  if (!db) {
    return false;
  }

  const now = Date.now();
  const status = input.status ?? "running";
  const tenantId = getCurrentTenantContext().tenantId;
  const currentUser = getCurrentAuthenticatedUser();

  try {
    db.query(`
      INSERT INTO jobs
        (
          id, ts, kind, state, status, actor, reason, target_type, target_id,
          command, request_json, evidence_json, started_at, max_retries,
          retry_count, retry_of_job_id, tenant_id
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      now,
      input.kind,
      status,
      status,
      input.actor ?? currentUser?.email ?? currentUser?.name ?? currentUser?.userId ?? "operator",
      input.reason ?? null,
      input.targetType ?? null,
      input.targetId ?? null,
      input.command ?? null,
      stringifyOptionalJson(input.request),
      stringifyOptionalJson(input.evidence),
      status === "running" ? now : null,
      input.maxRetries ?? 3,
      0,
      input.retryOfJobId ?? null,
      tenantId,
    );
    return true;
  } catch (error) {
    logDbWriteError("createJob", error);
    return false;
  }
}

function trimOutputTail(value: string): string {
  const redacted = redactString(value);
  return redacted.length > MAX_OUTPUT_TAIL ? redacted.slice(-MAX_OUTPUT_TAIL) : redacted;
}

export function updateJobOutput(id: string, output: string): void {
  if (!isDashboardDbEnabled()) {
    return;
  }

  const db = getDashboardDb();
  if (!db) {
    return;
  }

  const tenantWhere = whereTenant();

  try {
    db.query(`UPDATE jobs SET output_tail = ? WHERE id = ?${tenantWhere.clause}`).run(
      trimOutputTail(output),
      id,
      ...tenantWhere.params,
    );
  } catch (error) {
    logDbWriteError("updateJobOutput", error);
  }
}

export function finishJob(
  id: string,
  status: Exclude<JobStatus, "queued" | "running">,
  input: { output?: string; error?: string; exitCode?: number | null } = {},
): void {
  if (!isDashboardDbEnabled()) {
    return;
  }

  const db = getDashboardDb();
  if (!db) {
    return;
  }

  const tenantWhere = whereTenant();

  try {
    db.query(`
      UPDATE jobs
      SET state = ?, status = ?, finished_at = ?, output_tail = COALESCE(?, output_tail), error = ?, exit_code = ?
      WHERE id = ?${tenantWhere.clause}
    `).run(
      status,
      status,
      Date.now(),
      input.output === undefined ? null : trimOutputTail(input.output),
      input.error ? redactString(input.error) : null,
      input.exitCode ?? null,
      id,
      ...tenantWhere.params,
    );
  } catch (error) {
    logDbWriteError("finishJob", error);
  }
}

export function readOperatorState(key: string): unknown | null {
  if (!isDashboardDbEnabled()) {
    return null;
  }

  const db = getDashboardDb();
  if (!db) {
    return null;
  }

  const tenantWhere = whereTenant();

  try {
    const row = db.query(`SELECT value_json FROM operator_state WHERE key = ?${tenantWhere.clause}`)
      .get(key, ...tenantWhere.params) as { value_json?: string } | null;

    if (!row || typeof row.value_json !== "string") {
      return null;
    }

    return JSON.parse(row.value_json);
  } catch (error) {
    console.error("[control-surface] dashboard SQLite readOperatorState failed", error);
    return null;
  }
}

export function writeOperatorState(key: string, value: unknown): void {
  if (!isDashboardDbEnabled()) {
    return;
  }

  const db = getDashboardDb();
  if (!db) {
    return;
  }

  const tenantId = getCurrentTenantContext().tenantId;

  try {
    db.query(`
      INSERT INTO operator_state (key, value_json, updated_at, tenant_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at,
        tenant_id = excluded.tenant_id
    `).run(key, stringifyJson(value), Date.now(), tenantId);
  } catch (error) {
    logDbWriteError("writeOperatorState", error);
  }
}

function parseOptionalJson(value: string | null): unknown {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

type DbChannelLogRow = {
  id: number;
  ts: number;
  channel: string;
  direction: string;
  summary: string;
  payload_json: string | null;
};

function mapChannelLog(row: DbChannelLogRow): ChannelLogRow {
  return {
    id: row.id,
    ts: row.ts,
    channel: row.channel,
    direction: row.direction,
    summary: row.summary,
    payload: parseOptionalJson(row.payload_json),
  };
}

export function readChannelLog(
  options: { limit?: number; since?: number; channel?: string; direction?: string } = {},
): ChannelLogRow[] {
  if (!isDashboardDbEnabled()) {
    return [];
  }

  const db = getDashboardDb();
  if (!db) {
    return [];
  }

  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const params: Array<string | number> = [options.since ?? 0];
  let sql = `
    SELECT id, ts, channel, direction, summary, payload_json
    FROM channels_log
    WHERE ts > ?
  `;

  if (options.channel) {
    sql += " AND channel = ?";
    params.push(options.channel);
  }

  if (options.direction) {
    sql += " AND direction = ?";
    params.push(options.direction);
  }

  sql += " ORDER BY ts DESC, id DESC LIMIT ?";
  params.push(limit);

  try {
    return (db.query(sql).all(...params) as DbChannelLogRow[]).map(mapChannelLog);
  } catch (error) {
    console.error("[control-surface] dashboard SQLite readChannelLog failed", error);
    return [];
  }
}

type DbNotificationRuleRow = {
  id: number;
  kind: string;
  enabled: number;
  threshold_json: string | null;
  channels_json: string | null;
  updated_at: number;
};

function mapNotificationRule(row: DbNotificationRuleRow): NotificationRuleRow {
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled === 1,
    threshold: parseOptionalJson(row.threshold_json),
    channels: parseOptionalJson(row.channels_json),
    updatedAt: row.updated_at,
  };
}

export function readNotificationRules(options: { limit?: number; kind?: string } = {}): NotificationRuleRow[] {
  if (!isDashboardDbEnabled()) {
    return [];
  }

  const db = getDashboardDb();
  if (!db) {
    return [];
  }

  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const params: Array<string | number> = [];
  let sql = `
    SELECT id, kind, enabled, threshold_json, channels_json, updated_at
    FROM notification_rules
    WHERE 1 = 1
  `;

  if (options.kind) {
    sql += " AND kind = ?";
    params.push(options.kind);
  }

  sql += " ORDER BY kind ASC, id ASC LIMIT ?";
  params.push(limit);

  try {
    return (db.query(sql).all(...params) as DbNotificationRuleRow[]).map(mapNotificationRule);
  } catch (error) {
    console.error("[control-surface] dashboard SQLite readNotificationRules failed", error);
    return [];
  }
}

export function upsertNotificationRule(input: NotificationRuleInput): NotificationRuleRow | null {
  if (!isDashboardDbEnabled()) {
    return null;
  }

  const db = getDashboardDb();
  if (!db) {
    return null;
  }

  const now = Date.now();
  const enabled = input.enabled ? 1 : 0;

  try {
    if (input.id !== undefined) {
      db.query(`
        UPDATE notification_rules
        SET kind = ?, enabled = ?, threshold_json = ?, channels_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.kind,
        enabled,
        stringifyOptionalJson(input.threshold),
        stringifyOptionalJson(input.channels),
        now,
        input.id,
      );
    } else {
      const existing = db.query(`
        SELECT id
        FROM notification_rules
        WHERE kind = ?
        ORDER BY id ASC
        LIMIT 1
      `).get(input.kind) as { id: number } | null;

      if (existing) {
        db.query(`
          UPDATE notification_rules
          SET enabled = ?, threshold_json = ?, channels_json = ?, updated_at = ?
          WHERE id = ?
        `).run(
          enabled,
          stringifyOptionalJson(input.threshold),
          stringifyOptionalJson(input.channels),
          now,
          existing.id,
        );
      } else {
        db.query(`
          INSERT INTO notification_rules (kind, enabled, threshold_json, channels_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          input.kind,
          enabled,
          stringifyOptionalJson(input.threshold),
          stringifyOptionalJson(input.channels),
          now,
        );
      }
    }

    return readNotificationRules({ kind: input.kind, limit: 1 })[0] ?? null;
  } catch (error) {
    logDbWriteError("upsertNotificationRule", error);
    return null;
  }
}

type DbJobRow = {
  id: string;
  kind: string;
  state: string;
  status: string | null;
  actor: string | null;
  reason: string | null;
  target_type: string | null;
  target_id: string | null;
  command: string | null;
  request_json: string | null;
  evidence_json: string | null;
  output_tail: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  exit_code: number | null;
  retry_of_job_id: string | null;
  max_retries: number | null;
  retry_count: number | null;
  tenant_id: string | null;
};

function mapJob(row: DbJobRow): JobRow {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    status: (row.status ?? row.state) as JobStatus,
    actor: row.actor,
    reason: row.reason,
    targetType: row.target_type,
    targetId: row.target_id,
    command: row.command,
    request: parseOptionalJson(row.request_json),
    evidence: parseOptionalJson(row.evidence_json),
    outputTail: row.output_tail ?? "",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    exitCode: row.exit_code,
    retryOfJobId: row.retry_of_job_id,
    maxRetries: row.max_retries ?? 3,
    retryCount: row.retry_count ?? 0,
    tenantId: row.tenant_id,
  };
}

export function readJobs(options: { limit?: number; status?: string; kind?: string } = {}): JobRow[] {
  if (!isDashboardDbEnabled()) {
    return [];
  }

  const db = getDashboardDb();
  if (!db) {
    return [];
  }

  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const params: Array<string | number> = [];
  let sql = `
    SELECT id, kind, state, status, actor, reason, target_type, target_id, command,
      request_json, evidence_json, output_tail, started_at, finished_at, error,
      exit_code, retry_of_job_id, max_retries, retry_count, tenant_id
    FROM jobs
    WHERE 1 = 1
  `;

  const tenantWhere = whereTenant();
  sql += tenantWhere.clause;
  params.push(...tenantWhere.params);

  if (options.status) {
    sql += " AND COALESCE(status, state) = ?";
    params.push(options.status);
  }

  if (options.kind) {
    sql += " AND kind = ?";
    params.push(options.kind);
  }

  sql += " ORDER BY COALESCE(started_at, ts, 0) DESC LIMIT ?";
  params.push(limit);

  try {
    return (db.query(sql).all(...params) as DbJobRow[]).map(mapJob);
  } catch (error) {
    console.error("[control-surface] dashboard SQLite readJobs failed", error);
    return [];
  }
}

export function readJob(id: string): JobRow | null {
  if (!isDashboardDbEnabled()) {
    return null;
  }

  const db = getDashboardDb();
  if (!db) {
    return null;
  }

  const tenantWhere = whereTenant();

  try {
    const row = db.query(`
      SELECT id, kind, state, status, actor, reason, target_type, target_id, command,
        request_json, evidence_json, output_tail, started_at, finished_at, error,
        exit_code, retry_of_job_id, max_retries, retry_count, tenant_id
      FROM jobs
      WHERE id = ?${tenantWhere.clause}
    `).get(id, ...tenantWhere.params) as DbJobRow | null;
    return row ? mapJob(row) : null;
  } catch (error) {
    console.error("[control-surface] dashboard SQLite readJob failed", error);
    return null;
  }
}

type DbActionAuditRow = {
  id: number;
  ts: number;
  user_id: string | null;
  actor: string | null;
  actor_source: string | null;
  action_kind: string;
  action_id: string | null;
  reason: string | null;
  target: string | null;
  target_type: string | null;
  target_id: string | null;
  risk: string | null;
  request_json: string | null;
  args_json: string | null;
  result_status: string | null;
  result: string | null;
  result_json: string | null;
  evidence_json: string | null;
  job_id: string | null;
  event_id: string | null;
  rollback_hint: string | null;
  error: string | null;
  tenant_id: string | null;
};

function mapAudit(row: DbActionAuditRow): ActionAuditRow {
  return {
    id: row.id,
    ts: row.ts,
    userId: row.user_id,
    actor: row.actor,
    actorSource: row.actor_source,
    actionKind: row.action_kind,
    actionId: row.action_id,
    reason: row.reason,
    target: row.target,
    targetType: row.target_type,
    targetId: row.target_id,
    risk: row.risk,
    request: parseOptionalJson(row.request_json ?? row.args_json),
    resultStatus: row.result_status,
    result: row.result,
    resultJson: parseOptionalJson(row.result_json),
    evidence: parseOptionalJson(row.evidence_json),
    jobId: row.job_id,
    eventId: row.event_id,
    rollbackHint: row.rollback_hint,
    error: row.error,
    tenantId: row.tenant_id,
  };
}

export function readActionAudit(
  options: { limit?: number; targetType?: string; resultStatus?: string; actionKind?: string } = {},
): ActionAuditRow[] {
  if (!isDashboardDbEnabled()) {
    return [];
  }

  const db = getDashboardDb();
  if (!db) {
    return [];
  }

  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const params: Array<string | number> = [];
  let sql = `
    SELECT id, ts, user_id, actor, actor_source, action_kind, action_id, reason, target,
      target_type, target_id, risk, request_json, args_json, result_status,
      result, result_json, evidence_json, job_id, event_id, rollback_hint, error,
      tenant_id
    FROM action_audit
    WHERE 1 = 1
  `;

  const tenantWhere = whereTenant();
  sql += tenantWhere.clause;
  params.push(...tenantWhere.params);

  if (options.targetType) {
    sql += " AND target_type = ?";
    params.push(options.targetType);
  }

  if (options.resultStatus) {
    sql += " AND result_status = ?";
    params.push(options.resultStatus);
  }

  if (options.actionKind) {
    sql += " AND action_kind = ?";
    params.push(options.actionKind);
  }

  sql += " ORDER BY ts DESC, id DESC LIMIT ?";
  params.push(limit);

  try {
    return (db.query(sql).all(...params) as DbActionAuditRow[]).map(mapAudit);
  } catch (error) {
    console.error("[control-surface] dashboard SQLite readActionAudit failed", error);
    return [];
  }
}
