import { createHash, randomBytes } from "node:crypto";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { getAgent } from "../agents/registry.ts";

export const GATEWAY_KEY_PREFIX = "gwk_";
const GATEWAY_KEY_RANDOM_BYTES = 20;
const LAST_USED_THROTTLE_MS = 60_000;

export type GatewayKeyStatus = "active" | "revoked";

export type GatewayKeyRecord = {
  id: string;
  agentId: string;
  name: string;
  modelAllowlist: string[];
  dailyCapUsd: number | null;
  status: GatewayKeyStatus;
  createdAt: number;
  lastUsedAt: number | null;
  tenantId: string | null;
};

type GatewayKeyRow = {
  id: string;
  agent_id: string;
  name: string;
  key_hash: string;
  model_allowlist: string;
  daily_cap_usd: number | null;
  status: GatewayKeyStatus;
  created_at: number;
  last_used_at: number | null;
  tenant_id: string | null;
};

function newKeyId(): string {
  return `gk_${randomBytes(8).toString("hex")}`;
}

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generatePlaintext(): string {
  return GATEWAY_KEY_PREFIX + randomBytes(GATEWAY_KEY_RANDOM_BYTES).toString("hex");
}

function parseAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function rowToRecord(row: GatewayKeyRow): GatewayKeyRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    modelAllowlist: parseAllowlist(row.model_allowlist),
    dailyCapUsd: row.daily_cap_usd,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    tenantId: row.tenant_id,
  };
}

function startOfUtcDayMs(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export type CreateGatewayKeyOptions = {
  modelAllowlist?: string[];
  dailyCapUsd?: number;
};

export type CreatedGatewayKey = { key: string; record: GatewayKeyRecord };

export function createGatewayKey(
  agentId: string,
  name: string,
  opts: CreateGatewayKeyOptions = {},
): CreatedGatewayKey {
  if (!isDashboardDbEnabled()) {
    throw new Error("Gateway keys require the dashboard database to be enabled.");
  }
  const db = getDashboardDb();
  if (!db) {
    throw new Error("Gateway keys require the dashboard database to be enabled.");
  }
  if (!agentId || typeof agentId !== "string") {
    throw new Error("agentId is required to create a gateway key.");
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error("name is required to create a gateway key.");
  }

  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" is not registered. Register it before issuing a key.`);
  }

  const tenantId = getCurrentTenantContext().tenantId;
  const now = Date.now();
  const id = newKeyId();
  const plaintext = generatePlaintext();
  const keyHash = hashKey(plaintext);
  const allowlist = Array.isArray(opts.modelAllowlist)
    ? opts.modelAllowlist.map((m) => m.trim()).filter(Boolean).join(",")
    : "";
  const dailyCapUsd = typeof opts.dailyCapUsd === "number" && Number.isFinite(opts.dailyCapUsd)
    ? opts.dailyCapUsd
    : null;

  db.query(`
    INSERT INTO gateway_keys
      (id, agent_id, name, key_hash, model_allowlist, daily_cap_usd, status, created_at, last_used_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)
  `).run(id, agentId, name.trim(), keyHash, allowlist, dailyCapUsd, now, tenantId);

  const row = db.query(`SELECT * FROM gateway_keys WHERE id = ?`).get(id) as GatewayKeyRow;
  return { key: plaintext, record: rowToRecord(row) };
}

export type VerifiedGatewayKey = {
  agentId: string;
  keyId: string;
  modelAllowlist: string[];
  dailyCapUsd: number | null;
};

export function verifyGatewayKey(plaintext: string): VerifiedGatewayKey | null {
  if (!isDashboardDbEnabled()) return null;
  const db = getDashboardDb();
  if (!db) return null;
  if (!plaintext || typeof plaintext !== "string" || !plaintext.startsWith(GATEWAY_KEY_PREFIX)) {
    return null;
  }

  const keyHash = hashKey(plaintext);
  const row = db.query(`
    SELECT * FROM gateway_keys WHERE key_hash = ? AND status = 'active'
  `).get(keyHash) as GatewayKeyRow | null;
  if (!row) return null;

  const now = Date.now();
  if (row.last_used_at == null || now - row.last_used_at >= LAST_USED_THROTTLE_MS) {
    try {
      db.query(`UPDATE gateway_keys SET last_used_at = ? WHERE id = ?`).run(now, row.id);
    } catch {
      /* best-effort: throttle write failure should not break verification */
    }
  }

  return {
    agentId: row.agent_id,
    keyId: row.id,
    modelAllowlist: parseAllowlist(row.model_allowlist),
    dailyCapUsd: row.daily_cap_usd,
  };
}

export function listGatewayKeys(): GatewayKeyRecord[] {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant();
  const rows = db.query(`
    SELECT * FROM gateway_keys WHERE 1=1 ${tenant.clause}
    ORDER BY created_at DESC
  `).all(...tenant.params) as GatewayKeyRow[];
  return rows.map(rowToRecord);
}

export function revokeGatewayKey(id: string): boolean {
  if (!isDashboardDbEnabled()) return false;
  const db = getDashboardDb();
  if (!db) return false;
  if (!id) return false;
  const tenant = whereTenant();
  const result = db.query(`
    UPDATE gateway_keys SET status = 'revoked'
    WHERE id = ? ${tenant.clause}
  `).run(id, ...tenant.params);
  return result.changes > 0;
}

export type KeyDailySpendCheck = { allowed: boolean; spentUsd: number };

export function checkKeyDailySpend(
  agentId: string,
  dailyCapUsd: number,
): KeyDailySpendCheck {
  if (!isDashboardDbEnabled()) return { allowed: true, spentUsd: 0 };
  const db = getDashboardDb();
  if (!db) return { allowed: true, spentUsd: 0 };
  if (agentId == null || typeof dailyCapUsd !== "number" || !Number.isFinite(dailyCapUsd)) {
    return { allowed: true, spentUsd: 0 };
  }

  const dayStart = startOfUtcDayMs();
  const tenant = whereTenant();

  const row = db.query(`
    SELECT COALESCE(SUM(cost_estimate_usd), 0) AS total
    FROM gateway_calls
    WHERE caller = ? AND ts >= ? ${tenant.clause}
  `).get(agentId, dayStart, ...tenant.params) as { total: number | null } | null;

  const spentUsd = Number(row?.total ?? 0);
  return { allowed: spentUsd < dailyCapUsd, spentUsd };
}
