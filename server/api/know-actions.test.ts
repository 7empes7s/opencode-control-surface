import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readJob } from "../db/writer.ts";
import { setRunShellForTests } from "./shell.ts";
import { executeActionHandler } from "./execute.ts";

describe("Know governed actions", () => {
  let root: string;
  let previousDb: string | undefined;
  let previousDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    root = mkdtempSync(join(tmpdir(), "know-actions-"));
    previousDb = process.env.DASHBOARD_DB;
    previousDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(root, "dashboard.sqlite");
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    setRunShellForTests(null);
    closeDashboardDb();
    if (previousDb === undefined) delete process.env.DASHBOARD_DB; else process.env.DASHBOARD_DB = previousDb;
    if (previousDbPath === undefined) delete process.env.DASHBOARD_DB_PATH; else process.env.DASHBOARD_DB_PATH = previousDbPath;
    rmSync(root, { recursive: true, force: true });
  });

  async function execute(body: unknown) {
    const response = await executeActionHandler(new Request("http://x/api/actions/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { response, body: await response.json() as Record<string, any> };
  }

  test("runs fixed refresh timer as a durable job", async () => {
    const commands: string[] = [];
    setRunShellForTests((command) => {
      commands.push(command);
      return { ok: true, stdout: command.includes("is-active") ? "active\n" : "" };
    });
    const result = await execute({ actionId: "run:know:refresh-health" });
    expect(result.response.status).toBe(200);
    expect(result.body.jobId).toBeString();
    expect(commands).toEqual([
      "systemctl start --no-block know-health.service",
      "systemctl is-active know-health.service",
    ]);
    expect(readJob(result.body.jobId)?.status).toBe("success");
  });

  test("governs build confirmation and runs only the fixed validation", async () => {
    const missingConfirmation = await execute({ actionId: "run:know:build", reason: "release check" });
    expect(missingConfirmation.body.code).toBe("CONFIRM_REQUIRED");
    const missingReason = await execute({ actionId: "run:know:build", confirmed: true });
    expect(missingReason.body.code).toBe("REASON_REQUIRED");

    const commands: string[] = [];
    setRunShellForTests((command) => {
      commands.push(command);
      return { ok: true, stdout: "build passed" };
    });
    const result = await execute({ actionId: "run:know:build", confirmed: true, reason: "release check" });
    expect(result.response.status).toBe(200);
    for (let attempt = 0; attempt < 50 && readJob(result.body.jobId)?.status === "running"; attempt += 1) await Bun.sleep(5);
    expect(commands).toEqual(["cd /opt/know/web && npm run build"]);
    expect(readJob(result.body.jobId)?.status).toBe("success");
  });

  test("rejects unknown Know action targets", async () => {
    const result = await execute({ actionId: "run:know:publish-story" });
    expect(result.response.status).toBe(404);
    expect(result.body.code).toBe("NOT_FOUND");
  });
});
