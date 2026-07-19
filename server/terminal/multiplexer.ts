import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket, Subprocess, Terminal } from "bun";
import { getAuthenticatedUser, type AuthenticatedUser } from "../auth/session.ts";
import { writeActionAudit } from "../db/writer.ts";
import { resolveRole } from "../governance/rbac.ts";
import { appendAgentEvent, type AgentIdentity, type AgentSession } from "../agentWorkspace/registry.ts";
import {
  MANAGED_NAME_PATTERN,
  acquireTerminalAttachmentWriter,
  releaseTerminalAttachmentWriter,
  resolveManagedTerminalSession,
  takeoverTerminalAttachmentWriter,
  tmuxArgs,
  tmuxSessionNameFor,
} from "./multiSession.ts";
import {
  isTerminalOriginAllowed,
  terminalWebSocketHandlers,
  type TerminalSocketData,
} from "./session.ts";

const MAX_MANAGED_CONNECTIONS = 6;
const MAX_CONNECTION_ATTEMPTS_PER_MINUTE = 12;
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
const MAX_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

type ManagedRelayProcess = Subprocess<"ignore", "ignore", "ignore">;

export const MAX_SCROLLBACK_BYTES = 1024 * 1024;

/** Raw, bounded PTY bytes. This deliberately has no terminal-content parser. */
export class ByteRing {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly maximumBytes = MAX_SCROLLBACK_BYTES) {}

  append(value: Uint8Array): void {
    if (value.byteLength === 0) return;
    const bytes = new Uint8Array(value);
    if (bytes.byteLength >= this.maximumBytes) {
      this.chunks = [bytes.slice(bytes.byteLength - this.maximumBytes)];
      this.size = this.chunks[0].byteLength;
      return;
    }
    this.chunks.push(bytes);
    this.size += bytes.byteLength;
    while (this.size > this.maximumBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      const excess = this.size - this.maximumBytes;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.size -= first.byteLength;
      } else {
        this.chunks[0] = first.slice(excess);
        this.size -= excess;
      }
    }
  }

  snapshot(): Uint8Array {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  get byteLength(): number {
    return this.size;
  }
}

export type ManagedTerminalSocketData = {
  kind: "managed-terminal";
  connectionId: string;
  terminalId: string;
  sessionId: string;
  tmuxName: string;
  user: AuthenticatedUser;
  identity: AgentIdentity;
  clientIp: string;
  openedAt: number;
  attachedAt: number;
  cols: number;
  rows: number;
  mode: "writer" | "spectator";
  fenceEpoch: number;
  closing: boolean;
};

export type TerminalWebSocketData = TerminalSocketData | ManagedTerminalSocketData;

type ManagedClientMessage =
  | { type: "input"; data: string | Uint8Array }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping"; id: string }
  | { type: "takeover"; expectedFenceEpoch: number };

type ManagedParseResult =
  | { ok: true; message: ManagedClientMessage }
  | { ok: false; error: string };

type Relay = {
  terminalId: string;
  tmuxName: string;
  terminal: Terminal;
  process: ManagedRelayProcess | null;
  clients: Map<string, ServerWebSocket<TerminalWebSocketData>>;
  scrollback: ByteRing;
  cols: number;
  rows: number;
  closing: boolean;
};

const relays = new Map<string, Relay>();
const activeManagedConnections = new Map<string, ServerWebSocket<TerminalWebSocketData>>();
const connectionAttempts = new Map<string, { count: number; startedAt: number }>();

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "local";
}

