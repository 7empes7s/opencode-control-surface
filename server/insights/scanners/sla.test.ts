import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import { mapSlaFindings, runSlaScan, type SlaIncidentRow } from "./sla.ts";

// ── Pure mapping tests (no DB) ──────────────────────────────────────────────

function row(overrides: Partial<SlaIncidentRow> & { id: string }): SlaIncidentRow {
  return {
    id: overrides.id,
    title: overrides.title ?? "[high/medium] Something is wrong",
    first_seen: overrides.first_seen ?? 0,
    sla_due_at: overrides.sla_due_at ?? null,
    acknowledged_at: overrides.acknowledged_at ?? null,
    owner: overrides.owner ?? null,
    muted_at: overrides.muted_at ?? null,
    muted_until: overrides.muted_until ?? null,
  };
}

describe("mapSlaFindings (pure)", () => {
  test("emits a breach finding when now > sla_due_at", () => {
    const now = 1_000_000;
    const rows = [row({ id: "ri_1", sla_due_at: now - 60_000 })];
    const findings = mapSlaFindings(rows, now);
    expect(findings).toHaveLength(1);
    expect(findings[0].sourceKey).toBe("sla:breach:ri_1");
    expect(findings[0].title).toBe("An incident has breached its SLA");
    expect(findings[0].severity).toBe("high");
    expect(findings[0].domain).toBe("ops");
    expect(findings[0].manualPageHref).toBe("/incidents");
  });

  test("emits an approaching finding when due within the (capped) approaching window but not yet breached", () => {
    const now = 1_000_000;
    // [high/medium] => 24h window => approaching window = 6h. Due in 1h.
    const rows = [row({ id: "ri_2", sla_due_at: now + 60 * 60 * 1000 })];
    const findings = mapSlaFindings(rows, now);
    expect(findings).toHaveLength(1);
    expect(findings[0].sourceKey).toBe("sla:approaching:ri_2");
    expect(findings[0].title).toBe("An incident is approaching its SLA deadline");
  });

  test("emits nothing when the incident is open but nowhere near its deadline", () => {
    const now = 1_000_000;
    const rows = [row({ id: "ri_3", sla_due_at: now + 30 * 24 * 60 * 60 * 1000 })];
    expect(mapSlaFindings(rows, now)).toHaveLength(0);
  });

  test("skips rows with no sla_due_at", () => {
    const now = 1_000_000;
    const rows = [row({ id: "ri_4", sla_due_at: null })];
    expect(mapSlaFindings(rows, now)).toHaveLength(0);
  });

  test("excludes an actively muted incident from both breach and approaching detection", () => {
    const now = 1_000_000;
    const mutedForever = row({ id: "ri_5", sla_due_at: now - 60_000, muted_at: now - 1_000, muted_until: null });
    const mutedUntilFuture = row({ id: "ri_6", sla_due_at: now + 60_000, muted_at: now - 1_000, muted_until: now + 60_000 });
    expect(mapSlaFindings([mutedForever, mutedUntilFuture], now)).toHaveLength(0);
  });

  test("counts an incident again once its mute has expired", () => {
    const now = 1_000_000;
    const expiredMute = row({ id: "ri_7", sla_due_at: now - 60_000, muted_at: now - 10_000, muted_until: now - 1_000 });
    const findings = mapSlaFindings([expiredMute], now);
    expect(findings).toHaveLength(1);
    expect(findings[0].sourceKey).toBe("sla:breach:ri_7");
  });

  test("reflects ack state: actionDescriptorId points to acknowledge when unacknowledged, null once acknowledged", () => {
    const now = 1_000_000;
    const unacked = row({ id: "ri_8", sla_due_at: now - 60_000, acknowledged_at: null });
    const acked = row({ id: "ri_9", sla_due_at: now - 60_000, acknowledged_at: now - 500_000 });
    const findings = mapSlaFindings([unacked, acked], now);
    const unackedFinding = findings.find((f) => f.sourceKey === "sla:breach:ri_8");
    const ackedFinding = findings.find((f) => f.sourceKey === "sla:breach:ri_9");
    expect(unackedFinding?.actionDescriptorId).toBe("acknowledge:incident:ri_8");
    expect(ackedFinding?.actionDescriptorId).toBeNull();
    expect(unackedFinding?.plainSummary).toContain("not yet acknowledged");
    expect(ackedFinding?.plainSummary).toContain("acknowledged");
  });

  test("plainSummary reports the owner, or 'unassigned' when none is set", () => {
    const now = 1_000_000;
    const owned = row({ id: "ri_10", sla_due_at: now - 60_000, owner: "marouane@example.com" });
    const unowned = row({ id: "ri_11", sla_due_at: now - 60_000, owner: null });
    const findings = mapSlaFindings([owned, unowned], now);
    expect(findings.find((f) => f.sourceKey === "sla:breach:ri_10")?.plainSummary).toContain("marouane@example.com");
    expect(findings.find((f) => f.sourceKey === "sla:breach:ri_11")?.plainSummary).toContain("unassigned");
  });
});

