import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { createJob, finishJob, updateJobOutput, writeActionAudit } from "../db/writer.ts";
import {
  readBuilderRun,
  readBuilderRuns,
  readBuilderWorkflow,
  readBuilderWorkflows,
  readBuilderValidations,
  readBuilderPasses,
  readBuilderArtifacts,
  type BuilderRun,
  type BuilderWorkflow,
} from "./store.ts";
import { selectModelForRole, type ModelRole } from "./modelSelector.ts";
import { runDoctorReview, writeDoctorReport } from "./doctor.ts";
import { getNextRunTime, isDue, getBackoffMs } from "./scheduler.ts";

const BUILDER_RUNS_DIR = "/var/lib/control-surface/builder-runs";

function ensureRunsDir(): void {
  if (!existsSync(BUILDER_RUNS_DIR)) {
    mkdirSync(BUILDER_RUNS_DIR, { recursive: true });
  }
}

function runDir(runId: string): string {
  return join(BUILDER_RUNS_DIR, runId);
}

function tmuxSessionName(runId: string, passNumber = 1): string {
  if (passNumber === 1) return `builder-${runId.slice(0, 20)}`;
  return `builder-${runId.slice(0, 16)}-p${passNumber}`;
}

function requireDb() {
  if (!isDashboardDbEnabled()) throw new Error("DASHBOARD_DB disabled");
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard SQLite unavailable");
  return db;
}

function now(): number {
  return Date.now();
}

// ── Tmux helpers ───────────────────────────────────────────────────────────

function tmuxExists(session: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf8" });
  return result.status === 0;
}

function tmuxKill(session: string): void {
  spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf8" });
}

function tmuxSendKeys(session: string, keys: string): void {
  spawnSync("tmux", ["send-keys", "-t", session, keys], { encoding: "utf8" });
}

