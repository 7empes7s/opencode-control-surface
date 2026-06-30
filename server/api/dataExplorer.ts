import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { redactForDashboard } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { ok, type ApiEnvelope } from "./types.ts";

const SENSITIVE_COLUMN_RE = /secret|token|key|password|credential/i;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

type DatasetDefinition = {
  name: string;
  label: string;
  description: string;
  table: string;
  columns: string[];
  searchColumns: string[];
  orderBy: string;
  tenantScoped?: boolean;
};

export interface DataExplorerTableInfo {
  name: string;
  label: string;
  description: string;
  rowCount: number;
  columns: Array<{ name: string; redacted: boolean }>;
}

export interface DataExplorerTablesPayload {
  tables: DataExplorerTableInfo[];
}

export interface DataExplorerRowsPayload {
  table: DataExplorerTableInfo;
  rows: Array<Record<string, unknown>>;
  limit: number;
  offset: number;
  total: number;
  q: string;
}

const DATASETS: Record<string, DatasetDefinition> = {
  insights: {
    name: "insights",
    label: "Insights",
    description: "Detection inbox findings and their current state.",
    table: "insights",
    columns: [
      "id", "domain", "severity", "title", "plain_summary", "confidence",
      "manual_page_href", "status", "created_at", "source_key", "resolved_at",
      "resolution", "tenant_id",
    ],
    searchColumns: ["id", "domain", "severity", "title", "plain_summary", "source_key", "status"],
    orderBy: "created_at DESC",
    tenantScoped: true,
  },
  action_audit: {
    name: "action_audit",
    label: "Action Audit",
    description: "Audited operator and system actions.",
    table: "action_audit",
    columns: [
      "id", "ts", "actor", "actor_source", "action_kind", "action_id", "reason",
      "target_type", "target_id", "risk", "result_status", "result", "error", "tenant_id",
    ],
    searchColumns: ["actor", "action_kind", "action_id", "reason", "target_type", "target_id", "result_status", "error"],
    orderBy: "ts DESC, id DESC",
    tenantScoped: true,
  },
  reasoner_incidents: {
    name: "reasoner_incidents",
    label: "Reasoner Incidents",
    description: "Grouped reasoner and sentinel incidents with lifecycle fields.",
    table: "reasoner_incidents",
    columns: [
      "id", "cluster_key", "failure_class", "title", "first_seen", "last_seen",
      "occurrence_count", "representative_pass_id", "representative_diagnosis_id",
      "status", "acknowledged_at", "resolved_at", "post_mortem", "tenant_id",
    ],
    searchColumns: ["id", "cluster_key", "failure_class", "title", "status", "post_mortem"],
    orderBy: "last_seen DESC",
    tenantScoped: true,
  },
  reasoner_diagnoses: {
    name: "reasoner_diagnoses",
    label: "Reasoner Diagnoses",
    description: "Root-cause diagnoses emitted by the build reasoner.",
    table: "reasoner_diagnoses",
    columns: [
      "id", "pass_id", "run_id", "workflow_id", "failure_class", "root_cause",
      "evidence_json", "suggested_actions_json", "confidence", "diagnosed_at", "tenant_id",
    ],
    searchColumns: ["id", "pass_id", "run_id", "workflow_id", "failure_class", "root_cause", "confidence"],
    orderBy: "diagnosed_at DESC",
    tenantScoped: true,
  },
  builder_runs: {
    name: "builder_runs",
    label: "Builder Runs",
    description: "Workflow run state and result metadata.",
    table: "builder_runs",
    columns: [
      "id", "workflow_id", "trigger", "status", "started_at", "finished_at",
      "current_pass_id", "stop_requested_at", "stop_requested_by", "error",
      "github_issue_url", "github_branch_name", "github_commit_hash",
      "github_pull_request_url", "github_pull_request_status", "tenant_id",
    ],
    searchColumns: ["id", "workflow_id", "trigger", "status", "current_pass_id", "error", "github_branch_name"],
    orderBy: "started_at DESC",
    tenantScoped: true,
  },
  builder_workflows: {
    name: "builder_workflows",
    label: "Builder Workflows",
    description: "Builder workflow registry and scheduling state.",
    table: "builder_workflows",
    columns: [
      "id", "project_id", "name", "mode", "status", "plan_file", "created_at",
      "updated_at", "last_run_id", "next_run_at", "paused_reason", "tenant_id",
    ],
    searchColumns: ["id", "project_id", "name", "mode", "status", "plan_file", "paused_reason"],
    orderBy: "updated_at DESC",
    tenantScoped: true,
  },
  gateway_calls: {
    name: "gateway_calls",
    label: "Gateway Calls",
    description: "LiteLLM gateway call ledger without credential tables.",
    table: "gateway_calls",
    columns: [
      "id", "ts", "logical_model", "resolved_model", "backend", "tier",
      "prompt_tokens", "completion_tokens", "latency_ms", "cost_estimate_usd",
      "success", "error_class", "trace_id", "caller", "tenant_id",
    ],
    searchColumns: ["logical_model", "resolved_model", "backend", "tier", "error_class", "trace_id", "caller"],
    orderBy: "ts DESC, id DESC",
    tenantScoped: true,
  },
  jobs: {
    name: "jobs",
    label: "Jobs",
    description: "Durable background job state without request payloads or command output.",
    table: "jobs",
    columns: [
      "id", "ts", "kind", "state", "status", "actor", "reason", "target_type",
      "target_id", "started_at", "finished_at", "error", "exit_code",
      "retry_of_job_id", "max_retries", "retry_count", "tenant_id",
    ],
    searchColumns: ["id", "kind", "state", "status", "actor", "reason", "target_type", "target_id", "error"],
    orderBy: "COALESCE(started_at, ts, 0) DESC",
    tenantScoped: true,
  },
};

