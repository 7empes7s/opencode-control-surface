import { getDashboardDb } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export interface FeatureFlag {
  id: string;
  key: string;
  label: string | null;
  description: string | null;
  enabled: boolean;
  rolloutPercentage: number;
  /** JSON-serialised targeting rules: { tenant_ids?: string[], user_ids?: string[] } */
  targetingJson: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  tenantId: string;
}

export interface FeatureFlagHistory {
  id: number;
  ts: number;
  flagId: string;
  oldValueJson: string | null;
  newValueJson: string;
  changedBy: string;
  note: string | null;
}

export interface CreateFlagInput {
  key: string;
  label?: string | null;
  description?: string | null;
  enabled?: boolean;
  rolloutPercentage?: number;
  targetingJson?: unknown;
  createdBy?: string;
}

export interface UpdateFlagInput {
  key?: string;
  label?: string | null;
  description?: string | null;
  enabled?: boolean;
  rolloutPercentage?: number;
  targetingJson?: unknown;
}

type FlagRow = {
  id: string;
  key: string;
  label: string | null;
  description: string | null;
  enabled: number;
  rollout_percentage: number;
  targeting_json: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  tenant_id: string;
};

function rowToFlag(row: FlagRow): FeatureFlag {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    description: row.description,
    enabled: row.enabled === 1,
    rolloutPercentage: row.rollout_percentage,
    targetingJson: row.targeting_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    tenantId: row.tenant_id,
  };
}

