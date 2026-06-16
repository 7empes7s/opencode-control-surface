import { readOperatorState, writeOperatorState } from "../db/writer.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { checkToken } from "./actions.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { getAuthenticatedUser } from "../auth/session.ts";
import { ensureRoleBindingRole, getRoleForRequest, requireOwner, requireView, type RbacRole } from "../governance/rbac.ts";
import { writeActionAudit } from "../db/writer.ts";
import { randomUUID } from "node:crypto";

export function settingsStateHandler(url: URL): Response {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ degraded: true, reason: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const key = url.searchParams.get("key");

  if (key) {
    const value = readOperatorState(key);
    return new Response(JSON.stringify({ key, value }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Return all entries (we'd need to query the DB for all keys - limited implementation)
  // For now return a subset of known keys
  const knownKeys = [
    "last_visit_ts",
    "today.reviewed",
    "snapshot.newsbites.articleCount",
    "snapshot.newsbites.articleCount.midnight",
    "snapshot.queueDepth",
    "snapshot.modelsCheckAt",
    "snapshot.vastRunwayHours"
  ];

  const entries: Array<{ key: string; value: unknown }> = [];
  for (const k of knownKeys) {
    const v = readOperatorState(k);
    if (v !== null) {
      entries.push({ key: k, value: v });
    }
  }

  return new Response(JSON.stringify({ entries }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function settingsStatePutHandler(req: Request, key: string): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ degraded: true, reason: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate key format
  if (!/^[a-z0-9._-]{1,80}$/.test(key)) {
    return new Response(JSON.stringify({ error: "invalid key format" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { value: unknown };
  try {
    body = await req.json() as { value: unknown };
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  writeOperatorState(key, body.value);

  return new Response(JSON.stringify({ ok: true, key, value: body.value }), {
    headers: { "Content-Type": "application/json" },
  });
}

export function settingsAuthStatusHandler(): Response {
  const tokenSet = Boolean(process.env.OPERATOR_TOKEN && process.env.OPERATOR_TOKEN.length > 0);
  const productionMode = tokenSet && process.env.NODE_ENV === "production";
  const dashboardDbEnabled = isDashboardDbEnabled();

  let note = "";
  if (!tokenSet) {
    note = "Operator token not configured - using dev mode (local requests allowed)";
  } else if (!productionMode) {
    note = "Operator token set but not in production mode";
  } else {
    note = "Production mode - operator token required for protected actions";
  }

  return new Response(JSON.stringify({
    tokenSet,
    productionMode,
    dashboardDbEnabled,
    cloudflareHeadersPresent: false,
    note
  }), {
    headers: { "Content-Type": "application/json" },
  });
}

type AccessUserRow = {
  id: string;
  email: string;
  name: string | null;
  auth_method: string;
  created_at: number;
  role: string | null;
  tenant_id: string | null;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function cleanName(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function accessDbOrError(): { db: NonNullable<ReturnType<typeof getDashboardDb>> } | Response {
  if (!isDashboardDbEnabled()) {
    return json({ error: "Access management needs the dashboard database to be enabled." }, 503);
  }
  const db = getDashboardDb();
  if (!db) return json({ error: "Access management is not available right now." }, 503);
  return { db };
}

export function settingsAccessHandler(req: Request): Response {
  const guard = requireView(req, "audit.view");
  if (guard) return guard;
  const available = accessDbOrError();
  if (available instanceof Response) return available;
  const { db } = available;
  const ctx = getCurrentTenantContext();
  const rows = db.query(
    `SELECT u.id, u.email, u.name, u.auth_method, u.created_at, u.tenant_id, b.role
     FROM users u
     LEFT JOIN governance_role_bindings b
       ON b.user_id = u.id AND b.tenant_id = ?
     WHERE u.tenant_id = ? OR u.tenant_id IS NULL
     ORDER BY u.created_at DESC`,
  ).all(ctx.tenantId, ctx.tenantId) as AccessUserRow[];

  return json({
    users: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      authMethod: row.auth_method,
      createdAt: row.created_at,
      tenantId: row.tenant_id ?? ctx.tenantId,
      role: ensureRoleBindingRole(row.role ?? "") ?? "viewer",
    })),
    currentRole: getRoleForRequest(req),
  });
}

export async function settingsAccessInviteHandler(req: Request): Promise<Response> {
  const guard = requireOwner(req);
  if (guard) return guard;
  const available = accessDbOrError();
  if (available instanceof Response) return available;
  const { db } = available;
  const ctx = getCurrentTenantContext();

  let body: { email?: unknown; name?: unknown; password?: unknown; role?: unknown };
  try {
    body = await req.json() as { email?: unknown; name?: unknown; password?: unknown; role?: unknown };
  } catch {
    return json({ error: "Enter an email address, password, and role." }, 400);
  }

  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const role = ensureRoleBindingRole(typeof body.role === "string" ? body.role : "viewer") ?? "viewer";
  if (!email || !email.includes("@")) return json({ error: "Enter a valid email address." }, 400);
  if (password.length < 8) return json({ error: "Use a password with at least 8 characters." }, 400);

  const existing = db.query(
    `SELECT id FROM users WHERE lower(email) = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
  ).get(email, ctx.tenantId) as { id: string } | null;
  const userId = existing?.id ?? randomUUID();
  const now = Date.now();
  const passwordHash = await Bun.password.hash(password, "argon2id");

  if (!existing) {
    db.query(
      `INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, email, cleanName(body.name), "local", now, ctx.tenantId);
  } else {
    db.query(
      `UPDATE users SET name = COALESCE(?, name), auth_method = 'local' WHERE id = ?`,
    ).run(cleanName(body.name), userId);
  }

  db.query(
    `INSERT INTO local_account_credentials (user_id, password_hash, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
  ).run(userId, passwordHash, now);
  db.query(
    `INSERT INTO governance_role_bindings (id, user_id, role, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`,
  ).run(randomUUID(), userId, role, ctx.tenantId, now);

  const actor = getAuthenticatedUser(req);
  writeActionAudit({
    userId: actor?.userId ?? null,
    actionKind: "access.invite",
    targetType: "user",
    targetId: userId,
    risk: role === "owner" ? "high" : "medium",
    request: { email, role },
    resultStatus: "success",
  });

  return json({ ok: true, user: { id: userId, email, name: cleanName(body.name), role } }, existing ? 200 : 201);
}

export async function settingsAccessRoleHandler(req: Request, userId: string): Promise<Response> {
  const guard = requireOwner(req);
  if (guard) return guard;
  const available = accessDbOrError();
  if (available instanceof Response) return available;
  const { db } = available;
  const ctx = getCurrentTenantContext();

  let body: { role?: unknown };
  try {
    body = await req.json() as { role?: unknown };
  } catch {
    return json({ error: "Choose a role for this user." }, 400);
  }
  const role = ensureRoleBindingRole(typeof body.role === "string" ? body.role : "");
  if (!role) return json({ error: "Choose owner, operator, auditor, or viewer." }, 400);

  const user = db.query(
    `SELECT id, email FROM users WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
  ).get(userId, ctx.tenantId) as { id: string; email: string } | null;
  if (!user) return json({ error: "User was not found." }, 404);

  db.query(
    `INSERT INTO governance_role_bindings (id, user_id, role, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`,
  ).run(randomUUID(), userId, role, ctx.tenantId, Date.now());

  const actor = getAuthenticatedUser(req);
  writeActionAudit({
    userId: actor?.userId ?? null,
    actionKind: "access.role.set",
    targetType: "user",
    targetId: userId,
    risk: role === "owner" ? "high" : "medium",
    request: { role },
    resultStatus: "success",
  });

  return json({ ok: true, user: { id: user.id, email: user.email, role } });
}
