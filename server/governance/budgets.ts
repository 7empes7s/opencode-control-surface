import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { randomUUID } from "node:crypto";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant, tenantParams } from "../db/tenantScope.ts";
import type { TenantContext } from "../tenancy/context.ts";

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
  pctUsed?: number;
  warn?: boolean;
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

export function checkBudget(scope: BudgetScope, projectId?: string, ctx?: TenantContext): BudgetCheckResult {
  if (!isDashboardDbEnabled()) return { allowed: true };
  const db = getDashboardDb();
  if (!db) return { allowed: true };

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause: tenantClause, params: tenantParams } = whereTenant(tenantCtx);

  const budgets = scope === "project"
    ? db.query(
      `SELECT * FROM governance_budgets WHERE scope = ? AND project_id = ? ${tenantClause}`,
    ).all(scope, projectId ?? "", ...tenantParams) as GovernanceBudget[]
    : db.query(
      `SELECT * FROM governance_budgets WHERE scope = ? ${tenantClause}`,
    ).all(scope, ...tenantParams) as GovernanceBudget[];

  if (!budgets.length) return { allowed: true };

  const budget = budgets[0];
  const now = Date.now();
  const dayStart = getStartOfDay();
  const monthStart = getStartOfMonth();

  const spending = getBudgetSpending(scope, projectId, tenantCtx);
  const daySpent = spending.daily;
  const monthSpent = spending.monthly;

  if (budget.daily_cap_usd != null && daySpent >= budget.daily_cap_usd) {
    return { allowed: false, reason: "Daily budget exceeded", period: "daily", cap: budget.daily_cap_usd, spent: daySpent };
  }
  if (budget.monthly_cap_usd != null && monthSpent >= budget.monthly_cap_usd) {
    return { allowed: false, reason: "Monthly budget exceeded", period: "monthly", cap: budget.monthly_cap_usd, spent: monthSpent };
  }

  const dayPct = budget.daily_cap_usd ? daySpent / budget.daily_cap_usd : 0;
  const monthPct = budget.monthly_cap_usd ? monthSpent / budget.monthly_cap_usd : 0;
  const pctUsed = Math.max(dayPct, monthPct);
  const warn = pctUsed >= (budget.warn_pct ?? 0.8);

  return { allowed: true, pctUsed, warn };
}

export function upsertBudget(
  scope: BudgetScope,
  opts: { dailyCapUsd?: number | null; monthlyCapUsd?: number | null; warnPct?: number; projectId?: string | null },
  ctx?: TenantContext,
): GovernanceBudget {
  const db = getDashboardDb()!;
  const now = Date.now();
  const tenantCtx = ctx ?? getCurrentTenantContext();
  const tenantId = tenantCtx.tenantId;
  const id = scope === "global" ? `global-${tenantId}` : `${opts.projectId ?? randomUUID()}-${tenantId}`;

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
    const row = {
      id,
      scope,
      project_id: opts.projectId ?? null,
      daily_cap_usd: opts.dailyCapUsd ?? null,
      monthly_cap_usd: opts.monthlyCapUsd ?? null,
      warn_pct: opts.warnPct ?? 0.8,
      created_at: now,
      updated_at: now,
      tenant_id: tenantId,
    };

    db.query(
      `INSERT INTO governance_budgets (id, scope, project_id, daily_cap_usd, monthly_cap_usd, warn_pct, created_at, updated_at, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.scope,
      row.project_id,
      row.daily_cap_usd,
      row.monthly_cap_usd,
      row.warn_pct,
      row.created_at,
      row.updated_at,
      row.tenant_id,
    );
  }

  return db.query("SELECT * FROM governance_budgets WHERE id = ?").get(id) as GovernanceBudget;
}

export function getBudgetSpending(scope: BudgetScope, projectId?: string, ctx?: TenantContext): { daily: number; monthly: number } {
  if (!isDashboardDbEnabled()) return { daily: 0, monthly: 0 };
  const db = getDashboardDb();
  if (!db) return { daily: 0, monthly: 0 };

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause: tenantClause, params: tenantParams } = whereTenant(tenantCtx);

  const dayStart = getStartOfDay();
  const monthStart = getStartOfMonth();

  if (scope === "project") {
    if (!projectId) return { daily: 0, monthly: 0 };
    try {
      const dayRow = db.query(
        `SELECT SUM(cost_cents) / 100.0 as total FROM cost_events WHERE ts >= ? AND project = ? ${tenantClause}`,
      ).get(dayStart, projectId, ...tenantParams) as { total: number | null };

      const monthRow = db.query(
        `SELECT SUM(cost_cents) / 100.0 as total FROM cost_events WHERE ts >= ? AND project = ? ${tenantClause}`,
      ).get(monthStart, projectId, ...tenantParams) as { total: number | null };

      return {
        daily: dayRow?.total ?? 0,
        monthly: monthRow?.total ?? 0,
      };
    } catch {
      return { daily: 0, monthly: 0 };
    }
  }

  const dayRow = db.query(
    `SELECT SUM(cost_estimate_usd) as total FROM gateway_calls WHERE ts >= ? ${tenantClause}`,
  ).get(dayStart, ...tenantParams) as { total: number | null };

  const monthRow = db.query(
    `SELECT SUM(cost_estimate_usd) as total FROM gateway_calls WHERE ts >= ? ${tenantClause}`,
  ).get(monthStart, ...tenantParams) as { total: number | null };

  return {
    daily: dayRow?.total ?? 0,
    monthly: monthRow?.total ?? 0,
  };
}
