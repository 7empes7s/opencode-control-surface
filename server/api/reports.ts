import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDashboardDb } from "../db/dashboard.ts";
import { REPORT_TEMPLATES, runReport } from "../reporting/index.ts";
import type { ReportOutput } from "../reporting/types.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import { getTenantContext } from "../tenancy/context.ts";

type ReportRunRow = {
  id: string;
  tenant_id: string;
  template_id: string;
  params_json: string;
  status: string;
  output_json: string;
  row_count: number;
  started_at: number;
  finished_at: number | null;
  error: string | null;
};

function runToJson(run: ReportRunRow): Record<string, unknown> {
  return {
    id: run.id,
    tenantId: run.tenant_id,
    templateId: run.template_id,
    params: run.params_json ? JSON.parse(run.params_json) : {},
    status: run.status,
    output: run.output_json ? JSON.parse(run.output_json) : null,
    rowCount: run.row_count,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    error: run.error,
  };
}

function parseLimit(raw: string | null, fallback = 50): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireReportsDb(): ReturnType<typeof getDashboardDb> | Response {
  const db = getDashboardDb();
  if (!db) {
    return errorResponse("DASHBOARD_DB disabled", 503);
  }
  return db;
}

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "pending";
  return new Date(ts).toISOString();
}

function rowsFromOutput(outputJson: string): Record<string, unknown>[] {
  if (!outputJson) return [];
  const output = JSON.parse(outputJson) as { rows?: unknown };
  if (!Array.isArray(output.rows)) return [];
  return output.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

function renderReportMarkdown(run: ReportRunRow): string {
  const template = REPORT_TEMPLATES.find((t) => t.id === run.template_id);
  const title = template?.name ?? run.template_id;
  const rows = rowsFromOutput(run.output_json);
  const lines = [
    `# ${title} Report`,
    "",
    `- Run: ${run.id}`,
    `- Tenant: ${run.tenant_id}`,
    `- Template: ${run.template_id}`,
    `- Status: ${run.status}`,
    `- Started: ${formatDate(run.started_at)}`,
    `- Finished: ${formatDate(run.finished_at)}`,
    `- Rows: ${run.row_count}`,
    "",
  ];

  if (!rows.length) {
    lines.push("No rows.");
    return lines.join("\n");
  }

  const headers = Object.keys(rows[0]).slice(0, 10);
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows.slice(0, 100)) {
    lines.push(`| ${headers.map((header) => String(row[header] ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
  }
  if (rows.length > 100) {
    lines.push("");
    lines.push(`Showing 100 of ${rows.length} rows.`);
  }
  return lines.join("\n");
}

function vaultPathForRun(run: ReportRunRow): string {
  const vaultRoot = process.env.DASHBOARD_REPORTS_VAULT_DIR || "/opt/ai-vault";
  const date = new Date(run.finished_at ?? run.started_at).toISOString().slice(0, 10);
  if (run.template_id === "daily-pipeline") {
    return join(vaultRoot, "daily", `${date}-pipeline.md`);
  }
  if (run.template_id === "weekly-content-health") {
    return join(vaultRoot, "projects", "newsbites-content-weekly.md");
  }
  return join(vaultRoot, "projects", `dashboard-report-${run.template_id}-${date}.md`);
}

export async function createReportRun(input: {
  templateId: string;
  tenantId: string;
  fromTs: number;
  toTs: number;
  params?: Record<string, unknown>;
}): Promise<{ runId: string; output: ReportOutput }> {
  const template = REPORT_TEMPLATES.find((t) => t.id === input.templateId);
  if (!template) {
    throw new Error(`Unknown template: ${input.templateId}`);
  }

  const db = getDashboardDb();
  if (!db) {
    throw new Error("DASHBOARD_DB disabled");
  }

  const runId = crypto.randomUUID();
  const now = Date.now();
  const params = {
    ...(input.params ?? {}),
    tenantId: input.tenantId,
    fromTs: input.fromTs,
    toTs: input.toTs,
  };

  db.query(
    `INSERT INTO report_runs (id, tenant_id, template_id, params_json, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, input.tenantId, input.templateId, JSON.stringify(params), "running", now);

  try {
    const output = await runReport(input.templateId, {
      tenantId: input.tenantId,
      fromTs: input.fromTs,
      toTs: input.toTs,
    });

    db.query(
      `UPDATE report_runs SET status = ?, output_json = ?, row_count = ?, finished_at = ?
       WHERE id = ?`,
    ).run("success", JSON.stringify(output), output.rowCount, Date.now(), runId);

    return { runId, output };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    db.query(
      `UPDATE report_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
    ).run("failed", errMsg, Date.now(), runId);
    throw err;
  }
}

export function reportsListHandler(req: Request): Response {
  const dbOrResponse = requireReportsDb();
  if (dbOrResponse instanceof Response) return dbOrResponse;

  const ctx = getTenantContext(req);
  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const status = url.searchParams.get("status");
  const templateId = url.searchParams.get("templateId");

  const where = ["tenant_id = ?"];
  const params: Array<string | number> = [ctx.tenantId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (templateId) {
    where.push("template_id = ?");
    params.push(templateId);
  }

  const runs = dbOrResponse.query(`
    SELECT *
    FROM report_runs
    WHERE ${where.join(" AND ")}
    ORDER BY started_at DESC
    LIMIT ?
  `).all(...params, limit) as ReportRunRow[];

  const summaryRows = dbOrResponse.query(`
    SELECT template_id, status, COUNT(*) AS count, MAX(started_at) AS latest_started_at
    FROM report_runs
    WHERE tenant_id = ?
    GROUP BY template_id, status
    ORDER BY latest_started_at DESC
  `).all(ctx.tenantId) as Array<{ template_id: string; status: string; count: number; latest_started_at: number }>;

  const envelope: ApiEnvelope<Record<string, unknown>> = ok({
    runs: runs.map(runToJson),
    templates: REPORT_TEMPLATES,
    summary: summaryRows.map((row) => ({
      templateId: row.template_id,
      status: row.status,
      count: row.count,
      latestStartedAt: row.latest_started_at,
    })),
  });
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export function reportsTemplatesHandler(): Response {
  const envelope: ApiEnvelope<typeof REPORT_TEMPLATES> = ok(REPORT_TEMPLATES);
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function reportsRunHandler(req: Request): Promise<Response> {
  const dbOrResponse = requireReportsDb();
  if (dbOrResponse instanceof Response) return dbOrResponse;

  const ctx = getTenantContext(req);
  const body = await req.json().catch(() => ({})) as {
    templateId?: string;
    params?: { tenantId?: string; fromTs?: number; toTs?: number };
  };

  const templateId = body?.templateId;
  if (!templateId) {
    return errorResponse("templateId required", 400);
  }

  const template = REPORT_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    return errorResponse("Unknown template", 404);
  }

  const params = body?.params ?? {};
  const tenantId = params.tenantId ?? ctx.tenantId;
  const fromTs = params.fromTs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  const toTs = params.toTs ?? Date.now();

  try {
    const { runId, output } = await createReportRun({
      templateId,
      tenantId,
      fromTs,
      toTs,
      params,
    });

    return new Response(
      JSON.stringify(ok({ runId, output })),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return errorResponse(errMsg, 500);
  }
}

export async function reportsGetHandler(req: Request, runId: string): Promise<Response> {
  const dbOrResponse = requireReportsDb();
  if (dbOrResponse instanceof Response) return dbOrResponse;

  const run = dbOrResponse.query("SELECT * FROM report_runs WHERE id = ?").get(runId) as ReportRunRow | null;

  if (!run) {
    return errorResponse("run not found", 404);
  }

  const envelope: ApiEnvelope<Record<string, unknown>> = ok(runToJson(run));
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function reportsDownloadCsvHandler(req: Request, runId: string): Promise<Response> {
  const dbOrResponse = requireReportsDb();
  if (dbOrResponse instanceof Response) return dbOrResponse;

  const run = dbOrResponse.query("SELECT output_json, status FROM report_runs WHERE id = ?").get(runId) as
    | { output_json: string; status: string }
    | null;

  if (!run) {
    return errorResponse("run not found", 404);
  }

  if (run.status !== "success") {
    return errorResponse("run not completed", 409);
  }

  const output = JSON.parse(run.output_json) as { rows: Record<string, unknown>[] };
  if (!output.rows || output.rows.length === 0) {
    return new Response("No data", {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    });
  }

  const headers = Object.keys(output.rows[0]);
  const csvLines = [headers.join(",")];

  for (const row of output.rows) {
    const values = headers.map((h) => JSON.stringify(row[h] ?? ""));
    csvLines.push(values.join(","));
  }

  return new Response(csvLines.join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="report-${runId}.csv"`,
    },
  });
}

export async function reportsExportVaultHandler(req: Request, runId: string): Promise<Response> {
  const dbOrResponse = requireReportsDb();
  if (dbOrResponse instanceof Response) return dbOrResponse;

  const ctx = getTenantContext(req);
  const run = dbOrResponse.query("SELECT * FROM report_runs WHERE id = ? AND tenant_id = ?").get(runId, ctx.tenantId) as ReportRunRow | null;

  if (!run) {
    return errorResponse("run not found", 404);
  }

  if (run.status !== "success") {
    return errorResponse("run not completed", 409);
  }

  const path = vaultPathForRun(run);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${renderReportMarkdown(run)}\n`, "utf8");

  return new Response(JSON.stringify(ok({ path, runId: run.id, templateId: run.template_id })), {
    headers: { "Content-Type": "application/json" },
  });
}
