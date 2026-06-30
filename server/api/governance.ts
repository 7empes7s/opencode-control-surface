import { loadPolicyDocument, evaluatePolicy } from "../governance/policy.ts";
import {
  ROLE_PERMISSIONS,
  ensureRoleBindingRole,
  getAllowedActions,
  getRoleForRequest,
  getUserIdForRequest,
  requireOwner,
  requirePermission,
  type RbacRole,
} from "../governance/rbac.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { randomUUID } from "node:crypto";
import { writeSecret, readSecretPlaintext, listSecrets, deleteSecret } from "../governance/secrets.ts";
import { checkBudget, upsertBudget, getBudgetSpending } from "../governance/budgets.ts";
import { getRetentionPolicy, setRetentionPolicy } from "../governance/retention.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { getRoleBinding, upsertRoleBinding } from "../governance/store.ts";
import { writeActionAudit } from "../db/writer.ts";

const DEFAULT_POLICY_PATH = "/etc/tib-builder/policies/default.yaml";
let loadedPolicies: Awaited<ReturnType<typeof loadPolicyDocument>>[] = [];

type UserColumn = "id" | "email" | "name" | "tenant_id" | "created_at" | "last_seen" | "last_seen_at" | "updated_at";
type GovernanceUserRow = {
  id: string;
  email?: string | null;
  name?: string | null;
  tenant_id?: string | null;
  created_at?: number | null;
  last_seen?: number | null;
  last_seen_at?: number | null;
  updated_at?: number | null;
  role?: string | null;
};

const SAFE_USER_COLUMNS: UserColumn[] = ["id", "email", "name", "tenant_id", "created_at", "last_seen", "last_seen_at", "updated_at"];

function envelope<T extends Record<string, unknown>>(data: T, status = 200): Response {
  return Response.json({ data, ...data }, { status });
}

