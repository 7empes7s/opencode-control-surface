import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  acquireWriterLease,
  appendAgentEvent,
  authorizeAdapterSession,
  importLegacyAgentSessions,
  isInternalAdapterSession,
  isLegacyOpenCodeVisibilityReady,
  isReservedOpenCodeTitle,
  createAgentRun,
  listAgentEvents,
  listAgentSessions,
  recordInternalVisibility,
  registerAgentSession,
  releaseWriterLease,
  listAgentRuns,
  markUnreconciledAgentRunsStale,
  seedLegacyOpenCodeVisibilityReceipts,
} from "./registry.ts";

let root = "";
let dbPath = "";

const owner = { tenantId: "mimule", userId: "owner-a", role: "owner" as const };
const other = { tenantId: "mimule", userId: "owner-b", role: "owner" as const };

function register(id: string, ownerUserId = owner.userId, workspaceRoot: string | null = root) {
  return registerAgentSession({
    tenantId: "mimule",
    ownerUserId,
    harness: "opencode",
    adapterSessionId: id,
    adapterVersion: "test-v1",
    title: `Session ${id}`,
    workspaceRoot,
    repositoryRoot: workspaceRoot,
    createdBy: ownerUserId,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-workspace-"));
  dbPath = join(root, "dashboard.sqlite");
  initDashboardDb({ enabled: true, path: dbPath });
});

afterEach(() => {
  closeDashboardDb();
  rmSync(root, { recursive: true, force: true });
});

describe("agent workspace registry", () => {
  test("migrates v12 durable tables with 0600 local storage", () => {
    const db = getDashboardDb()!;
    const version = db.query("SELECT MAX(version) AS version FROM schema_version").get() as { version: number };
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(version.version).toBe(12);
    for (const table of ["agent_sessions", "agent_runs", "agent_events", "visibility_receipts", "artifacts", "leases"]) {
      expect(tables.has(table)).toBe(true);
    }
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  test("upgrades a historical v11 schema without assuming a single version row", () => {
    closeDashboardDb();
    const legacyPath = join(root, "legacy-v11.sqlite");
    const legacy = new Database(legacyPath);
    legacy.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const version of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11]) {
      legacy.query("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(version, version);
    }
    legacy.close();
    initDashboardDb({ enabled: true, path: legacyPath });
    const db = getDashboardDb()!;
    expect((db.query("SELECT MAX(version) AS version FROM schema_version").get() as { version: number }).version).toBe(12);
    expect((db.query("SELECT COUNT(*) AS count FROM agent_sessions").get() as { count: number }).count).toBe(0);
  });

  test("imports the exact immutable visibility receipt and validates readiness", () => {
    expect(seedLegacyOpenCodeVisibilityReceipts()).toBe(2490);
    expect(seedLegacyOpenCodeVisibilityReceipts()).toBe(0);
    expect(isLegacyOpenCodeVisibilityReady()).toBe(true);
    expect(isInternalAdapterSession("opencode", "ses_08617347dffez44xNhAPaQudYa")).toBe(true);
    expect(() => getDashboardDb()!.query("DELETE FROM visibility_receipts").run()).toThrow(/immutable/);
  });

  test("exact reserved marker does not match a near-prefix", () => {
    expect(isReservedOpenCodeTitle("__mimule_probe_v1__:health")).toBe(true);
    expect(isReservedOpenCodeTitle("__mimule_probe_v1_health")).toBe(false);
    expect(isReservedOpenCodeTitle("prefix __mimule_probe_v1__:health")).toBe(false);
  });

  test("enforces tenant and owner visibility while preserving explicit tenant sharing", () => {
    const own = register("ses_ownedA");
    register("ses_ownedB", other.userId);
    expect(listAgentSessions(owner).map((session) => session.id)).toEqual([own.id]);
    expect(authorizeAdapterSession(other, "opencode", own.adapterSessionId)).toBeNull();

    registerAgentSession({
      tenantId: "mimule",
      ownerUserId: other.userId,
      harness: "claude",
      adapterSessionId: "shared-1",
      adapterVersion: "test-v1",
      title: "Shared",
      visibility: "tenant",
      createdBy: other.userId,
    });
    expect(listAgentSessions(owner, "claude")).toHaveLength(1);
    expect(listAgentSessions({ ...owner, tenantId: "other" }, "claude")).toHaveLength(0);
  });

  test("hidden classification cannot be undone by a later import", () => {
    recordInternalVisibility({ harness: "opencode", adapterSessionId: "ses_hidden1", reason: "test", source: "test" });
    const hidden = registerAgentSession({
      tenantId: "mimule",
      ownerUserId: owner.userId,
      harness: "opencode",
      adapterSessionId: "ses_hidden1",
      adapterVersion: "v1",
      title: "renamed operator-looking session",
      internal: false,
      createdBy: owner.userId,
    });
    expect(hidden.internal).toBe(true);
    expect(listAgentSessions(owner)).toHaveLength(0);
    expect(() => getDashboardDb()!.query("UPDATE agent_sessions SET internal = 0 WHERE id = ?").run(hidden.id)).toThrow(/immutable/);
  });

  test("persists a monotonic event tail across database restart", () => {
    const session = register("ses_events1");
    expect(appendAgentEvent({ session, kind: "one", payload: { value: 1 } }).sequence).toBe(1);
    expect(appendAgentEvent({ session, kind: "two", payload: { value: 2 } }).sequence).toBe(2);
    closeDashboardDb();
    initDashboardDb({ enabled: true, path: dbPath });
    expect(listAgentEvents(owner, session.id).map((event) => [event.sequence, event.kind])).toEqual([[1, "one"], [2, "two"]]);
  });

  test("creates runs idempotently and reconstructs interrupted state as stale", () => {
    const session = register("ses_run1");
    const first = createAgentRun({ session, idempotencyKey: "request-1", status: "running", requestedConfig: { model: "logical-test" } });
    const replay = createAgentRun({ session, idempotencyKey: "request-1", status: "running" });
    expect(replay.id).toBe(first.id);
    expect(markUnreconciledAgentRunsStale(9_000)).toBe(1);
    const runs = listAgentRuns(owner, session.id);
    expect(runs[0].status).toBe("stale");
    expect(runs[0].finishedAt).toBe(9_000);
  });

  test("rejects a second shared-checkout writer and advances fencing after release", () => {
    const alias = join(tmpdir(), `agent-workspace-alias-${Date.now()}-${Math.random()}`);
    symlinkSync(root, alias);
    expect(readlinkSync(alias)).toBe(root);
    const first = acquireWriterLease({ tenantId: "mimule", resourceKey: root, sessionId: "s1", userId: "u1", now: 1_000 });
    expect(first.ok).toBe(true);
    const conflict = acquireWriterLease({ tenantId: "mimule", resourceKey: alias, sessionId: "s2", userId: "u2", now: 2_000 });
    expect(conflict.ok).toBe(false);
    if (!first.ok) throw new Error("expected lease");
    expect(releaseWriterLease({ resourceKey: root, sessionId: "s1", fenceEpoch: first.fenceEpoch, now: 3_000 })).toBe(true);
    const second = acquireWriterLease({ tenantId: "mimule", resourceKey: alias, sessionId: "s2", userId: "u2", now: 4_000 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.fenceEpoch).toBe(first.fenceEpoch + 1);
    rmSync(alias);
  });

  test("imports preserved legacy visible sessions idempotently", () => {
    seedLegacyOpenCodeVisibilityReceipts();
    const first = importLegacyAgentSessions();
    expect(first.opencode).toBe(77);
    const second = importLegacyAgentSessions();
    expect(second.opencode).toBe(0);
    expect(listAgentSessions({ tenantId: "mimule", userId: "operator-bootstrap", role: "owner" }, "opencode")).toHaveLength(77);
  });
});
