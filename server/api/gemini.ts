import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { normalizeWorkspace } from "./workspaces.ts";

const STATE_DIR = "/var/lib/control-surface";
const STATE_FILE = join(STATE_DIR, "gemini-sessions.json");
const GEMINI_BIN = "/usr/bin/gemini";
const activeGeminiRuns = new Map<string, { child: ChildProcessWithoutNullStreams; startedAt: number }>();

export type GeminiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
};

export type GeminiSession = {
  id: string;
  title: string;
  directory: string;
  geminiSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: GeminiMessage[];
  running?: boolean;
  runStartedAt?: number | null;
};

type State = { sessions: GeminiSession[] };

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

export async function geminiHealthHandler(): Promise<Response> {
  if (!existsSync(GEMINI_BIN)) {
    return json({ ok: false, error: `gemini CLI not found at ${GEMINI_BIN}` });
  }

  const versionRes = await probe(GEMINI_BIN, ["--version"]);
  if (versionRes.code !== 0) {
    return json({ ok: false, error: `gemini --version exit ${versionRes.code}: ${versionRes.stderr || versionRes.stdout}` });
  }
  const version = versionRes.stdout.split(/\s+/)[0] || "unknown";

  return json({ ok: true, version, auth: "installed (auth not probed)" });
}

// ── Session CRUD ──────────────────────────────────────────────────────────

export async function geminiListHandler(): Promise<Response> {
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
        geminiSessionId: s.geminiSessionId,
        running: activeGeminiRuns.has(s.id),
        runStartedAt: activeGeminiRuns.get(s.id)?.startedAt ?? null,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  });
}

export async function geminiCreateHandler(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { directory?: string; title?: string };
  const workspace = normalizeWorkspace(body.directory);
  if (workspace.ok === false) return json({ error: workspace.error }, 400);
  const directory = workspace.path;
  const title = body.title?.trim() || "New Gemini session";
  const now = Date.now();
  const session: GeminiSession = {
    id: `gem_${randomUUID()}`,
    title,
    directory,
    geminiSessionId: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const state = loadState();
  state.sessions.push(session);
  saveState(state);
  return json({ session });
}

export async function geminiGetHandler(id: string): Promise<Response> {
  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return json({ error: "not found" }, 404);
  return json({
    session: {
      ...session,
      running: activeGeminiRuns.has(id),
      runStartedAt: activeGeminiRuns.get(id)?.startedAt ?? null,
    },
  });
}

export async function geminiDeleteHandler(id: string): Promise<Response> {
  const state = loadState();
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.sessions.length === before) return json({ error: "not found" }, 404);
  saveState(state);
  return json({ ok: true });
}

// ── Streaming send ────────────────────────────────────────────────────────
//
// Spawns `gemini --prompt <text> --output-format stream-json --skip-trust
// [--session-id <uuid> | --resume <uuid>] [--approval-mode default|auto_edit|plan]`.
// Forwards each JSONL line as an SSE event.
//
// Events sent to the client:
//   started   — { geminiSessionId, model }
//   message   — { role, content, delta? }
//   tool_use  — { name, input }        (tool invocation announcements, if any)
//   error     — { error }
//   done      — { ok, geminiSessionId }

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type GeminiStreamEvent = {
  type?: string;
  session_id?: string;
  model?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
  stats?: unknown;
  [k: string]: unknown;
};

