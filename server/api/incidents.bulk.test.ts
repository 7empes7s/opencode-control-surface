import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { handleApi } from "./router.ts";
import { BULK_INCIDENT_MAX_IDS } from "./incidents.ts";

describe("POST /api/incidents/bulk — bulk acknowledge/resolve/mute (ULTRAPLAN A1)", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousOperatorToken: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "incidents-bulk-"));
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

  function bulk(body: Record<string, unknown>) {
    return handleApi(apiReq("/api/incidents/bulk", { method: "POST", body: JSON.stringify(body) }), new URL("http://localhost/api/incidents/bulk"));
  }

  function seedIncident(id: string, opts: { tenantId?: string; status?: string } = {}) {
    getDashboardDb()!.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id, `${id}:cluster`, "build_failure", `Incident ${id}`, 1_000, 2_000,
      `pass-${id}`, `diag-${id}`, opts.status ?? "open", opts.tenantId ?? "mimule",
    );
  }

  it("acknowledges N incidents in one batch: one audit row per target sharing a batchId", async () => {
    seedIncident("bulk-ack-1");
    seedIncident("bulk-ack-2");
    seedIncident("bulk-ack-3");

    const res = await bulk({ action: "acknowledge", ids: ["bulk-ack-1", "bulk-ack-2", "bulk-ack-3"] });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; batchId: string; results: Array<{ id: string; ok: boolean }>;
      summary: { total: number; succeeded: number; failed: number };
    };
    expect(body.ok).toBe(true);
    expect(body.summary).toEqual({ total: 3, succeeded: 3, failed: 0 });
    expect(body.results.every((r) => r.ok)).toBe(true);
    expect(body.batchId).toMatch(/^batch_/);

    const db = getDashboardDb()!;
    const rows = db.query(`
      SELECT target_id, action_kind, result_json FROM action_audit
      WHERE action_kind = 'acknowledge.incident' AND target_id IN ('bulk-ack-1', 'bulk-ack-2', 'bulk-ack-3')
    `).all() as Array<{ target_id: string; action_kind: string; result_json: string | null }>;
    // One audit row per target — not a single combined row.
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(JSON.parse(row.result_json!).batchId).toBe(body.batchId);
    }

    for (const id of ["bulk-ack-1", "bulk-ack-2", "bulk-ack-3"]) {
      const incident = db.query(`SELECT acknowledged_at FROM reasoner_incidents WHERE id = ?`).get(id) as { acknowledged_at: number | null };
      expect(incident.acknowledged_at).toBeGreaterThan(0);
    }
  });

  it("resolves a batch with a shared reason applied to every target", async () => {
    seedIncident("bulk-resolve-1");
    seedIncident("bulk-resolve-2");

    const res = await bulk({ action: "resolve", ids: ["bulk-resolve-1", "bulk-resolve-2"], reason: "batch cleanup" });
    expect(res.status).toBe(200);
    const body = await res.json() as { summary: { total: number; succeeded: number; failed: number } };
    expect(body.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });

    const db = getDashboardDb()!;
    for (const id of ["bulk-resolve-1", "bulk-resolve-2"]) {
      const incident = db.query(`SELECT status, resolved_at FROM reasoner_incidents WHERE id = ?`).get(id) as { status: string; resolved_at: number | null };
      expect(incident.status).toBe("resolved");
      expect(incident.resolved_at).toBeGreaterThan(0);
    }
    const audits = db.query(`
      SELECT reason FROM action_audit WHERE action_kind = 'resolve.incident' AND target_id IN ('bulk-resolve-1', 'bulk-resolve-2')
    `).all() as Array<{ reason: string | null }>;
    expect(audits.length).toBe(2);
    for (const audit of audits) expect(audit.reason).toBe("batch cleanup");
  });

  it("mutes a batch with a duration, applied identically to every target", async () => {
    seedIncident("bulk-mute-1");
    seedIncident("bulk-mute-2");
    const before = Date.now();

    const res = await bulk({ action: "mute", ids: ["bulk-mute-1", "bulk-mute-2"], reason: "noisy while investigating", durationMs: 60 * 60 * 1000 });
    expect(res.status).toBe(200);
    const body = await res.json() as { summary: { succeeded: number } };
    expect(body.summary.succeeded).toBe(2);

    const db = getDashboardDb()!;
    for (const id of ["bulk-mute-1", "bulk-mute-2"]) {
      const row = db.query(`SELECT muted_at, muted_until FROM reasoner_incidents WHERE id = ?`).get(id) as { muted_at: number; muted_until: number };
      expect(row.muted_at).toBeGreaterThanOrEqual(before);
      expect(row.muted_until).toBe(row.muted_at + 60 * 60 * 1000);
    }
  });

  it("isolates a bad id (missing incident) from the rest of the batch — never aborts", async () => {
    seedIncident("bulk-mixed-1");
    seedIncident("bulk-mixed-2");

    const res = await bulk({ action: "acknowledge", ids: ["bulk-mixed-1", "does-not-exist", "bulk-mixed-2"] });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; results: Array<{ id: string; ok: boolean; error?: string }>;
      summary: { total: number; succeeded: number; failed: number }; message: string;
    };
    expect(body.ok).toBe(true);
    expect(body.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
    const failedResult = body.results.find((r) => r.id === "does-not-exist");
    expect(failedResult?.ok).toBe(false);
    expect(failedResult?.error).toBeTruthy();
    // Never silent: the failure is surfaced by id and reason in the message.
    expect(body.message).toContain("does-not-exist");

    const db = getDashboardDb()!;
    for (const id of ["bulk-mixed-1", "bulk-mixed-2"]) {
      const incident = db.query(`SELECT acknowledged_at FROM reasoner_incidents WHERE id = ?`).get(id) as { acknowledged_at: number | null };
      expect(incident.acknowledged_at).toBeGreaterThan(0);
    }
  });

  it("isolates an incident belonging to another tenant as a per-target failure", async () => {
    seedIncident("bulk-tenant-mine");
    seedIncident("bulk-tenant-other", { tenantId: "other-tenant" });

    const res = await bulk({ action: "acknowledge", ids: ["bulk-tenant-mine", "bulk-tenant-other"] });
    const body = await res.json() as { summary: { total: number; succeeded: number; failed: number }; results: Array<{ id: string; ok: boolean }> };
    expect(body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(body.results.find((r) => r.id === "bulk-tenant-other")?.ok).toBe(false);
  });

  it("rejects a batch over the cap without applying anything", async () => {
    const ids = Array.from({ length: BULK_INCIDENT_MAX_IDS + 1 }, (_, i) => `too-many-${i}`);
    const res = await bulk({ action: "acknowledge", ids });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain(String(BULK_INCIDENT_MAX_IDS));

    const count = (getDashboardDb()!.query(`SELECT COUNT(*) AS n FROM action_audit`).get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("accepts a batch at exactly the cap", async () => {
    const ids = Array.from({ length: BULK_INCIDENT_MAX_IDS }, (_, i) => `cap-${i}`);
    for (const id of ids) seedIncident(id);

    const res = await bulk({ action: "acknowledge", ids });
    expect(res.status).toBe(200);
    const body = await res.json() as { summary: { total: number; succeeded: number } };
    expect(body.summary.total).toBe(BULK_INCIDENT_MAX_IDS);
    expect(body.summary.succeeded).toBe(BULK_INCIDENT_MAX_IDS);
  });

  it("rejects an unknown bulk action", async () => {
    seedIncident("bulk-unknown-action");
    const res = await bulk({ action: "delete", ids: ["bulk-unknown-action"] });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("unknown bulk action");
  });

  it("rejects an empty ids array", async () => {
    const res = await bulk({ action: "acknowledge", ids: [] });
    expect(res.status).toBe(400);
  });

  it("rejects a bulk request without an operator token", async () => {
    seedIncident("bulk-no-token");
    const req = apiReq("/api/incidents/bulk", { method: "POST", body: JSON.stringify({ action: "acknowledge", ids: ["bulk-no-token"] }) }, "");
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(401);
  });

  it("de-duplicates repeated ids in a single batch", async () => {
    seedIncident("bulk-dedupe");
    const res = await bulk({ action: "acknowledge", ids: ["bulk-dedupe", "bulk-dedupe", "bulk-dedupe"] });
    const body = await res.json() as { summary: { total: number } };
    expect(body.summary.total).toBe(1);
  });
});
