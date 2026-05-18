import { randomUUID } from "node:crypto";
import { getDashboardDb } from "../db/dashboard.ts";

export type LaneStatus = {
  active: number;
  max: number;
};

export function setLaneLimit(laneName: string, maxConcurrency: number, tenantId?: string): void {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not available");

  const effectiveTenantId = tenantId ?? "mimule"; // Default to mimule if not provided
  db.query(
    `INSERT INTO orchestrator_lanes (id, lane_name, max_concurrency, active_count, updated_at, tenant_id)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(lane_name) DO UPDATE SET max_concurrency = excluded.max_concurrency, updated_at = excluded.updated_at, tenant_id = excluded.tenant_id`,
  ).run(randomUUID(), laneName, maxConcurrency, Date.now(), effectiveTenantId);
}

export function acquireLane(laneName: string, tenantId?: string): boolean {
  const db = getDashboardDb();
  if (!db) return true; // permissive when DB is unavailable

  const effectiveTenantId = tenantId ?? "mimule"; // Default to mimule if not provided
  const result = db
    .query(
      `UPDATE orchestrator_lanes
       SET active_count = active_count + 1, updated_at = ?
       WHERE lane_name = ? AND active_count < max_concurrency AND (tenant_id = ? OR tenant_id IS NULL)
       RETURNING active_count`,
    )
    .get(Date.now(), laneName, effectiveTenantId) as { active_count: number } | null;

  return result !== null;
}

export function releaseLane(laneName: string, tenantId?: string): void {
  const db = getDashboardDb();
  if (!db) return;

  const effectiveTenantId = tenantId ?? "mimule"; // Default to mimule if not provided
  db.query(
    `UPDATE orchestrator_lanes
     SET active_count = MAX(0, active_count - 1), updated_at = ?
     WHERE lane_name = ? AND (tenant_id = ? OR tenant_id IS NULL)`,
  ).run(Date.now(), laneName, effectiveTenantId);
}

export function getLaneStatus(laneName: string, tenantId?: string): LaneStatus | null {
  const db = getDashboardDb();
  if (!db) return null;

  const effectiveTenantId = tenantId ?? "mimule"; // Default to mimule if not provided
  const row = db
    .query(`SELECT active_count, max_concurrency FROM orchestrator_lanes WHERE lane_name = ? AND (tenant_id = ? OR tenant_id IS NULL)`)
    .get(laneName, effectiveTenantId) as { active_count: number; max_concurrency: number } | null;

  if (!row) return null;

  return { active: row.active_count, max: row.max_concurrency };
}