function tmuxCapturePane(session: string): string {
  const result = spawnSync("tmux", ["capture-pane", "-p", "-t", session], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout ?? "";
}

// ── Run helpers ────────────────────────────────────────────────────────────

function readExitCode(runId: string, passNumber = 1): number | null {
  const path = join(runDir(runId), `pass-${passNumber}-exit.code`);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8").trim();
    const code = Number.parseInt(text, 10);
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

function readLogFile(runId: string, name: string): string {
  const path = join(runDir(runId), name);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ── Phase 5: Git / Backup / Logging helpers ────────────────────────────────

function captureSnapshotPatch(workflow: BuilderWorkflow, run: BuilderRun, passId: string): void {
  const projectRoot = workflow.projectRoot;
  if (!existsSync(projectRoot)) return;

  ensureRunsDir();
  const runDirPath = runDir(run.id);
  if (!existsSync(runDirPath)) mkdirSync(runDirPath, { recursive: true });

  // Capture git diff for all changed files
  const diffResult = spawnSync("git", ["diff", "--no-color"], {
    encoding: "utf8",
    cwd: projectRoot,
    timeout: 15_000,
  });

  // Capture dirty state summary
  const statusResult = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    cwd: projectRoot,
    timeout: 10_000,
  });

  const diffText = diffResult.stdout ?? "";
  const statusText = statusResult.stdout ?? "";

  // Write patch file
  const patchPath = join(runDir(run.id), "pre-pass.patch");
  writeFileSync(patchPath, diffText, { encoding: "utf8" });

  // Write dirty state file
  const dirtyPath = join(runDir(run.id), "pre-pass-dirty.txt");
  writeFileSync(dirtyPath, statusText, { encoding: "utf8" });

  // Create patch artifact
  createBuilderArtifact({
    workflowId: workflow.id,
    runId: run.id,
    passId,
    kind: "pre-pass-patch",
    path: patchPath,
    metadata: {
      dirtyFiles: statusText.split("\n").filter(Boolean).length,
      snapshotAt: new Date().toISOString(),
      phase: "pre-pass",
    },
  });

  // Create dirty-state artifact
  if (statusText.trim()) {
    createBuilderArtifact({
      workflowId: workflow.id,
      runId: run.id,
      passId,
      kind: "pre-pass-dirty-state",
      path: dirtyPath,
      metadata: {
        snapshotAt: new Date().toISOString(),
        phase: "pre-pass",
      },
    });
  }
}

function runBackup(workflow: BuilderWorkflow, run: BuilderRun, passId: string): void {
  const projectRoot = workflow.projectRoot;
  if (!existsSync(projectRoot)) return;

  const backupDir = "/var/lib/control-surface/builder-backups";
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${run.id}-${ts}.tar.gz`);

  // Exclude .git, node_modules, dist, .next, builder-runs
  const excludeFlags = [
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=.next",
    "--exclude=*.pyc",
    "--exclude=__pycache__",
    "--exclude=builder-runs",
  ];
  const excludeArgs = excludeFlags.flatMap((f) => f.split(" "));
  // flatten properly
  const flatExclude: string[] = [];
  for (const f of excludeFlags) flatExclude.push(...f.split(" "));

  const tarResult = spawnSync("tar", [
    "-czf", backupPath,
    "-C", projectRoot,
    ".",
    ...flatExclude,
  ], { encoding: "utf8", timeout: 120_000 });

  if (tarResult.status === 0 && existsSync(backupPath)) {
    createBuilderArtifact({
      workflowId: workflow.id,
      runId: run.id,
      passId,
      kind: "backup",
      path: backupPath,
      metadata: {
        projectRoot,
        createdAt: new Date().toISOString(),
        phase: "pre-pass",
        sizeBytes: existsSync(backupPath) ? readFileSync(backupPath).byteLength : 0,
      },
    });
  }
}

function commitChanges(workflow: BuilderWorkflow, run: BuilderRun): { commitHash: string | null; message: string } {
  const projectRoot = workflow.projectRoot;
  const message = `Builder: ${workflow.name} pass 1 (automated)\n\nWorkflow: ${workflow.id}\nRun: ${run.id}\nTimestamp: ${new Date().toISOString()}`;

  try {
    if (!existsSync(join(projectRoot, ".git"))) {
      return { commitHash: null, message: "no git repo" };
    }

    // git add -A
    const addResult = spawnSync("git", ["add", "-A"], { encoding: "utf8", cwd: projectRoot, timeout: 30_000 });
    if (addResult.status !== 0) {
      return { commitHash: null, message: `git add failed: ${addResult.stderr}` };
    }

    // Check if anything is staged
    const diffResult = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8", cwd: projectRoot, timeout: 10_000 });
    if (!diffResult.stdout?.trim()) {
      return { commitHash: null, message: "nothing to commit" };
    }

    // git commit
    const commitResult = spawnSync("git", ["commit", "-m", message], {
      encoding: "utf8",
      cwd: projectRoot,
      timeout: 30_000,
      env: { ...process.env, GIT_AUTHOR_NAME: "Builder Pipeline", GIT_AUTHOR_EMAIL: "builder@localhost" },
    });

    if (commitResult.status !== 0) {
      return { commitHash: null, message: `git commit failed: ${commitResult.stderr}` };
    }

    const hashResult = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: projectRoot, timeout: 10_000 });
    const commitHash = hashResult.stdout?.trim() ?? null;

    // Write commit artifact
    const commitInfoPath = join(runDir(run.id), "commit-info.txt");
    writeFileSync(commitInfoPath, `commit: ${commitHash}\nworkflow: ${workflow.name}\nrun: ${run.id}\nmessage: ${message}`, { encoding: "utf8" });

    createBuilderArtifact({
      workflowId: workflow.id,
      runId: run.id,
      passId: null,
      kind: "git-commit",
      path: commitInfoPath,
      metadata: { commitHash, workflowName: workflow.name, runId: run.id },
    });

    return { commitHash, message: "committed" };
  } catch (e) {
    return { commitHash: null, message: e instanceof Error ? e.message : String(e) };
  }
}

function pushChanges(workflow: BuilderWorkflow, run: BuilderRun): string {
  const projectRoot = workflow.projectRoot;
  const pushPolicy = workflow.config.gitPolicy.push;

  if (pushPolicy === "never") return "push disabled by policy";

  try {
    if (!existsSync(join(projectRoot, ".git"))) {
      return "no git repo";
    }

    if (pushPolicy === "current-branch") {
      const pushResult = spawnSync("git", ["push"], { encoding: "utf8", cwd: projectRoot, timeout: 60_000 });
      if (pushResult.status !== 0) {
        return `git push failed: ${pushResult.stderr?.slice(0, 500)}`;
      }
      return "pushed to current-branch";
    }

    if (pushPolicy === "workflow-branch") {
      const branchName = `builder/${workflow.id.slice(0, 16)}/${run.id.slice(0, 16)}`;
      const pushResult = spawnSync("git", ["push", "origin", `HEAD:refs/heads/${branchName}`, "-u"], {
        encoding: "utf8",
        cwd: projectRoot,
        timeout: 60_000,
      });
      if (pushResult.status !== 0) {
        return `git push to workflow branch failed: ${pushResult.stderr?.slice(0, 500)}`;
      }
      return `pushed to workflow branch: ${branchName}`;
    }

    return "unknown push policy";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function logToVault(workflow: BuilderWorkflow, run: BuilderRun, passId: string | null, runStatus: string): void {
  const ts = new Date().toISOString();
  const vaultDate = ts.slice(0, 10); // YYYY-MM-DD

  // Build summary lines
  const summaryLines: string[] = [
    `## Builder run: ${workflow.name}`,
    `**Status**: ${runStatus}`,
    `**Workflow**: ${workflow.id}`,
    `**Run**: ${run.id}`,
    `**Trigger**: ${run.trigger}`,
    `**Pass**: ${passId ?? "-"}`,
    `**Started**: ${run.startedAt ? new Date(run.startedAt).toISOString() : "-"}`,
    `**Finished**: ${run.finishedAt ? new Date(run.finishedAt).toISOString() : "-"}`,
    `**Agent**: ${workflow.config.agentOrder[0] ?? "unknown"}`,
    `**Model**: ${workflow.config.modelPolicy.builder ?? "-"}`,
    `**Plan**: ${workflow.planFile}`,
    `**Project**: ${workflow.projectRoot}`,
    "",
  ];

  const vaultEntry = summaryLines.join("\n");

  // Write to AI Vault daily note
  const vaultPath = `/opt/ai-vault/daily/${vaultDate}.md`;
  try {
    const existing = existsSync(vaultPath) ? readFileSync(vaultPath, "utf8") : "";
    const marker = `## Builder Runs`;
    if (existing.includes(marker)) {
      const parts = existing.split(marker);
      const after = parts[1] ?? "";
      const restParts = after.split("---");
      const rest = restParts.slice(1).join("---");
      writeFileSync(vaultPath, `${parts[0]}${marker}\n\n${vaultEntry}\n---${rest}`, { encoding: "utf8" });
    } else {
      const separator = existing.trim() ? "\n\n---\n\n" : "";
      writeFileSync(vaultPath, existing + separator + `## Builder Runs\n\n${vaultEntry}`, { encoding: "utf8" });
    }
  } catch (e) {
    console.error("[builder] vault log write failed:", e);
  }

  // Write to project plan file if it exists
  if (workflow.planFile && existsSync(workflow.planFile)) {
    try {
      const planContent = readFileSync(workflow.planFile, "utf8");
      const runMarker = `## Builder Run ${run.id.slice(0, 8)}`;
      if (!planContent.includes(runMarker)) {
        const timestamp = new Date().toISOString();
        const entry = `\n\n---\n${runMarker}\n- **Status**: ${runStatus}\n- **Trigger**: ${run.trigger}\n- **Finished**: ${timestamp}\n- **Artifact**: /var/lib/control-surface/builder-runs/${run.id}/\n`;
        writeFileSync(workflow.planFile, planContent + entry, { encoding: "utf8" });
      }
    } catch (e) {
      console.error("[builder] plan log write failed:", e);
    }
  }
}

// ── Phase 6: Auto-Continue and Context Handoff ─────────────────────────────

