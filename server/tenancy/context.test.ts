import { expect, test, describe } from "bun:test";
import {
  DEFAULT_TENANT_ID,
  DEFAULT_PROJECT_ID,
  getTenantContext,
  assertTenantId,
  testTenantContext,
} from "./context.ts";

describe("DEFAULT_TENANT_ID", () => {
  test("is mimule", () => {
    expect(DEFAULT_TENANT_ID).toBe("mimule");
  });
});

describe("DEFAULT_PROJECT_ID", () => {
  test("returns control-surface project id", () => {
    expect(DEFAULT_PROJECT_ID()).toBe("opencode-control-surface");
  });
});

describe("getTenantContext", () => {
  test("returns default context when no request", () => {
    const ctx = getTenantContext();
    expect(ctx.tenantId).toBe("mimule");
    expect(ctx.projectId).toBe("opencode-control-surface");
    expect(ctx.source).toBe("default");
    expect(ctx.actor).toBeUndefined();
  });

  test("derives context from x-tenant-id header", () => {
    const req = new Request("http://localhost/api", {
      headers: { "x-tenant-id": "acme" },
    });
    const ctx = getTenantContext(req);
    expect(ctx.tenantId).toBe("acme");
    expect(ctx.source).toBe("header");
  });

  test("includes project and actor from headers", () => {
    const req = new Request("http://localhost/api", {
      headers: {
        "x-tenant-id": "acme",
        "x-project-id": "my-app",
        "x-actor": "user-42",
      },
    });
    const ctx = getTenantContext(req);
    expect(ctx.tenantId).toBe("acme");
    expect(ctx.projectId).toBe("my-app");
    expect(ctx.actor).toBe("user-42");
    expect(ctx.source).toBe("header");
  });

  test("parses tenant from query string when no header", () => {
    const req = new Request("http://localhost/api?tenant=acme&project=my-app");
    const ctx = getTenantContext(req);
    expect(ctx.tenantId).toBe("acme");
    expect(ctx.projectId).toBe("my-app");
    expect(ctx.source).toBe("header");
  });

  test("falls back to default when no tenant header or query", () => {
    const req = new Request("http://localhost/api");
    const ctx = getTenantContext(req);
    expect(ctx.tenantId).toBe("mimule");
    expect(ctx.source).toBe("default");
  });
});

describe("assertTenantId", () => {
  test("accepts valid tenant IDs", () => {
    expect(assertTenantId("mimule")).toBe("mimule");
    expect(assertTenantId("acme-corp")).toBe("acme-corp");
    expect(assertTenantId("tenant_1")).toBe("tenant_1");
    expect(assertTenantId("a")).toBe("a");
    expect(assertTenantId("a1b2c3")).toBe("a1b2c3");
  });

  test("trims whitespace", () => {
    expect(assertTenantId("  mimule  ")).toBe("mimule");
  });

  test("rejects empty string", () => {
    expect(() => assertTenantId("")).toThrow(/Invalid tenant ID/);
  });

  test("rejects uppercase", () => {
    expect(() => assertTenantId("MIMULE")).toThrow(/Invalid tenant ID/);
  });

  test("rejects special characters", () => {
    expect(() => assertTenantId("acme.corp")).toThrow(/Invalid tenant ID/);
    expect(() => assertTenantId("acme/corp")).toThrow(/Invalid tenant ID/);
    expect(() => assertTenantId("acme corp")).toThrow(/Invalid tenant ID/);
  });

  test("rejects non-string input", () => {
    expect(() => assertTenantId(123 as unknown as string)).toThrow(/Invalid tenant ID/);
    expect(() => assertTenantId(null as unknown as string)).toThrow(/Invalid tenant ID/);
  });

  test("rejects IDs starting with hyphen or underscore", () => {
    expect(() => assertTenantId("-acme")).toThrow(/Invalid tenant ID/);
    expect(() => assertTenantId("_acme")).toThrow(/Invalid tenant ID/);
  });
});

describe("testTenantContext", () => {
  test("returns test source with defaults", () => {
    const ctx = testTenantContext();
    expect(ctx.tenantId).toBe("mimule");
    expect(ctx.source).toBe("test");
  });

  test("applies overrides", () => {
    const ctx = testTenantContext({ tenantId: "acme", actor: "tester" });
    expect(ctx.tenantId).toBe("acme");
    expect(ctx.actor).toBe("tester");
    expect(ctx.source).toBe("test");
  });
});
