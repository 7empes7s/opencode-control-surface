import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { computeCostHeadline, getAttribution, getCostSummary } from "./cost.ts";

const TEST_DB = "/tmp/test-cost-control-surface.db";

function setupTestDb() {
  rmSync(TEST_DB, { force: true });
  closeDashboardDb();
  return initDashboardDb({ enabled: true, path: TEST_DB })!;
}

function insertGatewayCall(
  ts: number,
  costEstimateUsd: number | null,
  promptTokens: number | null,
  completionTokens: number | null,
) {
  getDashboardDb()!.query(`
    INSERT INTO gateway_calls
      (ts, tenant_id, logical_model, resolved_model, backend, tier,
       prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    ts,
    "mimule",
    "editorial-heavy",
    "test-model",
    "litellm",
    costEstimateUsd === 0 ? "cloud-free" : "cloud-paid",
    promptTokens,
    completionTokens,
    100,
    costEstimateUsd,
  );
}

function insertPaidCatalogEntry(id: string, inputCentsPer1k: number, outputCentsPer1k: number) {
  getDashboardDb()!.query(`
    INSERT INTO provider_price_catalog
      (id, tenant_id, provider, logical_model, tier, input_cents_per_1k, output_cents_per_1k, effective_from)
    VALUES (?, ?, ?, ?, 'cloud-paid', ?, ?, ?)
  `).run(id, "mimule", "openrouter", null, inputCentsPer1k, outputCentsPer1k, 0);
}

describe("getCostSummary", () => {
  const previousDashboardDb = process.env.DASHBOARD_DB;

  beforeEach(() => {
    process.env.DASHBOARD_DB = "1";
    setupTestDb();
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });

    if (previousDashboardDb === undefined) {
      delete process.env.DASHBOARD_DB;
    } else {
      process.env.DASHBOARD_DB = previousDashboardDb;
    }
  });

  it("returns recent cost anomaly detector events", async () => {
    const now = Date.now();
    const db = getDashboardDb();
    expect(db).not.toBeNull();
    db!.query(`
      INSERT INTO events (ts, kind, severity, entity_type, entity_id, summary, payload_json, dedupe_key, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now - 1_000,
      "vast.burn_spike",
      "error",
      "vast",
      "burn_rate",
      "Vast burn spike: $3.00/h vs $1.00/h baseline (3x)",
      JSON.stringify({ currentHourlyRate: 3, baselineHourlyRate: 1, multiplier: 3 }),
      "test-vast-burn-spike",
      "mimule",
    );
    db!.query(`
      INSERT INTO events (ts, kind, severity, entity_type, entity_id, summary, payload_json, dedupe_key, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now - 2_000,
      "infra.disk_pressure",
      "warn",
      "hetzner",
      "disk",
      "Not a cost anomaly",
      JSON.stringify({ diskUsedPct: 86 }),
      "test-disk-pressure",
      "mimule",
    );

    const response = await getCostSummary(new Request("http://127.0.0.1/api/cost/summary"));
    const json = await response.json() as {
      data: { anomalies: Array<{ kind: string; severity: string; entityId: string; payload: { multiplier?: number } }> };
    };

    expect(response.status).toBe(200);
    expect(json.data.anomalies).toHaveLength(1);
    expect(json.data.anomalies[0].kind).toBe("vast.burn_spike");
    expect(json.data.anomalies[0].severity).toBe("error");
    expect(json.data.anomalies[0].entityId).toBe("burn_rate");
    expect(json.data.anomalies[0].payload.multiplier).toBe(3);

  });

  it("includes the CFO headline in the summary payload", async () => {
    insertGatewayCall(Date.now(), 0.25, 100, 50);

    const response = await getCostSummary(new Request("http://127.0.0.1/api/cost/summary"));
    const json = await response.json() as {
      data: { headline: { monthToDateCents: number | null; savedVsPaidBaselineCents: number | null; freeShare: number | null } };
    };

    expect(response.status).toBe(200);
    expect(json.data.headline.monthToDateCents).toBe(25);
    expect(json.data.headline.freeShare).toBe(0);
    expect(json.data.headline.savedVsPaidBaselineCents).toBe(0);
  });
});

describe("computeCostHeadline", () => {
  const previousDashboardDb = process.env.DASHBOARD_DB;

  // Fixed clock: 2026-06-15T12:00:00Z — 14.5 days elapsed in a 30-day month.
  const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
  const MONTH_START = Date.UTC(2026, 5, 1);
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    process.env.DASHBOARD_DB = "1";
    setupTestDb();
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });

    if (previousDashboardDb === undefined) {
      delete process.env.DASHBOARD_DB;
    } else {
      process.env.DASHBOARD_DB = previousDashboardDb;
    }
  });

  it("computes MTD, projection, savings, and free share from seeded ledger rows", () => {
    // Out-of-month row must be excluded.
    insertGatewayCall(MONTH_START - DAY_MS, 5.0, 1000, 1000);
    // Paid call: $0.50.
    insertGatewayCall(MONTH_START + DAY_MS, 0.5, 1000, 500);
    // Two free-routed calls with token counts.
    insertGatewayCall(MONTH_START + 2 * DAY_MS, 0, 2000, 1000);
    insertGatewayCall(MONTH_START + 3 * DAY_MS, 0, 2000, 1000);
    // Baseline = cheapest cloud-paid entry (0.5 + 1.0 beats 2.0 + 4.0).
    insertPaidCatalogEntry("price-cheap", 0.5, 1.0);
    insertPaidCatalogEntry("price-expensive", 2.0, 4.0);

    const headline = computeCostHeadline(NOW);

    expect(headline.monthToDateCents).toBe(50);
    // 50 cents / 14.5 elapsed days * 30 days in month.
    expect(headline.projectedMonthEndCents).toBe(Math.round((50 / 14.5) * 30));
    // 4000 prompt tokens * 0.5¢/1k + 2000 completion tokens * 1.0¢/1k = 4¢.
    expect(headline.savedVsPaidBaselineCents).toBe(4);
    expect(headline.freeShare).toBeCloseTo(2 / 3);
  });

  it("returns all nulls on an empty database", () => {
    const headline = computeCostHeadline(NOW);

    expect(headline.monthToDateCents).toBeNull();
    expect(headline.projectedMonthEndCents).toBeNull();
    expect(headline.savedVsPaidBaselineCents).toBeNull();
    expect(headline.freeShare).toBeNull();
  });

  it("returns null savings when the price catalog has no cloud-paid entry", () => {
    insertGatewayCall(MONTH_START + DAY_MS, 0, 2000, 1000);

    const headline = computeCostHeadline(NOW);

    expect(headline.monthToDateCents).toBe(0);
    expect(headline.freeShare).toBe(1);
    expect(headline.savedVsPaidBaselineCents).toBeNull();
  });

  it("returns null savings when a free call is missing token counts", () => {
    insertGatewayCall(MONTH_START + DAY_MS, 0, 2000, 1000);
    insertGatewayCall(MONTH_START + 2 * DAY_MS, 0, null, null);
    insertPaidCatalogEntry("price-cheap", 0.5, 1.0);

    const headline = computeCostHeadline(NOW);

    expect(headline.freeShare).toBe(1);
    expect(headline.savedVsPaidBaselineCents).toBeNull();
  });

  it("returns null projection when fewer than 2 days of the month have elapsed", () => {
    const earlyNow = Date.UTC(2026, 5, 2, 0, 0, 0);
    insertGatewayCall(MONTH_START + 60 * 60 * 1000, 0.5, 1000, 500);

    const headline = computeCostHeadline(earlyNow);

    expect(headline.monthToDateCents).toBe(50);
    expect(headline.projectedMonthEndCents).toBeNull();
  });
});

// Regression coverage for a bug found while rehearsing the SPEC 6 golden demo
// flow: server/insights/aggregate.ts's aggregateSpendAnomalies() builds evidence
// links of the shape /api/cost/attribution/<scope_type>?entityId=<scope_id>,
// where scope_type is always "workflow" or "project" (the only two scope_type
// values spend_anomalies ever carries — see server/insights/scanners/anomaly.ts
// and server/db/demo-seed.ts). getAttribution's switch previously only handled
// "article" | "dossier" | "builder-run", so every spend-anomaly cost insight's
// evidence link 400'd with "Unsupported entity type" -- a broken link, not a
// demo-only issue (it affects live spend-anomaly insights too).
describe("getAttribution", () => {
  const previousDashboardDb = process.env.DASHBOARD_DB;

  beforeEach(() => {
    process.env.DASHBOARD_DB = "1";
    setupTestDb();
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });

    if (previousDashboardDb === undefined) {
      delete process.env.DASHBOARD_DB;
    } else {
      process.env.DASHBOARD_DB = previousDashboardDb;
    }
  });

  function insertCostEvent(opts: {
    id: string;
    workflowId?: string | null;
    project?: string | null;
    articleSlug?: string | null;
    dossierId?: string | null;
    builderRunId?: string | null;
    costCents: number;
  }) {
    getDashboardDb()!.query(`
      INSERT INTO cost_events
        (id, tenant_id, ts, source, tier, workflow_id, project, article_slug, dossier_id, builder_run_id, cost_cents, cost_basis)
      VALUES (?, 'mimule', ?, 'gateway', 'free', ?, ?, ?, ?, ?, ?, 'provider_free_tier')
    `).run(
      opts.id,
      Date.now(),
      opts.workflowId ?? null,
      opts.project ?? null,
      opts.articleSlug ?? null,
      opts.dossierId ?? null,
      opts.builderRunId ?? null,
      opts.costCents,
    );
  }

  it("resolves workflow-scoped attribution (the shape spend-anomaly evidence links use)", async () => {
    insertCostEvent({ id: "ce-1", workflowId: "demo-wf-agent-team", costCents: 15.38 });
    insertCostEvent({ id: "ce-2", workflowId: "other-workflow", costCents: 99 });

    const req = new Request("http://localhost/api/cost/attribution/workflow?entityId=demo-wf-agent-team");
    const res = await getAttribution(req);
    const body = await res.json() as { entity: { type: string; id: string }; events: unknown[]; totals: { total_cents: number } };

    expect(res.status).toBe(200);
    expect(body.entity).toEqual({ type: "workflow", id: "demo-wf-agent-team" });
    expect(body.events).toHaveLength(1);
    expect(body.totals.total_cents).toBeCloseTo(15.38);
  });

  it("resolves project-scoped attribution", async () => {
    insertCostEvent({ id: "ce-3", project: "insights-inbox", costCents: 5.22 });

    const req = new Request("http://localhost/api/cost/attribution/project?entityId=insights-inbox");
    const res = await getAttribution(req);
    const body = await res.json() as { entity: { type: string; id: string }; events: unknown[] };

    expect(res.status).toBe(200);
    expect(body.entity).toEqual({ type: "project", id: "insights-inbox" });
    expect(body.events).toHaveLength(1);
  });

  it("still resolves the pre-existing article/dossier/builder-run entity types", async () => {
    insertCostEvent({ id: "ce-4", articleSlug: "some-article", costCents: 1 });
    insertCostEvent({ id: "ce-5", dossierId: "some-dossier", costCents: 2 });
    insertCostEvent({ id: "ce-6", builderRunId: "some-run", costCents: 3 });

    for (const [type, id] of [["article", "some-article"], ["dossier", "some-dossier"], ["builder-run", "some-run"]] as const) {
      const res = await getAttribution(new Request(`http://localhost/api/cost/attribution/${type}?entityId=${id}`));
      expect(res.status).toBe(200);
    }
  });

  it("still 400s on a genuinely unsupported entity type", async () => {
    const req = new Request("http://localhost/api/cost/attribution/not-a-real-type?entityId=x");
    const res = await getAttribution(req);
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("Unsupported entity type");
  });
});
