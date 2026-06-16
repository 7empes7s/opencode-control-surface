import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { issueOperatorSessionCookie } from "../auth/session.ts";

type LoginBody = {
  email?: string;
  password?: string;
};

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function authLoginHandler(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return json({ error: "Local account login needs the dashboard database to be enabled." }, 503);
  }

  const db = getDashboardDb();
  if (!db) return json({ error: "Local account login is not available right now." }, 503);

  let body: LoginBody;
  try {
    body = await req.json() as LoginBody;
  } catch {
    return json({ error: "Enter an email address and password." }, 400);
  }

  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return json({ error: "Enter an email address and password." }, 400);
  }

  const ctx = getCurrentTenantContext();
  const row = db.query(
    `SELECT u.id, u.email, u.name, u.tenant_id, c.password_hash
     FROM users u
     JOIN local_account_credentials c ON c.user_id = u.id
     WHERE lower(u.email) = ? AND (u.tenant_id = ? OR u.tenant_id IS NULL)
     LIMIT 1`,
  ).get(email, ctx.tenantId) as {
    id: string;
    email: string;
    name: string | null;
    tenant_id: string | null;
    password_hash: string;
  } | null;

  if (!row) {
    return json({ error: "Email or password is incorrect." }, 401);
  }

  const ok = await Bun.password.verify(password, row.password_hash);
  if (!ok) {
    return json({ error: "Email or password is incorrect." }, 401);
  }

  const tenantId = row.tenant_id ?? ctx.tenantId;
  return json(
    {
      ok: true,
      user: { id: row.id, email: row.email, name: row.name, tenantId },
    },
    200,
    { "Set-Cookie": issueOperatorSessionCookie(row.id, tenantId) },
  );
}
