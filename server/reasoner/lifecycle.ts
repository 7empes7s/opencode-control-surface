import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { writeActionAudit } from "../db/writer.ts";

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
