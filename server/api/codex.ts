import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { normalizeWorkspace } from "./workspaces.ts";

const STATE_DIR = "/var/lib/control-surface";
const STATE_FILE = join(STATE_DIR, "codex-sessions.json");
const CODEX_SESSIONS_DIR = "/root/.codex/sessions";
const activeCodexRuns = new Map<string, { child: ChildProcessWithoutNullStreams; startedAt: number }>();

export type CodexMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  items?: CodexStreamItem[];
};

export type CodexSession = {
  id: string;
  title: string;
  directory: string;
  codexSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: CodexMessage[];
  running?: boolean;
  runStartedAt?: number | null;
};

type State = { sessions: CodexSession[] };

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

// Walk ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and find the newest after `since`
function findNewestRolloutSince(since: number): { sessionId: string; path: string; mtime: number } | null {
  if (!existsSync(CODEX_SESSIONS_DIR)) return null;
  let best: { sessionId: string; path: string; mtime: number } | null = null;
  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        const st = statSync(full);
        if (st.mtimeMs >= since) {
          // Filename: rollout-2026-05-08T07-30-12-<uuid>.jsonl
          const m = e.name.match(/rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
          if (m && (!best || st.mtimeMs > best.mtime)) {
            best = { sessionId: m[1], path: full, mtime: st.mtimeMs };
          }
        }
      }
    }
  }
  try { walk(CODEX_SESSIONS_DIR); } catch {}
  return best;
}

async function runCodex({
  prompt,
  directory,
  resumeId,
}: {
  prompt: string;
  directory: string;
  resumeId: string | null;
}): Promise<{ output: string; exitCode: number; capturedSessionId: string | null; stderr: string }> {
  const outFile = join(tmpdir(), `codex-out-${randomUUID()}.txt`);
  const startedAt = Date.now() - 1000; // minor backstop for filesystem mtime granularity

  // `codex exec` and `codex exec resume` have different option sets — build them separately.
  // Resume picks up the original working directory from the saved session, so -C and --color
  // (which the resume subcommand rejects) are only valid on the first run.
  let args: string[];
  if (resumeId) {
    args = [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-o", outFile,
      resumeId,
      prompt,
    ];
  } else {
    args = [
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--color", "never",
      "-o", outFile,
      "-C", directory,
      prompt,
    ];
  }

  return new Promise((resolve) => {
    const child = spawn("codex", args, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on("data", () => { /* drain stdout to keep buffer happy */ });

    child.on("close", (code) => {
      let output = "";
      try {
        if (existsSync(outFile)) {
          output = readFileSync(outFile, "utf8").trim();
          unlinkSync(outFile);
        }
      } catch {}

      let capturedSessionId: string | null = null;
      if (!resumeId) {
        const found = findNewestRolloutSince(startedAt);
        if (found) capturedSessionId = found.sessionId;
      }

      resolve({
        output: output || "(codex returned no message)",
        exitCode: code ?? -1,
        capturedSessionId,
        stderr: stderr.slice(-2000),
      });
    });

    child.on("error", (err) => {
      resolve({
        output: `(codex spawn error: ${err.message})`,
        exitCode: -1,
        capturedSessionId: null,
        stderr: err.message,
      });
    });
  });
}

export async function codexListHandler(): Promise<Response> {
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
        codexSessionId: s.codexSessionId,
        running: activeCodexRuns.has(s.id),
        runStartedAt: activeCodexRuns.get(s.id)?.startedAt ?? null,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  });
}

export async function codexCreateHandler(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { directory?: string; title?: string };
  const workspace = normalizeWorkspace(body.directory);
  if (workspace.ok === false) return json({ error: workspace.error }, 400);
  const directory = workspace.path;
  const title = body.title?.trim() || "New Codex session";
  const now = Date.now();
  const session: CodexSession = {
    id: `cdx_${randomUUID()}`,
    title,
    directory,
    codexSessionId: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const state = loadState();
  state.sessions.push(session);
  saveState(state);
  return json({ session });
}

export async function codexGetHandler(id: string): Promise<Response> {
  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return json({ error: "not found" }, 404);
  return json({
    session: {
      ...session,
      running: activeCodexRuns.has(id),
      runStartedAt: activeCodexRuns.get(id)?.startedAt ?? null,
    },
  });
}

export async function codexDeleteHandler(id: string): Promise<Response> {
  const state = loadState();
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.sessions.length === before) return json({ error: "not found" }, 404);
  saveState(state);
  return json({ ok: true });
}

