import { randomUUID } from "node:crypto";
import { getAuthenticatedUser } from "../auth/session.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_RETENTION_MS = 90 * DAY_MS;

export type UsageSummary = {
  from: string;
  to: string;
  paths: Array<{ path: string; pageviews: number; actions: number }>;
  totals: { pageviews: number; actions: number };
};

export type ModuleUsage = {
  from: string;
  to: string;
  modules: Array<{ path: string; pageviews: number; actions: number; findingsActedOn: number }>;
  totals: { pageviews: number; actions: number; findingsActedOn: number };
};

function normalizePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  const delimiterIndex = value.search(/[?#]/);
  const path = delimiterIndex === -1 ? value : value.slice(0, delimiterIndex);
  if (!path.startsWith("/") || path.length === 0) return null;
  return path;
}

function utcDay(value: number | Date | string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsedDay = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isFinite(parsedDay) && new Date(parsedDay).toISOString().slice(0, 10) === value) return value;
    throw new Error("invalid usage summary date");
  }
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid usage summary date");
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Records a pageview batch. Oversized/empty batches are rejected as a whole;
 * malformed rows inside an otherwise valid batch are skipped.
 */
export function recordUsageEvents(events: Array<{ path: string }>, req: Request): number {
  if (!Array.isArray(events) || events.length === 0 || events.length > 50) return 0;

  const db = getDashboardDb();
  if (!db) return 0;

  const tenantId = getCurrentTenantContext().tenantId;
  const actorSource = getAuthenticatedUser(req)?.source ?? null;
  const insert = db.query(`
    INSERT INTO usage_events (id, tenant_id, ts, event_type, path, actor_source)
    VALUES (?, ?, ?, 'pageview', ?, ?)
  `);
  const validPaths = events.map((event) => normalizePath(event?.path)).filter((path): path is string => path !== null);
  if (validPaths.length === 0) return 0;

  let recorded = 0;
  const insertBatch = db.transaction((paths: string[]) => {
    for (const path of paths) {
      try {
        insert.run(randomUUID(), tenantId, Date.now(), path, actorSource);
        recorded += 1;
      } catch {
        // Usage collection is best-effort; one rejected row must not abort the batch.
      }
    }
  });

  try {
    insertBatch(validPaths);
  } catch {
    // SQLite availability must never make page navigation or API handling fail.
  }
  return recorded;
}

export function rollupUsageDaily(now: number | Date = Date.now()): void {
  const db = getDashboardDb();
  if (!db) return;

  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) throw new Error("invalid rollup date");
  const current = new Date(nowMs);
  const tomorrowUtc = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1);

  const actionColumns = db.query("PRAGMA table_info(action_audit)").all() as Array<{ name: string }>;
  const actionPathExpression = actionColumns.some((column) => column.name === "source_route")
    ? "COALESCE(NULLIF(source_route, ''), action_kind)"
    : "action_kind";

  const rollup = db.transaction(() => {
    db.exec(`
      INSERT INTO usage_daily (day, tenant_id, event_type, path, count)
      SELECT
        strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
        tenant_id,
        event_type,
        path,
        COUNT(*) AS count
      FROM usage_events
      WHERE ts < ${tomorrowUtc}
      GROUP BY day, tenant_id, event_type, path
      ON CONFLICT(day, tenant_id, event_type, path)
      DO UPDATE SET count = excluded.count;
    `);

    db.exec(`
      INSERT INTO usage_daily (day, tenant_id, event_type, path, count)
      SELECT
        strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
        COALESCE(tenant_id, 'mimule') AS tenant_id,
        'action' AS event_type,
        ${actionPathExpression} AS path,
        COUNT(*) AS count
      FROM action_audit
      WHERE ts < ${tomorrowUtc}
      GROUP BY day, COALESCE(tenant_id, 'mimule'), ${actionPathExpression}
      ON CONFLICT(day, tenant_id, event_type, path)
      DO UPDATE SET count = excluded.count;
    `);
  });

  rollup();
}

export function sweepUsageRetention(now: number | Date = Date.now()): number {
  const db = getDashboardDb();
  if (!db) return 0;
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) throw new Error("invalid retention date");
  const result = db.query("DELETE FROM usage_events WHERE ts < ?").run(nowMs - RAW_RETENTION_MS);
  return Number(result.changes);
}

