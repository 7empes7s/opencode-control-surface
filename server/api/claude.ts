import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { normalizeWorkspace } from "./workspaces.ts";

const STATE_DIR = "/var/lib/control-surface";
const STATE_FILE = join(STATE_DIR, "claude-sessions.json");
const CLAUDE_BIN = "/root/.local/bin/claude";
const activeClaudeRuns = new Map<string, { child: ChildProcessWithoutNullStreams; startedAt: number }>();

export type ClaudeMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
};

export type ClaudeSession = {
  id: string;
  title: string;
  directory: string;
  claudeSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: ClaudeMessage[];
  running?: boolean;
  runStartedAt?: number | null;
};

type State = { sessions: ClaudeSession[] };

function loadState(): State {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return { sessions: [] };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { sessions: [] };
  }
}

function saveState(state: State): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function probe(cmd: string, args: string[], timeoutMs = 4000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: e.message, code: -1 });
    });
  });
}

export async function claudeHealthHandler(): Promise<Response> {
  if (!existsSync(CLAUDE_BIN)) {
    return json({ ok: false, error: `claude CLI not found at ${CLAUDE_BIN}` });
  }

  const versionRes = await probe(CLAUDE_BIN, ["--version"]);
  if (versionRes.code !== 0) {
    return json({ ok: false, error: `claude --version exit ${versionRes.code}: ${versionRes.stderr || versionRes.stdout}` });
  }
  const version = versionRes.stdout.split(/\s+/)[0] || "unknown";

  return json({ ok: true, version, auth: "installed (auth not probed)" });
}

// ── Session CRUD ──────────────────────────────────────────────────────────

