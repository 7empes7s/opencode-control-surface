import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { backfillCostEventsOnce, writeLedgerEntry } from "./ledger.ts";
import { readActionAudit } from "../db/writer.ts";
import { runBudgetScan } from "../insights/scanners/budget.ts";
import { getInsight, listInsights } from "../insights/store.ts";
import { upsertBudget } from "../governance/budgets.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

function withTestTenantContext<R>(context: { tenantId: string }, fn: () => R): R {
  return tenantStore.run(testTenantContext(context), fn);
}

function db() {
  return getDashboardDb()!;
}

function nowMs(): number {
  return Date.now();
}

function seedGatewayCall(row: { id: number; cost: number | null; ts?: number; promptTokens?: number | null; completionTokens?: number | null }): void {
  const ts = row.ts ?? nowMs();
  const promptTokens = row.promptTokens === undefined ? 100 : row.promptTokens;
  const completionTokens = row.completionTokens === undefined ? 50 : row.completionTokens;
  db().query(`
    INSERT INTO gateway_calls
      (id, ts, tenant_id, logical_model, resolved_model, backend, tier,
       prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success, error_class, trace_id, caller)
    VALUES (?, ?, 'mimule', 'test-model', 'test-resolved', 'litellm', 'cloud-free',
            ?, ?, 200, ?, 1, NULL, NULL, 'tester')
  `).run(row.id, ts, promptTokens, completionTokens, row.cost);
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "cost-loop-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  withTestTenantContext({ tenantId: "mimule" }, () => {});
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

describe("writeLedgerEntry cost_events", () => {
  test("writes a free-tier cost_event row with cost_cents 0 when costEstimateUsd is 0", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      writeLedgerEntry({
        logicalModel: "test-model",
        resolvedModel: "test-resolved",
        backend: "litellm",
        tier: "cloud-free",
        promptTokens: 100,
        completionTokens: 50,
        latencyMs: 200,
        costEstimateUsd: 0,
        success: true,
        errorClass: null,
        caller: "tester",
      });
    });

    const rows = db().query(`SELECT cost_cents, cost_basis, source FROM cost_events`).all() as Array<{ cost_cents: number; cost_basis: string; source: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].cost_cents).toBe(0);
    expect(rows[0].cost_basis).toBe("free-tier");
    expect(rows[0].source).toBe("gateway");
  });

  test("writes an unpriced row for null cost with tokens, and a litellm-cost-estimate row for 0.5 — exactly one row each", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      writeLedgerEntry({
        logicalModel: "test-model",
        resolvedModel: "test-resolved",
        backend: "litellm",
        tier: "cloud-free",
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 100,
        costEstimateUsd: null,
        success: true,
        errorClass: null,
        caller: "tester",
      });
    });
    withTestTenantContext({ tenantId: "mimule" }, () => {
      writeLedgerEntry({
        logicalModel: "test-model",
        resolvedModel: "test-resolved",
        backend: "litellm",
        tier: "cloud-paid",
        promptTokens: 1000,
        completionTokens: 500,
        latencyMs: 200,
        costEstimateUsd: 0.5,
        success: true,
        errorClass: null,
        caller: "tester",
      });
    });

    const rows = db().query(`SELECT cost_cents, cost_basis FROM cost_events ORDER BY id ASC`).all() as Array<{ cost_cents: number; cost_basis: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0].cost_cents).toBe(0);
    expect(rows[0].cost_basis).toBe("unpriced");
    expect(rows[1].cost_cents).toBe(50);
    expect(rows[1].cost_basis).toBe("litellm-cost-estimate");
  });
});

describe("backfillCostEventsOnce", () => {
  test("inserts one cost_event per gateway_call, then is a no-op on the second call", () => {
    seedGatewayCall({ id: 1001, cost: 0 });
    seedGatewayCall({ id: 1002, cost: 0.25 });
    seedGatewayCall({ id: 1003, cost: null });

    withTestTenantContext({ tenantId: "mimule" }, () => {
      const inserted1 = backfillCostEventsOnce();
      expect(inserted1).toBe(3);

      const inserted2 = backfillCostEventsOnce();
      expect(inserted2).toBe(0);
    });

    const rows = db().query(`SELECT cost_cents, cost_basis, source FROM cost_events ORDER BY gateway_call_id ASC`).all() as Array<{ cost_cents: number; cost_basis: string; source: string }>;
    expect(rows.length).toBe(3);
    expect(rows[0].cost_cents).toBe(0);
    expect(rows[0].cost_basis).toBe("free-tier");
    expect(rows[1].cost_cents).toBe(25);
    expect(rows[1].cost_basis).toBe("litellm-cost-estimate");
    expect(rows[2].cost_cents).toBe(0);
    expect(rows[2].cost_basis).toBe("unpriced");
    for (const r of rows) expect(r.source).toBe("gateway-backfill");
  });

  test("backfills a row with null cost AND null tokens as unpriced (cost_cents 0)", () => {
    seedGatewayCall({ id: 2001, cost: null, promptTokens: null, completionTokens: null });

    withTestTenantContext({ tenantId: "mimule" }, () => {
      const inserted = backfillCostEventsOnce();
      expect(inserted).toBe(1);
    });

    const rows = db().query(`SELECT cost_cents, cost_basis, source, input_tokens, output_tokens, gateway_call_id FROM cost_events WHERE gateway_call_id = '2001'`).all() as Array<{ cost_cents: number; cost_basis: string; source: string; input_tokens: number | null; output_tokens: number | null; gateway_call_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].cost_cents).toBe(0);
    expect(rows[0].cost_basis).toBe("unpriced");
    expect(rows[0].source).toBe("gateway-backfill");
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].output_tokens).toBeNull();
    expect(rows[0].gateway_call_id).toBe("2001");
  });
});

