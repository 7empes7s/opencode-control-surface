import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { handleApi } from "./router.ts";
import { buildIncidentsDetail, sanitizePostMortemSuggestion } from "./incidents.ts";

describe("incidents SLA and lifecycle API", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousOperatorToken: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "incidents-api-"));
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

  function seedDiagnosis(id: string, passId: string) {
    getDashboardDb()!.query(`
      INSERT INTO reasoner_diagnoses
        (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json,
         suggested_actions_json, confidence, diagnosed_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      passId,
      `run-${id}`,
      `workflow-${id}`,
      "build_failure",
      `Root cause for ${id}`,
      JSON.stringify({ log: `evidence-${id}` }),
      JSON.stringify(["Restart the failed build step"]),
      "high",
      1_000,
      "mimule",
    );
  }

  function seedIncident(input: {
    id: string;
    firstSeen: number;
    acknowledgedAt?: number | null;
    resolvedAt?: number | null;
    status?: string;
  }) {
    const passId = `pass-${input.id}`;
    const diagnosisId = `diagnosis-${input.id}`;
    seedDiagnosis(diagnosisId, passId);
    getDashboardDb()!.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, acknowledged_at, resolved_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      `${input.id}:cluster`,
      "build_failure",
      `Incident ${input.id}`,
      input.firstSeen,
      input.firstSeen + 100,
      1,
      passId,
      diagnosisId,
      input.status ?? "open",
      input.acknowledgedAt ?? null,
      input.resolvedAt ?? null,
      "mimule",
    );
  }

  it("computes MTTA, MTTR, open age, breach count, and RCA from real rows", () => {
    const now = Date.now();
    seedIncident({ id: "incident-a", firstSeen: 1_000, acknowledgedAt: 4_000, resolvedAt: 11_000, status: "resolved" });
    seedIncident({ id: "incident-b", firstSeen: 2_000, acknowledgedAt: 8_000, resolvedAt: 22_000, status: "resolved" });
    seedIncident({ id: "incident-open", firstSeen: now - 25 * 60 * 60 * 1000, status: "open" });

    const detail = buildIncidentsDetail();

    expect(detail.sla.meanTimeToAcknowledgeMs).toBe(4_500);
    expect(detail.sla.meanTimeToResolveMs).toBe(15_000);
    expect(detail.sla.acknowledgedSamples).toBe(2);
    expect(detail.sla.resolvedSamples).toBe(2);
    expect(detail.sla.oldestOpenAgeMs).toBeGreaterThanOrEqual(25 * 60 * 60 * 1000 - 1_000);
    expect(detail.sla.breachingUnacknowledgedCount).toBe(1);
    expect(detail.reasonerIncidents.find((incident) => incident.id === "incident-a")?.rootCause).toContain("Root cause");
  });

  it("acks and resolves incidents through token-gated audited handlers", async () => {
    seedIncident({ id: "incident-lifecycle", firstSeen: 1_000 });

    const ackRes = await handleApi(apiReq("/api/incidents/incident-lifecycle/ack", { method: "POST" }), new URL("http://localhost/api/incidents/incident-lifecycle/ack"));
    expect(ackRes.status).toBe(200);
    const ackBody = await ackRes.json() as { ok: boolean };
    expect(ackBody.ok).toBe(true);

    const resolveRes = await handleApi(
      apiReq("/api/incidents/incident-lifecycle/resolve", {
        method: "POST",
        body: JSON.stringify({ reason: "test resolve" }),
      }),
      new URL("http://localhost/api/incidents/incident-lifecycle/resolve"),
    );
    expect(resolveRes.status).toBe(200);
    const resolveBody = await resolveRes.json() as { ok: boolean };
    expect(resolveBody.ok).toBe(true);

    const row = getDashboardDb()!.query(`
      SELECT acknowledged_at, resolved_at, status
      FROM reasoner_incidents
      WHERE id = ?
    `).get("incident-lifecycle") as { acknowledged_at: number | null; resolved_at: number | null; status: string };
    expect(row.acknowledged_at).toBeGreaterThan(0);
    expect(row.resolved_at).toBeGreaterThan(0);
    expect(row.status).toBe("resolved");

    const auditRows = getDashboardDb()!.query(`
      SELECT action_id FROM action_audit
      WHERE target_id = ?
      ORDER BY id
    `).all("incident-lifecycle") as Array<{ action_id: string }>;
    expect(auditRows.map((row) => row.action_id)).toContain("acknowledge:incident:incident-lifecycle");
    expect(auditRows.map((row) => row.action_id)).toContain("resolve:incident:incident-lifecycle");
  });

  it("persists operator post-mortem notes and audits the write", async () => {
    seedIncident({ id: "incident-postmortem", firstSeen: 1_000 });

    const res = await handleApi(
      apiReq("/api/incidents/incident-postmortem/post-mortem", {
        method: "POST",
        body: JSON.stringify({ postMortem: "Operator RCA note" }),
      }),
      new URL("http://localhost/api/incidents/incident-postmortem/post-mortem"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; postMortem: string };
    expect(body.ok).toBe(true);
    expect(body.postMortem).toBe("Operator RCA note");

    const row = getDashboardDb()!.query(`
      SELECT post_mortem FROM reasoner_incidents
      WHERE id = ?
    `).get("incident-postmortem") as { post_mortem: string | null };
    expect(row.post_mortem).toBe("Operator RCA note");

    const audit = getDashboardDb()!.query(`
      SELECT action_id FROM action_audit
      WHERE action_id = ?
    `).get("post-mortem:incident:incident-postmortem") as { action_id: string } | null;
    expect(audit?.action_id).toBe("post-mortem:incident:incident-postmortem");
  });

  it("rejects ack without an operator token", async () => {
    seedIncident({ id: "incident-no-token", firstSeen: 1_000 });

    const req = apiReq("/api/incidents/incident-no-token/ack", { method: "POST" }, "");
    const res = await handleApi(req, new URL(req.url));

    expect(res.status).toBe(401);
  });

  it("derives auto-close status from the action_audit trail, distinct from operator resolution", () => {
    seedIncident({ id: "incident-auto-closed", firstSeen: 1_000, resolvedAt: 5_000, status: "resolved" });
    writeActionAudit({
      actor: "system",
      actorSource: "sentinel-scan",
      actionKind: "incidents.auto-close",
      targetType: "incident",
      targetId: "incident-auto-closed",
      reason: "auto-closed: finding 'x' no longer failing",
    });

    seedIncident({ id: "incident-operator-resolved", firstSeen: 1_000, resolvedAt: 5_000, status: "resolved" });

    seedIncident({ id: "incident-open", firstSeen: 1_000, status: "open" });

    const detail = buildIncidentsDetail();

    const autoClosed = detail.reasonerIncidents.find((incident) => incident.id === "incident-auto-closed");
    expect(autoClosed?.autoClosed).toBe(true);
    expect(autoClosed?.resolutionSource).toBe("system");
    expect(autoClosed?.autoCloseReason).toContain("auto-closed");
    expect(autoClosed?.autoCloseAt).toBeGreaterThan(0);

    const operatorResolved = detail.reasonerIncidents.find((incident) => incident.id === "incident-operator-resolved");
    expect(operatorResolved?.autoClosed).toBe(false);
    expect(operatorResolved?.resolutionSource).toBe("operator");

    const open = detail.reasonerIncidents.find((incident) => incident.id === "incident-open");
    expect(open?.autoClosed).toBe(false);
    expect(open?.resolutionSource).toBe(null);
  });
});

describe("sanitizePostMortemSuggestion", () => {
  it("rejects leaked chain-of-thought text", () => {
    const raw = "The user wants me to write a post-mortem note based on the incident data provided. Let me analyze the data:\n- Incident ID: ri_x\nLet me draft: \"The";
    const result = sanitizePostMortemSuggestion(raw);
    expect(result.usable).toBe(false);
  });

  it("accepts a clean post-mortem unchanged", () => {
    const raw = "The litellm.service outage was detected by sentinel_health monitoring and lasted about 30 minutes. Root cause was not recorded. Follow up by confirming the fix held.";
    const result = sanitizePostMortemSuggestion(raw);
    expect(result.usable).toBe(true);
    expect(result.text).toBe(raw);
  });

  it("strips a <think> block and accepts the remaining clean text", () => {
    const raw = "<think>I should mention the timeline and cause.</think>The service recovered after 30 minutes; monitor for recurrence.";
    const result = sanitizePostMortemSuggestion(raw);
    expect(result.usable).toBe(true);
    expect(result.text.startsWith("The service recovered")).toBe(true);
  });
});
