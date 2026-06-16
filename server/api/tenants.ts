import { checkToken } from "./actions.ts";
import { upsertTenant, getTenant, listTenants } from "../tenancy/store.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { spawnSync } from "node:child_process";
import { requireMutation } from "../governance/rbac.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function operatorOnly(req: Request): Response | null {
  if (!checkToken(req)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function mutationOnly(req: Request): Response | null {
  return requireMutation(req);
}

export function tenantsListHandler(req: Request): Response {
  const guard = operatorOnly(req);
  if (guard) return guard;
  return json({ tenants: listTenants() });
}

export async function tenantsCreateHandler(req: Request): Promise<Response> {
  const guard = mutationOnly(req);
  if (guard) return guard;
  let body: { id?: string; name?: string };
  try {
    body = await req.json() as { id?: string; name?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.id || !body.name) return json({ error: "id and name are required" }, 400);
  const tenant = upsertTenant(body.id, body.name, "active");
  return json({ tenant }, 201);
}

export function tenantGetHandler(req: Request, id: string): Response {
  const guard = operatorOnly(req);
  if (guard) return guard;
  const tenant = getTenant(id);
  if (!tenant) return json({ error: "not found" }, 404);
  const db = getDashboardDb();
  const projectCount = db
    ? (db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM projects WHERE tenant_id = ? AND (status IS NULL OR status != 'deleted')"
      ).get(id)?.count ?? 0)
    : 0;
  return json({ tenant, projectCount });
}

export async function tenantPatchHandler(req: Request, id: string): Promise<Response> {
  const guard = mutationOnly(req);
  if (guard) return guard;
  const existing = getTenant(id);
  if (!existing) return json({ error: "not found" }, 404);
  let body: { name?: string; status?: string };
  try {
    body = await req.json() as { name?: string; status?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const tenant = upsertTenant(id, body.name ?? existing.name, body.status ?? existing.status);
  return json({ tenant });
}

export function tenantTmuxStatusHandler(req: Request, id: string): Response {
  const guard = operatorOnly(req);
  if (guard) return guard;
  const tenant = getTenant(id);
  if (!tenant) return json({ error: "not found" }, 404);
  const socket = `tib-${id}`;
  const result = spawnSync("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
    encoding: "utf8",
  });
  const sessions = result.status === 0
    ? (result.stdout ?? "").split(/\r?\n/).filter(Boolean)
    : [];
  const active = sessions.filter((s) => !s.startsWith("builder-child-")).length;
  return json({ socket, sessions, active });
}