describe("runBudgetScan", () => {
  test("emits a warn insight at 90% and an exceeded insight with the action descriptor above 100%", () => {
    withTestTenantContext({ tenantId: "mimule" }, () => {
      upsertBudget("global", { dailyCapUsd: 10, warnPct: 0.8 });
    });
    seedGatewayCall({ id: 2001, cost: 4 });
    seedGatewayCall({ id: 2002, cost: 3 });
    seedGatewayCall({ id: 2003, cost: 2 });
    db().query(`UPDATE gateway_calls SET ts = ? WHERE id IN (2001, 2002, 2003)`).run(nowMs());

    let warnInsight;
    withTestTenantContext({ tenantId: "mimule" }, () => {
      const r1 = runBudgetScan();
      warnInsight = r1.findings.find((f) => f.sourceKey === "budget:warn:global");
    });
    expect(warnInsight).toBeDefined();
    expect(warnInsight!.severity).toBe("medium");
    expect(warnInsight!.domain).toBe("cost");
    expect(warnInsight!.manualPageHref).toBe("/gateway");
    expect(warnInsight!.actionDescriptorId).toBeNull();
    expect(warnInsight!.title).toContain("90%");

    seedGatewayCall({ id: 2004, cost: 2 });
    db().query(`UPDATE gateway_calls SET ts = ? WHERE id IN (2001, 2002, 2003, 2004)`).run(nowMs());

    let exceeded;
    let warnStillOpen;
    withTestTenantContext({ tenantId: "mimule" }, () => {
      const r2 = runBudgetScan();
      exceeded = r2.findings.find((f) => f.sourceKey === "budget:exceeded:global");
      warnStillOpen = r2.findings.find((f) => f.sourceKey === "budget:warn:global");
    });
    expect(exceeded).toBeDefined();
    expect(exceeded!.severity).toBe("high");
    expect(exceeded!.domain).toBe("cost");
    expect(exceeded!.manualPageHref).toBe("/gateway");
    expect(exceeded!.actionDescriptorId).toBe("mutate-policy:budget:global:set-cap");
    expect(exceeded!.title).toBe("The global spend cap has been reached");
    expect(warnStillOpen).toBeUndefined();

    const persistedExceeded = getInsight("insight_budget_exceeded_global");
    expect(persistedExceeded).not.toBeNull();
    expect(persistedExceeded!.status).toBe("open");

    db().query(`DELETE FROM gateway_calls WHERE id IN (2001, 2002, 2003, 2004)`).run();

    let resolvedCount = 0;
    withTestTenantContext({ tenantId: "mimule" }, () => {
      const r3 = runBudgetScan();
      resolvedCount = r3.resolvedCount;
    });
    expect(resolvedCount).toBeGreaterThanOrEqual(1);

    const persistedExceededAfter = getInsight("insight_budget_exceeded_global");
    expect(persistedExceededAfter).not.toBeNull();
    expect(persistedExceededAfter!.status).toBe("resolved");

    const openAfter = listInsights("open");
    expect(openAfter.some((i) => i.sourceKey === "budget:exceeded:global")).toBe(false);
    expect(openAfter.some((i) => i.sourceKey === "budget:warn:global")).toBe(false);

    const audit = readActionAudit({ targetType: "insight" });
    expect(audit.some((row) =>
      row.actionKind === "insights.auto-resolve" &&
      row.targetId === "insight_budget_exceeded_global" &&
      row.resultStatus === "success",
    )).toBe(true);
  });

  test("emits nothing and resolves everything in the budget namespace when no budget is configured", () => {
    seedGatewayCall({ id: 3001, cost: 999 });
    withTestTenantContext({ tenantId: "mimule" }, () => {
      const inserted = backfillCostEventsOnce();
      expect(inserted).toBe(1);
      db().query(`INSERT OR REPLACE INTO insights (id, domain, severity, title, plain_summary, confidence, evidence_refs_json, action_descriptor_id, manual_page_href, status, tenant_id, created_at, source_key) VALUES ('insight_budget_exceeded_global', 'cost', 'high', 'The global spend cap has been reached', 'pre', 0.9, '[]', NULL, '/gateway', 'open', 'mimule', ?, 'budget:exceeded:global')`).run(nowMs() - 60_000);
    });

    let result;
    withTestTenantContext({ tenantId: "mimule" }, () => {
      result = runBudgetScan();
    });
    expect(result!.findings).toEqual([]);
    expect(result!.resolvedCount).toBeGreaterThanOrEqual(1);

    const openAfter = listInsights("open");
    expect(openAfter.some((i) => i.sourceKey === "budget:exceeded:global")).toBe(false);
  });
});