function json<T>(data: ApiEnvelope<T>, status = 200): Response {
  return Response.json(data, { status });
}

function error(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function tableExists(table: string): boolean {
  const db = getDashboardDb();
  if (!db) return false;
  const row = db.query(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(table) as { name: string } | null;
  return Boolean(row);
}

function existingColumns(definition: DatasetDefinition): string[] {
  const db = getDashboardDb();
  if (!db || !tableExists(definition.table)) return [];
  const rows = db.query(`PRAGMA table_info(${quoteIdentifier(definition.table)})`).all() as Array<{ name: string }>;
  const available = new Set(rows.map((row) => row.name));
  return definition.columns.filter((column) => available.has(column));
}

function clampLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, parsed);
}

function clampOffset(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

type QueryParam = string | number;

function buildWhere(definition: DatasetDefinition, columns: string[], q: string): { clause: string; params: QueryParam[] } {
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  if (definition.tenantScoped && columns.includes("tenant_id")) {
    clauses.push(`(${quoteIdentifier("tenant_id")} = ? OR ${quoteIdentifier("tenant_id")} IS NULL)`);
    params.push(getCurrentTenantContext().tenantId);
  }
  if (q.trim()) {
    const safeSearchColumns = definition.searchColumns.filter((column) => columns.includes(column));
    if (safeSearchColumns.length > 0) {
      clauses.push(`(${safeSearchColumns.map((column) => `CAST(${quoteIdentifier(column)} AS TEXT) LIKE ?`).join(" OR ")})`);
      params.push(...safeSearchColumns.map(() => `%${q.trim()}%`));
    }
  }
  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function tableInfo(definition: DatasetDefinition, rowCount: number, columns = existingColumns(definition)): DataExplorerTableInfo {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    rowCount,
    columns: columns.map((name) => ({ name, redacted: SENSITIVE_COLUMN_RE.test(name) })),
  };
}

function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      SENSITIVE_COLUMN_RE.test(column) ? "***" : redactForDashboard(value),
    ]),
  );
}

function countRows(definition: DatasetDefinition, columns = existingColumns(definition)): number {
  const db = getDashboardDb();
  if (!db || columns.length === 0) return 0;
  const where = buildWhere(definition, columns, "");
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM ${quoteIdentifier(definition.table)}
    ${where.clause}
  `).get(...where.params) as { count: number } | null;
  return row?.count ?? 0;
}

export async function dataExplorerTablesHandler(): Promise<Response> {
  if (!isDashboardDbEnabled()) return json(ok({ tables: [] } satisfies DataExplorerTablesPayload));
  const tables = Object.values(DATASETS).map((definition) => {
    const columns = existingColumns(definition);
    return tableInfo(definition, countRows(definition, columns), columns);
  });
  return json(ok({ tables }));
}

export async function dataExplorerTableHandler(name: string, url?: URL): Promise<Response> {
  if (!isDashboardDbEnabled()) return error("database unavailable", 503);
  const definition = DATASETS[name];
  if (!definition) return error("table not found", 404);
  const db = getDashboardDb();
  if (!db) return error("database unavailable", 503);

  const columns = existingColumns(definition);
  if (columns.length === 0) return error("table not found", 404);

  const limit = clampLimit(url?.searchParams.get("limit") ?? null);
  const offset = clampOffset(url?.searchParams.get("offset") ?? null);
  const q = url?.searchParams.get("q")?.slice(0, 200) ?? "";
  const where = buildWhere(definition, columns, q);
  const selectedColumns = columns.map(quoteIdentifier).join(", ");
  const total = (db.query(`
    SELECT COUNT(*) AS count
    FROM ${quoteIdentifier(definition.table)}
    ${where.clause}
  `).get(...where.params) as { count: number } | null)?.count ?? 0;

  const rows = db.query(`
    SELECT ${selectedColumns}
    FROM ${quoteIdentifier(definition.table)}
    ${where.clause}
    ORDER BY ${definition.orderBy}
    LIMIT ? OFFSET ?
  `).all(...where.params, limit, offset) as Array<Record<string, unknown>>;

  return json(ok({
    table: tableInfo(definition, countRows(definition, columns), columns),
    rows: rows.map(redactRow),
    limit,
    offset,
    total,
    q,
  } satisfies DataExplorerRowsPayload));
}
