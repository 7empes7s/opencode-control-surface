import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { writeActionAudit } from "../db/writer.ts";
import { resolveStaleInsights, upsertInsight } from "../insights/store.ts";

const DEFAULT_INCIDENT_IDLE_RESOLVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function incidentIdleResolveMs(): number {
  const raw = process.env.INCIDENT_IDLE_RESOLVE_DAYS;
  const days = raw ? Number(raw) : DEFAULT_INCIDENT_IDLE_RESOLVE_DAYS;
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_INCIDENT_IDLE_RESOLVE_DAYS) * DAY_MS;
}

type StaleIncidentRow = {
  id: string;
  last_seen: number;
  acknowledged_at: number | null;
};

/**
 * Sweeps open reasoner_incidents whose condition hasn't recurred in
 * INCIDENT_IDLE_RESOLVE_DAYS (default 7) and auto-resolves them, since
 * nothing else ever closes an incident once the underlying condition clears.
 * Acknowledged incidents get a 2x grace period before they're swept too, so
 * an operator actively tracking one isn't immediately overridden.
 */
export function autoResolveStaleIncidents(now = Date.now()): { resolvedIds: string[] } {
  const resolvedIds: string[] = [];
  try {
    if (!isDashboardDbEnabled()) return { resolvedIds };
    const db = getDashboardDb();
    if (!db) return { resolvedIds };

    const idleMs = incidentIdleResolveMs();
    const veryIdleMs = idleMs * 2;
    const tenant = whereTenant();

    const candidates = db.query(`
      SELECT id, last_seen, acknowledged_at
      FROM reasoner_incidents
      WHERE status = 'open'
        AND last_seen < ?
        ${tenant.clause}
    `).all(now - idleMs, ...tenant.params) as StaleIncidentRow[];

    for (const row of candidates) {
      const idleFor = now - row.last_seen;
      if (row.acknowledged_at != null && idleFor < veryIdleMs) continue;

      db.query(`
        UPDATE reasoner_incidents
        SET status = 'resolved', resolved_at = COALESCE(resolved_at, ?)
        WHERE id = ?
          ${tenant.clause}
      `).run(now, row.id, ...tenant.params);

      const idleDays = Math.floor(idleFor / DAY_MS);
      writeActionAudit({
        actor: "system",
        actorSource: "scheduler",
        actionKind: "incidents.auto-resolve",
        targetType: "incident",
        targetId: row.id,
        reason: `auto-resolved: no recurrence in ${idleDays} days (condition appears cleared)`,
        result: "auto-resolved",
        resultStatus: "success",
      });

      resolvedIds.push(row.id);
    }
  } catch (error) {
    console.error("[incidents] auto-resolve sweep failed", error instanceof Error ? error.message : error);
  }
  return { resolvedIds };
}

/**
 * Closes open non-sentinel incidents whose workflow has since completed a
 * SUCCESSFUL builder pass — proof the condition recovered, so waiting out the
 * 7-day idle sweep would just be noise. Only incidents whose
 * representative_pass_id resolves to a real builder pass are considered;
 * anything unlinkable is honestly left for the idle sweep.
 */
