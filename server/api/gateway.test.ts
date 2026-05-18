import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { gatewayLedgerHandler, gatewayStatsHandler } from "./gateway.ts";
import { writeLedgerEntry } from "../gateway/ledger.ts";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "gateway-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
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
