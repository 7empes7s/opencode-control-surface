import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { withTenantContext, getCurrentTenantContext } from "./middleware.ts";
import { readBuilderWorkflows } from "../builder/store.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "middleware-test-"));
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

describe("withTenantContext", () => {
  test("request with no tenant header resolves to mimule", async () => {
    let capturedTenantId = "";
    const handler = withTenantContext(async (_req: Request) => {
      capturedTenantId = getCurrentTenantContext().tenantId;
      return new Response("ok");
    });
    await handler(new Request("http://localhost/api/test"));
    expect(capturedTenantId).toBe("mimule");
  });

  test("request with X-Tenant-Id header resolves to that tenant", async () => {
    let capturedTenantId = "";
    const handler = withTenantContext(async (_req: Request) => {
      capturedTenantId = getCurrentTenantContext().tenantId;
      return new Response("ok");
    });
    await handler(new Request("http://localhost/api/test", {
      headers: { "x-tenant-id": "acme" },
    }));
    expect(capturedTenantId).toBe("acme");
  });

  test("outside a withTenantContext call, getCurrentTenantContext returns default", () => {
    const ctx = getCurrentTenantContext();
    expect(ctx.tenantId).toBe("mimule");
  });
});

describe("readBuilderWorkflows tenant filtering", () => {
  test("filters workflows by tenant_id, falls back to NULL rows", async () => {
    const db = getDashboardDb()!;
    const now = Date.now();
    // Insert workflows for two different tenants directly
    const ins = `INSERT INTO builder_workflows (id, project_id, plan_file, config_json, name, mode, status, created_at, updated_at, tenant_id)
      VALUES (?, 'proj', '', '{}', ?, 'once', 'draft', ?, ?, ?)`;
    db.run(ins, ["wf-mimule", "mimule wf", now, now, "mimule"]);
    db.run(ins, ["wf-acme", "acme wf", now, now, "acme"]);
    // Legacy row with NULL tenant_id
    const insLegacy = `INSERT INTO builder_workflows (id, project_id, plan_file, config_json, name, mode, status, created_at, updated_at)
      VALUES (?, 'proj', '', '{}', 'legacy wf', 'once', 'draft', ?, ?)`;
    db.run(insLegacy, ["wf-legacy", now, now]);

    // As mimule tenant: should see wf-mimule and wf-legacy (NULL), not wf-acme
    let workflows: ReturnType<typeof readBuilderWorkflows> = [];
    const mimuleHandler = withTenantContext(async (_req: Request) => {
      workflows = readBuilderWorkflows();
      return new Response("ok");
    });
    await mimuleHandler(new Request("http://localhost/"));
    const ids = workflows.map((w) => w.id);
    expect(ids).toContain("wf-mimule");
    expect(ids).toContain("wf-legacy");
    expect(ids).not.toContain("wf-acme");

    // As acme tenant: should see wf-acme and wf-legacy (NULL), not wf-mimule
    let acmeWorkflows: ReturnType<typeof readBuilderWorkflows> = [];
    const acmeHandler = withTenantContext(async (_req: Request) => {
      acmeWorkflows = readBuilderWorkflows();
      return new Response("ok");
    });
    await acmeHandler(new Request("http://localhost/", { headers: { "x-tenant-id": "acme" } }));
    const acmeIds = acmeWorkflows.map((w) => w.id);
    expect(acmeIds).toContain("wf-acme");
    expect(acmeIds).toContain("wf-legacy");
    expect(acmeIds).not.toContain("wf-mimule");
  });
});