// ── Hermetic DB-backed scan tests ───────────────────────────────────────────

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "sla-scanner-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

function seedIncident(input: {
  id: string;
  title: string;
  firstSeen: number;
  slaDueAt: number | null;
  status?: string;
  acknowledgedAt?: number | null;
  owner?: string | null;
  mutedAt?: number | null;
  mutedUntil?: number | null;
}): void {
  const tenant = whereTenant();
  const tenantId = tenant.params[0];
  db().query(`
    INSERT INTO reasoner_incidents
      (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
       representative_pass_id, representative_diagnosis_id, status, sla_due_at,
       acknowledged_at, owner, muted_at, muted_until, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    `${input.id}:cluster`,
    "build_failure",
    input.title,
    input.firstSeen,
    input.firstSeen + 100,
    `${input.id}:pass`,
    `${input.id}:diag`,
    input.status ?? "open",
    input.slaDueAt,
    input.acknowledgedAt ?? null,
    input.owner ?? null,
    input.mutedAt ?? null,
    input.mutedUntil ?? null,
    tenantId,
  );
}

function openInsights(): Array<{ source_key: string | null; status: string }> {
  return db().query(`SELECT source_key, status FROM insights WHERE status = 'open'`).all() as Array<{
    source_key: string | null;
    status: string;
  }>;
}

describe("runSlaScan (hermetic)", () => {
  test("creates an open insight for a breached open incident", () => {
    const now = Date.now();
    seedIncident({ id: "ri_breach", title: "[high/medium] litellm.service is down", firstSeen: now - 100_000, slaDueAt: now - 60_000 });

    const result = runSlaScan();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].sourceKey).toBe("sla:breach:ri_breach");
    expect(result.findings[0].status).toBe("open");
  });

  test("creates an open insight for an approaching open incident", () => {
    const now = Date.now();
    seedIncident({ id: "ri_approach", title: "[high/medium] litellm.service is down", firstSeen: now - 100_000, slaDueAt: now + 60 * 60 * 1000 });

    const result = runSlaScan();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].sourceKey).toBe("sla:approaching:ri_approach");
  });

  test("excludes a resolved incident even if its stale sla_due_at is in the past", () => {
    const now = Date.now();
    seedIncident({ id: "ri_resolved", title: "[high/medium] x", firstSeen: now - 100_000, slaDueAt: now - 60_000, status: "resolved" });

    const result = runSlaScan();
    expect(result.findings).toHaveLength(0);
  });

  test("excludes a muted incident", () => {
    const now = Date.now();
    seedIncident({
      id: "ri_muted", title: "[high/medium] x", firstSeen: now - 100_000, slaDueAt: now - 60_000,
      mutedAt: now - 1_000, mutedUntil: null,
    });

    const result = runSlaScan();
    expect(result.findings).toHaveLength(0);
  });

  test("auto-resolves the breach insight once the incident is resolved on a later scan", () => {
    const now = Date.now();
    seedIncident({ id: "ri_stale", title: "[high/medium] x", firstSeen: now - 100_000, slaDueAt: now - 60_000 });

    const first = runSlaScan();
    expect(first.findings).toHaveLength(1);
    expect(openInsights().map((i) => i.source_key)).toContain("sla:breach:ri_stale");

    db().query(`UPDATE reasoner_incidents SET status = 'resolved' WHERE id = ?`).run("ri_stale");

    const second = runSlaScan();
    expect(second.findings).toHaveLength(0);
    expect(second.resolvedCount).toBe(1);
    expect(openInsights().map((i) => i.source_key)).not.toContain("sla:breach:ri_stale");

    const resolvedRow = db().query(`SELECT status, resolution FROM insights WHERE source_key = ?`)
      .get("sla:breach:ri_stale") as { status: string; resolution: string | null };
    expect(resolvedRow.status).toBe("resolved");
    expect(resolvedRow.resolution).toBeTruthy();
  });

  test("auto-resolves the approaching insight once the deadline passes into breach on the next scan (sourceKey changes)", () => {
    const now = Date.now();
    seedIncident({ id: "ri_transition", title: "[high/medium] x", firstSeen: now - 100_000, slaDueAt: now + 60_000 });

    const first = runSlaScan();
    expect(first.findings[0].sourceKey).toBe("sla:approaching:ri_transition");

    db().query(`UPDATE reasoner_incidents SET sla_due_at = ? WHERE id = ?`).run(now - 60_000, "ri_transition");

    const second = runSlaScan();
    expect(second.findings[0].sourceKey).toBe("sla:breach:ri_transition");
    expect(second.resolvedCount).toBe(1);

    const approachingRow = db().query(`SELECT status FROM insights WHERE source_key = ?`)
      .get("sla:approaching:ri_transition") as { status: string };
    expect(approachingRow.status).toBe("resolved");
  });

  test("no-ops safely when the dashboard DB is unavailable", () => {
    closeDashboardDb();
    delete process.env.DASHBOARD_DB;
    const result = runSlaScan();
    expect(result.findings).toHaveLength(0);
    expect(result.resolvedCount).toBe(0);
  });
});
