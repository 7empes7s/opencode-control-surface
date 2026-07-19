import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStore } from "../auth/session.ts";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { registerAgentSession } from "../agentWorkspace/registry.ts";
import { getOpenCodeSessionSummary, resetOpenCodeOperationalCacheForTests } from "./opencode.ts";

let root = "";
let previousFetch: typeof globalThis.fetch;

function register(id: string, ownerUserId: string): void {
  registerAgentSession({
    tenantId: "mimule",
    ownerUserId,
    harness: "opencode",
    adapterSessionId: id,
    adapterVersion: "test-v1",
    title: `Session ${id}`,
    createdBy: ownerUserId,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
  initDashboardDb({ enabled: true, path: join(root, "dashboard.sqlite") });
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([])) as unknown as typeof globalThis.fetch;
  resetOpenCodeOperationalCacheForTests();
});

afterEach(() => {
  resetOpenCodeOperationalCacheForTests();
  globalThis.fetch = previousFetch;
  closeDashboardDb();
  rmSync(root, { recursive: true, force: true });
});

test("operational caching never reuses one owner's visible session summary", async () => {
  register("session-a1", "owner-a");
  register("session-a2", "owner-a");
  register("session-b1", "owner-b");

  const ownerA = await authStore.run(
    { userId: "owner-a", tenantId: "mimule", source: "local", bootstrapOwner: true },
    getOpenCodeSessionSummary,
  );
  const ownerB = await authStore.run(
    { userId: "owner-b", tenantId: "mimule", source: "local", bootstrapOwner: true },
    getOpenCodeSessionSummary,
  );

  expect(ownerA.sessionCount).toBe(2);
  expect(ownerB.sessionCount).toBe(1);
  expect(ownerA.reachable).toBe(true);
  expect(ownerB.reachable).toBe(true);
});
