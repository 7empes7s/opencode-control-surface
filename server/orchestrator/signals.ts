import { randomUUID } from "node:crypto";
import { getDashboardDb } from "../db/dashboard.ts";
import type { StepResult } from "./types.ts";

type DbSignalRow = {
  id: string;
  instance_id: string;
  signal_name: string;
  payload_json: string;
  delivered: number;
  created_at: number;
};

export type SignalPayload = unknown;

export function emitSignal(
  instanceId: string,
  signalName: string,
  payload: SignalPayload,
  tenantId?: string,
): string {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not available");

  const id = randomUUID();
  const effectiveTenantId = tenantId ?? "mimule"; // Default to mimule if not provided
  db.query(
    `INSERT INTO orchestrator_signals (id, instance_id, signal_name, payload_json, delivered, created_at, tenant_id)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, instanceId, signalName, JSON.stringify(payload), Date.now(), effectiveTenantId);

  return id;
}

export function consumeSignal(
  instanceId: string,
  signalName: string,
  tenantId?: string,
): SignalPayload | null {
  const db = getDashboardDb();
  if (!db) return null;

  const effectiveTenantId = tenantId ?? "mimule"; // Default to mimule if not provided

  const row = db
    .query(
      `SELECT * FROM orchestrator_signals
       WHERE instance_id = ? AND signal_name = ? AND delivered = 0 AND (tenant_id = ? OR tenant_id IS NULL)
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(instanceId, signalName, effectiveTenantId) as DbSignalRow | null;

  if (!row) return null;

  db.query(`UPDATE orchestrator_signals SET delivered = 1 WHERE id = ?`).run(row.id);

  return JSON.parse(row.payload_json) as SignalPayload;
}

const DEFAULT_SIGNAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const POLL_INTERVAL_MS = 5000;

export async function waitSignalStepHandler(
  payload: unknown,
  instanceId: string,
  tenantId?: string,
): Promise<StepResult> {
  const { name, timeoutMs = DEFAULT_SIGNAL_TIMEOUT_MS } = payload as {
    name: string;
    timeoutMs?: number;
  };

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const signalPayload = consumeSignal(instanceId, name, tenantId);
    if (signalPayload !== null) {
      return { status: "complete", output: signalPayload };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }

  return { status: "blocked", error: "timeout" };
}

export async function waitTimerStepHandler(
  payload: unknown,
  _instanceId: string,
): Promise<StepResult> {
  const { fireAt } = payload as { fireAt: number };

  const delay = fireAt - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return { status: "complete" };
}
