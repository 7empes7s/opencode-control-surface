import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { clearModelCooldown, modelQualityPath, setModelQualityStatus } from "./modelQuality.ts";
import { runContentHealthScan } from "../db/sampler.ts";
import { runShell } from "./shell.ts";
import { createJob, finishJob, readJob, updateJobOutput, writeActionAudit } from "../db/writer.ts";
import { getDoctorEntryErrorType, getFullLog } from "../adapters/doctor.ts";
import {
  constantEqual,
  expectedLegacySessionValue,
  getAuthenticatedUser,
} from "../auth/session.ts";
import { requireMutation } from "../governance/rbac.ts";

const PIPELINE_API = "http://127.0.0.1:3200";
const MODEL_HEALTH_PATH = "/var/lib/mimule/model-health.json";
const LITELLM_ENV_PATH = "/etc/litellm/litellm.env";
const SINGLE_MODEL_PROBE_TIMEOUT_MS = 30_000;
const SINGLE_MODEL_PROBE_PROMPT = 'Reply with exactly this JSON object on one line, nothing else: {"status":"ok"}';
const NEWSBITES_DEPLOY_SCRIPT_PATH = "/opt/newsbites/deploy.sh";

export function newsBitesDeployAvailable(): boolean {
  return Boolean(process.env.DASHBOARD_NEWSBITES_DEPLOY_CMD?.trim())
    || existsSync(NEWSBITES_DEPLOY_SCRIPT_PATH);
}

export const ALLOWED_SERVICES = [
  "newsbites", "newsbites-autopipeline", "litellm", "opencode-server",
  "control-surface", "vast-tunnel", "cloudflared",
  "know-web", "know-health", "know-ops", "know-doctor",
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
  "know-health",
  "know-ops",
  "know-doctor",
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

function modelHealthPath(): string {
  return process.env.DASHBOARD_MODEL_HEALTH_PATH || MODEL_HEALTH_PATH;
}

function loadEnvValue(filePath: string, name: string): string | null {
  try {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match?.[1] === name) return match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // ignore
  }
  return null;
}

function litellmKey(): string | null {
  return process.env.LITELLM_MASTER_KEY || loadEnvValue(LITELLM_ENV_PATH, "LITELLM_MASTER_KEY");
}

function extractAssistantContent(body: string): string {
  try {
    const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
    const content = parsed.choices?.[0]?.message?.content ?? parsed.choices?.[0]?.text ?? "";
    return typeof content === "object" && content !== null ? JSON.stringify(content) : String(content);
  } catch {
    return "";
  }
}

function isParseableJsonResponse(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object";
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return false;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed !== null && typeof parsed === "object";
    } catch {
      return false;
    }
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let singleModelProbeFetch: FetchLike = fetch;