function buildContinuationContext(workflow: BuilderWorkflow, run: BuilderRun, nextSequence: number): string {
  const projectRoot = workflow.projectRoot;
  const prevPasses = readBuilderPasses(run.id).filter((p) => p.sequence < nextSequence);

  const lines: string[] = [
    `=== Builder Pipeline: Pass ${nextSequence} Continuation Context ===`,
    `Workflow: ${workflow.name}`,
    `Plan: ${workflow.planFile}`,
    `Project: ${projectRoot}`,
    `Previous passes: ${prevPasses.length}`,
    "",
  ];

  for (const pass of prevPasses.sort((a, b) => a.sequence - b.sequence)) {
    const artifacts = readBuilderArtifacts(run.id).filter((a) => a.passId === pass.id);
    const validations = readBuilderValidations(run.id).filter((v) => v.passId === pass.id);

    lines.push(`--- Pass ${pass.sequence} (${pass.agent ?? "?"}, ${pass.status}) ---`);
    if (pass.summary) {
      lines.push(`Summary: ${pass.summary.slice(0, 500)}`);
    }
    const stdoutArtifact = artifacts.find((a) => a.kind === "stdout");
    if (stdoutArtifact && existsSync(stdoutArtifact.path)) {
      try {
        const content = readFileSync(stdoutArtifact.path, "utf8").slice(-2000);
        if (content) lines.push(`Last stdout (2KB): ${content.slice(-1500)}`);
      } catch { /* ignore */ }
    }
    const validationResults = validations.map((v) => `${v.kind}:${v.status}`).join(", ");
    if (validationResults) lines.push(`Validations: ${validationResults}`);
    lines.push("");
  }

  lines.push("--- Plan File Reminder ---");
  if (existsSync(workflow.planFile)) {
    try {
      const planContent = readFileSync(workflow.planFile, "utf8");
      const phaseMatch = planContent.match(/## (Phase \d+[^\n]*)/g);
      if (phaseMatch) {
        lines.push(`Plan phases found: ${phaseMatch.join(" | ")}`);
      }
      lines.push(`Full plan at: ${workflow.planFile}`);
    } catch { /* ignore */ }
  } else {
    lines.push(`Plan file not found at: ${workflow.planFile}`);
  }

  lines.push("");
  lines.push("=== Instructions ===");
  lines.push("Continue developing the project from where the previous pass left off.");
  lines.push("Review the plan file and prior pass summaries to understand what remains.");
  lines.push("Run validation commands after changes.");
  lines.push("Report: changed files, test results, what was accomplished, what still needs work.");

  return lines.join("\n");
}

async function startNextPass(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  nextSequence: number,
): Promise<void> {
  const agent = workflow.config.agentOrder[(nextSequence - 1) % workflow.config.agentOrder.length] ?? "codex";

  const role: ModelRole = nextSequence === 1 ? "planner" : nextSequence === 2 ? "builder" : "reviewer";
  const selection = selectModelForRole(role, workflow.config, agent);
  const { model, provider, reason: modelReason } = selection;

  const phase = nextSequence === 1 ? "plan" : nextSequence === 2 ? "implement" : "review";

  const passId = createBuilderPass({
    runId: run.id,
    workflowId: workflow.id,
    sequence: nextSequence,
    phase,
    agent,
    model,
    modelReason,
    provider,
  });

  updateBuilderRun(run.id, { currentPassId: passId });

  // Pre-pass snapshot for this pass
  captureSnapshotPatch(workflow, run, passId);
  if (workflow.config.backupPolicy.enabled && workflow.config.backupPolicy.beforeRun) {
    runBackup(workflow, run, passId);
  }

  // Build continuation context
  const continuationContext = buildContinuationContext(workflow, run, nextSequence);
  const scriptPath = writePassScript(run.id, workflow, agent, model, nextSequence, continuationContext);

  const jobId = `job_${randomUUID()}`;
  createJob({
    id: jobId,
    kind: "builder.agent-pass",
    status: "running",
    actor: "builder",
    reason: `builder workflow ${workflow.name} pass ${nextSequence}`,
    targetType: "builder-run",
    targetId: run.id,
    command: scriptPath,
    request: { workflowId: workflow.id, runId: run.id, passId, agent, model, continuation: true },
    evidence: { planFile: workflow.planFile, projectRoot: workflow.projectRoot, passNumber: nextSequence },
  });

  updateBuilderPass(passId, { jobIds: [jobId] });

  const scriptArtifact = createBuilderArtifact({ workflowId: workflow.id, runId: run.id, passId, kind: "command-script", path: scriptPath });
  const stdoutArtifact = createBuilderArtifact({ workflowId: workflow.id, runId: run.id, passId, kind: "stdout", path: join(runDir(run.id), `pass-${nextSequence}-stdout.log`) });
  const stderrArtifact = createBuilderArtifact({ workflowId: workflow.id, runId: run.id, passId, kind: "stderr", path: join(runDir(run.id), `pass-${nextSequence}-stderr.log`) });
  updateBuilderPass(passId, { artifactIds: [scriptArtifact, stdoutArtifact, stderrArtifact] });

  const session = tmuxSessionName(`${run.id}-p${nextSequence}`);
  const spawnResult = spawnSync("tmux", ["new-session", "-d", "-s", session, "-c", workflow.projectRoot, scriptPath], { encoding: "utf8" });
  if (spawnResult.status !== 0) {
    const error = spawnResult.stderr || `tmux spawn failed (exit ${spawnResult.status})`;
    updateBuilderPass(passId, { status: "failed", finishedAt: now(), error });
    throw new Error(error);
  }
}

// ── Builder run / pass / artifact writers ──────────────────────────────────

export function createBuilderRun(workflowId: string, trigger: string, actor = "operator"): BuilderRun {
  const db = requireDb();
  const id = `br_${randomUUID()}`;
  const ts = now();

  db.query(`
    INSERT INTO builder_runs
      (id, workflow_id, trigger, status, started_at, finished_at, current_pass_id,
       stop_requested_at, stop_requested_by, result_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    workflowId,
    trigger,
    "running",
    ts,
    null,
    null,
    null,
    null,
    null,
    null,
  );

  const run = readBuilderRun(id);
  if (!run) throw new Error("created run could not be read");

  // Update workflow lastRunId and status
  db.query(`
    UPDATE builder_workflows
    SET last_run_id = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(id, "running", ts, workflowId);

  return run;
}

export function updateBuilderRun(
  runId: string,
  updates: {
    status?: string;
    currentPassId?: string | null;
    finishedAt?: number | null;
    error?: string | null;
    result?: unknown;
  },
): void {
  const db = requireDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.currentPassId !== undefined) {
    sets.push("current_pass_id = ?");
    params.push(updates.currentPassId);
  }
  if (updates.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    params.push(updates.finishedAt);
  }
  if (updates.error !== undefined) {
    sets.push("error = ?");
    params.push(updates.error);
  }
  if (updates.result !== undefined) {
    sets.push("result_json = ?");
    params.push(JSON.stringify(updates.result));
  }

  if (sets.length === 0) return;
  params.push(runId);

  db.query(`UPDATE builder_runs SET ${sets.join(", ")} WHERE id = ?`).run(...(params as (string | number | null)[]));
}

export function createBuilderPass(input: {
  runId: string;
  workflowId: string;
  sequence: number;
  phase: string;
  agent: string | null;
  model: string | null;
  modelReason?: string | null;
  provider: string | null;
}): string {
  const db = requireDb();
  const id = `bp_${randomUUID()}`;
  const ts = now();

  db.query(`
    INSERT INTO builder_passes
      (id, run_id, workflow_id, sequence, phase, status, agent, provider, model,
       model_reason, started_at, finished_at, job_ids_json, validation_ids_json, artifact_ids_json,
       summary, next_instruction, failure_class, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.runId,
    input.workflowId,
    input.sequence,
    input.phase,
    "running",
    input.agent,
    input.provider,
    input.model,
    input.modelReason ?? null,
    ts,
    null,
    "[]",
    "[]",
    "[]",
    null,
    null,
    null,
    null,
  );

  return id;
}

export function updateBuilderPass(
  passId: string,
  updates: {
    status?: string;
    finishedAt?: number | null;
    summary?: string | null;
    failureClass?: string | null;
    error?: string | null;
    modelReason?: string | null;
    jobIds?: string[];
    artifactIds?: string[];
    validationIds?: string[];
  },
): void {
  const db = requireDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    params.push(updates.finishedAt);
  }
  if (updates.summary !== undefined) {
    sets.push("summary = ?");
    params.push(updates.summary);
  }
  if (updates.failureClass !== undefined) {
    sets.push("failure_class = ?");
    params.push(updates.failureClass);
  }
  if (updates.error !== undefined) {
    sets.push("error = ?");
    params.push(updates.error);
  }
  if (updates.modelReason !== undefined) {
    sets.push("model_reason = ?");
    params.push(updates.modelReason);
  }
  if (updates.jobIds !== undefined) {
    sets.push("job_ids_json = ?");
    params.push(JSON.stringify(updates.jobIds));
  }
  if (updates.artifactIds !== undefined) {
    sets.push("artifact_ids_json = ?");
    params.push(JSON.stringify(updates.artifactIds));
  }
  if (updates.validationIds !== undefined) {
    sets.push("validation_ids_json = ?");
    params.push(JSON.stringify(updates.validationIds));
  }

  if (sets.length === 0) return;
  params.push(passId);

  db.query(`UPDATE builder_passes SET ${sets.join(", ")} WHERE id = ?`).run(...(params as (string | number | null)[]));
}

export function createBuilderArtifact(input: {
  workflowId: string;
  runId: string;
  passId?: string | null;
  kind: string;
  path: string;
  sha256?: string | null;
  metadata?: unknown;
}): string {
  const db = requireDb();
  const id = `ba_${randomUUID()}`;
  const ts = now();

  db.query(`
    INSERT INTO builder_artifacts
      (id, workflow_id, run_id, pass_id, kind, path, sha256, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.workflowId,
    input.runId,
    input.passId ?? null,
    input.kind,
    input.path,
    input.sha256 ?? null,
    ts,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );

  return id;
}

export function updateBuilderWorkflowStatus(workflowId: string, status: string): void {
  const db = requireDb();
  db.query(`UPDATE builder_workflows SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    now(),
    workflowId,
  );
}

// ── Lock helpers ───────────────────────────────────────────────────────────

function acquireProjectLock(projectRoot: string, workflowId: string, runId: string, holder: string): boolean {
  const db = requireDb();
  const ts = now();
  const expires = ts + 24 * 60 * 60 * 1000; // 24h

  try {
    db.query(`
      INSERT INTO builder_locks (project_root, workflow_id, run_id, acquired_at, expires_at, holder)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectRoot, workflowId, runId, ts, expires, holder);
    return true;
  } catch {
    // Conflict means already locked
    return false;
  }
}

function releaseProjectLock(projectRoot: string): void {
  const db = requireDb();
  db.query(`DELETE FROM builder_locks WHERE project_root = ?`).run(projectRoot);
}

// ── Command builder ──────────────────────────────────────────────────────────

function buildCodexPrompt(workflow: BuilderWorkflow, continuationContext?: string): string {
  const { planFile, projectRoot } = workflow;
  let base = `Continue developing the project according to the plan at ${planFile}. Project root: ${projectRoot}. Use relevant skills. Run validation commands after changes. Report changed files, test results, and next steps.`;
  if (continuationContext) {
    base = `${continuationContext}\n\n${base}`;
  }
  return base;
}

function writePassScript(
  runId: string,
  workflow: BuilderWorkflow,
  agent: string,
  model: string | null,
  passNumber = 1,
  continuationContext?: string,
): string {
  ensureRunsDir();
  const dir = runDir(runId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const scriptPath = join(dir, `pass-${passNumber}.sh`);
  const prompt = buildCodexPrompt(workflow, continuationContext);

  let stdoutLog = `pass-${passNumber}-stdout.log`;
  let command: string;
  if (agent === "codex") {
    const modelFlag = model ? `--model ${model} ` : "";
    command = `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never ${modelFlag}-o "${dir}/codex-output.txt" -C "${workflow.projectRoot}" "${prompt.replace(/"/g, '\\"')}"`;
  } else if (agent === "claude") {
    command = `claude --permission-mode dontAsk -d "${workflow.projectRoot}" "${prompt.replace(/"/g, '\\"')}"`;
  } else if (agent === "opencode") {
    command = `opencode run --project "${workflow.projectRoot}" "${prompt.replace(/"/g, '\\"')}"`;
  } else {
    command = `echo "Unsupported builder agent: ${agent}"`;
  }

  const continuationBlock = continuationContext
    ? `\n# Continuation context written to file\nCONTEXT_FILE="${dir}/continuation-${passNumber}.txt"\necho -e "${continuationContext.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" > "$CONTEXT_FILE"\necho "[builder] Continuation context written to $CONTEXT_FILE" >> "$BUILDER_DIR/${stdoutLog}"\n`
    : "";

  const script = `#!/bin/bash
set -euo pipefail
BUILDER_DIR="${dir}"
RUN_ID="${runId}"
echo "[builder] Pass ${passNumber} starting at $(date -Iseconds)" | tee "$BUILDER_DIR/${stdoutLog}"
echo "[builder] Agent: ${agent}, Model: ${model ?? "default"}" >> "$BUILDER_DIR/${stdoutLog}"
echo "[builder] Project: ${workflow.projectRoot}" >> "$BUILDER_DIR/${stdoutLog}"
echo "[builder] Plan: ${workflow.planFile}" >> "$BUILDER_DIR/${stdoutLog}"
${continuationBlock}${command} >> "$BUILDER_DIR/${stdoutLog}" 2>> "$BUILDER_DIR/pass-${passNumber}-stderr.log"
EXIT_CODE=$?
echo "$EXIT_CODE" > "$BUILDER_DIR/pass-${passNumber}-exit.code"
echo "[builder] Pass ${passNumber} finished with exit code $EXIT_CODE at $(date -Iseconds)" >> "$BUILDER_DIR/${stdoutLog}"
`;

  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

// ── Runner API ───────────────────────────────────────────────────────────────

export async function startWorkflowRun(
  workflowId: string,
  trigger: string,
  actor = "operator",
): Promise<BuilderRun> {
  const workflow = readBuilderWorkflow(workflowId);
  if (!workflow) throw new Error("workflow not found");
  if (workflow.status !== "ready" && workflow.status !== "running" && workflow.status !== "paused") {
    throw new Error(`workflow cannot be started from status ${workflow.status}`);
  }

  // Determine agent/model
  const agent = workflow.config.agentOrder[0] ?? "codex";
  const selection = selectModelForRole("planner", workflow.config, agent);
  const { model, provider, reason: modelReason } = selection;

  // Create run
  const run = createBuilderRun(workflowId, trigger, actor);

  // Acquire lock
  if (!acquireProjectLock(workflow.projectRoot, workflowId, run.id, actor)) {
    // Rollback run
    updateBuilderRun(run.id, { status: "failed", finishedAt: now(), error: "project locked by another run" });
    updateBuilderWorkflowStatus(workflowId, "blocked");
    throw new Error("project is locked by another run");
  }

  // Create pass - doctor mode uses "doctor" phase instead of "plan"
  const phase = workflow.mode === "doctor" ? "doctor" : "plan";
  const passId = createBuilderPass({
    runId: run.id,
    workflowId,
    sequence: 1,
    phase,
    agent,
    model,
    modelReason,
    provider,
  });

  // Update run with current pass
  updateBuilderRun(run.id, { currentPassId: passId });

  // Phase 5: pre-pass snapshot and backup
  captureSnapshotPatch(workflow, run, passId);
  if (workflow.config.backupPolicy.enabled && workflow.config.backupPolicy.beforeRun) {
    runBackup(workflow, run, passId);
  }

  // Create job
  const jobId = `job_${randomUUID()}`;
  const scriptPath = writePassScript(run.id, workflow, agent, model);
  createJob({
    id: jobId,
    kind: "builder.agent-pass",
    status: "running",
    actor,
    reason: `builder workflow ${workflow.name} pass 1`,
    targetType: "builder-run",
    targetId: run.id,
    command: scriptPath,
    request: { workflowId, runId: run.id, passId, agent, model },
    evidence: { planFile: workflow.planFile, projectRoot: workflow.projectRoot },
  });

  // Link job to pass
  updateBuilderPass(passId, { jobIds: [jobId] });

  // Create artifacts for script and expected outputs
  const scriptArtifact = createBuilderArtifact({
    workflowId,
    runId: run.id,
    passId,
    kind: "command-script",
    path: scriptPath,
  });
  const stdoutArtifact = createBuilderArtifact({
    workflowId,
    runId: run.id,
    passId,
    kind: "stdout",
    path: join(runDir(run.id), "pass-1-stdout.log"),
  });
  const stderrArtifact = createBuilderArtifact({
    workflowId,
    runId: run.id,
    passId,
    kind: "stderr",
    path: join(runDir(run.id), "pass-1-stderr.log"),
  });
  updateBuilderPass(passId, { artifactIds: [scriptArtifact, stdoutArtifact, stderrArtifact] });

  // Spawn tmux
  const session = tmuxSessionName(run.id, 1);
  const spawnResult = spawnSync("tmux", ["new-session", "-d", "-s", session, "-c", workflow.projectRoot, scriptPath], {
    encoding: "utf8",
  });

  if (spawnResult.status !== 0) {
    const error = spawnResult.stderr || `tmux spawn failed (exit ${spawnResult.status})`;
    updateBuilderPass(passId, { status: "failed", finishedAt: now(), error });
    updateBuilderRun(run.id, { status: "failed", finishedAt: now(), error, currentPassId: null });
    finishJob(jobId, "failed", { error });
    releaseProjectLock(workflow.projectRoot);
    updateBuilderWorkflowStatus(workflowId, "failed");
    throw new Error(error);
  }

  return readBuilderRun(run.id)!;
}

export async function stopWorkflowRun(
  runId: string,
  actor = "operator",
): Promise<void> {
  const run = readBuilderRun(runId);
  if (!run) throw new Error("run not found");

  // Kill tmux sessions for all passes (pass 1 and beyond)
  const passes = readBuilderPasses(runId);
  for (const pass of passes) {
    const session = tmuxSessionName(runId, pass.sequence);
    if (tmuxExists(session)) {
      tmuxKill(session);
    }
  }

  const ts = now();
  const passId = run.currentPassId;
  if (passId) {
    updateBuilderPass(passId, { status: "canceled", finishedAt: ts });
  }

  updateBuilderRun(runId, { status: "canceled", finishedAt: ts, currentPassId: null });

  // Update jobs linked to this run
  const db = requireDb();
  db.query(`UPDATE jobs SET state = ?, status = ?, finished_at = ? WHERE target_type = ? AND target_id = ? AND state = ?`).run(
    "canceled", "canceled", ts, "builder-run", runId, "running",
  );

  const workflow = readBuilderWorkflow(run.workflowId);
  if (workflow) {
    releaseProjectLock(workflow.projectRoot);
    updateBuilderWorkflowStatus(run.workflowId, "ready");
  }
}

export async function pauseWorkflow(workflowId: string): Promise<void> {
  const workflow = readBuilderWorkflow(workflowId);
  if (!workflow) throw new Error("workflow not found");
  if (workflow.status !== "running" && workflow.status !== "ready") {
    throw new Error(`workflow cannot be paused from status ${workflow.status}`);
  }
  if (workflow.mode === "scheduled") {
    const db = requireDb();
    db.query(`UPDATE builder_workflows SET next_run_at = NULL, status = 'paused' WHERE id = ?`).run(workflowId);
  } else {
    updateBuilderWorkflowStatus(workflowId, "paused");
  }
}

export async function resumeWorkflow(workflowId: string): Promise<void> {
  const workflow = readBuilderWorkflow(workflowId);
  if (!workflow) throw new Error("workflow not found");
  if (workflow.status !== "paused" && workflow.status !== "blocked") {
    throw new Error(`workflow cannot be resumed from status ${workflow.status}`);
  }
  if (workflow.mode === "scheduled" && workflow.config.schedule?.expression) {
    const next = getNextRunTime(
      workflow.config.schedule.expression,
      workflow.config.schedule.timezone ?? "UTC"
    );
    const db = requireDb();
    db.query(`UPDATE builder_workflows SET status = 'ready', next_run_at = ? WHERE id = ?`).run(next, workflowId);
  } else {
    updateBuilderWorkflowStatus(workflowId, "ready");
  }
}

export async function retryRun(runId: string, actor = "operator"): Promise<BuilderRun> {
  const run = readBuilderRun(runId);
  if (!run) throw new Error("run not found");
  return startWorkflowRun(run.workflowId, "retry", actor);
}

export async function cancelRun(runId: string, actor = "operator"): Promise<void> {
  await stopWorkflowRun(runId, actor);
}

// ── Status reconciliation ──────────────────────────────────────────────────

export async function reconcileRunStatus(runId: string): Promise<BuilderRun | null> {
  const run = readBuilderRun(runId);
  if (!run || run.status !== "running") return run;

  // Look up current pass to get its sequence number
  const passId = run.currentPassId;
  const allPasses = passId ? readBuilderPasses(runId) : [];
  const currentPass = allPasses.find((p) => p.id === passId);
  const passSeq = currentPass?.sequence ?? 1;

  const session = tmuxSessionName(runId, passSeq);
  if (tmuxExists(session)) {
    const paneOutput = tmuxCapturePane(session);
    if (paneOutput) {
      updateJobOutputForRun(runId, paneOutput);
    }
    return run;
  }

  // Tmux session is gone — process finished
  const exitCode = readExitCode(runId, passSeq);
  const ts = now();

  // Capture final output using pass-specific filenames
  const stdout = readLogFile(runId, `pass-${passSeq}-stdout.log`);
  const stderr = readLogFile(runId, `pass-${passSeq}-stderr.log`);
  const codexOutput = readLogFile(runId, "codex-output.txt");

  if (passId) {
    const passStatus = exitCode === 0 ? "success" : "failed";
    const summary = codexOutput || stdout.slice(-2000);
    const failureClass = exitCode === null ? "unknown" : exitCode === 0 ? null : "unknown";
    updateBuilderPass(passId, {
      status: passStatus,
      finishedAt: ts,
      summary: summary || null,
      failureClass,
    });
  }

  // Run validation commands if pass succeeded
  const workflow = readBuilderWorkflow(run.workflowId);
  let validationIds: string[] = [];
  if (passId && workflow) {
    try {
      validationIds = await runValidationCommands(workflow, run, passId, workflow.projectRoot);
      updateBuilderPass(passId, { validationIds });
    } catch (err) {
      console.error("[builder] validation run failed:", err);
    }
  }

  // Validation gate: a pass with validation commands configured must have evidence
  const profile = workflow?.config.validationProfile;
  const hasValidationConfig = Boolean(
    profile &&
    (
      (profile.internal?.length ?? 0) > 0 ||
      (profile.runtime?.length ?? 0) > 0 ||
      (profile.public?.length ?? 0) > 0 ||
      (profile.commands?.length ?? 0) > 0
    )
  );
  const allValidationsPassed = validationIds.length > 0 && validationIds.every((vid) => {
    const vs = readBuilderValidations(runId).find((v) => v.id === vid);
    return vs && vs.status === "success";
  });

  let runStatus: "success" | "failed" = "failed";
  if (exitCode === 0) {
    runStatus = !hasValidationConfig || allValidationsPassed ? "success" : "failed";
  }

  updateBuilderRun(runId, {
    status: runStatus,
    finishedAt: ts,
    currentPassId: null,
    error: stderr ? stderr.slice(-2000) : null,
  });

  // Finish jobs
  const db = requireDb();
  db.query(`
    UPDATE jobs
    SET state = ?, status = ?, finished_at = ?, output_tail = COALESCE(?, output_tail), error = ?, exit_code = ?
    WHERE target_type = ? AND target_id = ? AND state = ?
  `).run(
    runStatus,
    runStatus,
    ts,
    stdout ? stdout.slice(-8000) : null,
    stderr ? stderr.slice(-2000) : null,
    exitCode,
    "builder-run",
    runId,
    "running",
  );

  // Check if we should continue to next pass before releasing lock
  const AUTO_CONTINUE_MODES = new Set(["auto-continue", "scheduled", "permanent"]);
  const shouldContinue = Boolean(
    workflow &&
    runStatus === "success" &&
    AUTO_CONTINUE_MODES.has(workflow.mode) &&
    passSeq < workflow.config.riskPolicy.maxPasses,
  );

  // Doctor mode: run doctor review after successful pass, but do NOT auto-continue
  if (workflow && runStatus === "success" && workflow.mode === "doctor" && passId) {
    try {
      const doctorReport = await runDoctorReview(workflow, run.id, passId);
      writeDoctorReport(doctorReport);
      updateBuilderRun(run.id, {
        result: { ...(run.result as object || {}), doctorReportId: doctorReport.id, doctorReport: doctorReport },
      });
      console.log(`[builder] doctor review completed for run ${run.id}, score: ${doctorReport.overallScore}`);
    } catch (err) {
      console.error("[builder] doctor review failed:", err);
    }
  }

  // Release lock only if we're not continuing to another pass
  if (workflow) {
    if (!shouldContinue) {
      releaseProjectLock(workflow.projectRoot);
      updateBuilderWorkflowStatus(run.workflowId, runStatus === "success" ? "done" : "failed");

      if (workflow.mode === "permanent" && workflow.status === "ready" && run.finishedAt) {
        const resultObj = run.result as { attemptCount?: number } | null;
        const attemptCount = resultObj?.attemptCount ?? 0;
        const backoffMs = getBackoffMs(attemptCount);
        const nextAttemptAt = run.finishedAt + backoffMs;
        if (Date.now() >= nextAttemptAt) {
          try {
            await startWorkflowRun(workflow.id, "permanent");
            updateBuilderRun(run.id, {
              result: { ...resultObj, attemptCount: attemptCount + 1 },
            });
          } catch (e) {
            console.error(`[builder-permanent] restart ${workflow.id} failed`, e);
          }
        }
      }
    }
  }

  // Phase 5: commit / push / vault-log
  if (workflow) {
    try {
      if (runStatus === "success" && workflow.config.gitPolicy.commit === "after-validation") {
        const { commitHash, message: commitMsg } = commitChanges(workflow, run);
        if (commitHash) {
          writeActionAudit({
            actionKind: "builder.commit",
            actionId: `builder-commit:${run.id}-p${passSeq}`,
            targetType: "builder-run",
            targetId: run.id,
            risk: "medium",
            result: `committed ${commitHash.slice(0, 8)}`,
            resultStatus: "success",
            evidence: [{ label: "commit", kind: "git", ref: commitHash }],
          });
          const pushMsg = pushChanges(workflow, run);
          writeActionAudit({
            actionKind: "builder.push",
            actionId: `builder-push:${run.id}-p${passSeq}`,
            targetType: "builder-run",
            targetId: run.id,
            risk: workflow.config.gitPolicy.push === "current-branch" ? "high" : "medium",
            result: pushMsg,
            resultStatus: "success",
          });
          console.log(`[builder] commit ${commitHash.slice(0, 8)} pushed: ${pushMsg}`);
        } else {
          console.log(`[builder] commit skipped: ${commitMsg}`);
        }
      }
    } catch (e) {
      console.error("[builder] commit/push failed:", e);
    }

    // Always log to vault regardless of run status
    logToVault(workflow, run, passId ?? null, runStatus);
  }

  // Phase 6: start next pass if conditions are met
  if (shouldContinue && workflow) {
    try {
      await startNextPass(workflow, run, passSeq + 1);
      console.log(`[builder] started pass ${passSeq + 1} for run ${run.id}`);
    } catch (e) {
      console.error(`[builder] startNextPass failed:`, e);
      // Release lock and mark failed if we can't start the next pass
      releaseProjectLock(workflow.projectRoot);
      updateBuilderWorkflowStatus(run.workflowId, "failed");
    }
  }

  return readBuilderRun(runId);
}

function updateJobOutputForRun(runId: string, output: string): void {
  const db = requireDb();
  try {
    db.query(`UPDATE jobs SET output_tail = ? WHERE target_type = ? AND target_id = ? AND state = ?`).run(
      output.slice(-8000),
      "builder-run",
      runId,
      "running",
    );
  } catch {
    // ignore
  }
}

// ── Validation runner ─────────────────────────────────────────────────────────

function createValidationRow(input: {
  workflowId: string;
  runId: string;
  passId: string | null;
  kind: string;
  status: string;
  command: string | null;
  url: string | null;
  startedAt: number;
  finishedAt: number;
  outputTail: string | null;
  artifactId: string | null;
  error: string | null;
}): string {
  const db = requireDb();
  const id = `bv_${randomUUID()}`;
  db.query(`
    INSERT INTO builder_validations
      (id, workflow_id, run_id, pass_id, kind, status, command, url,
       started_at, finished_at, output_tail, artifact_id, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.workflowId,
    input.runId,
    input.passId,
    input.kind,
    input.status,
    input.command,
    input.url,
    input.startedAt,
    input.finishedAt,
    input.outputTail,
    input.artifactId,
    input.error,
  );
  return id;
}

async function runValidationCommands(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  passId: string,
  projectRoot: string,
): Promise<string[]> {
  const profile = workflow.config.validationProfile;
  const internalCmds = profile.internal.length > 0 ? profile.internal : profile.commands;
  const validationIds: string[] = [];

  const phase1 = await runInternalValidation(workflow, run, passId, projectRoot, internalCmds);
  validationIds.push(...phase1);

  const phase2 = await runRuntimeValidation(workflow, run, passId, projectRoot, profile.runtime, profile.internalUrl);
  validationIds.push(...phase2);

  const phase3 = await runPublicValidation(workflow, run, passId, projectRoot, profile.public, profile.publicUrl, profile.playwright);
  validationIds.push(...phase3);

  return validationIds;
}

async function runInternalValidation(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  passId: string,
  projectRoot: string,
  commands: string[],
): Promise<string[]> {
  const validationIds: string[] = [];

  for (const command of commands) {
    const vStarted = Date.now();
    let outputTail = "";
    let error: string | null = null;
    let status = "failed";

    try {
      const workDir = existsSync(projectRoot) ? projectRoot : "/tmp";
      const result = spawnSync("/bin/bash", ["-c", command], {
        encoding: "utf8",
        timeout: 120_000,
        cwd: workDir,
        env: { ...process.env, BUILDER_RUN_ID: run.id },
      });
      outputTail = (result.stdout ?? "").slice(-4000);
      if (result.stderr) {
        outputTail += "\n" + result.stderr.slice(-2000);
      }
      if (result.status === 0) {
        status = "success";
      } else if (result.status === null) {
        error = "validation timed out after 120s";
        status = "timeout";
      } else {
        error = `exit code ${result.status}`;
        status = "failed";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = "error";
    }

    const vFinished = Date.now();
    const vid = createValidationRow({
      workflowId: workflow.id,
      runId: run.id,
      passId,
      kind: "command",
      status,
      command,
      url: null,
      startedAt: vStarted,
      finishedAt: vFinished,
      outputTail: outputTail || null,
      artifactId: null,
      error,
    });
    validationIds.push(vid);
  }

  return validationIds;
}

async function runRuntimeValidation(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  passId: string,
  projectRoot: string,
  runtimeCommands: string[],
  internalUrl: string | null | undefined,
): Promise<string[]> {
  const validationIds: string[] = [];

  for (const command of runtimeCommands) {
    const vStarted = Date.now();
    let outputTail = "";
    let error: string | null = null;
    let status = "failed";

    try {
      const workDir = existsSync(projectRoot) ? projectRoot : "/tmp";
      const result = spawnSync("/bin/bash", ["-c", command], {
        encoding: "utf8",
        timeout: 120_000,
        cwd: workDir,
        env: { ...process.env, BUILDER_RUN_ID: run.id },
      });
      outputTail = (result.stdout ?? "").slice(-4000);
      if (result.status === 0) status = "success";
      else {
        error = `exit code ${result.status ?? "null"}`;
        status = result.status === null ? "timeout" : "failed";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = "error";
    }

    const vFinished = Date.now();
    const vid = createValidationRow({
      workflowId: workflow.id,
      runId: run.id,
      passId,
      kind: "runtime",
      status,
      command,
      url: null,
      startedAt: vStarted,
      finishedAt: vFinished,
      outputTail: outputTail || null,
      artifactId: null,
      error,
    });
    validationIds.push(vid);
  }

  if (internalUrl) {
    const vStarted = Date.now();
    let error: string | null = null;
    let status = "failed";

    try {
      const result = spawnSync("curl", [
        "--max-time", "10",
        "--silent", "--show-error",
        "-o", "/dev/null",
        "-w", "%{http_code}",
        internalUrl,
      ], { encoding: "utf8", timeout: 15_000 });
      const code = (result.stdout ?? "").trim();
      if (code.startsWith("2")) status = "success";
      else { error = `HTTP ${code}`; status = "failed"; }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = "error";
    }

    const vFinished = Date.now();
    const vid = createValidationRow({
      workflowId: workflow.id,
      runId: run.id,
      passId,
      kind: "internal-smoke",
      status,
      command: null,
      url: internalUrl,
      startedAt: vStarted,
      finishedAt: vFinished,
      outputTail: null,
      artifactId: null,
      error,
    });
    validationIds.push(vid);
  }

  return validationIds;
}

async function runPublicValidation(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  passId: string,
  projectRoot: string,
  publicCommands: string[],
  publicUrl: string | null | undefined,
  playwright: { enabled?: boolean; config?: string; targets?: string[] } | undefined,
): Promise<string[]> {
  const validationIds: string[] = [];

  for (const command of publicCommands) {
    const vStarted = Date.now();
    let outputTail = "";
    let error: string | null = null;
    let status = "failed";

    try {
      const workDir = existsSync(projectRoot) ? projectRoot : "/tmp";
      const result = spawnSync("/bin/bash", ["-c", command], {
        encoding: "utf8",
        timeout: 120_000,
        cwd: workDir,
        env: { ...process.env, BUILDER_RUN_ID: run.id },
      });
      outputTail = (result.stdout ?? "").slice(-4000);
      if (result.status === 0) status = "success";
      else {
        error = `exit code ${result.status ?? "null"}`;
        status = result.status === null ? "timeout" : "failed";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = "error";
    }

    const vFinished = Date.now();
    const vid = createValidationRow({
      workflowId: workflow.id,
      runId: run.id,
      passId,
      kind: "public",
      status,
      command,
      url: null,
      startedAt: vStarted,
      finishedAt: vFinished,
      outputTail: outputTail || null,
      artifactId: null,
      error,
    });
    validationIds.push(vid);
  }

  if (publicUrl) {
    const vStarted = Date.now();
    let error: string | null = null;
    let status = "failed";

    try {
      const result = spawnSync("curl", [
        "--max-time", "10",
        "--silent", "--show-error",
        "-o", "/dev/null",
        "-w", "%{http_code}",
        publicUrl,
      ], { encoding: "utf8", timeout: 15_000 });
      const code = (result.stdout ?? "").trim();
      if (code.startsWith("2")) status = "success";
      else { error = `HTTP ${code}`; status = "failed"; }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = "error";
    }

    const vFinished = Date.now();
    const vid = createValidationRow({
      workflowId: workflow.id,
      runId: run.id,
      passId,
      kind: "public-smoke",
      status,
      command: null,
      url: publicUrl,
      startedAt: vStarted,
      finishedAt: vFinished,
      outputTail: null,
      artifactId: null,
      error,
    });
    validationIds.push(vid);
  }

  if (playwright?.enabled) {
    const pwIds = await runPlaywrightValidation(workflow, run, passId, projectRoot, playwright);
    validationIds.push(...pwIds);
  }

  return validationIds;
}

async function runPlaywrightValidation(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  passId: string,
  projectRoot: string,
  config: { config?: string; targets?: string[] },
): Promise<string[]> {
  const validationIds: string[] = [];
  const runDirPath = `/var/lib/control-surface/builder-runs/${run.id}`;
  const pwDir = join(runDirPath, "playwright");
  const traceFile = join(pwDir, "trace.zip");
  const reportFile = join(pwDir, "report.html");

  try {
    mkdirSync(pwDir, { recursive: true });
  } catch {
    // dir may already exist
  }

  const targets = config.targets?.length ? config.targets : ["/"];
  const internalUrl = workflow.config.validationProfile.internalUrl ?? "http://127.0.0.1:3000";

  for (const target of targets) {
    const vStarted = Date.now();
    let error: string | null = null;
    let status = "failed";
    let outputTail = "";

    const url = target.startsWith("http") ? target : `${internalUrl.replace(/\/$/, "")}${target}`;
    const pwScript = `
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', err => errors.push(err.message));
try {
  const resp = await page.goto('${url}', { timeout: 15000, waitUntil: 'networkidle' });
  const title = await page.title();
  const statusCode = resp?.status() ?? 0;
  await browser.close();
  const consoleErr = errors.filter(e => !e.includes('favicon'));
  console.log(JSON.stringify({ ok: statusCode >= 200 && statusCode < 400, status: statusCode, title, consoleErrors: consoleErr }));
} catch(e) {
  await browser.close().catch(() => {});
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
    `.trim();

    const scriptPath = join(pwDir, `pw-${target.replace(/\//g, "_")}.mjs`);
    writeFileSync(scriptPath, pwScript, { mode: 0o755 });

    try {
      const result = spawnSync("node", [scriptPath], {
        encoding: "utf8",
        timeout: 30_000,
        cwd: projectRoot,
      });
      outputTail = (result.stdout ?? "").slice(-2000);
      if (result.stderr) outputTail += "\n" + result.stderr.slice(-1000);
      try {
        const parsed = JSON.parse(outputTail.trim());
        if (parsed.ok) status = "success";
        else error = parsed.error ?? `status ${parsed.status}`;
      } catch {
        if (result.status === 0) status = "success";
        else error = `playwright error: ${result.status}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = "error";
    }

    const vFinished = Date.now();
    const vid = createValidationRow({
      workflowId: workflow.id,
      runId: run.id,
      passId,
      kind: "playwright",
      status,
      command: null,
      url,
      startedAt: vStarted,
      finishedAt: vFinished,
      outputTail: outputTail || null,
      artifactId: null,
      error,
    });
    validationIds.push(vid);
  }

  return validationIds;
}

// ── Background reconciler ─────────────────────────────────────────────────────

export type BuilderReconcilerController = { stop(): void };

export function startBuilderReconciler(options: { intervalMs?: number } = {}): BuilderReconcilerController | null {
  if (!isDashboardDbEnabled()) return null;

  const intervalMs = options.intervalMs ?? 10_000;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const running = readBuilderRuns().filter((r) => r.status === "running");
      for (const run of running) {
        if (stopped) break;
        try {
          await reconcileRunStatus(run.id);
        } catch (err) {
          console.error(`[builder-reconciler] reconcile ${run.id} failed`, err);
        }
      }

      const SCHEDULED_MODES = new Set(["scheduled", "permanent"]);
      const workflows = readBuilderWorkflows().filter((w) =>
        SCHEDULED_MODES.has(w.mode) && w.status === "ready"
      );
      for (const wf of workflows) {
        if (stopped) break;
        if (wf.nextRunAt && isDue(wf.nextRunAt)) {
          try {
            await startWorkflowRun(wf.id, "scheduled");
            if (wf.mode === "scheduled") {
              const next = getNextRunTime(
                wf.config.schedule?.expression ?? "",
                wf.config.schedule?.timezone ?? "UTC"
              );
              if (next) {
                const db = requireDb();
                db.query(`UPDATE builder_workflows SET next_run_at = ? WHERE id = ?`).run(next, wf.id);
              }
            }
          } catch (err) {
            console.error(`[builder-scheduler] trigger ${wf.id} failed`, err);
          }
        }
      }
    } catch (err) {
      console.error("[builder-reconciler] tick failed", err);
    }
  }

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();

  void tick(); // run once on startup

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
