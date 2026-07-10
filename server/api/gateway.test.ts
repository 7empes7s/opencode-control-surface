import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { handleApi } from "./router.ts";
import {
  gatewayLedgerHandler,
  gatewayStatsHandler,
  gatewayShowbackHandler,
  gatewayStatusHandler,
  selectHealthiestGatewayModel,
} from "./gateway.ts";
import { writeLedgerEntry } from "../gateway/ledger.ts";
import {
  clearGatewayRouteOverrideForGatewayAdmin,
  getGatewayRouteOverrideForGatewayAdmin,
  getGatewayRoutePlanForGatewayAdmin,
  resetGatewayRouteOverrideStateForTests,
  setCircuitStateForGatewayAdmin,
  setGatewayRouteOverrideForGatewayAdmin,
} from "../gateway/router.ts";
import { _resetGatewayConfigCacheForTests } from "../gateway/config.ts";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevOperatorToken: string | undefined;
let prevGatewayConfig: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "gateway-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevOperatorToken = process.env.OPERATOR_TOKEN;
  prevGatewayConfig = process.env.GATEWAY_CONFIG;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.GATEWAY_CONFIG = join(tempDir, "gateway.yaml");
  writeFileSync(process.env.GATEWAY_CONFIG, `
version: 1
litellm_url: http://127.0.0.1:4000
models:
  editorial-heavy:
    backend: litellm
    model: editorial-heavy
    tier: local
  editorial-fast:
    backend: litellm
    model: editorial-fast
    tier: local
`);
  _resetGatewayConfigCacheForTests();
  resetGatewayRouteOverrideStateForTests();
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
  clearGatewayRouteOverrideForGatewayAdmin();
  setCircuitStateForGatewayAdmin("model-open", "closed");
  setCircuitStateForGatewayAdmin("model-action", "closed");
  setCircuitStateForGatewayAdmin("opencode/nemotron-3-ultra-free", "closed");
  setCircuitStateForGatewayAdmin("openrouter/nvidia/nemotron-3-nano-30b-a3b:free", "closed");
});

