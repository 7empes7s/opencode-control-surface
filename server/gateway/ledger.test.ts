import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { writeLedgerEntry, readLedger, ledgerStats } from "./ledger.ts";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";

// Helper function to run code with a specific tenant context
function withTestTenantContext<R>(context: { tenantId: string }, fn: () => R): R {
  return tenantStore.run(testTenantContext(context), fn);
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "gateway-ledger-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

// Test data
const entry1 = {
  logicalModel: "test-model-1",
  resolvedModel: "resolved-1",
  backend: "test-backend",
  tier: "local" as const,
  promptTokens: 100,
  completionTokens: 50,
  latencyMs: 1000,
  costEstimateUsd: 0.001,
  success: true,
  errorClass: null,
  traceId: "trace-1",
  caller: "test-1",
};

const entry2 = {
  logicalModel: "test-model-2",
  resolvedModel: "resolved-2",
  backend: "test-backend",
  tier: "cloud-paid" as const,
  promptTokens: 200,
  completionTokens: 100,
  latencyMs: 2000,
  costEstimateUsd: 0.002,
  success: false,
  errorClass: "timeout",
  traceId: "trace-2",
  caller: "test-2",
};

test("tenant A can only see its own entries", () => {
  // Write entries for tenant A
  withTestTenantContext({ tenantId: "tenant-a" }, () => {
    writeLedgerEntry(entry1);
    writeLedgerEntry(entry2);
  });

  // Write entry for tenant B
  withTestTenantContext({ tenantId: "tenant-b" }, () => {
    writeLedgerEntry(entry1);
  });

  // Tenant A should only see its own entries
  const tenantAEntries = withTestTenantContext({ tenantId: "tenant-a" }, () => readLedger());
  expect(tenantAEntries.length).toBe(2);
  expect(tenantAEntries[0].logical_model).toBe("test-model-2");
  expect(tenantAEntries[1].logical_model).toBe("test-model-1");

  // Tenant B should only see its own entries
  const tenantBEntries = withTestTenantContext({ tenantId: "tenant-b" }, () => readLedger());
  expect(tenantBEntries.length).toBe(1);
  expect(tenantBEntries[0].logical_model).toBe("test-model-1");
});

test("ledger stats are scoped by tenant", () => {
  // Write entries for tenant A
  withTestTenantContext({ tenantId: "tenant-a" }, () => {
    writeLedgerEntry(entry1);
    writeLedgerEntry(entry2);
  });

  // Write entry for tenant B
  withTestTenantContext({ tenantId: "tenant-b" }, () => {
    writeLedgerEntry(entry1);
  });

  // Get stats for tenant A
  const tenantAStats = withTestTenantContext({ tenantId: "tenant-a" }, () => ledgerStats());
  expect(tenantAStats.totalCalls).toBe(2);
  expect(tenantAStats.byModel["test-model-1"]?.calls).toBe(1);
  expect(tenantAStats.byModel["test-model-2"]?.calls).toBe(1);

  // Get stats for tenant B
  const tenantBStats = withTestTenantContext({ tenantId: "tenant-b" }, () => ledgerStats());
  expect(tenantBStats.totalCalls).toBe(1);
  expect(tenantBStats.byModel["test-model-1"]?.calls).toBe(1);
  expect(tenantBStats.byModel["test-model-2"]?.calls).toBe(undefined);
});