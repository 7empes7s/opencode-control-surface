import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { clearModelCooldown, modelQualityPath, setModelQualityStatus } from "./modelQuality.ts";
import { runContentHealthScan } from "../db/sampler.ts";
import { createJob, finishJob, readJob, updateJobOutput, writeActionAudit } from "../db/writer.ts";
import { getDoctorEntryErrorType, getFullLog } from "../adapters/doctor.ts";
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
export const ALLOWED_TIMERS = [
  "model-health-check",
  "mimule-backup",
  "paperclip-action-notify",
  "newsbites-agent-watch",
  "newsbites-brief",
  "morning-brief",
  "vast-watchdog",
];

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

  if (action === "clear-cooldown") {
    if (!model) return json({ error: "model required" }, 400);
    const cooldownsPath = process.env.DASHBOARD_MODEL_COOLDOWNS_PATH || "/var/lib/mimule/model-cooldowns.json";
    try {
      clearModelCooldown(model, cooldownsPath);
      audit({
        actionKind: "models.cooldown",
        actionId: `mutate-policy:model:${model}:cooldown-clear`,
        targetType: "model",
        targetId: model,
        risk: "medium",
        reason: reasonFromBody(body),
        request: body,
        evidence: [{ label: "Model cooldowns", kind: "file", ref: cooldownsPath }],
        result: `${model} cooldown cleared`,
        resultStatus: "success",
        rollbackHint: "The cooldown was cleared manually. Monitor for repeated failures that triggered it.",
      });
      return json({ ok: true, message: `${model} cooldown cleared` });
    } catch (e) {
      audit({
        actionKind: "models.cooldown",
        actionId: `mutate-policy:model:${model}:cooldown-clear`,
        targetType: "model",
        targetId: model,
        risk: "medium",
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

// ── Doctor requeue: shared pipeline dispatch (SPEC 13 / ULTRAPLAN P3 A2) ────
//
// Fixed 2026-07-06: the old doctorRequeuHandler POSTed {command:"requeue",
// slug} to the autopipeline. There is no "requeue" case in the pipeline's
// handleCommand switch (newsbites-autopipeline.mjs ~2499-2690) — it fell
// through to `default: return {ok:false, error:"Unknown command: requeue"}`.
// Worse than "the job always finished failed": the pipeline's HTTP layer
// (POST /command) always responds HTTP 200 even for an {ok:false,...} body
// (it only ever sets a non-200 status if handleCommand itself throws, which
// it doesn't — parse/dispatch errors are caught and returned as {ok:false}
// at 200). The old code decided success with `res.ok` (HTTP status only), so
// it was actually finishing the job "success" on a silently-broken requeue.
// Fixed by (a) targeting the real, sanctioned "doctor-dispatch" command and
// (b) parsing the JSON body's `ok` field to decide the job outcome instead of
// trusting HTTP status alone.
//
// doctor-dispatch (POST {cmd:"doctor-dispatch",slug} to /command, same
// handler as POST {slug} to /doctor/dispatch) finds the item in
// state.completed with slug === msg.slug && status === "stuck" and, if
// found, runs the pipeline's own dispatchDoctorForItem({source:"manual"}) —
// the LLM doctor then decides retry/cooldown/skip/kill. If the story is not
// currently stuck it returns {ok:false, error:'"<slug>" not found in stuck
// stories'} and we surface that verbatim as a legitimate `failed` job, not a
// crash. We use /command (not /doctor/dispatch) only because the rest of
// this file's pipeline calls already go through /command — same handler,
// picked for consistency, not because either is more "correct".
//
// We deliberately do NOT use "inject" (ULTRAPLAN's literal text): inject
// requires {dossierDir, stage}, which the doctor decision log does not
// carry (it only has slug/stage/errorType) — inject is a force-requeue power
// path for "after partial manual work", not the honest re-run-the-doctor
// action a decision-log row implies. doctor-dispatch is the correct match.
async function dispatchDoctorRequeue(
  slug: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; message: string; raw: unknown }> {
  const res = await fetch(`${PIPELINE_API}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "doctor-dispatch", slug }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body: fall back to raw text */ }
  const bodyRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const bodyOk = bodyRecord?.ok === true;
  const message = bodyRecord
    ? String(bodyRecord.error ?? bodyRecord.message ?? bodyRecord.action ?? text)
    : (text || `HTTP ${res.status}`);
  return { ok: res.ok && bodyOk, message, raw: parsed ?? text };
}

// Async worker for a single per-entry requeue job. Exported so tests can
// await it directly (mirrors runNewsBitesDeployContentHealthScan above) —
// the HTTP handler below fires it without awaiting so the response is
// immediate, job-then-poll style.
export async function runDoctorRequeueDispatch(jobId: string, slug: string): Promise<void> {
  try {
    const result = await dispatchDoctorRequeue(slug);
    const output = JSON.stringify(result.raw);
    updateJobOutput(jobId, output);
    finishJob(jobId, result.ok ? "success" : "failed", {
      output,
      exitCode: result.ok ? 0 : 1,
      error: result.ok ? undefined : result.message,
    });
    audit({
      actionKind: "doctor.requeue.finished",
      targetType: "story",
      targetId: slug,
      risk: "medium",
      request: { slug },
      result: result.message,
      resultStatus: result.ok ? "success" : "failed",
      error: result.ok ? undefined : result.message,
      jobId,
    });
  } catch (e) {
    const message = errorMessage(e);
    finishJob(jobId, "failed", { error: message, exitCode: 1 });
    audit({
      actionKind: "doctor.requeue.finished",
      targetType: "story",
      targetId: slug,
      risk: "medium",
      request: { slug },
      resultStatus: "failed",
      error: message,
      jobId,
    });
  }
}

// POST /api/doctor/requeue — re-run the doctor for one currently-stuck story.
export async function doctorRequeuHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;
  let body: { slug?: string; reason?: string };
  try { body = await req.json() as typeof body; } catch { return json({ error: "invalid json" }, 400); }
  const { slug, reason } = body;
  if (!slug) return json({ error: "slug required" }, 400);

  const jobId = randomUUID();
  createJob({
    id: jobId,
    kind: "doctor-requeue",
    targetType: "story",
    targetId: slug,
    command: `doctor-dispatch slug=${slug}`,
    evidence: [
      { label: "Doctor detail", kind: "api", ref: "/api/doctor" },
      { label: "Autopipeline doctor-dispatch", kind: "api", ref: "POST http://127.0.0.1:3200/command {cmd:doctor-dispatch}" },
    ],
    request: { slug, reason },
  });
  audit({
    actionKind: "doctor.requeue",
    actionId: `start-job:doctor-requeue:${slug}`,
    targetType: "story",
    targetId: slug,
    risk: "medium",
    reason,
    request: { slug },
    resultStatus: "running",
    jobId,
    rollbackHint: `Pause the autopipeline queue or remove the story manually if the requeue causes issues.`,
  });

  void runDoctorRequeueDispatch(jobId, slug);

  return json({ ok: true, jobId, message: `Requeue started for ${slug}` });
}

// ── Doctor requeue: fix-all-of-class (SPEC 13 / ULTRAPLAN P3 A2, Deliverable 2)

// Exported so both the handler and tests can reason about the cap.
export const DOCTOR_REQUEUE_CLASS_MAX = 10;

// Distinct candidate slugs for an error class, most-recent first, derived
// from the SAME computed errorType the doctor page displays and filters by
// (getDoctorEntryErrorType — not the raw jsonl field, which getFullLog's own
// `errorType` filter option checks and which can miss entries whose class
// comes from the diagnosis/legacy `class` field fallback). Dedup by slug;
// cap applied by the caller so the total-vs-acted count stays honest.
function candidateSlugsForErrorType(errorType: string): { total: number; slugs: string[] } {
  const entries = getFullLog();
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (getDoctorEntryErrorType(entry) !== errorType) continue;
    const slug = entry.slug;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    distinct.push(slug);
  }
  return { total: distinct.length, slugs: distinct.slice(0, DOCTOR_REQUEUE_CLASS_MAX) };
}

function isRefusalMessage(message: string): boolean {
  return /not found in stuck stories|not currently stuck|is not stuck/i.test(message);
}

export interface DoctorRequeueClassSummary {
  errorType: string;
  total: number;
  acted: number;
  dispatched: number;
  refused: number;
  failed: number;
  perSlug: { slug: string; ok: boolean; message: string }[];
}

// Async worker for the batch job. Exported for direct-await testing, same
// pattern as runDoctorRequeueDispatch. Per-slug failures are isolated — one
// refusal/timeout never aborts the batch — and every slug gets its own
// audit row correlated to the parent job via jobId.
export async function runDoctorRequeueClassDispatch(
  jobId: string,
  errorType: string,
  slugs: string[],
  totalCandidates: number,
): Promise<void> {
  const perSlug: { slug: string; ok: boolean; message: string }[] = [];
  try {
    for (const slug of slugs) {
      let outcome: { ok: boolean; message: string };
      try {
        const result = await dispatchDoctorRequeue(slug);
        outcome = { ok: result.ok, message: result.message };
      } catch (e) {
        outcome = { ok: false, message: errorMessage(e) };
      }
      perSlug.push({ slug, ...outcome });
      audit({
        actionKind: "doctor.requeue-class.slug",
        actionId: `doctor-requeue-class:${errorType}:${slug}`,
        targetType: "story",
        targetId: slug,
        risk: "medium",
        request: { slug, errorType },
        result: outcome.message,
        resultStatus: outcome.ok ? "success" : "failed",
        error: outcome.ok ? undefined : outcome.message,
        jobId,
      });
    }

    const dispatched = perSlug.filter((p) => p.ok).length;
    const refused = perSlug.filter((p) => !p.ok && isRefusalMessage(p.message)).length;
    const failed = perSlug.length - dispatched - refused;
    const summary: DoctorRequeueClassSummary = {
      errorType, total: totalCandidates, acted: slugs.length, dispatched, refused, failed, perSlug,
    };

    const output = JSON.stringify(summary);
    updateJobOutput(jobId, output);
    finishJob(jobId, "success", { output, exitCode: 0 });
    audit({
      actionKind: "doctor.requeue-class.finished",
      actionId: `doctor-requeue-class:${errorType}`,
      targetType: "doctor",
      targetId: errorType,
      risk: "medium",
      request: { errorType },
      result: `acted ${slugs.length}/${totalCandidates}: dispatched ${dispatched}, refused ${refused}, failed ${failed}`,
      resultStatus: "success",
      resultJson: summary,
      jobId,
    });
  } catch (e) {
    const message = errorMessage(e);
    finishJob(jobId, "failed", { error: message, exitCode: 1 });
    audit({
      actionKind: "doctor.requeue-class.finished",
      actionId: `doctor-requeue-class:${errorType}`,
      targetType: "doctor",
      targetId: errorType,
      risk: "medium",
      request: { errorType },
      resultStatus: "failed",
      error: message,
      jobId,
    });
  }
}

// POST /api/doctor/requeue-class — fix-all-of-class: re-dispatch every
// currently-stuck story whose latest errorType matches, capped and audited.
export async function doctorRequeueClassHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;
  let body: { errorType?: string; reason?: string };
  try { body = await req.json() as typeof body; } catch { return json({ error: "invalid json" }, 400); }
  const errorType = (body.errorType ?? "").trim();
  const reason = body.reason;
  if (!errorType) return json({ error: "errorType required" }, 400);

  const { total, slugs } = candidateSlugsForErrorType(errorType);

  const jobId = randomUUID();
  createJob({
    id: jobId,
    kind: "doctor-requeue-class",
    targetType: "doctor",
    targetId: errorType,
    command: `doctor-dispatch class=${errorType} candidates=${slugs.length}/${total}`,
    evidence: [
      { label: "Doctor log", kind: "file", ref: "/var/lib/mimule/doctor-log.jsonl" },
      { label: "Doctor detail", kind: "api", ref: "/api/doctor" },
    ],
    request: { errorType, reason, candidateSlugs: slugs, totalCandidates: total },
  });
  audit({
    actionKind: "doctor.requeue-class",
    actionId: `start-job:doctor-requeue-class:${errorType}`,
    targetType: "doctor",
    targetId: errorType,
    risk: "medium",
    reason,
    request: { errorType, candidateCount: slugs.length, totalCandidates: total },
    resultStatus: "running",
    jobId,
    rollbackHint: "Pause the autopipeline queue or manually cool down the affected stories if the batch requeue causes issues.",
  });

  void runDoctorRequeueClassDispatch(jobId, errorType, slugs, total);

  const message = slugs.length > 0
    ? `Fix-all-of-class started for ${slugs.length} of ${total} "${errorType}" stor${total === 1 ? "y" : "ies"}`
    : `No candidates found for error class "${errorType}"`;
  return json({
    ok: true,
    jobId,
    message,
    summary: { errorType, total, acted: slugs.length, candidateSlugs: slugs },
  });
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
