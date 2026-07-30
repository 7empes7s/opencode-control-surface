import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { registerAgentSession } from "../agentWorkspace/registry.ts";
import {
  MAX_TERMINALS_PER_OWNER,
  TERMINAL_SOCKET,
  acquireTerminalAttachmentWriter,
  createTerminalSession,
  ensureLegacyRootTerminalRegistered,
  listManagedTerminals,
  releaseTerminalAttachmentWriter,
  resolveManagedTerminalSession,
  takeoverTerminalAttachmentWriter,
  tmuxArgs,
  tmuxSessionNameFor,
} from "./multiSession.ts";
import {
  ByteRing,
  MAX_SCROLLBACK_BYTES,
  managedTerminalUpgradeHandler,
  parseManagedTerminalClientMessage,
  respawnManagedSession,
  terminalMultiplexedWebSocketHandlers,
  type ManagedTerminalSocketData,
  type TerminalWebSocketData,
} from "./multiplexer.ts";
import { terminalWebSocketHandlers, type TerminalSocketData } from "./session.ts";

let root = "";
let previousToken: string | undefined;
const owner = { tenantId: "mimule", userId: "operator-bootstrap", role: "owner" as const };
const other = { tenantId: "mimule", userId: "other-owner", role: "owner" as const };

function registerTerminal(id: string, options: { ownerUserId?: string; visibility?: "private" | "tenant"; adapterSessionId?: string } = {}) {
  const tmuxName = options.adapterSessionId ?? tmuxSessionNameFor(id);
  return registerAgentSession({
    id,
    tenantId: owner.tenantId,
    ownerUserId: options.ownerUserId ?? owner.userId,
    harness: "terminal",
    adapterSessionId: tmuxName,
    adapterVersion: "tmux-1",
    title: `terminal ${id}`,
    visibility: options.visibility ?? "private",
    isolationMode: "shared",
    accessMode: "writer",
    effectiveConfig: { socket: TERMINAL_SOCKET, tmuxName, cwd: root },
    createdBy: owner.userId,
  });
}

function upgradeRequest(id: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://control.example.test/api/terminal/sessions/${encodeURIComponent(id)}/ws`, {
    headers: {
      host: "control.example.test",
      origin: "https://control.example.test",
      upgrade: "websocket",
      "x-operator-token": "test-token",
      ...headers,
    },
  });
}

function fakeServer(captured: { data?: ManagedTerminalSocketData }): Bun.Server<TerminalWebSocketData> {
  return {
    upgrade(_request: Request, options: { data: ManagedTerminalSocketData }) {
      captured.data = options.data;
      return true;
    },
  } as unknown as Bun.Server<TerminalWebSocketData>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "multiplexer-terminal-"));
  previousToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ enabled: true, path: join(root, "dashboard.sqlite") });
});

afterEach(() => {
  closeDashboardDb();
  rmSync(root, { recursive: true, force: true });
  if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousToken;
});