function availableUserColumns(): Set<string> {
  const db = getDashboardDb();
  if (!db) return new Set();
  const rows = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function selectedUserColumns(columns: Set<string>): UserColumn[] {
  return SAFE_USER_COLUMNS.filter((column) => columns.has(column));
}

function userDisplayName(row: GovernanceUserRow): string | null {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const email = typeof row.email === "string" ? row.email.trim() : "";
  return name || email || null;
}

function lastSeenFromRow(row: GovernanceUserRow): number | null {
  if (typeof row.last_seen === "number") return row.last_seen;
  if (typeof row.last_seen_at === "number") return row.last_seen_at;
  if (typeof row.updated_at === "number") return row.updated_at;
  return null;
}

function ownerCountForTenant(tenantId: string): number {
  const db = getDashboardDb();
  if (!db) return 0;
  const row = db.query(
    `SELECT COUNT(*) AS count
     FROM governance_role_bindings
     WHERE tenant_id = ? AND role = 'owner'`,
  ).get(tenantId) as { count: number } | null;
  return row?.count ?? 0;
}

export async function loadPolicies() {
  loadedPolicies = [];
  const doc = await loadPolicyDocument(DEFAULT_POLICY_PATH);
  if (doc) loadedPolicies.push(doc);
}

export function getGovernanceRole(req: Request): string {
  return getRoleForRequest(req);
}

export function requireRole(action: string) {
  return (req: Request) => {
    return requirePermission(req, action);
  };
}

export async function governancePoliciesHandler(): Promise<Response> {
  await loadPolicies();
  const db = getDashboardDb();
  const decisions = db
    ? db
        .query("SELECT COUNT(*) as count FROM governance_policy_decisions")
        .all()
        .pop()
    : { count: 0 };

  return Response.json({
    policies: loadedPolicies.map((p) => ({
      name: p.name,
      version: p.version,
      ruleCount: p.rules.length,
      path: DEFAULT_POLICY_PATH,
    })),
    decisionCount: (decisions as { count: number }).count,
  });
}

export async function governancePoliciesReloadHandler(): Promise<Response> {
  await loadPolicies();
  return Response.json({ ok: true, count: loadedPolicies.length });
}

export async function governanceRbacMeHandler(req: Request): Promise<Response> {
  const role = getGovernanceRole(req);
  return Response.json({
    role,
    allowedActions: getAllowedActions(role as "owner" | "operator" | "auditor" | "viewer"),
  });
}

export async function governanceUsersHandler(req: Request): Promise<Response> {
  const roleErr = requirePermission(req, "audit.view");
  if (roleErr) return roleErr;
  const db = getDashboardDb();
  if (!db) return envelope({ users: [], currentRole: getRoleForRequest(req) });

  const ctx = getCurrentTenantContext();
  const columns = selectedUserColumns(availableUserColumns());
  if (!columns.includes("id")) return envelope({ users: [], currentRole: getRoleForRequest(req) });

  const selectColumns = columns.map((column) => `u.${column}`).join(", ");
  const orderColumn = columns.includes("created_at") ? "u.created_at DESC" : "u.id ASC";
  const rows = db.query(
    `SELECT ${selectColumns}, b.role
     FROM users u
     LEFT JOIN governance_role_bindings b
       ON b.user_id = u.id
      AND b.tenant_id = COALESCE(u.tenant_id, ?)
     ORDER BY ${orderColumn}`,
  ).all(ctx.tenantId) as GovernanceUserRow[];

  return envelope({
    users: rows.map((row) => {
      const tenantId = row.tenant_id ?? ctx.tenantId;
      return {
        id: row.id,
        displayName: userDisplayName(row),
        email: row.email ?? null,
        role: ensureRoleBindingRole(row.role ?? "") ?? "viewer",
        tenantId,
        lastSeen: lastSeenFromRow(row),
        createdAt: row.created_at ?? null,
      };
    }),
    currentRole: getRoleForRequest(req),
  });
}

export async function rbacMatrixHandler(req: Request): Promise<Response> {
  const roleErr = requirePermission(req, "audit.view");
  if (roleErr) return roleErr;
  return envelope({ roles: Object.keys(ROLE_PERMISSIONS), matrix: ROLE_PERMISSIONS });
}

export async function governanceUserRoleHandler(req: Request, userId: string): Promise<Response> {
  const roleErr = requireOwner(req);
  if (roleErr) return roleErr;
  const db = getDashboardDb();
  if (!db) return envelope({ error: "db not available" }, 500);

  let body: { role?: unknown; tenantId?: unknown };
  try {
    body = await req.json() as { role?: unknown; tenantId?: unknown };
  } catch {
    return envelope({ error: "Choose owner, operator, auditor, or viewer." }, 400);
  }

  const role = ensureRoleBindingRole(typeof body.role === "string" ? body.role : "");
  if (!role) return envelope({ error: "Choose owner, operator, auditor, or viewer." }, 400);

  const ctx = getCurrentTenantContext();
  const tenantId = typeof body.tenantId === "string" && body.tenantId.trim() ? body.tenantId.trim() : ctx.tenantId;
  const user = db.query(
    `SELECT id, email, name, tenant_id
     FROM users
     WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
     LIMIT 1`,
  ).get(userId, tenantId) as { id: string; email?: string | null; name?: string | null; tenant_id?: string | null } | null;
  if (!user) return envelope({ error: "User was not found." }, 404);

  const oldBinding = getRoleBinding(userId, tenantId);
  const oldRole = ensureRoleBindingRole(oldBinding?.role ?? "") ?? "viewer";
  if (oldRole === "owner" && role !== "owner" && ownerCountForTenant(tenantId) <= 1) {
    return envelope({ error: "Cannot demote the last owner for this tenant." }, 409);
  }

  upsertRoleBinding(userId, role, tenantId);
  writeActionAudit({
    userId: getUserIdForRequest(req),
    actionKind: "governance.set-role",
    targetType: "user",
    targetId: userId,
    risk: role === "owner" || oldRole === "owner" ? "high" : "medium",
    request: { targetUserId: userId, tenantId, oldRole, newRole: role },
    resultStatus: "success",
    resultJson: { oldRole, newRole: role, tenantId },
  });

  return envelope({
    ok: true,
    user: {
      id: user.id,
      displayName: user.name || user.email || null,
      email: user.email ?? null,
      role,
      tenantId,
    },
  });
}

export async function governanceApprovalsListHandler(req: Request): Promise<Response> {
  const db = getDashboardDb();
  if (!db) return Response.json({ error: "db not available" }, { status: 500 });
  const ctx = getCurrentTenantContext();
  const { clause, params } = ctx.tenantId === "mimule" 
    ? { clause: "", params: [] } // For mimule tenant, show all approvals for backward compatibility
    : { clause: "AND tenant_id = ?", params: [ctx.tenantId] }; // For other tenants, scope to tenant
  
  const pending = db
    .query(`SELECT * FROM governance_approvals WHERE decision IS NULL ${clause} ORDER BY requested_at DESC`)
    .all(...params);
  const completed = db
    .query(`SELECT * FROM governance_approvals WHERE decision IS NOT NULL ${clause} ORDER BY decided_at DESC LIMIT 50`)
    .all(...params);
  return Response.json({ pending, completed });
}

export async function governanceApprovalDecideHandler(
  req: Request,
  runId: string,
  decision: "approve" | "reject",
): Promise<Response> {
  const roleErr = requireRole("secrets.write")(req);
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => ({}));
  const reason: string | undefined = body.reason;
  const db = getDashboardDb();
  if (!db) return Response.json({ error: "db not available" }, { status: 500 });

  const ctx = getCurrentTenantContext();
  const { clause, params } = ctx.tenantId === "mimule" 
    ? { clause: "", params: [] } // For mimule tenant, show all approvals for backward compatibility
    : { clause: "AND tenant_id = ?", params: [ctx.tenantId] }; // For other tenants, scope to tenant

  const existing = db
    .query(`SELECT * FROM governance_approvals WHERE run_id = ? AND decision IS NULL ${clause}`)
    .all(runId, ...params);

  if (!existing.length) {
    return Response.json({ error: "approval not found" }, { status: 404 });
  }

  const now = Date.now();
  db.query(
    `UPDATE governance_approvals SET decided_at = ?, decided_by = ?, decision = ?, reason = ? WHERE run_id = ? AND decision IS NULL ${clause}`,
  ).run(now, "owner", decision, reason ?? null, runId, ...params);

  if (decision === "approve") {
    try {
      const { startWorkflowRun } = await import("../builder/runner.ts");
      const run = db.query("SELECT workflow_id FROM builder_runs WHERE id = ?").get(runId) as { workflow_id: string } | null;
      if (run) {
        await startWorkflowRun(run.workflow_id, "approved", "owner");
      }
    } catch (e) {
      console.error("[governance] approve trigger failed:", e);
    }
  }

  return Response.json({ ok: true });
}

