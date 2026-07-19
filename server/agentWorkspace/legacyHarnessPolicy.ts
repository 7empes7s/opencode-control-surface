import { getCurrentAuthenticatedUser } from "../auth/session.ts";
import { resolveRole } from "../governance/rbac.ts";
import type { AgentHarness } from "./adapter.ts";
import {
  acquireWriterLease,
  archiveAgentSession,
  appendAgentEvent,
  authorizeAdapterSession,
  listAgentSessions,
  registerAgentSession,
  releaseWriterLeaseForSession,
  type AgentSession,
} from "./registry.ts";

type LegacyHarness = Exclude<AgentHarness, "terminal" | "opencode">;

function identity() {
  const user = getCurrentAuthenticatedUser();
  return user ? { tenantId: user.tenantId, userId: user.userId, role: resolveRole(user) } : null;
}

export function visibleLegacySessionIds(harness: LegacyHarness): Set<string> {
  const actor = identity();
  return new Set(actor ? listAgentSessions(actor, harness).map((session) => session.adapterSessionId) : []);
}

export function governedLegacySession(harness: LegacyHarness, id: string, mutation: boolean): AgentSession | null {
  const actor = identity();
  return actor ? authorizeAdapterSession(actor, harness, id, mutation) : null;
}

export function registerLegacySession(input: {
  harness: LegacyHarness;
  id: string;
  title: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
}): AgentSession | null {
  const actor = identity();
  if (!actor) return null;
  return registerAgentSession({
    tenantId: actor.tenantId,
    ownerUserId: actor.userId,
    harness: input.harness,
    adapterSessionId: input.id,
    adapterVersion: "legacy-json-v1",
    title: input.title,
    workspaceRoot: input.directory,
    repositoryRoot: input.directory,
    accessMode: "writer",
    requestedConfig: {},
    effectiveConfig: {},
    createdBy: actor.userId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

export function acquireLegacyWriter(session: AgentSession): boolean {
  const actor = identity();
  if (!actor || !session.workspaceRoot) return false;
  return acquireWriterLease({
    tenantId: actor.tenantId,
    resourceKey: session.workspaceRoot,
    sessionId: session.id,
    userId: actor.userId,
  }).ok;
}

export function releaseLegacyWriter(session: AgentSession): void {
  if (session.workspaceRoot) releaseWriterLeaseForSession(session.workspaceRoot, session.id);
}

export function archiveLegacySession(session: AgentSession): void {
  releaseLegacyWriter(session);
  archiveAgentSession(session.id);
}

export function appendLegacyEvent(session: AgentSession, kind: string, payload: Record<string, unknown>): void {
  appendAgentEvent({ session, kind, payload });
}