export async function claudeListHandler(): Promise<Response> {
  const state = loadState();
  return json({
    sessions: state.sessions
      .map((s) => ({
        id: s.id,
        title: s.title,
        directory: s.directory,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        claudeSessionId: s.claudeSessionId,
        running: activeClaudeRuns.has(s.id),
        runStartedAt: activeClaudeRuns.get(s.id)?.startedAt ?? null,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  });
}

export async function claudeCreateHandler(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { directory?: string; title?: string };
  const workspace = normalizeWorkspace(body.directory);
  if (workspace.ok === false) return json({ error: workspace.error }, 400);
  const directory = workspace.path;
  const title = body.title?.trim() || "New Claude session";
  const now = Date.now();
  const session: ClaudeSession = {
    id: `cld_${randomUUID()}`,
    title,
    directory,
    claudeSessionId: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const state = loadState();
  state.sessions.push(session);
  saveState(state);
  return json({ session });
}

export async function claudeGetHandler(id: string): Promise<Response> {
  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return json({ error: "not found" }, 404);
  return json({
    session: {
      ...session,
      running: activeClaudeRuns.has(id),
      runStartedAt: activeClaudeRuns.get(id)?.startedAt ?? null,
    },
  });
}

export async function claudeDeleteHandler(id: string): Promise<Response> {
  const state = loadState();
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.sessions.length === before) return json({ error: "not found" }, 404);
  saveState(state);
  return json({ ok: true });
}

// ── Streaming send ────────────────────────────────────────────────────────
//
// Spawns `claude -p <prompt> --output-format stream-json --include-partial-messages
// [--session-id <uuid> | --resume <uuid>] --permission-mode dontAsk`.
// Forwards each JSONL line as an SSE event.
//
// Events sent to the client:
//   started   — { claudeSessionId }
//   assistant — { text }              (each assistant text item)
//   tool_use  — { name, input }       (tool invocation announcements)
//   error     — { error }
//   done      — { ok, claudeSessionId }

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; content?: unknown }
  | { type: string; [k: string]: unknown };

type ClaudeStreamEvent =
  | { type: "system"; subtype?: string; session_id?: string; [k: string]: unknown }
  | { type: "assistant"; message: { content: ClaudeContentBlock[] }; session_id?: string; [k: string]: unknown }
  | { type: "user"; message: { content: ClaudeContentBlock[] }; [k: string]: unknown }
  | { type: "result"; subtype?: string; session_id?: string; result?: string; is_error?: boolean; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export async function claudeStreamHandler(req: Request, id: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = body.text?.trim() ?? "";
  if (!text) return new Response(JSON.stringify({ error: "text required" }), { status: 400 });

  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  if (activeClaudeRuns.has(id)) {
    return new Response(JSON.stringify({ error: "session already running" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  // First send: pick our own UUID via --session-id. Subsequent: --resume <uuid>.
  const isFirstTurn = !session.claudeSessionId;
  const targetSessionId = session.claudeSessionId ?? randomUUID();
  if (isFirstTurn) {
    session.claudeSessionId = targetSessionId;
  }

  const userMsg: ClaudeMessage = {
    id: `m_${randomUUID()}`,
    role: "user",
    content: text,
    ts: Date.now(),
  };
  session.messages.push(userMsg);
  session.updatedAt = Date.now();
  saveState(state);

  const args = [
    "-p", text,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--verbose",
    isFirstTurn ? "--session-id" : "--resume",
    targetSessionId,
  ];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(sseFrame(event, data))); } catch {}
      };

      const child = spawn(CLAUDE_BIN, args, {
        cwd: session.directory,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeClaudeRuns.set(id, { child, startedAt: Date.now() });

      let stderr = "";
      const assistantTexts: string[] = [];
      let capturedSessionId: string | null = null;

      send("started", { claudeSessionId: targetSessionId });

      // Send a comment-frame heartbeat every 8 s so proxies / Bun never see idle.
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch {}
      }, 8000);

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let ev: ClaudeStreamEvent;
        try { ev = JSON.parse(line) as ClaudeStreamEvent; }
        catch { return; }

        if (ev.type === "system" && (ev as { session_id?: string }).session_id) {
          capturedSessionId = (ev as { session_id: string }).session_id;
        } else if (ev.type === "assistant") {
          const blocks = (ev as { message?: { content?: ClaudeContentBlock[] } }).message?.content ?? [];
          for (const b of blocks) {
            if (b.type === "text" && typeof (b as { text?: string }).text === "string") {
              const t = (b as { text: string }).text;
              assistantTexts.push(t);
              send("assistant", { text: t });
            } else if (b.type === "tool_use") {
              send("tool_use", {
                name: (b as { name?: string }).name,
                input: (b as { input?: unknown }).input,
              });
            }
          }
        } else if (ev.type === "result") {
          if ((ev as { session_id?: string }).session_id) {
            capturedSessionId = (ev as { session_id: string }).session_id;
          }
          if ((ev as { is_error?: boolean }).is_error) {
            send("error", {
              error: (ev as { result?: string }).result || "claude reported an error",
              subtype: (ev as { subtype?: string }).subtype,
            });
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });

      child.on("close", (code) => {
        activeClaudeRuns.delete(id);
        clearInterval(heartbeat);
        rl.close();

        const fresh = loadState();
        const target = fresh.sessions.find((s) => s.id === id);
        if (target) {
          if (capturedSessionId) target.claudeSessionId = capturedSessionId;

          const finalText = assistantTexts.join("\n").trim();
          const assistant: ClaudeMessage = {
            id: `m_${randomUUID()}`,
            role: code === 0 ? "assistant" : "system",
            content: code === 0
              ? (finalText || "(claude returned no message)")
              : `claude exited ${code}\n${stderr.slice(-1000) || finalText}`,
            ts: Date.now(),
          };
          target.messages.push(assistant);
          target.updatedAt = Date.now();
          saveState(fresh);
        }

        if (code === 0) {
          send("done", { ok: true, claudeSessionId: capturedSessionId ?? targetSessionId });
        } else {
          send("error", {
            error: `claude exited ${code}`,
            stderr: stderr.slice(-1500),
            exitCode: code,
          });
          send("done", { ok: false, claudeSessionId: capturedSessionId ?? targetSessionId });
        }

        try { controller.close(); } catch {}
      });

      child.on("error", (err) => {
        activeClaudeRuns.delete(id);
        clearInterval(heartbeat);
        send("error", { error: `claude spawn error: ${err.message}` });
        send("done", { ok: false });
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function claudeStopHandler(id: string): Promise<Response> {
  const active = activeClaudeRuns.get(id);
  if (!active) return json({ ok: true, stopped: false });

  try {
    active.child.kill("SIGTERM");
    setTimeout(() => {
      if (activeClaudeRuns.get(id)?.child === active.child) {
        try { active.child.kill("SIGKILL"); } catch {}
      }
    }, 5000).unref?.();
    return json({ ok: true, stopped: true });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