export async function geminiStreamHandler(req: Request, id: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { text?: string; approvalMode?: string; outputFormat?: string };
  const text = body.text?.trim() ?? "";
  if (!text) return new Response(JSON.stringify({ error: "text required" }), { status: 400 });

  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  if (activeGeminiRuns.has(id)) {
    return new Response(JSON.stringify({ error: "session already running" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  const isFirstTurn = !session.geminiSessionId;
  const targetSessionId = session.geminiSessionId ?? randomUUID();
  if (isFirstTurn) {
    session.geminiSessionId = targetSessionId;
  }

  const userMsg: GeminiMessage = {
    id: `m_${randomUUID()}`,
    role: "user",
    content: text,
    ts: Date.now(),
  };
  session.messages.push(userMsg);
  session.updatedAt = Date.now();
  saveState(state);

  // TODO(model-selector): inject --model <name> here when Gemini CLI supports per-request model selection.
  const outputFormat = body.outputFormat === "text" ? "text" : "stream-json";
  const args = [
    "--prompt", text,
    "--output-format", outputFormat,
    "--skip-trust",
    isFirstTurn ? "--session-id" : "--resume",
    targetSessionId,
  ];

  if (body.approvalMode && ["default", "auto_edit", "plan"].includes(body.approvalMode)) {
    args.push("--approval-mode", body.approvalMode);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(sseFrame(event, data))); } catch {}
      };

      const child = spawn(GEMINI_BIN, args, {
        cwd: session.directory,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeGeminiRuns.set(id, { child, startedAt: Date.now() });

      let stderr = "";
      const assistantTexts: string[] = [];
      let capturedSessionId: string | null = null;
      let capturedModel: string | null = null;

      send("started", { geminiSessionId: targetSessionId });

      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch {}
      }, 8000);

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let ev: GeminiStreamEvent;
        try { ev = JSON.parse(line) as GeminiStreamEvent; }
        catch { return; }

        if (ev.type === "init") {
          capturedSessionId = ev.session_id ?? null;
          capturedModel = ev.model ?? null;
          send("message", { role: "system", content: `session started: ${capturedSessionId ?? "?"} | model: ${capturedModel ?? "?"}` });
        } else if (ev.type === "message") {
          const role = ev.role ?? "assistant";
          const content = ev.content ?? "";
          if (role === "user") {
            // user message already stored; skip
          } else if (role === "assistant") {
            assistantTexts.push(content);
            send("message", { role: "assistant", content, delta: ev.delta ?? false });
          }
        } else if (ev.type === "tool_call" || ev.type === "tool_use") {
          send("tool_use", {
            name: (ev as { name?: string }).name ?? "tool",
            input: ev.input ?? ev,
          });
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });

      child.on("close", (code) => {
        activeGeminiRuns.delete(id);
        clearInterval(heartbeat);
        rl.close();

        const fresh = loadState();
        const target = fresh.sessions.find((s) => s.id === id);
        if (target) {
          if (capturedSessionId) target.geminiSessionId = capturedSessionId;

          const finalText = assistantTexts.join("").trim();
          const assistant: GeminiMessage = {
            id: `m_${randomUUID()}`,
            role: code === 0 ? "assistant" : "system",
            content: code === 0
              ? (finalText || "(gemini returned no message)")
              : `gemini exited ${code}\n${stderr.slice(-1000) || finalText}`,
            ts: Date.now(),
          };
          target.messages.push(assistant);
          target.updatedAt = Date.now();
          saveState(fresh);
        }

        if (code === 0) {
          send("done", { ok: true, geminiSessionId: capturedSessionId ?? targetSessionId });
        } else {
          send("error", {
            error: `gemini exited ${code}`,
            stderr: stderr.slice(-1500),
            exitCode: code,
          });
          send("done", { ok: false, geminiSessionId: capturedSessionId ?? targetSessionId });
        }

        try { controller.close(); } catch {}
      });

      child.on("error", (err) => {
        activeGeminiRuns.delete(id);
        clearInterval(heartbeat);
        send("error", { error: `gemini spawn error: ${err.message}` });
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

export async function geminiStopHandler(id: string): Promise<Response> {
  const active = activeGeminiRuns.get(id);
  if (!active) return json({ ok: true, stopped: false });

  try {
    active.child.kill("SIGTERM");
    setTimeout(() => {
      if (activeGeminiRuns.get(id)?.child === active.child) {
        try { active.child.kill("SIGKILL"); } catch {}
      }
    }, 5000).unref?.();
    return json({ ok: true, stopped: true });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
}