describe("managed terminal upgrades", () => {
  test("rejects invalid upgrades and hidden, archived, legacy, and derived-name mismatches before tmux", () => {
    const valid = registerTerminal("upgrade-valid");
    registerTerminal("upgrade-private", { ownerUserId: other.userId });
    registerTerminal("upgrade-wrong-name", { adapterSessionId: "cs-000000000000" });
    const legacy = ensureLegacyRootTerminalRegistered(owner.userId, owner);
    expect(legacy).not.toBeNull();
    const spawn = spyOn(Bun, "spawnSync");
    try {
      expect(managedTerminalUpgradeHandler(new Request("https://control.example.test"), valid.id, fakeServer({}))?.status).toBe(426);
      expect(managedTerminalUpgradeHandler(upgradeRequest(valid.id, { "x-operator-token": "wrong" }), valid.id, fakeServer({}))?.status).toBe(401);
      expect(managedTerminalUpgradeHandler(upgradeRequest(valid.id, { origin: "https://evil.example.test" }), valid.id, fakeServer({}))?.status).toBe(403);
      expect(managedTerminalUpgradeHandler(upgradeRequest("upgrade-private"), "upgrade-private", fakeServer({}))?.status).toBe(404);
      expect(managedTerminalUpgradeHandler(upgradeRequest("upgrade-wrong-name"), "upgrade-wrong-name", fakeServer({}))?.status).toBe(404);
      expect(managedTerminalUpgradeHandler(upgradeRequest(legacy!.id), legacy!.id, fakeServer({}))?.status).toBe(404);
      expect(managedTerminalUpgradeHandler(upgradeRequest("missing"), "missing", fakeServer({}))?.status).toBe(404);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  test("stores only the validated managed session and connection metadata, with independent attempt limits", () => {
    const session = registerTerminal("upgrade-data");
    const captured: { data?: ManagedTerminalSocketData } = {};
    expect(managedTerminalUpgradeHandler(upgradeRequest(session.id, { "x-forwarded-for": "203.0.113.5" }), session.id, fakeServer(captured))).toBeUndefined();
    expect(captured.data).toMatchObject({
      kind: "managed-terminal",
      terminalId: session.id,
      sessionId: session.id,
      tmuxName: tmuxSessionNameFor(session.id),
      mode: "spectator",
      fenceEpoch: 0,
    });
    expect(captured.data?.connectionId).toMatch(/^[0-9a-f-]{36}$/);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(managedTerminalUpgradeHandler(upgradeRequest(session.id, { "x-forwarded-for": "203.0.113.6" }), session.id, fakeServer({}))).toBeUndefined();
    }
    expect(managedTerminalUpgradeHandler(upgradeRequest(session.id, { "x-forwarded-for": "203.0.113.6" }), session.id, fakeServer({}))?.status).toBe(429);
  });
});

describe("managed terminal lease protocol", () => {
  test("uses connection-scoped holders and a compare-and-swap takeover fence", () => {
    const terminal = registerTerminal("lease-terminal");
    expect(resolveManagedTerminalSession(owner, terminal.id)?.id).toBe(terminal.id);
    expect(resolveManagedTerminalSession(other, terminal.id)).toBeNull();

    const writer = acquireTerminalAttachmentWriter({ identity: owner, terminalId: terminal.id, connectionId: "writer-connection" });
    expect(writer.ok).toBe(true);
    if (!writer.ok) throw new Error("expected writer lease");
    const spectator = acquireTerminalAttachmentWriter({ identity: owner, terminalId: terminal.id, connectionId: "spectator-connection" });
    expect(spectator.ok).toBe(false);
    if (spectator.ok === true) throw new Error("expected spectator conflict");
    expect(spectator.holderSessionId).toBe("writer-connection");

    const takeover = takeoverTerminalAttachmentWriter({
      identity: owner,
      terminalId: terminal.id,
      connectionId: "spectator-connection",
      expectedFenceEpoch: spectator.fenceEpoch,
    });
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) throw new Error("expected successful takeover");
    expect(takeover.fenceEpoch).toBeGreaterThan(writer.fenceEpoch);
    const stale = takeoverTerminalAttachmentWriter({
      identity: owner,
      terminalId: terminal.id,
      connectionId: "third-connection",
      expectedFenceEpoch: spectator.fenceEpoch,
    });
    expect(stale.ok).toBe(false);
    expect(releaseTerminalAttachmentWriter({
      terminalId: terminal.id,
      connectionId: "writer-connection",
      fenceEpoch: writer.fenceEpoch,
    })).toBe(false);
    expect(releaseTerminalAttachmentWriter({
      terminalId: terminal.id,
      connectionId: "spectator-connection",
      fenceEpoch: takeover.fenceEpoch,
    })).toBe(true);
  });
});

describe("bounded managed transport primitives", () => {
  test("keeps raw scrollback bounded to the newest one MiB and parses takeover separately", () => {
    const ring = new ByteRing();
    const bytes = new Uint8Array(MAX_SCROLLBACK_BYTES + 12).fill(65);
    bytes.set(new TextEncoder().encode("newest-bytes"), bytes.byteLength - 12);
    ring.append(bytes);
    expect(ring.byteLength).toBe(MAX_SCROLLBACK_BYTES);
    expect(new TextDecoder().decode(ring.snapshot().slice(-12))).toBe("newest-bytes");
    expect(parseManagedTerminalClientMessage(JSON.stringify({ type: "takeover", expectedFenceEpoch: 7 }))).toEqual({
      ok: true,
      message: { type: "takeover", expectedFenceEpoch: 7 },
    });
    expect(parseManagedTerminalClientMessage(JSON.stringify({ type: "resize", cols: 2, rows: 9999 }))).toEqual({
      ok: true,
      message: { type: "resize", cols: 20, rows: 200 },
    });
  });

  test("dispatches root-terminal sockets to the untouched legacy handlers", () => {
    const open = spyOn(terminalWebSocketHandlers, "open").mockImplementation(() => {});
    try {
      const ws = { data: { kind: "root-terminal" } } as unknown as Bun.ServerWebSocket<TerminalSocketData>;
      terminalMultiplexedWebSocketHandlers.open(ws as unknown as Bun.ServerWebSocket<TerminalWebSocketData>);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });
});

describe("managed terminal respawn", () => {
  function socketDataFor(terminalId: string): ManagedTerminalSocketData {
    return {
      kind: "managed-terminal",
      connectionId: "respawn-connection",
      terminalId,
      sessionId: terminalId,
      tmuxName: tmuxSessionNameFor(terminalId),
      user: { userId: owner.userId, tenantId: owner.tenantId, bootstrapOwner: true } as ManagedTerminalSocketData["user"],
      identity: owner,
      clientIp: "local",
      openedAt: Date.now(),
      attachedAt: Date.now(),
      cols: 100,
      rows: 30,
      mode: "writer",
      fenceEpoch: 1,
      closing: false,
    };
  }

  test("recreates a missing tmux session with the derived name and recorded cwd", () => {
    const terminal = registerTerminal("respawn-terminal");
    const calls: string[][] = [];
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((...args: unknown[]) => {
      calls.push(args[0] as string[]);
      return { exitCode: 0 } as ReturnType<typeof Bun.spawnSync>;
    });
    try {
      expect(respawnManagedSession(socketDataFor(terminal.id))).toBe(true);
      expect(calls).toEqual([
        ["/usr/bin/tmux", "-L", TERMINAL_SOCKET, "new-session", "-d", "-s", tmuxSessionNameFor(terminal.id), "-c", root],
      ]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("fails closed when tmux cannot recreate the session and never spawns for unknown terminals", () => {
    const terminal = registerTerminal("respawn-failing");
    const failing = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 1 } as ReturnType<typeof Bun.spawnSync>);
    try {
      expect(respawnManagedSession(socketDataFor(terminal.id))).toBe(false);
    } finally {
      failing.mockRestore();
    }
    const spawn = spyOn(Bun, "spawnSync");
    try {
      expect(respawnManagedSession(socketDataFor("not-registered"))).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
});

describe("Slice 2a acceptance corrections", () => {
  test("reports legacy liveness as unmeasured and managed liveness as a boolean", () => {
    const managed = registerTerminal("alive-managed");
    const legacy = ensureLegacyRootTerminalRegistered(owner.userId, owner);
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 0,
      stdout: new TextEncoder().encode(`${tmuxSessionNameFor(managed.id)}\n`),
      stderr: new Uint8Array(),
    } as unknown as ReturnType<typeof Bun.spawnSync>);
    try {
      const terminals = listManagedTerminals(owner);
      expect(terminals.find((item) => item.session.id === legacy!.id)?.alive).toBeNull();
      expect(terminals.find((item) => item.session.id === managed.id)?.alive).toBe(true);
    } finally {
      spawn.mockRestore();
    }
  });

  test("allows the twelfth owner terminal and rejects the thirteenth before spawn", () => {
    for (let index = 0; index < MAX_TERMINALS_PER_OWNER - 1; index += 1) registerTerminal(`owner-limit-${index}`);
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as ReturnType<typeof Bun.spawnSync>);
    try {
      const twelfth = createTerminalSession({ identity: owner, actor: owner.userId, title: "twelfth", cwd: root });
      expect(twelfth.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const rejected = createTerminalSession({ identity: owner, actor: owner.userId, title: "thirteenth", cwd: root });
      expect(rejected).toEqual({ ok: false, error: "managed terminal limit reached", status: 429 });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(tmuxArgs("has-session", "-t", tmuxSessionNameFor("safe-id")).slice(0, 3)).toEqual(["/usr/bin/tmux", "-L", TERMINAL_SOCKET]);
    } finally {
      spawn.mockRestore();
    }
  });
});
