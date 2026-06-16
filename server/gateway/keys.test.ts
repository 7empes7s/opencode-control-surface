import "./test-gateway-config.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";
import {
  checkKeyDailySpend,
  createGatewayKey,
  listGatewayKeys,
  revokeGatewayKey,
  verifyGatewayKey,
} from "./keys.ts";
import { v1ChatCompletionsHandler } from "../api/gateway.ts";
import { seedDefaultAgents } from "../agents/registry.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevGatewayConfig: string | undefined;

function withTestTenantContext<R>(context: { tenantId: string }, fn: () => R): R {
  return tenantStore.run(testTenantContext(context), fn);
}

function db() {
  return getDashboardDb()!;
}

function nowMs(): number {
  return Date.now();
}

function seedAgent(id: string): void {
  withTestTenantContext({ tenantId: "mimule" }, () => {
    db().query(`
      INSERT OR IGNORE INTO agents
        (id, name, kind, owner, purpose, risk_tier, status, model_access, aliases_json, created_at, updated_at, tenant_id)
      VALUES (?, ?, 'runner', 'test', 'test', 'low', 'active', '', '[]', ?, ?, 'mimule')
    `).run(id, id, nowMs(), nowMs());
  });
}

function seedGatewayCall(row: { id: number; cost: number; caller: string; ts?: number }): void {
  const ts = row.ts ?? nowMs();
  db().query(`
    INSERT INTO gateway_calls
      (id, ts, tenant_id, logical_model, resolved_model, backend, tier,
       prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success, error_class, trace_id, caller)
    VALUES (?, ?, 'mimule', 'test-model', 'test-resolved', 'litellm', 'cloud-free',
            10, 5, 100, ?, 1, NULL, NULL, ?)
  `).run(row.id, ts, row.cost, row.caller);
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "gateway-keys-test-"));
  mkdirSync(tempDir, { recursive: true });
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevGatewayConfig = process.env.GATEWAY_CONFIG;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  // GATEWAY_CONFIG is set by ./test-gateway-config.ts at import time.

  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });

  withTestTenantContext({ tenantId: "mimule" }, () => {
    seedDefaultAgents();
    seedAgent("test-agent-a");
    seedAgent("test-agent-b");
  });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  if (prevGatewayConfig === undefined) delete process.env.GATEWAY_CONFIG;
  else process.env.GATEWAY_CONFIG = prevGatewayConfig;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createGatewayKey + verifyGatewayKey roundtrip", () => {
  test("create returns a plaintext key starting with gwk_ and a record without a hash", () => {
    const result = withTestTenantContext({ tenantId: "mimule" }, () => {
      return createGatewayKey("test-agent-a", "Agent A primary key");
    });

    expect(result.key.startsWith("gwk_")).toBe(true);
    expect(result.key.length).toBe(4 + 40);
    expect(result.record.agentId).toBe("test-agent-a");
    expect(result.record.name).toBe("Agent A primary key");
    expect(result.record.status).toBe("active");
    expect(result.record.dailyCapUsd).toBeNull();
    expect(result.record.modelAllowlist).toEqual([]);
    expect(result.record.id.length).toBeGreaterThan(0);

    const row = db().query(`SELECT * FROM gateway_keys WHERE id = ?`).get(result.record.id) as { key_hash: string };
    expect(row.key_hash.length).toBe(64);

    const verified = verifyGatewayKey(result.key);
    expect(verified).not.toBeNull();
    expect(verified!.agentId).toBe("test-agent-a");
    expect(verified!.keyId).toBe(result.record.id);
    expect(verified!.modelAllowlist).toEqual([]);
    expect(verified!.dailyCapUsd).toBeNull();
  });

  test("create with allowlist + daily cap persists the values", () => {
    const result = withTestTenantContext({ tenantId: "mimule" }, () => {
      return createGatewayKey("test-agent-a", "scoped key", {
        modelAllowlist: ["test-model", "another-model"],
        dailyCapUsd: 5.25,
      });
    });
    expect(result.record.modelAllowlist).toEqual(["test-model", "another-model"]);
    expect(result.record.dailyCapUsd).toBe(5.25);

    const verified = verifyGatewayKey(result.key);
    expect(verified!.modelAllowlist).toEqual(["test-model", "another-model"]);
    expect(verified!.dailyCapUsd).toBe(5.25);
  });

  test("revoked key verifies to null", () => {
    const result = withTestTenantContext({ tenantId: "mimule" }, () => {
      return createGatewayKey("test-agent-a", "doomed");
    });
    const ok = withTestTenantContext({ tenantId: "mimule" }, () => revokeGatewayKey(result.record.id));
    expect(ok).toBe(true);
    const verified = withTestTenantContext({ tenantId: "mimule" }, () => verifyGatewayKey(result.key));
    expect(verified).toBeNull();
  });

  test("unknown agentId is rejected with a plain-English error", () => {
    expect(() =>
      withTestTenantContext({ tenantId: "mimule" }, () => {
        return createGatewayKey("ghost-agent-does-not-exist", "nope");
      })
    ).toThrow(/is not registered/);
  });

  test("listGatewayKeys returns records without ever exposing the hash", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      createGatewayKey("test-agent-a", "k1");
      createGatewayKey("test-agent-b", "k2");
    });
    const keys = withTestTenantContext({ tenantId: "mimule" }, () => listGatewayKeys());
    expect(keys.length).toBe(2);
    for (const k of keys) {
      expect((k as unknown as { keyHash?: string }).keyHash).toBeUndefined();
      expect((k as unknown as { key_hash?: string }).key_hash).toBeUndefined();
      expect(k.id.length).toBeGreaterThan(0);
    }
  });

  test("verifyGatewayKey returns null for unknown / wrong-prefix / blank input", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      const created = createGatewayKey("test-agent-a", "k");
      expect(verifyGatewayKey("gwk_0000000000000000000000000000000000000000")).toBeNull();
      expect(verifyGatewayKey("not-a-key")).toBeNull();
      expect(verifyGatewayKey("")).toBeNull();
      expect(verifyGatewayKey(created.key + "tamper")).toBeNull();
    });
  });
});

