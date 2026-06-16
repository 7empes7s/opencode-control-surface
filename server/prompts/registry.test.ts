import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  diffVersions,
  diffVersionsToString,
  getPrompt,
  listPrompts,
  registerPrompt,
} from "./registry.ts";

function withTenant<R>(fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId: "mimule" }), fn);
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "prompts-registry-test-"));
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

describe("prompts registry — versioning", () => {
  test("first register creates version 1, listPrompts surfaces it", () => {
    const result = withTenant(() => registerPrompt("hello.system", "First line.\nSecond line."));
    expect(result.inserted).toBe(true);
    expect(result.version).toBe(1);

    const prompt = withTenant(() => getPrompt("hello.system"));
    expect(prompt).not.toBeNull();
    expect(prompt!.version).toBe(1);
    expect(prompt!.content).toBe("First line.\nSecond line.");

    const list = withTenant(() => listPrompts());
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("hello.system");
    expect(list[0].version).toBe(1);
  });

  test("identical content does NOT create a new version", () => {
    const first = withTenant(() => registerPrompt("dup.system", "Same content"));
    expect(first.inserted).toBe(true);
    expect(first.version).toBe(1);

    const second = withTenant(() => registerPrompt("dup.system", "Same content"));
    expect(second.inserted).toBe(false);
    expect(second.version).toBe(1);

    const list = withTenant(() => listPrompts());
    expect(list).toHaveLength(1);
    expect(list[0].version).toBe(1);
  });

  test("changed content auto-increments to v2", () => {
    const first = withTenant(() => registerPrompt("changing.system", "Original prompt body"));
    expect(first.version).toBe(1);

    const second = withTenant(() => registerPrompt("changing.system", "Updated prompt body with new guidance"));
    expect(second.inserted).toBe(true);
    expect(second.version).toBe(2);
    expect(second.contentHash).not.toBe(first.contentHash);

    const latest = withTenant(() => getPrompt("changing.system"));
    expect(latest!.version).toBe(2);
    expect(latest!.content).toBe("Updated prompt body with new guidance");

    const v1 = withTenant(() => getPrompt("changing.system", { version: 1 }));
    expect(v1!.content).toBe("Original prompt body");

    const list = withTenant(() => listPrompts());
    expect(list.find((e) => e.name === "changing.system")?.version).toBe(2);
  });

  test("different prompt names are independent", () => {
    withTenant(() => {
      registerPrompt("a.system", "A1");
      registerPrompt("b.system", "B1");
      registerPrompt("a.system", "A2");
    });
    const list = withTenant(() => listPrompts());
    const a = list.find((e) => e.name === "a.system");
    const b = list.find((e) => e.name === "b.system");
    expect(a?.version).toBe(2);
    expect(b?.version).toBe(1);
  });
});

describe("prompts registry — diffVersions", () => {
  test("returns added/removed/same lines between v1 and v2", () => {
    withTenant(() => {
      registerPrompt("diffable.system", "line one\nline two\nline three");
      registerPrompt("diffable.system", "line one\nline TWO\nline three\nline four");
    });

    const lines = withTenant(() => diffVersions("diffable.system", 1, 2));
    const summary = lines.map((l) => `${l.kind}:${l.text}`).join("|");
    expect(summary).toContain("same:line one");
    expect(summary).toContain("removed:line two");
    expect(summary).toContain("added:line TWO");
    expect(summary).toContain("same:line three");
    expect(summary).toContain("added:line four");
  });

  test("diffVersionsToString renders a + / - / (space) prefixed block", () => {
    withTenant(() => {
      registerPrompt("strdiff.system", "alpha\nbeta");
      registerPrompt("strdiff.system", "alpha\nbeta-gamma");
    });
    const out = withTenant(() => diffVersionsToString("strdiff.system", 1, 2));
    expect(out).toContain("  alpha");
    expect(out).toContain("- beta");
    expect(out).toContain("+ beta-gamma");
  });

  test("diffVersions on a missing prompt returns an empty list", () => {
    const lines = withTenant(() => diffVersions("does-not-exist", 1, 2));
    expect(lines).toEqual([]);
  });
});

describe("prompts registry — DB-disabled fallback", () => {
  test("registerPrompt is a no-op when DASHBOARD_DB is off, getPrompt returns null", () => {
    closeDashboardDb();
    process.env.DASHBOARD_DB = "0";
    const result = registerPrompt("offline.system", "Anything");
    expect(result.inserted).toBe(false);
    expect(result.version).toBe(0);
    expect(getPrompt("offline.system")).toBeNull();
    expect(listPrompts()).toEqual([]);
  });
});
