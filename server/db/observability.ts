import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_OBSERVABILITY_DB_PATH = "/var/lib/control-surface/observability.db";

let observabilityDb: Database | null = null;
let observabilityDbPath: string | null = null;

export function getObservabilityDbPath(): string {
  return process.env.OBSERVABILITY_DB_PATH || DEFAULT_OBSERVABILITY_DB_PATH;
}

export function getObservabilityDb(): Database | null {
  return observabilityDb;
}

export function initObservabilityDb(path?: string): Database | null {
  const dbPath = path || getObservabilityDbPath();
  if (observabilityDb && observabilityDbPath === dbPath) {
    return observabilityDb;
  }

  closeObservabilityDb();

  let db: Database | null = null;

  try {
    const dbDir = dirname(dbPath);
    mkdirSync(dbDir, { recursive: true });
    chmodSync(dbDir, 0o750);

    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    migrateObservabilityDb(db);

    observabilityDb = db;
    observabilityDbPath = dbPath;
    const openedDb = observabilityDb;
    db = null;
    return openedDb;
  } catch (error) {
    console.error("[control-surface] observability SQLite initialization failed", error);
    if (db) {
      try {
        db.close();
      } catch (closeError) {
        console.error("[control-surface] observability SQLite close after failed init failed", closeError);
      }
    }
    closeObservabilityDb();
    return null;
  }
}

export function closeObservabilityDb(): void {
  if (!observabilityDb) {
    observabilityDbPath = null;
    return;
  }

  try {
    observabilityDb.close();
  } catch {
    // ignore
  }
  observabilityDb = null;
  observabilityDbPath = null;
}

function migrateObservabilityDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finance_runs (
      id TEXT PRIMARY KEY,
      run_at TEXT NOT NULL,
      duration_ms INTEGER,
      model_used TEXT NOT NULL,
      article_window_days INTEGER,
      articles_corpus TEXT,
      market_data TEXT,
      fred_data TEXT,
      llm_prompt TEXT,
      llm_response TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      insights_count INTEGER,
      insights_ticker INTEGER,
      insights_macro INTEGER,
      insights_anomaly INTEGER,
      portfolio_config_id TEXT,
      status TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS portfolio_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      risk_tolerance INTEGER NOT NULL DEFAULT 5,
      confidence_threshold REAL NOT NULL DEFAULT 0.60,
      timeframe_pref TEXT NOT NULL DEFAULT 'all',
      watchlist TEXT NOT NULL DEFAULT '[]',
      excluded_verticals TEXT NOT NULL DEFAULT '[]',
      article_window_days INTEGER NOT NULL DEFAULT 14,
      analyst_persona TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scout_runs (
      id TEXT PRIMARY KEY,
      run_at TEXT NOT NULL,
      trigger TEXT NOT NULL,
      topics_found INTEGER,
      topics_queued INTEGER,
      verticals_covered TEXT,
      trace_path TEXT,
      duration_ms INTEGER,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_configs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'operator'
    );

    CREATE TABLE IF NOT EXISTS config_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      changed_by TEXT NOT NULL DEFAULT 'operator',
      changed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS litellm_routing_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logged_at TEXT NOT NULL,
      logical_name TEXT NOT NULL,
      tried_models TEXT NOT NULL,
      final_model TEXT,
      total_latency_ms INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      caller TEXT,
      status TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS litellm_routing_log_logical ON litellm_routing_log(logical_name, logged_at);
    CREATE INDEX IF NOT EXISTS litellm_routing_log_status ON litellm_routing_log(status, logged_at);

    CREATE TABLE IF NOT EXISTS finance_enrichments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      article_slug TEXT NOT NULL,
      model_used TEXT NOT NULL,
      tickers_extracted TEXT,
      confidence REAL,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'ok'
    );

    CREATE INDEX IF NOT EXISTS finance_enrichments_slug ON finance_enrichments(article_slug, run_at);
  `);

  // Seed default portfolio if none exists
  const existing = db.query("SELECT 1 FROM portfolio_configs WHERE id = 'default'").get();
  if (!existing) {
    const now = new Date().toISOString();
    db.query(`
      INSERT INTO portfolio_configs (id, name, risk_tolerance, confidence_threshold, timeframe_pref, watchlist, excluded_verticals, article_window_days, analyst_persona, created_at, updated_at)
      VALUES ('default', 'Default', 5, 0.60, 'all', '[]', '[]', 14, NULL, ?, ?)
    `).run(now, now);
  }
}

// ── Typed query helpers ────────────────────────────────────────────────────

export interface FinanceRunRow {
  id: string;
  run_at: string;
  duration_ms: number | null;
  model_used: string;
  article_window_days: number | null;
  articles_corpus: string | null;
  market_data: string | null;
  fred_data: string | null;
  llm_prompt: string | null;
  llm_response: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  insights_count: number | null;
  insights_ticker: number | null;
  insights_macro: number | null;
  insights_anomaly: number | null;
  portfolio_config_id: string | null;
  status: string;
  error: string | null;
}

export function insertFinanceRun(db: Database, row: Omit<FinanceRunRow, "id"> & { id: string }): void {
  db.query(`
    INSERT INTO finance_runs (
      id, run_at, duration_ms, model_used, article_window_days, articles_corpus, market_data, fred_data,
      llm_prompt, llm_response, prompt_tokens, completion_tokens, insights_count, insights_ticker,
      insights_macro, insights_anomaly, portfolio_config_id, status, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.run_at, row.duration_ms, row.model_used, row.article_window_days, row.articles_corpus,
    row.market_data, row.fred_data, row.llm_prompt, row.llm_response, row.prompt_tokens,
    row.completion_tokens, row.insights_count, row.insights_ticker, row.insights_macro,
    row.insights_anomaly, row.portfolio_config_id, row.status, row.error
  );
}

