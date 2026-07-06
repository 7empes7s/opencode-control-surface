// Hermetic tests for SPEC 14 / ULTRAPLAN P3 A3a — durable job-backed infra
// restart/timer-run + the runShell seam.
//
// NEVER exercises a real systemctl/docker command. `runShell` (server/api/
// shell.ts) is replaced with a recording stub for the whole file via
// setRunShellForTests; every test asserts on the exact recorded command
// strings instead of any real process execution. This is required by the
// build rails: running systemctl restart/start or docker restart against
// this host during build/test is forbidden.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { createJob, readJob } from "../db/writer.ts";
import { setRunShellForTests, type ShellResult } from "./shell.ts";
import {
  infraRunTimerHandler,
  infraServiceRestartHandler,
  runInfraServiceRestart,
  runInfraTimerRun,
  setInfraRestartTimingForTests,
} from "./actions.ts";

type ShellCall = { command: string; timeout?: number };

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousOperatorToken: string | undefined;
let shellCalls: ShellCall[];
let shellResponder: (command: string, callIndex: number) => ShellResult;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function installShellStub(): void {
  shellCalls = [];
  shellResponder = () => ({ ok: true, stdout: "" });
  const counters = new Map<string, number>();
  setRunShellForTests((command, opts) => {
    const idx = counters.get(command) ?? 0;
    counters.set(command, idx + 1);
    shellCalls.push({ command, timeout: opts?.timeout });
    return shellResponder(command, idx);
  });
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "infra-restart-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  installShellStub();
  // Keep the restart settle/retry delays tiny so the hermetic suite doesn't
  // spend real wall-clock seconds on a window whose only purpose in
  // production is "give a real restart a moment before re-reading state".
  setInfraRestartTimingForTests({ settleMs: 2, retryDelayMs: 2 });
});

afterEach(() => {
  closeDashboardDb();
  setRunShellForTests(null);
  setInfraRestartTimingForTests(null);
  restoreEnv("DASHBOARD_DB", previousDashboardDb);
  restoreEnv("DASHBOARD_DB_PATH", previousDashboardDbPath);
  restoreEnv("OPERATOR_TOKEN", previousOperatorToken);
  rmSync(tempDir, { recursive: true, force: true });
});

function auditRows(actionKind: string): Array<{
  action_kind: string;
  target_id: string;
  result_status: string;
  error: string | null;
  job_id: string | null;
  result_json: string | null;
  risk: string | null;
}> {
  return getDashboardDb()!.query(
    "SELECT action_kind, target_id, result_status, error, job_id, result_json, risk FROM action_audit WHERE action_kind = ? ORDER BY id ASC",
  ).all(actionKind) as never;
}

function mutationRequest(path: string, payload: unknown): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": "test-token" },
    body: JSON.stringify(payload),
  });
}

function commandsFor(prefix: string): ShellCall[] {
  return shellCalls.filter((c) => c.command.startsWith(prefix));
}

