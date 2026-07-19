import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { writeActionAudit } from "../db/writer.ts";
import {
  acquireWriterLease,
  appendAgentEvent,
  archiveAgentSession,
  canMutateAgentSession,
  getAgentSessionByAdapter,
  listAgentSessions,
  registerAgentSession,
  releaseWriterLeaseOfType,
  takeoverWriterLease,
  type AgentIdentity,
  type AgentSession,
  type LeaseResult,
} from "../agentWorkspace/registry.ts";
import { terminalSessionName } from "./session.ts";

export const TERMINAL_SOCKET = "cs-term";
export const TMUX_BIN = "/usr/bin/tmux";
export const MANAGED_NAME_PATTERN = /^cs-[0-9a-f]{12}$/;

/** argv prefix pinning every managed tmux call to the reserved socket. */
export function tmuxArgs(...rest: string[]): string[] {
  return [TMUX_BIN, "-L", TERMINAL_SOCKET, ...rest];
}

/** Deterministic, opaque, injection-proof tmux name: `cs-` + first 12 hex of sha256(terminalId). */
export function tmuxSessionNameFor(terminalId: string): string {
  return `cs-${createHash("sha256").update(terminalId).digest("hex").slice(0, 12)}`;
}

export function isManagedTmuxName(name: string): boolean {
  return MANAGED_NAME_PATTERN.test(name);
}

export type ManagedTerminal = { session: AgentSession; tmuxName: string; alive: boolean | null };

export const MAX_TERMINALS_PER_OWNER = 12;

