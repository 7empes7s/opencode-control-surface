import { createHash } from "node:crypto";
import { getDashboardDb } from "../../db/dashboard.ts";
import type { ActionAuditRow } from "../../db/writer.ts";

export type AuditExportFormat = "jsonl" | "csv";

export type AuditExportOptions = {
  tenantId: string;
  fromTs: number;
  toTs: number;
  format: AuditExportFormat;
  includeKinds?: string[];
};

export type AuditRowForHash = {
  id: string;
  ts: number;
  actor: string;
  actor_source: string;
  action_kind: string;
  action_id: string;
  reason: string;
  target: string;
  target_type: string;
  target_id: string;
  risk: string;
  request_json: string;
  args_json: string;
  result_status: string;
  result: string;
  result_json: string;
  evidence_json: string;
  job_id: string;
  event_id: string;
  rollback_hint: string;
  error: string;
  tenant_id: string;
  prev_hash: string;
  row_hash: string;
};

export type ChainResult = {
  rows: (AuditRowForHash & { hash: string })[];
  chainHash: string;
};

export async function* exportAuditLog(
  opts: AuditExportOptions,
): AsyncGenerator<string> {
  const db = getDashboardDb();
  if (!db) return;

  const { tenantId, fromTs, toTs, format, includeKinds } = opts;
  const params: Array<string | number> = [tenantId, fromTs, toTs];

  let sql = `
    SELECT id, ts, actor, actor_source, action_kind, action_id, reason, target,
      target_type, target_id, risk, request_json, args_json, result_status,
      result, result_json, evidence_json, job_id, event_id, rollback_hint, error,
      tenant_id, prev_hash, row_hash
    FROM action_audit
    WHERE tenant_id = ? AND ts >= ? AND ts <= ?
  `;

  if (includeKinds && includeKinds.length > 0) {
    const placeholders = includeKinds.map(() => "?").join(", ");
    sql += ` AND action_kind IN (${placeholders})`;
    params.push(...includeKinds);
  }

  sql += " ORDER BY ts ASC, id ASC";

  if (format === "csv") {
    yield [
      "id", "ts", "actor", "actor_source", "action_kind", "action_id", "reason",
      "target", "target_type", "target_id", "risk", "request_json", "args_json",
      "result_status", "result", "result_json", "evidence_json", "job_id",
      "event_id", "rollback_hint", "error", "tenant_id", "prev_hash", "row_hash",
    ].join(",") + "\n";
  }

  const BATCH = 500;
  let offset = 0;
  while (true) {
    const batchSql = sql + ` LIMIT ${BATCH} OFFSET ${offset}`;
    const rows = db.query(batchSql).all(...params) as AuditRowForHash[];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (format === "jsonl") {
        yield JSON.stringify(row) + "\n";
      } else {
        yield csvEscapeRow(row) + "\n";
      }
    }

    offset += BATCH;
    if (rows.length < BATCH) break;
  }
}

function csvEscapeRow(row: AuditRowForHash): string {
  const fields: (string | number)[] = [
    row.id,
    row.ts,
    row.actor ?? "",
    row.actor_source ?? "",
    row.action_kind ?? "",
    row.action_id ?? "",
    row.reason ?? "",
    row.target ?? "",
    row.target_type ?? "",
    row.target_id ?? "",
    row.risk ?? "",
    row.request_json ?? "",
    row.args_json ?? "",
    row.result_status ?? "",
    row.result ?? "",
    row.result_json ?? "",
    row.evidence_json ?? "",
    row.job_id ?? "",
    row.event_id ?? "",
    row.rollback_hint ?? "",
    row.error ?? "",
    row.tenant_id ?? "",
    row.prev_hash ?? "",
    row.row_hash ?? "",
  ];
  return fields.map((v) => csvEscape(String(v))).join(",");
}

function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function buildHashChain(rows: AuditRowForHash[]): ChainResult {
  const result: (AuditRowForHash & { hash: string })[] = [];
  let prevHash = "genesis";

  for (const row of rows) {
    const payload = prevHash + JSON.stringify(row);
    const hash = createHash("sha256").update(payload).digest("hex");
    result.push({ ...row, hash });
    prevHash = hash;
  }

  const chainHash = result.length > 0 ? result[result.length - 1].hash : "genesis";
  return { rows: result, chainHash };
}

export function verifyHashChain(
  rows: (AuditRowForHash & { hash: string })[],
): { valid: boolean; firstBadIndex?: number } {
  let prevHash = "genesis";

  for (let i = 0; i < rows.length; i++) {
    const { hash: _hash, ...rest } = rows[i];
    const rowWithoutHash = rest as AuditRowForHash;
    const expected = createHash("sha256").update(prevHash + JSON.stringify(rowWithoutHash)).digest("hex");
    if (expected !== rows[i].hash) {
      return { valid: false, firstBadIndex: i };
    }
    prevHash = rows[i].hash;
  }

  return { valid: true };
}

export function getAuditRetentionDays(tenantId: string): number {
  const db = getDashboardDb();
  if (!db) return 90;

  const row = db.query(
    "SELECT audit_retention_days FROM tenant_settings WHERE tenant_id = ?",
  ).get(tenantId) as { audit_retention_days: number } | null;

  return row?.audit_retention_days ?? Number.parseInt(process.env.AUDIT_RETENTION_DAYS ?? "90", 10);
}

export function purgeExpiredAuditRows(tenantId: string, retentionDays: number): number {
  const db = getDashboardDb();
  if (!db) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = db.query(
    "DELETE FROM action_audit WHERE tenant_id = ? AND ts < ?",
  ).run(tenantId, cutoff);

  return result.changes ?? 0;
}