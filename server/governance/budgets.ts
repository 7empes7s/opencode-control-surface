import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { randomUUID } from "node:crypto";

export type BudgetScope = "global" | "project";

export type GovernanceBudget = {
  id: string;
  scope: BudgetScope;
  project_id: string | null;
  daily_cap_usd: number | null;
  monthly_cap_usd: number | null;
  warn_pct: number;
  created_at: number;
  updated_at: number;
};

export type BudgetCheckResult = {
  allowed: boolean;
  reason?: string;
  period?: "daily" | "monthly";
  cap?: number;
  spent?: number;
};

function getStartOfDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getStartOfMonth(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function checkBudget(scope: BudgetScope, projectId?: string): BudgetCheckResult {
  if (!isDashboardDbEnabled()) return { allowed: true };
  const db = getDashboardDb();
  if (!db) return { allowed: true };

  const budgets = db.query(
    "SELECT * FROM governance_budgets WHERE scope = ?",
  ).all(scope) as GovernanceBudget[];

  if (!budgets.length) return { allowed: true };

  const budget = budgets[0];
  const now = Date.now();
  const dayStart = getStartOfDay();
  const monthStart = getStartOfMonth();

  const dayRow = db.query(
    `SELECT SUM(cost_estimate_usd) as total FROM gateway_calls WHERE ts >= ?`,
  ).get(dayStart) as { total: number | null };

  const monthRow = db.query(
    `SELECT SUM(cost_estimate_usd) as total FROM gateway_calls WHERE ts >= ?`,
  ).get(monthStart) as { total: number | null };

  const daySpent = dayRow?.total ?? 0;
  const monthSpent = monthRow?.total ?? 0;

  if (budget.daily_cap_usd != null && daySpent >= budget.daily_cap_usd) {
    return { allowed: false, reason: "Daily budget exceeded", period: "daily", cap: budget.daily_cap_usd, spent: daySpent };
  }
  if (budget.monthly_cap_usd != null && monthSpent >= budget.monthly_cap_usd) {
    return { allowed: false, reason: "Monthly budget exceeded", period: "monthly", cap: budget.monthly_cap_usd, spent: monthSpent };
  }

  return { allowed: true };
}

export function upsertBudget(
  scope: BudgetScope,
  opts: { dailyCapUsd?: number | null; monthlyCapUsd?: number | null; warnPct?: number; projectId?: string | null },
): GovernanceBudget {
  const db = getDashboardDb()!;
  const now = Date.now();
  const id = scope === "global" ? "global" : (opts.projectId ?? randomUUID());

  const existing = db.query("SELECT id FROM governance_budgets WHERE id = ?").get(id);
  if (existing) {
    db.query(
      `UPDATE governance_budgets SET daily_cap_usd = ?, monthly_cap_usd = ?, warn_pct = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      opts.dailyCapUsd ?? null,
      opts.monthlyCapUsd ?? null,
      opts.warnPct ?? 0.8,
      now,
      id,
    );
  } else {
    db.query(
      `INSERT INTO governance_budgets (id, scope, project_id, daily_cap_usd, monthly_cap_usd, warn_pct, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, scope, opts.projectId ?? null, opts.dailyCapUsd ?? null, opts.monthlyCapUsd ?? null, opts.warnPct ?? 0.8, now, now);
  }

  return db.query("SELECT * FROM governance_budgets WHERE id = ?").get(id) as GovernanceBudget;
}

export function getBudgetSpending(scope: BudgetScope, projectId?: string): { daily: number; monthly: number } {
  if (!isDashboardDbEnabled()) return { daily: 0, monthly: 0 };
  const db = getDashboardDb();
  if (!db) return { daily: 0, monthly: 0 };

  const dayStart = getStartOfDay();
  const monthStart = getStartOfMonth();

  const dayRow = db.query(
    `SELECT SUM(cost_estimate_usd) as total FROM gateway_calls WHERE ts >= ?`,
  ).get(dayStart) as { total: number | null };

  const monthRow = db.query(
    `SELECT SUM(cost_estimate_usd) as total FROM gateway_calls WHERE ts >= ?`,
  ).get(monthStart) as { total: number | null };

  return {
    daily: dayRow?.total ?? 0,
    monthly: monthRow?.total ?? 0,
  };
}