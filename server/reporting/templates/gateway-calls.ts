import { getDashboardDb } from "../../db/dashboard.ts";

export type GatewayCallsParams = {
  tenantId: string;
  fromTs: number;
  toTs: number;
};

export async function runGatewayCallsReport(params: GatewayCallsParams): Promise<Record<string, unknown>[]> {
  const db = getDashboardDb();
  if (!db) return [];

  const rows = db.query(
    `SELECT * FROM action_audit 
     WHERE tenant_id = ? AND action_kind = 'gateway.call' AND ts >= ? AND ts <= ? 
     ORDER BY ts DESC`,
  ).all(params.tenantId, params.fromTs, params.toTs);

  return rows as Record<string, unknown>[];
}