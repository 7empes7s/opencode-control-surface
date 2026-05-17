import { getDashboardDb } from "../../db/dashboard.ts";

export type UserActivityParams = {
  tenantId: string;
  fromTs: number;
  toTs: number;
};

export async function runUserActivityReport(params: UserActivityParams): Promise<Record<string, unknown>[]> {
  const db = getDashboardDb();
  if (!db) return [];

  const rows = db.query(
    `SELECT actor, COUNT(*) as event_count, MIN(ts) as first_ts, MAX(ts) as last_ts 
     FROM action_audit 
     WHERE tenant_id = ? AND ts >= ? AND ts <= ? 
     GROUP BY actor 
     ORDER BY event_count DESC`,
  ).all(params.tenantId, params.fromTs, params.toTs);

  return rows as Record<string, unknown>[];
}