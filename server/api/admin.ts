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
