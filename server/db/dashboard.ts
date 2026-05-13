import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DASHBOARD_DB_PATH = "/var/lib/control-surface/dashboard.sqlite";
export const DASHBOARD_SCHEMA_VERSION = 2;

type InitDashboardDbOptions = {
  enabled?: boolean;
  path?: string;
};

let dashboardDb: Database | null = null;
let dashboardDbPath: string | null = null;

export function isDashboardDbEnabled(enabled = process.env.DASHBOARD_DB === "1"): boolean {
  return enabled === true;
}

export function getDashboardDbPath(): string {
  return process.env.DASHBOARD_DB_PATH || DEFAULT_DASHBOARD_DB_PATH;
}

export function getDashboardDb(): Database | null {
  return dashboardDb;
}

export function initDashboardDb(options: InitDashboardDbOptions = {}): Database | null {
  const enabled = isDashboardDbEnabled(options.enabled);
  if (!enabled) {
    closeDashboardDb();
    return null;
  }

  const dbPath = options.path || getDashboardDbPath();
  if (dashboardDb && dashboardDbPath === dbPath) {
    return dashboardDb;
  }

  closeDashboardDb();

  let db: Database | null = null;

  try {
    const dbDir = dirname(dbPath);
    mkdirSync(dbDir, { recursive: true });
    chmodSync(dbDir, 0o750);

    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    migrateDashboardDb(db);

    dashboardDb = db;
    dashboardDbPath = dbPath;
    const openedDb = dashboardDb;
    db = null;
    return openedDb;
  } catch (error) {
    console.error("[control-surface] dashboard SQLite initialization failed", error);
    if (db) {
      try {
        db.close();
      } catch (closeError) {
        console.error("[control-surface] dashboard SQLite close after failed init failed", closeError);
      }
    }
    closeDashboardDb();
    return null;
  }
}

export function closeDashboardDb(): void {
  if (!dashboardDb) {
    dashboardDbPath = null;
    return;
  }

  try {
    dashboardDb.close();
  } catch (error) {
    console.error("[control-surface] dashboard SQLite close failed", error);
  } finally {
    dashboardDb = null;
    dashboardDbPath = null;
  }
}

