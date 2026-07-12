import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAuditRetentionDays, purgeExpiredAuditRows } from "./audit/export.ts";
import { rollupUsageDaily, sweepUsageRetention } from "../usage/analytics.ts";

export type RetentionPolicy = {
  tracesTtlDays: number;
  runDirsTtlDays: number;
  auditLogRetainForever: boolean;
};

let currentPolicy: RetentionPolicy = {
  tracesTtlDays: 30,
  runDirsTtlDays: 14,
  auditLogRetainForever: true,
};

export function getRetentionPolicy(): RetentionPolicy {
  return { ...currentPolicy };
}

export function setRetentionPolicy(policy: Partial<RetentionPolicy>): RetentionPolicy {
  currentPolicy = { ...currentPolicy, ...policy };
  return getRetentionPolicy();
}

export function runRetentionCleanup(): {
  tracesDeleted: number;
  runDirsDeleted: number;
  errors: string[];
  auditRowsPurged?: number;
} {
  const errors: string[] = [];
  let tracesDeleted = 0;
  let runDirsDeleted = 0;
  const now = Date.now();
  const policy = getRetentionPolicy();

  try {
    rollupUsageDaily(now);
    sweepUsageRetention(now);
  } catch (error) {
    // Keep the sweep behind the rollup: if aggregation fails, no raw usage is deleted.
    errors.push(`usage retention failed: ${String(error)}`);
  }

  const tracesDir = "/var/lib/control-surface/traces";
  const runDirsBase = "/var/lib/control-surface/runs";

  if (policy.tracesTtlDays > 0) {
    try {
      const entries = readdirSync(tracesDir);
      const cutoff = now - policy.tracesTtlDays * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        try {
          const fullPath = join(tracesDir, entry);
          const mtime = statSync(fullPath).mtimeMs;
          if (mtime < cutoff) {
            unlinkSync(fullPath);
            tracesDeleted++;
          }
        } catch {
          errors.push(`failed to check trace ${entry}: ${String((globalThis as { err?: unknown }).err)}`);
        }
      }
    } catch (e) {
      errors.push(`traces dir read failed: ${String(e)}`);
    }
  }

  if (policy.runDirsTtlDays > 0) {
    try {
      const entries = readdirSync(runDirsBase);
      const cutoff = now - policy.runDirsTtlDays * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        try {
          const fullPath = join(runDirsBase, entry);
          const mtime = statSync(fullPath).mtimeMs;
          if (mtime < cutoff) {
            unlinkSync(fullPath);
            runDirsDeleted++;
          }
        } catch {
          errors.push(`failed to check run dir ${entry}: ${String((globalThis as { err?: unknown }).err)}`);
        }
      }
    } catch (e) {
      errors.push(`run dirs base read failed: ${String(e)}`);
    }
  }

  return { tracesDeleted, runDirsDeleted, errors, auditRowsPurged: 0 };
}

export async function runAuditRetentionPurge(tenantId: string): Promise<number> {
  const days = getAuditRetentionDays(tenantId);
  return purgeExpiredAuditRows(tenantId, days);
}

let retentionTimer: ReturnType<typeof setInterval> | null = null;

export function startRetentionScheduler(): void {
  runRetentionCleanup();
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = setInterval(() => {
    runRetentionCleanup();
  }, 24 * 60 * 60 * 1000);
}

export function stopRetentionScheduler(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