export async function codexSendHandler(req: Request, id: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = body.text?.trim() ?? "";
  if (!text) return json({ error: "text required" }, 400);

  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return json({ error: "not found" }, 404);

  const userMsg: CodexMessage = {
    id: `m_${randomUUID()}`,
    role: "user",
    content: text,
    ts: Date.now(),
  };
  session.messages.push(userMsg);
  session.updatedAt = Date.now();
  saveState(state);

  const result = await runCodex({
    prompt: text,
    directory: session.directory,
    resumeId: session.codexSessionId,
  });

  // Re-load — the session list may have changed concurrently
  const fresh = loadState();
  const target = fresh.sessions.find((s) => s.id === id);
  if (!target) return json({ error: "session disappeared" }, 410);

  if (!target.codexSessionId && result.capturedSessionId) {
    target.codexSessionId = result.capturedSessionId;
  }

  const assistantMsg: CodexMessage = {
    id: `m_${randomUUID()}`,
    role: result.exitCode === 0 ? "assistant" : "system",
    content: result.exitCode === 0
      ? result.output
      : `codex exited ${result.exitCode}\n${result.stderr || result.output}`,
    ts: Date.now(),
  };
  target.messages.push(assistantMsg);
  target.updatedAt = Date.now();
  saveState(fresh);

  return json({
    message: assistantMsg,
    codexSessionId: target.codexSessionId,
    exitCode: result.exitCode,
  });
}

// ── Streaming send ────────────────────────────────────────────────────────
//
// Spawns `codex exec [resume <id>] --json` and forwards each JSONL event to
// the client as Server-Sent Events. Persists the user message immediately
// and the concatenated agent_message on completion.
//
// Event names sent to the client:
//   started   — { codexThreadId }
//   item      — { item: { id, type, text? } }   (one per item.completed)
//   usage     — { usage }                        (from turn.completed)
//   error     — { error }
//   done      — { ok, codexSessionId }

type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.completed"; item: CodexStreamItem }
  | { type: "turn.completed"; usage?: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

type CodexStreamItem = {
  id?: string;
  type: string;
  text?: string;
  [key: string]: unknown;
};

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function codexStreamHandler(req: Request, id: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = body.text?.trim() ?? "";
  if (!text) return new Response(JSON.stringify({ error: "text required" }), { status: 400 });

  const state = loadState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  if (activeCodexRuns.has(id)) {
    return new Response(JSON.stringify({ error: "session already running" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Persist the user message before streaming begins so reload-mid-run still shows it.
  const userMsg: CodexMessage = {
    id: `m_${randomUUID()}`,
    role: "user",
    content: text,
    ts: Date.now(),
  };
  session.messages.push(userMsg);
  session.updatedAt = Date.now();
  saveState(state);

  const args = session.codexSessionId
    ? [
        "exec", "resume",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        session.codexSessionId,
        text,
      ]
    : [
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "-C", session.directory,
        text,
      ];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(sseFrame(event, data))); } catch {}
      };

      const child = spawn("codex", args, {
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeCodexRuns.set(id, { child, startedAt: Date.now() });

      let capturedThreadId: string | null = null;
      let stderr = "";
      const agentTexts: string[] = [];
      const completedItems: CodexStreamItem[] = [];

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let ev: CodexEvent;
        try { ev = JSON.parse(line) as CodexEvent; }
        catch { return; }

        if (ev.type === "thread.started") {
          capturedThreadId = (ev as { thread_id: string }).thread_id;
          send("started", { codexThreadId: capturedThreadId });
        } else if (ev.type === "item.completed") {
          const item = (ev as { item: CodexStreamItem }).item;
          if (item.type === "agent_message" && item.text) agentTexts.push(item.text);
          completedItems.push(item);
          send("item", { item });
        } else if (ev.type === "turn.completed") {
          const usage = (ev as { usage?: unknown }).usage;
          if (usage) send("usage", { usage });
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });

      child.on("close", (code) => {
        activeCodexRuns.delete(id);
        rl.close();

        // Persist final state.
        const fresh = loadState();
        const target = fresh.sessions.find((s) => s.id === id);
        if (target) {
          if (!target.codexSessionId && capturedThreadId) target.codexSessionId = capturedThreadId;

          const finalText = agentTexts.join("\n").trim();
          const assistant: CodexMessage = {
            id: `m_${randomUUID()}`,
            role: code === 0 ? "assistant" : "system",
            content: code === 0
              ? (finalText || "(codex returned no message)")
              : `codex exited ${code}\n${stderr.slice(-1000) || finalText}`,
            ts: Date.now(),
            items: completedItems,
          };
          target.messages.push(assistant);
          target.updatedAt = Date.now();
          saveState(fresh);
        }

        if (code === 0) {
          send("done", { ok: true, codexSessionId: capturedThreadId ?? session.codexSessionId });
        } else {
          send("error", {
            error: `codex exited ${code}`,
            stderr: stderr.slice(-1500),
            exitCode: code,
          });
          send("done", { ok: false, codexSessionId: capturedThreadId ?? session.codexSessionId });
        }

        try { controller.close(); } catch {}
      });

      child.on("error", (err) => {
        activeCodexRuns.delete(id);
        send("error", { error: `codex spawn error: ${err.message}` });
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

export async function codexStopHandler(id: string): Promise<Response> {
  const active = activeCodexRuns.get(id);
  if (!active) return json({ ok: true, stopped: false });

  try {
    active.child.kill("SIGTERM");
    setTimeout(() => {
      if (activeCodexRuns.get(id)?.child === active.child) {
        try { active.child.kill("SIGKILL"); } catch {}
      }
    }, 5000).unref?.();
    return json({ ok: true, stopped: true });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
