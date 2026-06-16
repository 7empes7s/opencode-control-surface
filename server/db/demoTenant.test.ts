import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "./dashboard.ts";
import { seedDemoTenant, _demoSeedIds, DEMO_TENANT_ID } from "./demoTenant.ts";
import { listInsights } from "../insights/store.ts";
import { withTenantContext, tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { listTenants } from "../tenancy/store.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevDemo: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "demo-tenant-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevDemo = process.env.DEMO_TENANT;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.DEMO_TENANT = "1";
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
  if (prevDemo === undefined) delete process.env.DEMO_TENANT;
  else process.env.DEMO_TENANT = prevDemo;
  rmSync(tempDir, { recursive: true, force: true });
});

function counts() {
  const db = getDashboardDb()!;
  const ids = _demoSeedIds();
  return {
    tenants: (db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM tenants WHERE id = ?").get(DEMO_TENANT_ID)?.c) ?? 0,
    agents: (db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM agents WHERE tenant_id = ?").get(DEMO_TENANT_ID)?.c) ?? 0,
    budgets: (db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM governance_budgets WHERE tenant_id = ?").get(DEMO_TENANT_ID)?.c) ?? 0,
    insights: (db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM insights WHERE tenant_id = ?").get(DEMO_TENANT_ID)?.c) ?? 0,
    gatewayCalls: (db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM gateway_calls WHERE tenant_id = ?").get(DEMO_TENANT_ID)?.c) ?? 0,
    costEvents: (db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM cost_events WHERE tenant_id = ?").get(DEMO_TENANT_ID)?.c) ?? 0,
    audit: (db.query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM action_audit WHERE tenant_id = ?").get(DEMO_TENANT_ID)?.c) ?? 0,
    agentIds: ids.agentIds,
    insightIds: ids.insightIds,
    gatewayCallIds: ids.gatewayCallIds,
    costEventIds: ids.costEventIds,
    auditIds: ids.auditIds,
  };
}

describe("seedDemoTenant", () => {
  test("env gate: does nothing when DEMO_TENANT is not '1'", () => {
    process.env.DEMO_TENANT = "0";
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const c = counts();
    expect(c.tenants).toBe(0);
    expect(c.agents).toBe(0);
    expect(c.insights).toBe(0);
  });

  test("seeds the expected row counts on first run", () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const c = counts();
    expect(c.tenants).toBe(1);
    expect(c.agents).toBe(2);
    expect(c.budgets).toBe(1);
    expect(c.insights).toBe(3);
    expect(c.gatewayCalls).toBe(5);
    expect(c.costEvents).toBe(5);
    expect(c.audit).toBe(2);
  });

  test("is idempotent — running twice keeps the same row counts", () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const first = counts();
    seedDemoTenant(db);
    const second = counts();
    expect(second).toEqual(first);
  });

  test("the tenant appears in listTenants (so the dropdown shows it)", () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const tenants = listTenants();
    const acme = tenants.find((t) => t.id === DEMO_TENANT_ID);
    expect(acme).toBeDefined();
    expect(acme?.name).toBe("Acme Robotics (demo)");
    expect(acme?.status).toBe("active");
  });

  test("mimule tenant is unaffected by the demo seed", () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const tenants = listTenants();
    expect(tenants.find((t) => t.id === "mimule")).toBeDefined();
    expect(tenants.find((t) => t.id === DEMO_TENANT_ID)).toBeDefined();
    const mimule = tenants.find((t) => t.id === "mimule")!;
    expect(mimule.name).toBe("MIMULE");
  });

  test("listInsights under acme-demo context returns exactly the 3 seeded insights", () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const ids = _demoSeedIds();
    let result: ReturnType<typeof listInsights> = [];
    tenantStore.run(testTenantContext({ tenantId: DEMO_TENANT_ID }), () => {
      result = listInsights("all");
    });
    expect(result.length).toBe(3);
    const titles = result.map((r) => r.title).sort();
    expect(titles).toContain("OpenAI mini batch is 38% above the weekly free tier");
    expect(titles).toContain("Two API keys older than 90 days are still active");
    expect(titles).toContain("Builder pass rolled back the rollout page successfully");
    for (const r of result) {
      expect(r.tenant_id).toBe(DEMO_TENANT_ID);
      expect(ids.insightIds).toContain(r.id);
    }
  });

  test("listInsights under mimule context returns no acme-demo rows", () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    let result: ReturnType<typeof listInsights> = [];
    tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => {
      result = listInsights("all");
    });
    expect(result.length).toBe(0);
  });

  test("the seed writes one open cost insight, one resolved security insight, and one applied build insight", () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const db2 = getDashboardDb()!;
    const rows = db2.query<{ id: string; domain: string; status: string }, [string]>(
      `SELECT id, domain, status FROM insights WHERE tenant_id = ?`,
    ).all(DEMO_TENANT_ID);
    const byDomain = new Map(rows.map((r) => [r.domain, r.status]));
    expect(byDomain.get("cost")).toBe("open");
    expect(byDomain.get("security")).toBe("resolved");
    expect(byDomain.get("build")).toBe("applied");
  });

  test("scoped action_audit rows are all under tenant_id = acme-demo", () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const db2 = getDashboardDb()!;
    const rows = db2.query<{ tenant_id: string; count: number }, [string]>(
      `SELECT tenant_id, COUNT(*) as count FROM action_audit WHERE tenant_id = ? GROUP BY tenant_id`,
    ).all(DEMO_TENANT_ID);
    expect(rows.length).toBe(1);
    expect(rows[0]?.count).toBe(2);
  });

  test("withTenantContext middleware still returns only acme-demo rows via the cross-tenant helper", async () => {
    const db = getDashboardDb()!;
    seedDemoTenant(db);
    const req = new Request("http://localhost/api/insights", { headers: { "x-tenant-id": DEMO_TENANT_ID } });
    let result: ReturnType<typeof listInsights> = [];
    await withTenantContext(async () => {
      result = listInsights("all");
      return new Response("ok");
    })(req);
    expect(result.length).toBe(3);
    expect(result.every((r) => r.tenant_id === DEMO_TENANT_ID)).toBe(true);
  });
});
