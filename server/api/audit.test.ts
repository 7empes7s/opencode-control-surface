import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import {
  buildHashChain,
  verifyHashChain,
  exportAuditLog,
  type AuditRowForHash,
} from "../governance/audit/export.ts";
import {
  getAuditRetentionDays,
  purgeExpiredAuditRows,
} from "../governance/audit/export.ts";
import { getDashboardDb, initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";

const TEST_DB = "/tmp/test-audit-control-surface.db";
const TEST_EXPORT_DIR = "/tmp/test-exports";

function setupTestDb(): Database {
  rmSync(TEST_DB, { force: true });
  mkdirSync("/tmp", { recursive: true });
  chmodSync("/tmp", 0o755);
  closeDashboardDb();
  return initDashboardDb({ enabled: true, path: TEST_DB })!;
}

function createTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_audit (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      actor TEXT,
      actor_source TEXT,
      action_kind TEXT NOT NULL,
      action TEXT,
      action_id TEXT,
      reason TEXT,
      target TEXT,
      target_type TEXT,
      target_id TEXT,
      risk TEXT,
      args_json TEXT,
      request_json TEXT,
      result TEXT,
      result_status TEXT,
      result_json TEXT,
      evidence_json TEXT,
      job_id TEXT,
      event_id TEXT,
      rollback_hint TEXT,
      error TEXT,
      tenant_id TEXT,
      prev_hash TEXT,
      row_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id TEXT PRIMARY KEY,
      data_residency_region TEXT,
      storage_root TEXT,
      audit_retention_days INTEGER,
      require_two_approvers INTEGER DEFAULT 0,
      sso_required INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_export_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      from_ts INTEGER NOT NULL,
      to_ts INTEGER NOT NULL,
      format TEXT NOT NULL DEFAULT 'jsonl',
      status TEXT NOT NULL DEFAULT 'pending',
      row_count INTEGER,
      chain_hash TEXT,
      output_path TEXT,
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER
    );
  `);
}

function makeRow(overrides: Partial<AuditRowForHash> = {}): AuditRowForHash {
  return {
    id: "1",
    ts: 1000,
    actor: "alice",
    actor_source: "api",
    action_kind: "gateway.call",
    action_id: "call-001",
    reason: "test",
    target: "model",
    target_type: "gateway",
    target_id: "model-1",
    risk: "low",
    request_json: "{}",
    args_json: "[]",
    result_status: "success",
    result: "ok",
    result_json: '{"tokens":100}',
    evidence_json: "{}",
    job_id: "",
    event_id: "",
    rollback_hint: "",
    error: "",
    tenant_id: "mimule",
    prev_hash: "",
    row_hash: "",
    ...overrides,
  };
}

describe("buildHashChain", () => {
  it("builds chain and computes final hash", () => {
    const rows = [makeRow({ id: "1", ts: 1000 }), makeRow({ id: "2", ts: 2000 })];
    const { rows: out, chainHash } = buildHashChain(rows);
    expect(out.length).toBe(2);
    expect(out[0].hash).toBeTruthy();
    expect(out[1].hash).toBeTruthy();
    expect(out[0].hash).not.toBe(out[1].hash);
    expect(chainHash).toBe(out[1].hash);
  });

  it("uses genesis for first row prev_hash", () => {
    const rows = [makeRow({ id: "1" })];
    const { rows: out } = buildHashChain(rows);
    expect(out[0].hash).toBeTruthy();
  });

  it("handles empty rows", () => {
    const { rows: out, chainHash } = buildHashChain([]);
    expect(out.length).toBe(0);
    expect(chainHash).toBe("genesis");
  });
});

describe("verifyHashChain", () => {
  it("verifies a valid chain", () => {
    const rows = [makeRow({ id: "1" }), makeRow({ id: "2" })];
    const { rows: chained } = buildHashChain(rows);

    for (const row of chained) {
      expect(typeof row.hash).toBe("string");
      expect(row.hash.length).toBe(64);
    }

    const result = verifyHashChain(chained);
    expect(result.valid).toBe(true);
    expect(result.firstBadIndex).toBeUndefined();
  });

  it("detects tampered row", () => {
    const rows = [makeRow({ id: "1" }), makeRow({ id: "2" })];
    const { rows: chained } = buildHashChain(rows);
    chained[0] = { ...chained[0], actor: "tampered" };
    const result = verifyHashChain(chained);
    expect(result.valid).toBe(false);
    expect(result.firstBadIndex).toBe(0);
  });

  it("detects truncated chain", () => {
    const rows = [makeRow({ id: "1" }), makeRow({ id: "2" }), makeRow({ id: "3" })];
    const { rows: chained } = buildHashChain(rows);
    const fullChainHash = chained[chained.length - 1].hash;

    const truncated = chained.slice(0, 2);
    const result = verifyHashChain(truncated);
    expect(result.valid).toBe(true);
    const truncatedChainHash = truncated[truncated.length - 1].hash;
    expect(truncatedChainHash).not.toBe(fullChainHash);
  });
});

describe("exportAuditLog", () => {
  let db: Database;

  beforeEach(() => {
    db = setupTestDb();
    createTables(db);
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });

  it("streams JSONL format", async () => {
    const now = Date.now();
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(now, "alice", "gateway.call", "mimule", "", "");
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(now + 1, "bob", "builder.run", "mimule", "", "");

    const chunks: string[] = [];
    for await (const chunk of exportAuditLog({
      tenantId: "mimule",
      fromTs: 0,
      toTs: now + 10000,
      format: "jsonl",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.actor).toBe("alice");
  });

  it("streams CSV format with header", async () => {
    const now = Date.now();
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(now, "alice", "gateway.call", "mimule", "", "");

    const chunks: string[] = [];
    for await (const chunk of exportAuditLog({
      tenantId: "mimule",
      fromTs: 0,
      toTs: now + 10000,
      format: "csv",
    })) {
      chunks.push(chunk);
    }

    const content = chunks.join("");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("id,ts,actor");
    expect(lines[0]).toContain("actor_source");
  });

  it("filters by includeKinds", async () => {
    const now = Date.now();
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(now, "alice", "gateway.call", "mimule", "", "");
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(now + 1, "bob", "builder.run", "mimule", "", "");

    const chunks: string[] = [];
    for await (const chunk of exportAuditLog({
      tenantId: "mimule",
      fromTs: 0,
      toTs: now + 10000,
      format: "jsonl",
      includeKinds: ["gateway.call"],
    })) {
      chunks.push(chunk);
    }

    const lines = chunks.join("").split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.every((r) => r.action_kind === "gateway.call")).toBe(true);
  });
});

describe("getAuditRetentionDays", () => {
  let db: Database;

  beforeEach(() => {
    db = setupTestDb();
    createTables(db);
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });

  it("returns tenant_setting value when present", () => {
    db.query(
      `INSERT OR REPLACE INTO tenant_settings (tenant_id, audit_retention_days, updated_at) VALUES (?, ?, ?)`,
    ).run("mimule", 30, Date.now());
    expect(getAuditRetentionDays("mimule")).toBe(30);
  });

  it("returns env fallback when no tenant setting", () => {
    process.env.AUDIT_RETENTION_DAYS = "60";
    expect(getAuditRetentionDays("mimule")).toBe(60);
    delete process.env.AUDIT_RETENTION_DAYS;
  });
});

describe("purgeExpiredAuditRows", () => {
  let db: Database;

  beforeEach(() => {
    db = setupTestDb();
    createTables(db);
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });

  it("purges rows older than retention period", () => {
    const now = Date.now();
    const oldTs = now - 100 * 24 * 60 * 60 * 1000;
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(oldTs, "alice", "gateway.call", "mimule", "", "");
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(now, "bob", "gateway.call", "mimule", "", "");

    const deleted = purgeExpiredAuditRows("mimule", 90);
    expect(deleted).toBe(1);
    const remaining = db.query("SELECT COUNT(*) as cnt FROM action_audit WHERE tenant_id = ?").get("mimule") as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });
});