describe("infra service restart — durable job (Deliverable 2)", () => {
  test("healthy immediately after restart: creates job, captures before/after via systemctl is-active, issues systemctl restart, finishes success", async () => {
    shellResponder = (command, idx) => {
      if (command === "systemctl is-active newsbites") {
        // idx 0 = before capture, idx 1 = after capture (settle).
        return idx === 0 ? { ok: false, stdout: "inactive" } : { ok: true, stdout: "active" };
      }
      if (command === "systemctl restart newsbites") return { ok: true, stdout: "" };
      throw new Error(`unexpected command: ${command}`);
    };

    createJob({ id: "job-svc-1", kind: "infra-service-restart", targetType: "service", targetId: "newsbites", command: "systemctl restart newsbites", request: { service: "newsbites" } });
    await runInfraServiceRestart("job-svc-1", "service", "newsbites", "operator reason");

    // Exactly: before capture, restart, after capture (no retry needed).
    expect(commandsFor("systemctl is-active newsbites")).toHaveLength(2);
    expect(commandsFor("systemctl restart newsbites")).toHaveLength(1);
    expect(shellCalls.some((c) => c.command === "docker restart newsbites")).toBe(false);

    const job = readJob("job-svc-1");
    expect(job?.status).toBe("success");
    expect(job?.error).toBeNull();
    const evidence = JSON.parse(job!.outputTail) as { before: string; after: string; command: string };
    expect(evidence).toEqual({ before: "inactive", after: "active", command: "systemctl restart newsbites" });

    const rows = auditRows("infra.service-restart.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("success");
    expect(rows[0].job_id).toBe("job-svc-1");
    expect(rows[0].risk).toBe("high");
    expect(JSON.parse(rows[0].result_json!)).toEqual({ before: "inactive", after: "active", command: "systemctl restart newsbites" });
  });

  test("unhealthy on first after-check but healthy after the one retry: still success, exactly one retry", async () => {
    shellResponder = (command, idx) => {
      if (command === "systemctl is-active vast-tunnel") {
        if (idx === 0) return { ok: false, stdout: "inactive" }; // before
        if (idx === 1) return { ok: true, stdout: "activating" }; // after settle: not yet active
        return { ok: true, stdout: "active" }; // after retry: healthy
      }
      if (command === "systemctl restart vast-tunnel") return { ok: true, stdout: "" };
      throw new Error(`unexpected command: ${command}`);
    };

    createJob({ id: "job-svc-2", kind: "infra-service-restart", targetType: "service", targetId: "vast-tunnel", command: "systemctl restart vast-tunnel", request: {} });
    await runInfraServiceRestart("job-svc-2", "service", "vast-tunnel", undefined);

    expect(commandsFor("systemctl is-active vast-tunnel")).toHaveLength(3); // before + after + one retry
    const job = readJob("job-svc-2");
    expect(job?.status).toBe("success");
    const evidence = JSON.parse(job!.outputTail) as { before: string; after: string };
    expect(evidence.after).toBe("active");
  });

  test("restart command succeeds but after-state never recovers: legitimate failed job with state surfaced (not a silent success)", async () => {
    shellResponder = (command, idx) => {
      if (command === "systemctl is-active litellm") {
        if (idx === 0) return { ok: false, stdout: "inactive" };
        return { ok: false, stdout: "failed" }; // both after-check and retry stay unhealthy
      }
      if (command === "systemctl restart litellm") return { ok: true, stdout: "" }; // command itself "succeeds"
      throw new Error(`unexpected command: ${command}`);
    };

    createJob({ id: "job-svc-3", kind: "infra-service-restart", targetType: "service", targetId: "litellm", command: "systemctl restart litellm", request: {} });
    await runInfraServiceRestart("job-svc-3", "service", "litellm", undefined);

    // Exactly one retry attempted, never an unbounded retry loop.
    expect(commandsFor("systemctl is-active litellm")).toHaveLength(3);

    const job = readJob("job-svc-3");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("failed"); // observed after-state surfaced in the error
    const evidence = JSON.parse(job!.outputTail) as { before: string; after: string };
    expect(evidence.after).toBe("failed");

    const rows = auditRows("infra.service-restart.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("failed");
    expect(JSON.parse(rows[0].result_json!)).toEqual({ before: "inactive", after: "failed", command: "systemctl restart litellm" });
  });

  test("container target uses docker restart / docker inspect, not systemctl", async () => {
    shellResponder = (command, idx) => {
      if (command === "docker inspect --format '{{.State.Status}}' paperclip") {
        return idx === 0 ? { ok: true, stdout: "exited" } : { ok: true, stdout: "running" };
      }
      if (command === "docker restart paperclip") return { ok: true, stdout: "" };
      throw new Error(`unexpected command: ${command}`);
    };

    createJob({ id: "job-ctr-1", kind: "infra-service-restart", targetType: "service", targetId: "paperclip", command: "docker restart paperclip", request: {} });
    await runInfraServiceRestart("job-ctr-1", "container", "paperclip", undefined);

    expect(shellCalls.some((c) => c.command.startsWith("systemctl"))).toBe(false);
    expect(commandsFor("docker restart paperclip")).toHaveLength(1);
    expect(commandsFor("docker inspect")).toHaveLength(2);

    const job = readJob("job-ctr-1");
    expect(job?.status).toBe("success");
    const rows = auditRows("infra.container-restart.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("success");
  });

  test("cloudflared restart carries the same before/after is-active evidence — its post-restart health probe", async () => {
    shellResponder = (command, idx) => {
      if (command === "systemctl is-active cloudflared") {
        return idx === 0 ? { ok: false, stdout: "inactive" } : { ok: true, stdout: "active" };
      }
      if (command === "systemctl restart cloudflared") return { ok: true, stdout: "" };
      throw new Error(`unexpected command: ${command}`);
    };

    createJob({ id: "job-cf-1", kind: "infra-service-restart", targetType: "service", targetId: "cloudflared", command: "systemctl restart cloudflared", request: {} });
    await runInfraServiceRestart("job-cf-1", "service", "cloudflared", undefined);

    const job = readJob("job-cf-1");
    expect(job?.status).toBe("success");
    const evidence = JSON.parse(job!.outputTail) as { before: string; after: string; command: string };
    expect(evidence).toEqual({ before: "inactive", after: "active", command: "systemctl restart cloudflared" });
  });

  test("POST /api/infra/service-restart: immediate {ok,jobId}, job-then-worker settles success, start + finished audit rows both recorded", async () => {
    shellResponder = (command) => {
      if (command === "systemctl is-active newsbites") return { ok: true, stdout: "active" };
      if (command === "systemctl restart newsbites") return { ok: true, stdout: "" };
      throw new Error(`unexpected command: ${command}`);
    };

    const res = await infraServiceRestartHandler(mutationRequest("/api/infra/service-restart", { service: "newsbites", reason: "manual check" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; jobId: string; message: string };
    expect(body.ok).toBe(true);
    expect(typeof body.jobId).toBe("string");

    await new Promise((r) => setTimeout(r, 25));

    const job = readJob(body.jobId);
    expect(job?.status).toBe("success");
    expect(job?.kind).toBe("infra-service-restart");
    expect(auditRows("infra.service-restart")).toHaveLength(1);
    expect(auditRows("infra.service-restart.finished")).toHaveLength(1);
    expect(auditRows("infra.service-restart")[0].result_status).toBe("running");
  });

  test("allowlist refusal: unknown service returns 400, writes no job, is audited, and never touches the shell", async () => {
    const res = await infraServiceRestartHandler(mutationRequest("/api/infra/service-restart", { service: "not-a-real-service" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not in allowlist");
    expect(shellCalls).toHaveLength(0);

    const rows = auditRows("infra.service-restart");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("failed");
    expect(rows[0].job_id).toBeNull();
  });

  test("rejects without a mutating-capable request (no operator token) — never silently restarts", async () => {
    const req = new Request("http://127.0.0.1:3000/api/infra/service-restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "newsbites" }),
    });
    const res = await infraServiceRestartHandler(req);
    expect(res.status).toBe(401);
    expect(shellCalls).toHaveLength(0);
  });
});

describe("infra run-timer — durable job + --no-block fix (Deliverable 3)", () => {
  test("issues systemctl start --no-block (THE fix), creates job, captures post-enqueue state, finishes success on enqueue alone", async () => {
    shellResponder = (command) => {
      if (command === "systemctl start --no-block mimule-backup.service") return { ok: true, stdout: "" };
      if (command === "systemctl is-active mimule-backup.service") return { ok: true, stdout: "activating" };
      throw new Error(`unexpected command: ${command}`);
    };

    createJob({ id: "job-timer-1", kind: "infra-run-timer", targetType: "timer", targetId: "mimule-backup", command: "systemctl start --no-block mimule-backup.service", request: {} });
    await runInfraTimerRun("job-timer-1", "mimule-backup", "operator run-now");

    const startCalls = commandsFor("systemctl start");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].command).toContain("--no-block"); // the latent-bug fix
    expect(startCalls[0].command).toBe("systemctl start --no-block mimule-backup.service");

    const job = readJob("job-timer-1");
    expect(job?.status).toBe("success");
    const evidence = JSON.parse(job!.outputTail) as { command: string; state: string };
    expect(evidence.command).toContain("--no-block");
    expect(evidence.state).toBe("activating"); // enqueue success != oneshot completion — honestly recorded

    const rows = auditRows("infra.run-timer.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("success");
    expect(rows[0].risk).toBe("medium");
  });

  test("enqueue itself fails (e.g. unit not found): finished job failed, no false success", async () => {
    shellResponder = (command) => {
      if (command === "systemctl start --no-block newsbites-brief.service") {
        return { ok: false, stdout: "", stderr: "Unit not found.", error: "Command failed: systemctl start --no-block newsbites-brief.service" };
      }
      if (command === "systemctl is-active newsbites-brief.service") return { ok: false, stdout: "inactive" };
      throw new Error(`unexpected command: ${command}`);
    };

    createJob({ id: "job-timer-2", kind: "infra-run-timer", targetType: "timer", targetId: "newsbites-brief", command: "systemctl start --no-block newsbites-brief.service", request: {} });
    await runInfraTimerRun("job-timer-2", "newsbites-brief", undefined);

    const job = readJob("job-timer-2");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("systemctl start --no-block newsbites-brief.service");

    const rows = auditRows("infra.run-timer.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("failed");
  });

  test("POST /api/infra/run-timer: immediate {ok,jobId}, worker settles success, start + finished audit rows recorded", async () => {
    shellResponder = (command) => {
      if (command.startsWith("systemctl start --no-block")) return { ok: true, stdout: "" };
      if (command.startsWith("systemctl is-active")) return { ok: true, stdout: "active" };
      throw new Error(`unexpected command: ${command}`);
    };

    const res = await infraRunTimerHandler(mutationRequest("/api/infra/run-timer", { timer: "model-health-check" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; jobId: string; message: string };
    expect(body.ok).toBe(true);
    expect(typeof body.jobId).toBe("string");

    await new Promise((r) => setTimeout(r, 25));

    const job = readJob(body.jobId);
    expect(job?.status).toBe("success");
    expect(job?.kind).toBe("infra-run-timer");
    expect(job?.command).toContain("--no-block");
    expect(auditRows("infra.run-timer")).toHaveLength(1);
    expect(auditRows("infra.run-timer.finished")).toHaveLength(1);
  });

  test("allowlist refusal: unknown timer returns 400, writes no job, is audited, never touches the shell", async () => {
    const res = await infraRunTimerHandler(mutationRequest("/api/infra/run-timer", { timer: "not-a-real-timer" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not in allowlist");
    expect(shellCalls).toHaveLength(0);

    const rows = auditRows("infra.run-timer");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("failed");
    expect(rows[0].job_id).toBeNull();
  });

  test("rejects without a mutating-capable request (no operator token) — never silently runs the timer", async () => {
    const req = new Request("http://127.0.0.1:3000/api/infra/run-timer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timer: "mimule-backup" }),
    });
    const res = await infraRunTimerHandler(req);
    expect(res.status).toBe(401);
    expect(shellCalls).toHaveLength(0);
  });
});

describe("old synchronous execSync behavior is gone (Deliverable 1)", () => {
  test("neither infra handler nor its worker calls execSync directly anymore — everything routes through runShell", () => {
    const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
    const markerStart = source.indexOf("export async function runInfraServiceRestart");
    expect(markerStart).toBeGreaterThan(-1);
    const region = source.slice(markerStart);
    expect(region).not.toContain("execSync(");
    expect(region).toContain("runShell(");
  });
});
