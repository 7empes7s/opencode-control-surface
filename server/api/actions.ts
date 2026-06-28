import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { modelQualityPath, setModelQualityStatus } from "./modelQuality.ts";
import { runContentHealthScan } from "../db/sampler.ts";
import { createJob, finishJob, readJob, updateJobOutput, writeActionAudit } from "../db/writer.ts";
import {
  constantEqual,
  expectedLegacySessionValue,
  getAuthenticatedUser,
} from "../auth/session.ts";
import { requireMutation } from "../governance/rbac.ts";

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

// Fail-closed: rejects when OPERATOR_TOKEN is not set (prevents dev-bootstrap
// from granting read access on a misconfigured production deployment).
export function checkToken(req: Request): boolean {
  if (!process.env.OPERATOR_TOKEN) return false;
  return Boolean(getAuthenticatedUser(req));
}

export function authStatusHandler(req: Request): Response {
  const configured = Boolean(process.env.OPERATOR_TOKEN);
  return json({
    configured,
    authenticated: checkToken(req),
    devBypass: getAuthenticatedUser(req)?.source === "dev-bootstrap",
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
        `operator_session=${encodeURIComponent(expectedLegacySessionValue(token))}`,
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
  const denied = requireMutation(req);
  if (denied) return denied;
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
  const denied = requireMutation(req);
  if (denied) return denied;
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
      const path = modelQualityPath();
      setModelQualityStatus(model, action === "block" ? "blocked" : "healthy", path);
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

// POST /api/doctor/scan — durable job wrapper
export async function doctorScanHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  const jobId = randomUUID();
  createJob({
    id: jobId,
    kind: "doctor-scan",
    targetType: "doctor",
    targetId: "scan",
    command: `POST ${PIPELINE_API}/doctor/scan`,
    evidence: [{ label: "Doctor log", kind: "file", ref: "/var/lib/mimule/doctor-log.jsonl" }],
    request: {},
  });
  audit({
    actionKind: "doctor.scan",
    actionId: "start-job:doctor:scan",
    targetType: "doctor",
    targetId: "scan",
    risk: "medium",
    request: {},
    resultStatus: "running",
    jobId,
  });

  // Run scan asynchronously so the HTTP response is immediate.
  (async () => {
    try {
      const res = await fetch(`${PIPELINE_API}/doctor/scan`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      updateJobOutput(jobId, text);
      finishJob(jobId, res.ok ? "success" : "failed", {
        output: text,
        exitCode: res.ok ? 0 : 1,
        error: res.ok ? undefined : text,
      });
      audit({
        actionKind: "doctor.scan.finished",
        targetType: "doctor",
        targetId: "scan",
        risk: "medium",
        request: {},
        resultStatus: res.ok ? "success" : "failed",
        result: text.slice(0, 200),
        error: res.ok ? undefined : text,
        jobId,
      });
    } catch (e) {
      finishJob(jobId, "failed", { error: errorMessage(e), exitCode: 1 });
      audit({
        actionKind: "doctor.scan.finished",
        targetType: "doctor",
        targetId: "scan",
        risk: "medium",
        request: {},
        resultStatus: "failed",
        error: errorMessage(e),
        jobId,
      });
    }
  })();

  return json({ ok: true, jobId, message: "Doctor scan started" });
}

// POST /api/doctor/requeue — requeue a story at a specific stage via autopipeline
export async function doctorRequeuHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;
  let body: { slug?: string; nextStage?: string; reason?: string };
  try { body = await req.json() as typeof body; } catch { return json({ error: "invalid json" }, 400); }
  const { slug, nextStage, reason } = body;
  if (!slug) return json({ error: "slug required" }, 400);

  const jobId = randomUUID();
  createJob({
    id: jobId,
    kind: "doctor-requeue",
    targetType: "story",
    targetId: slug,
    command: `requeue slug=${slug} nextStage=${nextStage ?? "auto"}`,
    evidence: [{ label: "Autopipeline", kind: "api", ref: "/api/autopipeline" }],
    request: { slug, nextStage, reason },
  });
  audit({
    actionKind: "doctor.requeue",
    actionId: `start-job:doctor-requeue:${slug}`,
    targetType: "story",
    targetId: slug,
    risk: "medium",
    reason,
    request: { slug, nextStage },
    resultStatus: "running",
    jobId,
    rollbackHint: `Pause the autopipeline queue or remove the story manually if the requeue causes issues.`,
  });

  (async () => {
    try {
      const payload: Record<string, unknown> = { command: "requeue", slug };
      if (nextStage) payload.nextStage = nextStage;
      if (reason) payload.reason = reason;
      const res = await fetch(`${PIPELINE_API}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      updateJobOutput(jobId, text);
      finishJob(jobId, res.ok ? "success" : "failed", {
        output: text,
        exitCode: res.ok ? 0 : 1,
        error: res.ok ? undefined : text,
      });
    } catch (e) {
      finishJob(jobId, "failed", { error: errorMessage(e), exitCode: 1 });
    }
  })();

  return json({ ok: true, jobId, message: `Requeue started for ${slug}` });
}

// In-memory deploy job store
interface DeployJob {
  jobId: string;
  status: "running" | "success" | "failed";
  output: string;
  startedAt: number;
}
const deployJobs = new Map<string, DeployJob>();

function findingLabel(count: number): string {
  return count === 1 ? "finding" : "findings";
}

export async function runNewsBitesDeployContentHealthScan(
  jobId: string,
  currentOutput: string,
  updateMemoryOutput?: (output: string) => void,
): Promise<void> {
  try {
    const generatedFindings = await runContentHealthScan({ probeExternalLinks: true });
    const nextOutput = `${currentOutput}\n[content-health] post-deploy scan generated ${generatedFindings} ${findingLabel(generatedFindings)}\n`;
    updateMemoryOutput?.(nextOutput);
    updateJobOutput(jobId, nextOutput);
    audit({
      actionKind: "content-health.post-deploy-scan",
      actionId: "scan:content-health:newsbites-deploy",
      targetType: "content-health",
      targetId: "newsbites",
      risk: "low",
      request: { sourceJobId: jobId, probeExternalLinks: true },
      result: `generated ${generatedFindings} ${findingLabel(generatedFindings)}`,
      resultStatus: "success",
      jobId,
    });
  } catch (error) {
    const message = errorMessage(error);
    const nextOutput = `${currentOutput}\n[content-health] post-deploy scan failed: ${message}\n`;
    updateMemoryOutput?.(nextOutput);
    updateJobOutput(jobId, nextOutput);
    audit({
      actionKind: "content-health.post-deploy-scan",
      actionId: "scan:content-health:newsbites-deploy",
      targetType: "content-health",
      targetId: "newsbites",
      risk: "low",
      request: { sourceJobId: jobId, probeExternalLinks: true },
      resultStatus: "failed",
      error: message,
      jobId,
    });
  }
}

// POST /api/newsbites/deploy
export function newsBitesDeployHandler(req: Request): Response {
  const denied = requireMutation(req);
  if (denied) return denied;

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
    if (code === 0) {
      void runNewsBitesDeployContentHealthScan(jobId, out, (nextOutput) => {
        out = nextOutput;
        job.output = nextOutput;
      });
    }
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
  const denied = requireMutation(req);
  if (denied) return denied;
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
  const denied = requireMutation(req);
  if (denied) return denied;
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
