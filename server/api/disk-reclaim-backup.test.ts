// Hermetic tests for SPEC 15 / ULTRAPLAN P3 A3b — reclaim:disk:docker-prune
// and run:backup:now, the two remediation actions the disk-pressure and
// backup-stale ops detectors now point at.
//
// NEVER exercises a real docker/systemctl command. `runShell` (server/api/
// shell.ts) is replaced with a recording stub for the whole file via
// setRunShellForTests; every test asserts on the exact recorded command
// strings instead of any real process execution — required by the build
// rails (no real docker builder/image prune, no real systemctl start, ever).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { createJob, readJob } from "../db/writer.ts";
import { setRunShellForTests, type ShellResult } from "./shell.ts";
import { runDiskReclaim } from "./actions.ts";
import { executeActionHandler } from "./execute.ts";
import { mapBackupFreshnessFindings, mapHetznerFindings } from "../insights/scanners/ops.ts";
import { riskTierFor } from "../insights/autoapplyPolicy.ts";

type ShellCall = { command: string; timeout?: number };

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
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
  tempDir = mkdtempSync(join(tmpdir(), "disk-reclaim-backup-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  installShellStub();
});

afterEach(() => {
  closeDashboardDb();
  setRunShellForTests(null);
  restoreEnv("DASHBOARD_DB", previousDashboardDb);
  restoreEnv("DASHBOARD_DB_PATH", previousDashboardDbPath);
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

function jobCount(): number {
  return (getDashboardDb()!.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
}

async function executeRequest(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await executeActionHandler(new Request("http://127.0.0.1:3000/api/actions/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function commandsFor(prefix: string): ShellCall[] {
  return shellCalls.filter((c) => c.command.startsWith(prefix));
}

describe("reclaim:disk:docker-prune — bounded Docker reclaim (Deliverable 1)", () => {
  test("issues exactly df -BG / (before), docker builder prune -f, docker image prune -f, df -BG / (after) — in that order — and computes reclaimedGb", async () => {
    shellResponder = (command, idx) => {
      if (command === "df -BG /") {
        // idx 0 = before, idx 1 = after
        return idx === 0
          ? { ok: true, stdout: "Filesystem     1G-blocks  Used Available Use% Mounted on\n/dev/sda1           150G  110G       36G  75% /\n" }
          : { ok: true, stdout: "Filesystem     1G-blocks  Used Available Use% Mounted on\n/dev/sda1           150G  105G       41G  71% /\n" };
      }
      if (command === "docker builder prune -f") return { ok: true, stdout: "Total reclaimed space: 2GB" };
      if (command === "docker image prune -f") return { ok: true, stdout: "Total reclaimed space: 3GB" };
      throw new Error(`unexpected command: ${command}`);
    };

    createJob({ id: "job-reclaim-1", kind: "reclaim-disk", targetType: "disk", targetId: "docker-prune", command: "docker builder prune -f && docker image prune -f", request: {} });
    await runDiskReclaim("job-reclaim-1", "operator cleanup");

    // Exact order: df, builder prune, image prune, df.
    expect(shellCalls.map((c) => c.command)).toEqual([
      "df -BG /",
      "docker builder prune -f",
      "docker image prune -f",
      "df -BG /",
    ]);

    const job = readJob("job-reclaim-1");
    expect(job?.status).toBe("success");
    expect(job?.error).toBeNull();
    const evidence = JSON.parse(job!.outputTail) as {
      beforeUsedGb: number; afterUsedGb: number; reclaimedGb: number; beforePct: number; afterPct: number;
    };
    expect(evidence.beforeUsedGb).toBe(110);
    expect(evidence.afterUsedGb).toBe(105);
    expect(evidence.reclaimedGb).toBe(5);
    expect(evidence.beforePct).toBe(75);
    expect(evidence.afterPct).toBe(71);

    const rows = auditRows("reclaim.disk-docker-prune.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("success");
    expect(rows[0].job_id).toBe("job-reclaim-1");
    expect(rows[0].risk).toBe("medium");
    expect(JSON.parse(rows[0].result_json!).reclaimedGb).toBe(5);
  });

  test("-a / --all never appears in either issued prune command (the bounded-reclaim invariant)", async () => {
    shellResponder = (command) => {
      if (command === "df -BG /") return { ok: true, stdout: "/dev/sda1 150G 100G 50G 67% /" };
      return { ok: true, stdout: "" };
    };
    createJob({ id: "job-reclaim-bounded", kind: "reclaim-disk", targetType: "disk", targetId: "docker-prune", command: "docker builder prune -f && docker image prune -f", request: {} });
    await runDiskReclaim("job-reclaim-bounded", undefined);

    const pruneCalls = shellCalls.filter((c) => c.command.startsWith("docker "));
    expect(pruneCalls.length).toBeGreaterThan(0);
    for (const call of pruneCalls) {
      expect(call.command).not.toContain(" -a");
      expect(call.command).not.toContain("--all");
    }
    expect(commandsFor("docker builder prune")).toHaveLength(1);
    expect(commandsFor("docker builder prune")[0].command).toBe("docker builder prune -f");
    expect(commandsFor("docker image prune")).toHaveLength(1);
    expect(commandsFor("docker image prune")[0].command).toBe("docker image prune -f");
  });

  test("zero bytes reclaimed is still a legitimate success (nothing to reclaim != failure)", async () => {
    shellResponder = (command) => {
      if (command === "df -BG /") return { ok: true, stdout: "/dev/sda1 150G 90G 60G 60% /" };
      if (command === "docker builder prune -f") return { ok: true, stdout: "Total reclaimed space: 0B" };
      if (command === "docker image prune -f") return { ok: true, stdout: "Total reclaimed space: 0B" };
      throw new Error(`unexpected command: ${command}`);
    };
    createJob({ id: "job-reclaim-zero", kind: "reclaim-disk", targetType: "disk", targetId: "docker-prune", command: "docker builder prune -f && docker image prune -f", request: {} });
    await runDiskReclaim("job-reclaim-zero", undefined);

    const job = readJob("job-reclaim-zero");
    expect(job?.status).toBe("success");
    const evidence = JSON.parse(job!.outputTail) as { reclaimedGb: number; beforeUsedGb: number; afterUsedGb: number };
    expect(evidence.reclaimedGb).toBe(0);
    expect(evidence.beforeUsedGb).toBe(90);
    expect(evidence.afterUsedGb).toBe(90);

    const rows = auditRows("reclaim.disk-docker-prune.finished");
    expect(rows[0].result_status).toBe("success");
  });

  test("a failing prune command produces a legitimate failed job with stderr surfaced — not a throw, not a silent success", async () => {
    shellResponder = (command) => {
      if (command === "df -BG /") return { ok: true, stdout: "/dev/sda1 150G 100G 50G 67% /" };
      if (command === "docker builder prune -f") return { ok: true, stdout: "" };
      if (command === "docker image prune -f") {
        return { ok: false, stdout: "", stderr: "Error response from daemon: prune failed", error: "Command failed: docker image prune -f" };
      }
      throw new Error(`unexpected command: ${command}`);
    };
    createJob({ id: "job-reclaim-fail", kind: "reclaim-disk", targetType: "disk", targetId: "docker-prune", command: "docker builder prune -f && docker image prune -f", request: {} });
    await runDiskReclaim("job-reclaim-fail", undefined);

    // Both commands were still issued (max evidence), never a throw out of the worker.
    expect(commandsFor("docker builder prune")).toHaveLength(1);
    expect(commandsFor("docker image prune")).toHaveLength(1);

    const job = readJob("job-reclaim-fail");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("prune failed");

    const rows = auditRows("reclaim.disk-docker-prune.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("failed");
    expect(rows[0].error).toContain("prune failed");
  });

  test("confirm-gating: unconfirmed medium-risk reclaim returns 400 CONFIRM_REQUIRED, creates no job, touches no shell", async () => {
    const { status, body } = await executeRequest({ actionId: "reclaim:disk:docker-prune", reason: "clean up disk" });
    expect(status).toBe(400);
    expect(body.code).toBe("CONFIRM_REQUIRED");
    expect(shellCalls).toHaveLength(0);
    expect(jobCount()).toBe(0);
  });

  test("POST /api/actions/execute confirmed+reasoned: immediate {ok,jobId}, job settles success synchronously via the worker", async () => {
    shellResponder = (command) => {
      if (command === "df -BG /") return { ok: true, stdout: "/dev/sda1 150G 100G 50G 67% /" };
      return { ok: true, stdout: "" };
    };
    const { status, body } = await executeRequest({
      actionId: "reclaim:disk:docker-prune",
      reason: "clean up disk",
      confirmed: true,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("reclaim");
    expect(typeof body.jobId).toBe("string");

    const job = readJob(body.jobId as string);
    expect(job?.kind).toBe("reclaim-disk");
    expect(job?.targetType).toBe("disk");
    expect(job?.targetId).toBe("docker-prune");
    expect(job?.status).toBe("success");
  });

  test("unknown reclaim target returns 404 NOT_FOUND and creates no job", async () => {
    const { status, body } = await executeRequest({
      actionId: "reclaim:disk:something-else",
      reason: "x",
      confirmed: true,
    });
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(jobCount()).toBe(0);
  });
});

describe("run:backup:now — reuses the SPEC 14 timer-run worker (Deliverable 2)", () => {
  test("low risk: no confirm required, creates a job, dispatches through runInfraTimerRun issuing systemctl start --no-block mimule-backup.service", async () => {
    shellResponder = (command) => {
      if (command === "systemctl start --no-block mimule-backup.service") return { ok: true, stdout: "" };
      if (command === "systemctl is-active mimule-backup.service") return { ok: true, stdout: "activating" };
      throw new Error(`unexpected command: ${command}`);
    };

    // No `confirmed` field at all — low risk must not require it.
    const { status, body } = await executeRequest({ actionId: "run:backup:now", reason: "operator requested" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("run");
    expect(typeof body.jobId).toBe("string");

    const startCalls = commandsFor("systemctl start");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].command).toBe("systemctl start --no-block mimule-backup.service");
    expect(startCalls[0].command).toContain("--no-block");

    const job = readJob(body.jobId as string);
    expect(job?.kind).toBe("run-backup");
    expect(job?.targetType).toBe("timer");
    expect(job?.targetId).toBe("mimule-backup");
    expect(job?.status).toBe("success");

    // Reuses the exact SPEC 14 worker — same "infra.run-timer.finished" audit kind.
    const rows = auditRows("infra.run-timer.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("success");
    expect(rows[0].job_id).toBe(String(body.jobId));
  });

  test("enqueue failure surfaces as a failed job, not a silent success", async () => {
    shellResponder = (command) => {
      if (command === "systemctl start --no-block mimule-backup.service") {
        return { ok: false, stdout: "", stderr: "Unit not found.", error: "Command failed: systemctl start --no-block mimule-backup.service" };
      }
      if (command === "systemctl is-active mimule-backup.service") return { ok: false, stdout: "inactive" };
      throw new Error(`unexpected command: ${command}`);
    };
    const { body } = await executeRequest({ actionId: "run:backup:now" });
    const job = readJob(body.jobId as string);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("systemctl start --no-block mimule-backup.service");
  });

  test("unknown run:backup target returns 404 NOT_FOUND and creates no job", async () => {
    const { status, body } = await executeRequest({ actionId: "run:backup:later" });
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(jobCount()).toBe(0);
  });
});

describe("detector wiring — ops.ts insights carry the new actionDescriptorIds (Deliverable 3)", () => {
  test("disk-pressure insight carries reclaim:disk:docker-prune at a non-none riskTier", () => {
    const out = mapHetznerFindings(
      { load1: 0, load5: 0, load15: 0, memTotalKb: 100, memUsedKb: 10, memAvailableKb: 90, diskTotalGb: 100, diskUsedGb: 90, diskUsedPct: 90 },
      Date.now(),
    );
    const disk = out.find((f) => f.sourceKey === "ops:disk-pressure")!;
    expect(disk.actionDescriptorId).toBe("reclaim:disk:docker-prune");
    expect(riskTierFor(disk)).not.toBe("none");
    expect(riskTierFor(disk)).toBe("review");
  });

  test("backup-stale insight carries run:backup:now at a non-none riskTier", () => {
    const [stale] = mapBackupFreshnessFindings(
      { root: "/opt/backups", newestPath: "/opt/backups/2026-07-01", newestMtimeMs: Date.now() - 30 * 3_600_000, ageMs: 30 * 3_600_000, bucket: "stale" },
      Date.now(),
    );
    expect(stale.actionDescriptorId).toBe("run:backup:now");
    expect(riskTierFor(stale)).not.toBe("none");
    expect(riskTierFor(stale)).toBe("review");
  });
});
