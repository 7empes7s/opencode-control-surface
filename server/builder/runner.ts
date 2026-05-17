import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, chmodSync, statSync, appendFileSync } from "node:fs";
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
} from "./store.ts";
import { selectModelForRole, type ModelRole } from "./modelSelector.ts";
import { runDoctorReview, writeDoctorReport } from "./doctor.ts";
import { getNextRunTime, isDue, getBackoffMs } from "./scheduler.ts";
import { readSecretPlaintext } from "../governance/secrets.ts";
import { createOrchestratorInstance, getOrchestratorInstance, findInstanceByRunId, recordBuilderPassResult } from "../orchestrator/adapter.ts";
import { createApprovalRequest, getApprovalRequest } from "../governance/approvals.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import type { StepResult } from "../orchestrator/types.ts";

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
  return `tib-${tenantId}`;
}

export { tmuxSocket };

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
    `| Artifacts | /var/lib/control-surface/builder-runs/${run.id}/ |`,
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
        .slice(0, 5)
        .map((l) => l.trim());
      if (unchecked.length > 0) {
        lines.push(`Next unchecked items: ${unchecked.join(" | ")}`);
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
  lines.push("1. Read ONLY the next 2-3 unchecked items from the plan (use grep, not full cat).");
  lines.push("2. Implement those items, then mark them [x] in the plan file.");
  lines.push("3. Run validation commands after changes (see contract above).");
  lines.push("4. End with a concise summary: what changed, what failed, what the next item is.");
  lines.push("Do NOT try to complete the whole plan in one pass.");

  return lines.join("\n");
}

async function startNextPass(
  workflow: BuilderWorkflow,
  run: BuilderRun,
  nextSequence: number,
): Promise<void> {
  const entry = parseAgentEntry(workflow.config.agentOrder[(nextSequence - 1) % workflow.config.agentOrder.length] ?? "codex");
  const agent = entry.agent;
  const isCliAgent = ["codex", "claude", "gemini"].includes(agent);
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
  const stdoutArtifact = createBuilderArtifact({ workflowId: workflow.id, runId: run.id, passId, kind: "stdout", path: join(runDir(run.id), `pass-${nextSequence}-stdout.log`) });
  const stderrArtifact = createBuilderArtifact({ workflowId: workflow.id, runId: run.id, passId, kind: "stderr", path: join(runDir(run.id), `pass-${nextSequence}-stderr.log`) });
  updateBuilderPass(passId, { artifactIds: [scriptArtifact, stdoutArtifact, stderrArtifact] });

  const session = tmuxSessionName(run.id, nextSequence);
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

export function readPassResult(runId: string, passSeq: number): PassResult | null {
  const path = join(runDir(runId), "PASS_RESULT.json");
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as PassResult;
  } catch {
    return null;
  }
}

