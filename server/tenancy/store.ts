import { getDashboardDb } from "../db/dashboard.ts";
import { DEFAULT_TENANT_ID } from "./context.ts";

export type Tenant = {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

type TenantRow = {
  id: string;
  name: string;
  status: string;
  created_at: number;
  updated_at: number;
};

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertTenant(id: string, name: string, status: string): Tenant {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB unavailable");
  const now = Date.now();
  db.query(
    `INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, updated_at = excluded.updated_at`
  ).run(id, name, status, now, now);
  return getTenant(id)!;
}

export function getTenant(id: string): Tenant | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query<TenantRow, [string]>(
    "SELECT id, name, status, created_at, updated_at FROM tenants WHERE id = ?"
  ).get(id);
  return row ? rowToTenant(row) : null;
}

export function listTenants(): Tenant[] {
  const db = getDashboardDb();
  if (!db) return [];
  return db.query<TenantRow, []>(
    "SELECT id, name, status, created_at, updated_at FROM tenants ORDER BY created_at ASC"
  ).all().map(rowToTenant);
}

export function seedDefaultTenant(): void {
  const db = getDashboardDb();
  if (!db) return;
  const now = Date.now();
  db.query(
    `INSERT OR IGNORE INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(DEFAULT_TENANT_ID, "MIMULE / TechInsiderBytes", "active", now, now);
}
