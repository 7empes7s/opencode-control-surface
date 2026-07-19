import { getCurrentAuthenticatedUser } from "../auth/session.ts";
import { resolveRole } from "../governance/rbac.ts";
import { listAgentEvents, listAgentRuns, listAgentSessions, type AgentIdentity } from "../agentWorkspace/registry.ts";
import type { AgentHarness } from "../agentWorkspace/adapter.ts";
import { ok } from "./types.ts";

const HARNESSES = new Set<AgentHarness>(["terminal", "codex", "opencode", "claude", "gemini"]);

function identity(): AgentIdentity | null {
  const user = getCurrentAuthenticatedUser();
  return user ? { tenantId: user.tenantId, userId: user.userId, role: resolveRole(user) } : null;
}

function unauthorized(): Response {
  return Response.json({ error: "Please sign in to continue." }, { status: 401 });
}

export function agentSessionsListHandler(url: URL): Response {
  const actor = identity();
  if (!actor) return unauthorized();
  const requestedHarness = url.searchParams.get("harness");
  if (requestedHarness && !HARNESSES.has(requestedHarness as AgentHarness)) {
    return Response.json({ error: "invalid harness" }, { status: 400 });
  }
  const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase().slice(0, 200);
  const sessions = listAgentSessions(actor, requestedHarness as AgentHarness | undefined)
    .filter((session) => !query || [session.title, session.workspaceRoot, session.repositoryRoot, session.harness]
      .some((value) => value?.toLocaleLowerCase().includes(query)));
  return Response.json(ok({ sessions, count: sessions.length }));
}

export function agentSessionDetailHandler(id: string): Response {
  const actor = identity();
  if (!actor) return unauthorized();
  const session = listAgentSessions(actor).find((item) => item.id === id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });
  return Response.json(ok({ session }));
}

export function agentSessionEventsHandler(id: string, url: URL): Response {
  const actor = identity();
  if (!actor) return unauthorized();
  const session = listAgentSessions(actor).find((item) => item.id === id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });
  const after = Number(url.searchParams.get("after") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 500);
  const events = listAgentEvents(actor, id, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 500);
  return Response.json(ok({ sessionId: id, events, nextCursor: events.at(-1)?.sequence ?? Math.max(0, after) }));
}

export function agentSessionRunsHandler(id: string): Response {
  const actor = identity();
  if (!actor) return unauthorized();
  const session = listAgentSessions(actor).find((item) => item.id === id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });
  return Response.json(ok({ sessionId: id, runs: listAgentRuns(actor, id) }));
}
