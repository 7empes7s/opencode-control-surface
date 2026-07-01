import {
  computeAdminHealthScore,
  getAdminHealthTrend,
  getAdminBriefing,
  refreshAdminBriefingIfStale,
  writeHealthSample,
} from "../insights/health.ts";
import { isDashboardDbEnabled, getDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";
import { listInsights } from "../insights/store.ts";
import { ok, type ApiEnvelope } from "./types.ts";

function jsonOk<T>(data: T): Response {
  const env: ApiEnvelope<T> = ok(data);
  return new Response(JSON.stringify(env), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function adminHealthHandler(): Promise<Response> {
  const score = computeAdminHealthScore();
  // Write sample so trend builds up
  writeHealthSample(score.score);
  const trend = getAdminHealthTrend(24);
  // Fire-and-forget briefing refresh
  void refreshAdminBriefingIfStale();
  return jsonOk({ ...score, trend });
}

export async function adminBriefingHandler(): Promise<Response> {
  void refreshAdminBriefingIfStale();
  const briefing = getAdminBriefing();
  return jsonOk({ briefing });
}

export type AdminEventMarker = {
  id: string;
  ts: number;
  type: "deployment" | "config" | "incident";
  label: string;
  href: string;
  severity: "info" | "success" | "warning" | "critical";
};

function hasColumn(table: string, column: string): boolean {
  const db = getDashboardDb();
  if (!db) return false;
  try {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

export async function adminEventsHandler(url: URL): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return jsonOk({ events: [], degraded: true });
  }

  const db = getDashboardDb();
  if (!db) return jsonOk({ events: [], degraded: true });

  const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") ?? 7) || 7));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const events: AdminEventMarker[] = [];

  try {
    const rows = db.query(`
      SELECT id, kind, COALESCE(status, state) AS status, target_id, COALESCE(finished_at, started_at, ts) AS marker_ts
      FROM jobs
      WHERE COALESCE(finished_at, started_at, ts) >= ?
        AND (target_type = 'deploy' OR kind LIKE '%deploy%')
      ORDER BY marker_ts DESC
      LIMIT 20
    `).all(cutoff) as Array<{ id: string; kind: string; status: string | null; target_id: string | null; marker_ts: number | null }>;

    for (const row of rows) {
      if (!row.marker_ts) continue;
      const ok = row.status === "success" || row.status === "done";
      events.push({
        id: `deployment:${row.id}`,
        ts: row.marker_ts,
        type: "deployment",
        label: `${row.kind}${row.target_id ? ` ${row.target_id}` : ""}`,
        href: "/jobs",
        severity: ok ? "success" : row.status === "failed" ? "critical" : "info",
      });
    }
  } catch {
    // Best-effort annotations: a malformed/old table must not break Admin Center.
  }

  try {
    const tsColumn = hasColumn("config_changes", "ts") ? "ts" : "changed_at";
    const changedByColumn = hasColumn("config_changes", "changed_by") ? "changed_by" : "'operator'";
    const rows = db.query(`
      SELECT id, key, ${tsColumn} AS marker_ts, ${changedByColumn} AS changed_by
      FROM config_changes
      WHERE ${tsColumn} >= ?
      ORDER BY ${tsColumn} DESC
      LIMIT 20
    `).all(cutoff) as Array<{ id: number; key: string; marker_ts: number | null; changed_by: string | null }>;

    for (const row of rows) {
      if (!row.marker_ts) continue;
      events.push({
        id: `config:${row.id}`,
        ts: row.marker_ts,
        type: "config",
        label: `${row.key} changed by ${row.changed_by ?? "operator"}`,
        href: "/settings",
        severity: "warning",
      });
    }
  } catch {
    // Older deployments may not have config history yet.
  }

  try {
    const rows = db.query(`
      SELECT id, title, status, first_seen
      FROM reasoner_incidents
      WHERE first_seen >= ?
      ORDER BY first_seen DESC
      LIMIT 20
    `).all(cutoff) as Array<{ id: string; title: string; status: string; first_seen: number | null }>;

    for (const row of rows) {
      if (!row.first_seen) continue;
      events.push({
        id: `incident:${row.id}`,
        ts: row.first_seen,
        type: "incident",
        label: row.title,
        href: `/incidents?focus=${encodeURIComponent(row.id)}`,
        severity: row.status === "resolved" ? "info" : "critical",
      });
    }
  } catch {
    // Reasoner tables are optional in bare/dev DBs.
  }

  events.sort((a, b) => b.ts - a.ts);
  return jsonOk({ events: events.slice(0, 50), degraded: false });
}

export async function adminSearchHandler(url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (!q || q.length < 2) {
    return jsonOk({ insights: [], audit: [], jobs: [] });
  }

  const insightHits: Array<{ id: string; title: string; severity: string; domain: string; status: string; sourceKey: string | null }> = [];
  const auditHits: Array<{ id: number; ts: number; actionKind: string; actor: string | null; target: string | null; result: string | null }> = [];
  const jobHits: Array<{ id: string; kind: string; state: string; ts: number | null }> = [];

  // Search insights
  try {
    const insights = listInsights("all");
    for (const ins of insights) {
      if (
        ins.title.toLowerCase().includes(q) ||
        ins.plainSummary.toLowerCase().includes(q) ||
        (ins.sourceKey ?? "").toLowerCase().includes(q)
      ) {
        insightHits.push({ id: ins.id, title: ins.title, severity: ins.severity, domain: ins.domain, status: ins.status, sourceKey: ins.sourceKey ?? null });
        if (insightHits.length >= 10) break;
      }
    }
  } catch { /* ignore */ }

  // Search audit rows
  if (isDashboardDbEnabled()) {
    try {
      const rows = readActionAudit({ limit: 200 });
      for (const row of rows) {
        const haystack = [row.actionKind, row.actor, row.target, row.result, row.reason].join(" ").toLowerCase();
        if (haystack.includes(q)) {
          auditHits.push({ id: row.id, ts: row.ts, actionKind: row.actionKind, actor: row.actor, target: row.target, result: row.result });
          if (auditHits.length >= 5) break;
        }
      }
    } catch { /* ignore */ }

    // Search jobs
    const db = getDashboardDb();
    if (db) {
      try {
        const rows = db.query(
          `SELECT id, kind, state, ts FROM jobs WHERE (id LIKE ? OR kind LIKE ? OR state LIKE ?) ORDER BY ts DESC LIMIT 10`,
        ).all(`%${q}%`, `%${q}%`, `%${q}%`) as Array<{ id: string; kind: string; state: string; ts: number | null }>;
        jobHits.push(...rows);
      } catch { /* ignore */ }
    }
  }

  return jsonOk({ insights: insightHits, audit: auditHits, jobs: jobHits });
}

export type AdminAutoFixRow = {
  id: number;
  ts: number;
  targetId: string | null;
  result: string | null;
  resultStatus: string | null;
  rollbackHint: string | null;
  risk: string | null;
  request: unknown;
};

export async function adminAutoFixFeedHandler(): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return jsonOk({ feed: [], degraded: true });
  }
  const rows = readActionAudit({ actionKind: "insights.auto-apply", limit: 50 });
  const feed: AdminAutoFixRow[] = rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    targetId: r.targetId,
    result: r.result,
    resultStatus: r.resultStatus,
    rollbackHint: r.rollbackHint,
    risk: r.risk,
    request: r.request,
  }));
  return jsonOk({ feed, degraded: false });
}
