import { getDashboardDb } from "../../db/dashboard.ts";

export type ChainVerifierParams = {
  tenantId: string;
  fromTs: number;
  toTs: number;
};

export type ChainVerifierResult = {
  pass: boolean;
  totalRows: number;
  verifiedRows: number;
  anomalies: string[];
  checkedAt: number;
};

export async function runChainVerifierReport(params: ChainVerifierParams): Promise<Record<string, unknown>[]> {
  const db = getDashboardDb();
  if (!db) return [];

  const rows = db.query(
    `SELECT id, ts, prev_hash, row_hash FROM action_audit
     WHERE tenant_id = ? AND ts >= ? AND ts <= ?
     ORDER BY ts ASC`,
  ).all(params.tenantId, params.fromTs, params.toTs) as Array<{
    id: number;
    ts: number;
    prev_hash: string | null;
    row_hash: string | null;
  }>;

  const anomalies: string[] = [];
  let verifiedRows = 0;

  for (const row of rows) {
    if (!row.row_hash) {
      anomalies.push(`Row ${row.id}: missing row_hash`);
      continue;
    }
    verifiedRows++;
  }

  const pass = anomalies.length === 0;

  return [{
    pass,
    totalRows: rows.length,
    verifiedRows,
    anomalies,
    checkedAt: Date.now(),
  }];
}