function resolveTerminalCwd(cwd: string | undefined): string | null {
  const candidate = cwd ?? "/root";
  if (!isAbsolute(candidate)) return null;
  try {
    const resolved = realpathSync(candidate);
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function managedTmux(...args: string[]) {
  return Bun.spawnSync(tmuxArgs(...args), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

export function createTerminalSession(input: {
  identity: AgentIdentity;
  actor: string;
  title: string;
  cwd?: string;
}): { ok: true; terminal: ManagedTerminal } | { ok: false; error: string; status: number } {
  const cwd = resolveTerminalCwd(input.cwd);
  if (!cwd) return { ok: false, error: "cwd must be an existing absolute directory", status: 400 };

  const ownedManaged = listAgentSessions(input.identity, "terminal").filter((session) =>
    session.ownerUserId === input.identity.userId
    && session.effectiveConfig.socket === TERMINAL_SOCKET
    && isManagedTmuxName(session.adapterSessionId)
    && session.adapterSessionId === tmuxSessionNameFor(session.id),
  );
  if (ownedManaged.length >= MAX_TERMINALS_PER_OWNER) {
    return { ok: false, error: "managed terminal limit reached", status: 429 };
  }

  const terminalId = randomUUID();
  const tmuxName = tmuxSessionNameFor(terminalId);
  const session = registerAgentSession({
    id: terminalId,
    tenantId: input.identity.tenantId,
    ownerUserId: input.identity.userId,
    harness: "terminal",
    adapterSessionId: tmuxName,
    adapterVersion: "tmux-1",
    title: input.title,
    visibility: "private",
    workspaceRoot: cwd,
    isolationMode: "shared",
    accessMode: "writer",
    requestedConfig: { cwd },
    effectiveConfig: { socket: TERMINAL_SOCKET, tmuxName, cwd },
    createdBy: input.actor,
  });

  let created = false;
  try {
    created = managedTmux("new-session", "-d", "-s", tmuxName, "-c", cwd).exitCode === 0;
  } catch {
    created = false;
  }
  if (!created) {
    archiveAgentSession(session.id);
    return { ok: false, error: "failed to create managed terminal", status: 500 };
  }

  appendAgentEvent({
    session,
    kind: "terminal.created",
    payload: { socket: TERMINAL_SOCKET, tmuxName, cwd },
  });
  writeActionAudit({
    userId: input.identity.userId,
    actor: input.actor,
    actionKind: "terminal.session.create",
    targetType: "terminal-session",
    targetId: session.id,
    risk: "high",
    request: { title: input.title, cwd },
    result: "managed terminal created",
    resultStatus: "success",
  });

  return { ok: true, terminal: { session, tmuxName, alive: true } };
}

export function listManagedTerminals(identity: AgentIdentity): ManagedTerminal[] {
  const sessions = listAgentSessions(identity, "terminal");
  const aliveNames = new Set<string>();
  try {
    const result = managedTmux("list-sessions", "-F", "#{session_name}");
    if (result.exitCode === 0) {
      for (const name of new TextDecoder().decode(result.stdout).split("\n")) {
        if (isManagedTmuxName(name)) aliveNames.add(name);
      }
    }
  } catch {
    // An unavailable reserved tmux server means every registered terminal is detached/dead.
  }
  return sessions.map((session) => ({
    session,
    tmuxName: session.adapterSessionId,
    alive: session.effectiveConfig.legacy === true && session.effectiveConfig.attachOnly === true
      ? null
      : isManagedTmuxName(session.adapterSessionId) && aliveNames.has(session.adapterSessionId),
  }));
}

export function stopTerminalSession(input: {
  identity: AgentIdentity;
  actor: string;
  terminalId: string;
}): { ok: true; stopped: boolean } | { ok: false; error: string; status: number } {
  const session = listAgentSessions(input.identity, "terminal").find((item) => item.id === input.terminalId);
  if (!session) return { ok: false, error: "terminal session not found", status: 404 };
  if (!canMutateAgentSession(input.identity, session)) {
    return { ok: false, error: "terminal session cannot be mutated", status: 403 };
  }
  if (session.effectiveConfig.legacy === true && session.effectiveConfig.attachOnly === true) {
    return { ok: false, error: "legacy root terminal is attach-only", status: 409 };
  }

  const tmuxName = tmuxSessionNameFor(session.id);
  if (!isManagedTmuxName(tmuxName)) throw new Error("refusing to stop an unmanaged tmux session");

  let stopped = false;
  try {
    stopped = managedTmux("kill-session", "-t", tmuxName).exitCode === 0;
  } catch {
    stopped = false;
  }
  archiveAgentSession(session.id);
  return { ok: true, stopped };
}

export function acquireTerminalWriter(input: {
  identity: AgentIdentity;
  terminalId: string;
}): LeaseResult {
  return acquireWriterLease({
    tenantId: input.identity.tenantId,
    resourceType: "worktree",
    resourceKey: `terminal:${input.terminalId}`,
    sessionId: input.terminalId,
    userId: input.identity.userId,
    ttlMs: 30 * 60_000,
  });
}

export function releaseTerminalWriter(input: {
  identity: AgentIdentity;
  terminalId: string;
  fenceEpoch: number;
}): boolean {
  return releaseWriterLeaseOfType({
    resourceType: "worktree",
    resourceKey: `terminal:${input.terminalId}`,
    sessionId: input.terminalId,
    fenceEpoch: input.fenceEpoch,
  });
}

/** Idempotently registers the legacy default-socket `tib-root` terminal as attach-only. */
export function ensureLegacyRootTerminalRegistered(actor: string, identity: AgentIdentity): AgentSession | null {
  const adapterSessionId = terminalSessionName();
  const existing = getAgentSessionByAdapter("terminal", adapterSessionId);
  if (existing) return existing;
  try {
    return registerAgentSession({
      tenantId: identity.tenantId,
      ownerUserId: identity.userId,
      harness: "terminal",
      adapterSessionId,
      adapterVersion: "tmux-1",
      title: "Legacy root terminal",
      visibility: "private",
      isolationMode: "shared",
      accessMode: "reader",
      effectiveConfig: { legacy: true, attachOnly: true, socket: "default" },
      createdBy: actor,
    });
  } catch {
    return null;
  }
}

/** Resolves only a visible, registry-derived terminal on the reserved socket. */
export function resolveManagedTerminalSession(
  identity: AgentIdentity,
  terminalId: string,
  mutation = false,
): AgentSession | null {
  const session = listAgentSessions(identity, "terminal").find((item) => item.id === terminalId);
  if (!session || (mutation && !canMutateAgentSession(identity, session))) return null;
  if (session.effectiveConfig.legacy === true || session.archivedAt !== null) return null;
  if (session.effectiveConfig.socket !== TERMINAL_SOCKET) return null;
  if (!isManagedTmuxName(session.adapterSessionId)) return null;
  if (session.adapterSessionId !== tmuxSessionNameFor(session.id)) return null;
  return session;
}

export function acquireTerminalAttachmentWriter(input: {
  identity: AgentIdentity;
  terminalId: string;
  connectionId: string;
}): LeaseResult {
  return acquireWriterLease({
    tenantId: input.identity.tenantId,
    resourceType: "worktree",
    resourceKey: `terminal:${input.terminalId}`,
    sessionId: input.connectionId,
    userId: input.identity.userId,
    ttlMs: 30 * 60_000,
  });
}

export function releaseTerminalAttachmentWriter(input: {
  terminalId: string;
  connectionId: string;
  fenceEpoch: number;
}): boolean {
  return releaseWriterLeaseOfType({
    resourceType: "worktree",
    resourceKey: `terminal:${input.terminalId}`,
    sessionId: input.connectionId,
    fenceEpoch: input.fenceEpoch,
  });
}

export function takeoverTerminalAttachmentWriter(input: {
  identity: AgentIdentity;
  terminalId: string;
  connectionId: string;
  expectedFenceEpoch: number;
}): LeaseResult {
  if (!Number.isInteger(input.expectedFenceEpoch) || input.expectedFenceEpoch < 0) {
    return { ok: false, holderSessionId: null, fenceEpoch: 0, expiresAt: null };
  }
  const session = resolveManagedTerminalSession(input.identity, input.terminalId, true);
  if (!session) return { ok: false, holderSessionId: null, fenceEpoch: 0, expiresAt: null };
  return takeoverWriterLease({
    tenantId: input.identity.tenantId,
    resourceType: "worktree",
    resourceKey: `terminal:${input.terminalId}`,
    expectedFenceEpoch: input.expectedFenceEpoch,
    newHolderSessionId: input.connectionId,
    newHolderUserId: input.identity.userId,
    ttlMs: 30 * 60_000,
  });
}
