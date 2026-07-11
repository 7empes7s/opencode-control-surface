import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket, Subprocess, Terminal } from "bun";
import { getAuthenticatedUser, isLocalRequest, type AuthenticatedUser } from "../auth/session.ts";
import { writeActionAudit } from "../db/writer.ts";

const DEFAULT_SESSION_NAME = "tib-root";
const MAX_CONNECTIONS = 6;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CONNECTION_ATTEMPTS_PER_MINUTE = 12;
const textEncoder = new TextEncoder();

type TerminalProcess = Subprocess<"ignore", "ignore", "ignore">;

export type TerminalSocketData = {
  kind: "root-terminal";
  connectionId: string;
  user: AuthenticatedUser;
  clientIp: string;
  openedAt: number;
  cols: number;
  rows: number;
  terminal: Terminal | null;
  process: TerminalProcess | null;
  closing: boolean;
};

export type TerminalClientMessage =
  | { type: "input"; data: string | Uint8Array }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping"; id: string };

type ParseResult =
  | { ok: true; message: TerminalClientMessage }
  | { ok: false; error: string };

const activeConnections = new Map<string, TerminalSocketData>();
const connectionAttempts = new Map<string, { count: number; startedAt: number }>();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function terminalSessionName(): string {
  const configured = process.env.DASHBOARD_TERMINAL_SESSION?.trim() || DEFAULT_SESSION_NAME;
  return /^[a-zA-Z0-9_-]{1,64}$/.test(configured) ? configured : DEFAULT_SESSION_NAME;
}

function terminalOperator(req: Request): AuthenticatedUser | null {
  // A root shell is deliberately stricter than normal dashboard reads. A
  // signed local/SSO session is not enough: the connection must resolve to
  // the bootstrap owner backed by OPERATOR_TOKEN (or the local dev bootstrap).
  if (!process.env.OPERATOR_TOKEN) return null;
  const user = getAuthenticatedUser(req);
  return user?.bootstrapOwner ? user : null;
}

export function isTerminalOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return isLocalRequest(req);

  try {
    const originUrl = new URL(origin);
    const requestHost = req.headers.get("host")?.toLowerCase() ?? "";
    return Boolean(requestHost) && originUrl.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
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

export function parseTerminalClientMessage(raw: string | Uint8Array | ArrayBuffer): ParseResult {
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.byteLength > MAX_INPUT_BYTES) return { ok: false, error: "input payload too large" };
    return { ok: true, message: { type: "input", data: bytes } };
  }

  if (textEncoder.encode(raw).byteLength > MAX_INPUT_BYTES) {
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
    if (textEncoder.encode(message.data).byteLength > MAX_INPUT_BYTES) {
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
    const id = typeof message.id === "string" ? message.id.slice(0, 80) : "";
    return { ok: true, message: { type: "ping", id } };
  }

  return { ok: false, error: "unsupported terminal message" };
}

