import { isDashboardDbEnabled, getDashboardDb } from "../db/dashboard.ts";
import { readActionAudit, type ActionAuditRow } from "../db/writer.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import { exportAuditLog, buildHashChain, verifyHashChain, type AuditRowForHash } from "../governance/audit/export.ts";

export type ActionAuditResponse = {
  audit: ActionAuditRow[];
  degraded: boolean;
  reason?: string;
};

function response(data: ActionAuditResponse): Response {
  const envelope: ApiEnvelope<ActionAuditResponse> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 100;
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.max(1, Math.min(500, parsed));
}

export async function actionAuditHandler(url: URL): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return response({ audit: [], degraded: true, reason: "DASHBOARD_DB disabled" });
  }

  const audit = readActionAudit({
    limit: parseLimit(url.searchParams.get("limit")),
    targetType: url.searchParams.get("targetType") ?? undefined,
    resultStatus: url.searchParams.get("resultStatus") ?? undefined,
    actionKind: url.searchParams.get("actionKind") ?? undefined,
  });
  return response({ audit, degraded: false });
}

type AuditExportJob = {
  id: string;
  tenant_id: string;
  requested_by: string;
  from_ts: number;
  to_ts: number;
  format: string;
  status: string;
  row_count: number | null;
  chain_hash: string | null;
  output_path: string | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
};

function jobToJson(job: AuditExportJob): Record<string, unknown> {
  return {
    id: job.id,
    tenantId: job.tenant_id,
    requestedBy: job.requested_by,
    fromTs: job.from_ts,
    toTs: job.to_ts,
    format: job.format,
    status: job.status,
    rowCount: job.row_count,
    chainHash: job.chain_hash,
    outputPath: job.output_path,
    error: job.error,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

export async function auditExportHandler(
  url: URL,
  method: string,
  body: unknown,
): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = getDashboardDb()!;
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/api/audit/export") {
    const opts = body as { fromTs?: number; toTs?: number; format?: string; includeKinds?: string[]; tenantId?: string };
    const fromTs = opts?.fromTs ?? Date.now() - 90 * 24 * 60 * 60 * 1000;
    const toTs = opts?.toTs ?? Date.now();
    const format = opts?.format ?? "jsonl";
    const tenantId = opts?.tenantId ?? "mimule";
    const includeKinds = opts?.includeKinds;

    const jobId = crypto.randomUUID();
    const now = Date.now();

    db.query(
      `INSERT INTO audit_export_jobs (id, tenant_id, requested_by, from_ts, to_ts, format, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(jobId, tenantId, "api", fromTs, toTs, format, "running", now);

    const outputDir = "/var/lib/control-surface/exports";
    const outputPath = `${outputDir}/${jobId}.${format}`;

    try {
      const chunks: string[] = [];
      for await (const chunk of exportAuditLog({ tenantId, fromTs, toTs, format: format as "jsonl" | "csv", includeKinds })) {
        chunks.push(chunk);
      }
      const content = chunks.join("");

      await Bun.write(outputPath, content);

      const countResult = db.query(
        "SELECT COUNT(*) as cnt FROM action_audit WHERE tenant_id = ? AND ts >= ? AND ts <= ?",
      ).get(tenantId, fromTs, toTs) as { cnt: number };
      const rowCount = countResult?.cnt ?? 0;

      const rowsForHash = db.query(
        `SELECT id, ts, actor, actor_source, action_kind, action_id, reason, target,
          target_type, target_id, risk, request_json, args_json, result_status,
          result, result_json, evidence_json, job_id, event_id, rollback_hint, error,
          tenant_id, prev_hash, row_hash
         FROM action_audit WHERE tenant_id = ? AND ts >= ? AND ts <= ?
         ORDER BY ts ASC, id ASC`,
      ).all(tenantId, fromTs, toTs) as AuditRowForHash[];

      const { chainHash } = buildHashChain(rowsForHash);

      db.query(
        `UPDATE audit_export_jobs SET status = ?, row_count = ?, chain_hash = ?, output_path = ?, finished_at = ?
         WHERE id = ?`,
      ).run("completed", rowCount, chainHash, outputPath, Date.now(), jobId);

      return new Response(JSON.stringify(ok({ jobId, status: "completed", rowCount, chainHash, downloadUrl: `/api/audit/export/${jobId}/download` })), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      db.query(
        `UPDATE audit_export_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
      ).run("failed", errMsg, Date.now(), jobId);

      return new Response(JSON.stringify({ error: errMsg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const jobIdMatch = pathname.match(/^\/api\/audit\/export\/([^/]+)$/);
  if (!jobIdMatch) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const jobId = jobIdMatch[1];

  if (method === "GET") {
    const job = db.query("SELECT * FROM audit_export_jobs WHERE id = ?").get(jobId) as AuditExportJob | null;
    if (!job) {
      return new Response(JSON.stringify({ error: "job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(ok(jobToJson(job))), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (pathname.endsWith("/download")) {
    const job = db.query("SELECT output_path, status FROM audit_export_jobs WHERE id = ?").get(jobId) as { output_path: string | null; status: string } | null;
    if (!job || !job.output_path) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (job.status !== "completed") {
      return new Response(JSON.stringify({ error: "job not completed" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    const file = Bun.file(job.output_path);
    return new Response(file, {
      headers: {
        "Content-Type": job.output_path.endsWith(".csv") ? "text/csv" : "application/jsonl",
        "Content-Disposition": `attachment; filename="${jobId}.${job.output_path.split(".").pop()}"`,
      },
    });
  }

  if (method === "POST" && pathname.endsWith("/verify")) {
    const job = db.query("SELECT output_path, status FROM audit_export_jobs WHERE id = ?").get(jobId) as { output_path: string | null; status: string } | null;
    if (!job || !job.output_path) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const content = await Bun.file(job.output_path).text();
      const rows: (AuditRowForHash & { hash: string })[] = [];

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as AuditRowForHash & { hash?: string };
        if (parsed.hash !== undefined) {
          rows.push(parsed as AuditRowForHash & { hash: string });
        }
      }

      const result = verifyHashChain(rows);
      return new Response(JSON.stringify(ok({
        valid: result.valid,
        rowCount: rows.length,
        firstBadIndex: result.firstBadIndex,
      })), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: `verification failed: ${String(err)}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}