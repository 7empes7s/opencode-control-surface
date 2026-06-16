import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { writeLedgerEntry } from "../gateway/ledger.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { buildGatewayTraces, gatewayTracesHandler } from "./traces.ts";

function withTestTenantContext<R>(context: { tenantId: string }, fn: () => R): R {
  return tenantStore.run(testTenantContext(context), fn);
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "traces-api-test-"));
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

describe("buildGatewayTraces — grouping math", () => {
  test("groups gateway_calls by trace_id and aggregates totals", () => {
    const now = Date.now();
    // Seed via writeLedgerEntry so we get correct tenant_id handling.
    withTestTenantContext({ tenantId: "mimule" }, () => {
      // Trace A: 3 successful calls, 100 + 200 + 50 = 350 latency, 10+20+5 + 5+10+2 = 52 tokens
      writeLedgerEntry({
        logicalModel: "model-a", resolvedModel: "resolved-a", backend: "litellm", tier: "local",
        promptTokens: 10, completionTokens: 5, latencyMs: 100, costEstimateUsd: 0,
        success: true, errorClass: null, traceId: "trace-A", caller: "caller-x",
      });
      writeLedgerEntry({
        logicalModel: "model-a", resolvedModel: "resolved-b", backend: "litellm", tier: "local",
        promptTokens: 20, completionTokens: 10, latencyMs: 200, costEstimateUsd: 0,
        success: true, errorClass: null, traceId: "trace-A", caller: "caller-x",
      });
      writeLedgerEntry({
        logicalModel: "model-c", resolvedModel: "resolved-c", backend: "litellm", tier: "local",
        promptTokens: 5, completionTokens: 2, latencyMs: 50, costEstimateUsd: 0,
        success: true, errorClass: null, traceId: "trace-A", caller: "caller-x",
      });
      // Trace B: 2 calls, 1 failed (300 + 120 = 420 latency; 5+5 + 0 = 15 tokens)
      writeLedgerEntry({
        logicalModel: "model-d", resolvedModel: "resolved-d", backend: "litellm", tier: "local",
        promptTokens: 5, completionTokens: 5, latencyMs: 300, costEstimateUsd: 0,
        success: true, errorClass: null, traceId: "trace-B", caller: "caller-y",
      });
      writeLedgerEntry({
        logicalModel: "model-d", resolvedModel: "resolved-d", backend: "litellm", tier: "local",
        promptTokens: null, completionTokens: null, latencyMs: 120, costEstimateUsd: null,
        success: false, errorClass: "rate_limit", traceId: "trace-B", caller: "caller-y",
      });
      // Trace C: 1 single call (no trace_id, so its own group), caller = "lone"
      writeLedgerEntry({
        logicalModel: "model-l", resolvedModel: "resolved-l", backend: "litellm", tier: "local",
        promptTokens: 7, completionTokens: 3, latencyMs: 75, costEstimateUsd: 0,
        success: true, errorClass: null, traceId: null, caller: "lone",
      });
    });

    // Force all rows to fall inside the default 7d window. writeLedgerEntry uses Date.now() internally
    // so the rows are already recent. Build with the default sinceTs (7d ago).
    const result = withTestTenantContext({ tenantId: "mimule" }, () => buildGatewayTraces());

    expect(result.degraded).toBe(false);
    expect(result.traces.length).toBe(3);

    // Find each trace by id (null for the lone one).
    const traceA = result.traces.find((t) => t.traceId === "trace-A");
    const traceB = result.traces.find((t) => t.traceId === "trace-B");
    const traceC = result.traces.find((t) => t.traceId === null);

    expect(traceA).toBeDefined();
    expect(traceA!.calls.length).toBe(3);
    expect(traceA!.totalLatencyMs).toBe(350);
    expect(traceA!.totalTokens).toBe(52);
    expect(traceA!.caller).toBe("caller-x");
    // Each call carries the per-call latency + tokens used by the UI.
    for (const c of traceA!.calls) {
      expect(typeof c.ts).toBe("number");
      expect(typeof c.latencyMs).toBe("number");
      expect(typeof c.tokens).toBe("number");
      expect(typeof c.success).toBe("boolean");
    }

    expect(traceB).toBeDefined();
    expect(traceB!.calls.length).toBe(2);
    expect(traceB!.totalLatencyMs).toBe(420);
    expect(traceB!.totalTokens).toBe(10); // 5+5 from success; 0+0 from failed (nulls)
    // The failure has errorClass set; the success has null.
    const failedCall = traceB!.calls.find((c) => !c.success);
    expect(failedCall).toBeDefined();
    expect(failedCall!.errorClass).toBe("rate_limit");
    expect(failedCall!.tokens).toBe(0);
    const successCall = traceB!.calls.find((c) => c.success);
    expect(successCall!.errorClass).toBeNull();

    expect(traceC).toBeDefined();
    expect(traceC!.calls.length).toBe(1);
    expect(traceC!.totalLatencyMs).toBe(75);
    expect(traceC!.totalTokens).toBe(10);
    expect(traceC!.caller).toBe("lone");

    // Latest-first ordering: trace C (single) has its own row's ts; we just verify
    // the sort is non-increasing by the latest call ts.
    let prevLatest = Number.POSITIVE_INFINITY;
    for (const t of result.traces) {
      const latest = t.calls.reduce((m, c) => Math.max(m, c.ts), 0);
      expect(latest).toBeLessThanOrEqual(prevLatest);
      prevLatest = latest;
    }
  });

  test("multiple untraced calls become multiple single-call groups", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      for (let i = 0; i < 5; i += 1) {
        writeLedgerEntry({
          logicalModel: `model-u-${i}`, resolvedModel: "res", backend: "litellm", tier: "local",
          promptTokens: 1, completionTokens: 1, latencyMs: 10 + i, costEstimateUsd: 0,
          success: true, errorClass: null, traceId: null, caller: `caller-${i}`,
        });
      }
    });

    const result = withTestTenantContext({ tenantId: "mimule" }, () => buildGatewayTraces({ limit: 50 }));
    const untraced = result.traces.filter((t) => t.traceId === null);
    expect(untraced.length).toBe(5);
    for (const t of untraced) {
      expect(t.calls.length).toBe(1);
      expect(t.totalLatencyMs).toBe(t.calls[0].latencyMs);
    }
  });

  test("respects the limit and sinceTs window", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      for (let i = 0; i < 10; i += 1) {
        writeLedgerEntry({
          logicalModel: "model-l", resolvedModel: "res", backend: "litellm", tier: "local",
          promptTokens: 1, completionTokens: 1, latencyMs: 1, costEstimateUsd: 0,
          success: true, errorClass: null, traceId: `trace-${i}`, caller: "c",
        });
      }
    });

    const limited = withTestTenantContext({ tenantId: "mimule" }, () => buildGatewayTraces({ limit: 3 }));
    expect(limited.traces.length).toBe(3);

    // sinceTs in the future => no rows in window
    const empty = withTestTenantContext({ tenantId: "mimule" }, () =>
      buildGatewayTraces({ sinceTs: Date.now() + 60_000 }),
    );
    expect(empty.traces.length).toBe(0);
    expect(empty.total).toBe(0);
  });

  test("degrades gracefully when DB is disabled", () => {
    closeDashboardDb();
    process.env.DASHBOARD_DB = "0";
    const result = buildGatewayTraces();
    expect(result.degraded).toBe(true);
    expect(result.traces.length).toBe(0);
    expect(result.reason).toContain("DASHBOARD_DB");
  });
});

