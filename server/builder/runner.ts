import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, chmodSync, statSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { createJob, finishJob, updateJobOutput, writeActionAudit } from "../db/writer.ts";
import { startSpan, endSpan } from "../tracing/tracer.ts";
import { queueDiagnosis } from "../reasoner/agent.ts";
import { matchPlaybook, applyPlaybookAction, recordPlaybookRun } from "../reasoner/playbooks.ts";
import {
  readBuilderRun,
  readBuilderRuns,
  readBuilderWorkflow,
  readBuilderWorkflows,
  readBuilderValidations,
  readBuilderPasses,
  readBuilderArtifacts,
  parseAgentEntry,
  isBuilderProjectRootAllowlisted,
  type BuilderRun,
  type BuilderWorkflow,
  type BuilderPass,
  type BuilderValidation,
} from "./store.ts";
import { selectModelForRole, type ModelRole } from "./modelSelector.ts";
import { getVerifiedAgenticGroup } from "./discovery.ts";
import { runDoctorReview, writeDoctorReport } from "./doctor.ts";
import { getNextRunTime, isDue, getBackoffMs } from "./scheduler.ts";
import { readSecretPlaintext } from "../governance/secrets.ts";
import { createOrchestratorInstance, getOrchestratorInstance, findInstanceByRunId, recordBuilderPassResult } from "../orchestrator/adapter.ts";
import { createApprovalRequest, getApprovalRequest } from "../governance/approvals.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import type { StepResult } from "../orchestrator/types.ts";
import { isNonGatewayCliLane, recordRunnerUsage } from "./runnerAccounting.ts";
import { getBuildValidationCommand, getValidationProfileStartBlockers } from "./validation-profile.ts";
import { getPlanSanityStartBlockers } from "./plan-sanity.ts";

// Isolated XDG_CONFIG_HOME for builder opencode runs: a config without the scoped
// filesystem MCP servers (vault/newsbites/editorial) that make agentic models falsely
// believe they are sandboxed, and without the MIMULE infra CLAUDE.md instructions.
const BUILDER_OPENCODE_CONFIG_HOME = "/var/lib/control-surface/opencode-builder";

export function builderStateRoot(): string {
  return process.env.BUILDER_STATE_ROOT?.trim() || "/var/lib/control-surface";
}

function builderRunsDir(): string {
  return join(builderStateRoot(), "builder-runs");
}

function tenantRunsBaseDir(): string {
  return join(builderStateRoot(), "tenants");
}

function validationSucceeded(status: string): boolean {
  return /^(ok|pass|passed|success|succeeded|skipped)$/i.test(status);
}

export function repeatedValidationFailurePauseReason(
  passes: BuilderPass[],
  validations: BuilderValidation[],
  threshold: number,
): string | null {
  const normalizedThreshold = Math.min(20, Math.max(2, Math.round(threshold || 3)));
  const validationsByPass = new Map<string, BuilderValidation[]>();
  for (const validation of validations) {
    if (!validation.passId) continue;
    const rows = validationsByPass.get(validation.passId) ?? [];
    rows.push(validation);
    validationsByPass.set(validation.passId, rows);
  }

  let streak = 0;
  const failedLabels: string[] = [];
  for (const pass of [...passes].sort((a, b) => b.sequence - a.sequence)) {
    const passValidations = validationsByPass.get(pass.id) ?? [];
    if (passValidations.length === 0) break;
    const failed = passValidations.filter((validation) => !validationSucceeded(validation.status));
    if (failed.length === 0) break;
    streak += 1;
    for (const validation of failed) {
      const label = validation.command ?? validation.kind;
      if (label && !failedLabels.includes(label)) failedLabels.push(label);
    }
    if (streak >= normalizedThreshold) {
      const examples = failedLabels.slice(0, 3).join("; ");
      return `${streak} consecutive passes ended with validation failures${examples ? ` (${examples})` : ""} — workflow paused for repair before more agent passes run.`;
    }
  }
  return null;
}

function ensureRunsDir(): void {
  const runsDir = builderRunsDir();
  if (!existsSync(runsDir)) {
    mkdirSync(runsDir, { recursive: true });
  }
}

// Compatibility resolver: checks both new tenant-aware path and legacy path
function resolveRunDir(tenantId: string | null, projectId: string | null, runId: string): string {
  // First try the tenant-aware path
  const tenantAwarePath = runDir(tenantId, projectId, runId);
  if (existsSync(tenantAwarePath)) {
    return tenantAwarePath;
  }

  // Fall back to legacy path for backward compatibility
  const legacyPath = join(builderRunsDir(), runId);
  if (existsSync(legacyPath)) {
    return legacyPath;
  }

  // If neither exists, return the tenant-aware path for creation
  return tenantAwarePath;
}

function runDir(tenantIdOrRunId: string | null, projectId?: string | null, runId?: string): string {
  if (runId === undefined) {
    return join(builderRunsDir(), tenantIdOrRunId ?? "");
  }

  const tenantId = tenantIdOrRunId;
  // For backward compatibility, if tenantId is null or "mimule" and projectId is null, use legacy path
  if ((!tenantId || tenantId === "mimule") && !projectId) {
    return join(builderRunsDir(), runId);
  }

  // For tenant-aware paths
  const safeTenantId = sanitizeTenantId(tenantId || "mimule");
  const safeProjectId = projectId ? sanitizeProjectId(projectId) : "default";
  return join(tenantRunsBaseDir(), safeTenantId, "projects", safeProjectId, "builder-runs", runId);
}

