import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { computeClusterKey, clusterDiagnosis } from "./clustering.ts";
import type { DiagnosisResult } from "./types.ts";

describe("clustering", () => {
  const testDbPath = `/tmp/test-clustering-${Date.now()}.sqlite`;

  beforeAll(() => {
    initDashboardDb({ enabled: true, path: testDbPath });
  });

  afterAll(() => {
    closeDashboardDb();
  });

  beforeEach(() => {
    const db = getDashboardDb()!;
    db.query("DELETE FROM reasoner_incident_members").run();
    db.query("DELETE FROM reasoner_incidents").run();
    db.query("DELETE FROM reasoner_diagnoses").run();
  });

  test("two diagnoses with same failure class and root cause → same incident", () => {
    const db = getDashboardDb()!;
    const now = Date.now();

    db.query(`
      INSERT INTO reasoner_diagnoses (id, pass_id, run_id, workflow_id, failure_class, root_cause,
        evidence_json, suggested_actions_json, confidence, diagnosed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("diag1", "pass1", "run1", "wf1", "codex-exhausted", "Claude API key is exhausted",
      "[]", "[]", "high", now);
    db.query(`
      INSERT INTO reasoner_diagnoses (id, pass_id, run_id, workflow_id, failure_class, root_cause,
        evidence_json, suggested_actions_json, confidence, diagnosed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("diag2", "pass2", "run2", "wf1", "codex-exhausted", "Claude API key is exhausted",
      "[]", "[]", "high", now + 1);

    const diagnosis1: DiagnosisResult = {
      passId: "pass1", runId: "run1", workflowId: "wf1",
      failureClass: "codex-exhausted", rootCauseHypothesis: "Claude API key is exhausted",
      evidence: [], suggestedActions: [], confidence: "high", diagnosedAt: now,
    };
    const diagnosis2: DiagnosisResult = {
      passId: "pass2", runId: "run2", workflowId: "wf1",
      failureClass: "codex-exhausted", rootCauseHypothesis: "Claude API key is exhausted",
      evidence: [], suggestedActions: [], confidence: "high", diagnosedAt: now + 1,
    };

    const incidentId1 = clusterDiagnosis(db, diagnosis1);
    const incidentId2 = clusterDiagnosis(db, diagnosis2);

    expect(incidentId1).toBe(incidentId2);

    const members = db.query("SELECT COUNT(*) as cnt FROM reasoner_incident_members WHERE incident_id = ?")
      .get(incidentId1) as { cnt: number };
    expect(members.cnt).toBe(2);
  });

  test("two diagnoses with different failure classes → different incidents", () => {
    const db = getDashboardDb()!;
    const now = Date.now();

    const diagnosis1: DiagnosisResult = {
      passId: "pass3", runId: "run3", workflowId: "wf1",
      failureClass: "codex-exhausted", rootCauseHypothesis: "Claude API key is exhausted",
      evidence: [], suggestedActions: [], confidence: "high", diagnosedAt: now,
    };
    const diagnosis2: DiagnosisResult = {
      passId: "pass4", runId: "run4", workflowId: "wf1",
      failureClass: "build-error", rootCauseHypothesis: "TypeScript compilation failed",
      evidence: [], suggestedActions: [], confidence: "high", diagnosedAt: now + 1,
    };

    const incidentId1 = clusterDiagnosis(db, diagnosis1);
    const incidentId2 = clusterDiagnosis(db, diagnosis2);

    expect(incidentId1).not.toBe(incidentId2);
  });

  test("computeClusterKey is stable regardless of whitespace casing", () => {
    const key1 = computeClusterKey("Codex-Exhausted", "Claude API key is exhausted");
    const key2 = computeClusterKey("codex-exhausted", "claude api key is exhausted");
    expect(key1).toBe(key2);
  });

  test("sets sla_due_at on creation using the default 7-day window (clustering titles carry no severity prefix)", () => {
    const db = getDashboardDb()!;
    const now = Date.now();

    const diagnosis: DiagnosisResult = {
      passId: "pass-sla", runId: "run-sla", workflowId: "wf-sla",
      failureClass: "build-error", rootCauseHypothesis: "TypeScript compilation failed",
      evidence: [], suggestedActions: [], confidence: "high", diagnosedAt: now,
    };
    db.query(`
      INSERT INTO reasoner_diagnoses (id, pass_id, run_id, workflow_id, failure_class, root_cause,
        evidence_json, suggested_actions_json, confidence, diagnosed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("diag-sla", "pass-sla", "run-sla", "wf-sla", "build-error", "TypeScript compilation failed",
      "[]", "[]", "high", now);

    const incidentId = clusterDiagnosis(db, diagnosis);
    const row = db.query("SELECT first_seen, sla_due_at FROM reasoner_incidents WHERE id = ?")
      .get(incidentId) as { first_seen: number; sla_due_at: number };
    expect(row.sla_due_at).toBe(row.first_seen + 7 * 24 * 60 * 60 * 1000);
  });
});

describe("incident resolve endpoint", () => {
  const testDbPath = `/tmp/test-incident-resolve-${Date.now()}.sqlite`;

  beforeAll(() => {
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ enabled: true, path: testDbPath });
  });

  afterAll(() => {
    closeDashboardDb();
  });

  beforeEach(() => {
    const db = getDashboardDb()!;
    db.query("DELETE FROM reasoner_incident_members").run();
    db.query("DELETE FROM reasoner_incidents").run();
    db.query("DELETE FROM reasoner_diagnoses").run();
  });

  test("resolve endpoint updates incident status to resolved", async () => {
    const db = getDashboardDb()!;
    const now = Date.now();

    db.query(`
      INSERT INTO reasoner_incidents (id, cluster_key, failure_class, title, first_seen, last_seen,
        occurrence_count, representative_pass_id, representative_diagnosis_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("ri_test1", "ck_test1", "codex-exhausted", "Test incident", now, now, 1, "pass1", "diag1", "open");

    const { reasonerResolveIncidentHandler } = await import("../api/reasoner.ts");
    const res = await reasonerResolveIncidentHandler("ri_test1");

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const row = db.query("SELECT status FROM reasoner_incidents WHERE id = ?").get("ri_test1") as { status: string };
    expect(row.status).toBe("resolved");
  });

  test("resolve endpoint returns 404 for unknown incident", async () => {
    const { reasonerResolveIncidentHandler } = await import("../api/reasoner.ts");
    const res = await reasonerResolveIncidentHandler("ri_unknown");
    expect(res.status).toBe(404);
  });
});