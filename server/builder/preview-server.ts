// Live preview server manager for the builder.
//
// The dashboard is reached through a Cloudflare tunnel, so the operator's browser
// cannot hit a VPS-local dev server directly. We launch the project's dev server(s)
// on localhost ports, then expose them with Cloudflare *Quick Tunnels*
// (`cloudflared tunnel --url http://localhost:PORT`) which yield instant public
// https://*.trycloudflare.com origins — real origins, so Next.js / Vite / Expo-web
// all render correctly in an iframe (no base-path rewriting needed).
//
// Targets:
//   web          → the web workspace's dev server (next/vite/react-scripts) + tunnel
//   mobile-web   → `expo start --web` (Metro web build) + tunnel  → iframe
//   mobile-device→ `expo start --tunnel` → exp:// URL for a real device (QR via Expo Go)
//   fullstack    → docker compose up (Postgres/Redis) + backend API + web, each
//                  tunnelled; the web is launched with its API base URL pointed at the
//                  backend's public tunnel so data flows end-to-end in the preview.
//
// Everything is best-effort and gated behind the existing builder operator auth.

import { spawn, type ChildProcess, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";

export type PreviewTarget = "web" | "mobile-web" | "mobile-device" | "fullstack";
export type PreviewStatus = "starting" | "ready" | "error" | "stopped";
// Per-part health for fullstack previews so a dead backend can't masquerade as a
// fully-"ready" preview. null = not yet known, "skipped" = nothing to start.
export type PreviewPartStatus = "ok" | "error" | "skipped" | null;

export type PreviewRecord = {
  workflowId: string;
  target: PreviewTarget;
  status: PreviewStatus;
  port: number | null; // primary (web) port
  publicUrl: string | null; // trycloudflare https URL for the web UI
  apiUrl: string | null; // trycloudflare https URL for the backend API (fullstack)
  apiStatus: PreviewPartStatus; // fullstack: did the backend/API come up + tunnel?
  webStatus: PreviewPartStatus; // did the web app come up?
  expUrl: string | null; // exp:// URL for device QR (mobile-device)
  error: string | null;
  startedAt: number;
  logFile: string;
  workspaceDir: string | null;
  qrUrl: string | null; // URL to encode for phone/browser or Expo Go testing
  qrLabel: string | null;
  diagnostics: string[];
};

type LiveProc = {
  record: PreviewRecord;
  children: ChildProcess[]; // every process we spawned (dev servers + tunnels)
  ports: number[]; // every port we bound (for belt-and-suspenders teardown)
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const PREVIEWS = new Map<string, LiveProc>();
const PREVIEW_LOG_DIR = "/var/lib/control-surface/builder-previews";
const PORT_RANGE_START = 4400;
const PORT_RANGE_END = 4499;
const MAX_CONCURRENT = 2;
const IDLE_MS = 30 * 60 * 1000; // auto-stop after 30 min
const READY_TIMEOUT_MS = 120_000;

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

async function pickFreePort(exclude: Set<number>): Promise<number> {
  const taken = new Set<number>(exclude);
  for (const p of PREVIEWS.values()) for (const port of p.ports) taken.add(port);
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

function hasDependency(dir: string, dep: string): boolean {
  return Boolean(allDeps(readPkg(dir))[dep]);
}

function hasDependencyInProject(projectRoot: string, dir: string, dep: string): boolean {
  return hasDependency(dir, dep) || (dir !== projectRoot && hasDependency(projectRoot, dep));
}

function candidateDirs(projectRoot: string): string[] {
  const dirs = [projectRoot];
  const common = ["frontend-web", "web", "apps/web", "frontend", "client", "frontend-mobile", "mobile", "apps/mobile", "backend", "api", "apps/api", "server", "libs/api"];
  for (const c of common) { const d = join(projectRoot, c); if (existsSync(d)) dirs.push(d); }
  for (const base of ["apps", "packages", "libs"]) {
    const b = join(projectRoot, base);
    if (existsSync(b)) {
      try { for (const e of readdirSync(b)) { const d = join(b, e); if (existsSync(join(d, "package.json"))) dirs.push(d); } } catch { /* skip */ }
    }
  }
  return [...new Set(dirs)];
}

// --- nx workspace support ---------------------------------------------------
// nx monorepos usually have no per-app package.json and are run via `nx serve <app>`.
// We read each project.json under apps/packages/libs and classify by its serve executor.
type NxProject = { name: string; dir: string; targets: Record<string, { executor?: string }> };
function readNxProjects(projectRoot: string): NxProject[] {
  if (!existsSync(join(projectRoot, "nx.json"))) return [];
  const found: NxProject[] = [];
  const scan = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    if (entries.includes("project.json")) {
      try {
        const p = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { name?: string; targets?: Record<string, { executor?: string }> };
        found.push({ name: p.name ?? dir.split("/").pop() ?? dir, dir, targets: p.targets ?? {} });
      } catch { /* skip */ }
    }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".") || e === "project.json") continue;
      try { if (readdirSync(join(dir, e)).length) scan(join(dir, e), depth + 1); } catch { /* not a dir */ }
    }
  };
  for (const base of ["apps", "packages", "libs", "services"]) {
    const b = join(projectRoot, base);
    if (existsSync(b)) scan(b, 0);
  }
  return found;
}
const NX_WEB_EXECUTOR = /@nx\/(next|remix|vite|web|webpack|react|angular):.*(serve|dev|server)/i;
const NX_NODE_EXECUTOR = /@nx\/(js|node|nest):.*(node|serve)/i;
const NX_EXPO_EXECUTOR = /@nx\/expo:/i;
const NX_REACT_NATIVE_EXECUTOR = /@nx\/react-native:/i;
function detectNxWeb(projectRoot: string): { dir: string; cmd: string; args: string[] } | null {
  for (const p of readNxProjects(projectRoot)) {
    const serve = p.targets.serve ?? p.targets.dev;
    const ex = serve?.executor ?? "";
    if (!serve || !NX_WEB_EXECUTOR.test(ex)) continue;
    // Prefer running the framework DIRECTLY in the project dir: generated nx apps frequently
    // have skewed @nx/* plugin versions and `nx serve` crashes, but `next dev`/`vite` work.
    const hasNextCfg = ["next.config.js", "next.config.mjs", "next.config.ts"].some((f) => existsSync(join(p.dir, f)));
    if (/@nx\/next/i.test(ex) && hasNextCfg) {
      return { dir: p.dir, cmd: "npx", args: ["next", "dev", "-p", "__PORT__"] };
    }
    if (/@nx\/(vite|react)/i.test(ex)) {
      return { dir: p.dir, cmd: "npx", args: ["vite", "--port", "__PORT__", "--host", "127.0.0.1"] };
    }
    // Fallback: let nx drive it (works when plugin versions are aligned).
    return { dir: projectRoot, cmd: "npx", args: ["nx", "serve", p.name, "--port", "__PORT__"] };
  }
  return null;
}
function detectNxBackend(projectRoot: string): { dir: string; cmd: string; args: string[] } | null {
  for (const p of readNxProjects(projectRoot)) {
    const serve = p.targets.serve;
    if (serve && NX_NODE_EXECUTOR.test(serve.executor ?? "")) {
      // @nx/js:node runs the built app, which reads process.env.PORT (set by the caller).
      return { dir: projectRoot, cmd: "npx", args: ["nx", "serve", p.name] };
    }
  }
  return null;
}

