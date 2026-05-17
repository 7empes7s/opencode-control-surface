import { randomUUID } from "node:crypto";
import { getDashboardDb } from "../db/dashboard.ts";

export type LaneStatus = {
  active: number;
  max: number;
};

export function setLaneLimit(laneName: string, maxConcurrency: number): void {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not available");

  db.query(
    `INSERT INTO orchestrator_lanes (id, lane_name, max_concurrency, active_count, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(lane_name) DO UPDATE SET max_concurrency = excluded.max_concurrency, updated_at = excluded.updated_at`,
  ).run(randomUUID(), laneName, maxConcurrency, Date.now());
}

export function acquireLane(laneName: string): boolean {
  const db = getDashboardDb();
  if (!db) return true; // permissive when DB is unavailable

  const result = db
    .query(
      `UPDATE orchestrator_lanes
       SET active_count = active_count + 1, updated_at = ?
       WHERE lane_name = ? AND active_count < max_concurrency
       RETURNING active_count`,
    )
    .get(Date.now(), laneName) as { active_count: number } | null;

  return result !== null;
}

export function releaseLane(laneName: string): void {
  const db = getDashboardDb();
  if (!db) return;

  db.query(
    `UPDATE orchestrator_lanes
     SET active_count = MAX(0, active_count - 1), updated_at = ?
     WHERE lane_name = ?`,
  ).run(Date.now(), laneName);
}

export function getLaneStatus(laneName: string): LaneStatus | null {
  const db = getDashboardDb();
  if (!db) return null;

  const row = db
    .query(`SELECT active_count, max_concurrency FROM orchestrator_lanes WHERE lane_name = ?`)
    .get(laneName) as { active_count: number; max_concurrency: number } | null;

  if (!row) return null;

  return { active: row.active_count, max: row.max_concurrency };
}
