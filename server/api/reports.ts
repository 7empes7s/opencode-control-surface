import { getDashboardDb } from "../db/dashboard.ts";
import { REPORT_TEMPLATES, runReport } from "../reporting/index.ts";
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

export function reportsTemplatesHandler(): Response {
  const envelope: ApiEnvelope<typeof REPORT_TEMPLATES> = ok(REPORT_TEMPLATES);
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function reportsRunHandler(req: Request): Promise<Response> {
  if (!getDashboardDb()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ctx = getTenantContext(req);
  const body = await req.json().catch(() => ({})) as {
    templateId?: string;
    params?: { tenantId?: string; fromTs?: number; toTs?: number };
  };

  const templateId = body?.templateId;
  if (!templateId) {
    return new Response(JSON.stringify({ error: "templateId required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const template = REPORT_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    return new Response(JSON.stringify({ error: "Unknown template" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const params = body?.params ?? {};
  const tenantId = params.tenantId ?? ctx.tenantId;
  const fromTs = params.fromTs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  const toTs = params.toTs ?? Date.now();

  const db = getDashboardDb()!;
  const runId = crypto.randomUUID();
  const now = Date.now();

  db.query(
    `INSERT INTO report_runs (id, tenant_id, template_id, params_json, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, tenantId, templateId, JSON.stringify(params), "running", now);

  try {
    const output = await runReport(templateId, { tenantId, fromTs, toTs });

    db.query(
      `UPDATE report_runs SET status = ?, output_json = ?, row_count = ?, finished_at = ?
       WHERE id = ?`,
    ).run("success", JSON.stringify(output), output.rowCount, Date.now(), runId);

    return new Response(
      JSON.stringify(ok({ runId, output })),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    db.query(
      `UPDATE report_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
    ).run("failed", errMsg, Date.now(), runId);

    return new Response(JSON.stringify({ error: errMsg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function reportsGetHandler(req: Request, runId: string): Promise<Response> {
  if (!getDashboardDb()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = getDashboardDb()!;
  const run = db.query("SELECT * FROM report_runs WHERE id = ?").get(runId) as ReportRunRow | null;

  if (!run) {
    return new Response(JSON.stringify({ error: "run not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const envelope: ApiEnvelope<Record<string, unknown>> = ok(runToJson(run));
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function reportsDownloadCsvHandler(req: Request, runId: string): Promise<Response> {
  if (!getDashboardDb()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = getDashboardDb()!;
  const run = db.query("SELECT output_json, status FROM report_runs WHERE id = ?").get(runId) as
    | { output_json: string; status: string }
    | null;

  if (!run) {
    return new Response(JSON.stringify({ error: "run not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (run.status !== "success") {
    return new Response(JSON.stringify({ error: "run not completed" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
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