describe("checkKeyDailySpend", () => {
  test("returns allowed=true with zero spend when no calls recorded", () => {
    const result = withTestTenantContext({ tenantId: "mimule" }, () => {
      return checkKeyDailySpend("test-agent-a", 1.0);
    });
    expect(result.allowed).toBe(true);
    expect(result.spentUsd).toBe(0);
  });

  test("returns allowed=false once spend >= cap and sums today's calls", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      seedGatewayCall({ id: 1, cost: 0.4, caller: "test-agent-a" });
      seedGatewayCall({ id: 2, cost: 0.7, caller: "test-agent-a" });
      seedGatewayCall({ id: 3, cost: 0.2, caller: "test-agent-b" });
    });

    const result = withTestTenantContext({ tenantId: "mimule" }, () => {
      return checkKeyDailySpend("test-agent-a", 1.0);
    });
    expect(result.spentUsd).toBeCloseTo(1.1, 6);
    expect(result.allowed).toBe(false);

    const resultOk = withTestTenantContext({ tenantId: "mimule" }, () => {
      return checkKeyDailySpend("test-agent-a", 2.0);
    });
    expect(resultOk.allowed).toBe(true);
  });

  test("ignores calls from other callers", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      seedGatewayCall({ id: 10, cost: 5.0, caller: "test-agent-b" });
    });
    const result = withTestTenantContext({ tenantId: "mimule" }, () => {
      return checkKeyDailySpend("test-agent-a", 1.0);
    });
    expect(result.spentUsd).toBe(0);
    expect(result.allowed).toBe(true);
  });
});