function migrateDashboardDb(db: Database): void {
  const appliedAt = Date.now();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metric_samples (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metric_samples_source_key_ts
      ON metric_samples (source, key, ts);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      summary TEXT NOT NULL,
      payload_json TEXT,
      dedupe_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
    CREATE INDEX IF NOT EXISTS idx_events_kind_severity ON events (kind, severity);

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
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_audit_ts ON action_audit (ts);
    CREATE INDEX IF NOT EXISTS idx_action_audit_action_kind ON action_audit (action_kind);

    CREATE TABLE IF NOT EXISTS operator_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      ts INTEGER,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      actor TEXT,
      reason TEXT,
      target_type TEXT,
      target_id TEXT,
      command TEXT,
      request_json TEXT,
      evidence_json TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      output_tail TEXT,
      error TEXT,
      exit_code INTEGER,
      cancel_requested_at INTEGER,
      retry_of_job_id TEXT,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state);
    CREATE INDEX IF NOT EXISTS idx_jobs_kind ON jobs (kind);

    CREATE TABLE IF NOT EXISTS workspace_sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      cwd TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_rules (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      threshold_json TEXT,
      channels_json TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels_log (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channels_log_ts ON channels_log (ts);
    CREATE INDEX IF NOT EXISTS idx_channels_log_channel ON channels_log (channel);

    CREATE TABLE IF NOT EXISTS report_archive (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS content_health_findings (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      slug TEXT NOT NULL,
      finding TEXT NOT NULL,
      severity TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_content_health_findings_slug
      ON content_health_findings (slug);
    CREATE INDEX IF NOT EXISTS idx_content_health_findings_ts
      ON content_health_findings (ts);

    CREATE TABLE IF NOT EXISTS source_stats (
      slug TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      last_used INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runbooks (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS builder_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT NOT NULL UNIQUE,
      config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS builder_workflows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_file TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_id TEXT,
      next_run_at INTEGER,
      paused_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_builder_workflows_project
      ON builder_workflows (project_id);
    CREATE INDEX IF NOT EXISTS idx_builder_workflows_status
      ON builder_workflows (status);

    CREATE TABLE IF NOT EXISTS builder_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      current_pass_id TEXT,
      stop_requested_at INTEGER,
      stop_requested_by TEXT,
      result_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_builder_runs_workflow
      ON builder_runs (workflow_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_builder_runs_status
      ON builder_runs (status);

    CREATE TABLE IF NOT EXISTS builder_passes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      agent TEXT,
      provider TEXT,
      model TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      job_ids_json TEXT,
      validation_ids_json TEXT,
      artifact_ids_json TEXT,
      summary TEXT,
      next_instruction TEXT,
      failure_class TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_builder_passes_run
      ON builder_passes (run_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_builder_passes_workflow
      ON builder_passes (workflow_id, sequence);

    CREATE TABLE IF NOT EXISTS builder_artifacts (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      pass_id TEXT,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT,
      created_at INTEGER NOT NULL,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_builder_artifacts_run
      ON builder_artifacts (run_id, created_at);

    CREATE TABLE IF NOT EXISTS builder_validations (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      pass_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      command TEXT,
      url TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      output_tail TEXT,
      artifact_id TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_builder_validations_run
      ON builder_validations (run_id, started_at);

    CREATE TABLE IF NOT EXISTS builder_locks (
      project_root TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      holder TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS builder_doctor_reports (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT,
      pass_id TEXT,
      created_at INTEGER NOT NULL,
      project_root TEXT NOT NULL,
      plan_file TEXT NOT NULL,
      code_review_json TEXT,
      accessibility_json TEXT,
      performance_json TEXT,
      security_json TEXT,
      runtime_json TEXT,
      overall_score REAL NOT NULL,
      verdict TEXT NOT NULL,
      evidence_json TEXT,
      FOREIGN KEY (workflow_id) REFERENCES builder_workflows(id),
      FOREIGN KEY (run_id) REFERENCES builder_runs(id)
    );
  `);

  ensureColumn(db, "action_audit", "actor_source", "TEXT");
  ensureColumn(db, "action_audit", "action", "TEXT");
  ensureColumn(db, "action_audit", "action_id", "TEXT");
  ensureColumn(db, "action_audit", "reason", "TEXT");
  ensureColumn(db, "action_audit", "target_type", "TEXT");
  ensureColumn(db, "action_audit", "target_id", "TEXT");
  ensureColumn(db, "action_audit", "risk", "TEXT");
  ensureColumn(db, "action_audit", "request_json", "TEXT");
  ensureColumn(db, "action_audit", "result_status", "TEXT");
  ensureColumn(db, "action_audit", "result_json", "TEXT");
  ensureColumn(db, "action_audit", "evidence_json", "TEXT");
  ensureColumn(db, "action_audit", "job_id", "TEXT");
  ensureColumn(db, "action_audit", "event_id", "TEXT");
  ensureColumn(db, "action_audit", "rollback_hint", "TEXT");

  ensureColumn(db, "jobs", "ts", "INTEGER");
  ensureColumn(db, "jobs", "status", "TEXT");
  ensureColumn(db, "jobs", "actor", "TEXT");
  ensureColumn(db, "jobs", "reason", "TEXT");
  ensureColumn(db, "jobs", "target_type", "TEXT");
  ensureColumn(db, "jobs", "target_id", "TEXT");
  ensureColumn(db, "jobs", "command", "TEXT");
  ensureColumn(db, "jobs", "request_json", "TEXT");
  ensureColumn(db, "jobs", "evidence_json", "TEXT");
  ensureColumn(db, "jobs", "exit_code", "INTEGER");
  ensureColumn(db, "jobs", "cancel_requested_at", "INTEGER");
  ensureColumn(db, "jobs", "retry_of_job_id", "TEXT");
  ensureColumn(db, "jobs", "max_retries", "INTEGER NOT NULL DEFAULT 3");
  ensureColumn(db, "jobs", "retry_count", "INTEGER NOT NULL DEFAULT 0");

  ensureColumn(db, "builder_passes", "model_reason", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_action_audit_target ON action_audit (target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_action_audit_result_status ON action_audit (result_status);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
    CREATE INDEX IF NOT EXISTS idx_jobs_target ON jobs (target_type, target_id);
  `);

  db.query("INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)")
    .run(DASHBOARD_SCHEMA_VERSION, appliedAt);
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((row) => row.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