function detectWebWorkspace(projectRoot: string): { dir: string; cmd: string; args: string[] } | null {
  const nx = detectNxWeb(projectRoot);
  if (nx) return nx;
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

function detectMobileWorkspace(projectRoot: string): { dir: string; kind: "expo" | "react-native"; name?: string } | null {
  const expo = detectExpoWorkspace(projectRoot);
  if (expo) return { dir: expo.dir, kind: "expo" };
  for (const p of readNxProjects(projectRoot)) {
    const start = p.targets.start ?? p.targets.serve ?? p.targets.dev;
    const executor = start?.executor ?? "";
    if (NX_EXPO_EXECUTOR.test(executor) && hasDependencyInProject(projectRoot, p.dir, "expo")) {
      return { dir: p.dir, kind: "expo", name: p.name };
    }
    if (NX_REACT_NATIVE_EXECUTOR.test(executor)) return { dir: p.dir, kind: "react-native", name: p.name };
  }
  for (const dir of candidateDirs(projectRoot)) {
    const pkg = readPkg(dir);
    if (pkg && allDeps(pkg)["react-native"]) return { dir, kind: "react-native" };
  }
  return null;
}

function setPhoneQr(record: PreviewRecord, url: string, label: string) {
  record.qrUrl = url;
  record.qrLabel = label;
}

function detectBackendWorkspace(projectRoot: string): { dir: string; cmd: string; args: string[] } | null {
  const nx = detectNxBackend(projectRoot);
  if (nx) return nx;
  for (const dir of candidateDirs(projectRoot)) {
    const pkg = readPkg(dir);
    if (!pkg) continue;
    const deps = allDeps(pkg);
    const scripts = pkg.scripts ?? {};
    const isBackend = deps["@nestjs/core"] || deps.express || deps.fastify || deps.koa;
    if (!isBackend) continue;
    if (scripts["start:dev"]) return { dir, cmd: "npm", args: ["run", "start:dev"] };
    if (scripts.dev) return { dir, cmd: "npm", args: ["run", "dev"] };
    if (scripts.start) return { dir, cmd: "npm", args: ["run", "start"] };
  }
  return null;
}

function spawnLogged(cmd: string, args: string[], cwd: string, env: Record<string, string>, logFile: string): ChildProcess {
  const out = openSync(logFile, "a");
  const child = spawn(cmd, args, {
    cwd,
    detached: true, // new session (setsid) → session id == child.pid, used for teardown
    stdio: ["ignore", out, out],
    env: { ...process.env, BROWSER: "none", CI: "1", ...env },
  });
  child.unref();
  return child;
}

// Teardown is scoped to OUR processes only — by session id (catches Next's detached
// next-server worker), by process group, and by the exact ports we bound. Never by
// process-name pattern (that would hit unrelated/production services).
function killBySession(sid: number | null | undefined) {
  if (!sid) return;
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid || pid === sid) continue;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(after[3]) === sid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      } catch { /* vanished */ }
    }
    try { process.kill(sid, "SIGKILL"); } catch { /* gone */ }
  } catch { /* best effort */ }
}

