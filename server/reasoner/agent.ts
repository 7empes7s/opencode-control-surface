import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { complete } from "../gateway/client.ts";
import { clusterDiagnosis } from "./clustering.ts";
import { buildDiagnosisPrompt, parseDiagnosisResult, type DiagnosisPromptInput } from "./prompts.ts";
import type { DiagnosisResult, ReasonerJob } from "./types.ts";
import {
  readBuilderPasses,
  readBuilderRun,
  readBuilderWorkflow,
  readBuilderValidations,
} from "../builder/store.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

function requireDb() {
  if (!isDashboardDbEnabled()) throw new Error("DASHBOARD_DB disabled");
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard SQLite unavailable");
  return db;
}

export function queueDiagnosis(passId: string, runId: string, workflowId: string): string {
  const db = requireDb();
  const id = `rq_${randomUUID()}`;
  const ts = Date.now();
  const tenantId = getCurrentTenantContext().tenantId;
  db.query(`
    INSERT INTO reasoner_jobs (id, pass_id, run_id, workflow_id, status, attempts, created_at, tenant_id)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(id, passId, runId, workflowId, ts, tenantId);
  return id;
}

function getJob(db: ReturnType<typeof requireDb>, jobId: string): ReasonerJob | null {
  const tenantId = getCurrentTenantContext().tenantId;
  const row = db.query(`
    SELECT id, pass_id, run_id, workflow_id, status, attempts, created_at, finished_at, error
    FROM reasoner_jobs WHERE id = ? AND tenant_id = ?
  `).get(jobId, tenantId) as {
    id: string;
    pass_id: string;
    run_id: string;
    workflow_id: string;
    status: string;
    attempts: number;
    created_at: number;
    finished_at: number | null;
    error: string | null;
  } | null;
  if (!row) return null;
  return {
    id: row.id,
    passId: row.pass_id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    status: row.status as ReasonerJob["status"],
    attempts: row.attempts,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function upsertDiagnosis(diagnosis: DiagnosisResult, rawLLMResponse: string): string {
  const db = requireDb();
  const id = `rd_${randomUUID()}`;
  const tenantId = getCurrentTenantContext().tenantId;
  db.query(`
    INSERT INTO reasoner_diagnoses
      (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json,
       suggested_actions_json, confidence, raw_llm_response, diagnosed_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    diagnosis.passId,
    diagnosis.runId,
    diagnosis.workflowId,
    diagnosis.failureClass,
    diagnosis.rootCauseHypothesis,
    JSON.stringify(diagnosis.evidence),
    JSON.stringify(diagnosis.suggestedActions),
    diagnosis.confidence,
    rawLLMResponse.slice(0, 10000),
    diagnosis.diagnosedAt,
    tenantId,
  );
  return id;
}

async function runDiagnosisJob(job: ReasonerJob): Promise<void> {
  const db = requireDb();

  db.query(`UPDATE reasoner_jobs SET status = 'running' WHERE id = ?`).run(job.id);

  const run = readBuilderRun(job.runId);
  const workflow = readBuilderWorkflow(job.workflowId);
  const passes = readBuilderPasses(job.runId);
  const pass = passes.find((p) => p.id === job.passId);

  if (!run || !workflow || !pass) {
    db.query(`UPDATE reasoner_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
      .run("run/workflow/pass not found", Date.now(), job.id);
    return;
  }

  const stdoutTail = (() => {
    try {
      const passSeq = pass.sequence ?? 1;
      const stdoutPath = join(`/var/lib/control-surface/builder-runs`, job.runId, `pass-${passSeq}-stdout.log`);
      if (!existsSync(stdoutPath)) return "";
      return readFileSync(stdoutPath, "utf8").slice(-2000);
    } catch { return ""; }
  })();

  const analytics = pass.analyticsJson
    ? JSON.parse(pass.analyticsJson) as Record<string, unknown> | null
    : null;

  const validations = readBuilderValidations(job.runId)
    .filter((v) => v.id && v.command)
    .map((v) => ({
      command: v.command ?? "",
      status: v.status ?? "unknown",
      output: v.outputTail ?? "",
    }));

  const planExcerpt = pass.nextInstruction ?? "";

  const traceSummary = pass.traceId
    ? `trace_id=${pass.traceId}, pass_sequence=${pass.sequence}`
    : "";

  const promptInput: DiagnosisPromptInput = {
    failureClass: pass.failureClass ?? "unknown",
    passAnalytics: analytics,
    stdoutTail,
    validationResults: validations,
    planExcerpt,
    traceSummary,
  };

  const prompt = buildDiagnosisPrompt(promptInput);

  let diagnosis: DiagnosisResult | null = null;
  let lastError = "";
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const messages = [{ role: "user" as const, content: prompt }];
      const response = await complete("editorial-heavy", messages, {
        temperature: 0.2,
        maxTokens: 1500,
        timeoutMs: 120_000,
        caller: "reasoner",
      });

      const content = response.choices?.[0]?.message?.content ?? "";
      const parsed = parseDiagnosisResult(content, {
        passId: job.passId,
        runId: job.runId,
        workflowId: job.workflowId,
        failureClass: pass.failureClass ?? "unknown",
      });

      if (parsed) {
        diagnosis = parsed;
        upsertDiagnosis(parsed, content);
        clusterDiagnosis(db, parsed);
        break;
      } else {
        lastError = "JSON parse failed";
      }
    } catch (err) {
      lastError = String(err);
    }
  }

  if (!diagnosis) {
    db.query(`
      UPDATE reasoner_jobs
      SET status = 'failed', attempts = ?, error = ?, finished_at = ?
      WHERE id = ?
    `).run(job.attempts + 1, lastError || "no diagnosis", Date.now(), job.id);
  } else {
    db.query(`
      UPDATE reasoner_jobs
      SET status = 'done', attempts = ?, finished_at = ?
      WHERE id = ?
    `).run(job.attempts + 1, Date.now(), job.id);
  }
}

let watcherInterval: ReturnType<typeof setInterval> | null = null;
let activeCount = 0;
const MAX_CONCURRENT = 2;
const POLL_INTERVAL_MS = 60_000;

function pollPendingJobs(): void {
  if (!isDashboardDbEnabled()) return;
  const db = getDashboardDb();
  if (!db) return;

  if (activeCount >= MAX_CONCURRENT) return;
  
  const tenantId = getCurrentTenantContext().tenantId;

  const rows = db.query(`
    SELECT id FROM reasoner_jobs
    WHERE status = 'pending' AND tenant_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(tenantId, MAX_CONCURRENT - activeCount) as Array<{ id: string }>;

  for (const row of rows) {
    const job = getJob(db, row.id);
    if (!job || job.status !== "pending") continue;

    activeCount++;
    runDiagnosisJob(job).finally(() => {
      activeCount = Math.max(0, activeCount - 1);
    });
  }
}

export function startReasonerWatcher(): void {
  if (watcherInterval) return;
  watcherInterval = setInterval(pollPendingJobs, POLL_INTERVAL_MS);
  console.log("[reasoner] watcher started");
}

export function stopReasonerWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}