function writeHistory(
  flagId: string,
  oldJson: string | null,
  newJson: string,
  changedBy: string,
  note?: string,
): void {
  const db = getDashboardDb();
  if (!db) return;
  try {
    db.query(
      "INSERT INTO config_changes (ts, key, old_value_json, new_value_json, changed_by, note) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(Date.now(), `feature-flag:${flagId}`, oldJson, newJson, changedBy, note ?? null);
  } catch { /* non-fatal */ }
}

export function listFlags(): FeatureFlag[] {
  const db = getDashboardDb();
  if (!db) return [];
  const { tenantId } = getCurrentTenantContext();
  const rows = db.query<FlagRow, [string]>(
    "SELECT * FROM feature_flags WHERE tenant_id = ? ORDER BY created_at DESC",
  ).all(tenantId);
  return rows.map(rowToFlag);
}

export function getFlag(id: string): FeatureFlag | null {
  const db = getDashboardDb();
  if (!db) return null;
  const { tenantId } = getCurrentTenantContext();
  const row = db.query<FlagRow, [string, string]>(
    "SELECT * FROM feature_flags WHERE id = ? AND tenant_id = ?",
  ).get(id, tenantId);
  return row ? rowToFlag(row) : null;
}

export function getFlagByKey(key: string): FeatureFlag | null {
  const db = getDashboardDb();
  if (!db) return null;
  const { tenantId } = getCurrentTenantContext();
  const row = db.query<FlagRow, [string, string]>(
    "SELECT * FROM feature_flags WHERE key = ? AND tenant_id = ?",
  ).get(key, tenantId);
  return row ? rowToFlag(row) : null;
}

export function createFlag(input: CreateFlagInput, changedBy = "operator"): FeatureFlag {
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard db not available");
  const { tenantId } = getCurrentTenantContext();
  const id = `ff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const targetingJson = input.targetingJson !== undefined ? JSON.stringify(input.targetingJson) : null;
  const newJson = JSON.stringify({
    key: input.key,
    label: input.label ?? null,
    description: input.description ?? null,
    enabled: input.enabled ? 1 : 0,
    rollout_percentage: input.rolloutPercentage ?? 0,
    targeting_json: targetingJson,
  });
  db.query(
    `INSERT INTO feature_flags
      (id, key, label, description, enabled, rollout_percentage, targeting_json, created_at, updated_at, created_by, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.key,
    input.label ?? null,
    input.description ?? null,
    input.enabled ? 1 : 0,
    input.rolloutPercentage ?? 0,
    targetingJson,
    now,
    now,
    input.createdBy ?? changedBy,
    tenantId,
  );
  writeHistory(id, null, newJson, changedBy, "created");
  const flag = getFlag(id);
  if (!flag) throw new Error("failed to read back created flag");
  return flag;
}

export function updateFlag(id: string, input: UpdateFlagInput, changedBy = "operator"): FeatureFlag | null {
  const db = getDashboardDb();
  if (!db) return null;
  const { tenantId } = getCurrentTenantContext();
  const existing = db.query<FlagRow, [string, string]>(
    "SELECT * FROM feature_flags WHERE id = ? AND tenant_id = ?",
  ).get(id, tenantId);
  if (!existing) return null;
  const oldJson = JSON.stringify(existing);
  const now = Date.now();
  const newEnabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
  const newPct = input.rolloutPercentage !== undefined ? input.rolloutPercentage : existing.rollout_percentage;
  const newTargetingJson = input.targetingJson !== undefined
    ? JSON.stringify(input.targetingJson)
    : existing.targeting_json;
  db.query(
    `UPDATE feature_flags SET
      key = ?, label = ?, description = ?, enabled = ?, rollout_percentage = ?,
      targeting_json = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
  ).run(
    input.key ?? existing.key,
    input.label !== undefined ? input.label : existing.label,
    input.description !== undefined ? input.description : existing.description,
    newEnabled,
    newPct,
    newTargetingJson,
    now,
    id,
    tenantId,
  );
  const updated = getFlag(id);
  if (updated) writeHistory(id, oldJson, JSON.stringify(updated), changedBy, "updated");
  return updated;
}

export function toggleFlag(id: string, enabled: boolean, changedBy = "operator"): FeatureFlag | null {
  const db = getDashboardDb();
  if (!db) return null;
  const { tenantId } = getCurrentTenantContext();
  const existing = db.query<FlagRow, [string, string]>(
    "SELECT * FROM feature_flags WHERE id = ? AND tenant_id = ?",
  ).get(id, tenantId);
  if (!existing) return null;
  const oldJson = JSON.stringify(existing);
  const now = Date.now();
  db.query(
    "UPDATE feature_flags SET enabled = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
  ).run(enabled ? 1 : 0, now, id, tenantId);
  const updated = getFlag(id);
  if (updated) writeHistory(id, oldJson, JSON.stringify(updated), changedBy, enabled ? "enabled" : "disabled");
  return updated;
}

export function deleteFlag(id: string, changedBy = "operator"): boolean {
  const db = getDashboardDb();
  if (!db) return false;
  const { tenantId } = getCurrentTenantContext();
  const existing = db.query<FlagRow, [string, string]>(
    "SELECT * FROM feature_flags WHERE id = ? AND tenant_id = ?",
  ).get(id, tenantId);
  if (!existing) return false;
  const oldJson = JSON.stringify(existing);
  db.query("DELETE FROM feature_flags WHERE id = ? AND tenant_id = ?").run(id, tenantId);
  writeHistory(id, oldJson, "{}", changedBy, "deleted");
  return true;
}

export function getFlagHistory(flagId: string): FeatureFlagHistory[] {
  const db = getDashboardDb();
  if (!db) return [];
  const key = `feature-flag:${flagId}`;
  const rows = db.query<{
    id: number;
    ts: number;
    key: string;
    old_value_json: string | null;
    new_value_json: string;
    changed_by: string;
    note: string | null;
  }, [string]>(
    "SELECT id, ts, key, old_value_json, new_value_json, changed_by, note FROM config_changes WHERE key = ? ORDER BY ts DESC LIMIT 50",
  ).all(key);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    flagId,
    oldValueJson: r.old_value_json,
    newValueJson: r.new_value_json,
    changedBy: r.changed_by,
    note: r.note,
  }));
}

/**
 * Deterministic percentage-bucketing evaluation of a feature flag.
 *
 * The bucket for a given ctx.key is stable: same key always lands in the same
 * bucket, ensuring consistent behaviour across multiple evaluations. Monotonic:
 * raising rolloutPercentage from N to N+1 includes exactly one more bucket.
 */
export function evaluateFlag(flag: FeatureFlag, ctx: { key: string }): boolean {
  if (!flag.enabled) return false;
  if (flag.rolloutPercentage <= 0) return false;
  if (flag.rolloutPercentage >= 100) return true;
  return stableHash(ctx.key) % 100 < flag.rolloutPercentage;
}

/** Non-negative 32-bit integer hash suitable for deterministic bucketing. */
export function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}
