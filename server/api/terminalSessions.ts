import { getCurrentAuthenticatedUser } from "../auth/session.ts";
import { resolveRole } from "../governance/rbac.ts";
import {
  createTerminalSession,
  ensureLegacyRootTerminalRegistered,
  listManagedTerminals,
  stopTerminalSession,
} from "../terminal/multiSession.ts";
import type { AgentIdentity } from "../agentWorkspace/registry.ts";
import { ok } from "./types.ts";

function identity(): AgentIdentity | null {
  const user = getCurrentAuthenticatedUser();
  return user ? { tenantId: user.tenantId, userId: user.userId, role: resolveRole(user) } : null;
}

function unauthorized(): Response {
  return Response.json({ error: "Please sign in to continue." }, { status: 401 });
}

export function terminalSessionsListHandler(): Response {
  const actor = identity();
  if (!actor) return unauthorized();
  ensureLegacyRootTerminalRegistered(actor.userId, actor);
  const terminals = listManagedTerminals(actor);
  return Response.json(ok({ terminals, count: terminals.length }));
}

export async function terminalSessionCreateHandler(req: Request): Promise<Response> {
  const actor = identity();
  if (!actor) return unauthorized();
  if (actor.role !== "owner" && actor.role !== "operator") {
    return Response.json({ error: "Your role cannot make this change." }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { title?: unknown; cwd?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > 120) {
    return Response.json({ error: "title must be a non-empty string of at most 120 characters" }, { status: 400 });
  }
  if (body.cwd !== undefined && typeof body.cwd !== "string") {
    return Response.json({ error: "cwd must be a string" }, { status: 400 });
  }

  const result = createTerminalSession({
    identity: actor,
    actor: actor.userId,
    title,
    cwd: body.cwd as string | undefined,
  });
  if (result.ok === false) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(ok({ terminal: result.terminal }), { status: 201 });
}

export async function terminalSessionStopHandler(id: string): Promise<Response> {
  const actor = identity();
  if (!actor) return unauthorized();
  const result = stopTerminalSession({ identity: actor, actor: actor.userId, terminalId: id });
  if (result.ok === false) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(ok({ stopped: result.stopped }));
}
