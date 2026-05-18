import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb, getDashboardDb } from "./dashboard.ts";
import {
  createJob,
  finishJob,
  readJob,
  readJobs,
  readActionAudit,
  writeActionAudit,
  readOperatorState,
  writeOperatorState,
  updateJobOutput,
  type JobRow,
  type ActionAuditRow,
} from "./writer.ts";
import { withTenantContext } from "../tenancy/middleware.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "writer-test-"));
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

function reqFor(tenantId: string): Request {
  return new Request("http://localhost/api/test", {
    headers: { "x-tenant-id": tenantId },
  });
}

describe("cross-tenant job isolation", () => {
  test("tenant A jobs are not visible to tenant B", async () => {
    await withTenantContext(async () => {
      createJob({ id: "job-a1", kind: "test" });
      return new Response("ok");
    })(reqFor("t-alpha"));

    await withTenantContext(async () => {
      createJob({ id: "job-b1", kind: "test" });
      return new Response("ok");
    })(reqFor("t-beta"));

    let alphaJobs: JobRow[] = [];
    await withTenantContext(async () => {
      alphaJobs = readJobs();
      return new Response("ok");
    })(reqFor("t-alpha"));

    expect(alphaJobs).toHaveLength(1);
    expect(alphaJobs[0].id).toBe("job-a1");
    expect(alphaJobs.some((j) => j.id === "job-b1")).toBe(false);
  });

  test("tenant B cannot read tenant A job by id", async () => {
    await withTenantContext(async () => {
      createJob({ id: "job-a1", kind: "test" });
      return new Response("ok");
    })(reqFor("t-alpha"));

    let betaRead: JobRow | null = null;
    await withTenantContext(async () => {
      betaRead = readJob("job-a1");
      return new Response("ok");
    })(reqFor("t-beta"));

    expect(betaRead).toBeNull();
  });

  test("updateJobOutput only affects current tenant job", async () => {
    await withTenantContext(async () => {
      createJob({ id: "job-a1", kind: "test" });
      updateJobOutput("job-a1", "alpha-output");
      return new Response("ok");
    })(reqFor("t-alpha"));

    await withTenantContext(async () => {
      createJob({ id: "job-b1", kind: "test" });
      updateJobOutput("job-b1", "beta-output");
      return new Response("ok");
    })(reqFor("t-beta"));

    let alphaJob: JobRow | null = null;
    let betaJob: JobRow | null = null;
    await withTenantContext(async () => {
      alphaJob = readJob("job-a1");
      return new Response("ok");
    })(reqFor("t-alpha"));

    await withTenantContext(async () => {
      betaJob = readJob("job-b1");
      return new Response("ok");
    })(reqFor("t-beta"));

    expect(alphaJob?.outputTail).toBe("alpha-output");
    expect(betaJob?.outputTail).toBe("beta-output");
  });

  test("finishJob only affects current tenant job", async () => {
    await withTenantContext(async () => {
      createJob({ id: "job-a1", kind: "test" });
      finishJob("job-a1", "success", { output: "alpha-done" });
      return new Response("ok");
    })(reqFor("t-alpha"));

    await withTenantContext(async () => {
      createJob({ id: "job-b1", kind: "test" });
      return new Response("ok");
    })(reqFor("t-beta"));

    let betaJob: JobRow | null = null;
    await withTenantContext(async () => {
      betaJob = readJob("job-b1");
      return new Response("ok");
    })(reqFor("t-beta"));

    expect(betaJob?.status).not.toBe("success");
    expect(betaJob?.outputTail).not.toBe("alpha-done");
  });
});

describe("cross-tenant action_audit isolation", () => {
  test("tenant A audit rows are not visible to tenant B", async () => {
    await withTenantContext(async () => {
      writeActionAudit({ actionKind: "test.create" });
      return new Response("ok");
    })(reqFor("t-alpha"));

    await withTenantContext(async () => {
      writeActionAudit({ actionKind: "test.create" });
      return new Response("ok");
    })(reqFor("t-beta"));

    let alphaAudit: ActionAuditRow[] = [];
    await withTenantContext(async () => {
      alphaAudit = readActionAudit();
      return new Response("ok");
    })(reqFor("t-alpha"));

    expect(alphaAudit).toHaveLength(1);
    expect(alphaAudit[0].tenantId).toBe("t-alpha");
  });

  test("non-existent tenant returns empty audit", async () => {
    await withTenantContext(async () => {
      writeActionAudit({ actionKind: "test.create" });
      return new Response("ok");
    })(reqFor("t-alpha"));

    let gammaAudit: ActionAuditRow[] = [];
    await withTenantContext(async () => {
      gammaAudit = readActionAudit();
      return new Response("ok");
    })(reqFor("t-gamma"));

    expect(gammaAudit).toEqual([]);
  });
});

describe("cross-tenant operator_state isolation", () => {
  test("tenant A state is not visible to tenant B with different keys", async () => {
    await withTenantContext(async () => {
      writeOperatorState("alpha-key", { value: "alpha" });
      return new Response("ok");
    })(reqFor("t-alpha"));

    await withTenantContext(async () => {
      writeOperatorState("beta-key", { value: "beta" });
      return new Response("ok");
    })(reqFor("t-beta"));

    let alphaValue: unknown = null;
    let betaValue: unknown = null;
    let alphaSeesBeta: unknown = null;
    await withTenantContext(async () => {
      alphaValue = readOperatorState("alpha-key");
      return new Response("ok");
    })(reqFor("t-alpha"));

    await withTenantContext(async () => {
      betaValue = readOperatorState("beta-key");
      return new Response("ok");
    })(reqFor("t-beta"));

    await withTenantContext(async () => {
      alphaSeesBeta = readOperatorState("beta-key");
      return new Response("ok");
    })(reqFor("t-alpha"));

    expect(alphaValue).toEqual({ value: "alpha" });
    expect(betaValue).toEqual({ value: "beta" });
    expect(alphaSeesBeta).toBeNull();
  });

  test("default tenant can read null-tenant_id state", async () => {
    const db = getDashboardDb();
    if (!db) throw new Error("db not initialized");
    db.query(
      `INSERT INTO operator_state (key, value_json, updated_at, tenant_id) VALUES (?, ?, ?, ?)`
    ).run("legacy-key", JSON.stringify({ value: "legacy" }), Date.now(), null);

    let value: unknown = null;
    await withTenantContext(async () => {
      value = readOperatorState("legacy-key");
      return new Response("ok");
    })(reqFor("mimule"));

    expect(value).toEqual({ value: "legacy" });
  });
});
