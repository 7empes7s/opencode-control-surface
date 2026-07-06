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
    slaDueAt?: number | null;
    owner?: string | null;
  }) {
    const passId = `pass-${input.id}`;
    const diagnosisId = `diagnosis-${input.id}`;
    seedDiagnosis(diagnosisId, passId);
    getDashboardDb()!.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, acknowledged_at, resolved_at,
         sla_due_at, owner, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.slaDueAt ?? null,
      input.owner ?? null,
      "mimule",
    );
  }

  it("computes MTTA, MTTR, open age, SLA breach/due-soon counts, and RCA from real rows", () => {
    const now = Date.now();
    // Anchored recently (within the trailing 90d MTTX sample window) so these
    // count toward the means — see the dedicated windowing test below for rows
    // that fall OUTSIDE the window.
    seedIncident({ id: "incident-a", firstSeen: now - 1_000_000, acknowledgedAt: now - 1_000_000 + 3_000, resolvedAt: now - 1_000_000 + 10_000, status: "resolved" });
    seedIncident({ id: "incident-b", firstSeen: now - 900_000, acknowledgedAt: now - 900_000 + 6_000, resolvedAt: now - 900_000 + 20_000, status: "resolved" });
    // Breached: sla_due_at is in the past.
    seedIncident({ id: "incident-open", firstSeen: now - 25 * 60 * 60 * 1000, status: "open", slaDueAt: now - 60 * 60 * 1000 });
    // Due-soon: sla_due_at is 30 minutes away, well within the (capped 6h) approaching window.
    seedIncident({ id: "incident-due-soon", firstSeen: now - 60 * 60 * 1000, status: "open", slaDueAt: now + 30 * 60 * 1000 });
    // Open but nowhere near its deadline: must not count toward either metric.
    seedIncident({ id: "incident-not-due", firstSeen: now - 60 * 60 * 1000, status: "open", slaDueAt: now + 10 * 24 * 60 * 60 * 1000 });
    // Open with no sla_due_at at all (e.g. pre-migration row): excluded from both.
    seedIncident({ id: "incident-no-deadline", firstSeen: now - 60 * 60 * 1000, status: "open" });

    const detail = buildIncidentsDetail();

    expect(detail.sla.meanTimeToAcknowledgeMs).toBe(4_500);
    expect(detail.sla.meanTimeToResolveMs).toBe(15_000);
    expect(detail.sla.acknowledgedSamples).toBe(2);
    expect(detail.sla.resolvedSamples).toBe(2);
    expect(detail.sla.sampleWindowMs).toBe(90 * 24 * 60 * 60 * 1000);
    expect(detail.sla.oldestOpenAgeMs).toBeGreaterThanOrEqual(25 * 60 * 60 * 1000 - 1_000);
    expect(detail.sla.slaBreachedOpenCount).toBe(1);
    expect(detail.sla.slaDueSoonCount).toBe(1);
    expect(detail.reasonerIncidents.find((incident) => incident.id === "incident-a")?.rootCause).toContain("Root cause");
  });

  it("excludes ancient acknowledged_at/resolved_at samples from MTTA/MTTR (task #23) but still counts recent ones", () => {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Completion outside the window: resolved/acked 100 days ago — excluded
    // regardless of birth.
    seedIncident({
      id: "incident-ancient",
      firstSeen: now - 900 * DAY_MS,
      acknowledgedAt: now - 100 * DAY_MS,
      resolvedAt: now - 100 * DAY_MS,
      status: "resolved",
    });
    // THE live-DB bug scenario (2023-era rows mass-closed on Jun 30): born
    // 2 years ago but acked/resolved YESTERDAY. Completion recency alone
    // would admit this row and its ~730d duration into the mean; the birth
    // (first_seen) cutoff must exclude it.
    seedIncident({
      id: "incident-born-ancient-resolved-yesterday",
      firstSeen: now - 730 * DAY_MS,
      acknowledgedAt: now - DAY_MS,
      resolvedAt: now - DAY_MS,
      status: "resolved",
    });
    // A normal incident born AND completed inside the window: included.
    seedIncident({
      id: "incident-recent",
      firstSeen: now - 60_000,
      acknowledgedAt: now - 50_000,
      resolvedAt: now - 40_000,
      status: "resolved",
    });

    const detail = buildIncidentsDetail();

    // Only the born-and-completed-in-window row counts.
    expect(detail.sla.acknowledgedSamples).toBe(1);
    expect(detail.sla.resolvedSamples).toBe(1);
    expect(detail.sla.meanTimeToAcknowledgeMs).toBe(10_000);
    expect(detail.sla.meanTimeToResolveMs).toBe(20_000);
    expect(detail.sla.sampleWindowMs).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("reports null means and zero samples (never a fake 0ms) when no incident qualifies for the MTTX window", () => {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Only disqualified rows exist: born ancient, resolved recently — the
    // exact shape of the live DB after the Jun 30 mass-close.
    seedIncident({
      id: "incident-only-disqualified",
      firstSeen: now - 730 * DAY_MS,
      acknowledgedAt: now - DAY_MS,
      resolvedAt: now - DAY_MS,
      status: "resolved",
    });

    const detail = buildIncidentsDetail();

    expect(detail.sla.acknowledgedSamples).toBe(0);
    expect(detail.sla.resolvedSamples).toBe(0);
    expect(detail.sla.meanTimeToAcknowledgeMs).toBeNull();
    expect(detail.sla.meanTimeToResolveMs).toBeNull();
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

  it("mutes incidents through the token-gated audited handler", async () => {
    seedIncident({ id: "incident-muted", firstSeen: 1_000 });

    const res = await handleApi(
      apiReq("/api/incidents/incident-muted/mute", {
        method: "POST",
        body: JSON.stringify({ reason: "noisy duplicate while build is already being fixed" }),
      }),
      new URL("http://localhost/api/incidents/incident-muted/mute"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const row = getDashboardDb()!.query(`
      SELECT muted_at, muted_by, mute_reason
      FROM reasoner_incidents
      WHERE id = ?
    `).get("incident-muted") as { muted_at: number | null; muted_by: string | null; mute_reason: string | null };
    expect(row.muted_at).toBeGreaterThan(0);
    expect(row.muted_by).toBe("operator");
    expect(row.mute_reason).toBe("noisy duplicate while build is already being fixed");

    const detail = buildIncidentsDetail();
    const muted = detail.reasonerIncidents.find((incident) => incident.id === "incident-muted");
    expect(muted?.mutedAt).toBe(row.muted_at);
    expect(muted?.mutedBy).toBe("operator");
    expect(muted?.muteReason).toBe("noisy duplicate while build is already being fixed");
    expect(muted?.mutedUntil).toBeNull();
    expect(muted?.muteActive).toBe(true);

    const audit = getDashboardDb()!.query(`
      SELECT action_id, reason, result_status FROM action_audit
      WHERE action_id = ?
    `).get("mute:incident:incident-muted") as { action_id: string; reason: string | null; result_status: string } | null;
    expect(audit?.action_id).toBe("mute:incident:incident-muted");
    expect(audit?.reason).toBe("noisy duplicate while build is already being fixed");
    expect(audit?.result_status).toBe("success");
  });

  it("snoozes incidents with durationMs and expires the mute after the deadline", async () => {
    seedIncident({ id: "incident-snoozed", firstSeen: 1_000 });

    const before = Date.now();
    const res = await handleApi(
      apiReq("/api/incidents/incident-snoozed/mute", {
        method: "POST",
        body: JSON.stringify({ reason: "snooze for an hour", durationMs: 60 * 60 * 1000 }),
      }),
      new URL("http://localhost/api/incidents/incident-snoozed/mute"),
    );
    expect(res.status).toBe(200);

    const row = getDashboardDb()!.query(`
      SELECT muted_at, muted_until FROM reasoner_incidents WHERE id = ?
    `).get("incident-snoozed") as { muted_at: number | null; muted_until: number | null };
    expect(row.muted_at).toBeGreaterThanOrEqual(before);
    expect(row.muted_until).toBe((row.muted_at ?? 0) + 60 * 60 * 1000);

    const detail = buildIncidentsDetail();
    const snoozed = detail.reasonerIncidents.find((incident) => incident.id === "incident-snoozed");
    expect(snoozed?.mutedUntil).toBe(row.muted_until);
    expect(snoozed?.muteActive).toBe(true);

    // Simulate the deadline passing: an expired snooze reads as not muted.
    getDashboardDb()!.query(`
      UPDATE reasoner_incidents SET muted_until = ? WHERE id = ?
    `).run(Date.now() - 1_000, "incident-snoozed");
    const expired = buildIncidentsDetail().reasonerIncidents.find((incident) => incident.id === "incident-snoozed");
    expect(expired?.muteActive).toBe(false);
    expect(expired?.mutedAt).not.toBeNull();
  });

  it("caps snooze duration at 90 days and ignores invalid durations", async () => {
    seedIncident({ id: "incident-capped", firstSeen: 1_000 });
    const res = await handleApi(
      apiReq("/api/incidents/incident-capped/mute", {
        method: "POST",
        body: JSON.stringify({ reason: "absurd snooze", durationMs: 400 * 24 * 60 * 60 * 1000 }),
      }),
      new URL("http://localhost/api/incidents/incident-capped/mute"),
    );
    expect(res.status).toBe(200);
    const row = getDashboardDb()!.query(`
      SELECT muted_at, muted_until FROM reasoner_incidents WHERE id = ?
    `).get("incident-capped") as { muted_at: number; muted_until: number };
    expect(row.muted_until - row.muted_at).toBe(90 * 24 * 60 * 60 * 1000);

    seedIncident({ id: "incident-bad-duration", firstSeen: 1_000 });
    const badRes = await handleApi(
      apiReq("/api/incidents/incident-bad-duration/mute", {
        method: "POST",
        body: JSON.stringify({ reason: "negative duration", durationMs: -5 }),
      }),
      new URL("http://localhost/api/incidents/incident-bad-duration/mute"),
    );
    expect(badRes.status).toBe(200);
    const badRow = getDashboardDb()!.query(`
      SELECT muted_until FROM reasoner_incidents WHERE id = ?
    `).get("incident-bad-duration") as { muted_until: number | null };
    expect(badRow.muted_until).toBeNull();
  });

  it("unmutes incidents, clears all mute state, and audits the action", async () => {
    seedIncident({ id: "incident-unmuted", firstSeen: 1_000 });
    const muteRes = await handleApi(
      apiReq("/api/incidents/incident-unmuted/mute", {
        method: "POST",
        body: JSON.stringify({ reason: "temporary mute", durationMs: 60 * 60 * 1000 }),
      }),
      new URL("http://localhost/api/incidents/incident-unmuted/mute"),
    );
    expect(muteRes.status).toBe(200);

    const res = await handleApi(
      apiReq("/api/incidents/incident-unmuted/unmute", { method: "POST" }),
      new URL("http://localhost/api/incidents/incident-unmuted/unmute"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const row = getDashboardDb()!.query(`
      SELECT muted_at, muted_by, mute_reason, muted_until FROM reasoner_incidents WHERE id = ?
    `).get("incident-unmuted") as { muted_at: number | null; muted_by: string | null; mute_reason: string | null; muted_until: number | null };
    expect(row.muted_at).toBeNull();
    expect(row.muted_by).toBeNull();
    expect(row.mute_reason).toBeNull();
    expect(row.muted_until).toBeNull();

    const detail = buildIncidentsDetail();
    const unmuted = detail.reasonerIncidents.find((incident) => incident.id === "incident-unmuted");
    expect(unmuted?.muteActive).toBe(false);

    const audit = getDashboardDb()!.query(`
      SELECT action_id, result_status FROM action_audit WHERE action_id = ?
    `).get("unmute:incident:incident-unmuted") as { action_id: string; result_status: string } | null;
    expect(audit?.action_id).toBe("unmute:incident:incident-unmuted");
    expect(audit?.result_status).toBe("success");
  });

  it("assigns an owner, reflects it in the detail payload, and audits the write", async () => {
    seedIncident({ id: "incident-assign", firstSeen: 1_000 });

    const res = await handleApi(
      apiReq("/api/incidents/incident-assign/assign", {
        method: "POST",
        body: JSON.stringify({ owner: "marouane@example.com" }),
      }),
      new URL("http://localhost/api/incidents/incident-assign/assign"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const row = getDashboardDb()!.query(`
      SELECT owner FROM reasoner_incidents WHERE id = ?
    `).get("incident-assign") as { owner: string | null };
    expect(row.owner).toBe("marouane@example.com");

    const detail = buildIncidentsDetail();
    const assigned = detail.reasonerIncidents.find((incident) => incident.id === "incident-assign");
    expect(assigned?.owner).toBe("marouane@example.com");

    const audit = getDashboardDb()!.query(`
      SELECT action_kind, action_id, result_status FROM action_audit
      WHERE action_id = ? AND action_kind = ?
    `).get("assign:incident:incident-assign", "incidents.assign") as { action_kind: string; action_id: string; result_status: string } | null;
    expect(audit?.action_kind).toBe("incidents.assign");
    expect(audit?.result_status).toBe("success");
  });

  it("unassigns an incident by assigning an empty owner, clearing the column to NULL", async () => {
    seedIncident({ id: "incident-unassign", firstSeen: 1_000, owner: "someone@example.com" });

    const res = await handleApi(
      apiReq("/api/incidents/incident-unassign/assign", {
        method: "POST",
        body: JSON.stringify({ owner: "" }),
      }),
      new URL("http://localhost/api/incidents/incident-unassign/assign"),
    );
    expect(res.status).toBe(200);

    const row = getDashboardDb()!.query(`
      SELECT owner FROM reasoner_incidents WHERE id = ?
    `).get("incident-unassign") as { owner: string | null };
    expect(row.owner).toBeNull();

    const detail = buildIncidentsDetail();
    const unassigned = detail.reasonerIncidents.find((incident) => incident.id === "incident-unassign");
    expect(unassigned?.owner).toBeNull();
  });

  it("rejects an owner longer than 120 characters", async () => {
    seedIncident({ id: "incident-assign-too-long", firstSeen: 1_000 });
    const res = await handleApi(
      apiReq("/api/incidents/incident-assign-too-long/assign", {
        method: "POST",
        body: JSON.stringify({ owner: "x".repeat(121) }),
      }),
      new URL("http://localhost/api/incidents/incident-assign-too-long/assign"),
    );
    expect(res.status).toBe(400);
    const row = getDashboardDb()!.query(`
      SELECT owner FROM reasoner_incidents WHERE id = ?
    `).get("incident-assign-too-long") as { owner: string | null };
    expect(row.owner).toBeNull();
  });

  it("rejects assign without an operator token", async () => {
    seedIncident({ id: "incident-assign-no-token", firstSeen: 1_000 });
    const req = apiReq("/api/incidents/incident-assign-no-token/assign", {
      method: "POST",
      body: JSON.stringify({ owner: "someone@example.com" }),
    }, "");
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(401);
  });

  it("rejects unmute without an operator token", async () => {
    seedIncident({ id: "incident-unmute-no-token", firstSeen: 1_000 });
    const req = apiReq("/api/incidents/incident-unmute-no-token/unmute", { method: "POST" }, "");
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(401);
  });

  it("excludes actively muted incidents from the SLA breach count, and counts them again after expiry", async () => {
    const now = Date.now();
    seedIncident({ id: "incident-breaching", firstSeen: now - 25 * 60 * 60 * 1000, status: "open", slaDueAt: now - 60 * 60 * 1000 });
    expect(buildIncidentsDetail().sla.slaBreachedOpenCount).toBe(1);

    const res = await handleApi(
      apiReq("/api/incidents/incident-breaching/mute", {
        method: "POST",
        body: JSON.stringify({ reason: "known issue, fix scheduled", durationMs: 60 * 60 * 1000 }),
      }),
      new URL("http://localhost/api/incidents/incident-breaching/mute"),
    );
    expect(res.status).toBe(200);
    expect(buildIncidentsDetail().sla.slaBreachedOpenCount).toBe(0);

    getDashboardDb()!.query(`
      UPDATE reasoner_incidents SET muted_until = ? WHERE id = ?
    `).run(now - 1_000, "incident-breaching");
    expect(buildIncidentsDetail().sla.slaBreachedOpenCount).toBe(1);
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
