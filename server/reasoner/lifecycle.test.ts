import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { getInsight } from "../insights/store.ts";
import { autoCloseRecoveredIncidents, autoResolveStaleIncidents, detectRecurringIncidents } from "./lifecycle.ts";

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

  function insertPass(id: string, workflowId: string, status: string, finishedAt: number): void {
    getDashboardDb()!.query(`
      INSERT INTO builder_passes (id, run_id, workflow_id, sequence, phase, status, started_at, finished_at)
      VALUES (?, 'run_test', ?, 1, 'build', ?, ?, ?)
    `).run(id, workflowId, status, finishedAt - 1000, finishedAt);
  }

  function insertLinkedIncident(id: string, passId: string, lastSeen: number, failureClass = "pass-timeout"): void {
    getDashboardDb()!.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open')
    `).run(id, `cluster_${id}`, failureClass, `title for ${id}`, lastSeen, lastSeen, passId, `diag_${id}`);
  }

  test("recovered workflow (newer successful pass) → non-sentinel incident auto-closed + audited", () => {
    const now = Date.now();
    const db = getDashboardDb()!;
    db.query("DELETE FROM builder_passes").run();
    insertPass("bp_failed", "wf_1", "failed", now - 2 * DAY_MS);
    insertLinkedIncident("ri_recovered", "bp_failed", now - 2 * DAY_MS);
    insertPass("bp_recovery", "wf_1", "success", now - DAY_MS);

    const { closedIds } = autoCloseRecoveredIncidents(now);

    expect(closedIds).toContain("ri_recovered");
    expect(readIncident("ri_recovered").status).toBe("resolved");
    const audit = db.query(
      `SELECT reason FROM action_audit WHERE target_id = 'ri_recovered' AND action_kind = 'incidents.auto-close'`,
    ).get() as { reason: string } | null;
    expect(audit?.reason).toContain("bp_recovery");
  });

  test("workflow with no newer successful pass → incident stays open", () => {
    const now = Date.now();
    getDashboardDb()!.query("DELETE FROM builder_passes").run();
    insertPass("bp_failed2", "wf_2", "failed", now - DAY_MS);
    insertLinkedIncident("ri_unrecovered", "bp_failed2", now - DAY_MS);

    const { closedIds } = autoCloseRecoveredIncidents(now);

    expect(closedIds).toEqual([]);
    expect(readIncident("ri_unrecovered").status).toBe("open");
  });

  test("unlinkable representative_pass_id is honestly left for the idle sweep", () => {
    const now = Date.now();
    getDashboardDb()!.query("DELETE FROM builder_passes").run();
    insertLinkedIncident("ri_unlinkable", "1", now - DAY_MS);

    const { closedIds } = autoCloseRecoveredIncidents(now);

    expect(closedIds).toEqual([]);
    expect(readIncident("ri_unlinkable").status).toBe("open");
  });
});

describe("detectRecurringIncidents", () => {
  const testDbPath = `/tmp/test-recurrence-${Date.now()}.sqlite`;
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
    db.query("DELETE FROM reasoner_incidents").run();
    db.query("DELETE FROM insights").run();
  });

  function insertRecurrence(id: string, title: string, firstSeen: number): void {
    getDashboardDb()!.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status)
      VALUES (?, ?, 'sentinel_health', ?, ?, ?, 1, ?, ?, 'resolved')
    `).run(id, `cluster_${id}`, title, firstSeen, firstSeen, `pass_${id}`, `diag_${id}`);
  }

  test("3 incidents for the same condition in 7 days → high ops insight; stopping → auto-resolves", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      insertRecurrence(`ri_flap_${i}`, "[high/high] api /health failing", now - i * DAY_MS);
    }

    const first = detectRecurringIncidents(now);
    expect(first.flagged).toBe(1);

    const db = getDashboardDb()!;
    const insight = db.query(
      `SELECT id, severity, status FROM insights WHERE source_key LIKE 'remediation:recurrence:%'`,
    ).get() as { id: string; severity: string; status: string } | null;
    expect(insight).toBeTruthy();
    expect(insight!.severity).toBe("high");
    expect(insight!.status).toBe("open");

    // Incidents age out of the window → recurrence insight auto-resolves.
    const later = now + 8 * DAY_MS;
    const second = detectRecurringIncidents(later);
    expect(second.flagged).toBe(0);
    expect(second.resolved).toBe(1);
    expect(getInsight(insight!.id)!.status).toBe("resolved");
  });

  test("2 incidents in the window stay below the threshold — no insight", () => {
    const now = Date.now();
    insertRecurrence("ri_two_a", "[high/high] flappy thing", now - DAY_MS);
    insertRecurrence("ri_two_b", "[high/high] flappy thing", now - 2 * DAY_MS);

    const { flagged } = detectRecurringIncidents(now);

    expect(flagged).toBe(0);
    const count = (getDashboardDb()!.query(
      `SELECT COUNT(*) AS n FROM insights WHERE source_key LIKE 'remediation:recurrence:%'`,
    ).get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