export function autoCloseRecoveredIncidents(now = Date.now()): { closedIds: string[] } {
  const closedIds: string[] = [];
  try {
    if (!isDashboardDbEnabled()) return { closedIds };
    const db = getDashboardDb();
    if (!db) return { closedIds };
    const tenant = whereTenant(undefined, "i");

    const rows = db.query(`
      SELECT i.id, i.last_seen, p.workflow_id
      FROM reasoner_incidents i
      JOIN builder_passes p ON p.id = i.representative_pass_id
      WHERE i.status = 'open' AND i.failure_class != 'sentinel_health'
        ${tenant.clause}
    `).all(...tenant.params) as Array<{ id: string; last_seen: number; workflow_id: string }>;

    for (const row of rows) {
      const recovered = db.query(`
        SELECT id, finished_at FROM builder_passes
        WHERE workflow_id = ? AND status = 'success'
          AND COALESCE(finished_at, started_at, 0) > ?
        ORDER BY COALESCE(finished_at, started_at, 0) DESC
        LIMIT 1
      `).get(row.workflow_id, row.last_seen) as { id: string; finished_at: number | null } | null;
      if (!recovered) continue;

      db.query(`
        UPDATE reasoner_incidents
        SET status = 'resolved', resolved_at = COALESCE(resolved_at, ?), mitigated_at = COALESCE(mitigated_at, ?)
        WHERE id = ? AND status = 'open'
      `).run(now, now, row.id);
      closedIds.push(row.id);

      writeActionAudit({
        actor: "system",
        actorSource: "scheduler",
        actionKind: "incidents.auto-close",
        targetType: "incident",
        targetId: row.id,
        reason: `auto-closed: workflow ${row.workflow_id} completed a successful pass (${recovered.id}) after the failure`,
        result: "auto-closed",
        resultStatus: "success",
        resultJson: { workflowId: row.workflow_id, recoveryPassId: recovered.id },
      });
    }
  } catch (error) {
    console.error("[incidents] recovered-incident sweep failed", error instanceof Error ? error.message : error);
  }
  return { closedIds };
}

const RECURRENCE_WINDOW_MS = 7 * DAY_MS;
const RECURRENCE_THRESHOLD = 3;

/**
 * Flags conditions the remediation loop keeps "fixing": the same
 * (failure_class, title) producing >= 3 incidents inside 7 days means
 * auto-close is masking a flapping root cause, not curing it. Emits one
 * ops insight per recurring condition; insights auto-resolve once the
 * condition stops recurring.
 */
export function detectRecurringIncidents(now = Date.now()): { flagged: number; resolved: number } {
  try {
    if (!isDashboardDbEnabled()) return { flagged: 0, resolved: 0 };
    const db = getDashboardDb();
    if (!db) return { flagged: 0, resolved: 0 };
    const tenant = whereTenant();

    // Bare `id` next to MAX(last_seen) is the documented SQLite behaviour of
    // returning the column from the row that produced the max — i.e. the
    // group's most recent incident, used as the escalation target.
    const groups = db.query(`
      SELECT failure_class, title, COUNT(*) AS n, MAX(last_seen) AS latest, SUM(status = 'open') AS open_count, id AS latest_incident_id
      FROM reasoner_incidents
      WHERE first_seen >= ? ${tenant.clause}
      GROUP BY failure_class, title
      HAVING n >= ?
    `).all(now - RECURRENCE_WINDOW_MS, ...tenant.params, RECURRENCE_THRESHOLD) as Array<{
      failure_class: string; title: string; n: number; latest: number; open_count: number; latest_incident_id: string | null;
    }>;

    const activeKeys: string[] = [];
    for (const g of groups) {
      const slug = `${g.failure_class}|${g.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 100);
      const sourceKey = `remediation:recurrence:${slug}`;
      activeKeys.push(sourceKey);
      upsertInsight({
        id: `insight_${sourceKey.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        sourceKey,
        domain: "ops",
        severity: "high",
        title: "A condition keeps recurring despite auto-remediation",
        plainSummary: `"${g.title}" (${g.failure_class}) has produced ${g.n} incidents in the last 7 days` +
          `${g.open_count > 0 ? ` (${g.open_count} still open)` : ""}. ` +
          `The remediation loop keeps clearing it, but it keeps coming back — investigate the root cause instead of relying on auto-close.`,
        confidence: 0.9,
        evidenceRefs: [{
          label: "Recurring incidents",
          kind: "api",
          ref: `/api/reasoner/incidents?status=all`,
          redacted: false,
        }],
        actionDescriptorId: g.latest_incident_id ? `escalate:incident:${g.latest_incident_id}` : null,
        manualPageHref: "/incidents",
        createdAt: now,
      });
    }

    const resolved = resolveStaleInsights(
      "remediation:recurrence:",
      activeKeys,
      "The condition has stopped recurring (fewer than 3 incidents in the trailing 7 days).",
    );
    return { flagged: groups.length, resolved: resolved.length };
  } catch (error) {
    console.error("[incidents] recurrence detection failed", error instanceof Error ? error.message : error);
    return { flagged: 0, resolved: 0 };
  }
}
