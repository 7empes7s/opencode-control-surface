import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { upsertTenant } from "./store.ts";
import { upsertProject } from "../projects/index.ts";
import { readBuilderWorkflows } from "../builder/store.ts";
import { withTenantContext } from "./middleware.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "isolation-test-"));
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

function seedTenantsAndProjects() {
  const db = getDashboardDb()!;
  const now = Date.now();
  for (const id of ["t-alpha", "t-beta", "t-gamma"]) {
    upsertTenant(id, `Tenant ${id}`, "active");
    for (let i = 1; i <= 2; i++) {
      upsertProject({
        id: `${id}-proj-${i}`,
        tenantId: id,
        name: `${id} Project ${i}`,
        repoPath: `/tmp/${id}/proj-${i}`,
        language: "typescript",
        framework: "bun",
        validatorCommands: [],
        defaultModelRoster: [],
        defaultPolicies: {},
        status: "active",
      });
    }
    // Insert a builder_workflow directly to avoid project allowlist check
    db.query(
      `INSERT INTO builder_workflows (id, project_id, tenant_id, name, mode, status, plan_file, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'one-shot', 'draft', '', '{}', ?, ?)`
    ).run(`wf-${id}`, `${id}-proj-1`, id, `workflow-${id}`, now, now);
  }
}

function reqFor(tenantId: string): Request {
  return new Request("http://localhost/api/builder/workflows", {
    headers: { "x-tenant-id": tenantId },
  });
}

describe("cross-tenant workflow isolation", () => {
  test("querying workflows for t-alpha returns only t-alpha rows", async () => {
    seedTenantsAndProjects();

    let alphaWfs: ReturnType<typeof readBuilderWorkflows> = [];
    await withTenantContext(async (_req: Request) => {
      alphaWfs = readBuilderWorkflows();
      return new Response("ok");
    })(reqFor("t-alpha"));

    expect(alphaWfs.every((w) => w.tenantId === "t-alpha")).toBe(true);
    expect(alphaWfs.some((w) => w.tenantId === "t-beta")).toBe(false);
    expect(alphaWfs.some((w) => w.tenantId === "t-gamma")).toBe(false);
  });

  test("querying workflows for t-beta returns only t-beta rows, not t-alpha or t-gamma", async () => {
    seedTenantsAndProjects();

    let betaWfs: ReturnType<typeof readBuilderWorkflows> = [];
    await withTenantContext(async (_req: Request) => {
      betaWfs = readBuilderWorkflows();
      return new Response("ok");
    })(reqFor("t-beta"));

    expect(betaWfs.every((w) => w.tenantId === "t-beta")).toBe(true);
    expect(betaWfs.some((w) => w.tenantId === "t-alpha")).toBe(false);
    expect(betaWfs.some((w) => w.tenantId === "t-gamma")).toBe(false);
  });

  test("a tenant with no workflows returns empty array, not an error", async () => {
    // Only seed t-alpha and t-beta workflows, not t-gamma
    const db = getDashboardDb()!;
    const now = Date.now();
    for (const id of ["t-alpha", "t-beta", "t-gamma"]) {
      upsertTenant(id, `Tenant ${id}`, "active");
    }
    for (const id of ["t-alpha", "t-beta"]) {
      db.query(
        `INSERT INTO builder_workflows (id, project_id, tenant_id, name, mode, status, plan_file, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'one-shot', 'draft', '', '{}', ?, ?)`
      ).run(`wf-${id}`, "proj", id, `workflow-${id}`, now, now);
    }

    let gammaWfs: ReturnType<typeof readBuilderWorkflows> = [];
    await withTenantContext(async (_req: Request) => {
      gammaWfs = readBuilderWorkflows();
      return new Response("ok");
    })(reqFor("t-gamma"));

    expect(gammaWfs).toEqual([]);
  });

  test("a non-existent tenant returns empty array, not an error", async () => {
    seedTenantsAndProjects();

    let unknownWfs: ReturnType<typeof readBuilderWorkflows> = [];
    await withTenantContext(async (_req: Request) => {
      unknownWfs = readBuilderWorkflows();
      return new Response("ok");
    })(reqFor("t-unknown"));

    expect(unknownWfs).toEqual([]);
  });
});

describe("cross-tenant action_audit isolation", () => {
  test("audit rows for t-beta are not visible under t-alpha query", () => {
    seedTenantsAndProjects();
    const db = getDashboardDb()!;
    const now = Date.now();

    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id) VALUES (?, ?, ?, ?)`
    ).run(now, "system", "workflow.create", "t-beta");

    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id) VALUES (?, ?, ?, ?)`
    ).run(now, "system", "workflow.create", "t-alpha");

    type AuditRow = { tenant_id: string };
    const betaRows = db.query(`SELECT tenant_id FROM action_audit WHERE tenant_id = ?`).all("t-beta") as AuditRow[];
    const alphaRows = db.query(`SELECT tenant_id FROM action_audit WHERE tenant_id = ?`).all("t-alpha") as AuditRow[];

    expect(betaRows.length).toBeGreaterThan(0);
    expect(betaRows.every((r) => r.tenant_id === "t-beta")).toBe(true);
    expect(alphaRows.every((r) => r.tenant_id === "t-alpha")).toBe(true);
    expect(betaRows.some((r) => r.tenant_id === "t-alpha")).toBe(false);
    expect(alphaRows.some((r) => r.tenant_id === "t-beta")).toBe(false);
  });

  test("audit query for non-existent tenant returns empty array", () => {
    seedTenantsAndProjects();
    const db = getDashboardDb()!;

    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id) VALUES (?, ?, ?, ?)`
    ).run(Date.now(), "system", "workflow.create", "t-alpha");

    const unknownRows = db.query(`SELECT tenant_id FROM action_audit WHERE tenant_id = ?`).all("t-nonexistent") as unknown[];
    expect(unknownRows).toEqual([]);
  });
});
