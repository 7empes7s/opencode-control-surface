import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DASHBOARD_DB_PATH = "/var/lib/control-surface/dashboard.sqlite";
export const DASHBOARD_SCHEMA_VERSION = 3;

type InitDashboardDbOptions = {
  enabled?: boolean;
  path?: string;
};

let dashboardDb: Database | null = null;
let dashboardDbPath: string | null = null;

export function isDashboardDbEnabled(enabled?: boolean): boolean {
  if (enabled !== undefined) return enabled === true;
  return process.env.DASHBOARD_DB === "1";
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
    db.exec("PRAGMA busy_timeout = 5000;");
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

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT,
      repo_path TEXT,
      language TEXT,
      framework TEXT,
      validator_commands_json TEXT,
      default_model_roster_json TEXT,
      default_policies_json TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_projects_tenant_id
      ON projects (tenant_id);

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

    CREATE TABLE IF NOT EXISTS project_locks (
      project_root TEXT PRIMARY KEY,
      locked_by TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      reason TEXT
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS sso_configs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT UNIQUE,
      provider_kind TEXT NOT NULL,
      issuer TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret_enc TEXT NOT NULL,
      redirect_uri TEXT,
      scopes_json TEXT,
      group_mapping_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sso_configs_tenant ON sso_configs (tenant_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_configs_tenant_unique ON sso_configs (tenant_id);

    CREATE TABLE IF NOT EXISTS sso_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      sub TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL,
      groups_json TEXT,
      access_token_enc TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sso_sessions_tenant ON sso_sessions (tenant_id);
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
  ensureColumn(db, "builder_passes", "next_instruction", "TEXT");
  ensureColumn(db, "builder_passes", "analytics_json", "TEXT");
  ensureColumn(db, "builder_passes", "plan_items_done", "INTEGER");
  ensureColumn(db, "builder_passes", "plan_items_remaining", "INTEGER");
  ensureColumn(db, "builder_passes", "completion_percent", "INTEGER");
  ensureColumn(db, "builder_passes", "trace_id", "TEXT");
   ensureColumn(db, "builder_runs", "trace_id", "TEXT");
    ensureColumn(db, "builder_runs", "orchestrator_instance_id", "TEXT");
    ensureColumn(db, "action_audit", "prev_hash", "TEXT");
  ensureColumn(db, "action_audit", "row_hash", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      loaded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS governance_policy_decisions (
      id INTEGER PRIMARY KEY,
      policy_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      effect TEXT NOT NULL,
      rule_name TEXT,
      reason TEXT,
      context_json TEXT,
      decided_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gov_policy_decisions_ts ON governance_policy_decisions (decided_at);
    CREATE INDEX IF NOT EXISTS idx_gov_policy_decisions_policy ON governance_policy_decisions (policy_id);
    CREATE TABLE IF NOT EXISTS governance_role_bindings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      project_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gov_role_bindings_user ON governance_role_bindings (user_id);
    CREATE TABLE IF NOT EXISTS governance_secrets (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      encrypted_value TEXT NOT NULL,
      encrypted_dek TEXT NOT NULL,
      iv TEXT NOT NULL,
      key_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS governance_approvals (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tenant_id TEXT,
      requested_at INTEGER NOT NULL,
      requested_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approvals_json TEXT NOT NULL DEFAULT '[]',
      required_count INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER,
      decided_at INTEGER,
      decided_by TEXT,
      decision TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS governance_approval_votes (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      voter TEXT NOT NULL,
      decision TEXT NOT NULL,
      comment TEXT,
      voted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS governance_budgets (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      daily_cap_usd REAL,
      monthly_cap_usd REAL,
      warn_pct REAL NOT NULL DEFAULT 0.8,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_audit_export_jobs_tenant ON audit_export_jobs (tenant_id, status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id TEXT PRIMARY KEY,
      data_residency_region TEXT,
      storage_root TEXT,
      audit_retention_days INTEGER,
      require_two_approvers INTEGER DEFAULT 0,
      sso_required INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS report_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      template_id TEXT,
      params_json TEXT,
      status TEXT,
      output_json TEXT,
      row_count INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_calls (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      logical_model TEXT NOT NULL,
      resolved_model TEXT NOT NULL,
      backend TEXT NOT NULL,
      tier TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      latency_ms INTEGER,
      cost_estimate_usd REAL,
      success INTEGER NOT NULL DEFAULT 1,
      error_class TEXT,
      trace_id TEXT,
      caller TEXT
    );
CREATE INDEX IF NOT EXISTS idx_gateway_calls_ts ON gateway_calls (ts);
    CREATE INDEX IF NOT EXISTS idx_gateway_calls_model ON gateway_calls (logical_model, ts);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reasoner_jobs (
      id TEXT PRIMARY KEY,
      pass_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reasoner_jobs_status ON reasoner_jobs (status);
    CREATE INDEX IF NOT EXISTS idx_reasoner_jobs_created ON reasoner_jobs (created_at);

    CREATE TABLE IF NOT EXISTS reasoner_diagnoses (
      id TEXT PRIMARY KEY,
      pass_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      failure_class TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      suggested_actions_json TEXT NOT NULL,
      confidence TEXT NOT NULL,
      raw_llm_response TEXT,
      diagnosed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reasoner_diagnoses_pass ON reasoner_diagnoses (pass_id);
    CREATE INDEX IF NOT EXISTS idx_reasoner_diagnoses_run ON reasoner_diagnoses (run_id);

    CREATE TABLE IF NOT EXISTS reasoner_incidents (
      id TEXT PRIMARY KEY,
      cluster_key TEXT NOT NULL UNIQUE,
      failure_class TEXT NOT NULL,
      title TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      representative_pass_id TEXT NOT NULL,
      representative_diagnosis_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_reasoner_incidents_status ON reasoner_incidents (status);
    CREATE INDEX IF NOT EXISTS idx_reasoner_incidents_occurrence ON reasoner_incidents (occurrence_count);

    CREATE TABLE IF NOT EXISTS reasoner_incident_members (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      pass_id TEXT NOT NULL,
      diagnosis_id TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reasoner_incident_members_incident ON reasoner_incident_members (incident_id);
    CREATE INDEX IF NOT EXISTS idx_reasoner_incident_members_pass ON reasoner_incident_members (pass_id);

    CREATE TABLE IF NOT EXISTS reasoner_playbooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      failure_class_pattern TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      is_safe INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reasoner_playbook_runs (
      id TEXT PRIMARY KEY,
      playbook_id TEXT NOT NULL,
      incident_id TEXT,
      pass_id TEXT,
      triggered_by TEXT NOT NULL,
      actions_applied_json TEXT NOT NULL,
      result TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reasoner_playbook_runs_playbook ON reasoner_playbook_runs (playbook_id);
    CREATE INDEX IF NOT EXISTS idx_reasoner_playbook_runs_incident ON reasoner_playbook_runs (incident_id);

    CREATE TABLE IF NOT EXISTS orchestrator_instances (
      id TEXT PRIMARY KEY,
      definition_name TEXT NOT NULL,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step_index INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orchestrator_instances_status ON orchestrator_instances (status);
    CREATE INDEX IF NOT EXISTS idx_orchestrator_instances_workflow ON orchestrator_instances (workflow_id);

    CREATE TABLE IF NOT EXISTS orchestrator_history (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orchestrator_history_instance ON orchestrator_history (instance_id, step_index);

    CREATE TABLE IF NOT EXISTS orchestrator_signals (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      signal_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orchestrator_signals_instance ON orchestrator_signals (instance_id, signal_name, delivered);

    CREATE TABLE IF NOT EXISTS orchestrator_lanes (
      id TEXT PRIMARY KEY,
      lane_name TEXT NOT NULL UNIQUE,
      max_concurrency INTEGER NOT NULL DEFAULT 3,
      active_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketplace_skills (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      kind TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      bundle_path TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      error_message TEXT,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );
    CREATE INDEX IF NOT EXISTS idx_marketplace_skills_tenant ON marketplace_skills (tenant_id, status);

    CREATE TABLE IF NOT EXISTS marketplace_skill_runs (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      output_json TEXT,
      error TEXT,
      FOREIGN KEY (skill_id) REFERENCES marketplace_skills(id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );
    CREATE INDEX IF NOT EXISTS idx_marketplace_skill_runs_skill ON marketplace_skill_runs (skill_id, started_at DESC);

    -- Cost Management Tables
    CREATE TABLE IF NOT EXISTS cost_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      logical_model TEXT,
      provider TEXT,
      tier TEXT NOT NULL,
      workflow_type TEXT,
      workflow_id TEXT,
      project TEXT,
      article_slug TEXT,
      dossier_id TEXT,
      builder_run_id TEXT,
      gateway_call_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_cents REAL NOT NULL DEFAULT 0,
      cost_basis TEXT NOT NULL,
      fallback_reason TEXT,
      metadata_json TEXT,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cost_events_ts ON cost_events (ts);
    CREATE INDEX IF NOT EXISTS idx_cost_events_scope ON cost_events (workflow_type, workflow_id);
    CREATE INDEX IF NOT EXISTS idx_cost_events_model ON cost_events (logical_model, ts);
    CREATE INDEX IF NOT EXISTS idx_cost_events_article ON cost_events (article_slug);
    CREATE INDEX IF NOT EXISTS idx_cost_events_tenant_ts ON cost_events (tenant_id, ts);

    CREATE TABLE IF NOT EXISTS provider_price_catalog (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      logical_model TEXT,
      tier TEXT NOT NULL,
      input_cents_per_1k REAL,
      output_cents_per_1k REAL,
      hourly_cents REAL,
      effective_from INTEGER NOT NULL,
      effective_to INTEGER,
      source_note TEXT,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );
    CREATE INDEX IF NOT EXISTS idx_price_catalog_provider_model ON provider_price_catalog (provider, logical_model);
    CREATE INDEX IF NOT EXISTS idx_price_catalog_tenant_provider ON provider_price_catalog (tenant_id, provider);

    CREATE TABLE IF NOT EXISTS spend_anomalies (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      baseline_cents REAL NOT NULL,
      observed_cents REAL NOT NULL,
      multiplier REAL NOT NULL,
      status TEXT NOT NULL,
      alert_firing_id TEXT,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );
    CREATE INDEX IF NOT EXISTS idx_spend_anomalies_ts_status ON spend_anomalies (ts, status);
    CREATE INDEX IF NOT EXISTS idx_spend_anomalies_tenant_ts ON spend_anomalies (tenant_id, ts);
  `);

  // Add columns to tables created above (must run after CREATE TABLE)
  ensureColumn(db, "orchestrator_instances", "parent_instance_id", "TEXT");

  // ── Phase 2: tenant_id columns ──────────────────────────────────────────
  // Core telemetry / ops tables
  ensureColumn(db, "metric_samples", "tenant_id", "TEXT");
  ensureColumn(db, "events", "tenant_id", "TEXT");
  ensureColumn(db, "action_audit", "tenant_id", "TEXT");
  ensureColumn(db, "jobs", "tenant_id", "TEXT");
  ensureColumn(db, "operator_state", "tenant_id", "TEXT");

  // Builder tables
  ensureColumn(db, "builder_projects", "tenant_id", "TEXT");
  ensureColumn(db, "builder_workflows", "tenant_id", "TEXT");
  ensureColumn(db, "builder_runs", "tenant_id", "TEXT");
  ensureColumn(db, "builder_passes", "tenant_id", "TEXT");
  ensureColumn(db, "builder_artifacts", "tenant_id", "TEXT");
  ensureColumn(db, "builder_validations", "tenant_id", "TEXT");
  ensureColumn(db, "builder_locks", "tenant_id", "TEXT");
  ensureColumn(db, "builder_doctor_reports", "tenant_id", "TEXT");

  // Governance tables
  ensureColumn(db, "governance_policies", "tenant_id", "TEXT");
  ensureColumn(db, "governance_policy_decisions", "tenant_id", "TEXT");
  ensureColumn(db, "governance_role_bindings", "tenant_id", "TEXT");
  ensureColumn(db, "governance_secrets", "tenant_id", "TEXT");
  ensureColumn(db, "governance_approvals", "tenant_id", "TEXT");
  ensureColumn(db, "governance_approvals", "status", "TEXT");
  ensureColumn(db, "governance_approvals", "approvals_json", "TEXT");
  ensureColumn(db, "governance_approvals", "required_count", "INTEGER");
  ensureColumn(db, "governance_approvals", "expires_at", "INTEGER");
  ensureColumn(db, "governance_approval_votes", "id", "TEXT");
  ensureColumn(db, "governance_approval_votes", "request_id", "TEXT");
  ensureColumn(db, "governance_approval_votes", "voter", "TEXT");
  ensureColumn(db, "governance_approval_votes", "decision", "TEXT");
  ensureColumn(db, "governance_approval_votes", "comment", "TEXT");
  ensureColumn(db, "governance_approval_votes", "voted_at", "INTEGER");
  ensureColumn(db, "governance_budgets", "tenant_id", "TEXT");

  // Audit export jobs
  ensureColumn(db, "audit_export_jobs", "tenant_id", "TEXT");
  ensureColumn(db, "audit_export_jobs", "requested_by", "TEXT");
  ensureColumn(db, "audit_export_jobs", "from_ts", "INTEGER");
  ensureColumn(db, "audit_export_jobs", "to_ts", "INTEGER");
  ensureColumn(db, "audit_export_jobs", "format", "TEXT");
  ensureColumn(db, "audit_export_jobs", "status", "TEXT");
  ensureColumn(db, "audit_export_jobs", "row_count", "INTEGER");
  ensureColumn(db, "audit_export_jobs", "chain_hash", "TEXT");
  ensureColumn(db, "audit_export_jobs", "output_path", "TEXT");
  ensureColumn(db, "audit_export_jobs", "error", "TEXT");
  ensureColumn(db, "audit_export_jobs", "started_at", "INTEGER");
  ensureColumn(db, "audit_export_jobs", "finished_at", "INTEGER");

  // Tenant settings
  ensureColumn(db, "tenant_settings", "data_residency_region", "TEXT");
  ensureColumn(db, "tenant_settings", "storage_root", "TEXT");
  ensureColumn(db, "tenant_settings", "audit_retention_days", "INTEGER");
  ensureColumn(db, "tenant_settings", "require_two_approvers", "INTEGER");
  ensureColumn(db, "tenant_settings", "sso_required", "INTEGER");
  ensureColumn(db, "tenant_settings", "updated_at", "INTEGER");

  // Gateway
  ensureColumn(db, "gateway_calls", "tenant_id", "TEXT");

  // Reasoner tables
  ensureColumn(db, "reasoner_jobs", "tenant_id", "TEXT");
  ensureColumn(db, "reasoner_diagnoses", "tenant_id", "TEXT");
  ensureColumn(db, "reasoner_incidents", "tenant_id", "TEXT");
  ensureColumn(db, "reasoner_incident_members", "tenant_id", "TEXT");
  ensureColumn(db, "reasoner_playbooks", "tenant_id", "TEXT");
  ensureColumn(db, "reasoner_playbook_runs", "tenant_id", "TEXT");

  // Orchestrator tables
  ensureColumn(db, "orchestrator_instances", "tenant_id", "TEXT");
  ensureColumn(db, "orchestrator_history", "tenant_id", "TEXT");
  ensureColumn(db, "orchestrator_signals", "tenant_id", "TEXT");
  ensureColumn(db, "orchestrator_lanes", "tenant_id", "TEXT");

  // ── Phase 2: backfill null tenant_id to "mimule" ────────────────────────
  const TENANT_BACKFILL_TABLES = [
    "metric_samples", "events", "action_audit", "jobs", "operator_state",
    "builder_projects", "builder_workflows", "builder_runs", "builder_passes",
    "builder_artifacts", "builder_validations", "builder_locks", "builder_doctor_reports",
    "governance_policies", "governance_policy_decisions", "governance_role_bindings",
    "governance_secrets", "governance_approvals", "governance_budgets",
    "gateway_calls",
    "cost_events", "provider_price_catalog", "spend_anomalies",
    "reasoner_jobs", "reasoner_diagnoses", "reasoner_incidents",
    "reasoner_incident_members", "reasoner_playbooks", "reasoner_playbook_runs",
    "orchestrator_instances", "orchestrator_history", "orchestrator_signals", "orchestrator_lanes",
  ];
  for (const tbl of TENANT_BACKFILL_TABLES) {
    db.run(`UPDATE ${tbl} SET tenant_id = 'mimule' WHERE tenant_id IS NULL`);
  }

  // ── Phase 2: tenant-leading indexes ─────────────────────────────────────
  // Telemetry / audit / job tables: (tenant_id, ts)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_metric_samples_tenant_ts
      ON metric_samples (tenant_id, ts);
    CREATE INDEX IF NOT EXISTS idx_events_tenant_ts
      ON events (tenant_id, ts);
    CREATE INDEX IF NOT EXISTS idx_action_audit_tenant_ts
      ON action_audit (tenant_id, ts);
    CREATE INDEX IF NOT EXISTS idx_jobs_tenant_ts
      ON jobs (tenant_id, ts);
  `);

  // Builder: (tenant_id, project_id) on workflows
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_builder_workflows_tenant_project
      ON builder_workflows (tenant_id, project_id);
  `);

  // Builder: (tenant_id, workflow_id) on runs/passes/artifacts/validations
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_builder_runs_tenant_workflow
      ON builder_runs (tenant_id, workflow_id);
    CREATE INDEX IF NOT EXISTS idx_builder_passes_tenant_workflow
      ON builder_passes (tenant_id, workflow_id);
    CREATE INDEX IF NOT EXISTS idx_builder_artifacts_tenant_workflow
      ON builder_artifacts (tenant_id, workflow_id);
    CREATE INDEX IF NOT EXISTS idx_builder_validations_tenant_workflow
      ON builder_validations (tenant_id, workflow_id);
  `);

  // Cost Management: (tenant_id, ts)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cost_events_tenant_ts
      ON cost_events (tenant_id, ts);
    CREATE INDEX IF NOT EXISTS idx_provider_price_catalog_tenant_ts
      ON provider_price_catalog (tenant_id, effective_from);
    CREATE INDEX IF NOT EXISTS idx_spend_anomalies_tenant_ts
      ON spend_anomalies (tenant_id, ts);
  `);

  // Orchestrator / reasoner: (tenant_id, status)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orchestrator_instances_tenant_status
      ON orchestrator_instances (tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_reasoner_jobs_tenant_status
      ON reasoner_jobs (tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_reasoner_incidents_tenant_status
      ON reasoner_incidents (tenant_id, status);
  `);

  // Seed default tenant
  const now = Date.now();
  db.query("INSERT OR IGNORE INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("mimule", "MIMULE", "active", now, now);

  db.query("INSERT OR IGNORE INTO tenant_settings (tenant_id, updated_at) VALUES (?, ?)")
    .run("mimule", now);

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
