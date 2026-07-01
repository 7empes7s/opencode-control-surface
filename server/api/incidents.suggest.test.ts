import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../gateway/client.ts", () => ({
  complete: async () => {
    throw new Error("gateway unavailable in test");
  },
}));

const { closeDashboardDb, getDashboardDb, initDashboardDb } = await import("../db/dashboard.ts");
const { handleApi } = await import("./router.ts");

describe("incident post-mortem suggestion API", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousOperatorToken: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "incidents-suggest-api-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousOperatorToken = process.env.OPERATOR_TOKEN;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    process.env.OPERATOR_TOKEN = "test-token";
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousOperatorToken;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function apiReq(path: string, options: RequestInit = {}, token = "test-token") {
    const headers = new Headers(options.headers);
    if (token) headers.set("x-operator-token", token);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return new Request(`http://localhost${path}`, { ...options, headers });
  }

  function seedIncident() {
    const db = getDashboardDb()!;
    db.query(`
      INSERT INTO reasoner_diagnoses
        (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json,
         suggested_actions_json, confidence, diagnosed_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "diagnosis-suggest",
      "pass-suggest",
      "run-suggest",
      "workflow-suggest",
      "build_failure",
      "Builder step timed out while waiting for model output",
      JSON.stringify({ signal: "timeout", model: "logical/editorial-heavy" }),
      JSON.stringify(["Retry the pass after confirming gateway health"]),
      "high",
      1_000,
      "mimule",
    );
    db.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "incident-suggest",
      "incident-suggest:cluster",
      "build_failure",
      "Builder timeout cluster",
      1_000,
      2_000,
      3,
      "pass-suggest",
      "diagnosis-suggest",
      "open",
      "mimule",
    );
  }

  test("returns a deterministic suggestion envelope when AI is unavailable", async () => {
    seedIncident();

    const req = apiReq("/api/incidents/incident-suggest/suggest-postmortem", { method: "POST" });
    const res = await handleApi(req, new URL(req.url));

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { suggestion: string } };
    expect(body.data.suggestion).toContain("Builder timeout cluster");
    expect(body.data.suggestion).toContain("occurrences");
    expect(body.data.suggestion).toContain("Builder step timed out");

    const audit = getDashboardDb()!.query(`
      SELECT action_id, result_json, error FROM action_audit
      WHERE action_id = ?
    `).get("suggest-postmortem:incident:incident-suggest") as { action_id: string; result_json: string; error: string | null } | null;
    expect(audit?.action_id).toBe("suggest-postmortem:incident:incident-suggest");
    expect(audit?.result_json).toContain("template");
    expect(audit?.error).toContain("gateway unavailable");
  });
});
