import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, appendFileSync, statSync } from "fs";
import { join, basename } from "path";
import { spawn, spawnSync } from "child_process";
import { requireMutation } from "../governance/rbac.ts";

const JOBS_DIR = "/var/lib/mimule/jobs";
const GUARD_FILE = "/var/lib/mimule/team-guardrails.json";
const COOLDOWNS_FILE = "/var/lib/mimule/agent-cooldowns.json";
const MODELS_FILE = "/var/lib/mimule/agent-models.json";
const ROSTER_FILE = "/var/lib/mimule/agent-roster.resolved.json";
const VAULT_ADVISOR_DIR = "/opt/ai-vault/advisor";
const ACTIVITY_LOG = "/var/log/mimule-agents.log";
const JOB_WORK_DIR = "/var/lib/mimule/jobs/work";
const PROJECTS_FILE = "/var/lib/mimule/projects.json";

const JOB_STATES = ["queue", "running", "done", "failed", "rejected"] as const;

const ID_REGEX = /^[A-Za-z0-9._-]+$/;
const MAX_FILE_CONTENT = 8000;

function safeReadJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readJobFiles(state: string): any[] {
  const dir = join(JOBS_DIR, state);
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => safeReadJson(join(dir, f), null))
      .filter((j): j is any => j !== null);
  } catch {
    return [];
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

function readProjects() {
  const reg = safeReadJson<{ projects?: any[] }>(PROJECTS_FILE, { projects: [] });
  const list = reg.projects ?? [];
  if (list.length === 0) return [];
  // count jobs per project dir across states
  const counts: Record<string, Record<string, number>> = {};
  for (const st of JOB_STATES) {
    for (const j of readJobFiles(st)) {
      const dir = j.dir ?? "";
      if (!dir) continue;
      (counts[dir] ??= {})[st] = ((counts[dir] ??= {})[st] ?? 0) + 1;
    }
  }
  return list.map((p) => ({
    name: p.name ?? "",
    path: p.path ?? "",
    capability: p.capability ?? "",
    lastImprove: p.last_improve ?? 0,
    counts: {
      queue: counts[p.path]?.queue ?? 0,
      running: counts[p.path]?.running ?? 0,
      done: counts[p.path]?.done ?? 0,
      failed: counts[p.path]?.failed ?? 0,
      rejected: counts[p.path]?.rejected ?? 0,
    },
  }));
}

// Phase 3 — the self-correction proof. The team audits its own work and safely
// ROLLS BACK when the auditor finds a real issue. Surfaced as a FEATURE
// (reversible, traced) — not a failure. This is the trust centerpiece: an AI
// workforce whose every change is reviewed and reversible.
export function readSelfCorrection() {
  const events: Array<{ jobId: string; goal: string; outcome: "rolled-back" | "shipped"; verdict: string; finding: string; ts: number }> = [];
  let audited = 0, rolledBack = 0, shipped = 0;
  for (const state of ["rejected", "done"] as const) {
    const dir = join(JOBS_DIR, state);
    if (!existsSync(dir)) continue;
    let files: Array<{ id: string; ts: number; goal: string }> = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
        const j = safeReadJson<any>(join(dir, f), {});
        let ts = j.created ? j.created * 1000 : 0;
        try { ts = ts || statSync(join(dir, f)).mtimeMs; } catch { /* keep created */ }
        return { id: f.replace(/\.json$/, ""), ts, goal: truncate(String(j.goal ?? j.prompt ?? ""), 110) };
      }).sort((a, b) => b.ts - a.ts).slice(0, 12);
    } catch { continue; }
    for (const { id, ts, goal } of files) {
      const work = join(JOB_WORK_DIR, id);
      if (!existsSync(work)) continue;
      let auditFiles: string[] = [];
      try { auditFiles = readdirSync(work).filter((x) => /^(audit|oversee)/.test(x) && x.endsWith(".md")).sort().reverse(); } catch { /* none */ }
      if (auditFiles.length === 0) continue; // only count builds that were actually audited
      audited++;
      let verdict = "", finding = "";
      for (const af of auditFiles.slice(0, 3)) {
        let txt = "";
        try { txt = readFileSync(join(work, af), "utf8"); } catch { continue; }
        const vm = txt.match(/VERDICT:\s*(PASS|FAIL|APPROVE|REJECT)/i);
        if (vm && !verdict) verdict = vm[1].toUpperCase();
        if (!finding) {
          const fl = txt.split("\n").map((l) => l.trim()).find((l) =>
            /^P[0-9]:/.test(l) || (l.startsWith("- ") && l.length > 12) ||
            (l.length > 35 && !/^(Warning|Ripgrep|Attempt|VERDICT|256-color|I'm|I am|No |The goal|Error executing|Failed to|Static (audit|evidence|check))/.test(l)));
          if (fl) finding = fl.replace(/^- /, "").slice(0, 180);
        }
      }
      if (state === "rejected") { rolledBack++; events.push({ jobId: id, goal, outcome: "rolled-back", verdict: verdict || "FAIL", finding, ts }); }
      else { shipped++; events.push({ jobId: id, goal, outcome: "shipped", verdict: verdict || "PASS", finding, ts }); }
    }
  }
  events.sort((a, b) => b.ts - a.ts);
  return { summary: { audited, rolledBack, shipped }, events: events.slice(0, 8) };
}

export function agentTeamHandler(): Response {
  try {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    // Jobs
    const jobs: any[] = JOB_STATES.map((state) => {
      const items = readJobFiles(state)
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .slice(0, 20)
        .map((j) => ({
          id: j.id ?? "",
          type: j.type ?? j.role ?? "",
          goal: truncate(j.goal ?? j.prompt ?? j.task ?? "", 200),
          dir: j.dir ?? "",
          created: j.created ?? 0,
        }));
      return { state, count: items.length, items };
    });

    // Cooldowns
    const cooldownsRaw = safeReadJson<Record<string, any>>(COOLDOWNS_FILE, {});
    const cooldowns = Object.entries(cooldownsRaw)
      .map(([provider, v]) => ({
        provider,
        until: v.until ?? 0,
        scope: v.scope ?? "",
        msg: v.msg ?? "",
      }))
      .filter((c) => c.until > nowSec);

    // Models
    const modelsRaw = safeReadJson<any>(MODELS_FILE, { models: [] });
    const modelsList = modelsRaw.models ?? [];
    const providers = Array.from(new Set(modelsList.map((m: any) => m.provider).filter(Boolean))).sort();
    const usableFree = modelsList.filter((m: any) => m.usable_free === true).length;
    const models = {
      count: modelsList.length,
      providers,
      usableFree,
    };

    // Roles
    const rosterRaw = safeReadJson<any>(ROSTER_FILE, { roles: {} });
    const roles = Object.entries(rosterRaw.roles ?? {}).map(([role, v]: [string, any]) => ({
      role,
      mode: v.mode ?? "readonly",
      chain: v.chain ?? [],
    }));

    // Latest orchestrator report
    let latestReport: { file: string; head: string } | null = null;
    try {
      if (existsSync(VAULT_ADVISOR_DIR)) {
        const files = readdirSync(VAULT_ADVISOR_DIR)
          .filter((f) => f.startsWith("orchestrator-") && f.endsWith(".md"))
          .sort()
          .reverse();
        if (files.length > 0) {
          const latestFile = files[0];
          const content = readFileSync(join(VAULT_ADVISOR_DIR, latestFile), "utf8");
          const lines = content.split("\n").slice(0, 40);
          latestReport = {
            file: latestFile,
            head: lines.join("\n"),
          };
        }
      }
    } catch {
      latestReport = null;
    }

    // Recent activity
    let recentActivity: string[] = [];
    try {
      if (existsSync(ACTIVITY_LOG)) {
        const content = readFileSync(ACTIVITY_LOG, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        recentActivity = lines.slice(-30);
      }
    } catch {
      recentActivity = [];
    }

    return Response.json({
      data: {
        jobs,
        cooldowns,
        models,
        roles,
        projects: readProjects(),
        latestReport,
        recentActivity,
        selfCorrection: readSelfCorrection(),
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error("agentTeamHandler failed:", e);
    return Response.json({
      data: {
        jobs: JOB_STATES.map((s) => ({ state: s, count: 0, items: [] })),
        cooldowns: [],
        models: { count: 0, providers: [], usableFree: 0 },
        roles: [],
        projects: [],
        latestReport: null,
        recentActivity: [],
        generatedAt: new Date().toISOString(),
      },
    });
  }
}

export function agentTeamJobHandler(id: string): Response {
  try {
    if (!ID_REGEX.test(id)) {
      return Response.json({ data: { id, files: [] } });
    }

    // Single-step (dispatch/ask) jobs store flat <id>.prompt and <id>.out files.
    const flat: { name: string; content: string }[] = [];
    for (const [ext, label] of [["prompt", "prompt"], ["out", "output"]] as const) {
      const fp = join(JOB_WORK_DIR, `${id}.${ext}`);
      if (existsSync(fp)) {
        try {
          const raw = readFileSync(fp, "utf8").replace(/\x1b?\[[0-9;]*m/g, "");
          flat.push({ name: label, content: raw.length > MAX_FILE_CONTENT ? raw.slice(-MAX_FILE_CONTENT) : raw });
        } catch { /* skip */ }
      }
    }

    const workDir = join(JOB_WORK_DIR, id);
    if (!existsSync(workDir)) {
      return Response.json({ data: { id, files: flat } });
    }

    const files = readdirSync(workDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        try {
          const raw = readFileSync(join(workDir, f), "utf8");
          // strip ANSI color escapes (opencode/codex CLI output) for clean display
          const content = raw.replace(/\[[0-9;]*m/g, "");
          const trimmed = content.length > MAX_FILE_CONTENT
            ? content.slice(-MAX_FILE_CONTENT)
            : content;
          return { name: f, content: trimmed };
        } catch {
          return { name: f, content: "" };
        }
      });

    return Response.json({ data: { id, files: [...files, ...flat] } });
  } catch {
    return Response.json({ data: { id, files: [] } });
  }
}

// ── Governed actions (mutating) — operator-token gated, file-scoped, audited ──
function auditAction(msg: string) {
  try { appendFileSync(ACTIVITY_LOG, `${new Date().toISOString().slice(11, 19)}Z [portal] ${msg}\n`); } catch { /* non-fatal */ }
}

function moveJob(jobId: string, fromStates: string[], to: string, mutate?: (j: Record<string, unknown>) => void): boolean {
  for (const s of fromStates) {
    const src = join(JOBS_DIR, s, jobId + ".json");
    if (!existsSync(src)) continue;
    try {
      const j = safeReadJson<Record<string, unknown>>(src, {});
      if (mutate) mutate(j);
      writeFileSync(join(JOBS_DIR, to, jobId + ".json"), JSON.stringify(j, null, 2));
      unlinkSync(src);
      return true;
    } catch { return false; }
  }
  return false;
}

export async function agentTeamActionHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  let body: Record<string, string>;
  try { body = (await req.json()) as Record<string, string>; }
  catch { return Response.json({ error: "invalid json" }, { status: 400 }); }

  const action = body.action ?? "";
  const jobId = body.jobId ?? "";
  const path = body.path ?? "";
  const name = body.name ?? "";
  const dir = body.dir ?? "";
  const goal = body.goal ?? "";

  // Hard guardrail floor (defensive — these actions are not destructive, but enforce anyway).
  const guard = safeReadJson<{ hard_forbidden?: string[] }>(GUARD_FILE, {});
  const forbidden = new Set(guard.hard_forbidden ?? []);
  if (forbidden.has("portal_actions")) return Response.json({ error: "actions disabled by guardrails" }, { status: 403 });

  if (action === "run-orchestrator") {
    try {
      spawn("systemctl", ["start", "mimule-orchestrator.service"], { detached: true, stdio: "ignore" }).unref();
      auditAction("run-orchestrator");
      return Response.json({ data: { ok: true, action } });
    } catch { return Response.json({ error: "failed to trigger orchestrator" }, { status: 500 }); }
  }

  // Register a project from the portal (no shell needed)
  if (action === "register-project") {
    if (!/^\/[A-Za-z0-9._\/ -]+$/.test(path) || !existsSync(path)) return Response.json({ error: "path must be an existing absolute directory" }, { status: 400 });
    const nm = /^[A-Za-z0-9._-]*$/.test(name) ? name : "";
    const r = spawnSync("/usr/local/bin/mimule-project", nm ? ["register", path, nm] : ["register", path], { timeout: 30000 });
    auditAction(`register-project ${path} ${nm}`);
    return Response.json({ data: { ok: r.status === 0, action, path } });
  }
  // Detect candidate projects on disk (no typing paths) — package.json/.git under common roots
  if (action === "scan-projects") {
    const roots = ["/opt", "/root", "/home"];
    const reg = new Set((safeReadJson<{ projects?: { path?: string }[] }>(PROJECTS_FILE, { projects: [] }).projects ?? []).map((p) => p.path));
    const out: { path: string; name: string; marker: string }[] = [];
    const seen = new Set<string>();
    const consider = (d: string) => {
      if (out.length >= 60 || seen.has(d) || reg.has(d)) return;
      const m = existsSync(join(d, "package.json")) ? "package.json" : (existsSync(join(d, ".git")) ? "git" : "");
      if (m) { out.push({ path: d, name: basename(d), marker: m }); seen.add(d); }
    };
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let entries: string[] = [];
      try { entries = readdirSync(root); } catch { continue; }
      for (const e of entries) {
        if (e === "node_modules" || e.startsWith(".")) continue;
        const d = join(root, e);
        try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
        consider(d);
        try {
          for (const e2 of readdirSync(d)) {
            if (e2 === "node_modules" || e2.startsWith(".")) continue;
            const d2 = join(d, e2);
            try { if (statSync(d2).isDirectory()) consider(d2); } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
    auditAction(`scan-projects -> ${out.length} candidates`);
    return Response.json({ data: { candidates: out } });
  }
  if (action === "unregister-project") {
    const nm = name || jobId;
    if (!/^[A-Za-z0-9._-]+$/.test(nm)) return Response.json({ error: "invalid name" }, { status: 400 });
    spawnSync("/usr/local/bin/mimule-project", ["unregister", nm], { timeout: 15000 });
    auditAction(`unregister-project ${nm}`);
    return Response.json({ data: { ok: true, action } });
  }
  // Enqueue a team job with a CUSTOM GOAL from the portal (e.g. "fix the mobile style on /agent-team")
  if (action === "enqueue-team") {
    if (!dir.startsWith("/") || !existsSync(dir)) return Response.json({ error: "dir must be an existing absolute path" }, { status: 400 });
    if (!goal || goal.trim().length < 5) return Response.json({ error: "goal required (min 5 chars)" }, { status: 400 });
    const id = `job-${Math.floor(Date.now() / 1000)}-${Math.floor(Math.random() * 100000)}`;
    const job = { id, type: "team", goal: goal.slice(0, 4000), dir, max_iters: 6, retries: 0, max_retries: 5, created: Math.floor(Date.now() / 1000) };
    try { writeFileSync(join(JOBS_DIR, "queue", id + ".json"), JSON.stringify(job, null, 2)); }
    catch { return Response.json({ error: "failed to enqueue" }, { status: 500 }); }
    auditAction(`enqueue-team dir=${dir} goal="${goal.slice(0, 60)}"`);
    return Response.json({ data: { ok: true, action, id } });
  }

  if (action === "clear-cooldown") {
    const provider = body.provider ?? "";
    if (!/^[a-z0-9-]+$/.test(provider)) return Response.json({ error: "invalid provider" }, { status: 400 });
    spawnSync("/usr/local/bin/mimule-cooldowns.py", ["clear", provider]);
    auditAction("clear-cooldown " + provider);
    return Response.json({ data: { ok: true } });
  }

  if (!ID_REGEX.test(jobId)) return Response.json({ error: "invalid id" }, { status: 400 });

  if (action === "improve-project") {
    try {
      spawn("/usr/local/bin/mimule-project", ["improve", jobId], { detached: true, stdio: "ignore" }).unref();
      auditAction(`improve-project ${jobId}`);
      return Response.json({ data: { ok: true, action, project: jobId } });
    } catch { return Response.json({ error: "failed to trigger improve" }, { status: 500 }); }
  }

  if (action === "requeue") {
    const ok = moveJob(jobId, ["rejected", "failed"], "queue", (j) => { j.retries = 0; delete j.not_before; });
    auditAction(`requeue job=${jobId} ${ok ? "ok" : "notfound"}`);
    return ok ? Response.json({ data: { ok: true, action, jobId } })
              : Response.json({ error: "job not found in rejected/failed" }, { status: 404 });
  }
  if (action === "cancel") {
    const ok = moveJob(jobId, ["queue"], "rejected", (j) => { j.cancelled = true; });
    auditAction(`cancel job=${jobId} ${ok ? "ok" : "notfound"}`);
    return ok ? Response.json({ data: { ok: true, action, jobId } })
              : Response.json({ error: "job not found in queue" }, { status: 404 });
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
}
