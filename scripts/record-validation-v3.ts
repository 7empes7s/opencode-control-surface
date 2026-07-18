#!/usr/bin/env bun

// Candidate-bound producer for the strict repair-arc verifier.  This command
// is intentionally not part of normal test runs: it creates a detached
// worktree and immutable operator receipts when explicitly invoked.
import {
  closeSync, chmodSync, chownSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, rmSync, writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { COMMAND_MAX_BUFFER_BYTES, DEFAULT_EVIDENCE_DIR, VALIDATION_COMMANDS } from "./verify-repair-arc.ts";
import { extractGetRoutes } from "../e2e/fresh-host/routeInventory.mjs";

const REPO = "/opt/opencode-control-surface";
const RECEIPT_ROOT = join(DEFAULT_EVIDENCE_DIR, "receipts");
const COMMAND_KEYS = ["focused", "typecheck", "build", "freshHost"] as const;
type CommandKey = typeof COMMAND_KEYS[number];

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function command(args: string[], cwd = REPO, env?: Record<string, string>): { exitCode: number; output: Buffer } {
  const result = Bun.spawnSync({
    cmd: args, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const output = Buffer.concat([Buffer.from(result.stdout), Buffer.from(result.stderr)]);
  return { exitCode: result.exitCode ?? 1, output: output.subarray(0, COMMAND_MAX_BUFFER_BYTES) };
}

function requiredCommand(args: string[], cwd = REPO): string {
  const result = command(args, cwd);
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.output.toString("utf8").slice(0, 300)}`);
  return result.output.toString("utf8").trim();
}

function ensureReceiptRoot(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true, mode: 0o755 });
  chmodSync(RECEIPT_ROOT, 0o755);
  chownSync(RECEIPT_ROOT, 0, 0);
  const stat = lstatSync(RECEIPT_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("receipt directory is not trustworthy");
}

function writeImmutable(name: string, bytes: Uint8Array): { path: string; sha256: string; bytes: number } {
  const path = join(RECEIPT_ROOT, name);
  const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o444);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
    chmodSync(path, 0o444);
    chownSync(path, 0, 0);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o222) !== 0) throw new Error(`immutable receipt check failed for ${name}`);
  } finally {
    closeSync(fd);
  }
  return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function processSnapshot(): Array<{ pid: number; argvSha256: string }> {
  const result = command(["ps", "-eo", "pid=,args="]);
  if (result.exitCode !== 0) throw new Error("process guard could not list processes");
  const forbidden = /\bcodex exec\b|opencode.*\bbuilder\b|\bmimule-jobd\b|\bproject-improve\b|\boverseer\b|\bautonomous-orchestrator\b/i;
  return result.output.toString("utf8").split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !forbidden.test(match[2]!)) return [];
    return [{ pid: Number(match[1]), argvSha256: sha256(match[2]!.replace(/\s+/g, " ").trim()) }];
  }).sort((a, b) => a.argvSha256.localeCompare(b.argvSha256) || a.pid - b.pid);
}

function sourceProof(worktree: string, commit: string, tree: string, allowedChanged: string[] = []): { head: string; tree: string; detached: boolean; clean: boolean } {
  const head = requiredCommand(["git", "-C", worktree, "rev-parse", "HEAD"]);
  const actualTree = requiredCommand(["git", "-C", worktree, "rev-parse", "HEAD^{tree}"]);
  const detached = command(["git", "-C", worktree, "symbolic-ref", "-q", "HEAD"]).exitCode !== 0;
  const changed = requiredCommand(["git", "-C", worktree, "diff", "--name-only", "HEAD", "--"])
    .split("\n").filter(Boolean).sort();
  return { head, tree: actualTree, detached, clean: head === commit && actualTree === tree && detached && JSON.stringify(changed) === JSON.stringify([...allowedChanged].sort()) };
}

function junitLooksUsable(path: string): boolean {
  try {
    const text = readFileSync(path, "utf8");
    return /<testsuites\b/.test(text) && /failures="0"/.test(text);
  } catch { return false; }
}

function structuredFreshReport(path: string, runId: string, commit: string, tree: string, startedAt: number, finishedAt: number): Buffer {
  try {
    const sidecar = JSON.parse(readFileSync(path, "utf8")) as { counts: unknown; results: unknown };
    return Buffer.from(JSON.stringify({ schemaVersion: 2, kind: "fresh-host-api-report", runId, candidateCommit: commit, candidateTree: tree,
      generatedAt: Math.min(Math.max(Date.now(), startedAt), finishedAt), counts: sidecar.counts, results: sidecar.results }));
  } catch {
    return Buffer.from(JSON.stringify({ schemaVersion: 2, kind: "fresh-host-api-report", runId, candidateCommit: commit, candidateTree: tree,
      generatedAt: finishedAt, counts: { HONEST: 0, LEAK: 0, CRASH: 0, "ERROR-5xx": 0 }, results: [] }));
  }
}

async function main(): Promise<number> {
  const commit = requiredCommand(["git", "-C", REPO, "rev-parse", "HEAD"]);
  const tree = requiredCommand(["git", "-C", REPO, "rev-parse", "HEAD^{tree}"]);
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree) || command(["git", "-C", REPO, "diff", "--quiet", "HEAD", "--"]).exitCode !== 0) throw new Error("main worktree is not tracked-clean");
  ensureReceiptRoot();
  const runId = randomUUID();
  const before = processSnapshot();
  const tempRoot = mkdtempSync(join(tmpdir(), "control-surface-validation-v3-"));
  const worktree = join(tempRoot, "candidate");
  const commands: Record<CommandKey, Record<string, unknown>> = {} as Record<CommandKey, Record<string, unknown>>;
  let after: Array<{ pid: number; argvSha256: string }> = [];
  let complete = false;
  try {
    requiredCommand(["git", "-C", REPO, "worktree", "add", "--detach", worktree, commit]);
    const initial = sourceProof(worktree, commit, tree);
    if (!initial.clean) throw new Error("detached candidate worktree is not at the requested tree");
    for (const key of COMMAND_KEYS) {
      const cleanBefore = sourceProof(worktree, commit, tree).clean;
      if (!cleanBefore) throw new Error(`candidate worktree is not clean before ${key}`);
      const junitPath = join(worktree, ".v3-focused.junit.xml");
      const argv = key === "focused" ? [...VALIDATION_COMMANDS.focused, "--reporter=junit", `--reporter-outfile=${junitPath}`] : VALIDATION_COMMANDS[key];
      const startedAt = Date.now();
      const result = command(argv, worktree, key === "focused" ? VALIDATION_COMMANDS.focusedEnv : undefined);
      const finishedAt = Date.now();
      const allowed = key === "freshHost" ? ["e2e/fresh-host/REPORT.json", "e2e/fresh-host/REPORT.md"] : [];
      const cleanAfter = sourceProof(worktree, commit, tree, allowed).clean;
      const output = writeImmutable(`validation-${commit}-${runId}-${key}.log`, result.output.length ? result.output : Buffer.from("(no output)\n"));
      commands[key] = { startedAt, finishedAt, argv, env: key === "focused" ? VALIDATION_COMMANDS.focusedEnv : {}, exitCode: result.exitCode,
        source: { head: commit, tree, detached: true, cleanBefore, cleanAfter }, output };
      if (key === "focused") {
        const bytes = (() => { try { return readFileSync(junitPath); } catch { return Buffer.from("<testsuites failures=\"1\"><testsuite file=\"missing\"/></testsuites>"); } })();
        commands.focused.junit = writeImmutable(`validation-${commit}-${runId}-focused.junit.xml`, bytes);
      }
      if (key === "freshHost") commands.freshHost.report = writeImmutable(`fresh-host-${commit}-${runId}.json`, structuredFreshReport(join(worktree, "e2e/fresh-host/REPORT.json"), runId, commit, tree, startedAt, finishedAt));
      if (!cleanAfter) throw new Error(`candidate worktree changed unexpectedly during ${key}`);
    }
    complete = true;
  } finally {
    after = processSnapshot();
    try { command(["git", "-C", REPO, "worktree", "remove", "--force", worktree]); } catch { /* cleanup is best effort */ }
    rmSync(tempRoot, { recursive: true, force: true });
  }
  const beforeSet = new Set(before.map((entry) => entry.argvSha256));
  const forbiddenProcessesSpawned = after.some((entry) => !beforeSet.has(entry.argvSha256));
  const routes = ["/", ...extractGetRoutes(readFileSync(join(REPO, "server/api/router.ts"), "utf8"))].sort();
  const manifest = {
    schemaVersion: 3, kind: "spec45-validation", runId, candidateCommit: commit, candidateTree: tree, recordedAt: Date.now(),
    processGuard: { before, after, forbiddenProcessesSpawned }, routeInventory: { routes, sha256: sha256(JSON.stringify(routes)) }, commands,
  };
  const receipt = writeImmutable(`validation-${commit}-${runId}.json`, Buffer.from(JSON.stringify(manifest)));
  console.log(JSON.stringify({ manifestPath: receipt.path, manifestSha256: receipt.sha256 }));
  const allExitedZero = COMMAND_KEYS.every((key) => commands[key]?.exitCode === 0);
  const junit = commands.focused?.junit as { path: string } | undefined;
  return complete && allExitedZero && !!junit && junitLooksUsable(junit.path) && !forbiddenProcessesSpawned ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });
