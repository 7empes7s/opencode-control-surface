// Live preview server manager for the builder.
//
// The dashboard is reached through a Cloudflare tunnel, so the operator's browser
// cannot hit a VPS-local dev server directly. We launch the project's dev server
// on a localhost port, then expose it with a Cloudflare *Quick Tunnel*
// (`cloudflared tunnel --url http://localhost:PORT`) which yields an instant public
// https://*.trycloudflare.com origin — a real origin, so Next.js / Vite / Expo-web
// all render correctly in an iframe (no base-path rewriting needed).
//
// Targets:
//   web          → the web workspace's dev server (next/vite/react-scripts) + tunnel
//   mobile-web   → `expo start --web` (Metro web build) + tunnel  → iframe
//   mobile-device→ `expo start --tunnel` → exp:// URL for a real iOS/Android device (QR)
//
// Everything is best-effort and gated behind the existing builder operator auth.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";

export type PreviewTarget = "web" | "mobile-web" | "mobile-device";
export type PreviewStatus = "starting" | "ready" | "error" | "stopped";

export type PreviewRecord = {
  workflowId: string;
  target: PreviewTarget;
  status: PreviewStatus;
  port: number | null;
  publicUrl: string | null; // trycloudflare https URL (web / mobile-web)
  expUrl: string | null; // exp:// URL for device QR (mobile-device)
  error: string | null;
  startedAt: number;
  logFile: string;
  workspaceDir: string | null;
};

type LiveProc = {
  record: PreviewRecord;
  dev: ChildProcess | null;
  tunnel: ChildProcess | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const PREVIEWS = new Map<string, LiveProc>();
const PREVIEW_LOG_DIR = "/var/lib/control-surface/builder-previews";
const PORT_RANGE_START = 4400;
const PORT_RANGE_END = 4499;
const MAX_CONCURRENT = 2;
const IDLE_MS = 30 * 60 * 1000; // auto-stop after 30 min
const READY_TIMEOUT_MS = 90_000;

function ensureLogDir() {
  if (!existsSync(PREVIEW_LOG_DIR)) mkdirSync(PREVIEW_LOG_DIR, { recursive: true });
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.setTimeout(400);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
}

async function pickFreePort(): Promise<number> {
  const taken = new Set<number>();
  for (const p of PREVIEWS.values()) if (p.record.port) taken.add(p.record.port);
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (taken.has(port)) continue;
    if (!(await portInUse(port))) return port;
  }
  throw new Error("no free preview port available");
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function readPkg(dir: string): { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

function allDeps(pkg: ReturnType<typeof readPkg>): Record<string, string> {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

// Candidate subdirectories to scan for a web / expo workspace.
function candidateDirs(projectRoot: string): string[] {
  const dirs = [projectRoot];
  const common = ["frontend-web", "web", "apps/web", "frontend", "client", "frontend-mobile", "mobile", "apps/mobile"];
  for (const c of common) { const d = join(projectRoot, c); if (existsSync(d)) dirs.push(d); }
  // Also scan apps/* and packages/* one level deep
  for (const base of ["apps", "packages"]) {
    const b = join(projectRoot, base);
    if (existsSync(b)) {
      try { for (const e of readdirSync(b)) { const d = join(b, e); if (existsSync(join(d, "package.json"))) dirs.push(d); } } catch { /* skip */ }
    }
  }
  return [...new Set(dirs)];
}

function detectWebWorkspace(projectRoot: string): { dir: string; cmd: string; args: string[] } | null {
  for (const dir of candidateDirs(projectRoot)) {
    const pkg = readPkg(dir);
    if (!pkg) continue;
    const deps = allDeps(pkg);
    const scripts = pkg.scripts ?? {};
    if (deps.next) return { dir, cmd: "npx", args: ["next", "dev", "-p", "__PORT__"] };
    if (deps.vite) return { dir, cmd: "npx", args: ["vite", "--port", "__PORT__", "--host", "127.0.0.1"] };
    if (deps["react-scripts"]) return { dir, cmd: "npx", args: ["react-scripts", "start"] }; // honors PORT env
    if (scripts.dev && !deps.expo) return { dir, cmd: "npm", args: ["run", "dev"] };
  }
  return null;
}

function detectExpoWorkspace(projectRoot: string): { dir: string } | null {
  for (const dir of candidateDirs(projectRoot)) {
    const pkg = readPkg(dir);
    if (pkg && allDeps(pkg).expo) return { dir };
  }
  return null;
}

function spawnLogged(cmd: string, args: string[], cwd: string, port: number, logFile: string): ChildProcess {
  const out = require("node:fs").openSync(logFile, "a");
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, PORT: String(port), BROWSER: "none", CI: "1" },
  });
  child.unref();
  return child;
}

function killTree(child: ChildProcess | null) {
  if (!child || child.pid == null) return;
  // Kill the process group (covers npx → child trees), then the bare pid as fallback.
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* not a group leader */ }
  try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
}

// Bulletproof teardown: we spawn detached (setsid), so the spawned pid is a session
// leader and EVERY descendant — including Next.js's next-server worker that re-forks
// into its own group and reparents to init — keeps session id == spawned pid. Kill
// every process in that session.
function killBySession(sid: number | null | undefined) {
  if (!sid) return;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid || pid === sid) continue;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        // Fields after the final ")": state ppid pgrp session ...
        const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(after[3]) === sid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      } catch { /* process vanished / unreadable */ }
    }
    try { process.kill(sid, "SIGKILL"); } catch { /* gone */ }
  } catch { /* best effort */ }
}