function tmuxSessionExists(): boolean {
  const probe = Bun.spawnSync(["/usr/bin/tmux", "has-session", "-t", terminalSessionName()], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exitCode === 0;
}

function commandExists(command: string): boolean {
  const probe = Bun.spawnSync(["/usr/bin/bash", "-lc", `command -v ${command}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exitCode === 0;
}

export function terminalStatusHandler(req: Request): Response {
  const user = terminalOperator(req);
  if (!user) return json({ error: "operator token required" }, 401);

  const cliCommands = ["codex", "opencode", "claude", "gemini", "aider"]
    .filter(commandExists);
  return json({
    ok: true,
    host: hostname(),
    user: "root",
    cwd: "/root",
    shell: "/bin/bash -l",
    session: terminalSessionName(),
    persistent: true,
    sessionActive: tmuxSessionExists(),
    connectedClients: activeConnections.size,
    cliCommands,
  });
}

export function terminalUpgradeHandler(req: Request, server: Server<TerminalSocketData>): Response | undefined {
  if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket upgrade required" }, 426);
  }

  const user = terminalOperator(req);
  if (!user) return json({ error: "operator token required" }, 401);
  if (!isTerminalOriginAllowed(req)) return json({ error: "origin not allowed" }, 403);
  if (activeConnections.size >= MAX_CONNECTIONS) return json({ error: "terminal connection limit reached" }, 503);

  const ip = clientIp(req);
  if (!consumeConnectionAttempt(ip)) return json({ error: "too many terminal connection attempts" }, 429);

  const upgraded = server.upgrade(req, {
    data: {
      kind: "root-terminal",
      connectionId: randomUUID(),
      user,
      clientIp: ip,
      openedAt: Date.now(),
      cols: 100,
      rows: 30,
      terminal: null,
      process: null,
      closing: false,
    },
  });
  if (!upgraded) return json({ error: "websocket upgrade failed" }, 500);
  return undefined;
}

function sendJson(ws: ServerWebSocket<TerminalSocketData>, body: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(body), true);
}

function spawnTerminal(ws: ServerWebSocket<TerminalSocketData>): void {
  const data = ws.data;
  const session = terminalSessionName();
  const attachCommand = [
    "umask 077",
    `tmux has-session -t ${session} 2>/dev/null || tmux new-session -d -s ${session} -c /root`,
    `tmux set-option -t ${session} window-size latest 2>/dev/null || true`,
    `exec tmux attach-session -t ${session}`,
  ].join("; ");

  const terminal = new Bun.Terminal({
    cols: data.cols,
    rows: data.rows,
    name: "xterm-256color",
    data(_terminal, chunk) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, true);
    },
  });

  const proc = Bun.spawn(["/usr/bin/bash", "-lc", attachCommand], {
    cwd: "/root",
    env: {
      ...process.env,
      HOME: "/root",
      USER: "root",
      LOGNAME: "root",
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG || "C.UTF-8",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    terminal,
    onExit(_process, exitCode, signalCode, error) {
      data.process = null;
      data.terminal = null;
      if (!data.closing) {
        sendJson(ws, {
          type: "exit",
          exitCode,
          signal: signalCode,
          error: error ? "terminal process exited unexpectedly" : undefined,
        });
        ws.close(1011, "terminal process exited");
      }
    },
  }) as TerminalProcess;

  data.terminal = terminal;
  data.process = proc;
  activeConnections.set(data.connectionId, data);

  writeActionAudit({
    userId: data.user.userId,
    actor: data.user.email || data.user.name || data.user.userId,
    actorSource: data.user.source,
    actionKind: "terminal.connect",
    actionId: data.connectionId,
    targetType: "root-shell",
    targetId: session,
    risk: "high",
    request: { connectionId: data.connectionId, clientIp: data.clientIp },
    result: "root terminal attached",
    resultStatus: "success",
  });

  sendJson(ws, {
    type: "ready",
    connectionId: data.connectionId,
    session,
    host: hostname(),
    persistent: true,
    connectedClients: activeConnections.size,
  });
}

function releaseTerminal(data: TerminalSocketData, reason: string): void {
  if (data.closing) return;
  data.closing = true;
  activeConnections.delete(data.connectionId);

  try { data.process?.kill("SIGTERM"); } catch { /* already exited */ }
  try { data.terminal?.close(); } catch { /* already closed */ }
  data.process = null;
  data.terminal = null;

  writeActionAudit({
    userId: data.user.userId,
    actor: data.user.email || data.user.name || data.user.userId,
    actorSource: data.user.source,
    actionKind: "terminal.disconnect",
    actionId: data.connectionId,
    targetType: "root-shell",
    targetId: terminalSessionName(),
    risk: "high",
    request: {
      connectionId: data.connectionId,
      durationMs: Math.max(0, Date.now() - data.openedAt),
      reason: reason.slice(0, 120),
    },
    result: "terminal client detached; tmux session preserved",
    resultStatus: "success",
  });
}

export const terminalWebSocketHandlers = {
  open(ws: ServerWebSocket<TerminalSocketData>) {
    spawnTerminal(ws);
  },

  message(ws: ServerWebSocket<TerminalSocketData>, raw: string | Uint8Array) {
    const parsed = parseTerminalClientMessage(raw);
    if (!parsed.ok) {
      sendJson(ws, { type: "error", error: "error" in parsed ? parsed.error : "invalid terminal message" });
      return;
    }

    const terminal = ws.data.terminal;
    if (!terminal || terminal.closed) return;

    if (parsed.message.type === "input") {
      terminal.write(parsed.message.data);
      return;
    }
    if (parsed.message.type === "resize") {
      ws.data.cols = parsed.message.cols;
      ws.data.rows = parsed.message.rows;
      terminal.resize(parsed.message.cols, parsed.message.rows);
      return;
    }
    sendJson(ws, { type: "pong", id: parsed.message.id, at: Date.now() });
  },

  close(ws: ServerWebSocket<TerminalSocketData>, _code: number, reason: string) {
    releaseTerminal(ws.data, reason || "client disconnected");
  },

  error(ws: ServerWebSocket<TerminalSocketData>, error: Error) {
    releaseTerminal(ws.data, error.message || "websocket error");
  },

  idleTimeout: 0,
  maxPayloadLength: MAX_INPUT_BYTES,
  backpressureLimit: 4 * 1024 * 1024,
  closeOnBackpressureLimit: true,
  sendPings: true,
  perMessageDeflate: false,
};

export function closeTerminalClients(): void {
  for (const data of [...activeConnections.values()]) {
    releaseTerminal(data, "control surface shutting down");
  }
}
