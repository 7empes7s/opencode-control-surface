import { execSync, spawn } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createJob, finishJob, readJob, updateJobOutput, writeActionAudit } from "../db/writer.ts";

const PIPELINE_API = "http://127.0.0.1:3200";

export const ALLOWED_SERVICES = [
  "newsbites", "newsbites-autopipeline", "litellm", "opencode-server",
  "control-surface", "vast-tunnel", "cloudflared",
];
export const ALLOWED_CONTAINERS = ["openclaw_gateway", "paperclip", "goblin_game"];
export const ALLOWED_TIMERS = ["model-health-check", "mimule-backup"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function audit(input: Parameters<typeof writeActionAudit>[0]): void {
  writeActionAudit(input);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reasonFromBody(body: unknown): string | undefined {
  return body && typeof body === "object" && "reason" in body
    ? String((body as { reason?: unknown }).reason ?? "") || undefined
    : undefined;
}

function isLocalRequest(req: Request): boolean {
  const host = req.headers.get("host")?.split(":")[0] ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function expectedSessionValue(token: string): string {
  return createHmac("sha256", token)
    .update("opencode-control-surface.operator-session.v1")
    .digest("base64url");
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") ?? "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function constantEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function checkToken(req: Request): boolean {
  const token = process.env.OPERATOR_TOKEN;
  if (!token) {
    return process.env.NODE_ENV !== "production" && isLocalRequest(req);
  }

  const headerToken = req.headers.get("x-operator-token");
  if (headerToken && constantEqual(headerToken, token)) return true;

  const sessionCookie = parseCookies(req).operator_session;
  const expected = expectedSessionValue(token);
  return Boolean(sessionCookie && constantEqual(sessionCookie, expected));
}

export function authStatusHandler(req: Request): Response {
  const configured = Boolean(process.env.OPERATOR_TOKEN);
  return json({
    configured,
    authenticated: checkToken(req),
    devBypass: !configured && process.env.NODE_ENV !== "production" && isLocalRequest(req),
  });
}

export async function authSessionHandler(req: Request): Promise<Response> {
  const token = process.env.OPERATOR_TOKEN;
  if (!token) return json({ error: "operator token is not configured" }, 503);

  let body: { token?: string };
  try { body = await req.json() as { token?: string }; }
  catch { return json({ error: "invalid json" }, 400); }

  if (!body.token || !constantEqual(body.token, token)) {
    return json({ error: "unauthorized" }, 401);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": [
        `operator_session=${encodeURIComponent(expectedSessionValue(token))}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=86400",
      ].join("; "),
    },
  });
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
    audit({
      actionKind: "autopipeline.command",
      targetType: "autopipeline",
      targetId: "command",
      risk: "high",
      reason: reasonFromBody(body),
      request: body,
      resultStatus: res.ok ? "success" : "failed",
      resultJson: result,
      error: res.ok ? undefined : JSON.stringify(result),
    });
    return json(result, res.status);
  } catch (e) {
    audit({
      actionKind: "autopipeline.command",
      targetType: "autopipeline",
      targetId: "command",
      risk: "high",
      reason: reasonFromBody(body),
      request: body,
      resultStatus: "failed",
      error: errorMessage(e),
    });
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
      audit({
        actionKind: "models.health-check",
        targetType: "model-health",
        targetId: "all",
        risk: "medium",
        reason: reasonFromBody(body),
        request: body,
        result: "model health check started",
        resultStatus: "success",
        rollbackHint: "Review model-health-check.service journal and retain the previous health file if the run fails.",
      });
      return json({ ok: true, message: "model health check started" });
    } catch (e) {
      audit({
        actionKind: "models.health-check",
        targetType: "model-health",
        targetId: "all",
        risk: "medium",
        reason: reasonFromBody(body),
        request: body,
        resultStatus: "failed",
        error: errorMessage(e),
      });
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
      audit({
        actionKind: "models.policy",
        actionId: `mutate-policy:model:${model}:${action}`,
        targetType: "model",
        targetId: model,
        risk: "high",
        reason: reasonFromBody(body),
        request: body,
        evidence: [{ label: "Model quality", kind: "file", ref: path }],
        result: `${model} ${action}`,
        resultStatus: "success",
        rollbackHint: `Use the inverse model policy action for ${model}.`,
      });
      return json({ ok: true, message: `${model} → ${action === "block" ? "blocked" : "healthy"}` });
    } catch (e) {
      audit({
        actionKind: "models.policy",
        actionId: model ? `mutate-policy:model:${model}:${action}` : undefined,
        targetType: "model",
        targetId: model,
        risk: "high",
        reason: reasonFromBody(body),
        request: body,
        resultStatus: "failed",
        error: errorMessage(e),
      });
      return json({ error: String(e) }, 500);
    }
  }

  audit({
    actionKind: "models.unknown",
    targetType: "model",
    targetId: model ?? "unknown",
    request: body,
    resultStatus: "failed",
    error: `unknown action: ${action}`,
  });
  return json({ error: `unknown action: ${action}` }, 400);
}

// POST /api/doctor/scan
export async function doctorScanHandler(req: Request): Promise<Response> {
  if (!checkToken(req)) return json({ error: "unauthorized" }, 401);
  try {
    const res = await fetch(`${PIPELINE_API}/doctor/scan`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    try {
      const result = JSON.parse(text);
      audit({
        actionKind: "doctor.scan",
        targetType: "doctor",
        targetId: "scan",
        risk: "medium",
        request: {},
        resultStatus: res.ok ? "success" : "failed",
        resultJson: result,
        error: res.ok ? undefined : text,
      });
      return json(result, res.status);
    } catch {
      audit({
        actionKind: "doctor.scan",
        targetType: "doctor",
        targetId: "scan",
        risk: "medium",
        request: {},
        resultStatus: res.ok ? "success" : "failed",
        result: text,
        error: res.ok ? undefined : text,
      });
      return json({ ok: res.ok, output: text }, res.status);
    }
  } catch (e) {
    audit({
      actionKind: "doctor.scan",
      targetType: "doctor",
      targetId: "scan",
      risk: "medium",
      request: {},
      resultStatus: "failed",
      error: errorMessage(e),
    });
    return json({ error: String(e) }, 502);
  }
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

  const jobId = randomUUID();
  const job: DeployJob = { jobId, status: "running", output: "", startedAt: Date.now() };
  const durable = createJob({
    id: jobId,
    kind: "newsbites-deploy",
    targetType: "deploy",
    targetId: "newsbites",
    command: "cd /opt/newsbites && ./deploy.sh",
    evidence: [
      { label: "Deploy script", kind: "file", ref: "/opt/newsbites/deploy.sh" },
      { label: "NewsBites detail", kind: "api", ref: "/api/newsbites" },
    ],
    request: {},
  });
  if (!durable) {
    deployJobs.set(jobId, job);
  }
  audit({
    actionKind: "newsbites.deploy",
    actionId: "start-job:deploy:newsbites",
    targetType: "deploy",
    targetId: "newsbites",
    risk: "high",
    request: {},
    result: "deploy job started",
    resultStatus: "running",
    jobId,
    rollbackHint: "Use the previous deployed build or inspect the NewsBites journal if deploy fails.",
  });

  const proc = spawn("bash", ["-c", "cd /opt/newsbites && ./deploy.sh 2>&1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  const append = (chunk: Buffer): void => {
    out += chunk.toString();
    job.output = out;
    updateJobOutput(jobId, out);
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  proc.on("close", (code: number | null) => {
    job.status = code === 0 ? "success" : "failed";
    job.output = out;
    finishJob(jobId, job.status, {
      output: out,
      exitCode: code,
      error: code === 0 ? undefined : `deploy exited with ${code}`,
    });
    audit({
      actionKind: "newsbites.deploy.finished",
      targetType: "deploy",
      targetId: "newsbites",
      risk: "high",
      request: {},
      result: job.status,
      resultStatus: job.status,
      jobId,
      error: code === 0 ? undefined : `deploy exited with ${code}`,
    });
    // Evict after 10 minutes
    setTimeout(() => deployJobs.delete(jobId), 600_000);
  });

  return json({ jobId });
}

// GET /api/newsbites/deploy/:jobId
export function newsBitesDeployStatusHandler(jobId: string): Response {
  const durableJob = readJob(jobId);
  if (durableJob) {
    return json({
      jobId: durableJob.id,
      status: durableJob.status,
      output: durableJob.outputTail,
      startedAt: durableJob.startedAt,
      finishedAt: durableJob.finishedAt,
      error: durableJob.error,
    });
  }

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
      audit({
        actionKind: "infra.service-restart",
        actionId: `start-job:service:${service}:restart`,
        targetType: "service",
        targetId: service,
        risk: "high",
        reason: reasonFromBody(body),
        request: body,
        result: `${service} restarted`,
        resultStatus: "success",
        evidence: [{ label: "Restart command", kind: "command", ref: `systemctl restart ${service}` }],
        rollbackHint: `Inspect ${service} logs and restart the previous dependency if health does not recover.`,
      });
      return json({ ok: true, message: `${service} restarted` });
    } catch (e) {
      audit({
        actionKind: "infra.service-restart",
        actionId: `start-job:service:${service}:restart`,
        targetType: "service",
        targetId: service,
        risk: "high",
        reason: reasonFromBody(body),
        request: body,
        resultStatus: "failed",
        error: errorMessage(e),
      });
      return json({ error: String(e) }, 500);
    }
  }
  if (ALLOWED_CONTAINERS.includes(service)) {
    try {
      execSync(`docker restart ${service}`, { timeout: 60_000 });
      audit({
        actionKind: "infra.container-restart",
        actionId: `start-job:service:${service}:restart`,
        targetType: "service",
        targetId: service,
        risk: "high",
        reason: reasonFromBody(body),
        request: body,
        result: `${service} restarted`,
        resultStatus: "success",
        evidence: [{ label: "Restart command", kind: "command", ref: `docker restart ${service}` }],
        rollbackHint: `Inspect ${service} container logs if health does not recover.`,
      });
      return json({ ok: true, message: `${service} restarted` });
    } catch (e) {
      audit({
        actionKind: "infra.container-restart",
        actionId: `start-job:service:${service}:restart`,
        targetType: "service",
        targetId: service,
        risk: "high",
        reason: reasonFromBody(body),
        request: body,
        resultStatus: "failed",
        error: errorMessage(e),
      });
      return json({ error: String(e) }, 500);
    }
  }
  audit({
    actionKind: "infra.service-restart",
    targetType: "service",
    targetId: service,
    risk: "high",
    reason: reasonFromBody(body),
    request: body,
    resultStatus: "failed",
    error: `not in allowlist: ${service}`,
  });
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
    audit({
      actionKind: "infra.run-timer",
      targetType: "timer",
      targetId: timer,
      risk: "medium",
      reason: reasonFromBody(body),
      request: body,
      resultStatus: "failed",
      error: `not in allowlist: ${timer}`,
    });
    return json({ error: `not in allowlist: ${timer}` }, 400);
  }
  try {
    execSync(`systemctl start ${timer}.service`, { timeout: 5_000 });
    audit({
      actionKind: "infra.run-timer",
      actionId: `start-job:timer:${timer}:run-now`,
      targetType: "timer",
      targetId: timer,
      risk: "medium",
      reason: reasonFromBody(body),
      request: body,
      result: `${timer} started`,
      resultStatus: "success",
      evidence: [{ label: "Timer command", kind: "command", ref: `systemctl start ${timer}.service` }],
      rollbackHint: "Inspect the service journal and wait for the next timer cycle if the manual run fails.",
    });
    return json({ ok: true, message: `${timer} started` });
  } catch (e) {
    audit({
      actionKind: "infra.run-timer",
      actionId: `start-job:timer:${timer}:run-now`,
      targetType: "timer",
      targetId: timer,
      risk: "medium",
      reason: reasonFromBody(body),
      request: body,
      resultStatus: "failed",
      error: errorMessage(e),
    });
    return json({ error: String(e) }, 500);
  }
}
