import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { promptsHandler } from "./prompts.ts";
import { registerPrompt } from "../prompts/registry.ts";

function withTenant<R>(fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId: "mimule" }), fn);
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "prompts-api-test-"));
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

describe("GET /api/prompts", () => {
  test("returns 401 without the operator token", async () => {
    delete process.env.OPERATOR_TOKEN;
    const res = await promptsHandler(
      new Request("http://localhost/api/prompts"),
      new URL("http://localhost/api/prompts"),
    );
    expect(res.status).toBe(401);
  });

  test("returns 200 with a list of registered prompts", async () => {
    withTenant(() => {
      registerPrompt("incident-postmortem.system", "Prompt body for tests");
    });
    const res = await promptsHandler(
      new Request("http://localhost/api/prompts", { headers: { "x-operator-token": "test-token" } }),
      new URL("http://localhost/api/prompts"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { prompts: Array<{ name: string; version: number }>; latest: null } };
    expect(body.data.prompts).toHaveLength(1);
    expect(body.data.prompts[0].name).toBe("incident-postmortem.system");
    expect(body.data.prompts[0].version).toBe(1);
    expect(body.data.latest).toBeNull();
  });

  test("returns the latest version's content when name is supplied", async () => {
    withTenant(() => {
      registerPrompt("incident-postmortem.system", "First version");
      registerPrompt("incident-postmortem.system", "Second version");
    });
    const res = await promptsHandler(
      new Request("http://localhost/api/prompts?name=incident-postmortem.system", {
        headers: { "x-operator-token": "test-token" },
      }),
      new URL("http://localhost/api/prompts?name=incident-postmortem.system"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { prompts: unknown[]; latest: { version: number; content: string } | null } };
    expect(body.data.latest).not.toBeNull();
    expect(body.data.latest!.version).toBe(2);
    expect(body.data.latest!.content).toBe("Second version");
  });

  test("returns a specific version when ?version=N is given", async () => {
    withTenant(() => {
      registerPrompt("multi.system", "v1 body");
      registerPrompt("multi.system", "v2 body");
      registerPrompt("multi.system", "v3 body");
    });
    const res = await promptsHandler(
      new Request("http://localhost/api/prompts?name=multi.system&version=2", {
        headers: { "x-operator-token": "test-token" },
      }),
      new URL("http://localhost/api/prompts?name=multi.system&version=2"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { latest: { version: number; content: string } | null } };
    expect(body.data.latest).not.toBeNull();
    expect(body.data.latest!.version).toBe(2);
    expect(body.data.latest!.content).toBe("v2 body");
  });

  test("returns the list with latest=null when the requested name is unknown", async () => {
    withTenant(() => {
      registerPrompt("known.system", "Body");
    });
    const res = await promptsHandler(
      new Request("http://localhost/api/prompts?name=unknown.system", {
        headers: { "x-operator-token": "test-token" },
      }),
      new URL("http://localhost/api/prompts?name=unknown.system"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { latest: unknown; prompts: unknown[] } };
    expect(body.data.latest).toBeNull();
    expect(body.data.prompts).toHaveLength(1);
  });
});
