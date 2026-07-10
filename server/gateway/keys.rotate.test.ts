import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { seedDefaultAgents } from "../agents/registry.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { rotateGatewayKeyHandler } from "../api/gatewayKeys.ts";
import {
  createGatewayKey,
  listGatewayKeys,
  revokeGatewayKey,
  rotateGatewayKey,
  verifyGatewayKey,
} from "./keys.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

function withTenant<R>(fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId: "mimule" }), fn);
}

function db() {
  return getDashboardDb()!;
}

function seedAgent(id: string): void {
  db().query(`
    INSERT OR IGNORE INTO agents
      (id, name, kind, owner, purpose, risk_tier, status, model_access, aliases_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, 'runner', 'test', 'test', 'low', 'active', '', '[]', ?, ?, 'mimule')
  `).run(id, id, Date.now(), Date.now());
}

async function rotateViaHandler(id: string, graceSeconds: number) {
  const res = await rotateGatewayKeyHandler(new Request("http://x/api/gateway/keys/" + id + "/rotate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed: true, reason: "test rotation", graceSeconds }),
  }), id);
  const body = await res.json() as { data?: { rotationRevokeAt: number }; error?: string };
  return { status: res.status, body };
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "gateway-key-rotate-test-"));
  mkdirSync(tempDir, { recursive: true });
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  withTenant(() => {
    seedDefaultAgents();
    seedAgent("rotate-agent");
  });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("rotateGatewayKey", () => {
  test("happy path inherits attributes, marks old grace, and both keys verify during grace", () => {
    const created = withTenant(() => createGatewayKey("rotate-agent", "primary", {
      modelAllowlist: ["model-a", "model-b"],
      dailyCapUsd: 2.5,
    }));

    const before = Date.now();
    const rotated = withTenant(() => rotateGatewayKey(created.record.id, { graceSeconds: 120 }));
    const after = Date.now();

    expect(rotated).not.toBeNull();
    expect(rotated!.key).toStartWith("gwk_");
    expect(rotated!.record.agentId).toBe(created.record.agentId);
    expect(rotated!.record.name).toBe(created.record.name);
    expect(rotated!.record.modelAllowlist).toEqual(created.record.modelAllowlist);
    expect(rotated!.record.dailyCapUsd).toBe(created.record.dailyCapUsd);
    expect(rotated!.record.tenantId).toBe(created.record.tenantId);
    expect(rotated!.record.rotatedFromKeyId).toBe(created.record.id);

    const old = withTenant(() => listGatewayKeys().find((key) => key.id === created.record.id))!;
    expect(old.status).toBe("active");
    expect(old.rotationRevokeAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(old.rotationRevokeAt).toBeLessThanOrEqual(after + 120_000);

    expect(withTenant(() => verifyGatewayKey(created.key))?.keyId).toBe(created.record.id);
    expect(withTenant(() => verifyGatewayKey(rotated!.key))?.keyId).toBe(rotated!.record.id);
  });

  test("expired grace makes old key verify null and flips it to revoked while replacement remains valid", () => {
    const created = withTenant(() => createGatewayKey("rotate-agent", "primary"));
    const rotated = withTenant(() => rotateGatewayKey(created.record.id, { graceSeconds: 120 }))!;
    db().query(`UPDATE gateway_keys SET rotation_revoke_at = ? WHERE id = ?`)
      .run(Date.now() - 1_000, created.record.id);

    expect(withTenant(() => verifyGatewayKey(created.key))).toBeNull();
    expect(withTenant(() => verifyGatewayKey(rotated.key))?.keyId).toBe(rotated.record.id);

    const old = db().query(`SELECT status FROM gateway_keys WHERE id = ?`).get(created.record.id) as { status: string };
    expect(old.status).toBe("revoked");
  });

  test("revoked and pending keys cannot rotate", async () => {
    const revoked = withTenant(() => createGatewayKey("rotate-agent", "revoked"));
    withTenant(() => revokeGatewayKey(revoked.record.id));
    expect(withTenant(() => rotateGatewayKey(revoked.record.id))).toBeNull();
    expect((await rotateViaHandler(revoked.record.id, 120)).status).toBe(409);

    const pending = withTenant(() => createGatewayKey("rotate-agent", "pending"));
    expect(withTenant(() => rotateGatewayKey(pending.record.id, { graceSeconds: 120 }))).not.toBeNull();
    expect(withTenant(() => rotateGatewayKey(pending.record.id, { graceSeconds: 120 }))).toBeNull();
    expect((await rotateViaHandler(pending.record.id, 120)).status).toBe(409);
  });

  test("route clamps graceSeconds below and above bounds", async () => {
    const low = withTenant(() => createGatewayKey("rotate-agent", "low clamp"));
    const lowBefore = Date.now();
    const lowRes = await rotateViaHandler(low.record.id, 1);
    const lowAfter = Date.now();
    expect(lowRes.status).toBe(200);
    expect(lowRes.body.data!.rotationRevokeAt).toBeGreaterThanOrEqual(lowBefore + 60_000);
    expect(lowRes.body.data!.rotationRevokeAt).toBeLessThanOrEqual(lowAfter + 60_000);

    const high = withTenant(() => createGatewayKey("rotate-agent", "high clamp"));
    const highBefore = Date.now();
    const highRes = await rotateViaHandler(high.record.id, 999 * 86_400);
    const highAfter = Date.now();
    expect(highRes.status).toBe(200);
    expect(highRes.body.data!.rotationRevokeAt).toBeGreaterThanOrEqual(highBefore + 30 * 86_400_000);
    expect(highRes.body.data!.rotationRevokeAt).toBeLessThanOrEqual(highAfter + 30 * 86_400_000);
  });
});