export async function governanceSecretsListHandler(req: Request): Promise<Response> {
  const roleErr = requireRole("secrets.read")(req);
  if (roleErr) return roleErr;
  try {
    const ctx = getCurrentTenantContext();
    const secrets = listSecrets(ctx);
    return Response.json({ secrets });
  } catch {
    return Response.json({ error: "failed to list secrets" }, { status: 500 });
  }
}

export async function governanceSecretsWriteHandler(req: Request): Promise<Response> {
  const roleErr = requireRole("secrets.write")(req);
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.value) {
    return Response.json({ error: "name and value required" }, { status: 400 });
  }
  try {
    const ctx = getCurrentTenantContext();
    const entry = writeSecret(body.name, body.value, body.description ?? "", ctx);
    return Response.json({ ok: true, id: entry.id, name: entry.name });
  } catch {
    return Response.json({ error: "failed to write secret" }, { status: 500 });
  }
}

export async function governanceSecretsDeleteHandler(req: Request, name: string): Promise<Response> {
  const roleErr = requireRole("secrets.write")(req);
  if (roleErr) return roleErr;
  try {
    const ctx = getCurrentTenantContext();
    const deleted = deleteSecret(name, ctx);
    return Response.json({ ok: deleted });
  } catch {
    return Response.json({ error: "failed to delete secret" }, { status: 500 });
  }
}

export async function governanceBudgetsListHandler(req: Request): Promise<Response> {
  const db = getDashboardDb();
  if (!db) return Response.json({ error: "db not available" }, { status: 500 });
  const ctx = getCurrentTenantContext();
  const { clause, params } = ctx.tenantId === "mimule" 
    ? { clause: "", params: [] } // For mimule tenant, show all budgets for backward compatibility
    : { clause: "WHERE tenant_id = ?", params: [ctx.tenantId] }; // For other tenants, scope to tenant
  
  const budgets = db.query(`SELECT * FROM governance_budgets ${clause}`).all(...params);
  const spending = getBudgetSpending("global", undefined, ctx);
  return Response.json({ budgets, spending });
}