// Next.js (and some bundlers) re-fork their server into a NEW process group, so it
// escapes the parent group kill. Catch it by SIGKILLing whatever still listens on
// the preview port.
function killByPort(port: number | null) {
  if (!port) return;
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(`ss -ltnpH 'sport = :${port}' 2>/dev/null || true`, { encoding: "utf8" });
    for (const m of out.matchAll(/pid=(\d+)/g)) {
      try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* gone */ }
    }
  } catch { /* best effort */ }
}

function tailLog(logFile: string, bytes = 4000): string {
  try {
    const buf = readFileSync(logFile, "utf8");
    return buf.length > bytes ? buf.slice(-bytes) : buf;
  } catch { return ""; }
}

function parseTrycloudflare(logFile: string): string | null {
  const m = tailLog(logFile, 8000).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

function parseExpUrl(logFile: string): string | null {
  const m = tailLog(logFile, 8000).match(/exp:\/\/[^\s"']+/);
  return m ? m[0] : null;
}

function resetIdleTimer(proc: LiveProc) {
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  proc.idleTimer = setTimeout(() => { void stopPreview(proc.record.workflowId); }, IDLE_MS);
}

export function getPreview(workflowId: string): PreviewRecord | null {
  const proc = PREVIEWS.get(workflowId);
  if (!proc) return null;
  // Refresh url/status from logs if still resolving.
  if (proc.record.status === "starting") {
    if (proc.record.target === "mobile-device") {
      const exp = parseExpUrl(proc.record.logFile);
      if (exp) { proc.record.expUrl = exp; proc.record.status = "ready"; }
    } else {
      const url = parseTrycloudflare(proc.record.logFile);
      if (url) { proc.record.publicUrl = url; proc.record.status = "ready"; }
    }
  }
  return { ...proc.record };
}

export function getPreviewLog(workflowId: string): string {
  const proc = PREVIEWS.get(workflowId);
  return proc ? tailLog(proc.record.logFile) : "";
}

export async function stopPreview(workflowId: string): Promise<void> {
  const proc = PREVIEWS.get(workflowId);
  if (!proc) return;
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  killBySession(proc.tunnel?.pid);
  killBySession(proc.dev?.pid);
  killTree(proc.tunnel);
  killTree(proc.dev);
  killByPort(proc.record.port);
  proc.record.status = "stopped";
  PREVIEWS.delete(workflowId);
}

export async function startPreview(workflowId: string, projectRoot: string, target: PreviewTarget): Promise<PreviewRecord> {
  // Restart cleanly if one is already running for this workflow.
  await stopPreview(workflowId);
  if (PREVIEWS.size >= MAX_CONCURRENT) {
    throw new Error(`max ${MAX_CONCURRENT} live previews running — stop one first`);
  }
  if (!projectRoot || !existsSync(projectRoot)) throw new Error("project root does not exist");

  ensureLogDir();
  const logFile = join(PREVIEW_LOG_DIR, `${workflowId}-${target}-${Date.now()}.log`);
  const record: PreviewRecord = {
    workflowId, target, status: "starting", port: null, publicUrl: null, expUrl: null,
    error: null, startedAt: Date.now(), logFile, workspaceDir: null,
  };
  const proc: LiveProc = { record, dev: null, tunnel: null, idleTimer: null };
  PREVIEWS.set(workflowId, proc);
  resetIdleTimer(proc);

  try {
    if (target === "mobile-device") {
      const expo = detectExpoWorkspace(projectRoot);
      if (!expo) throw new Error("no Expo (React Native) workspace found to preview on a device");
      record.workspaceDir = expo.dir;
      // Expo's own tunnel exposes Metro publicly; the exp:// URL drives a device via Expo Go.
      proc.dev = spawnLogged("npx", ["expo", "start", "--tunnel"], expo.dir, 19000, logFile);
      // exp URL is parsed lazily in getPreview()
      return { ...record };
    }

    let dir: string;
    let cmd: string;
    let args: string[];
    if (target === "mobile-web") {
      const expo = detectExpoWorkspace(projectRoot);
      if (!expo) throw new Error("no Expo (React Native) workspace found");
      dir = expo.dir; cmd = "npx"; args = ["expo", "start", "--web", "--port", "__PORT__"];
    } else {
      const web = detectWebWorkspace(projectRoot);
      if (!web) throw new Error("no web app (next/vite/react-scripts) found to preview");
      dir = web.dir; cmd = web.cmd; args = web.args;
    }

    const port = await pickFreePort();
    record.port = port;
    record.workspaceDir = dir;
    args = args.map((a) => (a === "__PORT__" ? String(port) : a));

    proc.dev = spawnLogged(cmd, args, dir, port, logFile);

    // Wait for the dev server to listen, then open the Cloudflare quick tunnel.
    void (async () => {
      const up = await waitForPort(port, READY_TIMEOUT_MS);
      if (!PREVIEWS.has(workflowId)) return; // stopped meanwhile
      if (!up) {
        record.status = "error";
        record.error = `dev server didn't start within ${READY_TIMEOUT_MS / 1000}s — check logs`;
        return;
      }
      proc.tunnel = spawnLogged("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], dir, port, logFile);
      // publicUrl is parsed lazily in getPreview()
    })();

    return { ...record };
  } catch (e) {
    record.status = "error";
    record.error = e instanceof Error ? e.message : String(e);
    await stopPreview(workflowId);
    PREVIEWS.set(workflowId, proc); // keep the error record briefly for the UI
    return { ...record };
  }
}