export function updateFinanceRun(db: Database, id: string, updates: Partial<Omit<FinanceRunRow, "id">>): void {
  const keys = Object.keys(updates).filter(k => (updates as any)[k] !== undefined);
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = ?`).join(", ");
  const values = keys.map(k => (updates as any)[k]);
  db.query(`UPDATE finance_runs SET ${setClause} WHERE id = ?`).run(...values, id);
}

export function getFinanceRun(db: Database, id: string): FinanceRunRow | null {
  return db.query<FinanceRunRow, string>("SELECT * FROM finance_runs WHERE id = ?").get(id) ?? null;
}

export function listFinanceRuns(db: Database, limit = 50): FinanceRunRow[] {
  return db.query<FinanceRunRow, [number]>("SELECT * FROM finance_runs ORDER BY run_at DESC LIMIT ?").all(limit);
}

export interface PortfolioConfigRow {
  id: string;
  name: string;
  risk_tolerance: number;
  confidence_threshold: number;
  timeframe_pref: string;
  watchlist: string;
  excluded_verticals: string;
  article_window_days: number;
  analyst_persona: string | null;
  created_at: string;
  updated_at: string;
}

export function listPortfolioConfigs(db: Database): PortfolioConfigRow[] {
  return db.query<PortfolioConfigRow, []>("SELECT * FROM portfolio_configs ORDER BY created_at").all();
}

export function getPortfolioConfig(db: Database, id: string): PortfolioConfigRow | null {
  return db.query<PortfolioConfigRow, string>("SELECT * FROM portfolio_configs WHERE id = ?").get(id) ?? null;
}

export function upsertPortfolioConfig(db: Database, row: PortfolioConfigRow): void {
  db.query(`
    INSERT INTO portfolio_configs (id, name, risk_tolerance, confidence_threshold, timeframe_pref, watchlist, excluded_verticals, article_window_days, analyst_persona, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      risk_tolerance = excluded.risk_tolerance,
      confidence_threshold = excluded.confidence_threshold,
      timeframe_pref = excluded.timeframe_pref,
      watchlist = excluded.watchlist,
      excluded_verticals = excluded.excluded_verticals,
      article_window_days = excluded.article_window_days,
      analyst_persona = excluded.analyst_persona,
      updated_at = excluded.updated_at
  `).run(
    row.id, row.name, row.risk_tolerance, row.confidence_threshold, row.timeframe_pref, row.watchlist,
    row.excluded_verticals, row.article_window_days, row.analyst_persona, row.created_at, row.updated_at
  );
}

export function deletePortfolioConfig(db: Database, id: string): void {
  db.query("DELETE FROM portfolio_configs WHERE id = ? AND id != 'default'").run(id);
}

export interface ScoutRunRow {
  id: string;
  run_at: string;
  trigger: string;
  topics_found: number | null;
  topics_queued: number | null;
  verticals_covered: string | null;
  trace_path: string | null;
  duration_ms: number | null;
  status: string;
}

export function listScoutRuns(db: Database, limit = 50): ScoutRunRow[] {
  return db.query<ScoutRunRow, [number]>("SELECT * FROM scout_runs ORDER BY run_at DESC LIMIT ?").all(limit);
}

export function insertScoutRun(db: Database, row: ScoutRunRow): void {
  db.query(`
    INSERT INTO scout_runs (id, run_at, trigger, topics_found, topics_queued, verticals_covered, trace_path, duration_ms, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.run_at, row.trigger, row.topics_found, row.topics_queued, row.verticals_covered,
    row.trace_path, row.duration_ms, row.status
  );
}

export interface SystemConfigRow {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
  updated_by: string;
}

export function getSystemConfig(db: Database, key: string): SystemConfigRow | null {
  return db.query<SystemConfigRow, string>("SELECT * FROM system_configs WHERE key = ?").get(key) ?? null;
}

export function listSystemConfigs(db: Database): SystemConfigRow[] {
  return db.query<SystemConfigRow, []>("SELECT * FROM system_configs ORDER BY key").all();
}

export function upsertSystemConfig(db: Database, row: SystemConfigRow): void {
  db.query(`
    INSERT INTO system_configs (key, value, description, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      description = excluded.description,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(row.key, row.value, row.description, row.updated_at, row.updated_by);
}

export interface ConfigChangeRow {
  id: number;
  key: string;
  old_value: string | null;
  new_value: string;
  changed_by: string;
  changed_at: string;
}

export function insertConfigChange(db: Database, row: Omit<ConfigChangeRow, "id">): void {
  db.query(`
    INSERT INTO config_changes (key, old_value, new_value, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.key, row.old_value, row.new_value, row.changed_by, row.changed_at);
}

export function listConfigChanges(db: Database, limit = 50): ConfigChangeRow[] {
  return db.query<ConfigChangeRow, [number]>("SELECT * FROM config_changes ORDER BY changed_at DESC LIMIT ?").all(limit);
}

export interface LiteLLMRoutingLogRow {
  id: number;
  logged_at: string;
  logical_name: string;
  tried_models: string;
  final_model: string | null;
  total_latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  caller: string | null;
  status: string;
}

export function insertLiteLLMRoutingLog(db: Database, row: Omit<LiteLLMRoutingLogRow, "id">): void {
  db.query(`
    INSERT INTO litellm_routing_log (logged_at, logical_name, tried_models, final_model, total_latency_ms, prompt_tokens, completion_tokens, caller, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.logged_at, row.logical_name, row.tried_models, row.final_model, row.total_latency_ms,
    row.prompt_tokens, row.completion_tokens, row.caller, row.status
  );
}

export function listLiteLLMRoutingLogs(db: Database, limit = 200): LiteLLMRoutingLogRow[] {
  return db.query<LiteLLMRoutingLogRow, [number]>("SELECT * FROM litellm_routing_log ORDER BY logged_at DESC LIMIT ?").all(limit);
}

export interface FinanceEnrichmentRow {
  id: number;
  run_at: string;
  article_slug: string;
  model_used: string;
  tickers_extracted: string | null;
  confidence: number | null;
  duration_ms: number | null;
  status: string;
}

export function insertFinanceEnrichment(db: Database, row: Omit<FinanceEnrichmentRow, "id">): void {
  db.query(`
    INSERT INTO finance_enrichments (run_at, article_slug, model_used, tickers_extracted, confidence, duration_ms, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.run_at, row.article_slug, row.model_used, row.tickers_extracted, row.confidence, row.duration_ms, row.status
  );
}

export function listFinanceEnrichments(db: Database, limit = 200): FinanceEnrichmentRow[] {
  return db.query<FinanceEnrichmentRow, [number]>("SELECT * FROM finance_enrichments ORDER BY run_at DESC LIMIT ?").all(limit);
}
