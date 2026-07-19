import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  acquireWriterLease,
  listAgentSessions,
  registerAgentSession,
} from "../agentWorkspace/registry.ts";
import {
  MANAGED_NAME_PATTERN,
  TERMINAL_SOCKET,
  TMUX_BIN,
  acquireTerminalWriter,
  ensureLegacyRootTerminalRegistered,
  isManagedTmuxName,
  listManagedTerminals,
  releaseTerminalWriter,
  stopTerminalSession,
  tmuxArgs,
  tmuxSessionNameFor,
} from "./multiSession.ts";

let root = "";
const configuredLegacySession = process.env.DASHBOARD_TERMINAL_SESSION;

const owner = { tenantId: "mimule", userId: "owner-a", role: "owner" as const };
const other = { tenantId: "mimule", userId: "owner-b", role: "owner" as const };

function registerTerminal(id: string, options: { ownerUserId?: string; visibility?: "private" | "tenant" } = {}) {
  const tmuxName = tmuxSessionNameFor(id);
  return registerAgentSession({
    id,
    tenantId: owner.tenantId,
    ownerUserId: options.ownerUserId ?? owner.userId,
    harness: "terminal",
    adapterSessionId: tmuxName,
    adapterVersion: "tmux-1",
    title: `Terminal ${id}`,
    visibility: options.visibility ?? "private",
    isolationMode: "shared",
    accessMode: "writer",
    effectiveConfig: { socket: TERMINAL_SOCKET, tmuxName, cwd: root },
    createdBy: owner.userId,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "managed-terminal-"));
  delete process.env.DASHBOARD_TERMINAL_SESSION;
  initDashboardDb({ enabled: true, path: join(root, "dashboard.sqlite") });
});

afterEach(() => {
  closeDashboardDb();
  rmSync(root, { recursive: true, force: true });
  if (configuredLegacySession === undefined) delete process.env.DASHBOARD_TERMINAL_SESSION;
  else process.env.DASHBOARD_TERMINAL_SESSION = configuredLegacySession;
});

describe("managed terminal namespace", () => {
  test("derives deterministic opaque names on the reserved tmux socket", () => {
    const first = tmuxSessionNameFor("terminal-one");
    expect(first).toBe(tmuxSessionNameFor("terminal-one"));
    expect(first).toMatch(MANAGED_NAME_PATTERN);
    expect(tmuxSessionNameFor("terminal-two")).not.toBe(first);
    expect(tmuxArgs("list-sessions")).toEqual([TMUX_BIN, "-L", TERMINAL_SOCKET, "list-sessions"]);
  });

  test("derives safe names from shell-shaped terminal ids", () => {
    for (const terminalId of ["terminal; rm -rf /", "terminal with spaces", "$(touch /tmp/not-run)"]) {
      expect(tmuxSessionNameFor(terminalId)).toMatch(MANAGED_NAME_PATTERN);
    }
  });

  test("rejects every non-managed tmux name", () => {
    for (const name of ["tib-root", "default", "", "cs-XYZ"]) {
      expect(isManagedTmuxName(name)).toBe(false);
    }
  });

  test("refuses to stop the legacy attach-only terminal without invoking tmux", () => {
    const legacy = ensureLegacyRootTerminalRegistered(owner.userId, owner);
    expect(legacy).not.toBeNull();
    const spawn = spyOn(Bun, "spawnSync");
    try {
      const result = stopTerminalSession({ identity: owner, actor: owner.userId, terminalId: legacy!.id });
      expect(result).toEqual({ ok: false, error: "legacy root terminal is attach-only", status: 409 });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  test("keeps private terminals hidden and rejects unauthorized exact stops", () => {
    const privateTerminal = registerTerminal("private-terminal");
    const tenantTerminal = registerTerminal("tenant-terminal", { visibility: "tenant" });
    const visibleIds = listManagedTerminals(other).map((terminal) => terminal.session.id);
    expect(visibleIds).not.toContain(privateTerminal.id);
    expect(visibleIds).toContain(tenantTerminal.id);

    const spawn = spyOn(Bun, "spawnSync");
    try {
      const hidden = stopTerminalSession({ identity: other, actor: other.userId, terminalId: privateTerminal.id });
      expect(hidden).toEqual({ ok: false, error: "terminal session not found", status: 404 });
      const forbidden = stopTerminalSession({ identity: other, actor: other.userId, terminalId: tenantTerminal.id });
      expect(forbidden).toEqual({ ok: false, error: "terminal session cannot be mutated", status: 403 });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  test("fences competing terminal writers and advances the epoch after release", () => {
    const terminalId = "writer-terminal";
    const first = acquireTerminalWriter({ identity: owner, terminalId });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first terminal writer lease");

    const conflict = acquireWriterLease({
      tenantId: other.tenantId,
      resourceType: "worktree",
      resourceKey: `terminal:${terminalId}`,
      sessionId: "spectator-terminal",
      userId: other.userId,
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok !== false) throw new Error("expected a terminal writer conflict");
    expect(conflict.holderSessionId).toBe(terminalId);
    expect(conflict.fenceEpoch).toBe(first.fenceEpoch);

    expect(releaseTerminalWriter({ identity: owner, terminalId, fenceEpoch: first.fenceEpoch })).toBe(true);
    const second = acquireTerminalWriter({ identity: other, terminalId });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.fenceEpoch).toBeGreaterThan(first.fenceEpoch);
  });

  test("registers the legacy root terminal idempotently", () => {
    const first = ensureLegacyRootTerminalRegistered(owner.userId, owner);
    const second = ensureLegacyRootTerminalRegistered(other.userId, other);
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(second?.ownerUserId).toBe(owner.userId);
    expect(second?.accessMode).toBe("reader");
    expect(second?.effectiveConfig).toEqual({ legacy: true, attachOnly: true, socket: "default" });
    expect(listAgentSessions(owner, "terminal")).toHaveLength(1);
  });
});
