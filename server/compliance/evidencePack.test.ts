import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDashboardDb,
  getDashboardDb,
  initDashboardDb,
} from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  buildEvidencePackInMemory,
  generateEvidencePack,
  readEvidencePackById,
} from "./evidencePack.ts";

const SECRET_VALUE = "supersecret-token-DO-NOT-LEAK-9f3a";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "evidence-pack-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function withTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

function seedAuditRows(tenantId: string, n: number): void {
  withTenant(tenantId, () => {
    for (let i = 0; i < n; i++) {
      writeActionAudit({
        userId: `user-${i}`,
        actor: `actor-${i}`,
        actorSource: "test",
        actionKind: `test.action.${i}`,
        targetType: "test-target",
        targetId: `tgt-${i}`,
        risk: "low",
        resultStatus: "success",
        resultJson: { note: SECRET_VALUE, index: i },
      });
    }
  });
}

function seedUserWithRole(id: string, email: string, role: string): void {
  const db = getDashboardDb()!;
  const now = Date.now();
  db.query(
    `INSERT OR REPLACE INTO users (id, email, name, auth_method, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, email, email, "local", now, "mimule");
  db.query(
    `INSERT OR REPLACE INTO governance_role_bindings (id, user_id, role, project_id, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(`binding-${id}`, id, role, null, now);
}

function seedGatewayKey(id: string, agentId: string, hash: string): void {
  const db = getDashboardDb()!;
  const now = Date.now();
  db.query(
    `INSERT OR REPLACE INTO gateway_keys (id, agent_id, name, key_hash, model_allowlist, status, created_at, last_used_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, agentId, `key-${id}`, hash, "", "active", now, now, "mimule");
}

describe("evidencePack", () => {
  it("generates a pack and persists a report_archive row", () => {
    const { id } = withTenant("mimule", () => generateEvidencePack());
    expect(id).not.toBe("db-off");
    expect(id).toMatch(/^\d+$/);

    const db = getDashboardDb()!;
    const row = db
      .query(
        `SELECT id, kind, path, summary FROM report_archive WHERE kind = 'evidence-pack'`,
      )
      .get() as { id: number; kind: string; path: string; summary: string | null } | null;

    expect(row).not.toBeNull();
    expect(row!.kind).toBe("evidence-pack");
    expect(row!.path).toContain("compliance/evidence-pack/");
    expect(row!.summary).toBeTruthy();

    const stored = JSON.parse(row!.summary!) as {
      tenant: string;
      auditChain: { rows: unknown[]; chainSha256: string };
      accessReview: { users: unknown[]; gatewayKeys: unknown[] };
      trustScore: { score: number; maxScore: number };
      counts: { insights: number; action_audit: number; cost_events: number };
    };
    expect(stored.tenant).toBe("mimule");
    expect(stored.trustScore.maxScore).toBe(100);
    expect(stored.counts.action_audit).toBeGreaterThanOrEqual(0);
  });

  it("readEvidencePackById returns the stored JSON for the returned id", () => {
    const { id } = withTenant("mimule", () => generateEvidencePack());
    const pack = withTenant("mimule", () => readEvidencePackById(id));
    expect(pack).not.toBeNull();
    expect(pack!.id).toBe(id);
    expect(pack!.tenant).toBe("mimule");
    expect(pack!.auditChain.chainSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("readEvidencePackById returns null for unknown id", () => {
    const pack = withTenant("mimule", () => readEvidencePackById("999999"));
    expect(pack).toBeNull();
  });

  it("chainSha256 is deterministic for the same redacted rows", () => {
    seedAuditRows("mimule", 3);
    const a = withTenant("mimule", () => buildEvidencePackInMemory());
    const b = withTenant("mimule", () => buildEvidencePackInMemory());
    expect(a.chainSha256).toBe(b.chainSha256);
    expect(a.chainSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("chainSha256 changes when audit rows change", () => {
    seedAuditRows("mimule", 2);
    const a = withTenant("mimule", () => buildEvidencePackInMemory());
    seedAuditRows("mimule", 1);
    const b = withTenant("mimule", () => buildEvidencePackInMemory());
    expect(a.chainSha256).not.toBe(b.chainSha256);
  });

  it("redacts audit rows to {ts, actor, action, target_type, target_id, result_status}", () => {
    seedAuditRows("mimule", 1);
    const { pack } = withTenant("mimule", () => buildEvidencePackInMemory());
    expect(pack.auditChain.rows.length).toBeGreaterThan(0);
    for (const row of pack.auditChain.rows) {
      const keys = Object.keys(row).sort();
      expect(keys).toEqual(
        ["action", "actor", "result_status", "target_id", "target_type", "ts"],
      );
    }
  });

  it("never leaks secrets from action_audit into the accessReview", () => {
    seedAuditRows("mimule", 2);
    seedUserWithRole("u-1", "ops@example.com", "owner");
    seedGatewayKey("k-1", "agent-alpha", SECRET_VALUE);

    const { pack } = withTenant("mimule", () => buildEvidencePackInMemory());
    const json = JSON.stringify(pack.accessReview);
    expect(json).not.toContain(SECRET_VALUE);
    expect(json).not.toContain("supersecret-token-DO-NOT-LEAK");

    for (const key of pack.accessReview.gatewayKeys) {
      const keyJson = JSON.stringify(key);
      expect(keyJson).not.toContain(SECRET_VALUE);
      expect(Object.keys(key).sort()).toEqual(
        ["agent_id", "id", "last_used_at", "status"],
      );
    }
  });

  it("returns db-off sentinel when DB is disabled", () => {
    closeDashboardDb();
    const { id } = withTenant("mimule", () => generateEvidencePack());
    expect(id).toBe("db-off");
  });
});
