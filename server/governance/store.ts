import { getDashboardDb } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant, tenantParams, withTenantInsert } from "../db/tenantScope.ts";
import type { TenantContext } from "../tenancy/context.ts";
import { randomUUID } from "node:crypto";

// Policy documents are stored on disk, not in the database
// But policy decisions are stored in the database and need tenant scoping

export interface PolicyDecisionRow {
  id: string;
  policy_id: string;
  event_type: string;
  effect: string;
  rule_name: string | null;
  reason: string;
  context_json: string;
  decided_at: number;
  tenant_id: string;
}

export function writePolicyDecision(
  policyId: string,
  eventType: string,
  effect: string,
  ruleName: string | null,
  reason: string,
  context: Record<string, unknown>,
  ctx?: TenantContext,
): void {
  const db = getDashboardDb();
  if (!db) return;

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const row = withTenantInsert(tenantCtx, {
    policy_id: policyId,
    event_type: eventType,
    effect,
    rule_name: ruleName,
    reason,
    context_json: JSON.stringify(context),
    decided_at: Date.now(),
  });

  db.query(
    `INSERT INTO governance_policy_decisions 
     (policy_id, event_type, effect, rule_name, reason, context_json, decided_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.policy_id,
    row.event_type,
    row.effect,
    row.rule_name,
    row.reason,
    row.context_json,
    row.decided_at,
    row.tenant_id,
  );
}

export function listPolicyDecisions(limit = 100, ctx?: TenantContext): PolicyDecisionRow[] {
  const db = getDashboardDb();
  if (!db) return [];

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause, params } = whereTenant(tenantCtx);

  const rows = db.query(
    `SELECT * FROM governance_policy_decisions WHERE 1=1 ${clause} ORDER BY decided_at DESC LIMIT ?`,
  ).all(...params, limit) as PolicyDecisionRow[];

  return rows;
}

// Role bindings
export interface RoleBindingRow {
  user_id: string;
  role: string;
  tenant_id: string;
}

export function writeRoleBinding(userId: string, role: string, ctx?: TenantContext): void {
  const db = getDashboardDb();
  if (!db) return;

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const row = withTenantInsert(tenantCtx, {
    user_id: userId,
    role,
  });

  db.query(
    `INSERT INTO governance_role_bindings (user_id, role, tenant_id)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`,
  ).run(row.user_id, row.role, row.tenant_id);
}

export function getRoleBindings(ctx?: TenantContext): RoleBindingRow[] {
  const db = getDashboardDb();
  if (!db) return [];

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause, params } = whereTenant(tenantCtx);

  const rows = db.query(
    `SELECT user_id, role, tenant_id FROM governance_role_bindings WHERE 1=1 ${clause}`,
  ).all(...params) as RoleBindingRow[];

  return rows;
}

export function deleteRoleBinding(userId: string, ctx?: TenantContext): void {
  const db = getDashboardDb();
  if (!db) return;

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause, params } = whereTenant(tenantCtx);

  db.query(
    `DELETE FROM governance_role_bindings WHERE user_id = ? ${clause}`,
  ).run(userId, ...params);
}