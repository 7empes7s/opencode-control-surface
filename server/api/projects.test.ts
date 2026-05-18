import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  projectsListHandler,
  projectsCreateHandler,
  projectGetHandler,
  projectPatchHandler,
  projectDeleteHandler,
  projectsDetectHandler,
} from "./projects.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "projects-api-"));
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

function authedReq(method = "GET", url = "http://localhost/api/projects", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "x-operator-token": "test-token", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const sampleProject = {
  id: "test-proj",
  tenantId: "mimule",
  name: "Test Project",
  repoPath: "/tmp/test-proj",
  language: "typescript",
  framework: "bun",
  validatorCommands: ["bun test"],
  defaultModelRoster: [],
  defaultPolicies: {},
  status: "active",
};

describe("POST + GET /api/projects CRUD round-trip", () => {
  test("creates and retrieves a project", async () => {
    const createRes = await projectsCreateHandler(authedReq("POST", "http://localhost/api/projects", sampleProject));
    expect(createRes.status).toBe(201);

    const getRes = projectGetHandler(authedReq(), "test-proj");
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { project: { id: string; language: string } };
    expect(body.project.id).toBe("test-proj");
    expect(body.project.language).toBe("typescript");
  });

  test("lists projects for a tenant", async () => {
    await projectsCreateHandler(authedReq("POST", "http://localhost/api/projects", sampleProject));
    const listRes = projectsListHandler(authedReq("GET", "http://localhost/api/projects?tenantId=mimule"), new URL("http://localhost/api/projects?tenantId=mimule"));
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as { projects: unknown[] };
    expect(body.projects.length).toBeGreaterThanOrEqual(1);
  });

  test("returns 200 with tenant defaulted from context when tenantId param absent", () => {
    const res = projectsListHandler(authedReq("GET", "http://localhost/api/projects"), new URL("http://localhost/api/projects"));
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/projects/:id", () => {
  test("updates project config", async () => {
    await projectsCreateHandler(authedReq("POST", "http://localhost/api/projects", sampleProject));
    const patchReq = authedReq("PATCH", "http://localhost/api/projects/test-proj", { name: "Renamed" });
    const res = await projectPatchHandler(patchReq, "test-proj");
    expect(res.status).toBe(200);
    const body = await res.json() as { project: { name: string } };
    expect(body.project.name).toBe("Renamed");
  });

  test("returns 404 for missing project", async () => {
    const res = await projectPatchHandler(authedReq("PATCH", "http://localhost/api/projects/nope", { name: "x" }), "nope");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/:id", () => {
  test("soft-deletes a project", async () => {
    await projectsCreateHandler(authedReq("POST", "http://localhost/api/projects", sampleProject));
    const delRes = projectDeleteHandler(authedReq("DELETE"), "test-proj");
    expect(delRes.status).toBe(200);
    // After delete, list should not include it
    const listRes = projectsListHandler(authedReq("GET", "http://localhost/api/projects?tenantId=mimule"), new URL("http://localhost/api/projects?tenantId=mimule"));
    const body = await listRes.json() as { projects: Array<{ id: string }> };
    expect(body.projects.find((p) => p.id === "test-proj")).toBeUndefined();
  });
});

describe("POST /api/projects/detect", () => {
  test("detects language for a real repo", async () => {
    const req = authedReq("POST", "http://localhost/api/projects/detect", { repoPath: "/opt/opencode-control-surface" });
    const res = await projectsDetectHandler(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { detected: { language: string } };
    expect(body.detected.language).toBe("typescript");
  });

  test("returns 400 when repoPath missing", async () => {
    const req = authedReq("POST", "http://localhost/api/projects/detect", {});
    const res = await projectsDetectHandler(req);
    expect(res.status).toBe(400);
  });
});
