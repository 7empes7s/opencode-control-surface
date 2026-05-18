import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getDashboardDb, isDashboardDbEnabled } from "../dashboard.ts";
import { getCurrentTenantContext } from "../../tenancy/middleware.ts";
import type { TenantContext } from "../../tenancy/context.ts";

const AUDIT_ANCHOR_DIR = "/opt/ai-vault/audit";
const GENESIS = "genesis";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function requireDb(): Database {
  if (!isDashboardDbEnabled()) throw new Error("dashboard DB disabled");
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard DB not initialized");
  return db;
}

function tenantClause(ctx?: TenantContext, alias?: string): string {
  const tenantId = (ctx ?? getCurrentTenantContext()).tenantId;
  const prefix = alias ? `${alias}.` : "";
  if (tenantId === "mimule") {
    return ` AND (${prefix}tenant_id = 'mimule' OR ${prefix}tenant_id IS NULL)`;
  }
  return ` AND ${prefix}tenant_id = ?`;
}

function tenantParam(ctx?: TenantContext): string[] {
  const tenantId = (ctx ?? getCurrentTenantContext()).tenantId;
  if (tenantId === "mimule") return [];
  return [tenantId];
}

export function getChainHead(
  db?: Database,
  ctx?: TenantContext,
): { rowHash: string; ts: number; rowId: number } | null {
  const d = db ?? getDashboardDb();
  if (!d) return null;
  try {
    const clause = tenantClause(ctx);
    const params = tenantParam(ctx);
    const row = d.query(
      `SELECT id, ts, row_hash FROM action_audit WHERE row_hash IS NOT NULL${clause} ORDER BY id DESC LIMIT 1`
    ).get(...params) as { id: number; ts: number; row_hash: string } | null;
    if (!row) return null;
    return { rowId: row.id, ts: row.ts, rowHash: row.row_hash };
  } catch {
    return null;
  }
}

export function appendAudit(
  db: Database,
  row: Record<string, unknown>,
  ctx?: TenantContext,
): void {
  const head = getChainHead(db, ctx);
  const prevHash = head?.rowHash ?? GENESIS;
  const rowHash = sha256(prevHash + JSON.stringify(row));
  const clause = tenantClause(ctx);
  const params = tenantParam(ctx);

  try {
    db.query(
      `UPDATE action_audit SET prev_hash = ?, row_hash = ? WHERE id = (SELECT MAX(id) FROM action_audit WHERE row_hash IS NULL${clause})`
    ).run(prevHash, rowHash, ...params);
  } catch {
    // non-fatal: chain integrity writes should never block the audit write
  }
}

export function verifyChain(
  db?: Database,
  limit = 1000,
  ctx?: TenantContext,
): { ok: boolean; firstBadId?: number; checkedCount: number } {
  const d = db ?? requireDb();
  const clause = tenantClause(ctx);
  const params = tenantParam(ctx);
  const rows = d.query(
    `SELECT id, prev_hash, row_hash FROM action_audit WHERE row_hash IS NOT NULL${clause} ORDER BY id ASC LIMIT ?`
  ).all(...params, limit) as Array<{ id: number; prev_hash: string | null; row_hash: string }>;

  if (rows.length === 0) return { ok: true, checkedCount: 0 };

  let expectedPrev = GENESIS;
  for (const row of rows) {
    const prevOk = (row.prev_hash ?? GENESIS) === expectedPrev;
    if (!prevOk) return { ok: false, firstBadId: row.id, checkedCount: rows.indexOf(row) };
    expectedPrev = row.row_hash;
  }
  return { ok: true, checkedCount: rows.length };
}

export function anchorChain(db?: Database, date?: string, ctx?: TenantContext): void {
  const d = db ?? getDashboardDb();
  if (!d) return;
  const head = getChainHead(d, ctx);
  if (!head) return;
  const anchorDate = date ?? new Date().toISOString().slice(0, 10);
  const clause = tenantClause(ctx);
  const params = tenantParam(ctx);
  const rowCount = (d.query(`SELECT COUNT(*) as c FROM action_audit WHERE row_hash IS NOT NULL${clause}`).get(...params) as { c: number } | null)?.c ?? 0;
  const anchor = { headHash: head.rowHash, rowCount, date: anchorDate, ts: Date.now() };
  try {
    mkdirSync(AUDIT_ANCHOR_DIR, { recursive: true });
    writeFileSync(`${AUDIT_ANCHOR_DIR}/${anchorDate}-anchor.json`, JSON.stringify(anchor, null, 2), "utf8");
  } catch {
    // non-fatal
  }
}
