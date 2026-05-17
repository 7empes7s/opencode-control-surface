import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkBudget, upsertBudget, getBudgetSpending } from "./budgets.ts";
import { getDashboardDb, initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";

const TEST_DB = "/tmp/test-budget-control-surface.db";

function setupTestDb() {
  rmSync(TEST_DB, { force: true });
  mkdirSync("/tmp", { recursive: true });
  chmodSync("/tmp", 0o755);
  return initDashboardDb({ enabled: true, path: TEST_DB });
}

describe("budgets", () => {
  let db: Database;

  beforeEach(() => {
    closeDashboardDb();
    process.env.DASHBOARD_DB = "1";
    db = setupTestDb()!;
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
    `);
    db.exec(`
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
  });

  afterEach(() => {
    closeDashboardDb();
    delete process.env.DASHBOARD_DB;
    rmSync(TEST_DB, { force: true });
  });

  it("allows when no budget is configured", () => {
    const result = checkBudget("global");
    expect(result.allowed).toBe(true);
  });

  it("denies when daily cap is exceeded", () => {
    const now = Date.now();
    db.query(`INSERT INTO gateway_calls (ts, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now - 1000, "test", "gemma", "litellm", "standard", 100, 100, 500, 5.0, 1);
    db.query(`INSERT INTO gateway_calls (ts, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now - 1000, "test", "gemma", "litellm", "standard", 100, 100, 500, 6.0, 1);

    upsertBudget("global", { dailyCapUsd: 10.0 });

    const budget = db.query("SELECT * FROM governance_budgets WHERE scope = 'global'").get();
    expect(budget).toBeTruthy();

    const result = checkBudget("global");
    expect(result.allowed).toBe(false);
    expect(result.period).toBe("daily");
  });

  it("denies when monthly cap is exceeded", () => {
    const now = Date.now();
    db.query(`INSERT INTO gateway_calls (ts, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now - 1000, "test", "gemma", "litellm", "standard", 100, 100, 500, 50.0, 1);

    upsertBudget("global", { monthlyCapUsd: 40.0 });

    const result = checkBudget("global");
    expect(result.allowed).toBe(false);
    expect(result.period).toBe("monthly");
  });

  it("allows when under cap", () => {
    const now = Date.now();
    db.query(`INSERT INTO gateway_calls (ts, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now - 1000, "test", "gemma", "litellm", "standard", 100, 100, 500, 2.0, 1);

    upsertBudget("global", { dailyCapUsd: 10.0, monthlyCapUsd: 100.0 });

    const result = checkBudget("global");
    expect(result.allowed).toBe(true);
  });

  it("gets correct spending totals", () => {
    const now = Date.now();
    db.query(`INSERT INTO gateway_calls (ts, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now - 1000, "test", "gemma", "litellm", "standard", 100, 100, 500, 3.0, 1);
    db.query(`INSERT INTO gateway_calls (ts, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      now - 1000, "test", "gemma", "litellm", "standard", 100, 100, 500, 7.0, 1);

    const spending = getBudgetSpending("global");
    expect(spending.daily).toBe(10.0);
    expect(spending.monthly).toBe(10.0);
  });
});