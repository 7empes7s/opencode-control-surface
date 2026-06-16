import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDashboardDb,
  getDashboardDb,
  initDashboardDb,
} from "./dashboard.ts";
import {
  createJob,
  finishJob,
  readActionAudit,
  readJob,
  readOperatorState,
  updateJobOutput,
  writeActionAudit,
  writeEvent,
  writeOperatorState,
} from "./writer.ts";

const expectedTables = [
  "schema_version",
  "tenants",
  "metric_samples",
  "events",
  "action_audit",
  "users",
  "local_account_credentials",
  "operator_state",
  "jobs",
  "workspace_sessions",
  "notification_rules",
  "channels_log",
  "report_archive",
  "content_health_findings",
  "insights",
  "source_stats",
  "runbooks",
  "builder_projects",
  "builder_workflows",
  "builder_runs",
  "builder_passes",
  "builder_artifacts",
  "builder_validations",
  "builder_locks",
  "marketplace_skills",
  "marketplace_skill_runs",
  "agents",
  "gateway_keys",
  "prompts",
  "webhooks",
  "webhook_deliveries",
];

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;

function registerDashboardDbTests(): void {
  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-db-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
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

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("migration creates all dashboard tables", () => {
    process.env.DASHBOARD_DB = "1";
    const db = initDashboardDb({ path: tempDbPath() });
    expect(db).not.toBeNull();

    const rows = getDashboardDb()!.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
    `).all() as Array<{ name: string }>;

    const tables = new Set(rows.map((row) => row.name));
    for (const table of expectedTables) {
      expect(tables.has(table)).toBe(true);
    }

    const version = getDashboardDb()!.query("SELECT version FROM schema_version").get() as { version: number };
    expect(version.version).toBe(10);
  });

  test("migration tolerates historical v5 and v6 schema_version rows", () => {
    process.env.DASHBOARD_DB = "1";
    const path = tempDbPath();
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (5, 1), (6, 2);
      CREATE TABLE insights (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        plain_summary TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        action_descriptor_id TEXT,
        manual_page_href TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        tenant_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        source_key TEXT
      );
      INSERT INTO insights (
        id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
        action_descriptor_id, manual_page_href, status, tenant_id, created_at, source_key
      ) VALUES (
        'insight-1', 'build', 'warn', 'Build signal', 'Summary', 0.8, '[]',
        NULL, '/reports', 'open', 'mimule', 100, 'seed'
      );
    `);
    seed.close();

    const db = initDashboardDb({ path });
    expect(db).not.toBeNull();

    const versions = getDashboardDb()!.query("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>;
    expect(versions.map((row) => row.version)).toEqual([10]);
    const columns = getDashboardDb()!.query("PRAGMA table_info(insights)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "resolved_at")).toBe(true);
  });

  test("operator_state write and read round-trips JSON values", () => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ path: tempDbPath() });

    const value = { theme: "dense", hiddenWidgets: ["vast", "models"] };
    writeOperatorState("dashboard:prefs", value);

    expect(readOperatorState("dashboard:prefs")).toEqual(value);
    expect(readOperatorState("missing")).toBeNull();
  });

  test("writeEvent ignores duplicate dedupe keys", () => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ path: tempDbPath() });

    writeEvent({
      kind: "service_state",
      severity: "warning",
      summary: "litellm restarted",
      dedupeKey: "service:litellm:restart",
    });
    writeEvent({
      kind: "service_state",
      severity: "warning",
      summary: "litellm restarted again",
      dedupeKey: "service:litellm:restart",
    });

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count FROM events WHERE dedupe_key = ?
    `).get("service:litellm:restart") as { count: number };

    expect(row.count).toBe(1);
  });

  test("jobs persist output tails and final status", () => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ path: tempDbPath() });

    createJob({
      id: "job-1",
      kind: "newsbites-deploy",
      targetType: "deploy",
      targetId: "newsbites",
      command: "deploy token=secret-value",
      request: { token: "secret-value" },
    });
    updateJobOutput("job-1", "line 1\nBearer abc123\n");
    finishJob("job-1", "success", { exitCode: 0 });

    const job = readJob("job-1");
    expect(job?.status).toBe("success");
    expect(job?.targetType).toBe("deploy");
    expect(job?.request).toEqual({ token: "[REDACTED]" });
    expect(job?.outputTail).toContain("Bearer [REDACTED]");
  });

  test("action audit persists V4 metadata", () => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ path: tempDbPath() });

    writeActionAudit({
      actionKind: "infra.service-restart",
      actionId: "start-job:service:control-surface:restart",
      targetType: "service",
      targetId: "control-surface",
      risk: "high",
      reason: "verify restart trace",
      request: { service: "control-surface", operatorToken: "secret" },
      resultStatus: "success",
      jobId: "job-1",
      rollbackHint: "check journal",
    });

    const rows = readActionAudit({ targetType: "service" });
    expect(rows).toHaveLength(1);
    expect(rows[0].actionId).toBe("start-job:service:control-surface:restart");
    expect(rows[0].request).toEqual({ service: "control-surface", operatorToken: "[REDACTED]" });
    expect(rows[0].rollbackHint).toBe("check journal");
  });

  test("DASHBOARD_DB unset leaves dashboard SQLite disabled and creates no file", () => {
    delete process.env.DASHBOARD_DB;
    const dbPath = tempDbPath();

    const db = initDashboardDb({ path: dbPath });

    expect(db).toBeNull();
    expect(getDashboardDb()).toBeNull();
    expect(existsSync(dbPath)).toBe(false);
  });

  test("fresh DB has tenant_id columns on all scoped tables and backfills to mimule", () => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ path: tempDbPath() });

    const db = getDashboardDb()!;
    const tenantTables = [
      "metric_samples", "events", "action_audit", "jobs", "operator_state",
      "users",
      "content_health_findings", "insights",
      "builder_projects", "builder_workflows", "builder_runs", "builder_passes",
      "builder_artifacts", "builder_validations", "builder_locks", "builder_doctor_reports",
      "governance_policies", "governance_policy_decisions", "governance_role_bindings",
      "governance_secrets", "governance_approvals", "governance_budgets",
      "gateway_calls",
      "reasoner_jobs", "reasoner_diagnoses", "reasoner_incidents",
      "reasoner_incident_members", "reasoner_playbooks", "reasoner_playbook_runs",
      "orchestrator_instances", "orchestrator_history", "orchestrator_signals", "orchestrator_lanes",
    ];

    for (const table of tenantTables) {
      const cols = db.query("PRAGMA table_info(" + table + ")").all() as Array<{ name: string }>;
      const hasTenantCol = cols.some((c) => c.name === "tenant_id");
      expect(hasTenantCol).toBeTrue();
    }
  });

  test("migration backfills tenant_id on pre-existing rows", () => {
    process.env.DASHBOARD_DB = "1";
    const dbPath = tempDbPath();

    // Create a fresh DB via migration first (full schema)
    initDashboardDb({ path: dbPath });
    const db = getDashboardDb()!;

    // Insert rows with null tenant_id to simulate pre-migration data
    db.run("INSERT INTO metric_samples (ts, source, key, value_json) VALUES (1000, 'svc', 'cpu', '80')");
    db.run("INSERT INTO events (ts, kind, severity, summary) VALUES (1000, 'svc', 'warn', 'restart')");
    db.run("INSERT INTO action_audit (ts, actor, action_kind) VALUES (1000, 'user', 'deploy')");
    db.run("INSERT INTO jobs (id, kind, state) VALUES ('j1', 'deploy', 'pending')");
    db.run("INSERT INTO operator_state (key, value_json, updated_at) VALUES ('key', '{}', 1000)");

    // Verify they have null tenant_id
    const nullCount = db.query(
      "SELECT COUNT(*) AS c FROM metric_samples WHERE tenant_id IS NULL"
    ).get() as { c: number };
    expect(nullCount.c).toBe(1);

    // Now simulate a second init (as would happen on server restart)
    closeDashboardDb();
    delete process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB_PATH = dbPath;
    initDashboardDb({ path: dbPath });

    const db2 = getDashboardDb()!;

    // Backfill should have set tenant_id = 'mimule' on all rows
    const backfillTables = [
      "metric_samples", "events", "action_audit", "jobs", "operator_state",
    ];

    for (const table of backfillTables) {
      const row = db2.query("SELECT tenant_id FROM " + table + " LIMIT 1").get() as { tenant_id: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe("mimule");
    }
  });

  test("tenant-leading indexes exist after migration", () => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ path: tempDbPath() });

    const db = getDashboardDb()!;
    const indexes = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%_tenant_%'"
    ).all() as Array<{ name: string }>;

    const indexNames = new Set(indexes.map((i) => i.name));
    const expectedIndexes = [
      "idx_metric_samples_tenant_ts",
      "idx_events_tenant_ts",
      "idx_action_audit_tenant_ts",
      "idx_jobs_tenant_ts",
      "idx_content_health_findings_tenant_ts",
      "idx_insights_tenant_created",
      "idx_insights_tenant_status_severity",
      "idx_builder_workflows_tenant_project",
      "idx_builder_runs_tenant_workflow",
      "idx_builder_passes_tenant_workflow",
      "idx_builder_artifacts_tenant_workflow",
      "idx_builder_validations_tenant_workflow",
      "idx_orchestrator_instances_tenant_status",
      "idx_reasoner_jobs_tenant_status",
      "idx_reasoner_incidents_tenant_status",
    ];

    for (const idx of expectedIndexes) {
      expect(indexNames.has(idx)).toBeTrue();
    }
  });
}

function tempDbPath(): string {
  return join(tempDir, "dashboard.sqlite");
}

try {
  registerDashboardDbTests();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (import.meta.main && message.includes("outside of the test runner")) {
    const result = Bun.spawnSync(["bun", "test", new URL(import.meta.url).pathname], {
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(result.exitCode);
  }

  throw error;
}
