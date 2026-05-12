import { afterEach, beforeEach, expect, test } from "bun:test";
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
  "metric_samples",
  "events",
  "action_audit",
  "operator_state",
  "jobs",
  "workspace_sessions",
  "notification_rules",
  "channels_log",
  "report_archive",
  "content_health_findings",
  "source_stats",
  "runbooks",
  "builder_projects",
  "builder_workflows",
  "builder_runs",
  "builder_passes",
  "builder_artifacts",
  "builder_validations",
  "builder_locks",
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
    expect(version.version).toBe(2);
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
