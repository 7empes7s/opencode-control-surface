import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "./dashboard.ts";
import { seedDemoData } from "./demo-seed.ts";

const DEMO_TENANT_ID = "showcase-demo";
const GENESIS = "genesis";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousDemoSeed: string | undefined;

function tempDbPath(): string {
  return join(tempDir, "dashboard.sqlite");
}

function openScratchDb() {
  process.env.DASHBOARD_DB = "1";
  const db = initDashboardDb({ path: tempDbPath() });
  if (!db) {
    throw new Error("scratch dashboard DB did not initialize");
  }
  return db;
}

function countRows(db: NonNullable<ReturnType<typeof initDashboardDb>>, table: string): number {
  const row = db.query(`SELECT COUNT(*) as count FROM ${table} WHERE tenant_id = ?`).get(DEMO_TENANT_ID) as { count: number };
  return row.count;
}

function seedCounts(db: NonNullable<ReturnType<typeof initDashboardDb>>): Record<string, number> {
  return {
    tenants: (db.query(`SELECT COUNT(*) as count FROM tenants WHERE id = ?`).get(DEMO_TENANT_ID) as { count: number }).count,
    tenant_settings: (db.query(`SELECT COUNT(*) as count FROM tenant_settings WHERE tenant_id = ?`).get(DEMO_TENANT_ID) as { count: number }).count,
    provider_price_catalog: countRows(db, "provider_price_catalog"),
    cost_events: countRows(db, "cost_events"),
    action_audit: countRows(db, "action_audit"),
    reasoner_diagnoses: countRows(db, "reasoner_diagnoses"),
    reasoner_incidents: countRows(db, "reasoner_incidents"),
    jobs: countRows(db, "jobs"),
    spend_anomalies: countRows(db, "spend_anomalies"),
    builder_projects: countRows(db, "builder_projects"),
    builder_workflows: countRows(db, "builder_workflows"),
    builder_runs: countRows(db, "builder_runs"),
    builder_passes: countRows(db, "builder_passes"),
    builder_validations: countRows(db, "builder_validations"),
  };
}

type AuditRow = {
  id: number;
  ts: number;
  actor: string;
  actor_source: string;
  action_kind: string;
  action: string;
  action_id: string;
  reason: string;
  target: string;
  target_type: string;
  target_id: string;
  risk: string;
  args_json: string;
  request_json: string;
  result: string;
  result_status: string;
  result_json: string;
  evidence_json: string;
  job_id: string | null;
  event_id: string;
  rollback_hint: string;
  error: string | null;
  tenant_id: string;
  prev_hash: string;
  row_hash: string;
};

function hashAuditRow(prevHash: string, row: AuditRow): string {
  const seedShape = {
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    actor_source: row.actor_source,
    action_kind: row.action_kind,
    action: row.action,
    action_id: row.action_id,
    reason: row.reason,
    target: row.target,
    target_type: row.target_type,
    target_id: row.target_id,
    risk: row.risk,
    args_json: row.args_json,
    request_json: row.request_json,
    result: row.result,
    result_status: row.result_status,
    result_json: row.result_json,
    evidence_json: row.evidence_json,
    job_id: row.job_id,
    event_id: row.event_id,
    rollback_hint: row.rollback_hint,
    error: row.error,
    tenant_id: row.tenant_id,
  };
  return createHash("sha256").update(prevHash + JSON.stringify(seedShape), "utf8").digest("hex");
}

describe("seedDemoData", () => {
  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "demo-seed-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousDemoSeed = process.env.DEMO_SEED;
  });

  afterEach(() => {
    closeDashboardDb();

    if (previousDashboardDb === undefined) {
      delete process.env.DASHBOARD_DB;
    } else {
      process.env.DASHBOARD_DB = previousDashboardDb;
    }

    if (previousDashboardDbPath === undefined) {
      delete process.env.DASHBOARD_DB_PATH;
    } else {
      process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    }

    if (previousDemoSeed === undefined) {
      delete process.env.DEMO_SEED;
    } else {
      process.env.DEMO_SEED = previousDemoSeed;
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("does nothing unless DEMO_SEED is enabled", () => {
    const db = openScratchDb();
    delete process.env.DEMO_SEED;

    seedDemoData(db);

    expect(seedCounts(db)).toEqual({
      tenants: 0,
      tenant_settings: 0,
      provider_price_catalog: 0,
      cost_events: 0,
      action_audit: 0,
      reasoner_diagnoses: 0,
      reasoner_incidents: 0,
      jobs: 0,
      spend_anomalies: 0,
      builder_projects: 0,
      builder_workflows: 0,
      builder_runs: 0,
      builder_passes: 0,
      builder_validations: 0,
    });
  });

  test("populates the required showcase rows", () => {
    const db = openScratchDb();
    process.env.DEMO_SEED = "1";

    seedDemoData(db);

    expect(seedCounts(db)).toEqual({
      tenants: 1,
      tenant_settings: 1,
      provider_price_catalog: 4,
      cost_events: 6,
      action_audit: 5,
      reasoner_diagnoses: 3,
      reasoner_incidents: 3,
      jobs: 5,
      spend_anomalies: 2,
      builder_projects: 1,
      builder_workflows: 1,
      builder_runs: 1,
      builder_passes: 4,
      builder_validations: 4,
    });
  });

  test("is idempotent across repeated runs", () => {
    const db = openScratchDb();
    process.env.DEMO_SEED = "1";

    seedDemoData(db);
    const firstCounts = seedCounts(db);
    seedDemoData(db);

    expect(seedCounts(db)).toEqual(firstCounts);
  });

  test("creates a valid linked action audit hash chain", () => {
    const db = openScratchDb();
    process.env.DEMO_SEED = "1";

    seedDemoData(db);

    const rows = db.query(`
      SELECT
        id, ts, actor, actor_source, action_kind, action, action_id, reason,
        target, target_type, target_id, risk, args_json, request_json, result,
        result_status, result_json, evidence_json, job_id, event_id,
        rollback_hint, error, tenant_id, prev_hash, row_hash
      FROM action_audit
      WHERE tenant_id = ?
      ORDER BY id ASC
    `).all(DEMO_TENANT_ID) as AuditRow[];

    expect(rows).toHaveLength(5);
    let prevHash = GENESIS;
    for (const row of rows) {
      expect(row.prev_hash).toBe(prevHash);
      expect(row.row_hash).toBe(hashAuditRow(prevHash, row));
      prevHash = row.row_hash;
    }
  });

  test("creates only one demo tenant", () => {
    const db = openScratchDb();
    process.env.DEMO_SEED = "1";

    seedDemoData(db);
    seedDemoData(db);

    const rows = db.query(`SELECT id FROM tenants WHERE id = ?`).all(DEMO_TENANT_ID) as Array<{ id: string }>;
    expect(rows).toEqual([{ id: DEMO_TENANT_ID }]);
  });
});