afterEach(() => {
  clearGatewayRouteOverrideForGatewayAdmin();
  resetGatewayRouteOverrideStateForTests();
  setCircuitStateForGatewayAdmin("model-open", "closed");
  setCircuitStateForGatewayAdmin("model-action", "closed");
  setCircuitStateForGatewayAdmin("opencode/nemotron-3-ultra-free", "closed");
  setCircuitStateForGatewayAdmin("openrouter/nvidia/nemotron-3-nano-30b-a3b:free", "closed");
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevOperatorToken;
  if (prevGatewayConfig === undefined) delete process.env.GATEWAY_CONFIG;
  else process.env.GATEWAY_CONFIG = prevGatewayConfig;
  _resetGatewayConfigCacheForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

const entryA = {
  logicalModel: "model-a",
  resolvedModel: "resolved-a",
  backend: "test",
  tier: "local" as const,
  promptTokens: 10,
  completionTokens: 5,
  latencyMs: 100,
  costEstimateUsd: 0.001,
  success: true,
  errorClass: null,
  traceId: "t1",
  caller: "c1",
};

const entryB = {
  logicalModel: "model-b",
  resolvedModel: "resolved-b",
  backend: "test",
  tier: "cloud-free" as const,
  promptTokens: 20,
  completionTokens: 10,
  latencyMs: 200,
  costEstimateUsd: 0.002,
  success: false,
  errorClass: "timeout",
  traceId: "t2",
  caller: "c2",
};

describe("gateway API tenant isolation", () => {
  test("ledger only returns entries for current tenant", async () => {
    withTenant("tenant-a", () => {
      writeLedgerEntry(entryA);
    });
    withTenant("tenant-b", () => {
      writeLedgerEntry(entryB);
    });

    const resA = withTenant("tenant-a", () => gatewayLedgerHandler(new URL("http://localhost/api/gateway/ledger")));
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { data: { rows: Array<{ logical_model: string }> } };
    expect(bodyA.data.rows.length).toBe(1);
    expect(bodyA.data.rows[0].logical_model).toBe("model-a");

    const resB = withTenant("tenant-b", () => gatewayLedgerHandler(new URL("http://localhost/api/gateway/ledger")));
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { data: { rows: Array<{ logical_model: string }> } };
    expect(bodyB.data.rows.length).toBe(1);
    expect(bodyB.data.rows[0].logical_model).toBe("model-b");
  });

  test("stats only include calls for current tenant", async () => {
    withTenant("tenant-a", () => {
      writeLedgerEntry(entryA);
    });
    withTenant("tenant-b", () => {
      writeLedgerEntry(entryB);
    });

    const resA = withTenant("tenant-a", () => gatewayStatsHandler(new URL("http://localhost/api/gateway/stats")));
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { data: { totalCalls: number } };
    expect(bodyA.data.totalCalls).toBe(1);

    const resB = withTenant("tenant-b", () => gatewayStatsHandler(new URL("http://localhost/api/gateway/stats")));
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { data: { totalCalls: number } };
    expect(bodyB.data.totalCalls).toBe(1);
  });
});

describe("gateway admin API", () => {
  test("status includes last-updated and healthy recommendation metadata", async () => {
    const res = gatewayStatusHandler();
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { lastUpdatedAt: string; degraded: boolean; recommendations: unknown[]; routeOverride: unknown | null; modelCount: number; models: string[] } };
    expect(Date.parse(body.data.lastUpdatedAt)).toBeGreaterThan(0);
    expect(typeof body.data.degraded).toBe("boolean");
    expect(Array.isArray(body.data.recommendations)).toBe(true);
    expect(body.data.routeOverride).toBeNull();
    expect(body.data.models.length).toBe(body.data.modelCount);
    expect(body.data.models.length).toBeGreaterThan(0);
  });

  test("status reports open circuit, high error rate, and high latency recommendations", async () => {
    setCircuitStateForGatewayAdmin("model-open", "open");
    writeLedgerEntry({ ...entryA, logicalModel: "slow-model", resolvedModel: "slow-model", latencyMs: 12_000, success: false, errorClass: "timeout" });
    writeLedgerEntry({ ...entryA, logicalModel: "slow-model", resolvedModel: "slow-model", latencyMs: 13_000, success: false, errorClass: "timeout" });
    writeLedgerEntry({ ...entryA, logicalModel: "slow-model", resolvedModel: "slow-model", latencyMs: 11_000, success: true, errorClass: null });

    const res = gatewayStatusHandler();
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { degraded: boolean; recommendations: Array<{ kind: string }> } };
    expect(body.data.degraded).toBe(true);
    expect(body.data.recommendations.map((r) => r.kind)).toContain("open_circuit");
    expect(body.data.recommendations.map((r) => r.kind)).toContain("high_error_rate");
    expect(body.data.recommendations.map((r) => r.kind)).toContain("high_latency");
  });

  test("unauthenticated POST actions are rejected", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const req = new Request("http://localhost/api/gateway/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-action" }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(401);
  });

  test("authenticated reset and half-open circuit actions write audit rows", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    setCircuitStateForGatewayAdmin("model-action", "open");

    for (const action of ["reset", "half-open"] as const) {
      const req = new Request(`http://localhost/api/gateway/circuits/model-action/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-operator-token": "test-token",
          "x-actor": "test-operator",
        },
        body: JSON.stringify({ reason: `${action} test` }),
      });
      const res = await handleApi(req, new URL(req.url));
      expect(res.status).toBe(200);
    }

    const audit = readActionAudit({ targetType: "gateway" });
    expect(audit.some((row) => row.actionKind === "gateway.circuit.reset" && row.targetId === "model-action" && row.resultStatus === "success")).toBe(true);
    expect(audit.some((row) => row.actionKind === "gateway.circuit.half-open" && row.targetId === "model-action" && row.resultStatus === "success")).toBe(true);
  });

  test("probe action returns structured failure", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("synthetic probe failure"))) as unknown as typeof fetch;
    try {
      const req = new Request("http://localhost/api/gateway/probe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-token": "test-token" },
        body: JSON.stringify({ model: "missing-probe-model", reason: "test probe" }),
      });
      const res = await handleApi(req, new URL(req.url));
      expect(res.status).toBe(502);
      const body = await res.json() as { data: { ok: boolean; model: string; error: string; latencyMs: number } };
      expect(body.data.ok).toBe(false);
      expect(body.data.model).toBe("missing-probe-model");
      expect(body.data.error).toContain("synthetic probe failure");
      expect(body.data.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("authenticated route-healthiest action sets an audited route override used by future chains", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const req = new Request("http://localhost/api/gateway/route-healthiest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-token": "test-token",
        "x-actor": "test-operator",
      },
      body: JSON.stringify({ reason: "prefer free cloud route", ttlMs: 120_000 }),
    });

    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { selected: { logicalName: string }; routeOverride: { targetModel: string; expiresAt: string } } };
    expect(body.data.routeOverride.targetModel).toBe(body.data.selected.logicalName);
    expect(Date.parse(body.data.routeOverride.expiresAt)).toBeGreaterThan(Date.now());

    const override = getGatewayRouteOverrideForGatewayAdmin();
    expect(override?.targetModel).toBe(body.data.selected.logicalName);
    expect(getGatewayRoutePlanForGatewayAdmin("editorial-heavy")[0]).toBe(body.data.selected.logicalName);

    const audit = readActionAudit({ targetType: "gateway" });
    expect(audit.some((row) => row.actionKind === "gateway.route-healthiest" && row.targetId === body.data.selected.logicalName && row.resultStatus === "success")).toBe(true);
  });

  test("route override pin validates confirmation, reason, and configured model before auditing success", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const request = (body: Record<string, unknown>) => {
      const req = new Request("http://localhost/api/gateway/route-override", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-operator-token": "test-token",
          "x-tenant-id": "mimule",
          "x-actor": "pin-test-operator",
        },
        body: JSON.stringify(body),
      });
      return handleApi(req, new URL(req.url));
    };

    const unconfirmed = await request({ model: "editorial-heavy", reason: "test pin" });
    expect(unconfirmed.status).toBe(400);

    const noReason = await request({ model: "editorial-heavy", confirmed: true });
    expect(noReason.status).toBe(400);

    const unknown = await request({ model: "definitely-unknown-model", confirmed: true, reason: "test pin" });
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json() as { error: string };
    expect(unknownBody.error).toContain("not found");

    const startedAt = Date.now();
    const success = await request({ model: "editorial-heavy", confirmed: true, reason: "prefer local tonight" });
    expect(success.status).toBe(200);
    const successBody = await success.json() as {
      data: { ok: boolean; routeOverride: { targetModel: string; setBy: string; expiresAt: string }; message: string };
    };
    expect(successBody.data.ok).toBe(true);
    expect(successBody.data.routeOverride.targetModel).toBe("editorial-heavy");
    expect(successBody.data.routeOverride.setBy).toBe("pin-test-operator");
    expect(Date.parse(successBody.data.routeOverride.expiresAt) - startedAt).toBeGreaterThanOrEqual(14_400_000);
    expect(successBody.data.message).toContain("Pinned gateway routing to editorial-heavy until");

    const audit = readActionAudit({ targetType: "gateway", actionKind: "gateway.route-override-set" });
    expect(audit.some((row) => row.targetId === "editorial-heavy" && row.risk === "low" && row.resultStatus === "success")).toBe(true);
  });

  test("route override DELETE returns 404 when empty and clears an active override with an audit", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const request = (reason?: string) => {
      const req = new Request("http://localhost/api/gateway/route-override", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-operator-token": "test-token",
          "x-tenant-id": "mimule",
          "x-actor": "clear-test-operator",
        },
        body: JSON.stringify({ reason }),
      });
      return handleApi(req, new URL(req.url));
    };

    expect((await request()).status).toBe(404);

    setGatewayRouteOverrideForGatewayAdmin({
      targetModel: "editorial-heavy",
      resolvedModel: "editorial-heavy",
      tier: "local",
      reason: "temporary pin",
    });
    const cleared = await request("resume normal routing");
    expect(cleared.status).toBe(200);
    const body = await cleared.json() as { data: { ok: boolean; message: string } };
    expect(body.data.ok).toBe(true);
    expect(body.data.message).toContain("editorial-heavy");
    expect(getGatewayRouteOverrideForGatewayAdmin()).toBeNull();

    const audit = readActionAudit({ targetType: "gateway", actionKind: "gateway.route-override-cleared" });
    expect(audit.some((row) => row.targetId === "editorial-heavy" && row.risk === "low" && row.resultStatus === "success")).toBe(true);
  });

  test("healthiest routing prefers healthy free cloud routes before paid fallback", () => {
    for (let i = 0; i < 3; i += 1) {
      writeLedgerEntry({
        ...entryB,
        logicalModel: "opencode/nemotron-3-ultra-free",
        resolvedModel: "opencode/nemotron-3-ultra-free",
        tier: "cloud-free",
        success: false,
        latencyMs: 900,
        errorClass: "rate_limit",
      });
    }

    const selected = selectHealthiestGatewayModel();
    expect(selected?.logicalName).toBe("openrouter/nvidia/nemotron-3-nano-30b-a3b:free");
    expect(selected?.isFree).toBe(true);
    expect(selected?.isCloud).toBe(true);
  });
});

describe("gateway cost headline", () => {
  test("status includes cost headline with correct math", async () => {
    const now = Date.now();
    // 3 calls: 2 free (0 cost), 1 paid (1.234 cost)
    withTenant("tenant-cost-test", () => {
      writeLedgerEntry({
        logicalModel: "model-free-1",
        resolvedModel: "resolved-free-1",
        backend: "test",
        tier: "cloud-free",
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 100,
        costEstimateUsd: 0,
        success: true,
        errorClass: null,
      });
      writeLedgerEntry({
        logicalModel: "model-free-2",
        resolvedModel: "resolved-free-2",
        backend: "test",
        tier: "cloud-free",
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 100,
        costEstimateUsd: null,
        success: true,
        errorClass: null,
      });
      writeLedgerEntry({
        logicalModel: "model-paid-1",
        resolvedModel: "resolved-paid-1",
        backend: "test",
        tier: "cloud-paid",
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 100,
        costEstimateUsd: 1.234,
        success: true,
        errorClass: null,
      });
    });

    const res = withTenant("tenant-cost-test", () => gatewayStatusHandler());
    expect(res.status).toBe(200);
    const raw = await res.json() as { data: { costHeadline: { totalCalls: number; freeSharePct: number; estimatedSpendUsd: number; headline: string } } };
    const data = raw.data.costHeadline;

    expect(data.totalCalls).toBe(3);
    expect(data.freeSharePct).toBe(67); // 2/3 = 66.66... rounded
    expect(data.estimatedSpendUsd).toBe(1.23); // 1.234 rounded to 2 decimals
    expect(data.headline).toContain("67% of the last 3 model calls");
    expect(data.headline).toContain("$1.23");
  });

  test("status returns zeros when no calls exist", async () => {
    const res = withTenant("tenant-empty", () => gatewayStatusHandler());
    expect(res.status).toBe(200);
    const raw = await res.json() as { data: { costHeadline: { totalCalls: number; headline: string } } };
    const data = raw.data.costHeadline;

    expect(data.totalCalls).toBe(0);
    expect(data.headline).toContain("warming up");
  });
});

describe("gateway showback", () => {
  test("group sums match seeded gateway_calls and cost_events", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const seededTenant = "tenant-showback";
    withTenant(seededTenant, () => {
      writeLedgerEntry({
        ...entryA,
        logicalModel: "showback-model-a",
        resolvedModel: "showback-model-a",
        promptTokens: 1000,
        completionTokens: 500,
        costEstimateUsd: 0.05,
        caller: "alpha",
      });
      writeLedgerEntry({
        ...entryA,
        logicalModel: "showback-model-a",
        resolvedModel: "showback-model-a",
        promptTokens: 2000,
        completionTokens: 1000,
        costEstimateUsd: 0.10,
        caller: "alpha",
      });
      writeLedgerEntry({
        ...entryA,
        logicalModel: "showback-model-b",
        resolvedModel: "showback-model-b",
        promptTokens: 500,
        completionTokens: 250,
        costEstimateUsd: 0,
        caller: "beta",
      });
    });

    const req = new Request("http://localhost/api/gateway/showback", {
      headers: { "x-operator-token": "test-token" },
    });
    const res = withTenant(seededTenant, () => gatewayShowbackHandler(req));
    expect(res.status).toBe(200);
    const raw = await res.json() as {
      data: {
        window: string;
        byModel: Array<{ model: string; calls: number; costUsd: number }>;
        byCaller: Array<{ caller: string; calls: number; costUsd: number }>;
        byBasis: Array<{ basis: string; events: number; costUsd: number }>;
        totalCostUsd: number;
        totalEvents: number;
        counterfactual: { availableTokens: boolean; estimatedPaidUsd: number | null; explanation: string; tier?: string };
      };
    };
    const data = raw.data;

    expect(data.window).toBe("30d");
    expect(data.totalEvents).toBe(3);
    expect(data.totalCostUsd).toBeCloseTo(0.15, 2);

    const a = data.byModel.find((row) => row.model === "showback-model-a");
    const b = data.byModel.find((row) => row.model === "showback-model-b");
    expect(a).toBeDefined();
    expect(a?.calls).toBe(2);
    expect(a?.costUsd).toBeCloseTo(0.15, 2);
    expect(b).toBeDefined();
    expect(b?.calls).toBe(1);
    expect(b?.costUsd).toBe(0);

    const alpha = data.byCaller.find((row) => row.caller === "alpha");
    const beta = data.byCaller.find((row) => row.caller === "beta");
    expect(alpha?.calls).toBe(2);
    expect(alpha?.costUsd).toBeCloseTo(0.15, 2);
    expect(beta?.calls).toBe(1);
    expect(beta?.costUsd).toBe(0);

    const total = data.byBasis.reduce((acc, row) => acc + row.events, 0);
    expect(total).toBe(3);
    expect(data.byBasis.length).toBeGreaterThan(0);

    expect(data.counterfactual.availableTokens).toBe(true);
    expect(data.counterfactual.estimatedPaidUsd).not.toBeNull();
    expect(data.counterfactual.estimatedPaidUsd!).toBeGreaterThan(0);
    expect(data.counterfactual.explanation).toContain("token volumes");
  });

  test("empty DB returns zeros, counterfactual availableTokens false, 200", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const req = new Request("http://localhost/api/gateway/showback", {
      headers: { "x-operator-token": "test-token" },
    });
    const res = withTenant("tenant-showback-empty", () => gatewayShowbackHandler(req));
    expect(res.status).toBe(200);
    const raw = await res.json() as {
      data: {
        byModel: unknown[];
        byCaller: unknown[];
        byBasis: unknown[];
        totalCostUsd: number;
        totalEvents: number;
        counterfactual: { availableTokens: boolean; estimatedPaidUsd: number | null; explanation: string };
      };
    };
    const data = raw.data;

    expect(data.byModel).toEqual([]);
    expect(data.byCaller).toEqual([]);
    expect(data.byBasis).toEqual([]);
    expect(data.totalCostUsd).toBe(0);
    expect(data.totalEvents).toBe(0);
    expect(data.counterfactual.availableTokens).toBe(false);
    expect(data.counterfactual.estimatedPaidUsd).toBeNull();
    expect(data.counterfactual.explanation).toContain("Not enough token data");
  });

  test("unauthenticated request returns 401", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const req = new Request("http://localhost/api/gateway/showback");
    const res = withTenant("tenant-showback-401", () => gatewayShowbackHandler(req));
    expect(res.status).toBe(401);
    const raw = await res.json() as { error: string };
    expect(raw.error).toBe("unauthorized");

    const routeRes = await handleApi(req, new URL(req.url));
    expect(routeRes.status).toBe(401);
  });
});