export async function governanceBudgetsWriteHandler(req: Request): Promise<Response> {
  const roleErr = requireRole("secrets.write")(req);
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => null);
  if (!body?.scope) {
    return Response.json({ error: "scope required" }, { status: 400 });
  }
  const scope = body.scope as "global" | "project";
  const ctx = getCurrentTenantContext();
  upsertBudget(scope, {
    dailyCapUsd: body.dailyCapUsd,
    monthlyCapUsd: body.monthlyCapUsd,
    warnPct: body.warnPct,
    projectId: body.projectId,
  }, ctx);
  return Response.json({ ok: true });
}

export async function governanceAuditHandler(req: Request): Promise<Response> {
  const db = getDashboardDb();
  if (!db) return Response.json({ error: "db not available" }, { status: 500 });

  const url = new URL(req.url);
  const from = parseInt(url.searchParams.get("from") || "0");
  const to = parseInt(url.searchParams.get("to") || "0");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 1000);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const actionKind = url.searchParams.get("action_kind") || undefined;
  const tenant_filter = url.searchParams.get("tenant") || undefined;

  const fromTs = from || Date.now() - 30 * 24 * 60 * 60 * 1000;
  const toTs = to || Date.now();

  const ctx = getCurrentTenantContext();
  const isMimule = ctx.tenantId === "mimule";
  const conditions: (string | number)[] = [];
  const whereParts: string[] = [];

  whereParts.push("ts >= ?");
  conditions.push(fromTs);
  whereParts.push("ts <= ?");
  conditions.push(toTs);

  if (!isMimule) {
    whereParts.push("tenant_id = ?");
    conditions.push(ctx.tenantId);
  } else if (tenant_filter) {
    whereParts.push("tenant_id = ?");
    conditions.push(tenant_filter);
  }

  if (actionKind) {
    whereParts.push("action_kind = ?");
    conditions.push(actionKind);
  }

  const whereClause = whereParts.length > 0 ? "WHERE " + whereParts.join(" AND ") : "";

  const rows = db.query(
    `SELECT id, ts, tenant_id, user_id, actor, actor_source, action_kind, action, action_id,
            reason, target_type, target_id, risk, result_status, prev_hash, row_hash, event_id
     FROM action_audit ${whereClause}
     ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).all(...conditions, limit, offset);

  const countRow = db.query(
    `SELECT COUNT(*) as total FROM action_audit ${whereClause}`
  ).get(...conditions) as { total: number };

  return Response.json({
    events: rows,
    pagination: {
      total: countRow.total,
      limit,
      offset,
      hasMore: offset + rows.length < countRow.total,
    },
  });
}

export async function governanceRetentionHandler(): Promise<Response> {
  return Response.json(getRetentionPolicy());
}

export async function governanceRetentionWriteHandler(req: Request): Promise<Response> {
  const roleErr = requireRole("secrets.write")?.(req);
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "body required" }, { status: 400 });
  setRetentionPolicy({
    tracesTtlDays: body.tracesTtlDays,
    runDirsTtlDays: body.runDirsTtlDays,
    auditLogRetainForever: body.auditLogRetainForever,
  });
  return Response.json({ ok: true, policy: getRetentionPolicy() });
}

export async function evaluatePolicyForEvent(event: string, ctx: Record<string, unknown>): Promise<void> {
  for (const doc of loadedPolicies) {
    const decision = evaluatePolicy(doc, { event, ...ctx } as Parameters<typeof evaluatePolicy>[1]);
    if (decision.effect !== "log-only") {
      const db = getDashboardDb();
      if (db) {
        db.query(
          "INSERT INTO governance_policy_decisions (id, policy_id, event_type, effect, rule_name, reason, context_json, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          crypto.randomUUID(),
          doc.name,
          event,
          decision.effect,
          decision.ruleName ?? null,
          decision.reason,
          JSON.stringify(ctx),
          Date.now(),
        );
      }
    }
  }
}
