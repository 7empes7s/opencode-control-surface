import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PIPELINE_API = "http://127.0.0.1:3200";

const ALLOWED_SERVICES = [
  "newsbites", "newsbites-autopipeline", "litellm", "opencode-server",
  "control-surface", "vast-tunnel", "cloudflared",
];
const ALLOWED_CONTAINERS = ["openclaw_gateway", "paperclip", "goblin_game"];
const ALLOWED_TIMERS = ["model-health-check", "mimule-backup"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function checkToken(req: Request): boolean {
  const token = process.env.OPERATOR_TOKEN;
  if (!token) return true; // dev mode
  return req.headers.get("x-operator-token") === token;
}

// POST /api/autopipeline/command
export async function autopipelineCommandHandler(req: Request): Promise<Response> {
  if (!checkToken(req)) return json({ error: "unauthorized" }, 401);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  try {
    const res = await fetch(`${PIPELINE_API}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await res.json();
    return json(result, res.status);
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
}

// POST /api/models/action
export async function modelsActionHandler(req: Request): Promise<Response> {
  if (!checkToken(req)) return json({ error: "unauthorized" }, 401);
  let body: { action: string; model?: string };
  try { body = await req.json() as { action: string; model?: string }; }
  catch { return json({ error: "invalid json" }, 400); }

  const { action, model } = body;

  if (action === "run-quick-check" || action === "run-full-check") {
    try {
      execSync("systemctl start model-health-check.service", { timeout: 5_000 });
      return json({ ok: true, message: "model health check started" });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (action === "block" || action === "unblock" || action === "probation-clear") {
    if (!model) return json({ error: "model required" }, 400);
    try {
      const path = "/var/lib/mimule/model-quality.json";
      let quality: Record<string, { status: string; recentFailures: number; consecutiveGarbage: number }> = {};
      try { quality = JSON.parse(readFileSync(path, "utf8")); } catch {}
      const existing = quality[model] ?? { recentFailures: 0, consecutiveGarbage: 0 };
      if (action === "block") {
        quality[model] = { ...existing, status: "blocked" };
      } else {
        quality[model] = { ...existing, status: "healthy", recentFailures: 0, consecutiveGarbage: 0 };
      }
      writeFileSync(path, JSON.stringify(quality, null, 2));
      return json({ ok: true, message: `${model} → ${action === "block" ? "blocked" : "healthy"}` });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: `unknown action: ${action}` }, 400);
}

// In-memory deploy job store
interface DeployJob {
  jobId: string;
  status: "running" | "success" | "failed";
  output: string;
  startedAt: number;
}
const deployJobs = new Map<string, DeployJob>();

// POST /api/newsbites/deploy
export function newsBitesDeployHandler(req: Request): Response {
  if (!checkToken(req)) return json({ error: "unauthorized" }, 401);

  const jobId = Math.random().toString(36).slice(2);
  const job: DeployJob = { jobId, status: "running", output: "", startedAt: Date.now() };
  deployJobs.set(jobId, job);

  const proc = spawn("bash", ["-c", "cd /opt/newsbites && ./deploy.sh 2>&1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  proc.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); job.output = out; });
  proc.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString(); job.output = out; });
  proc.on("close", (code: number | null) => {
    job.status = code === 0 ? "success" : "failed";
    job.output = out;
    // Evict after 10 minutes
    setTimeout(() => deployJobs.delete(jobId), 600_000);
  });

  return json({ jobId });
}

// GET /api/newsbites/deploy/:jobId
export function newsBitesDeployStatusHandler(jobId: string): Response {
  const job = deployJobs.get(jobId);
  if (!job) return json({ error: "not found" }, 404);
  return json(job);
}

// POST /api/infra/service-restart
export async function infraServiceRestartHandler(req: Request): Promise<Response> {
  if (!checkToken(req)) return json({ error: "unauthorized" }, 401);
  let body: { service: string };
  try { body = await req.json() as { service: string }; }
  catch { return json({ error: "invalid json" }, 400); }

  const { service } = body;
  if (ALLOWED_SERVICES.includes(service)) {
    try {
      execSync(`systemctl restart ${service}`, { timeout: 30_000 });
      return json({ ok: true, message: `${service} restarted` });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }
  if (ALLOWED_CONTAINERS.includes(service)) {
    try {
      execSync(`docker restart ${service}`, { timeout: 60_000 });
      return json({ ok: true, message: `${service} restarted` });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }
  return json({ error: `not in allowlist: ${service}` }, 400);
}

// POST /api/infra/run-timer
export async function infraRunTimerHandler(req: Request): Promise<Response> {
  if (!checkToken(req)) return json({ error: "unauthorized" }, 401);
  let body: { timer: string };
  try { body = await req.json() as { timer: string }; }
  catch { return json({ error: "invalid json" }, 400); }

  const { timer } = body;
  if (!ALLOWED_TIMERS.includes(timer)) {
    return json({ error: `not in allowlist: ${timer}` }, 400);
  }
  try {
    execSync(`systemctl start ${timer}.service`, { timeout: 5_000 });
    return json({ ok: true, message: `${timer} started` });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