describe("gatewayTracesHandler", () => {
  test("requires the operator token", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    const url = new URL("http://localhost/api/traces/gateway");
    const res = await gatewayTracesHandler(new Request("http://localhost/api/traces/gateway"), url);
    expect(res.status).toBe(401);
  });

  test("returns envelope and reads seeded rows", async () => {
    process.env.OPERATOR_TOKEN = "test-token";
    withTestTenantContext({ tenantId: "mimule" }, () => {
      writeLedgerEntry({
        logicalModel: "model-h", resolvedModel: "res-h", backend: "litellm", tier: "local",
        promptTokens: 3, completionTokens: 4, latencyMs: 50, costEstimateUsd: 0,
        success: true, errorClass: null, traceId: "trace-handler", caller: "handler-caller",
      });
    });

    const req = new Request("http://localhost/api/traces/gateway", {
      headers: { "x-operator-token": "test-token" },
    });
    const res = await gatewayTracesHandler(req, new URL("http://localhost/api/traces/gateway"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { traces: Array<{ traceId: string | null; totalTokens: number }>; degraded: boolean } };
    expect(body.data.degraded).toBe(false);
    const trace = body.data.traces.find((t) => t.traceId === "trace-handler");
    expect(trace).toBeDefined();
    expect(trace!.totalTokens).toBe(7);

    // ensure the DB row was persisted (sanity check the test setup)
    const rowCount = getDashboardDb()!.query("SELECT COUNT(*) as cnt FROM gateway_calls").get() as { cnt: number };
    expect(rowCount.cnt).toBeGreaterThan(0);
  });
});