export function setSingleModelProbeFetchForTests(fn: FetchLike | null): void {
  singleModelProbeFetch = fn ?? fetch;
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

  if (action === "probe-model") {
    if (!model) return json({ error: "model required" }, 400);
    const jobId = randomUUID();
    createJob({
      id: jobId,
      kind: "model-single-probe",
      targetType: "model",
      targetId: model,
      command: `POST /v1/chat/completions model=${model} fallbacks=[]`,
      evidence: [{ label: "Model health", kind: "file", ref: modelHealthPath() }],
      request: body,
    });
    void runSingleModelProbe(jobId, model, reasonFromBody(body));
    audit({
      actionKind: "models.single-probe",
      actionId: `probe:model:${model}`,
      targetType: "model",
      targetId: model,
      risk: "low",
      reason: reasonFromBody(body),
      request: body,
      result: `${model} probe started`,
      resultStatus: "success",
      evidence: [{ label: "Model health", kind: "file", ref: modelHealthPath() }],
      rollbackHint: "Run the full model-health check if a single probe writes bad evidence.",
      jobId,
    });
    return json({ ok: true, jobId, message: `${model} probe started` });
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

type ModelHealthFile = {
  checkedAt?: number;
  checkedAtISO?: string;
  lastSingleProbeAt?: number;
  lastSingleProbeAtISO?: string;
  models?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

async function probeLogicalModel(logicalName: string): Promise<{
  available: boolean;
  latency: number;
  error?: string;
  resolvedModel?: string | null;
  jsonOk?: boolean;
  sampleContent?: string;
}> {
  const key = litellmKey();
  if (!key) return { available: false, latency: 0, error: "missing LITELLM_MASTER_KEY" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SINGLE_MODEL_PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await singleModelProbeFetch("http://127.0.0.1:4000/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: logicalName,
        messages: [{ role: "user", content: SINGLE_MODEL_PROBE_PROMPT }],
        temperature: 0,
        max_tokens: 40,
        store: false,
        fallbacks: [],
      }),
    });
    clearTimeout(timer);
    const latency = Date.now() - started;
    const text = await res.text().catch(() => "");
    if (!res.ok) return { available: false, latency, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    const content = extractAssistantContent(text);
    let resolvedModel: string | null = null;
    try {
      const parsed = JSON.parse(text) as { model?: unknown };
      resolvedModel = typeof parsed.model === "string" ? parsed.model : null;
    } catch {
      // ignore
    }
    return {
      available: true,
      latency,
      resolvedModel,
      jsonOk: isParseableJsonResponse(content),
      sampleContent: content.slice(0, 80),
    };
  } catch (error) {
    clearTimeout(timer);
    const name = error instanceof Error ? error.name : "";
    return {
      available: false,
      latency: Date.now() - started,
      error: name === "AbortError" ? "timeout" : errorMessage(error),
    };
  }
}

export async function runSingleModelProbe(jobId: string, logicalName: string, reason: string | undefined): Promise<void> {
  const path = modelHealthPath();
  const now = Date.now();
  let health: ModelHealthFile;
  try {
    health = JSON.parse(readFileSync(path, "utf8")) as ModelHealthFile;
  } catch (error) {
    const message = `model health file unreadable: ${errorMessage(error)}`;
    finishJob(jobId, "failed", { output: message, exitCode: 1, error: message });
    audit({
      actionKind: "models.single-probe.finished",
      actionId: `probe:model:${logicalName}`,
      targetType: "model",
      targetId: logicalName,
      risk: "low",
      reason,
      request: { logicalName, path },
      resultStatus: "failed",
      result: message,
      error: message,
      jobId,
    });
    return;
  }

  const models = Array.isArray(health.models) ? health.models : [];
  const index = models.findIndex((model) => model.logicalName === logicalName);
  if (index < 0) {
    const message = `model not found in health file: ${logicalName}`;
    finishJob(jobId, "failed", { output: message, exitCode: 1, error: message });
    audit({
      actionKind: "models.single-probe.finished",
      actionId: `probe:model:${logicalName}`,
      targetType: "model",
      targetId: logicalName,
      risk: "low",
      reason,
      request: { logicalName, path },
      resultStatus: "failed",
      result: message,
      error: message,
      evidence: [{ label: "Model health", kind: "file", ref: path }],
      jobId,
    });
    return;
  }

  const previous = models[index];
  const probe = await probeLogicalModel(logicalName);
  models[index] = {
    ...previous,
    available: probe.available,
    latency: probe.latency,
    error: probe.available ? null : probe.error ?? "probe failed",
    checkedAt: now,
    lastTestedAt: now,
    jsonOk: probe.jsonOk ?? previous.jsonOk ?? false,
    resolvedModel: probe.resolvedModel ?? previous.resolvedModel ?? null,
    unavailableSince: probe.available ? null : previous.unavailableSince ?? now,
  };
  health.models = models;
  health.checkedAt = now;
  health.checkedAtISO = new Date(now).toISOString();
  health.lastSingleProbeAt = now;
  health.lastSingleProbeAtISO = health.checkedAtISO;
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(health, null, 2)}\n`, "utf8");

  const output = JSON.stringify({ logicalName, ...probe, healthPath: path });
  updateJobOutput(jobId, output);
  finishJob(jobId, probe.available ? "success" : "failed", {
    output,
    exitCode: probe.available ? 0 : 1,
    error: probe.available ? undefined : probe.error ?? "probe failed",
  });
  audit({
    actionKind: "models.single-probe.finished",
    actionId: `probe:model:${logicalName}`,
    targetType: "model",
    targetId: logicalName,
    risk: "low",
    reason,
    request: { logicalName },
    resultStatus: probe.available ? "success" : "failed",
    result: probe.available
      ? `${logicalName} probe succeeded (${probe.latency}ms)`
      : `${logicalName} probe failed: ${probe.error ?? "unknown"}`,
    resultJson: { logicalName, ...probe },
    evidence: [{ label: "Model health", kind: "file", ref: path }],
    rollbackHint: "Restore the previous model-health.json from backup if this probe produced bad evidence; otherwise run the full model-health check.",
    error: probe.available ? undefined : probe.error ?? "probe failed",
    jobId,
  });
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

export function startNewsBitesDeployJob(): { jobId: string } {
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

  // Resolve at call time so tests can exercise the real job lifecycle with a
  // harmless command while production retains the existing deploy verbatim.
  const command = process.env.DASHBOARD_NEWSBITES_DEPLOY_CMD?.trim() || "cd /opt/newsbites && ./deploy.sh 2>&1";
  const proc = spawn("bash", ["-c", command], {
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

  return { jobId };
}

// POST /api/newsbites/deploy
export function newsBitesDeployHandler(req: Request): Response {
  const denied = requireMutation(req);
  if (denied) return denied;

  return json(startNewsBitesDeployJob());
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

// ── Infra service/container restart: durable job + before/after health
// capture (SPEC 14 / ULTRAPLAN P3 A3a) ──────────────────────────────────
//
// Was: execSync(...) called synchronously inline in the HTTP handler,
// blocking the response up to 30-60s, with no job row (invisible on
// /jobs, not retryable — the "fire-and-forget" A3 targets). Now: the
// handler only validates + allowlists + creates the job, returns
// {ok, jobId} immediately, and an exported async worker (awaitable
// directly in tests, mirroring doctorScanHandler/runDoctorRequeueDispatch)
// does the actual restart through the runShell seam and captures
// BEFORE/AFTER state. A restart is only judged `success` if BOTH the
// restart command succeeded AND the after-state is healthy — a command
// that exits 0 but leaves the unit unhealthy is a legitimate `failed`
// with the observed state surfaced (the SPEC 13 res.ok lesson: judge on
// captured state, not just the command's exit).
//
// cloudflared is already in ALLOWED_SERVICES, so its restart already goes
// through this exact path — the before/after `systemctl is-active
// cloudflared` capture below IS its post-restart health probe; no
// separate cloudflared-specific code is needed to satisfy that half of
// the A3 bullet.
const INFRA_RESTART_SETTLE_MS = 1_500;
const INFRA_RESTART_RETRY_DELAY_MS = 1_500;

// Test seam for the two delays above. Production always uses the named
// constants; hermetic tests dial them down to a few ms so the suite
// doesn't burn real wall-clock seconds waiting out a settle window whose
// only job is "give a stubbed restart a moment before re-reading state".
let infraRestartSettleMs = INFRA_RESTART_SETTLE_MS;
let infraRestartRetryDelayMs = INFRA_RESTART_RETRY_DELAY_MS;
export function setInfraRestartTimingForTests(opts: { settleMs?: number; retryDelayMs?: number } | null): void {
  infraRestartSettleMs = opts?.settleMs ?? INFRA_RESTART_SETTLE_MS;
  infraRestartRetryDelayMs = opts?.retryDelayMs ?? INFRA_RESTART_RETRY_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RestartTargetKind = "service" | "container";

function captureRestartState(kind: RestartTargetKind, id: string): string {
  const res = kind === "container"
    ? runShell(`docker inspect --format '{{.State.Status}}' ${id}`, { timeout: 5_000 })
    : runShell(`systemctl is-active ${id}`, { timeout: 5_000 });
  const stdout = res.stdout.trim();
  if (stdout) return stdout;
  return res.stderr?.trim() || "unknown";
}

function isRestartHealthy(kind: RestartTargetKind, state: string): boolean {
  return kind === "container" ? state === "running" : state === "active";
}

// Exported so tests can await the restart worker directly instead of
// racing the fire-and-forget promise the HTTP handler kicks off.
export async function runInfraServiceRestart(
  jobId: string,
  kind: RestartTargetKind,
  id: string,
  reason: string | undefined,
): Promise<void> {
  const actionKind = kind === "container" ? "infra.container-restart" : "infra.service-restart";
  const before = captureRestartState(kind, id);
  const command = kind === "container" ? `docker restart ${id}` : `systemctl restart ${id}`;
  const restartResult = runShell(command, { timeout: kind === "container" ? 60_000 : 30_000 });

  await sleep(infraRestartSettleMs);
  let after = captureRestartState(kind, id);
  if (!isRestartHealthy(kind, after)) {
    await sleep(infraRestartRetryDelayMs);
    after = captureRestartState(kind, id);
  }

  const healthy = isRestartHealthy(kind, after);
  const success = restartResult.ok && healthy;
  const evidence = { before, after, command };
  const output = JSON.stringify(evidence);
  const failureReason = !restartResult.ok
    ? (restartResult.error ?? "restart command failed")
    : `after-state not healthy: ${after}`;

  updateJobOutput(jobId, output);
  finishJob(jobId, success ? "success" : "failed", {
    output,
    exitCode: success ? 0 : 1,
    error: success ? undefined : failureReason,
  });
  audit({
    actionKind: `${actionKind}.finished`,
    targetType: "service",
    targetId: id,
    risk: "high",
    reason,
    request: {},
    result: success
      ? `${id} restarted (before=${before}, after=${after})`
      : `${id} restart did not reach a healthy state (before=${before}, after=${after})`,
    resultStatus: success ? "success" : "failed",
    resultJson: evidence,
    evidence: [
      { label: "Restart command", kind: "command", ref: command },
      { label: "Before state", kind: "text", ref: before },
      { label: "After state", kind: "text", ref: after },
    ],
    rollbackHint: `Inspect ${id} logs and restart the previous dependency if health does not recover.`,
    error: success ? undefined : failureReason,
    jobId,
  });
}

// POST /api/infra/service-restart
export async function infraServiceRestartHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;
  let body: { service: string; reason?: string };
  try { body = await req.json() as { service: string; reason?: string }; }
  catch { return json({ error: "invalid json" }, 400); }

  const { service } = body;
  const kind: RestartTargetKind | null = ALLOWED_SERVICES.includes(service)
    ? "service"
    : ALLOWED_CONTAINERS.includes(service)
    ? "container"
    : null;

  // Allowlist refusal stays audited and returns 400 with no job created —
  // consistent, never-silent, and unchanged from the old behavior.
  if (!kind) {
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

  const actionKind = kind === "container" ? "infra.container-restart" : "infra.service-restart";
  const jobId = randomUUID();
  createJob({
    id: jobId,
    kind: "infra-service-restart",
    targetType: "service",
    targetId: service,
    command: kind === "container" ? `docker restart ${service}` : `systemctl restart ${service}`,
    request: body,
  });
  audit({
    actionKind,
    actionId: `start-job:service:${service}:restart`,
    targetType: "service",
    targetId: service,
    risk: "high",
    reason: reasonFromBody(body),
    request: body,
    resultStatus: "running",
    jobId,
  });

  // Fire-and-forget the worker itself is fine — the *job* is durable and
  // retryable; the HTTP response no longer blocks on the restart.
  void runInfraServiceRestart(jobId, kind, service, reasonFromBody(body));

  return json({ ok: true, jobId, message: `${service} restart started` });
}

// ── Infra timer run: durable job + --no-block fix (SPEC 14 / ULTRAPLAN
// P3 A3a) ────────────────────────────────────────────────────────────────
//
// Latent bug fixed here: the old code ran `systemctl start
// ${timer}.service` (no --no-block) at a 5s timeout. `systemctl start`
// without --no-block blocks until the unit's start job completes, so any
// oneshot timer whose work takes longer than ~5s (backups, scans, model
// health checks) hit ETIMEDOUT and was reported `failed` even though it
// was enqueued fine and kept running. The execute.ts timer path (line
// ~256) and model-health path (~279) already learned this and pass
// --no-block; this handler gets the same fix.
// "Enqueue succeeded" (exit 0 from a --no-block start) is a different,
// weaker claim than "the oneshot finished" — we only assert the former
// and record the observed post-enqueue unit state as evidence, honestly.
export async function runInfraTimerRun(jobId: string, timer: string, reason: string | undefined): Promise<void> {
  const command = `systemctl start --no-block ${timer}.service`;
  const startResult = runShell(command, { timeout: 5_000 });
  const stateResult = runShell(`systemctl is-active ${timer}.service`, { timeout: 5_000 });
  const state = stateResult.stdout.trim() || (stateResult.stderr?.trim() || "unknown");

  const success = startResult.ok;
  const evidence = { command, state };
  const output = JSON.stringify(evidence);
  const failureReason = startResult.error ?? "enqueue failed";

  updateJobOutput(jobId, output);
  finishJob(jobId, success ? "success" : "failed", {
    output,
    exitCode: success ? 0 : 1,
    error: success ? undefined : failureReason,
  });
  audit({
    actionKind: "infra.run-timer.finished",
    targetType: "timer",
    targetId: timer,
    risk: "medium",
    reason,
    request: {},
    result: success
      ? `${timer} enqueued via --no-block; observed post-enqueue state: ${state}`
      : `${timer} enqueue failed`,
    resultStatus: success ? "success" : "failed",
    resultJson: evidence,
    evidence: [
      { label: "Timer command", kind: "command", ref: command },
      { label: "Post-enqueue state", kind: "text", ref: state },
    ],
    rollbackHint: "Inspect the service journal and wait for the next timer cycle if the manual run fails.",
    error: success ? undefined : failureReason,
    jobId,
  });
}

const KNOW_ROOT = "/opt/know/web";
const KNOW_VALIDATION_COMMANDS = {
  typecheck: `cd ${KNOW_ROOT} && npm run typecheck`,
  build: `cd ${KNOW_ROOT} && npm run build`,
} as const;

export type KnowValidationTarget = keyof typeof KNOW_VALIDATION_COMMANDS;

/** Run one fixed, read-only Know validation as a durable Control Surface job. */
export async function runKnowValidation(
  jobId: string,
  target: KnowValidationTarget,
  reason: string | undefined,
): Promise<void> {
  // Yield before the synchronous runner so the API can return the durable job id.
  await Promise.resolve();
  const envName = target === "typecheck" ? "DASHBOARD_KNOW_TYPECHECK_CMD" : "DASHBOARD_KNOW_BUILD_CMD";
  const command = process.env[envName]?.trim() || KNOW_VALIDATION_COMMANDS[target];
  const result = runShell(command, { timeout: target === "build" ? 180_000 : 120_000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-64_000);
  updateJobOutput(jobId, output);
  finishJob(jobId, result.ok ? "success" : "failed", {
    output,
    exitCode: result.ok ? 0 : 1,
    error: result.ok ? undefined : result.error ?? `${target} failed`,
  });
  audit({
    actionKind: "know.validation.finished",
    actionId: `run:know:${target}`,
    targetType: "know",
    targetId: target,
    risk: target === "build" ? "medium" : "low",
    reason,
    request: { target },
    result: result.ok ? `Know ${target} passed` : `Know ${target} failed`,
    resultStatus: result.ok ? "success" : "failed",
    jobId,
    evidence: [{ label: "Know validation", kind: "command", ref: KNOW_VALIDATION_COMMANDS[target] }],
    error: result.ok ? undefined : result.error ?? `${target} failed`,
  });
}

// POST /api/infra/run-timer
export async function infraRunTimerHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;
  let body: { timer: string; reason?: string };
  try { body = await req.json() as { timer: string; reason?: string }; }
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

  const jobId = randomUUID();
  createJob({
    id: jobId,
    kind: "infra-run-timer",
    targetType: "timer",
    targetId: timer,
    command: `systemctl start --no-block ${timer}.service`,
    request: body,
  });
  audit({
    actionKind: "infra.run-timer",
    actionId: `start-job:timer:${timer}:run-now`,
    targetType: "timer",
    targetId: timer,
    risk: "medium",
    reason: reasonFromBody(body),
    request: body,
    resultStatus: "running",
    jobId,
  });

  void runInfraTimerRun(jobId, timer, reasonFromBody(body));

  return json({ ok: true, jobId, message: `${timer} run started` });
}

// ── Disk reclaim: bounded, audited Docker prune (SPEC 15 / ULTRAPLAN P3 A3b) ─
//
// "Bounded" is the whole point: docker builder prune -f (build cache only)
// and docker image prune -f (dangling/untagged images only) — NEVER
// `-a`/`--all`, which would also delete tagged-but-unused images an operator
// may still want. Neither command touches volumes or images in use by a
// running container. Both commands run through
// the runShell seam so tests can assert the exact strings and never touch a
// real Docker daemon. Per the SPEC 13 lesson, success is judged on whether
// both prune commands themselves succeeded — a prune that reclaims 0 bytes
// (nothing to reclaim) is still a legitimate success, not a failure.
const DISK_RECLAIM_COMMAND_TIMEOUT_MS = 120_000;
const DISK_RECLAIM_DF_TIMEOUT_MS = 5_000;
const DISK_RECLAIM_DF_COMMAND = "df -BG /";
const DISK_RECLAIM_BUILDER_COMMAND = "docker builder prune -f";
const DISK_RECLAIM_IMAGE_COMMAND = "docker image prune -f";

type DfSnapshot = { usedGb: number; usedPct: number; raw: string };

// Parses the data row of `df -BG /` (whole-GB granularity — precise enough to
// report reclaimed space to an operator without a second byte-level parse
// path. Typical output:
//   Filesystem     1G-blocks  Used Available Use% Mounted on
//   /dev/sda1           150G  107G       38G  74% /
function parseDfGb(stdout: string): DfSnapshot | null {
  const lines = stdout.trim().split("\n").filter((line) => line.trim().length > 0);
  const dataLine = lines[lines.length - 1];
  if (!dataLine) return null;
  const parts = dataLine.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const usedGb = parseInt(parts[2], 10);
  const usedPct = parseInt(parts[4], 10);
  if (!Number.isFinite(usedGb) || !Number.isFinite(usedPct)) return null;
  return { usedGb, usedPct, raw: dataLine.trim() };
}

// Exported so tests can await the reclaim worker directly, same pattern as
// runInfraServiceRestart/runInfraTimerRun above.
export async function runDiskReclaim(jobId: string, reason: string | undefined): Promise<void> {
  const beforeCapture = runShell(DISK_RECLAIM_DF_COMMAND, { timeout: DISK_RECLAIM_DF_TIMEOUT_MS });
  const before = parseDfGb(beforeCapture.stdout);

  // Sequential and in this exact order — runShell is synchronous, so this IS
  // the ordering guarantee, not just a convention: builder cache first, then
  // dangling images. Both always run regardless of the first's outcome so
  // the operator gets maximum evidence; overall success requires both ok.
  const builderResult = runShell(DISK_RECLAIM_BUILDER_COMMAND, { timeout: DISK_RECLAIM_COMMAND_TIMEOUT_MS });
  const imageResult = runShell(DISK_RECLAIM_IMAGE_COMMAND, { timeout: DISK_RECLAIM_COMMAND_TIMEOUT_MS });

  const afterCapture = runShell(DISK_RECLAIM_DF_COMMAND, { timeout: DISK_RECLAIM_DF_TIMEOUT_MS });
  const after = parseDfGb(afterCapture.stdout);

  const success = builderResult.ok && imageResult.ok;
  const beforeUsedGb = before?.usedGb ?? null;
  const afterUsedGb = after?.usedGb ?? null;
  const reclaimedGb = beforeUsedGb !== null && afterUsedGb !== null ? beforeUsedGb - afterUsedGb : null;

  const evidence = {
    beforePct: before?.usedPct ?? null,
    afterPct: after?.usedPct ?? null,
    beforeUsedGb,
    afterUsedGb,
    reclaimedGb,
    builderPruneOutput: builderResult.stdout,
    imagePruneOutput: imageResult.stdout,
    commands: [DISK_RECLAIM_DF_COMMAND, DISK_RECLAIM_BUILDER_COMMAND, DISK_RECLAIM_IMAGE_COMMAND, DISK_RECLAIM_DF_COMMAND],
  };
  const output = JSON.stringify(evidence);
  const failureReason = !builderResult.ok
    ? (builderResult.stderr || builderResult.error || "docker builder prune failed")
    : !imageResult.ok
    ? (imageResult.stderr || imageResult.error || "docker image prune failed")
    : undefined;

  updateJobOutput(jobId, output);
  finishJob(jobId, success ? "success" : "failed", {
    output,
    exitCode: success ? 0 : 1,
    error: success ? undefined : failureReason,
  });
  audit({
    actionKind: "reclaim.disk-docker-prune.finished",
    targetType: "disk",
    targetId: "docker-prune",
    risk: "medium",
    reason,
    request: {},
    result: success
      ? `docker prune reclaimed ${reclaimedGb ?? "unknown"}GB (before=${before?.usedPct ?? "?"}%, after=${after?.usedPct ?? "?"}%)`
      : `docker prune failed: ${failureReason}`,
    resultStatus: success ? "success" : "failed",
    resultJson: evidence,
    evidence: [
      { label: "Builder cache prune", kind: "command", ref: DISK_RECLAIM_BUILDER_COMMAND },
      { label: "Dangling image prune", kind: "command", ref: DISK_RECLAIM_IMAGE_COMMAND },
      { label: "Before df -BG /", kind: "text", ref: before?.raw ?? "unknown" },
      { label: "After df -BG /", kind: "text", ref: after?.raw ?? "unknown" },
    ],
    rollbackHint: "Pruned build cache and dangling images cannot be restored; rebuild or re-pull an image if one turns out to have still been needed.",
    error: success ? undefined : failureReason,
    jobId,
  });
}