function extractPassAnalytics(
  runId: string,
  passId: string,
  passSeq: number,
  startedAt: number | null,
  finishedAt: number,
): void {
  const result = readPassResult(runId, passSeq);
  if (!result) return;

  const durationMs = startedAt ? finishedAt - startedAt : null;

  const stdoutTail = (() => {
    try {
      const p = join(runDir(runId), `pass-${passSeq}-stdout.log`);
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

── BLOCKER PROTOCOL ─────────────────────────────────────────────────────────
- If a service is down and your task requires it: write PASS_RESULT.json with status="blocked"
- If a dependency is missing (import error for nonexistent package): write blocked + suggest fix
- If plan instructions are ambiguous for your item: write blocked + quote the ambiguous part
- Do NOT guess at blocked states — always declare and exit

── SCOPE DISCIPLINE (Minimal Diff) ─────────────────────────────────────────
- Only edit files required by your plan items
- Do not "clean up" or refactor passing code you didn't need to touch
- If you find a bug in adjacent code: log it in passNote but don't fix it
- Keep diffs minimal — reviewability matters
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
  const dir = runDir(runId);
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
    command = `opencode run --dir "$BUILDER_PROJECT_ROOT" --dangerously-skip-permissions${modelFlag} "$(cat "$BUILDER_PROMPT_FILE")"`;
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
      '  active_children=$(tmux list-sessions -F \'#{session_name}\' 2>/dev/null | grep -c "^builder-child-${RUN_ID}_" || true)',
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
      '    opencode run --dir "$BUILDER_PROJECT_ROOT" --dangerously-skip-permissions --model "$BUILDER_CHILD_MODEL" "$task"',
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
      `  tmux new-session -d -s "builder-child-$child_id" -c "${projectRoot}" "env PATH=\\"$PATH\\" BUILDER_DIR=\\"$BUILDER_DIR\\" BUILDER_CHILD_ID=\\"$child_id\\" BUILDER_CHILD_DIR=\\"$child_dir\\" BUILDER_CHILD_AGENT=\\"$child_agent\\" BUILDER_CHILD_MODEL=\\"$child_model\\" BUILDER_PROJECT_ROOT=\\"${projectRoot}\\" BUILDER_CHILD_PASS_LOG=\\"$BUILDER_DIR/${stdoutLog}\\" \\"$child_script\\""`,
      '  local child_pid=""',
      '  for _ in 1 2 3 4 5 6 7 8 9 10; do',
      '    if [ -s "$child_dir/pid" ]; then child_pid="$(cat "$child_dir/pid" 2>/dev/null)"; break; fi',
      '    sleep 0.1',
      '  done',
      '  if [ -z "$child_pid" ]; then',
      '    child_pid=$(tmux list-panes -t "builder-child-$child_id" -F \'#{pane_pid}\' 2>/dev/null | head -1)',
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
      '  if tmux has-session -t "builder-child-$child_id" 2>/dev/null; then',
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
      '    if ! tmux has-session -t "builder-child-$child_id" 2>/dev/null && [ -f "$BUILDER_DIR/children/$child_id/exit.code" ]; then',
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
      '  tmux kill-session -t "builder-child-$child_id" 2>/dev/null || true',
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
      '  [ -n "$child_id" ] && tmux kill-session -t "builder-child-$child_id" 2>/dev/null || kill "$child_pid" 2>/dev/null',
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
export BUILDER_DIR RUN_ID BUILDER_PROJECT_ROOT BUILDER_PROMPT_FILE
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
  const STARTABLE_STATUSES = new Set(["ready", "draft", "paused", "done", "failed", "blocked"]);
  if (!STARTABLE_STATUSES.has(workflow.status)) {
    throw new Error(`workflow cannot be started from status ${workflow.status}`);
  }

  // Determine agent/model from first agent order entry
  const entry = parseAgentEntry(workflow.config.agentOrder[0] ?? "codex");
  const agent = entry.agent;
  const isCliAgent = ["codex", "claude", "gemini"].includes(agent);
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
    createApprovalRequest(workflowId, run.id, tenantId, actor, requiredCount, expiresAt);
    updateBuilderRun(run.id, { status: "pending-approval" });
    updateBuilderWorkflowStatus(workflowId, "pending-approval");
    return run;
  }

  // Acquire lock
  if (!acquireProjectLock(workflow.projectRoot, workflowId, run.id, actor)) {
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
  const socket = tmuxSocket(run.tenantId);
  const passes = readBuilderPasses(runId);
  for (const pass of passes) {
    const session = tmuxSessionName(runId, pass.sequence);
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

  const session = tmuxSessionName(runId, passSeq);
  const sessionExists = tmuxExists(socket, session);
  if (sessionExists) {
    const paneOutput = tmuxCapturePane(socket, session);
    if (paneOutput) {
      updateJobOutputForRun(runId, paneOutput);
    }

    // ── Stall detection ──────────────────────────────────────────────────
    const stdoutPath = join(runDir(runId), `pass-${passSeq}-stdout.log`);
    const stderrPath = join(runDir(runId), `pass-${passSeq}-stderr.log`);
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
    const recordedExitCode = readExitCode(runId, passSeq);
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
    const STALL_THRESHOLD_MS = (workflow?.config.riskPolicy?.passTimeoutSeconds ?? 900) * 1000;
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
        releaseProjectLock(workflow.projectRoot);
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

  const exitCode = readExitCode(runId, passSeq);
  const ts = now();

  // Capture final output using pass-specific filenames
  const stdout = readLogFile(runId, `pass-${passSeq}-stdout.log`);
  const stderr = readLogFile(runId, `pass-${passSeq}-stderr.log`);
  const codexOutput = readLogFile(runId, "codex-output.txt");

  // Apply secret redaction to stdout before any processing
  if (workflow?.config.secretNames?.length) {
    try {
      const secrets = loadSecretsForPass(workflow);
      const redacted = redactSecrets(stdout, secrets);
      const redactedPath = join(runDir(runId), `pass-${passSeq}-stdout.log`);
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

  if (passId) {
    const passStatus = exitCode === 0 ? "success" : "failed";
    const passAgent = currentPass?.agent ?? "";
    const rawSummary = codexOutput || stdout;
    const summary = passAgent === "claude"
      ? parseClaudeStreamJson(rawSummary)
      : rawSummary.slice(-2000);
    const failureClass = codexExhausted
      ? "codex-exhausted"
      : exitCode === 124
      ? "pass-timeout"
      : exitCode === 143 || exitCode === 137
      ? "agent-stalled"
      : exitCode === null
      ? "unknown"
      : exitCode === 0
      ? null
      : "unknown";
    updateBuilderPass(passId, {
      status: passStatus,
      finishedAt: ts,
      summary: summary || null,
      failureClass,
    });

    if (passId) {
      try {
        extractPassAnalytics(runId, passId, passSeq, run.startedAt ?? null, ts);
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
  );
  const allValidationsPassed = validationIds.length > 0 && validationIds.every((vid) => {
    const vs = readBuilderValidations(runId).find((v) => v.id === vid);
    return vs && vs.status === "success";
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

  let runStatus: "success" | "failed" = "failed";
  if (exitCode === 0) {
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

  // Build a human-readable error message (never raw stderr, which is agent terminal output)
  let runError: string | null = null;
  if (exitCode === null) {
    runError = "Run killed before completing (no exit code written)";
  } else if (codexExhausted) {
    runError = "Codex usage limit reached — retry after limit resets";
  } else if (exitCode !== 0) {
    runError = `Agent exited with code ${exitCode}`;
  } else if (runStatus === "failed" && !allValidationsPassed && validationIds.length > 0) {
    const failedVal = readBuilderValidations(runId).find(
      (v) => v.status !== "success",
    );
    runError = failedVal
      ? `Validation failed: ${failedVal.command ?? "unknown command"}`
      : "Validation failed";
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

  // "once" mode runs all agentOrder passes exactly once; auto-continue/scheduled/permanent
  // keep going until maxPasses is reached or a pass fails.
  // Never continue when the plan file has 0 unchecked items — work is complete.
  const shouldContinue = Boolean(
    workflow &&
    !planComplete &&
    (runStatus === "success" || canContinueAfterTimeout) &&
    (
      (AUTO_CONTINUE_MODES.has(workflow.mode) && passSeq < workflow.config.riskPolicy.maxPasses) ||
      (workflow.mode === "once" && passSeq < workflow.config.agentOrder.length)
    ),
  );

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
    };
  }
  return {
    failureClass: fc,
    title: "Pass Failed",
    whatHappened: pass.error ?? "The pass ended with an error status.",
    lastActivity: lastLines.slice(-300),
    likelyCause: "Check stdout for details",
    suggestedActions: ["view-stdout", "retry-narrow"],
  };
}