describe("v1ChatCompletionsHandler auth", () => {
  function v1Request(opts: { auth?: string; body: unknown }): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.auth) headers["authorization"] = opts.auth;
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
    });
  }

  test("no auth header → 401 with plain-English message", async () => {
    const res = await v1ChatCompletionsHandler(
      v1Request({ body: { model: "test-model", messages: [{ role: "user", content: "hi" }] } })
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/agent key/);
  });

  test("non-gwk_ Bearer token → 401", async () => {
    const res = await v1ChatCompletionsHandler(
      v1Request({ auth: "Bearer some-other-token", body: { model: "test-model", messages: [{ role: "user", content: "hi" }] } })
    );
    expect(res.status).toBe(401);
  });

  test("invalid gwk_ key → 401", async () => {
    const res = await v1ChatCompletionsHandler(
      v1Request({ auth: "Bearer gwk_deadbeef0000000000000000000000000000beef", body: { model: "test-model", messages: [{ role: "user", content: "hi" }] } })
    );
    expect(res.status).toBe(401);
  });

  test("valid key → 200-path reaches gatewayComplete with caller = agentId (ledger row records caller)", async () => {
    const created = withTestTenantContext({ tenantId: "mimule" }, () => {
      return createGatewayKey("test-agent-a", "live test key");
    });

    const res = await v1ChatCompletionsHandler(
      v1Request({
        auth: `Bearer ${created.key}`,
        body: { model: "test-model", messages: [{ role: "user", content: "ping" }] },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("ok");

    const ledgerRow = db().query(`
      SELECT caller, logical_model FROM gateway_calls
      WHERE tenant_id = 'mimule' AND caller = ?
      ORDER BY id DESC LIMIT 1
    `).get("test-agent-a") as { caller: string; logical_model: string } | null;
    expect(ledgerRow).not.toBeNull();
    expect(ledgerRow!.caller).toBe("test-agent-a");
    expect(ledgerRow!.logical_model).toBe("test-model");
  });

  test("operator token auth → 200-path with caller = operator", async () => {
    const res = await v1ChatCompletionsHandler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-operator-token": "test-token",
        },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "ping" }] }),
      })
    );
    expect(res.status).toBe(200);

    const ledgerRow = db().query(`
      SELECT caller FROM gateway_calls WHERE tenant_id = 'mimule'
      ORDER BY id DESC LIMIT 1
    `).get() as { caller: string };
    expect(ledgerRow.caller).toBe("operator");
  });

  test("allowlist deny → 403 + audit row naming allowed models", async () => {
    const created = withTestTenantContext({ tenantId: "mimule" }, () => {
      return createGatewayKey("test-agent-a", "locked-down", {
        modelAllowlist: ["some-other-model"],
      });
    });

    const res = await v1ChatCompletionsHandler(
      v1Request({
        auth: `Bearer ${created.key}`,
        body: { model: "test-model", messages: [{ role: "user", content: "ping" }] },
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; code: string; allowedModels: string[] };
    expect(body.code).toBe("model_not_allowed");
    expect(body.allowedModels).toEqual(["some-other-model"]);
    expect(body.error).toContain("test-model");
    expect(body.error).toContain("some-other-model");

    const audit = readActionAudit({ targetType: "gateway" });
    expect(audit.some((row) =>
      row.actionKind === "gateway.model-denied"
      && row.targetId === "test-model"
      && row.resultStatus === "blocked"
      && row.actor === "test-agent-a"
    )).toBe(true);
  });

  test("daily cap exceeded → 429 + audit row", async () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      seedGatewayCall({ id: 100, cost: 5.0, caller: "test-agent-a" });
    });
    const created = withTestTenantContext({ tenantId: "mimule" }, () => {
      return createGatewayKey("test-agent-a", "cap-test", { dailyCapUsd: 1.0 });
    });

    const res = await v1ChatCompletionsHandler(
      v1Request({
        auth: `Bearer ${created.key}`,
        body: { model: "test-model", messages: [{ role: "user", content: "ping" }] },
      })
    );
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; code: string; dailyCapUsd: number; spentUsd: number };
    expect(body.code).toBe("daily_cap_exceeded");
    expect(body.dailyCapUsd).toBe(1.0);
    expect(body.spentUsd).toBeCloseTo(5.0, 4);

    const audit = readActionAudit({ targetType: "gateway" });
    expect(audit.some((row) =>
      row.actionKind === "gateway.key-budget-stop"
      && row.targetId === created.record.id
      && row.resultStatus === "blocked"
      && row.actor === "test-agent-a"
    )).toBe(true);
  });
});
