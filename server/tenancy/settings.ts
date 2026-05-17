import { getDashboardDb } from "../db/dashboard.ts";
import { mkdirSync } from "fs";

export type TenantSettings = {
  tenantId: string;
  dataResidencyRegion: string;
  storageRoot: string;
  auditRetentionDays: number;
  requireTwoApprovers: boolean;
  ssoRequired: boolean;
  updatedAt: number;
};

export function getDefaultStorageRoot(tenantId: string): string {
  return process.env.STORAGE_ROOT
    ? `${process.env.STORAGE_ROOT}/${tenantId}`
    : `/var/lib/control-surface/tenants/${tenantId}`;
}

export function getTenantSettings(tenantId: string): TenantSettings {
  const db = getDashboardDb();
  if (!db) return defaultSettings(tenantId);
  const row = db.prepare("SELECT * FROM tenant_settings WHERE tenant_id = ?").get(tenantId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return defaultSettings(tenantId);
  return rowToSettings(row);
}

export function updateTenantSettings(
  tenantId: string,
  patch: Partial<TenantSettings>,
): TenantSettings {
  const db = getDashboardDb();
  if (!db) throw new Error("DB unavailable");
  const current = getTenantSettings(tenantId);
  const next: TenantSettings = { ...current, ...patch, tenantId, updatedAt: Date.now() };
  db.prepare(
    `
    INSERT INTO tenant_settings (tenant_id, data_residency_region, storage_root, audit_retention_days, require_two_approvers, sso_required, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      data_residency_region=excluded.data_residency_region,
      storage_root=excluded.storage_root,
      audit_retention_days=excluded.audit_retention_days,
      require_two_approvers=excluded.require_two_approvers,
      sso_required=excluded.sso_required,
      updated_at=excluded.updated_at
  `,
  ).run(
    next.tenantId,
    next.dataResidencyRegion,
    next.storageRoot,
    next.auditRetentionDays,
    next.requireTwoApprovers ? 1 : 0,
    next.ssoRequired ? 1 : 0,
    next.updatedAt,
  );
  mkdirSync(next.storageRoot, { recursive: true });
  return next;
}

function defaultSettings(tenantId: string): TenantSettings {
  return {
    tenantId,
    dataResidencyRegion: "auto",
    storageRoot: getDefaultStorageRoot(tenantId),
    auditRetentionDays: 90,
    requireTwoApprovers: false,
    ssoRequired: false,
    updatedAt: 0,
  };
}

function rowToSettings(row: Record<string, unknown>): TenantSettings {
  return {
    tenantId: String(row.tenant_id),
    dataResidencyRegion: String(row.data_residency_region ?? "auto"),
    storageRoot: String(row.storage_root ?? getDefaultStorageRoot(String(row.tenant_id))),
    auditRetentionDays: Number(row.audit_retention_days ?? 90),
    requireTwoApprovers: Boolean(row.require_two_approvers),
    ssoRequired: Boolean(row.sso_required),
    updatedAt: Number(row.updated_at ?? 0),
  };
}