function sanitizeTenantId(tenantId: string): string {
  // Replace any characters that are not safe for directory names
  return tenantId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeProjectId(projectId: string): string {
  // Replace any characters that are not safe for directory names
  return projectId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function tmuxSessionName(tenantId: string | null, runId: string, passNumber = 1): string {
  const safeTenantId = tenantId ? sanitizeTenantId(tenantId) : "default";
  if (passNumber === 1) return `builder-${safeTenantId}-${runId.slice(0, 16)}`;
  return `builder-${safeTenantId}-${runId.slice(0, 12)}-p${passNumber}`;
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

// Extract human-readable text from claude --output-format stream-json output.
// Prefers the final `result` event; falls back to collected assistant text chunks.
function parseClaudeStreamJson(raw: string): string {
  let finalResult = "";
  const assistantChunks: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      if (ev.type === "result" && typeof ev.result === "string") {
        finalResult = ev.result;
      } else if (ev.type === "assistant") {
        const content = (ev.message as { content?: unknown[] } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if ((block as { type?: string; text?: string }).type === "text") {
              assistantChunks.push((block as { text: string }).text);
            }
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }
  const text = (finalResult || assistantChunks.join("")).trim();
  return text.slice(0, 2000) || raw.slice(-500);
}

function loadSecretsForPass(workflow: BuilderWorkflow): Record<string, string> {
  const names = workflow.config.secretNames ?? [];
  if (!names.length) return {};
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const plaintext = readSecretPlaintext(name);
    if (plaintext !== null) {
      secrets[`SECRET_${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = plaintext;
    }
  }
  return secrets;
}

function redactSecrets(text: string, secrets: Record<string, string>): string {
  if (!Object.keys(secrets).length) return text;
  let result = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value && value.length > 0) {
      result = result.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return result;
}

// Reads the live model-health file to produce a concise briefing for agents.
// Fails silently — a missing health file is not fatal.
function readModelBriefing(selectedModel: string | null, agent: string): string {
  try {
    const healthPath = "/var/lib/mimule/model-health.json";
    if (!existsSync(healthPath)) return "";
    const health = JSON.parse(readFileSync(healthPath, "utf8")) as {
      bestCloudHeavy?: string;
      bestCloudFast?: string;
      bestLocal?: string;
      ranked?: { heavy?: string[]; medium?: string[] };
    };
    const heavy = health.bestCloudHeavy ?? "editorial-cloud-heavy";
    const fast  = health.bestCloudFast  ?? "editorial-cloud-fast";
    const local = health.bestLocal;
    const topHeavy = (health.ranked?.heavy  ?? []).slice(0, 4).join(", ");
    const topFast  = (health.ranked?.medium ?? []).slice(0, 3).join(", ");
    return [
      "=== MODEL BRIEFING (live from /var/lib/mimule/model-health.json) ===",
      `This pass: ${agent}${selectedModel ? `/${selectedModel}` : " (agent default)"}`,
      `  Best heavy (complex coding / research): ${heavy}`,
      `  Best fast  (single-file edits / prep): ${fast}`,
      local ? `  Best local GPU (lowest latency):       ${local}` : "",
      topHeavy ? `  Heavy pool (fastest first): ${topHeavy}` : "",
      topFast  ? `  Fast pool  (fastest first): ${topFast}`  : "",
      "",
      "Use LiteLLM logical names (above) for --model flags or builder_spawn_child.",
      "OpenCode native IDs: opencode-go/kimi-k2.6, anthropic/claude-sonnet-4-5,",
      "  google/gemini-2.5-flash, openai/gpt-4.1, openai/o4-mini, xai/grok-3-mini",
      "====================================================================",
    ].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

// ── Tmux helpers ───────────────────────────────────────────────────────────

function tmuxSocket(tenantId: string): string {
  return `${process.env.BUILDER_TMUX_SOCKET_PREFIX?.trim() || "tib-"}${tenantId}`;
}

export { tmuxSocket, acquireProjectLock, releaseProjectLock };

function tmuxEnsureServer(socket: string): void {
  spawnSync("tmux", ["-L", socket, "new-session", "-d", "-s", "init"], { encoding: "utf8" });
}

function tmuxExists(socket: string, session: string): boolean {
  const result = spawnSync("tmux", ["-L", socket, "has-session", "-t", session], { encoding: "utf8" });
  return result.status === 0;
}

function tmuxKill(socket: string, session: string): void {
  spawnSync("tmux", ["-L", socket, "kill-session", "-t", session], { encoding: "utf8" });
}

function tmuxSendKeys(socket: string, session: string, keys: string): void {
  spawnSync("tmux", ["-L", socket, "send-keys", "-t", session, keys], { encoding: "utf8" });
}

function tmuxCapturePane(socket: string, session: string): string {
  const result = spawnSync("tmux", ["-L", socket, "capture-pane", "-p", "-t", session], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout ?? "";
}

function tmuxPanePids(socket: string, session: string): number[] {
  const result = spawnSync("tmux", ["-L", socket, "list-panes", "-t", session, "-F", "#{pane_pid}"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function processHasChildren(pid: number): boolean {
  const result = spawnSync("pgrep", ["-P", String(pid)], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function tmuxPaneHasChildProcess(socket: string, session: string): boolean {
  return tmuxPanePids(socket, session).some((pid) => processHasChildren(pid));
}

function killDetachedRunProcesses(runId: string): void {
  const result = spawnSync("ps", ["-eo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) return;

  const pids = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number.parseInt(match[1], 10);
      const command = match[2];
      if (!Number.isFinite(pid) || pid <= 0) return null;
      if (!command.includes(runId)) return null;
      if (command.includes("ps -eo pid=,command=")) return null;
      return String(pid);
    })
    .filter((pid): pid is string => Boolean(pid));

  if (pids.length > 0) {
    spawnSync("kill", ["-TERM", ...pids], { encoding: "utf8" });
  }
}

// ── Run helpers ────────────────────────────────────────────────────────────

function readExitCode(tenantIdOrRunId: string | null, projectIdOrPassNumber?: string | null | number, runId?: string, passNumber = 1): number | null {
  const actualRunId = runId ?? tenantIdOrRunId;
  const actualPassNumber = typeof projectIdOrPassNumber === "number" ? projectIdOrPassNumber : passNumber;
  const path = join(
    runId === undefined ? resolveRunDir(null, null, actualRunId) : resolveRunDir(tenantIdOrRunId, projectIdOrPassNumber as string | null, runId),
    `pass-${actualPassNumber}-exit.code`,
  );
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8").trim();
    const code = Number.parseInt(text, 10);
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

function readLogFile(tenantIdOrRunId: string | null, projectIdOrName: string | null, runId?: string, name?: string): string {
  const path = runId === undefined
    ? join(resolveRunDir(null, null, tenantIdOrRunId), projectIdOrName ?? "")
    : join(resolveRunDir(tenantIdOrRunId, projectIdOrName, runId), name ?? "");
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
  const runDirPath = resolveRunDir(run.tenantId, workflow.projectId, run.id);
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
  const patchPath = join(resolveRunDir(run.tenantId, workflow.projectId, run.id), "pre-pass.patch");
  writeFileSync(patchPath, diffText, { encoding: "utf8" });

  // Write dirty state file
  const dirtyPath = join(resolveRunDir(run.tenantId, workflow.projectId, run.id), "pre-pass-dirty.txt");
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

  const backupDir = join(builderStateRoot(), "builder-backups");
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
    const commitInfoPath = join(resolveRunDir(run.tenantId, workflow.projectId, run.id), "commit-info.txt");
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

const BUILDER_VAULT_DIR = "/opt/ai-vault/builder";

function ensureBuilderVaultDir(): void {
  if (!existsSync(BUILDER_VAULT_DIR)) mkdirSync(BUILDER_VAULT_DIR, { recursive: true });
}

function logToVault(workflow: BuilderWorkflow, run: BuilderRun, passId: string | null, passSeq: number, runStatus: string): void {
  const ts = new Date().toISOString();
  const vaultDate = ts.slice(0, 10); // YYYY-MM-DD

  const wfShort  = workflow.id.slice(0, 8);
  const runShort = run.id.slice(0, 8);

  // Full details go to /opt/ai-vault/builder/YYYY-MM-DD-<wf>-<run>.md
  // Daily vault gets only a brief one-liner — keeps the daily note clean.
  ensureBuilderVaultDir();
  const builderLogPath = `${BUILDER_VAULT_DIR}/${vaultDate}-${wfShort}-${runShort}.md`;

  const passResult = (() => {
    try { return readPassResult(run.id, passSeq); } catch { return null; }
  })();

  const analyticsLines: string[] = [];
  if (passResult) {
    analyticsLines.push("", "## Pass Analytics", "");
    analyticsLines.push(`| Field | Value |`);
    analyticsLines.push(`|---|---|`);
    analyticsLines.push(`| Pass status   | ${passResult.status} |`);
    if (passResult.completionPercent != null)
      analyticsLines.push(`| Completion    | ${passResult.completionPercent}% |`);
    if (passResult.itemsDone?.length)
      analyticsLines.push(`| Items done    | ${passResult.itemsDone.length} |`);
    if (passResult.itemsRemaining?.length)
      analyticsLines.push(`| Items left    | ${passResult.itemsRemaining.length} |`);
    if (passResult.filesEdited?.length)
      analyticsLines.push(`| Files edited  | ${passResult.filesEdited.join(", ")} |`);
    if (passResult.filesCreated?.length)
      analyticsLines.push(`| Files created | ${passResult.filesCreated.join(", ")} |`);
    if (passResult.nextInstruction)
      analyticsLines.push(`| Next step     | ${passResult.nextInstruction.slice(0, 120)} |`);
    if (passResult.passNote)
      analyticsLines.push(`| Pass note     | ${passResult.passNote.slice(0, 200)} |`);
    const unresolvedErrors = (passResult.errors ?? []).filter((e) => !e.resolved);
    if (unresolvedErrors.length)
      analyticsLines.push(`| Errors        | ${unresolvedErrors.length} unresolved |`);
  }

  const fullLines: string[] = [
    `# Builder run: ${workflow.name}`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Status    | ${runStatus} |`,
    `| Workflow  | ${workflow.id} |`,
    `| Run       | ${run.id} |`,
    `| Trigger   | ${run.trigger} |`,
    `| Pass      | ${passId ?? "-"} |`,
    `| Started   | ${run.startedAt ? new Date(run.startedAt).toISOString() : "-"} |`,
    `| Finished  | ${run.finishedAt ? new Date(run.finishedAt).toISOString() : ts} |`,
    `| Agent     | ${workflow.config.agentOrder[0] ?? "unknown"} |`,
    `| Model     | ${workflow.config.modelPolicy.builder ?? "-"} |`,
    `| Plan      | ${workflow.planFile} |`,
    `| Project   | ${workflow.projectRoot} |`,
    `| Artifacts | ${resolveRunDir(run.tenantId, workflow.projectId, run.id)}/ |`,
    ...analyticsLines,
    "",
    `_Logged at ${ts}_`,
  ];

  try {
    writeFileSync(builderLogPath, fullLines.join("\n"), { encoding: "utf8" });
  } catch (e) {
    console.error("[builder] builder vault write failed:", e);
  }

  // One-liner in the daily vault under ## Builder Runs
  const briefEntry = `- [${runStatus}] ${workflow.name} · run=${runShort} · ${ts.slice(11, 19)} UTC → [details](${builderLogPath})\n`;
  const dailyVaultPath = `/opt/ai-vault/daily/${vaultDate}.md`;
  try {
    const existing = existsSync(dailyVaultPath) ? readFileSync(dailyVaultPath, "utf8") : "";
    const marker = "## Builder Runs";
    if (existing.includes(marker)) {
      writeFileSync(
        dailyVaultPath,
        existing.replace(marker + "\n", marker + "\n" + briefEntry),
        { encoding: "utf8" },
      );
    } else {
      const separator = existing.trim() ? "\n\n---\n\n" : "";
      writeFileSync(
        dailyVaultPath,
        existing + separator + `${marker}\n${briefEntry}`,
        { encoding: "utf8" },
      );
    }
  } catch (e) {
    console.error("[builder] daily vault write failed:", e);
  }

  // Append a brief progress entry to the plan file (useful for plan tracking)
  if (workflow.planFile && existsSync(workflow.planFile)) {
    try {
      const planContent = readFileSync(workflow.planFile, "utf8");
      const runMarker = `Builder run ${runShort}`;
      if (!planContent.includes(runMarker)) {
        const entry = `\n\n<!-- ${runMarker}: ${runStatus} at ${ts} — details: ${builderLogPath} -->`;
        writeFileSync(workflow.planFile, planContent + entry, { encoding: "utf8" });
      }
    } catch (e) {
      console.error("[builder] plan log write failed:", e);
    }
  }
}

// ── Phase 6: Auto-Continue and Context Handoff ─────────────────────────────

function buildContinuationContext(workflow: BuilderWorkflow, run: BuilderRun, nextSequence: number, agent?: string, model?: string | null): string {
  const projectRoot = workflow.projectRoot;
  const prevPasses = readBuilderPasses(run.id).filter((p) => p.sequence < nextSequence);

  // If the most recent pass left the production build broken, the next pass MUST repair the build
  // baseline before touching any plan item — otherwise the run "advances roadmap items after a
  // failed validation" and digs the hole deeper (the exact failure pattern Codex flagged). We pull
  // the failing command + error tail from the latest pass's build validation and force focus on it.
  let buildBreak: { command: string; outputTail: string } | null = null;
  const latestPass = [...prevPasses].sort((a, b) => b.sequence - a.sequence)[0];
  if (latestPass) {
    const lastBuildVal = readBuilderValidations(run.id)
      .filter((v) => v.passId === latestPass.id && v.kind === "build" && v.status !== "success")
      .pop();
    if (lastBuildVal) {
      buildBreak = {
        command: lastBuildVal.command ?? "(build command)",
        outputTail: (lastBuildVal.outputTail ?? lastBuildVal.error ?? "").slice(-3000),
      };
    }
  }

  const lines: string[] = [
    `=== Builder Pipeline: Pass ${nextSequence} Continuation Context ===`,
    `Workflow: ${workflow.name}`,
    `Plan: ${workflow.planFile}`,
    `Project: ${projectRoot}`,
    `Previous passes: ${prevPasses.length}`,
    "",
  ];

  // For the very first pass of a new run, prepend findings from the previous run so work is not restarted from scratch.
  if (prevPasses.length === 0 && workflow.lastRunId && workflow.lastRunId !== run.id) {
    const lastRun = readBuilderRun(workflow.lastRunId);
    if (lastRun) {
      const lastPasses = readBuilderPasses(lastRun.id).sort((a, b) => a.sequence - b.sequence);
      if (lastPasses.length > 0) {
        lines.push(`--- Previous Run (${workflow.lastRunId.slice(0, 12)}, ${lastRun.status}) — carry forward ---`);
        for (const p of lastPasses) {
          const wasTimeout = p.failureClass === "pass-timeout";
          const label = wasTimeout ? "interrupted/timeout — partial work preserved" : p.status;
          lines.push(`  Pass ${p.sequence} (${p.agent ?? "?"}, ${label}): ${(p.summary ?? "no summary").slice(0, 400)}`);
        }
        lines.push("Continue from where the previous run left off. Check the plan for remaining unchecked items.");
        lines.push("");
      }
    }
  }

  for (const pass of prevPasses.sort((a, b) => a.sequence - b.sequence)) {
    const artifacts = readBuilderArtifacts(run.id).filter((a) => a.passId === pass.id);
    const validations = readBuilderValidations(run.id).filter((v) => v.passId === pass.id);

    const wasTimeout = pass.failureClass === "pass-timeout";
    const statusLabel = wasTimeout ? "interrupted/timeout — partial work preserved" : pass.status;
    lines.push(`--- Pass ${pass.sequence} (${pass.agent ?? "?"}, ${statusLabel}) ---`);

    // Prefer PASS_RESULT.json over raw stdout
    const passResult = readPassResult(run.tenantId, workflow.projectId, run.id, pass.sequence);
    if (passResult) {
      if (passResult.passNote) {
        lines.push(`Note: ${passResult.passNote.slice(0, wasTimeout ? 1000 : 500)}`);
      }
      if (passResult.itemsDone.length > 0) {
        lines.push(`Completed: ${passResult.itemsDone.join(" | ")}`);
      }
      if (passResult.filesEdited.length > 0) {
        lines.push(`Files changed: ${passResult.filesEdited.join(", ")}`);
      }
      if (passResult.nextInstruction) {
        lines.push(`Handoff instruction: ${passResult.nextInstruction.slice(0, 800)}`);
      }
      const unresolved = (passResult.errors ?? []).filter((e) => !e.resolved);
      if (unresolved.length > 0) {
        lines.push(`UNRESOLVED ERRORS: ${unresolved.map((e) => e.message).join("; ")}`);
      }
    } else {
      // Fallback: raw stdout tail (existing behavior)
      if (pass.summary) {
        lines.push(`Summary: ${pass.summary.slice(0, wasTimeout ? 1000 : 500)}`);
      }
      const stdoutArtifact = artifacts.find((a) => a.kind === "stdout");
      if (stdoutArtifact && existsSync(stdoutArtifact.path)) {
        try {
          const raw = readFileSync(stdoutArtifact.path, "utf8");
          const excerptLen = wasTimeout ? 4000 : 2000;
          const content = pass.agent === "claude" ? parseClaudeStreamJson(raw) : raw.slice(-excerptLen);
          const label = wasTimeout ? `Interrupted output (${excerptLen / 1000}KB)` : "Last stdout (2KB)";
          if (content) lines.push(`${label}: ${content.slice(-excerptLen)}`);
        } catch { /* ignore */ }
      }
    }
    const validationResults = validations.map((v) => `${v.kind}:${v.status}`).join(", ");
    if (validationResults) lines.push(`Validations: ${validationResults}`);
    lines.push("");
  }

  lines.push("--- Plan File Reminder ---");
  if (existsSync(workflow.planFile)) {
    try {
      const planContent = readFileSync(workflow.planFile, "utf8");
      const phaseMatch = planContent.match(/^##[^\n]*/gm);
      if (phaseMatch) {
        lines.push(`Plan sections: ${phaseMatch.slice(0, 20).join(" | ")}`);
      }
      // Find next unchecked items without reading the whole file
      const unchecked = planContent
        .split(/\r?\n/)
        .filter((l) => /^\s*-\s+\[ \]/.test(l))
        .map((l) => l.trim());
      if (unchecked.length > 0) {
        lines.push(`Remaining plan items (${unchecked.length} total):`);
        for (const item of unchecked.slice(0, 15)) {
          lines.push(`  ${item}`);
        }
        if (unchecked.length > 15) {
          lines.push(`  ... and ${unchecked.length - 15} more`);
        }
      }
      lines.push(`Full plan at: ${workflow.planFile}`);
      lines.push(`Use: grep -n '^\\s*- \\[ \\]' '${workflow.planFile}' | head -20`);
    } catch { /* ignore */ }
  } else {
    lines.push(`Plan file not found at: ${workflow.planFile}`);
  }

  // Inject live model briefing so agents know what's available
  const briefing = readModelBriefing(model ?? null, agent ?? "unknown");
  if (briefing) {
    lines.push("");
    lines.push(briefing);
  }

  lines.push("");
  lines.push("=== Instructions for this pass ===");
  if (buildBreak) {
    // Build is broken — repair-only pass. Do not advance the roadmap.
    lines.push("THE PRODUCTION BUILD IS BROKEN. This pass is a BUILD-REPAIR pass ONLY.");
    lines.push(`Failing command: ${buildBreak.command}`);
    lines.push("Build error (tail):");
    lines.push("```");
    lines.push(buildBreak.outputTail || "(no captured output - re-run the command to see the error)");
    lines.push("```");
    lines.push("1. Re-run the failing command above and read the FIRST error (fix root cause, not symptoms).");
    lines.push("2. Fix ONLY what is needed to make that command exit 0 (missing deps, imports, types, 'use client', config).");
    lines.push("3. Re-run the command until it passes. Do NOT pick up new plan items. Do NOT mark plan items [x].");
    lines.push("4. Do NOT add features, screens, monetization, or anything requiring external services/credentials.");
    lines.push("5. End with a concise summary: the error, the fix, and whether the build now passes.");
  } else {
    lines.push("1. Read ONLY the next 2-3 unchecked items from the plan (use grep, not full cat).");
    lines.push("2. Implement those items, then mark them [x] in the plan file.");
    lines.push("3. Run validation commands after changes (see contract above).");
    lines.push("4. End with a concise summary: what changed, what failed, what the next item is.");
    lines.push("Do NOT try to complete the whole plan in one pass.");
  }

  // Surface the broken-build banner at the very TOP too, so it is the first thing the agent reads.
  if (buildBreak) {
    lines.unshift(
      "",
      `   Failing command: ${buildBreak.command}`,
      "BUILD BASELINE IS BROKEN - fix the build before anything else (details + error below).",
      "",
    );
  }

  return lines.join("\n");
}

// Expand "group:<name>" tokens in agentOrder into the verified agentic model roster, so the
// builder picks a GROUP of proven models (round-robined per pass) instead of one hardcoded id.
// Explicit single/multi model configs (no group token) are respected as-is. Idempotent —
// safe to call on every pass. Empty roster falls back to the one model proven to work.
function expandModelGroupsInPlace(config: BuilderWorkflow["config"]): void {
  const order = config.agentOrder ?? [];
  const hasGroup = order.some((e) => /^group:/i.test(parseAgentEntry(e).model ?? ""));
  if (!hasGroup) return;
  let groupName = "agentic-heavy";
  const expanded: string[] = [];
  for (const raw of order) {
    const parsed = parseAgentEntry(raw);
    const gm = (parsed.model ?? "").match(/^group:([a-z0-9_-]+)$/i);
    if (gm) {
      groupName = gm[1];
      const agent = parsed.agent || "opencode";
      for (const model of getVerifiedAgenticGroup(groupName)) expanded.push(`${agent}:${model}`);
    } else {
      expanded.push(raw);
    }
  }
  if (expanded.length === 0) expanded.push("opencode:openrouter/openai/gpt-oss-120b:free");
  config.agentOrder = expanded;
  const group = getVerifiedAgenticGroup(groupName);
  if (group.length) {
    config.modelPolicy.fallbackTargets = [...new Set([...(config.modelPolicy.fallbackTargets ?? []), ...group])];
  }
}

async function startNextPass(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  nextSequence: number,
): Promise<void> {
  expandModelGroupsInPlace(workflow.config);
  const entry = parseAgentEntry(workflow.config.agentOrder[(nextSequence - 1) % workflow.config.agentOrder.length] ?? "codex");
  const agent = entry.agent;
  const isCliAgent = ["codex", "claude", "gemini", "opencode"].includes(agent);
  const embeddedModel = entry.model;
  const embeddedEffort = entry.effort;

  const role: ModelRole = nextSequence === 1 ? "planner" : nextSequence === 2 ? "builder" : "reviewer";
  const selection = isCliAgent && embeddedModel
    ? { model: embeddedModel, provider: agent, reason: `embedded:${agent}:${embeddedModel}`, role, capability: null, qualityStatus: "healthy" as const }
    : selectModelForRole(role, workflow.config, agent);
  const { model, provider, reason: modelReason } = selection;

  const phase = agent === "claude" ? "plan" : agent === "codex" ? "review" : "implement";

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
  const continuationContext = buildContinuationContext(workflow, run, nextSequence, agent, model);
  const secrets = loadSecretsForPass(workflow);
  const scriptPath = writePassScript(run.id, workflow, agent, model, nextSequence, continuationContext, embeddedEffort, secrets);

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
    request: { workflowId: workflow.id, runId: run.id, passId, agent, model, effort: embeddedEffort, continuation: true },
    evidence: { planFile: workflow.planFile, projectRoot: workflow.projectRoot, passNumber: nextSequence },
  });

  updateBuilderPass(passId, { jobIds: [jobId] });

  const scriptArtifact = createBuilderArtifact({ workflowId: workflow.id, runId: run.id, passId, kind: "command-script", path: scriptPath });
  const stdoutArtifact = createBuilderArtifact({ workflowId: workflow.id, runId: run.id, passId, kind: "stdout", path: join(resolveRunDir(run.tenantId, workflow.projectId, run.id), `pass-${nextSequence}-stdout.log`) });
  const stderrArtifact = createBuilderArtifact({ workflowId: workflow.id, runId: run.id, passId, kind: "stderr", path: join(resolveRunDir(run.tenantId, workflow.projectId, run.id), `pass-${nextSequence}-stderr.log`) });
  updateBuilderPass(passId, { artifactIds: [scriptArtifact, stdoutArtifact, stderrArtifact] });

  const session = tmuxSessionName(workflow.tenantId, run.id, nextSequence);
  const socket = tmuxSocket(workflow.tenantId);
  tmuxEnsureServer(socket);
  const spawnResult = spawnSync("tmux", ["-L", socket, "new-session", "-d", "-s", session, "-c", workflow.projectRoot, scriptPath], { encoding: "utf8" });
  if (spawnResult.status !== 0) {
    const error = spawnResult.stderr || `tmux spawn failed (exit ${spawnResult.status})`;
    updateBuilderPass(passId, { status: "failed", finishedAt: now(), error });
    throw new Error(error);
  }
}

// ── Builder run / pass / artifact writers ──────────────────────────────────

export function createBuilderRun(workflowId: string, trigger: string, actor = "operator"): BuilderRun {
  const workflow = readBuilderWorkflow(workflowId);
  if (!workflow) throw new Error("workflow not found");
  const ctx = getCurrentTenantContext();
  const tenantId = workflow.tenantId || ctx.tenantId;
  const db = requireDb();
  const id = `br_${randomUUID()}`;
  const ts = now();

  db.query(`
    INSERT INTO builder_runs
      (id, workflow_id, tenant_id, trigger, status, started_at, finished_at, current_pass_id,
       stop_requested_at, stop_requested_by, result_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    workflowId,
    tenantId,
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
    traceId?: string | null;
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
  if (updates.traceId !== undefined) {
    sets.push("trace_id = ?");
    params.push(updates.traceId);
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
    nextInstruction?: string | null;
    analyticsJson?: string | null;
    planItemsDone?: number | null;
    planItemsRemaining?: number | null;
    completionPercent?: number | null;
    traceId?: string | null;
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
  if (updates.nextInstruction !== undefined) {
    sets.push("next_instruction = ?");
    params.push(updates.nextInstruction);
  }
  if (updates.analyticsJson !== undefined) {
    sets.push("analytics_json = ?");
    params.push(updates.analyticsJson);
  }
  if (updates.planItemsDone !== undefined) {
    sets.push("plan_items_done = ?");
    params.push(updates.planItemsDone);
  }
  if (updates.planItemsRemaining !== undefined) {
    sets.push("plan_items_remaining = ?");
    params.push(updates.planItemsRemaining);
  }
  if (updates.completionPercent !== undefined) {
    sets.push("completion_percent = ?");
    params.push(updates.completionPercent);
  }
  if (updates.traceId !== undefined) {
    sets.push("trace_id = ?");
    params.push(updates.traceId);
  }

  if (sets.length === 0) return;
  params.push(passId);

  db.query(`UPDATE builder_passes SET ${sets.join(", ")} WHERE id = ?`).run(...(params as (string | number | null)[]));
}

export type PassResult = {
  status: "incomplete" | "complete" | "failed" | "blocked";
  completionPercent?: number | null;
  itemsDone?: string[];
  itemsRemaining?: string[];
  filesEdited?: string[];
  filesCreated?: string[];
  filesRead?: string[];
  toolsUsed?: Record<string, number>;
  modelsUsed?: string[];
  errors?: Array<{ type: string; message: string; resolved: boolean }>;
  validationResults?: {
    typecheck?: string;
    tests?: string;
    playwright?: string;
    build?: string;
  };
  nextInstruction?: string | null;
  blockers?: Array<{ reason: string; suggestedFix: string }>;
  passNote?: string | null;
};

export function readPassResult(tenantIdOrRunId: string | null, projectIdOrPassSeq: string | null | number, runId?: string, _passSeq?: number): PassResult | null {
  const path = join(
    runId === undefined ? runDir(tenantIdOrRunId) : runDir(tenantIdOrRunId, projectIdOrPassSeq as string | null, runId),
    "PASS_RESULT.json",
  );
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as PassResult;
  } catch {
    return null;
  }
}

function extractPassAnalytics(
  tenantId: string | null,
  projectId: string | null,
  runId: string,
  passId: string,
  passSeq: number,
  startedAt: number | null,
  finishedAt: number,
): void {
  const result = readPassResult(tenantId, projectId, runId, passSeq);
  if (!result) return;

  const durationMs = startedAt ? finishedAt - startedAt : null;

  const stdoutTail = (() => {
    try {
      const p = join(runDir(tenantId, projectId, runId), `pass-${passSeq}-stdout.log`);
      if (!existsSync(p)) return "";
      const content = readFileSync(p, "utf8");
      return content.slice(-3000);
    } catch { return ""; }
  })();

  const analytics = {
    durationMs,
    planItemsDone: result.itemsDone?.length ?? 0,
    planItemsRemaining: result.itemsRemaining?.length ?? null,
    completionPercent: result.completionPercent ?? null,
    filesEdited: result.filesEdited ?? [],
    filesCreated: result.filesCreated ?? [],
    typecheckOutcome: result.validationResults?.typecheck ?? "skipped",
    playwrightOutcome: result.validationResults?.playwright ?? "skipped",
    unresolvedErrors: (result.errors ?? []).filter((e) => !e.resolved).length,
    stdoutTail,
  };

  updateBuilderPass(passId, {
    analyticsJson: JSON.stringify(analytics),
    planItemsDone: analytics.planItemsDone,
    planItemsRemaining: analytics.planItemsRemaining ?? undefined,
    completionPercent: analytics.completionPercent ?? undefined,
    nextInstruction: result.nextInstruction ?? null,
    summary: result.passNote ?? undefined,
  });

  // Write pass-analytics.json artifact
  try {
    const analyticsPath = join(runDir(tenantId, projectId, runId), `pass-${passSeq}-analytics.json`);
    writeFileSync(analyticsPath, JSON.stringify(analytics, null, 2), { encoding: "utf8" });
  } catch (err) {
    console.error("[builder] writing pass-analytics.json failed:", err);
  }
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

function acquireProjectLock(projectRoot: string, workflowId: string, runId: string, holder: string, tenantId: string): boolean {
  const db = requireDb();
  const ts = now();
  const expires = ts + 24 * 60 * 60 * 1000; // 24h

  try {
    db.query(`
      INSERT INTO builder_locks (project_root, workflow_id, run_id, acquired_at, expires_at, holder, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectRoot, workflowId, runId, ts, expires, holder, tenantId);
    return true;
  } catch {
    // Conflict means already locked
    return false;
  }
}

function releaseProjectLock(projectRoot: string, tenantId: string): void {
  const db = requireDb();
  db.query(`DELETE FROM builder_locks WHERE project_root = ? AND tenant_id = ?`).run(projectRoot, tenantId);
}

// ── Command builder ──────────────────────────────────────────────────────────

function buildCodexPrompt(workflow: BuilderWorkflow, continuationContext?: string): string {
  const { planFile, projectRoot } = workflow;
  const orchestrationRules = `
=== BUILDER PASS CONTRACT ===

── PLAN FILE NAVIGATION (critical for large plans) ──────────────────────────
DO NOT read the entire plan file at once. Use targeted commands:
  grep -n '^\s*- \[ \]' '${planFile}' | head -20   # next unchecked items
  grep -n '^## ' '${planFile}'                      # phase/section headings
  grep -n '^### \|^## ' '${planFile}' | head -40    # full outline
Focus on the NEXT 2-3 unchecked [ ] items only. After completing an item,
mark it [x] in the plan file. Do NOT attempt to finish an entire phase in
one pass — that overruns context and produces incomplete work.

── CONTEXT EFFICIENCY ───────────────────────────────────────────────────────
Read files with head/tail/grep; never cat an entire file >100 lines.
Your end-of-pass summary is stored (capped ~2 KB) and fed to the next pass.
Write it concisely: what changed, what failed, what the next unchecked item is.
Example: head -80 file.ts; grep -n 'functionName' file.ts

── TASK SPLITTING — when to use builder_spawn_child ────────────────────────
Split into child tasks when ANY of these apply:
  • >5 separate files need changes in one coherent logical unit
  • 2+ independent features/components can be built in parallel
  • A subtask needs a different model (e.g. heavy cloud for research)
Write $BUILDER_DIR/child-context.txt with project state BEFORE spawning.

── SUB-AGENT HELPERS (available in this shell) ──────────────────────────────
1. builder_spawn_child <agent> <model> <task-description>
   → agents: opencode, codex, claude, gemini
   → model: LiteLLM logical name or OpenCode native ID
   → returns PID; max 3 concurrent children
2. builder_child_status <pid>   → RUNNING | DONE | FAILED | TIMEOUT
3. builder_child_wait <pid> [timeout-seconds]   → default 300 s
4. builder_child_output <pid>   → last 200 lines of stdout+stderr
5. builder_child_kill <pid>     → SIGTERM on a hung child

RULES:
- Each child gets a fresh tmux session, shares the project directory.
- Children MUST NOT commit or push — only the parent pass does that.
- Retry a failed child ONCE with a different model/agent, then give up.
- Log every child PID and final status to the pass stdout.
- DO NOT invoke opencode/claude/codex/gemini directly — use builder_spawn_child.

── CONTEXT BUDGET RULES ─────────────────────────────────────────────────────
- Exploration budget: max 8 file reads before starting implementation
- Use grep -n / head -50 / wc -l instead of cat for unknown files
- Never read node_modules, .git, dist, or build artifacts
- Check file size with wc -l before reading (skip if > 500 lines unless directly editing)

── PLAN ADHERENCE ───────────────────────────────────────────────────────────
- Read the plan file sections for your 2-3 target items ONLY (not the full plan)
- Mark [x] immediately after completing each item
- Do not implement items beyond your allocated scope
- Do not refactor code outside your plan items

── VERIFICATION CADENCE ─────────────────────────────────────────────────────
- After every 2-3 file edits: run bun run check (or equivalent)
- If typecheck fails after an edit: fix it before moving to the next item
- Do not accumulate more than 3 typecheck errors before fixing
- Run targeted tests (bun test path/to/relevant.test.ts) not the full suite
- A PRODUCTION BUILD runs automatically after your pass and GATES completion —
  typecheck passing is NOT enough. Run the build yourself before finishing
  (e.g. npx nx run-many -t build, or npm run build) and fix any build errors.
- Next.js App Router: any component using hooks (useState/useEffect/useContext),
  context, browser events (onClick/onChange), or a class component MUST start with
  a "use client" directive on line 1. tsc won't catch this — the build will. Add it proactively.

── BLOCKER PROTOCOL ─────────────────────────────────────────────────────────
- If a service is down and your task requires it: write PASS_RESULT.json with status="blocked"
- If a dependency is missing (import error for nonexistent package): write blocked + suggest fix
- If plan instructions are ambiguous for your item: write blocked + quote the ambiguous part
- Do NOT guess at blocked states — always declare and exit

── PASS RESULT (MANDATORY — write this before exiting) ───────────────────────
Write $BUILDER_DIR/PASS_RESULT.json with this exact shape:

{
  "status": "incomplete",
  "completionPercent": 35,
  "itemsDone": [],
  "itemsRemaining": [],
  "filesEdited": [],
  "filesCreated": [],
  "filesRead": [],
  "toolsUsed": {},
  "modelsUsed": [],
  "errors": [],
  "validationResults": {
    "typecheck": "pass",
    "tests": "skipped",
    "playwright": "skipped",
    "build": "skipped"
  },
  "nextInstruction": "",
  "blockers": [],
  "passNote": ""
}

STATUS GUIDE:
- "incomplete": you ran out of time or context — next pass will continue
- "complete": all unchecked plan items are now checked [x]
- "failed": something broke and you couldn't fix it
- "blocked": ONLY when a hard EXTERNAL dependency is missing — a required secret/credential,
  or an external service that is down. NEVER use "blocked" for design questions, missing
  scaffolding, "I need clarification", or "no existing code to extend". Those are YOUR job:
  make a conventional decision and build it.

PLAN IS INCOMPLETE RULE:
If you reach context limit or timeout is imminent, set status="incomplete",
fill itemsRemaining with what's left, and write a precise nextInstruction.
Do NOT set status="complete" unless all checklist items are marked [x].

── GREENFIELD AUTONOMY (build from scratch) ────────────────────────────────
- This app is being BUILT, not maintained. MOST plan items require you to CREATE new
  files: controllers, services, DTOs, Prisma models/migrations, React components, screens,
  routes, tests. CREATE them. Do not wait for "existing scaffolding" to appear.
- You have FULL authority to make architectural and naming decisions. Make conventional,
  sensible choices (e.g. NestJS module under apps/api/src/<feature>/, Redis key
  "leaderboard:{leagueId}", Jest+Supertest for tests) and proceed.
- NEVER ask the operator to "confirm structure", "clarify expectations", or "provide
  guidance". There is no operator in the loop. Decide and build.
- "no existing code to extend" is NOT a blocker — it means you create the first version.
── SCOPE DISCIPLINE ─────────────────────────────────────────────────────────
- Create whatever the plan items need, but do not touch UNRELATED, passing code.
- Do not refactor code you weren't asked to change. "Minimal diff" applies to UNRELATED
  files — it never means "avoid creating the files this feature requires".
- If you find a bug in adjacent code: log it in passNote but don't fix it.
=============================================================================`;
  let base = `Continue developing the project according to the plan at ${planFile}. Project root: ${projectRoot}. Use relevant skills. Run validation commands after changes. Report changed files, test results, and next steps.${orchestrationRules}`;
  if (workflow.mode === "plan") {
    base = `Research the project at ${projectRoot}, dynamically inspect existing plan files, AGENTS.md, README files, package metadata, and current git state, then create or update the plan file at ${planFile}. Do not implement product code in this pass. The output plan must include current facts, open gaps, proposed phases, validation commands, and the next manual test path. If ${planFile} does not exist, create it.${orchestrationRules}`;
  }
  if (continuationContext) {
    base = `${continuationContext}\n\n${base}`;
  }
  return base;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellDoubleQuoteFragment(value: string): string {
  return value.replace(/([\\"$`])/g, "\\$1");
}

function writePassScript(
  runId: string,
  workflow: BuilderWorkflow,
  agent: string,
  model: string | null,
  passNumber = 1,
  continuationContext?: string,
  effort?: string,
  secrets?: Record<string, string>,
): string {
  ensureRunsDir();
  const dir = resolveRunDir(workflow.tenantId, workflow.projectId, runId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const scriptPath = join(dir, `pass-${passNumber}.sh`);
  let prompt = buildCodexPrompt(workflow, continuationContext);
  if (effort) {
    prompt = `[[Effort level: ${effort.toUpperCase()}]]\n${prompt}`;
  }

  const stdoutLog = `pass-${passNumber}-stdout.log`;
  const promptFile = `pass-${passNumber}-prompt.txt`;
  let command: string;
  if (agent === "codex") {
    const modelFlag = model ? ` --model ${shellQuote(model)}` : "";
    command = `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never${modelFlag} -o "$BUILDER_DIR/codex-output.txt" -C "$BUILDER_PROJECT_ROOT" "$(cat "$BUILDER_PROMPT_FILE")"`;
  } else if (agent === "claude") {
    command = `claude --print --output-format stream-json --verbose --permission-mode dontAsk -d "$BUILDER_PROJECT_ROOT" "$(cat "$BUILDER_PROMPT_FILE")"`;
  } else if (agent === "opencode") {
    const modelFlag = model ? ` --model ${shellQuote(model)}` : "";
    // Use an isolated opencode config (no scoped filesystem MCP servers, no MIMULE infra
    // instructions) so the agentic model doesn't hallucinate a sandbox and refuse to touch
    // the project. Auth lives in XDG_DATA_HOME so credentials are unaffected.
    command = `XDG_CONFIG_HOME=${BUILDER_OPENCODE_CONFIG_HOME} opencode run --dir "$BUILDER_PROJECT_ROOT" --dangerously-skip-permissions${modelFlag} "$(cat "$BUILDER_PROMPT_FILE")"`;
  } else if (agent === "gemini") {
    const modelFlag = model ? ` --model ${shellQuote(model)}` : "";
    const approvalMode = (workflow.config as { geminiApprovalMode?: string }).geminiApprovalMode ?? "auto_edit";
    command = `gemini --skip-trust --approval-mode ${shellQuote(approvalMode)}${modelFlag} --prompt - < "$BUILDER_PROMPT_FILE"`;
  } else {
    command = `echo "Unsupported builder agent: ${agent}"`;
  }

  // Continuation context is written by Node.js directly (no heredoc needed in shell).
  const continuationContextFile = continuationContext ? `${dir}/continuation-${passNumber}.txt` : null;
  const continuationBlock = continuationContextFile
    ? `echo "[builder] Continuation context from prior passes: ${continuationContextFile}" >> "$BUILDER_DIR/${stdoutLog}"\n`
    : "";

  const PASS_TIMEOUT_SECONDS = workflow.config.riskPolicy?.passTimeoutSeconds ?? 900;
  const timedCommand = `timeout ${PASS_TIMEOUT_SECONDS}s bash -lc ${shellQuote(command)}`;
  const tmuxSocketPrefix = shellDoubleQuoteFragment(tmuxSocket(""));

  function buildChildHelpersScript(): string {
    const projectRoot = workflow.projectRoot.replace(/"/g, '\\"');
    return [
      "# ── Sub-agent orchestration helpers ─────────────────────────────────────────",
      'builder_child_id_for_pid() {',
      '  local child_pid="$1"',
      '  for pid_file in "$BUILDER_DIR"/children/*/pid; do',
      '    [ -f "$pid_file" ] || continue',
      '    if [ "$(cat "$pid_file" 2>/dev/null)" = "$child_pid" ]; then',
      '      basename "$(dirname "$pid_file")"',
      '      return 0',
      '    fi',
      '  done',
      '  return 1',
      '}',
      "builder_spawn_child() {",
      '  if [ "$#" -lt 3 ]; then',
      '    echo "ERROR: usage builder_spawn_child <agent> <model> <task-description>" >&2',
      '    return 1',
      '  fi',
      '  local child_agent="$1" child_model="$2"',
      '  shift 2',
      '  local child_task="$*"',
      '  if [ ! -s "$BUILDER_DIR/child-context.txt" ]; then',
      '    echo "ERROR: write $BUILDER_DIR/child-context.txt before spawning children" >&2',
      '    return 1',
      '  fi',
      '  local active_children=0',
      `  active_children=$(tmux -L "${tmuxSocketPrefix}\${TENANT_ID}" list-sessions -F '#{session_name}' 2>/dev/null | grep -c "^builder-child-\${RUN_ID}_" || true)`,
      '  if [ "$active_children" -ge 3 ]; then',
      '    echo "ERROR: max 3 concurrent children allowed" >&2; return 1',
      '  fi',
      '  local child_id="${RUN_ID}_$(date +%s)_$(openssl rand -hex 4 2>/dev/null || head -c8 /dev/urandom | xxd -p)"',
      '  local child_dir="$BUILDER_DIR/children/$child_id"',
      '  mkdir -p "$child_dir"',
      '  printf "%s\\n\\n=== Child Task ===\\n%s\\n" "$(cat "$BUILDER_DIR/child-context.txt")" "$child_task" > "$child_dir/task.txt"',
      '  local child_script="$child_dir/run.sh"',
      '  cat > "$child_script" << \'CHILD_EOF\'',
      '#!/bin/bash',
      'set -uo pipefail',
      'echo "$$" > "$BUILDER_CHILD_DIR/pid"',
      'run_child() {',
      '  local task',
      '  task="$(cat "$BUILDER_CHILD_DIR/task.txt")"',
      '  if [ "$BUILDER_CHILD_AGENT" = "opencode" ]; then',
      `    XDG_CONFIG_HOME=${BUILDER_OPENCODE_CONFIG_HOME} opencode run --dir "$BUILDER_PROJECT_ROOT" --dangerously-skip-permissions --model "$BUILDER_CHILD_MODEL" "$task"`,
      '  elif [ "$BUILDER_CHILD_AGENT" = "codex" ]; then',
      '    codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never --model "$BUILDER_CHILD_MODEL" -o "$BUILDER_CHILD_DIR/output.txt" -C "$BUILDER_PROJECT_ROOT" "$task"',
      '  elif [ "$BUILDER_CHILD_AGENT" = "claude" ]; then',
      '    claude --print --output-format stream-json --verbose --permission-mode dontAsk -d "$BUILDER_PROJECT_ROOT" "$task"',
      '  elif [ "$BUILDER_CHILD_AGENT" = "gemini" ]; then',
      '    printf "%s" "$task" | gemini --skip-trust --approval-mode auto_edit --model "$BUILDER_CHILD_MODEL" --prompt -',
      '  else',
      '    echo "ERROR: unknown agent $BUILDER_CHILD_AGENT" >&2',
      '    return 2',
      '  fi',
      '}',
      'run_child > "$BUILDER_CHILD_DIR/stdout.log" 2> "$BUILDER_CHILD_DIR/stderr.log"',
      'code=$?',
      'echo "$code" > "$BUILDER_CHILD_DIR/exit.code"',
      'status="FAILED"',
      '[ "$code" = "0" ] && status="DONE"',
      '[ "$code" = "124" ] && status="TIMEOUT"',
      'echo "$status" > "$BUILDER_CHILD_DIR/status"',
      'echo "[builder-child] $BUILDER_CHILD_ID status=$status exit=$code finished_at=$(date -Iseconds)" >> "$BUILDER_CHILD_PASS_LOG"',
      'CHILD_EOF',
      '  chmod +x "$child_script"',
      `  tmux -L "${tmuxSocketPrefix}\${TENANT_ID}" new-session -d -s "builder-child-$child_id" -c "${projectRoot}" "env PATH=\\"$PATH\\" BUILDER_DIR=\\"$BUILDER_DIR\\" BUILDER_CHILD_ID=\\"$child_id\\" BUILDER_CHILD_DIR=\\"$child_dir\\" BUILDER_CHILD_AGENT=\\"$child_agent\\" BUILDER_CHILD_MODEL=\\"$child_model\\" BUILDER_PROJECT_ROOT=\\"${projectRoot}\\" BUILDER_CHILD_PASS_LOG=\\"$BUILDER_DIR/${stdoutLog}\\" \\"$child_script\\""`,
      '  local child_pid=""',
      '  for _ in 1 2 3 4 5 6 7 8 9 10; do',
      '    if [ -s "$child_dir/pid" ]; then child_pid="$(cat "$child_dir/pid" 2>/dev/null)"; break; fi',
      '    sleep 0.1',
      '  done',
      '  if [ -z "$child_pid" ]; then',
      `    child_pid=$(tmux -L "${tmuxSocketPrefix}\${TENANT_ID}" list-panes -t "builder-child-$child_id" -F '#{pane_pid}' 2>/dev/null | head -1)`,
      '    echo "$child_pid" > "$child_dir/pid"',
      '  fi',
      '  echo "{\\"id\\":\\"$child_id\\",\\"agent\\":\\"$child_agent\\",\\"model\\":\\"$child_model\\",\\"pid\\":\\"$child_pid\\",\\"spawnedAt\\":\\"$(date -Iseconds)\\"}" >> "$BUILDER_DIR/children-manifest.jsonl"',
      '  echo "[builder-child] $child_id pid=$child_pid agent=$child_agent model=$child_model spawned_at=$(date -Iseconds)" >> "$BUILDER_DIR/' + stdoutLog + '"',
      '  echo "$child_pid"',
      '}',
      'builder_child_status() {',
      '  local child_pid="$1"',
      '  local child_id',
      '  child_id="$(builder_child_id_for_pid "$child_pid" 2>/dev/null || true)"',
      '  [ -z "$child_id" ] && echo "NOT_FOUND" && return',
      `  if tmux -L "${tmuxSocketPrefix}\${TENANT_ID}" has-session -t "builder-child-$child_id" 2>/dev/null; then`,
      '    echo "RUNNING"',
      '  elif [ -f "$BUILDER_DIR/children/$child_id/status" ]; then',
      '    cat "$BUILDER_DIR/children/$child_id/status"',
      '  elif [ -f "$BUILDER_DIR/children/$child_id/exit.code" ]; then',
      '    local code=$(cat "$BUILDER_DIR/children/$child_id/exit.code")',
      '    if [ "$code" = "0" ]; then echo "DONE"; elif [ "$code" = "124" ]; then echo "TIMEOUT"; else echo "FAILED"; fi',
      '  else',
      '    echo "UNKNOWN"',
      '  fi',
      '}',
      'builder_child_wait() {',
      '  local child_pid="$1" wait_timeout="${2:-300}"',
      '  local child_id',
      '  child_id="$(builder_child_id_for_pid "$child_pid" 2>/dev/null || true)"',
      '  [ -z "$child_id" ] && echo "NOT_FOUND" && return 1',
      '  local waited=0',
      '  while [ $waited -lt $wait_timeout ]; do',
      `    if ! tmux -L "${tmuxSocketPrefix}\${TENANT_ID}" has-session -t "builder-child-$child_id" 2>/dev/null && [ -f "$BUILDER_DIR/children/$child_id/exit.code" ]; then`,
      '      local status code',
      '      status=$(builder_child_status "$child_pid")',
      '      code=$(cat "$BUILDER_DIR/children/$child_id/exit.code")',
      '      echo "$status"',
      '      [ "$code" = "0" ] && return 0 || return 1',
      '    fi',
      '    sleep 5',
      '    waited=$((waited + 5))',
      '  done',
      '  echo "TIMEOUT" > "$BUILDER_DIR/children/$child_id/status"',
      '  echo "124" > "$BUILDER_DIR/children/$child_id/exit.code"',
      `  tmux -L "${tmuxSocketPrefix}\${TENANT_ID}" kill-session -t "builder-child-$child_id" 2>/dev/null || true`,
      '  echo "[builder-child] $child_id status=TIMEOUT exit=124 finished_at=$(date -Iseconds)" >> "$BUILDER_DIR/' + stdoutLog + '"',
      '  echo "TIMEOUT"',
      '  return 124',
      '}',
      'builder_child_output() {',
      '  local child_pid="$1"',
      '  local child_id',
      '  child_id="$(builder_child_id_for_pid "$child_pid" 2>/dev/null || true)"',
      '  [ -z "$child_id" ] && echo "NOT_FOUND" && return',
      '  [ -f "$BUILDER_DIR/children/$child_id/stdout.log" ] && tail -200 "$BUILDER_DIR/children/$child_id/stdout.log"',
      '  [ -f "$BUILDER_DIR/children/$child_id/stderr.log" ] && tail -200 "$BUILDER_DIR/children/$child_id/stderr.log"',
      '  return 0',
      '}',
      'builder_child_kill() {',
      '  local child_pid="$1"',
      '  local child_id',
      '  child_id="$(builder_child_id_for_pid "$child_pid" 2>/dev/null || true)"',
      `  [ -n "$child_id" ] && tmux -L "${tmuxSocketPrefix}\${TENANT_ID}" kill-session -t "builder-child-$child_id" 2>/dev/null || kill "$child_pid" 2>/dev/null`,
      '  if [ -n "$child_id" ]; then',
      '    echo "FAILED" > "$BUILDER_DIR/children/$child_id/status"',
      '    echo "143" > "$BUILDER_DIR/children/$child_id/exit.code"',
      '    echo "[builder-child] $child_id status=FAILED exit=143 finished_at=$(date -Iseconds)" >> "$BUILDER_DIR/' + stdoutLog + '"',
      '  fi',
      '  echo "killed"',
      '}',
      '# ── End helpers ─────────────────────────────────────────────────────────────',
    ].join("\n");
  }

  const childHelpers = buildChildHelpersScript();

  // Write prompt, helpers, and continuation context files directly from Node.js.
  // This avoids shell heredoc injection: if these strings contain the heredoc
  // sentinel on a line by itself, the shell script would terminate early.
  const promptFilePath = join(dir, promptFile);
  writeFileSync(promptFilePath, prompt, { encoding: "utf8" });
  writeFileSync(join(dir, "builder-child-helpers.sh"), childHelpers, { encoding: "utf8" });
  if (continuationContext && continuationContextFile) {
    writeFileSync(continuationContextFile, continuationContext, { encoding: "utf8" });
  }

  const secretExportBlock = (() => {
    if (!secrets || Object.keys(secrets).length === 0) return "";
    const lines: string[] = [];
    for (const [name, value] of Object.entries(secrets)) {
      const safe = value.replace(/'/g, "'\\''");
      lines.push(`export ${name}='${safe}'`);
    }
    return lines.join("\n") + "\n";
  })();

  const script = `#!/bin/bash
set -euo pipefail
BUILDER_DIR="${dir}"
RUN_ID="${runId}"
BUILDER_PROJECT_ROOT="${workflow.projectRoot}"
BUILDER_PROMPT_FILE="$BUILDER_DIR/${promptFile}"
TENANT_ID="${workflow.tenantId ?? "mimule"}"
export BUILDER_DIR RUN_ID BUILDER_PROJECT_ROOT BUILDER_PROMPT_FILE TENANT_ID
export PATH=${shellQuote(process.env.PATH ?? "")}
EXIT_CODE=143
trap 'echo "$EXIT_CODE" > "$BUILDER_DIR/pass-${passNumber}-exit.code"' EXIT
mkdir -p "$BUILDER_DIR/children" "$BUILDER_DIR/bin"
${secretExportBlock}echo "[builder] Pass ${passNumber} starting at $(date -Iseconds)" | tee "$BUILDER_DIR/${stdoutLog}"
echo "[builder] Agent: ${agent}, Model: ${model ?? "default"}" >> "$BUILDER_DIR/${stdoutLog}"
echo "[builder] Project: ${workflow.projectRoot}" >> "$BUILDER_DIR/${stdoutLog}"
echo "[builder] Plan: ${workflow.planFile}" >> "$BUILDER_DIR/${stdoutLog}"
echo "[builder] Timeout: ${PASS_TIMEOUT_SECONDS}s" >> "$BUILDER_DIR/${stdoutLog}"
echo "[builder] Prompt: $BUILDER_PROMPT_FILE ($(wc -c < "$BUILDER_PROMPT_FILE") bytes)" >> "$BUILDER_DIR/${stdoutLog}"
source "$BUILDER_DIR/builder-child-helpers.sh"
export -f builder_child_id_for_pid builder_spawn_child builder_child_status builder_child_wait builder_child_output builder_child_kill
export BASH_ENV="$BUILDER_DIR/builder-child-helpers.sh"
for helper in builder_spawn_child builder_child_status builder_child_wait builder_child_output builder_child_kill; do
  cat > "$BUILDER_DIR/bin/$helper" << 'BUILDER_HELPER_WRAPPER_EOF'
#!/bin/bash
set -euo pipefail
source "$BUILDER_DIR/builder-child-helpers.sh"
"$(basename "$0")" "$@"
BUILDER_HELPER_WRAPPER_EOF
  chmod +x "$BUILDER_DIR/bin/$helper"
done
export PATH="$BUILDER_DIR/bin:$PATH"
echo "[builder] Child helper commands installed in $BUILDER_DIR/bin" >> "$BUILDER_DIR/${stdoutLog}"
${continuationBlock}set +e
${timedCommand} >> "$BUILDER_DIR/${stdoutLog}" 2>> "$BUILDER_DIR/pass-${passNumber}-stderr.log"
EXIT_CODE=$?
set -e
if [ $EXIT_CODE -eq 124 ]; then
  echo "[builder] Pass ${passNumber} TIMEOUT after ${PASS_TIMEOUT_SECONDS}s at $(date -Iseconds)" >> "$BUILDER_DIR/${stdoutLog}"
else
  echo "[builder] Pass ${passNumber} finished with exit code $EXIT_CODE at $(date -Iseconds)" >> "$BUILDER_DIR/${stdoutLog}"
fi
echo "$EXIT_CODE" > "$BUILDER_DIR/pass-${passNumber}-exit.code"
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
  if (!isBuilderProjectRootAllowlisted(workflow.projectRoot)) {
    throw new Error(`project root is not allowlisted: ${workflow.projectRoot}`);
  }
  const validationProfileBlockers = getValidationProfileStartBlockers(workflow.projectRoot, {
    mode: workflow.mode,
    trigger,
    maxPasses: workflow.config.riskPolicy?.maxPasses,
    agentCount: workflow.config.agentOrder.length,
  });
  if (validationProfileBlockers.length > 0) {
    throw new Error(`project-local validation profile required: ${validationProfileBlockers.join("; ")}`);
  }
  const planSanityBlockers = getPlanSanityStartBlockers(workflow.planFile);
  if (planSanityBlockers.length > 0) {
    throw new Error(`plan sanity check failed: ${planSanityBlockers.join("; ")}`);
  }
  const STARTABLE_STATUSES = new Set(["ready", "draft", "paused", "done", "failed", "blocked"]);
  if (!STARTABLE_STATUSES.has(workflow.status)) {
    throw new Error(`workflow cannot be started from status ${workflow.status}`);
  }
  // Expand any "group:<name>" token into the verified agentic roster before model selection.
  expandModelGroupsInPlace(workflow.config);
  // Determine agent/model from first agent order entry
  const entry = parseAgentEntry(workflow.config.agentOrder[0] ?? "codex");
  const agent = entry.agent;
  const isCliAgent = ["codex", "claude", "gemini", "opencode"].includes(agent);
  const embeddedModel = entry.model;
  const embeddedEffort = entry.effort;
  const selection = isCliAgent && embeddedModel
    ? { model: embeddedModel, provider: agent, reason: `embedded:${agent}:${embeddedModel}`, role: "planner" as const, capability: null, qualityStatus: "healthy" as const }
    : selectModelForRole("planner", workflow.config, agent);
  const { model, provider, reason: modelReason } = selection;

  // Create run
  const run = createBuilderRun(workflowId, trigger, actor);

  // Phase 5: create orchestrator instance for the run
  const orchestratorInstanceId = createOrchestratorInstance(run.id, workflowId);

  // 4-eyes approval gate: if workflow requires two approvers and not already approved trigger, enter pending-approval
  if (workflow.config.requiresTwoApprovers && trigger !== "approved") {
    const { tenantId } = getCurrentTenantContext();
    const requiredCount = workflow.config.requiredApproverCount ?? 2;
    const expiresAt = workflow.config.approvalExpiresAtMs
      ? Date.now() + workflow.config.approvalExpiresAtMs
      : undefined;
    createApprovalRequest(workflowId, run.id, actor, requiredCount, expiresAt);
    updateBuilderRun(run.id, { status: "pending-approval" });
    updateBuilderWorkflowStatus(workflowId, "pending-approval");
    return run;
  }

  // Acquire lock
  if (!acquireProjectLock(workflow.projectRoot, workflowId, run.id, actor, run.tenantId)) {
    // Rollback run
    updateBuilderRun(run.id, { status: "failed", finishedAt: now(), error: "project locked by another run" });
    updateBuilderWorkflowStatus(workflowId, "blocked");
    throw new Error("project is locked by another run");
  }

  // Create pass - specialized modes get explicit phases in the run ledger.
  const phase = workflow.mode === "doctor" ? "doctor" : workflow.mode === "plan" ? "plan-file" : "plan";
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

  // Load secrets for this pass (for env var injection + redaction)
  const secrets = loadSecretsForPass(workflow);

  // Create job
  const jobId = `job_${randomUUID()}`;
  const scriptPath = writePassScript(run.id, workflow, agent, model, 1, undefined, embeddedEffort, secrets);
  createJob({
    id: jobId,
    kind: "builder.agent-pass",
    status: "running",
    actor,
    reason: `builder workflow ${workflow.name} pass 1`,
    targetType: "builder-run",
    targetId: run.id,
    command: scriptPath,
    request: { workflowId, runId: run.id, passId, agent, model, effort: embeddedEffort },
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
    path: join(resolveRunDir(run.tenantId, workflow.projectId, run.id), "pass-1-stdout.log"),
  });
  const stderrArtifact = createBuilderArtifact({
    workflowId,
    runId: run.id,
    passId,
    kind: "stderr",
    path: join(resolveRunDir(run.tenantId, workflow.projectId, run.id), "pass-1-stderr.log"),
  });
  updateBuilderPass(passId, { artifactIds: [scriptArtifact, stdoutArtifact, stderrArtifact] });

  // Spawn tmux
  const session = tmuxSessionName(workflow.tenantId, run.id, 1);
  const socket = tmuxSocket(workflow.tenantId);
  tmuxEnsureServer(socket);
  const spawnResult = spawnSync("tmux", ["-L", socket, "new-session", "-d", "-s", session, "-c", workflow.projectRoot, scriptPath], {
    encoding: "utf8",
  });

  if (spawnResult.status !== 0) {
    const error = spawnResult.stderr || `tmux spawn failed (exit ${spawnResult.status})`;
    updateBuilderPass(passId, { status: "failed", finishedAt: now(), error });
    updateBuilderRun(run.id, { status: "failed", finishedAt: now(), error, currentPassId: null });
    finishJob(jobId, "failed", { error });
    releaseProjectLock(workflow.projectRoot, workflow.tenantId);
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
  const socket = tmuxSocket(run.tenantId);
  const passes = readBuilderPasses(runId);
  for (const pass of passes) {
    const session = tmuxSessionName(run.tenantId, runId, pass.sequence);
    if (tmuxExists(socket, session)) {
      tmuxKill(socket, session);
    }
    // Kill child tmux sessions for this run only.
    const childPattern = `builder-child-${runId}_`;
    try {
      const listResult = spawnSync("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
      const childSessions = (listResult.stdout ?? "").split(/\r?\n/).filter((s) => s.startsWith(childPattern));
      for (const childSession of childSessions) {
        tmuxKill(socket, childSession);
      }
    } catch { /* ignore */ }
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
    releaseProjectLock(workflow.projectRoot, workflow.tenantId);
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

// Provider/agent fatal errors that can accompany a clean (exit 0) shell exit — the CLI
// prints the error then returns 0 (observed: opencode "Insufficient balance" → exit 0).
// Without this, the run is falsely marked success despite the agent doing no work.
// Scanned against STDERR ONLY (the agent's own error channel): stdout carries the plan
// transcript and generated app code, which for some domains legitimately contains phrases
// like "insufficient balance" (e.g. a wallet feature) and must not trigger a false failure.
// An agent (esp. a flaky free model) sometimes hallucinates a sandbox / permission block and
// exits 0 without doing any work, asking to "add the directory to the allowed list" or "move the
// project". Counting these as success is what poisoned the continuation context (each refusal got
// echoed forward, training the model to keep refusing). Detect them so the pass FAILS instead.
function detectAgentRefusal(stdout: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/not (within|in) the (list of )?(paths|allowed[- ]?director)/i, "agent refusal: false allowed-dir claim"],
    [/isn.?t (in|within|among) the (list of )?(paths|allowed)/i, "agent refusal: false allowed-dir claim"],
    [/add .{0,40}? to the allowed[- ]?director/i, "agent refusal: asked to add allowed dir"],
    [/access restrictions prevent/i, "agent refusal: claimed access restrictions"],
    [/(cannot|can.?t|unable to) (read or modify|access|inspect) .{0,40}?(project|files|director|codebase)/i, "agent refusal: claimed cannot access project"],
    [/move .{0,30}?project .{0,40}?(permitted|allowed) location/i, "agent refusal: asked to move project"],
    [/only .{0,30}?\/opt\/ai-vault.{0,20}?(is )?(allowed|permitted)/i, "agent refusal: false ai-vault-only claim"],
    // Conservative "ask the operator instead of building" refusals on a greenfield app.
    [/confirm (the )?intended structure/i, "agent refusal: asked operator to confirm structure"],
    [/clarify .{0,30}?(testing )?expectations/i, "agent refusal: asked operator to clarify"],
    [/provide guidance on where/i, "agent refusal: asked operator for guidance"],
    [/cannot safely (add|implement|proceed|create)/i, "agent refusal: 'cannot safely' build"],
    [/without .{0,40}?(scaffolding|starting point|existing code|guidance).{0,60}?(cannot|can.?t|unable)/i, "agent refusal: 'no scaffolding so cannot build'"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(stdout)) return label;
  }
  return null;
}

function detectAgentFatalError(stderr: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/insufficient balance/i, "provider billing: insufficient balance"],
    [/manage your billing/i, "provider billing error"],
    [/credit balance is too low/i, "provider billing: credit balance too low"],
    [/\bout of credits\b|no credits remaining/i, "provider billing: out of credits"],
    [/invalid[_ ]api[_ ]key/i, "auth: invalid API key"],
    [/no api key (was )?(provided|configured|set)|missing api key/i, "auth: missing API key"],
    [/you exceeded your current quota|quota exceeded|quota exhausted/i, "provider quota exceeded"],
    [/no endpoints found (for|matching)/i, "model unavailable: no endpoints"],
    [/ProviderModelNotFoundError|\bmodel not found\b|unknown model\b|no such model/i, "model not found / misconfigured"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(stderr)) return label;
  }
  return null;
}

export async function reconcileRunStatus(runId: string): Promise<BuilderRun | null> {
  const run = readBuilderRun(runId);
  if (!run || run.status !== "running") return run;

  // Look up current pass to get its sequence number
  const passId = run.currentPassId;
  const allPasses = passId ? readBuilderPasses(runId) : [];
  const currentPass = allPasses.find((p) => p.id === passId);
  const passSeq = currentPass?.sequence ?? 1;

  // Ensure this run has a traceId; stamp on first reconcile
  if (!run.traceId) {
    const traceId = randomUUID();
    updateBuilderRun(runId, { traceId });
    const runSpan = startSpan("run", { runId, workflowId: run.workflowId, trigger: run.trigger }, null, traceId);
    endSpan(runSpan.spanId, "ok");
    if (passId) {
      updateBuilderPass(passId, { traceId });
      const passSpan = startSpan("pass", { passId, runId, sequence: passSeq }, null, traceId);
      endSpan(passSpan.spanId, "ok");
    }
  }

  const workflow = readBuilderWorkflow(run.workflowId);
  const socket = tmuxSocket(run.tenantId);

  const session = tmuxSessionName(run.tenantId, runId, passSeq);
  const sessionExists = tmuxExists(socket, session);
  if (sessionExists) {
    const paneOutput = tmuxCapturePane(socket, session);
    if (paneOutput) {
      updateJobOutputForRun(runId, paneOutput);
    }

    // ── Stall detection ──────────────────────────────────────────────────
    const stdoutPath = join(resolveRunDir(run.tenantId, workflow?.projectId ?? null, runId), `pass-${passSeq}-stdout.log`);
    const stderrPath = join(resolveRunDir(run.tenantId, workflow?.projectId ?? null, runId), `pass-${passSeq}-stderr.log`);
    const checkedAt = now();
    const resultObj = typeof run.result === "object" && run.result
      ? run.result as Record<string, unknown>
      : {};
    const monitor = typeof resultObj.runnerMonitor === "object" && resultObj.runnerMonitor
      ? resultObj.runnerMonitor as Record<string, unknown>
      : {};
    const lastOutputSize = typeof monitor.lastOutputSize === "number"
      ? monitor.lastOutputSize
      : null;
    const lastOutputAt = typeof monitor.lastOutputAt === "number"
      ? monitor.lastOutputAt
      : (run.startedAt ?? checkedAt);
    let currentSize = 0;
    try {
      if (existsSync(stdoutPath)) currentSize += statSync(stdoutPath).size;
      if (existsSync(stderrPath)) currentSize += statSync(stderrPath).size;
    } catch { /* ignore */ }
    const recordedExitCode = readExitCode(run.tenantId, workflow?.projectId ?? null, runId, passSeq);
    const paneHasChild = tmuxPaneHasChildProcess(socket, session);
    const noChildSince = typeof monitor.noChildSince === "number"
      ? monitor.noChildSince
      : null;
    const STALE_PANE_GRACE_MS = 15_000;
    if (recordedExitCode !== null) {
      console.log(`[builder] run ${runId} pass ${passSeq} finished but tmux session still exists; finalizing recorded exit ${recordedExitCode}`);
      tmuxKill(socket, session);
    } else if (!paneHasChild) {
      const firstNoChildAt = noChildSince ?? checkedAt;
      const staleForMs = checkedAt - firstNoChildAt;
      if (staleForMs > STALE_PANE_GRACE_MS) {
        console.error(`[builder] run ${runId} pass ${passSeq} has stale tmux session with no child process for ${staleForMs}ms; finalizing as interrupted`);
        try {
          appendFileSync(stdoutPath, `\n[builder-warn] Tmux session had no child process for ${Math.round(staleForMs / 1000)}s; finalizing pass as interrupted.\n`);
        } catch { /* ignore */ }
        tmuxKill(socket, session);
        killDetachedRunProcesses(runId);
      } else {
        updateBuilderRun(runId, {
          result: {
            ...resultObj,
            runnerMonitor: {
              ...monitor,
              lastOutputSize: currentSize,
              lastOutputAt,
              passSeq,
              noChildSince: firstNoChildAt,
            },
          },
        });
        return run;
      }
    } else if (noChildSince !== null) {
      updateBuilderRun(runId, {
        result: {
          ...resultObj,
          runnerMonitor: {
            ...monitor,
            lastOutputSize: currentSize,
            lastOutputAt,
            passSeq,
            noChildSince: undefined,
          },
        },
      });
    }

    if (recordedExitCode === null && !paneHasChild && noChildSince !== null && checkedAt - noChildSince > STALE_PANE_GRACE_MS) {
      // Fall through to the normal completion path below. There is no exit code,
      // so it will be classified as an interrupted run instead of wedging.
    } else if (recordedExitCode !== null) {
      // Fall through to the normal completion path below with the recorded exit.
    } else {
    const STALL_WARN_MS = 5 * 60 * 1000; // 300s — warn but don't kill yet
    const STALL_THRESHOLD_MS = (workflow?.config.riskPolicy?.stallTimeoutSeconds ?? workflow?.config.riskPolicy?.passTimeoutSeconds ?? 900) * 1000;
    const outputChanged = lastOutputSize === null || currentSize !== lastOutputSize;
    const outputAgeMs = checkedAt - (outputChanged ? checkedAt : lastOutputAt);
    const warnedStall = monitor.warnedStall === true;
    if (!outputChanged && outputAgeMs > STALL_WARN_MS && !warnedStall) {
      const warnSecs = Math.round(STALL_WARN_MS / 1000);
      const killSecs = Math.round(STALL_THRESHOLD_MS / 1000);
      console.log(`[builder] [warn] run ${runId} pass ${passSeq} — no output for ${warnSecs}s. Will kill at ${killSecs}s.`);
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs");
        appendFileSync(stdoutPath, `\n[builder-warn] No output for ${warnSecs}s — agent may be stalled. Will kill at ${killSecs}s.\n`);
      } catch { /* ignore */ }
      updateBuilderRun(runId, { result: { ...resultObj, runnerMonitor: { ...monitor, lastOutputSize: currentSize, lastOutputAt: outputChanged ? checkedAt : lastOutputAt, passSeq, warnedStall: true } } });
    }
    if (!outputChanged && outputAgeMs > STALL_THRESHOLD_MS) {
      // No output growth and past timeout — kill as stalled
      console.error(`[builder] run ${runId} pass ${passSeq} STALLED (no output change for >${STALL_THRESHOLD_MS}ms, outputAge=${outputAgeMs}ms)`);
      tmuxKill(socket, session);
      updateBuilderPass(passId!, { status: "failed", finishedAt: now(), failureClass: "agent-stalled", error: `Stalled: no output change for ${Math.round(STALL_THRESHOLD_MS / 1000)}s` });
      updateBuilderRun(runId, { status: "failed", finishedAt: now(), error: `Stalled: no output change for ${Math.round(STALL_THRESHOLD_MS / 1000)}s`, currentPassId: null });
      finishJobByRun(runId, "failed", { error: "stalled" });
      if (workflow) {
        releaseProjectLock(workflow.projectRoot, workflow.tenantId);
        updateBuilderWorkflowStatus(run.workflowId, "failed");
      }
      return readBuilderRun(runId);
    }
    // Persist size for next reconciliation check
    try {
      updateBuilderRun(runId, {
        result: {
          ...resultObj,
          runnerMonitor: {
            ...monitor,
            lastOutputSize: currentSize,
            lastOutputAt: outputChanged ? checkedAt : lastOutputAt,
            passSeq,
          },
        },
      });
    } catch { /* ignore */ }

    // ── Child agent reconciliation ────────────────────────────────────────
    const manifestPath = join(runDir(runId), "children-manifest.jsonl");
    if (existsSync(manifestPath)) {
      try {
        const manifestLines = readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean);
        for (const line of manifestLines) {
          try {
            const entry = JSON.parse(line) as { id: string; agent: string; model: string; pid: string; spawnedAt: string };
            const childSession = `builder-child-${entry.id}`;
            if (tmuxExists(socket, childSession)) {
              // Child still running — check for timeout
              const childAgeMs = now() - new Date(entry.spawnedAt).getTime();
              const childTimeoutMs = 600_000; // 10 min default child timeout
              if (childAgeMs > childTimeoutMs) {
                console.error(`[builder] child ${entry.id} timed out after ${childAgeMs}ms`);
                tmuxKill(socket, childSession);
                const childDir = join(runDir(runId), "children", entry.id);
                writeFileSync(join(childDir, "status"), "TIMEOUT");
                writeFileSync(join(childDir, "exit.code"), "124");
              }
            }
          } catch { /* ignore malformed line */ }
        }
      } catch { /* ignore missing manifest */ }
    }

    return run;
    }
  }

  // Tmux session is gone — process finished.
  // Re-read from DB: another reconciler tick may have already handled this run
  // (race between concurrent ticks) and we must not overwrite its result.
  const freshCheck = readBuilderRun(runId);
  if (!freshCheck || freshCheck.status !== "running") return freshCheck;

  const projectId = workflow?.projectId ?? null;
  const exitCode = readExitCode(run.tenantId, projectId, runId, passSeq);
  const ts = now();

  // Capture final output using pass-specific filenames
  const stdout = readLogFile(run.tenantId, projectId, runId, `pass-${passSeq}-stdout.log`);
  const stderr = readLogFile(run.tenantId, projectId, runId, `pass-${passSeq}-stderr.log`);
  const codexOutput = readLogFile(run.tenantId, projectId, runId, "codex-output.txt");

  // Apply secret redaction to stdout before any processing
  if (workflow?.config.secretNames?.length) {
    try {
      const secrets = loadSecretsForPass(workflow);
      const redacted = redactSecrets(stdout, secrets);
      const redactedPath = join(resolveRunDir(run.tenantId, projectId, runId), `pass-${passSeq}-stdout.log`);
      if (redacted !== stdout) {
        writeFileSync(redactedPath, redacted, { encoding: "utf8" });
      }
    } catch (e) {
      console.error("[builder] secret redaction failed:", e);
    }
  }

  // Detect codex exhaustion from stdout (codex CLI prints this to stdout)
  const codexExhausted =
    stdout.includes("hit your usage limit") || stdout.includes("usage limit") ||
    stderr.includes("hit your usage limit");

  // Detect OOM from stdout/stderr (Linux OOM killer messages)
  const oomIndicators = /out of memory|killed process|oom-kill|cannot allocate memory/i;
  const agentOom = exitCode === 137 && (oomIndicators.test(stdout) || oomIndicators.test(stderr));

  // A clean exit (0) is not proof of success: some CLIs print a fatal provider error
  // (billing/auth/quota) and still return 0. Treat those as failures.
  const agentFatalError = exitCode === 0
    ? (detectAgentFatalError(stderr) ?? detectAgentFatalError(stdout) ?? detectAgentRefusal(stdout))
    : null;

  if (passId) {
    const passStatus = exitCode === 0 && !agentFatalError ? "success" : "failed";
    const passAgent = currentPass?.agent ?? "";
    const rawSummary = codexOutput || stdout;
    const summary = passAgent === "claude"
      ? parseClaudeStreamJson(rawSummary)
      : rawSummary.slice(-2000);
    const passResult = readPassResult(run.tenantId, projectId, runId, passSeq);
    const passResultStatus = passResult?.status ?? null;
    const failureClass = codexExhausted
      ? "codex-exhausted"
      : exitCode === 124
      ? "pass-timeout"
      : agentOom
      ? "agent-oom"
      : exitCode === 137
      ? "agent-killed"
      : exitCode === 143
      ? "agent-stalled"
      : exitCode === null
      ? "no-result-file"
      : agentFatalError
      ? "agent-error"
      : exitCode === 0 && passResultStatus === "incomplete"
      ? "plan-incomplete"
      : exitCode === 0
      ? null
      : "unknown";
    updateBuilderPass(passId, {
      status: passStatus,
      finishedAt: ts,
      summary: summary || null,
      failureClass,
    });

    if (isNonGatewayCliLane(passAgent)) {
      try {
        recordRunnerUsage({
          agentKind: passAgent,
          sessionOrRunId: runId,
          detail: `passSeq=${passSeq} exitCode=${exitCode ?? "null"} status=${passStatus} failureClass=${failureClass ?? "none"}`,
          traceId: currentPass?.traceId ?? run.traceId ?? undefined,
        });
      } catch (e) {
        console.error("[builder] recordRunnerUsage failed:", e);
      }
    }

    if (passId) {
      try {
        extractPassAnalytics(run.tenantId, projectId, runId, passId, passSeq, run.startedAt ?? null, ts);
      } catch (err) {
        console.error("[builder] extractPassAnalytics failed:", err);
      }
    }

    if (passStatus === "failed" && passId) {
      try { queueDiagnosis(passId, runId, run.workflowId); } catch (e) { console.error("[builder] queueDiagnosis failed:", e); }
      if (workflow?.config.autoApplySafePlaybooks && failureClass && isDashboardDbEnabled()) {
        const db = getDashboardDb()!;
        try {
          const playbook = matchPlaybook(db, failureClass);
          if (playbook?.isSafe) {
            const results: string[] = [];
            for (const action of playbook.actions) {
              const r = await applyPlaybookAction(action, run.workflowId, runId, passId);
              results.push(r);
            }
            recordPlaybookRun(db, playbook.id, null, passId, "auto", playbook.actions, results.join(","));
            try { appendFileSync(join(runDir(runId), `pass-${passSeq}-stdout.log`), `\n[reasoner] auto-applied playbook "${playbook.name}" (${failureClass}): ${results.join(", ")}\n`); } catch { /* ignore */ }
          }
        } catch (e) { console.error("[builder] auto-playbook failed:", e); }
      }
    }
  }

  // Run validation commands if pass succeeded
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
  ) || (workflow ? detectBuildCommand(workflow.projectRoot) !== null : false);
  const allValidationsPassed = validationIds.length > 0 && validationIds.every((vid) => {
    const vs = readBuilderValidations(runId).find((v) => v.id === vid);
    return vs && vs.status === "success";
  });
  // A failing production build must never count as "done" — it should drive another pass
  // to fix the build break (the failure is surfaced to the next pass via continuation).
  const buildFailed = validationIds.some((vid) => {
    const vs = readBuilderValidations(runId).find((v) => v.id === vid);
    return vs ? vs.kind === "build" && vs.status !== "success" : false;
  });

  // Set when the plan file has 0 unchecked items — work is done, stop continuation
  // regardless of maxPasses or auto-continue mode.
  let planComplete = false;

  const checkPlanComplete = (planFile: string): boolean => {
    try {
      const planText = require("fs").readFileSync(planFile, "utf8") as string;
      return (planText.match(/^\s*- \[ \]/gm) ?? []).length === 0;
    } catch { return false; }
  };

  // Read PASS_RESULT.json to drive continuation decisions
  const passResult = readPassResult(runId, passSeq);
  const passResultStatus = passResult?.status ?? null;

  let runStatus: "success" | "failed" = "failed";
  if (exitCode === 0 && !agentFatalError) {
    runStatus = !hasValidationConfig || allValidationsPassed ? "success" : "failed";
    if (runStatus === "success" && workflow?.planFile) {
      planComplete = checkPlanComplete(workflow.planFile);
    }
  } else if (codexExhausted || exitCode === 143 || exitCode === 137) {
    // Agent exhausted or stalled: treat as success if the plan file shows all items checked.
    const planFile = workflow?.planFile;
    if (planFile && checkPlanComplete(planFile)) {
      runStatus = "success";
      planComplete = true;
    }
  }

  // Update failure classification for plan-complete passes
  if (passId && exitCode === 0 && planComplete && passResultStatus === "complete") {
    updateBuilderPass(passId, { failureClass: "plan-complete" });
  }

  // Build a human-readable error message (never raw stderr, which is agent terminal output)
  let runError: string | null = null;
  if (exitCode === null) {
    runError = "Run killed before completing (no exit code written)";
  } else if (codexExhausted) {
    runError = "Codex usage limit reached — retry after limit resets";
  } else if (agentFatalError) {
    runError = `Agent could not run: ${agentFatalError}`;
  } else if (exitCode !== 0) {
    runError = `Agent exited with code ${exitCode}`;
  } else if (runStatus === "failed" && !allValidationsPassed && validationIds.length > 0) {
    const failedVal = readBuilderValidations(runId).find(
      (v) => validationIds.includes(v.id) && v.status !== "success",
    );
    runError = failedVal
      ? `Validation failed: ${failedVal.command ?? "unknown command"}`
      : "Validation failed";
  }

  // Write clean error to pass record (never raw stdout/git diff)
  if (passId) {
    updateBuilderPass(passId, { error: runError ?? null });
  }

  // Correct the pass status to reflect validation, not just the exit code. The pass row was
  // marked "success" earlier when the agent merely exited 0, but a failing production-build
  // validation means the pass did NOT succeed — leaving it green misleads the operator and the
  // run-risk tiles. Downgrade to "failed" so status, error, and validations agree.
  if (passId && exitCode === 0 && runStatus === "failed") {
    const validationFailureClass = buildFailed ? "build-failed" : "validation-failed";
    updateBuilderPass(passId, {
      status: "failed",
      failureClass: validationFailureClass,
    });
    // The earlier queueDiagnosis() call (a few dozen lines up, guarded by
    // `passStatus === "failed"`) only fires when the AGENT PROCESS itself failed
    // (nonzero exit / fatal-error detection) — that check runs before validations
    // are executed. A pass that exits 0 but whose change breaks validation/build
    // never reached that branch, so this failureClass ("validation-failed" /
    // "build-failed") was silently never diagnosed: no reasoner_diagnoses row was
    // ever written for it, and mapReasonerBuildFindings() (server/insights/scanners/build.ts)
    // reads reasoner_diagnoses — not builder_passes — so the Insights Inbox never
    // surfaced these real failures and the built-in "validation-failed -> Surface to
    // operator" playbook (server/reasoner/playbooks.ts) could never be matched for
    // them either. Queue diagnosis here too so a validation-only failure is diagnosed
    // and reaches the inbox exactly like an agent-level failure does.
    try { queueDiagnosis(passId, runId, run.workflowId); } catch (e) { console.error("[builder] queueDiagnosis (validation-failed) failed:", e); }
  }

  // Determine continuation before writing final run state
  const AUTO_CONTINUE_MODES = new Set(["auto-continue", "scheduled", "permanent"]);

  // Fallback: when a reviewer/CLI agent is exhausted or times out, retry with a free opencode model
  // instead of failing the whole run. Only applies when there are remaining passes budget.
  const isPassTimeout = exitCode === 124;
  const isRecoverableFailure = runStatus === "failed" && (
    codexExhausted ||
    (isPassTimeout && passSeq >= (workflow?.config.agentOrder.length ?? 99))
  );
  const fallbackAgent = isRecoverableFailure && workflow && passSeq < workflow.config.riskPolicy.maxPasses
    ? (workflow.config.modelPolicy?.fallbackTargets ?? [])
        .find((t) => !t.startsWith("codex") && !t.startsWith("claude") && !t.startsWith("gemini"))
    : null;

  if (fallbackAgent && workflow && run) {
    // Retry this same logical pass with the fallback model, treating it as a new sequence slot
    const fallbackEntry = `opencode:${fallbackAgent}`;
    const overriddenOrder = [...(workflow.config.agentOrder ?? [])];
    // Append a fallback opencode entry so startNextPass picks it up
    overriddenOrder.splice(passSeq, 0, fallbackEntry);
    updateBuilderRun(runId, { currentPassId: null, error: null });
    void startNextPass(
      { ...workflow, config: { ...workflow.config, agentOrder: overriddenOrder } },
      run,
      passSeq + 1,
    );
    return;
  }

  // A pass-timeout means the agent ran out of time but may have made partial progress.
  // In auto-continue/once modes, allow continuation to the next pass rather than failing the run.
  const canContinueAfterTimeout = isPassTimeout && Boolean(workflow && (
    (AUTO_CONTINUE_MODES.has(workflow.mode) && passSeq < workflow.config.riskPolicy.maxPasses) ||
    (workflow.mode === "once" && passSeq < workflow.config.agentOrder.length)
  ));

  // Honor PASS_RESULT.json status for continuation decisions
  const canContinueFromResult = passResultStatus === "incomplete" && Boolean(
    workflow &&
    (
      (AUTO_CONTINUE_MODES.has(workflow.mode) && passSeq < workflow.config.riskPolicy.maxPasses) ||
      (workflow.mode === "once" && passSeq < workflow.config.agentOrder.length)
    ),
  );
  if (passResultStatus === "complete") {
    planComplete = true;
  }
  // A broken production build is never "done" — keep iterating to fix it.
  if (buildFailed) planComplete = false;

  // "once" mode runs all agentOrder passes exactly once; auto-continue/scheduled/permanent
  // keep going until maxPasses is reached or a pass fails.
  // Never continue when the plan file has 0 unchecked items — work is complete.
  const stopAfterPass = Boolean(
    run &&
    typeof run.result === "object" &&
    run.result &&
    (run.result as Record<string, unknown>).stopAfterPass === true,
  );
  let shouldContinue = Boolean(
    workflow &&
    !planComplete &&
    !stopAfterPass &&
    (runStatus === "success" || canContinueAfterTimeout || canContinueFromResult || buildFailed) &&
    (
      (AUTO_CONTINUE_MODES.has(workflow.mode) && passSeq < workflow.config.riskPolicy.maxPasses) ||
      (workflow.mode === "once" && passSeq < workflow.config.agentOrder.length)
    ),
  );

  // Pause guard: stop the run from digging deeper. If the recent tail of passes has made no real
  // progress — either repeated no-output timeouts, or the production build never recovering across
  // many passes — pause the workflow with a precise reason instead of churning to maxPasses.
  // A reasoner/operator can then diagnose, rather than burning the whole pass budget on a hang.
  let pauseReason: string | null = null;
  if (shouldContinue && workflow) {
    const CONSECUTIVE_TIMEOUT_LIMIT = 3; // N back-to-back no-output timeouts → pause
    const NO_BUILD_PROGRESS_LIMIT = 6;   // N passes where the build never went green → pause
    const validationPausePolicy = workflow.config.riskPolicy.pauseOnRepeatedValidationFailure;
    const tail = readBuilderPasses(runId)
      .filter((p) => p.sequence <= passSeq)
      .sort((a, b) => b.sequence - a.sequence);
    let timeoutStreak = 0;
    for (const p of tail) {
      if (p.failureClass === "pass-timeout" || p.error === "Agent exited with code 124") timeoutStreak++;
      else break;
    }
    if (validationPausePolicy?.enabled !== false) {
      pauseReason = repeatedValidationFailurePauseReason(
        tail,
        readBuilderValidations(runId),
        validationPausePolicy?.threshold ?? 3,
      );
    }
    if (!pauseReason && timeoutStreak >= CONSECUTIVE_TIMEOUT_LIMIT) {
      pauseReason = `${timeoutStreak} consecutive agent timeouts with no output — needs a reasoner/operator diagnosis before continuing.`;
    } else if (!pauseReason && buildFailed) {
      // Count trailing passes that never produced a green build.
      let brokenStreak = 0;
      for (const p of tail) {
        const vals = readBuilderValidations(runId).filter((v) => v.passId === p.id && v.kind === "build");
        const buildGreen = vals.length > 0 && vals.every((v) => v.status === "success");
        if (buildGreen) break;
        brokenStreak++;
      }
      if (brokenStreak >= NO_BUILD_PROGRESS_LIMIT) {
        pauseReason = `Production build has not recovered in ${brokenStreak} passes — pausing for diagnosis instead of advancing the roadmap on a broken baseline.`;
      }
    }
  }
  if (pauseReason && workflow && passId) {
    shouldContinue = false;
    updateBuilderPass(passId, { status: "blocked", failureClass: "paused-no-progress", error: pauseReason });
    updateBuilderRun(runId, { status: "blocked", finishedAt: ts, currentPassId: null, error: pauseReason });
    updateBuilderWorkflowStatus(workflow.id, "blocked");
    releaseProjectLock(workflow.projectRoot, workflow.tenantId);
    finishJobByRun(runId, "failed", { error: pauseReason });
    logToVault(workflow, run, passId, passSeq, "blocked");
    console.log(`[builder] run ${runId} PAUSED: ${pauseReason}`);
    return readBuilderRun(runId);
  }

  // Handle blocked status from PASS_RESULT.json
  if (passResultStatus === "blocked" && workflow) {
    const blockers = passResult?.blockers ?? [];
    const blockerReason = blockers.map((b) => b.reason).join("; ") || "Agent declared blocked (no reason given)";
    updateBuilderPass(passId!, {
      status: "blocked",
      finishedAt: ts,
      failureClass: "blocked",
      error: blockerReason,
    });
    updateBuilderRun(runId, {
      status: "blocked",
      finishedAt: ts,
      currentPassId: null,
      error: blockerReason,
    });
    updateBuilderWorkflowStatus(workflow.id, "blocked");
    releaseProjectLock(workflow.projectRoot, workflow.tenantId);
    finishJobByRun(runId, "failed", { error: blockerReason });
    logToVault(workflow, run, passId ?? null, passSeq, "blocked");
    return readBuilderRun(runId);
  }

  // Phase 5: advance orchestrator instance after pass completion
  const instanceId = run.orchestratorInstanceId || findInstanceByRunId(runId)?.id;
  if (instanceId) {
    try {
      const spawnPassResult: StepResult = exitCode === 0
        ? { status: "complete", output: { done: runStatus === "success" && !shouldContinue } }
        : { status: "failed", error: runError ?? `exit code ${exitCode}` };

      recordBuilderPassResult(instanceId, passSeq - 1, spawnPassResult);
    } catch (err) {
      console.error("[builder] recordBuilderPassResult failed:", err);
    }
  }

  if (!shouldContinue) {
    updateBuilderRun(runId, {
      status: runStatus,
      finishedAt: ts,
      currentPassId: null,
      error: runError,
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
      runError,
      exitCode,
      "builder-run",
      runId,
      "running",
    );
  } else {
    // Inter-pass: clear currentPassId so startNextPass can set the new one; keep run "running"
    updateBuilderRun(runId, { currentPassId: null, error: null });
  }

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
      releaseProjectLock(workflow.projectRoot, workflow.tenantId);
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
    logToVault(workflow, run, passId ?? null, passSeq, runStatus);
  }

  // Phase 6: start next pass if conditions are met
  if (shouldContinue && workflow) {
    try {
      await startNextPass(workflow, run, passSeq + 1);
      console.log(`[builder] started pass ${passSeq + 1} for run ${run.id}`);
    } catch (e) {
      console.error(`[builder] startNextPass failed:`, e);
      // Release lock and mark failed if we can't start the next pass
      releaseProjectLock(workflow.projectRoot, workflow.tenantId);
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

function finishJobByRun(runId: string, status: "success" | "failed" | "canceled", input: { output?: string; error?: string } = {}): void {
  const db = requireDb();
  try {
    db.query(`
      UPDATE jobs
      SET state = ?, status = ?, finished_at = ?, output_tail = COALESCE(?, output_tail), error = ?
      WHERE target_type = ? AND target_id = ? AND state = ?
    `).run(
      status, status, Date.now(),
      input.output === undefined ? null : input.output.slice(-8000),
      input.error ? input.error.slice(-2000) : null,
      "builder-run", runId, "running",
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

// A real production build catches errors that `tsc --noEmit` misses — e.g. Next.js
// App-Router "use client" violations, bundler/import resolution, framework config. We
// auto-detect and run it as a gating validation so the builder fixes build-breakers
// itself instead of shipping an app that typechecks but won't build/serve.
// Find the dir of the deployable web app by its framework config file. Building it directly
// is far more robust than `nx serve/build`, which crashes on the skewed @nx/* plugin versions
// generated apps tend to have.
function findFrameworkAppDir(projectRoot: string, configNames: string[]): string | null {
  const scan = (dir: string, depth: number): string | null => {
    if (depth > 3) return null;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return null; }
    if (configNames.some((c) => entries.includes(c))) return dir;
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      try { if (readdirSync(join(dir, e)).length) { const f = scan(join(dir, e), depth + 1); if (f) return f; } } catch { /* not a dir */ }
    }
    return null;
  };
  for (const base of ["apps", "packages", "."]) {
    const b = join(projectRoot, base);
    if (existsSync(b)) { const f = scan(b, 0); if (f) return f; }
  }
  return null;
}

export function detectBuildCommand(projectRoot: string): string | null {
  try {
    const profileBuildCommand = getBuildValidationCommand(projectRoot);
    if (profileBuildCommand) return `${profileBuildCommand} 2>&1`;
    // Prefer a direct production build of the web app — catches the same class of errors
    // (use-client, override modifiers, bundler/import resolution) without nx plugin fragility.
    const nextDir = findFrameworkAppDir(projectRoot, ["next.config.js", "next.config.mjs", "next.config.ts"]);
    if (nextDir) return `cd ${shellQuote(nextDir)} && npx next build 2>&1`;
    const viteDir = findFrameworkAppDir(projectRoot, ["vite.config.ts", "vite.config.js", "vite.config.mjs"]);
    if (viteDir) return `cd ${shellQuote(viteDir)} && npx vite build 2>&1`;
    if (existsSync(join(projectRoot, "nx.json"))) {
      // No detectable direct web app — let nx build everything (best-effort).
      return "npx nx run-many --target=build --exclude='*-e2e' --skip-nx-cache=false 2>&1";
    }
    const pkgPath = join(projectRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) return "npm run build 2>&1";
    }
  } catch { /* ignore */ }
  return null;
}

async function runBuildValidation(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  passId: string,
  projectRoot: string,
): Promise<string[]> {
  const command = detectBuildCommand(projectRoot);
  if (!command) return [];
  const vStarted = Date.now();
  let outputTail = "";
  let error: string | null = null;
  let status = "failed";
  try {
    const workDir = existsSync(projectRoot) ? projectRoot : "/tmp";
    const result = spawnSync("/bin/bash", ["-c", command], {
      encoding: "utf8",
      timeout: 420_000, // production builds routinely exceed the 120s internal limit
      cwd: workDir,
      env: { ...process.env, BUILDER_RUN_ID: run.id, CI: "1" },
      maxBuffer: 24 * 1024 * 1024,
    });
    outputTail = (result.stdout ?? "").slice(-6000);
    if (result.stderr) outputTail += "\n" + result.stderr.slice(-3000);
    if (result.status === 0) status = "success";
    else if (result.status === null) { error = "build timed out after 420s"; status = "timeout"; }
    else { error = `build failed (exit ${result.status})`; status = "failed"; }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    status = "error";
  }
  const vid = createValidationRow({
    workflowId: workflow.id,
    runId: run.id,
    passId,
    kind: "build",
    status,
    command,
    url: null,
    startedAt: vStarted,
    finishedAt: Date.now(),
    outputTail: outputTail || null,
    artifactId: null,
    error,
  });
  return [vid];
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

  // Phase 4: production build — auto-detected, gates "done" so build-breakers can't ship.
  const phase4 = await runBuildValidation(workflow, run, passId, projectRoot);
  validationIds.push(...phase4);

  // Phase 5: substance gate — a build can pass on hollow placeholder stubs. Reject those so
  // an agent can't mark a plan item [x] with "will be displayed here" / a near-empty view.
  const phase5 = runSubstanceValidation(workflow, run, passId, projectRoot);
  validationIds.push(...phase5);

  return validationIds;
}

// Placeholder phrases agents leave when they stub instead of build.
const HOLLOW_MARKERS =
  /(placeholder for now|will be (displayed|shown|added|implemented) here|content goes here|coming soon|todo:?\s*implement|not implemented( yet)?|lorem ipsum|replace (this|the elements)|your .{0,20} here)/i;

function runSubstanceValidation(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  passId: string,
  projectRoot: string,
): string[] {
  const startedAt = Date.now();
  let changed: string[] = [];
  try {
    const tracked = spawnSync("git", ["diff", "--name-only"], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 }).stdout ?? "";
    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 }).stdout ?? "";
    changed = [...tracked.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const SRC = /\.(tsx?|jsx?|vue|svelte)$/;
  const hollow: string[] = [];
  for (const rel of changed) {
    if (!SRC.test(rel) || /\.(spec|test|d)\.[tj]sx?$/.test(rel)) continue;
    let body = "";
    try {
      body = readFileSync(join(projectRoot, rel), "utf8");
    } catch {
      continue;
    }
    const code = body.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").trim();
    const isView = /(^|\/)(page|screen|view)\.[tj]sx?$/.test(rel) || /\/(pages|screens|views|app)\//.test(rel);
    if (HOLLOW_MARKERS.test(body)) hollow.push(`${rel} — contains placeholder text`);
    else if (isView && code.length < 160) hollow.push(`${rel} — near-empty view (${code.length} chars of code)`);
  }
  if (hollow.length === 0) return [];
  const id = createValidationRow({
    workflowId: workflow.id,
    runId: run.id,
    passId,
    kind: "substance",
    status: "error",
    command: null,
    url: null,
    startedAt,
    finishedAt: Date.now(),
    outputTail:
      "Deliverables are placeholders/stubs — implement REAL content; do NOT mark these items [x]:\n" +
      hollow.join("\n"),
    artifactId: null,
    error: `Substance gate: ${hollow.length} placeholder/stub file(s)`,
  });
  return [id];
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
  const runDirPath = join(builderStateRoot(), "builder-runs", run.id);
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

  // Service-up probe before running Playwright — skip tests entirely if the service is down
  const probeResult = spawnSync("curl", [
    "--max-time", "8", "--silent", "--show-error",
    "-o", "/dev/null", "-w", "%{http_code}",
    internalUrl,
  ], { encoding: "utf8", timeout: 12_000 });
  const probeCode = (probeResult.stdout ?? "").trim();
  if (!probeCode.startsWith("2") && !probeCode.startsWith("3")) {
    const vid = createValidationRow({
      workflowId: workflow.id, runId: run.id, passId,
      kind: "playwright", status: "failed",
      command: null, url: internalUrl,
      startedAt: Date.now(), finishedAt: Date.now(),
      outputTail: null,
      artifactId: null,
      error: `Service not reachable before Playwright (HTTP ${probeCode || "no response"})`,
    });
    return [vid];
  }

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
        env: { ...process.env, NODE_PATH: "/usr/lib/node_modules" },
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

export type FailureDiagnosis = {
  failureClass: string;
  title: string;
  whatHappened: string;
  lastActivity: string;
  likelyCause: string;
  suggestedActions: Array<"retry-narrow" | "retry-higher-timeout" | "retry-continue" | "edit-plan" | "view-stdout" | "pause-workflow">;
  evidence: string[];
  confidence: "high" | "medium" | "low";
};

export type StopReason =
  | "operator"
  | "timeout"
  | "stall"
  | "validation-failed"
  | "budget"
  | "error"
  | "plan-complete"
  | "blocked"
  | "codex-exhausted"
  | "agent-oom"
  | "agent-killed"
  | "unknown";

export type CostModelTraceEntry = {
  passId: string;
  passSequence: number;
  agent: string | null;
  model: string | null;
  provider: string | null;
  estimatedCostUsd: number | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
};

export function classifyFailureDiagnosis(pass: BuilderPass, stdoutTail: string): FailureDiagnosis {
  const fc = pass.failureClass ?? "unknown";
  const lastLines = stdoutTail.split("\n").filter((l) => l.trim()).slice(-5).join("\n");

  if (fc === "agent-stalled") {
    const exploring = /let me look|understand|exploring|checking/i.test(lastLines);
  return {
    failureClass: fc,
    title: "Agent Stalled",
    whatHappened: "No output for the stall timeout duration. Pass was killed.",
    lastActivity: lastLines.slice(-300),
    likelyCause: exploring
      ? "Agent began broad file exploration — model inference stalled or context filled"
      : "Model inference timeout or network issue",
    suggestedActions: ["retry-narrow", "retry-higher-timeout", "edit-plan"],
    evidence: [lastLines.slice(-500)],
    confidence: "medium" as const,
  };
  }
  if (fc === "pass-timeout") {
    return {
      failureClass: fc,
      title: "Pass Timeout",
      whatHappened: "Pass hit the hard timeout limit and was killed by the OS.",
      lastActivity: lastLines.slice(-300),
      likelyCause: "Plan has more work than fits in one pass — this is normal for large plans",
      suggestedActions: ["retry-continue", "retry-higher-timeout"],
      evidence: [lastLines.slice(-500)],
      confidence: "high" as const,
    };
  }
  if (fc === "validation-failed") {
    return {
      failureClass: fc,
      title: "Validation Failed",
      whatHappened: "The pass completed but one or more validation checks failed.",
      lastActivity: lastLines.slice(-300),
      likelyCause: "TypeScript errors, failing tests, or Playwright failures introduced by the agent",
      suggestedActions: ["retry-narrow", "view-stdout", "edit-plan"],
      evidence: [lastLines.slice(-500)],
      confidence: "high" as const,
    };
  }
  if (fc === "blocked") {
    return {
      failureClass: fc,
      title: "Agent Blocked",
      whatHappened: "The agent declared it cannot proceed without operator input.",
      lastActivity: lastLines.slice(-300),
      likelyCause: "Missing context, ambiguous instruction, or a dependency not in scope",
      suggestedActions: ["edit-plan", "retry-narrow"],
      evidence: [lastLines.slice(-500)],
      confidence: "high" as const,
    };
  }
  if (fc === "agent-oom") {
    return {
      failureClass: fc,
      title: "Agent OOM Killed",
      whatHappened: "The agent process was killed by the Linux OOM killer (out of memory).",
      lastActivity: lastLines.slice(-300),
      likelyCause: "Model context too large, memory leak in agent, or VPS memory exhausted",
      suggestedActions: ["retry-narrow", "retry-higher-timeout", "edit-plan"],
      evidence: [lastLines.slice(-500)],
      confidence: "high" as const,
    };
  }
  if (fc === "agent-killed") {
    return {
      failureClass: fc,
      title: "Agent Killed",
      whatHappened: "The agent process received SIGKILL (exit 137) from outside the runner.",
      lastActivity: lastLines.slice(-300),
      likelyCause: "Manual kill, Docker healthcheck, or host-level process management",
      suggestedActions: ["retry-continue", "view-stdout"],
      evidence: [lastLines.slice(-500)],
      confidence: "medium" as const,
    };
  }
  if (fc === "no-result-file") {
    return {
      failureClass: fc,
      title: "No Result File",
      whatHappened: "The pass ended without writing PASS_RESULT.json — the agent may have crashed or been killed before finishing.",
      lastActivity: lastLines.slice(-300),
      likelyCause: "Agent crash, OOM, or manual termination before result serialization",
      suggestedActions: ["retry-continue", "view-stdout", "retry-higher-timeout"],
      evidence: [lastLines.slice(-500)],
      confidence: "medium" as const,
    };
  }
  if (fc === "plan-incomplete") {
    return {
      failureClass: fc,
      title: "Plan Incomplete",
      whatHappened: "The agent exited cleanly but declared the pass incomplete — not all plan items were finished.",
      lastActivity: lastLines.slice(-300),
      likelyCause: "Agent ran out of context window, hit token limits, or the plan item was too large for one pass",
      suggestedActions: ["retry-continue", "edit-plan"],
      evidence: [lastLines.slice(-500)],
      confidence: "medium" as const,
    };
  }
  if (fc === "plan-complete") {
    return {
      failureClass: fc,
      title: "Plan Complete",
      whatHappened: "The pass succeeded and all plan items are checked off. Work is done.",
      lastActivity: lastLines.slice(-300),
      likelyCause: "Normal completion — no action needed.",
      suggestedActions: ["view-stdout"],
      evidence: [lastLines.slice(-500)],
      confidence: "high" as const,
    };
  }
  if (fc === "codex-exhausted") {
    return {
      failureClass: fc,
      title: "Codex Usage Limit",
      whatHappened: "The Codex agent hit its usage limit and could not continue.",
      lastActivity: lastLines.slice(-300),
      likelyCause: "Codex rate limit or quota exhausted — retry after limit resets",
      suggestedActions: ["retry-continue", "pause-workflow"],
      evidence: [lastLines.slice(-500)],
      confidence: "high" as const,
    };
  }
  return {
    failureClass: fc,
    title: "Pass Failed",
    whatHappened: pass.error ?? "The pass ended with an error status.",
    lastActivity: lastLines.slice(-300),
    likelyCause: "Check stdout for details",
    suggestedActions: ["view-stdout", "retry-narrow"],
    evidence: [lastLines.slice(-500)],
    confidence: "low" as const,
  };
}

export function classifyStopReason(run: BuilderRun): StopReason {
  if (!run.finishedAt) return "unknown";
  if (run.status === "canceled") return "operator";
  if (run.error?.includes("timeout")) return "timeout";
  if (run.error?.includes("stall")) return "stall";

  const passes = readBuilderPasses(run.id).sort((a, b) => a.sequence - b.sequence);
  const failedPasses = passes.filter(p => p.status === "failed");
  if (failedPasses.length > 0) {
    const lastPass = failedPasses[failedPasses.length - 1];
    if (lastPass?.failureClass === "validation-failed") return "validation-failed";
    if (lastPass?.failureClass === "agent-oom") return "agent-oom";
    if (lastPass?.failureClass === "agent-killed") return "agent-killed";
    if (lastPass?.failureClass === "blocked") return "blocked";
    if (lastPass?.failureClass === "codex-exhausted") return "codex-exhausted";
  }
  if (run.status === "success") {
    const allPassesSucceeded = passes.every(p => p.status === "success");
    if (allPassesSucceeded && passes.length > 0) return "plan-complete";
  }
  if (run.error) return "error";
  return "unknown";
}