function consumeConnectionAttempt(ip: string): boolean {
  const now = Date.now();
  const current = connectionAttempts.get(ip);
  if (!current || now - current.startedAt >= 60_000) {
    connectionAttempts.set(ip, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= MAX_CONNECTION_ATTEMPTS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function isOpen(ws: ServerWebSocket<TerminalWebSocketData>): boolean {
  return ws.readyState === WebSocket.OPEN;
}

function sendJson(ws: ServerWebSocket<TerminalWebSocketData>, body: unknown): void {
  if (isOpen(ws)) ws.send(JSON.stringify(body), true);
}

function sanitizeReason(reason: string): string {
  const normalized = reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().toLowerCase();
  if (normalized === "attached") return "attached";
  if (normalized === "deliberate takeover") return "deliberate-takeover";
  if (normalized === "control surface shutting down") return "control-surface-shutdown";
  if (normalized === "managed relay exited") return "relay-exited";
  if (normalized === "client disconnected") return "client-disconnected";
  if (normalized === "websocket error") return "websocket-error";
  return "detached";
}

function metadata(data: ManagedTerminalSocketData, reason: string, durationMs = 0): Record<string, unknown> {
  return {
    sessionId: data.sessionId,
    terminalId: data.terminalId,
    connectionId: data.connectionId,
    mode: data.mode,
    fenceEpoch: data.fenceEpoch,
    durationMs: Math.max(0, durationMs),
    reason: sanitizeReason(reason),
  };
}

function writeAttachmentMetadata(
  kind: "attached" | "detached" | "writer_takeover",
  session: AgentSession,
  data: ManagedTerminalSocketData,
  reason: string,
  durationMs = 0,
): void {
  const payload = metadata(data, reason, durationMs);
  appendAgentEvent({ session, kind: `terminal.${kind}`, payload });
  writeActionAudit({
    userId: data.user.userId,
    actor: data.user.email || data.user.name || data.user.userId,
    actorSource: data.user.source,
    actionKind: `terminal.${kind}`,
    actionId: data.connectionId,
    targetType: "terminal-session",
    targetId: data.terminalId,
    risk: "high",
    request: payload,
    result: `managed terminal ${kind}`,
    resultStatus: "success",
  });
}

/** The managed parser is intentionally independent from the root-terminal parser. */
export function parseManagedTerminalClientMessage(raw: string | Uint8Array | ArrayBuffer): ManagedParseResult {
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.byteLength > MAX_CLIENT_MESSAGE_BYTES) return { ok: false, error: "input payload too large" };
    return { ok: true, message: { type: "input", data: bytes } };
  }
  if (textEncoder.encode(raw).byteLength > MAX_CLIENT_MESSAGE_BYTES) {
    return { ok: false, error: "message payload too large" };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid terminal message" };
  }
  if (!body || typeof body !== "object" || !("type" in body)) {
    return { ok: false, error: "invalid terminal message" };
  }
  const message = body as Record<string, unknown>;
  if (message.type === "input") {
    if (typeof message.data !== "string") return { ok: false, error: "input must be a string" };
    if (textEncoder.encode(message.data).byteLength > MAX_CLIENT_MESSAGE_BYTES) {
      return { ok: false, error: "input payload too large" };
    }
    return { ok: true, message: { type: "input", data: message.data } };
  }
  if (message.type === "resize") {
    return {
      ok: true,
      message: {
        type: "resize",
        cols: clampDimension(message.cols, 20, 400, 100),
        rows: clampDimension(message.rows, 6, 200, 30),
      },
    };
  }
  if (message.type === "ping") {
    return { ok: true, message: { type: "ping", id: typeof message.id === "string" ? message.id.slice(0, 80) : "" } };
  }
  if (message.type === "takeover") {
    if (!Number.isInteger(message.expectedFenceEpoch) || (message.expectedFenceEpoch as number) < 0) {
      return { ok: false, error: "expectedFenceEpoch must be a non-negative integer" };
    }
    return { ok: true, message: { type: "takeover", expectedFenceEpoch: message.expectedFenceEpoch as number } };
  }
  return { ok: false, error: "unsupported terminal message" };
}

function relayNameIsValid(terminalId: string, tmuxName: string): boolean {
  return MANAGED_NAME_PATTERN.test(tmuxName) && tmuxName === tmuxSessionNameFor(terminalId);
}

function stopRelay(relay: Relay): void {
  if (relay.closing) return;
  relay.closing = true;
  try { relay.process?.kill("SIGTERM"); } catch { /* exact attach relay already exited */ }
  try { relay.terminal.close(); } catch { /* terminal already closed */ }
  relay.process = null;
  relays.delete(relay.terminalId);
}

function closeBackpressuredClient(ws: ServerWebSocket<TerminalWebSocketData>): void {
  try { ws.close(1013, "terminal client backpressure limit reached"); } catch { /* socket already closed */ }
}

function broadcastOutput(relay: Relay, chunk: Uint8Array): void {
  relay.scrollback.append(chunk);
  for (const ws of relay.clients.values()) {
    if (!isOpen(ws)) continue;
    if (ws.getBufferedAmount() > MAX_BACKPRESSURE_BYTES) {
      closeBackpressuredClient(ws);
      continue;
    }
    try { ws.send(chunk, true); } catch { closeBackpressuredClient(ws); }
  }
}

function relayExited(relay: Relay, exitCode: number | null, signalCode: number | null): void {
  if (relay.closing) return;
  relay.closing = true;
  relays.delete(relay.terminalId);
  relay.process = null;
  for (const ws of [...relay.clients.values()]) {
    sendJson(ws, { type: "exit", state: "unreachable", exitCode, signal: signalCode });
    releaseManagedSocket(ws, "managed relay exited");
    try { ws.close(1011, "managed terminal relay exited"); } catch { /* already closed */ }
  }
}

function createRelay(data: ManagedTerminalSocketData): Relay | null {
  if (!relayNameIsValid(data.terminalId, data.tmuxName)) return null;
  try {
    const liveness = Bun.spawnSync(tmuxArgs("has-session", "-t", data.tmuxName), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (liveness.exitCode !== 0) return null;

    const capture = Bun.spawnSync(tmuxArgs("capture-pane", "-p", "-e", "-J", "-S", "-2000", "-t", data.tmuxName), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (capture.exitCode !== 0) return null;
    const scrollback = new ByteRing();
    scrollback.append(new Uint8Array(capture.stdout));

    let relay: Relay;
    const terminal = new Bun.Terminal({
      cols: data.cols,
      rows: data.rows,
      name: "xterm-256color",
      data(_terminal, chunk) {
        broadcastOutput(relay, new Uint8Array(chunk));
      },
    });
    relay = {
      terminalId: data.terminalId,
      tmuxName: data.tmuxName,
      terminal,
      process: null,
      clients: new Map(),
      scrollback,
      cols: data.cols,
      rows: data.rows,
      closing: false,
    };
    const process = Bun.spawn(tmuxArgs("attach-session", "-t", data.tmuxName), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      terminal,
      onExit(_process, exitCode, signalCode) {
        relayExited(relay, exitCode, signalCode);
      },
    }) as ManagedRelayProcess;
    relay.process = process;
    relays.set(data.terminalId, relay);
    return relay;
  } catch {
    return null;
  }
}

function writerState(relay: Relay, holderSessionId: string | null, fenceEpoch: number): void {
  for (const ws of relay.clients.values()) {
    const data = ws.data;
    if (data.kind !== "managed-terminal") continue;
    data.fenceEpoch = fenceEpoch;
    data.mode = holderSessionId === data.connectionId ? "writer" : "spectator";
    sendJson(ws, {
      type: "writer-state",
      terminalId: data.terminalId,
      connectionId: holderSessionId,
      mode: data.mode,
      fenceEpoch,
    });
  }
}

function validateWriter(data: ManagedTerminalSocketData, relay: Relay, ws: ServerWebSocket<TerminalWebSocketData>): boolean {
  if (data.mode !== "writer") {
    sendJson(ws, { type: "error", code: "read-only", error: "terminal attachment is read-only" });
    return false;
  }
  const lease = acquireTerminalAttachmentWriter({
    identity: data.identity,
    terminalId: data.terminalId,
    connectionId: data.connectionId,
  });
  if (lease.ok === false) {
    writerState(relay, lease.holderSessionId, lease.fenceEpoch);
    sendJson(ws, { type: "error", code: "writer-fenced", error: "terminal writer lease is no longer current", fenceEpoch: lease.fenceEpoch });
    return false;
  }
  if (lease.fenceEpoch !== data.fenceEpoch) {
    releaseTerminalAttachmentWriter({
      terminalId: data.terminalId,
      connectionId: data.connectionId,
      fenceEpoch: lease.fenceEpoch,
    });
    writerState(relay, null, lease.fenceEpoch);
    sendJson(ws, { type: "error", code: "writer-fenced", error: "terminal writer lease is no longer current", fenceEpoch: lease.fenceEpoch });
    return false;
  }
  return true;
}

function releaseManagedSocket(ws: ServerWebSocket<TerminalWebSocketData>, reason: string): void {
  const data = ws.data;
  if (data.kind !== "managed-terminal" || data.closing) return;
  data.closing = true;
  activeManagedConnections.delete(data.connectionId);
  const relay = relays.get(data.terminalId);
  if (data.mode === "writer") {
    releaseTerminalAttachmentWriter({
      terminalId: data.terminalId,
      connectionId: data.connectionId,
      fenceEpoch: data.fenceEpoch,
    });
  }
  relay?.clients.delete(data.connectionId);
  const session = resolveManagedTerminalSession(data.identity, data.terminalId);
  if (session) {
    writeAttachmentMetadata("detached", session, data, reason, Date.now() - data.attachedAt);
  }
  if (relay && relay.clients.size === 0) stopRelay(relay);
}

function openManagedSocket(ws: ServerWebSocket<TerminalWebSocketData>): void {
  const data = ws.data;
  if (data.kind !== "managed-terminal") return;
  const session = resolveManagedTerminalSession(data.identity, data.terminalId);
  if (!session || session.id !== data.sessionId || session.adapterSessionId !== data.tmuxName) {
    sendJson(ws, { type: "exit", state: "unreachable" });
    try { ws.close(1011, "managed terminal is unavailable"); } catch { /* already closed */ }
    return;
  }
  let relay = relays.get(data.terminalId);
  if (!relay) relay = createRelay(data);
  if (!relay) {
    sendJson(ws, { type: "exit", state: "unreachable" });
    try { ws.close(1011, "managed terminal is unreachable"); } catch { /* already closed */ }
    return;
  }

  data.cols = relay.cols;
  data.rows = relay.rows;
  const lease = acquireTerminalAttachmentWriter({
    identity: data.identity,
    terminalId: data.terminalId,
    connectionId: data.connectionId,
  });
  if (lease.ok) {
    data.mode = "writer";
    data.fenceEpoch = lease.fenceEpoch;
  } else {
    data.mode = "spectator";
    data.fenceEpoch = lease.fenceEpoch;
  }
  const snapshot = relay.scrollback.snapshot();
  sendJson(ws, {
    type: "ready",
    connectionId: data.connectionId,
    terminalId: data.terminalId,
    mode: data.mode,
    fenceEpoch: data.fenceEpoch,
    persistent: true,
    attachmentCount: relay.clients.size + 1,
  });
  if (snapshot.byteLength > 0 && isOpen(ws)) ws.send(snapshot, true);
  relay.clients.set(data.connectionId, ws);
  activeManagedConnections.set(data.connectionId, ws);
  writeAttachmentMetadata("attached", session, data, "attached");
}

function messageManagedSocket(ws: ServerWebSocket<TerminalWebSocketData>, raw: string | Uint8Array): void {
  const data = ws.data;
  if (data.kind !== "managed-terminal") return;
  const parsed = parseManagedTerminalClientMessage(raw);
  if (parsed.ok === false) {
    sendJson(ws, { type: "error", error: parsed.error });
    return;
  }
  if (parsed.message.type === "ping") {
    sendJson(ws, { type: "pong", id: parsed.message.id, at: Date.now() });
    return;
  }
  const relay = relays.get(data.terminalId);
  if (!relay || relay.closing || !relay.clients.has(data.connectionId)) {
    sendJson(ws, { type: "error", code: "unreachable", error: "managed terminal relay is unavailable" });
    return;
  }
  if (parsed.message.type === "takeover") {
    const result = takeoverTerminalAttachmentWriter({
      identity: data.identity,
      terminalId: data.terminalId,
      connectionId: data.connectionId,
      expectedFenceEpoch: parsed.message.expectedFenceEpoch,
    });
    if (result.ok === false) {
      writerState(relay, result.holderSessionId, result.fenceEpoch);
      sendJson(ws, {
        type: "error",
        code: "takeover-conflict",
        error: "terminal writer state changed",
        fenceEpoch: result.fenceEpoch,
        holderConnectionId: result.holderSessionId,
      });
      return;
    }
    writerState(relay, data.connectionId, result.fenceEpoch);
    const session = resolveManagedTerminalSession(data.identity, data.terminalId);
    if (session) writeAttachmentMetadata("writer_takeover", session, data, "deliberate takeover");
    return;
  }
  if (!validateWriter(data, relay, ws)) return;
  if (parsed.message.type === "input") {
    relay.terminal.write(parsed.message.data);
    return;
  }
  relay.cols = parsed.message.cols;
  relay.rows = parsed.message.rows;
  data.cols = parsed.message.cols;
  data.rows = parsed.message.rows;
  relay.terminal.resize(parsed.message.cols, parsed.message.rows);
}

/**
 * Upgrades an already path-validated managed terminal endpoint. All registry
 * visibility and derived-name checks happen before any tmux operation.
 */
export function managedTerminalUpgradeHandler(
  req: Request,
  terminalId: string,
  server: Server<TerminalWebSocketData>,
): Response | undefined {
  if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return response({ error: "websocket upgrade required" }, 426);
  }
  if (!process.env.OPERATOR_TOKEN) return response({ error: "operator token required" }, 401);
  const user = getAuthenticatedUser(req);
  if (!user?.bootstrapOwner) return response({ error: "operator token required" }, 401);
  if (!isTerminalOriginAllowed(req)) return response({ error: "origin not allowed" }, 403);
  const identity: AgentIdentity = { tenantId: user.tenantId, userId: user.userId, role: resolveRole(user) };
  const session = resolveManagedTerminalSession(identity, terminalId);
  if (!session) return response({ error: "terminal session not found" }, 404);
  if (activeManagedConnections.size >= MAX_MANAGED_CONNECTIONS) {
    return response({ error: "terminal connection limit reached" }, 503);
  }
  const ip = clientIp(req);
  if (!consumeConnectionAttempt(ip)) return response({ error: "too many terminal connection attempts" }, 429);
  const upgraded = server.upgrade(req, {
    data: {
      kind: "managed-terminal",
      connectionId: randomUUID(),
      terminalId: session.id,
      sessionId: session.id,
      tmuxName: session.adapterSessionId,
      user,
      identity,
      clientIp: ip,
      openedAt: Date.now(),
      attachedAt: Date.now(),
      cols: 100,
      rows: 30,
      mode: "spectator",
      fenceEpoch: 0,
      closing: false,
    },
  });
  return upgraded ? undefined : response({ error: "websocket upgrade failed" }, 500);
}

/** One Bun handler table, with the legacy root-terminal path dispatched unchanged. */
export const terminalMultiplexedWebSocketHandlers = {
  open(ws: ServerWebSocket<TerminalWebSocketData>) {
    if (ws.data.kind === "root-terminal") {
      terminalWebSocketHandlers.open(ws as unknown as ServerWebSocket<TerminalSocketData>);
      return;
    }
    openManagedSocket(ws);
  },

  message(ws: ServerWebSocket<TerminalWebSocketData>, raw: string | Uint8Array) {
    if (ws.data.kind === "root-terminal") {
      terminalWebSocketHandlers.message(ws as unknown as ServerWebSocket<TerminalSocketData>, raw);
      return;
    }
    messageManagedSocket(ws, raw);
  },

  close(ws: ServerWebSocket<TerminalWebSocketData>, code: number, reason: string) {
    if (ws.data.kind === "root-terminal") {
      terminalWebSocketHandlers.close(ws as unknown as ServerWebSocket<TerminalSocketData>, code, reason);
      return;
    }
    releaseManagedSocket(ws, reason || "client disconnected");
  },

  error(ws: ServerWebSocket<TerminalWebSocketData>, error: Error) {
    if (ws.data.kind === "root-terminal") {
      terminalWebSocketHandlers.error(ws as unknown as ServerWebSocket<TerminalSocketData>, error);
      return;
    }
    releaseManagedSocket(ws, error.message || "websocket error");
  },

  idleTimeout: 0,
  maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
  backpressureLimit: MAX_BACKPRESSURE_BYTES,
  closeOnBackpressureLimit: true,
  sendPings: true,
  perMessageDeflate: false,
};

/** Releases exact connection leases and only the Control Surface attach relays. */
export function closeManagedTerminalClients(): void {
  for (const ws of [...activeManagedConnections.values()]) {
    releaseManagedSocket(ws, "control surface shutting down");
    try { ws.close(1012, "control surface shutting down"); } catch { /* already closed */ }
  }
  for (const relay of [...relays.values()]) stopRelay(relay);
}