export function getUsageSummary(
  periodStart: number | Date | string,
  periodEnd: number | Date | string,
): UsageSummary {
  const from = utcDay(periodStart);
  const to = utcDay(periodEnd);
  if (from > to) throw new Error("usage summary start must not be after end");

  const summary: UsageSummary = {
    from,
    to,
    paths: [],
    totals: { pageviews: 0, actions: 0 },
  };
  const db = getDashboardDb();
  if (!db) return summary;

  const tenantId = getCurrentTenantContext().tenantId;
  const rows = db.query(`
    SELECT
      path,
      SUM(CASE WHEN event_type = 'pageview' THEN count ELSE 0 END) AS pageviews,
      SUM(CASE WHEN event_type = 'action' THEN count ELSE 0 END) AS actions
    FROM usage_daily
    WHERE tenant_id = ? AND day >= ? AND day <= ?
    GROUP BY path
    ORDER BY pageviews DESC, actions DESC, path ASC
  `).all(tenantId, from, to) as Array<{ path: string; pageviews: number; actions: number }>;

  summary.paths = rows.map((row) => ({
    path: row.path,
    pageviews: Number(row.pageviews),
    actions: Number(row.actions),
  }));
  for (const row of summary.paths) {
    summary.totals.pageviews += row.pageviews;
    summary.totals.actions += row.actions;
  }
  return summary;
}

export function getModuleUsage(
  periodStart: number | Date | string,
  periodEnd: number | Date | string,
): ModuleUsage {
  const from = utcDay(periodStart);
  const to = utcDay(periodEnd);
  if (from > to) throw new Error("usage summary start must not be after end");

  const result: ModuleUsage = {
    from,
    to,
    modules: [],
    totals: { pageviews: 0, actions: 0, findingsActedOn: 0 },
  };
  const db = getDashboardDb();
  if (!db) return result;

  const tenantId = getCurrentTenantContext().tenantId;
  const usageRows = db.query(`
    SELECT
      path,
      SUM(CASE WHEN event_type = 'pageview' THEN count ELSE 0 END) AS pageviews,
      SUM(CASE WHEN event_type = 'action' THEN count ELSE 0 END) AS actions
    FROM usage_daily
    WHERE tenant_id = ? AND day >= ? AND day <= ?
    GROUP BY path
  `).all(tenantId, from, to) as Array<{ path: string; pageviews: number; actions: number }>;

  const insightColumns = db.query("PRAGMA table_info(insights)").all() as Array<{ name: string }>;
  const actedAtExpression = insightColumns.some((column) => column.name === "updated_at")
    ? "COALESCE(resolved_at, updated_at)"
    : "COALESCE(resolved_at, created_at)";
  const fromTs = Date.parse(`${from}T00:00:00.000Z`);
  const toTs = Date.parse(`${to}T00:00:00.000Z`);
  const findingRows = db.query(`
    SELECT manual_page_href AS manualPageHref, COUNT(*) AS findingsActedOn
    FROM insights
    WHERE tenant_id = ?
      AND status IN ('applied', 'resolved')
      AND ${actedAtExpression} >= ?
      AND ${actedAtExpression} < ?
    GROUP BY manual_page_href
  `).all(tenantId, fromTs, toTs) as Array<{ manualPageHref: string; findingsActedOn: number }>;

  const modules = new Map<string, { path: string; pageviews: number; actions: number; findingsActedOn: number }>();
  for (const row of usageRows) {
    modules.set(row.path, {
      path: row.path,
      pageviews: Number(row.pageviews),
      actions: Number(row.actions),
      findingsActedOn: 0,
    });
  }
  for (const row of findingRows) {
    const normalizedPath = normalizePath(row.manualPageHref);
    if (!normalizedPath) continue;
    const module = modules.get(normalizedPath) ?? {
      path: normalizedPath,
      pageviews: 0,
      actions: 0,
      findingsActedOn: 0,
    };
    module.findingsActedOn += Number(row.findingsActedOn);
    modules.set(normalizedPath, module);
  }

  result.modules = [...modules.values()].sort((a, b) =>
    b.actions - a.actions ||
    b.findingsActedOn - a.findingsActedOn ||
    b.pageviews - a.pageviews ||
    a.path.localeCompare(b.path)
  );
  for (const module of result.modules) {
    result.totals.pageviews += module.pageviews;
    result.totals.actions += module.actions;
    result.totals.findingsActedOn += module.findingsActedOn;
  }
  return result;
}
