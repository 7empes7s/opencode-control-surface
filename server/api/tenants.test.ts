import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  tenantsListHandler,
  tenantsCreateHandler,
  tenantGetHandler,
  tenantPatchHandler,
} from "./tenants.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "tenants-api-"));
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

function authedReq(method = "GET", body?: unknown): Request {
  return new Request("http://localhost/api/tenants", {
    method,
    headers: { "x-operator-token": "test-token", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/tenants", () => {
  test("returns list of tenants", async () => {
    const res = tenantsListHandler(authedReq());
    expect(res.status).toBe(200);
    const body = await res.json() as { tenants: unknown[] };
    expect(Array.isArray(body.tenants)).toBe(true);
  });

  test("returns 401 without token", async () => {
    const req = new Request("http://localhost/api/tenants");
    const res = tenantsListHandler(req);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/tenants", () => {
  test("creates a new tenant", async () => {
    const res = await tenantsCreateHandler(authedReq("POST", { id: "acme", name: "Acme Corp" }));
    expect(res.status).toBe(201);
    const body = await res.json() as { tenant: { id: string; name: string } };
    expect(body.tenant.id).toBe("acme");
    expect(body.tenant.name).toBe("Acme Corp");
  });

  test("returns 400 when id is missing", async () => {
    const res = await tenantsCreateHandler(authedReq("POST", { name: "Acme Corp" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tenants/:id", () => {
  test("returns tenant with project count", async () => {
    await tenantsCreateHandler(authedReq("POST", { id: "tenant1", name: "Tenant One" }));
    const res = tenantGetHandler(authedReq(), "tenant1");
    expect(res.status).toBe(200);
    const body = await res.json() as { tenant: { id: string }; projectCount: number };
    expect(body.tenant.id).toBe("tenant1");
    expect(typeof body.projectCount).toBe("number");
  });

  test("returns 404 for missing tenant", async () => {
    const res = tenantGetHandler(authedReq(), "nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/tenants/:id", () => {
  test("updates tenant name and status", async () => {
    await tenantsCreateHandler(authedReq("POST", { id: "patchable", name: "Old Name" }));
    const req = new Request("http://localhost/api/tenants/patchable", {
      method: "PATCH",
      headers: { "x-operator-token": "test-token", "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name", status: "inactive" }),
    });
    const res = await tenantPatchHandler(req, "patchable");
    expect(res.status).toBe(200);
    const body = await res.json() as { tenant: { name: string; status: string } };
    expect(body.tenant.name).toBe("New Name");
    expect(body.tenant.status).toBe("inactive");
  });

  test("returns 404 for missing tenant", async () => {
    const req = new Request("http://localhost/api/tenants/none", {
      method: "PATCH",
      headers: { "x-operator-token": "test-token", "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    const res = await tenantPatchHandler(req, "none");
    expect(res.status).toBe(404);
  });
});
