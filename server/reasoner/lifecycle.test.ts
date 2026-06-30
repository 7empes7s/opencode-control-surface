import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { autoResolveStaleIncidents } from "./lifecycle.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("autoResolveStaleIncidents", () => {
  const testDbPath = `/tmp/test-lifecycle-${Date.now()}.sqlite`;
  let prevDashboardDb: string | undefined;

  beforeAll(() => {
    prevDashboardDb = process.env.DASHBOARD_DB;
    process.env.DASHBOARD_DB = "1";
    initDashboardDb({ enabled: true, path: testDbPath });
  });

  afterAll(() => {
    closeDashboardDb();
    if (prevDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = prevDashboardDb;
  });

  beforeEach(() => {
    const db = getDashboardDb()!;
    db.query("DELETE FROM reasoner_incident_members").run();
    db.query("DELETE FROM reasoner_incidents").run();
    db.query("DELETE FROM action_audit").run();
  });

  function insertIncident(id: string, opts: {
    lastSeen: number;
    acknowledgedAt?: number | null;
    resolvedAt?: number | null;
    status?: string;
  }): void {
    const db = getDashboardDb()!;
    db.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, acknowledged_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      id, `cluster_${id}`, "test_failure", `title for ${id}`,
      opts.lastSeen, opts.lastSeen, `pass_${id}`, `diag_${id}`,
      opts.status ?? "open", opts.acknowledgedAt ?? null, opts.resolvedAt ?? null,
    );
  }

  function readIncident(id: string): { status: string; resolved_at: number | null; acknowledged_at: number | null } {
    const db = getDashboardDb()!;
    return db.query(`SELECT status, resolved_at, acknowledged_at FROM reasoner_incidents WHERE id = ?`).get(id) as any;
  }

  function auditRowFor(id: string): { action_kind: string; actor: string; actor_source: string; reason: string; result_status: string } | null {
    const db = getDashboardDb()!;
    return db.query(`SELECT action_kind, actor, actor_source, reason, result_status FROM action_audit WHERE target_id = ? AND action_kind = 'incidents.auto-resolve'`).get(id) as any;
  }

  test("open incident idle 8 days → auto-resolved + audited", () => {
    const now = Date.now();
    insertIncident("ri_8d", { lastSeen: now - 8 * DAY_MS });

    const { resolvedIds } = autoResolveStaleIncidents(now);

    expect(resolvedIds).toContain("ri_8d");
    const row = readIncident("ri_8d");
    expect(row.status).toBe("resolved");
    expect(row.resolved_at).toBeTruthy();

    const audit = auditRowFor("ri_8d");
    expect(audit).toBeTruthy();
    expect(audit!.actor).toBe("system");
    expect(audit!.actor_source).toBe("scheduler");
    expect(audit!.result_status).toBe("success");
    expect(audit!.reason).toContain("no recurrence in 8 days");
  });

  test("open incident idle 1 day → NOT resolved", () => {
    const now = Date.now();
    insertIncident("ri_1d", { lastSeen: now - 1 * DAY_MS });

    const { resolvedIds } = autoResolveStaleIncidents(now);

    expect(resolvedIds).not.toContain("ri_1d");
    expect(readIncident("ri_1d").status).toBe("open");
  });

  test("acknowledged incident idle 8 days (< 2x threshold) → NOT resolved", () => {
    const now = Date.now();
    insertIncident("ri_ack_8d", { lastSeen: now - 8 * DAY_MS, acknowledgedAt: now - 8 * DAY_MS });

    const { resolvedIds } = autoResolveStaleIncidents(now);

    expect(resolvedIds).not.toContain("ri_ack_8d");
    expect(readIncident("ri_ack_8d").status).toBe("open");
  });

  test("acknowledged incident idle > 2x threshold (15 days) → resolved", () => {
    const now = Date.now();
    insertIncident("ri_ack_15d", { lastSeen: now - 15 * DAY_MS, acknowledgedAt: now - 15 * DAY_MS });

    const { resolvedIds } = autoResolveStaleIncidents(now);

    expect(resolvedIds).toContain("ri_ack_15d");
    expect(readIncident("ri_ack_15d").status).toBe("resolved");
  });

  test("resolved_at is set when missing and not clobbered when already present", () => {
    const now = Date.now();
    const earlierResolvedAt = now - 100;
    insertIncident("ri_already_resolved_at", { lastSeen: now - 8 * DAY_MS, resolvedAt: earlierResolvedAt });

    autoResolveStaleIncidents(now);

    const row = readIncident("ri_already_resolved_at");
    expect(row.status).toBe("resolved");
    expect(row.resolved_at).toBe(earlierResolvedAt);
  });

  test("env override INCIDENT_IDLE_RESOLVE_DAYS changes the threshold", () => {
    const prev = process.env.INCIDENT_IDLE_RESOLVE_DAYS;
    process.env.INCIDENT_IDLE_RESOLVE_DAYS = "1";
    try {
      const now = Date.now();
      insertIncident("ri_short_threshold", { lastSeen: now - 2 * DAY_MS });

      const { resolvedIds } = autoResolveStaleIncidents(now);

      expect(resolvedIds).toContain("ri_short_threshold");
    } finally {
      if (prev === undefined) delete process.env.INCIDENT_IDLE_RESOLVE_DAYS;
      else process.env.INCIDENT_IDLE_RESOLVE_DAYS = prev;
    }
  });
});
