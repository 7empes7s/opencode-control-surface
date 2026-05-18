import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { contextGetHandler } from "./context.ts";

let prevToken: string | undefined;

beforeEach(() => {
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "test-token";
});

afterEach(() => {
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
});

function authedReq(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/context", {
    headers: { "x-operator-token": "test-token", ...headers },
  });
}

describe("GET /api/context", () => {
  test("returns default context without tenant headers", async () => {
    const ctx = testTenantContext({ source: "default" });
    const res = tenantStore.run(ctx, () => contextGetHandler(authedReq()));
    expect(res.status).toBe(200);
    const body = await res.json() as { tenantId: string; projectId: string | null; source: string };
    expect(body.tenantId).toBe("mimule");
    expect(body.projectId).toBe("opencode-control-surface");
    expect(body.source).toBe("default");
  });

  test("returns header-derived context with x-tenant-id", async () => {
    const req = authedReq({ "x-tenant-id": "acme", "x-project-id": "acme-web" });
    const ctx = testTenantContext({ tenantId: "acme", projectId: "acme-web", source: "header" });
    const res = tenantStore.run(ctx, () => contextGetHandler(req));
    expect(res.status).toBe(200);
    const body = await res.json() as { tenantId: string; projectId: string | null; source: string };
    expect(body.tenantId).toBe("acme");
    expect(body.projectId).toBe("acme-web");
    expect(body.source).toBe("header");
  });

  test("returns 401 without token", async () => {
    const res = contextGetHandler(new Request("http://localhost/api/context"));
    expect(res.status).toBe(401);
  });
});
