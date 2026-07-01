import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { createJob, finishJob } from "../db/writer.ts";
import { adminEventsHandler } from "./admin.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "admin-events-test-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

test("admin events returns deployments, config changes, and incidents as graph markers", async () => {
  const now = Date.now();
  createJob({
    id: "deploy-1",
    kind: "newsbites-deploy",
    targetType: "deploy",
    targetId: "newsbites",
    command: "deploy",
  });
  finishJob("deploy-1", "success", { exitCode: 0 });

  const db = getDashboardDb()!;
  db.query(`
    INSERT INTO config_changes (ts, key, old_value_json, new_value_json, changed_by, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(now - 5_000, "budget.global.cap", "20", "25", "operator", "test cap");
  db.query(`
    INSERT INTO reasoner_incidents (
      id, cluster_key, failure_class, title, first_seen, last_seen,
      occurrence_count, representative_pass_id, representative_diagnosis_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("ri-admin-marker", "cluster-admin-marker", "validation", "Route regression", now - 10_000, now - 10_000, 1, "pass-1", "diag-1", "open");

  const response = await adminEventsHandler(new URL("http://local/api/admin/events?days=1"));
  const envelope = await response.json() as {
    data: { events: Array<{ id: string; type: string; href: string; severity: string; label: string }>; degraded: boolean };
  };

  expect(envelope.data.degraded).toBe(false);
  expect(envelope.data.events.map((event) => event.type).sort()).toEqual(["config", "deployment", "incident"]);
  expect(envelope.data.events.find((event) => event.type === "deployment")?.href).toBe("/jobs");
  expect(envelope.data.events.find((event) => event.type === "config")?.href).toBe("/settings");
  expect(envelope.data.events.find((event) => event.type === "incident")?.severity).toBe("critical");
  expect(envelope.data.events.find((event) => event.type === "config")?.label).toContain("budget.global.cap");
});