function killByPort(port: number) {
  try {
    const out = execSync(`ss -ltnpH 'sport = :${port}' 2>/dev/null || true`, { encoding: "utf8" });
    for (const m of out.matchAll(/pid=(\d+)/g)) {
      try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* gone */ }
    }
  } catch { /* best effort */ }
}

function tailLog(logFile: string, bytes = 8000): string {
  try { const buf = readFileSync(logFile, "utf8"); return buf.length > bytes ? buf.slice(-bytes) : buf; } catch { return ""; }
}

function parseTrycloudflare(text: string): string | null {
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

async function inspectWebPreview(port: number): Promise<string[]> {
  const diagnostics: string[] = [];
  try {
    const base = `http://127.0.0.1:${port}`;
    const htmlRes = await fetch(base, { signal: AbortSignal.timeout(20_000) });
    const html = await htmlRes.text();
    if (!htmlRes.ok) diagnostics.push(`web root returned HTTP ${htmlRes.status}`);
    if (/Welcome web|Generated by create-nx-workspace/i.test(html)) {
      diagnostics.push("preview is still serving the stock Nx welcome page, not the intended generated app UI");
    }
    const cssHrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter(Boolean);
    if (cssHrefs.length === 0) {
      diagnostics.push("no stylesheet links were found in the preview HTML");
    }
    for (const href of cssHrefs.slice(0, 8)) {
      const cssUrl = new URL(href, base).toString();
      try {
        const cssRes = await fetch(cssUrl, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
        const contentType = cssRes.headers.get("content-type") ?? "";
        if (!cssRes.ok || !contentType.includes("text/css")) {
          diagnostics.push(`stylesheet ${new URL(cssUrl).pathname} returned HTTP ${cssRes.status}`);
        }
      } catch (e) {
        diagnostics.push(`stylesheet ${href} could not be checked: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    diagnostics.push(`preview health check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return diagnostics;
}

// Spawn a quick tunnel for a port, writing to its OWN log so the URL is unambiguous.
async function openTunnel(port: number, cwd: string, logFile: string, proc: LiveProc): Promise<string | null> {
  const child = spawnLogged("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], cwd, {}, logFile);
  proc.children.push(child);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const url = parseTrycloudflare(tailLog(logFile));
    if (url) return url;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

// Bring up ONLY the data services (db/cache) a generated app needs — never app/proxy
// services, which bind host ports (e.g. nginx:80) and collide with the live VPS.
const DATA_SERVICE_RE = /(postgres|postgresql|pgvector|mysql|mariadb|mongo|redis|valkey|rabbit|kafka|cache|database|clickhouse|cassandra|elastic|meilisearch)/i;
function composeUp(projectRoot: string, logFile: string): void {
  const hasCompose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].some((f) => existsSync(join(projectRoot, f)));
  if (!hasCompose) return;
  try {
    const services = execSync(`docker compose config --services 2>/dev/null || true`, { cwd: projectRoot, encoding: "utf8", timeout: 20_000 })
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const data = services.filter((s) => DATA_SERVICE_RE.test(s));
    if (data.length === 0) return; // nothing safe to start; don't boot app/proxy containers
    execSync(`docker compose up -d ${data.join(" ")} >> ${JSON.stringify(logFile)} 2>&1 || true`, { cwd: projectRoot, timeout: 90_000 });
  } catch { /* best effort — DB may already be up */ }
}

function resetIdleTimer(proc: LiveProc) {
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  proc.idleTimer = setTimeout(() => { void stopPreview(proc.record.workflowId); }, IDLE_MS);
}

export function getPreview(workflowId: string): PreviewRecord | null {
  const proc = PREVIEWS.get(workflowId);
  if (!proc) return null;
  if (proc.record.status === "starting" && proc.record.target === "mobile-device") {
    const exp = tailLog(proc.record.logFile).match(/exp:\/\/[^\s"']+/);
    if (exp) {
      proc.record.expUrl = exp[0];
      setPhoneQr(proc.record, exp[0], "Scan with Expo Go");
      proc.record.status = "ready";
    }
  }
  return { ...proc.record };
}

export function getPreviewLog(workflowId: string): string {
  const proc = PREVIEWS.get(workflowId);
  return proc ? tailLog(proc.record.logFile, 4000) : "";
}

export async function stopPreview(workflowId: string): Promise<void> {
  const proc = PREVIEWS.get(workflowId);
  if (!proc) return;
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  for (const c of proc.children) killBySession(c.pid);
  for (const port of proc.ports) killByPort(port);
  proc.record.status = "stopped";
  PREVIEWS.delete(workflowId);
}

export async function startPreview(workflowId: string, projectRoot: string, target: PreviewTarget): Promise<PreviewRecord> {
  await stopPreview(workflowId);
  if (PREVIEWS.size >= MAX_CONCURRENT) throw new Error(`max ${MAX_CONCURRENT} live previews running — stop one first`);
  if (!projectRoot || !existsSync(projectRoot)) throw new Error("project root does not exist");

  ensureLogDir();
  const stamp = Date.now();
  const logFile = join(PREVIEW_LOG_DIR, `${workflowId}-${target}-${stamp}.log`);
  const record: PreviewRecord = {
    workflowId, target, status: "starting", port: null, publicUrl: null, apiUrl: null,
    apiStatus: null, webStatus: null, expUrl: null,
    error: null, startedAt: stamp, logFile, workspaceDir: null, qrUrl: null, qrLabel: null, diagnostics: [],
  };
  const proc: LiveProc = { record, children: [], ports: [], idleTimer: null };
  PREVIEWS.set(workflowId, proc);
  resetIdleTimer(proc);

  const fail = async (msg: string) => { record.status = "error"; record.error = msg; };

  try {
    if (target === "mobile-device") {
      const mobile = detectMobileWorkspace(projectRoot);
      if (mobile?.kind === "expo") {
        record.workspaceDir = mobile.dir;
        proc.children.push(spawnLogged("npx", ["expo", "start", "--tunnel"], mobile.dir, { PORT: "19000" }, logFile));
        return { ...record };
      }
      const web = detectWebWorkspace(projectRoot);
      if (!web) throw new Error("no Expo workspace or web app found to produce a phone QR");
      record.diagnostics.push("No Expo workspace was detected; QR opens the web preview in a phone browser.");
      const port = await pickFreePort(new Set());
      record.port = port; record.workspaceDir = web.dir; proc.ports.push(port);
      const args = web.args.map((a) => (a === "__PORT__" ? String(port) : a));
      proc.children.push(spawnLogged(web.cmd, args, web.dir, { PORT: String(port) }, logFile));
      void (async () => {
        if (!(await waitForPort(port, READY_TIMEOUT_MS))) return fail(`web preview for phone QR didn't start within ${READY_TIMEOUT_MS / 1000}s`);
        if (!PREVIEWS.has(workflowId)) return;
        record.diagnostics.push(...await inspectWebPreview(port));
        const url = await openTunnel(port, web.dir, logFile, proc);
        if (url) {
          record.publicUrl = url;
          setPhoneQr(record, url, "Scan to open the web preview on your phone");
          record.status = "ready";
        } else await fail("phone QR tunnel didn't come up");
      })();
      return { ...record };
    }

    if (target === "mobile-web") {
      const expo = detectMobileWorkspace(projectRoot);
      if (!expo || expo.kind !== "expo") {
        const web = detectWebWorkspace(projectRoot);
        if (!web) throw new Error("no Expo workspace or web app found for mobile-web preview");
        record.diagnostics.push("Expo is not installed in the generated mobile workspace; showing the web preview with a phone QR instead.");
        const port = await pickFreePort(new Set());
        record.port = port; record.workspaceDir = web.dir; proc.ports.push(port);
        const args = web.args.map((a) => (a === "__PORT__" ? String(port) : a));
        proc.children.push(spawnLogged(web.cmd, args, web.dir, { PORT: String(port) }, logFile));
        void (async () => {
          if (!(await waitForPort(port, READY_TIMEOUT_MS))) return fail(`web preview for mobile-web didn't start within ${READY_TIMEOUT_MS / 1000}s`);
          if (!PREVIEWS.has(workflowId)) return;
          record.diagnostics.push(...await inspectWebPreview(port));
          const url = await openTunnel(port, web.dir, logFile, proc);
          if (url) {
            record.publicUrl = url;
            setPhoneQr(record, url, "Scan to open the web preview on your phone");
            record.status = "ready";
          } else await fail("mobile-web fallback tunnel didn't come up");
        })();
        return { ...record };
      }
      const port = await pickFreePort(new Set());
      record.port = port; record.workspaceDir = expo.dir; proc.ports.push(port);
      proc.children.push(spawnLogged("npx", ["expo", "start", "--web", "--port", String(port)], expo.dir, { PORT: String(port) }, logFile));
      void (async () => {
        if (!(await waitForPort(port, READY_TIMEOUT_MS))) return fail(`Expo web didn't start within ${READY_TIMEOUT_MS / 1000}s`);
        if (!PREVIEWS.has(workflowId)) return;
        record.diagnostics.push(...await inspectWebPreview(port));
        const url = await openTunnel(port, expo.dir, logFile, proc);
        if (url) {
          record.publicUrl = url;
          setPhoneQr(record, url, "Scan to open Expo web preview on your phone");
          record.status = "ready";
        } else await fail("tunnel didn't come up");
      })();
      return { ...record };
    }

    if (target === "fullstack") {
      // DB/Redis first (best effort), then backend, tunnel it, then web pointed at the API tunnel.
      composeUp(projectRoot, logFile);
      const backend = detectBackendWorkspace(projectRoot);
      const web = detectWebWorkspace(projectRoot);
      if (!web) throw new Error("no web app found to preview");

      void (async () => {
        let apiUrl: string | null = null;
        if (backend) {
          // Backend gets its own log so a backend failure can be surfaced specifically
          // (the shared web log would otherwise bury it).
          const apiLog = `${logFile}.api.log`;
          const backendCmd = `${backend.cmd} ${backend.args.join(" ")}`.trim();
          const apiPort = await pickFreePort(new Set());
          proc.ports.push(apiPort);
          proc.children.push(spawnLogged(backend.cmd, backend.args, backend.dir, { PORT: String(apiPort), API_PORT: String(apiPort) }, apiLog));
          if (await waitForPort(apiPort, READY_TIMEOUT_MS)) {
            apiUrl = await openTunnel(apiPort, backend.dir, apiLog, proc);
            record.apiUrl = apiUrl;
            record.apiStatus = apiUrl ? "ok" : "error";
            if (!apiUrl) {
              record.diagnostics.push(`Backend started but its public tunnel didn't come up — API calls will fail. Backend command: ${backendCmd}`);
            }
          } else {
            // Detected a backend but it never bound its port: do NOT pretend the preview
            // is fully ready. Surface the command + the tail of the backend log.
            record.apiStatus = "error";
            record.diagnostics.push(`Backend/API failed to start within ${READY_TIMEOUT_MS / 1000}s — preview is WEB-ONLY and API calls will fail. Backend command: ${backendCmd}`);
            const tail = tailLog(apiLog, 1600).split("\n").filter((l) => l.trim()).slice(-20).join("\n");
            if (tail) record.diagnostics.push(`Backend log (last lines):\n${tail}`);
          }
        } else {
          record.apiStatus = "skipped";
          record.diagnostics.push("No backend/API workspace was detected; previewing the web app only.");
        }
        if (!PREVIEWS.has(workflowId)) return;
        const webPort = await pickFreePort(new Set(proc.ports));
        record.port = webPort; record.workspaceDir = web.dir; proc.ports.push(webPort);
        // Point common API-base env vars at the backend's public tunnel so data flows.
        const apiEnv: Record<string, string> = apiUrl
          ? { NEXT_PUBLIC_API_URL: apiUrl, NEXT_PUBLIC_API_BASE_URL: apiUrl, VITE_API_URL: apiUrl, EXPO_PUBLIC_API_URL: apiUrl, API_URL: apiUrl }
          : {};
        const webArgs = web.args.map((a) => (a === "__PORT__" ? String(webPort) : a));
        proc.children.push(spawnLogged(web.cmd, webArgs, web.dir, { PORT: String(webPort), ...apiEnv }, logFile));
        if (!(await waitForPort(webPort, READY_TIMEOUT_MS))) { record.webStatus = "error"; return fail(`web didn't start within ${READY_TIMEOUT_MS / 1000}s`); }
        if (!PREVIEWS.has(workflowId)) return;
        record.webStatus = "ok";
        record.diagnostics.push(...await inspectWebPreview(webPort));
        const url = await openTunnel(webPort, web.dir, logFile, proc);
        if (url) {
          record.publicUrl = url;
          setPhoneQr(record, url, "Scan to open the full-stack web preview on your phone");
          // Web is genuinely up (iframe is useful), but keep the API failure unmissable
          // via apiStatus + diagnostics rather than a falsely-clean "ready".
          record.status = "ready";
        } else { record.webStatus = "error"; await fail("web tunnel didn't come up"); }
      })();
      return { ...record };
    }

    // target === "web"
    const web = detectWebWorkspace(projectRoot);
    if (!web) throw new Error("no web app (next/vite/react-scripts) found to preview");
    const port = await pickFreePort(new Set());
    record.port = port; record.workspaceDir = web.dir; proc.ports.push(port);
    const args = web.args.map((a) => (a === "__PORT__" ? String(port) : a));
    proc.children.push(spawnLogged(web.cmd, args, web.dir, { PORT: String(port) }, logFile));
    void (async () => {
      if (!(await waitForPort(port, READY_TIMEOUT_MS))) return fail(`dev server didn't start within ${READY_TIMEOUT_MS / 1000}s — check logs`);
      if (!PREVIEWS.has(workflowId)) return;
      record.diagnostics.push(...await inspectWebPreview(port));
      const url = await openTunnel(port, web.dir, logFile, proc);
      if (url) {
        record.publicUrl = url;
        setPhoneQr(record, url, "Scan to open the web preview on your phone");
        record.status = "ready";
      } else await fail("tunnel didn't come up");
    })();
    return { ...record };
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
    return { ...record };
  }
}
