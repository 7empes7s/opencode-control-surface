// Command-runner seam (ULTRAPLAN P3 / A3, SPEC 14).
//
// Why this exists: server/api/actions.ts and server/api/execute.ts called
// `execSync` directly at ~10 call sites with no way to intercept it in
// tests. That meant any test exercising those code paths either had to
// mock.module() the whole node:child_process module (which bun test warns
// leaks across files — see the same caution already written into
// server/evals/modelEval.ts) or skip coverage entirely. This module gives
// infra mutation handlers ONE seam to call through, so tests can stub it
// with a plain function assignment and assert exact command strings —
// no real systemctl/docker/etc. call ever happens in build or test.
//
// Scope for SPEC 14: only the two infra handlers (service-restart,
// run-timer) and their new job workers are migrated onto this seam. The
// ~8 other execSync call sites in server/api/execute.ts (and the ones in
// onboarding.ts / newsbites-actions.ts / adapters/*) are deliberately left
// alone here — migrating all of them is a larger, separate cleanup and
// out of scope for this spec (noted as follow-up, not silently dropped).
import { execSync } from "node:child_process";

export type ShellResult = {
  ok: boolean;
  stdout: string;
  stderr?: string;
  error?: string;
};

export type ShellRunner = (command: string, opts?: { timeout?: number }) => ShellResult;

function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

// Real implementation: wraps execSync, never throws to the caller. Even on
// a non-zero exit / timeout, we still surface whatever stdout/stderr the
// process produced (execSync attaches `.stdout`/`.stderr` to the thrown
// error) — callers like `systemctl is-active` rely on this, since it exits
// non-zero for "inactive"/"failed" while still printing that state to
// stdout.
function realRunShell(command: string, opts?: { timeout?: number }): ShellResult {
  try {
    const stdout = execSync(command, { timeout: opts?.timeout ?? 30_000, encoding: "utf8" });
    return { ok: true, stdout: toText(stdout) };
  } catch (error) {
    const err = error as { stdout?: unknown; stderr?: unknown; message?: string };
    return {
      ok: false,
      stdout: toText(err?.stdout),
      stderr: err?.stderr !== undefined ? toText(err.stderr) : undefined,
      error: err?.message ?? String(error),
    };
  }
}

// Injection seam for tests (mock.module leaks across bun test files; never
// use it here — see server/evals/modelEval.ts for the same idiom).
let runShellImpl: ShellRunner = realRunShell;

export function setRunShellForTests(fn: ShellRunner | null): void {
  runShellImpl = fn ?? realRunShell;
}

export function runShell(command: string, opts?: { timeout?: number }): ShellResult {
  return runShellImpl(command, opts);
}
