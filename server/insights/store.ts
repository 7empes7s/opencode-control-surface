import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import type { Insight, InsightInput, InsightSeverity, InsightStatus } from "./types.ts";

type InsightRow = {
  id: string;
  domain: Insight["domain"];
  severity: InsightSeverity;
  title: string;
  plain_summary: string;
  confidence: number;
  evidence_refs_json: string;
  action_descriptor_id: string | null;
  manual_page_href: string;
  status: InsightStatus;
  tenant_id: string;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
  source_key: string | null;
};

export const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function mapRow(row: InsightRow): Insight {
  let evidenceRefs: Insight["evidenceRefs"] = [];
  try {
    evidenceRefs = JSON.parse(row.evidence_refs_json) as Insight["evidenceRefs"];
  } catch {
    evidenceRefs = [];
  }
  return {
    id: row.id,
    domain: row.domain,
    severity: row.severity,
    title: row.title,
    plainSummary: row.plain_summary,
    confidence: row.confidence,
    evidenceRefs,
    actionDescriptorId: row.action_descriptor_id,
    manualPageHref: row.manual_page_href,
    status: row.status,
    tenant_id: row.tenant_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    sourceKey: row.source_key,
  };
}

export function listInsights(status?: InsightStatus | "all"): Insight[] {
  const db = getDashboardDb();
  if (!db) return [];

  const tenant = whereTenant();
  const params: Array<string | number> = [...tenant.params];
  let sql = `
    SELECT id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
           action_descriptor_id, manual_page_href, status, tenant_id, created_at,
           resolved_at, resolution, source_key
    FROM insights
    WHERE 1=1 ${tenant.clause}
  `;

  if (status && status !== "all") {
    sql += " AND status = ?";
    params.push(status);
  }

  sql += " ORDER BY created_at DESC";
  return (db.query(sql).all(...params) as InsightRow[])
    .map(mapRow)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAt - a.createdAt);
}

export function getInsight(id: string): Insight | null {
  const db = getDashboardDb();
  if (!db) return null;
  const tenant = whereTenant();
  const row = db.query(`
    SELECT id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
           action_descriptor_id, manual_page_href, status, tenant_id, created_at,
           resolved_at, resolution, source_key
    FROM insights
    WHERE id = ? ${tenant.clause}
  `).get(id, ...tenant.params) as InsightRow | null;
  return row ? mapRow(row) : null;
}

export function upsertInsight(input: InsightInput): Insight | null {
  const db = getDashboardDb();
  if (!db) return null;

  const tenantId = input.tenant_id ?? getCurrentTenantContext().tenantId;
  const createdAt = input.createdAt || Date.now();
  const status = input.status ?? "open";
  const evidenceJson = JSON.stringify(input.evidenceRefs);

  db.query(`
    INSERT INTO insights
      (id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
       action_descriptor_id, manual_page_href, status, tenant_id, created_at, source_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      domain = excluded.domain,
      severity = excluded.severity,
      title = excluded.title,
      plain_summary = excluded.plain_summary,
      confidence = excluded.confidence,
      evidence_refs_json = excluded.evidence_refs_json,
      action_descriptor_id = excluded.action_descriptor_id,
      manual_page_href = excluded.manual_page_href,
      tenant_id = excluded.tenant_id,
      source_key = COALESCE(excluded.source_key, insights.source_key),
      status = CASE
        WHEN insights.status = 'resolved' THEN 'open'
        ELSE insights.status
      END,
      resolved_at = CASE
        WHEN insights.status = 'resolved' THEN NULL
        ELSE insights.resolved_at
      END,
      resolution = CASE
        WHEN insights.status = 'resolved' THEN NULL
        ELSE insights.resolution
      END
  `).run(
    input.id,
    input.domain,
    input.severity,
    input.title,
    input.plainSummary,
    Math.max(0, Math.min(1, input.confidence)),
    evidenceJson,
    input.actionDescriptorId,
    input.manualPageHref,
    status,
    tenantId,
    createdAt,
    input.sourceKey ?? null,
  );

  return getInsight(input.id);
}

export function updateInsightStatus(id: string, status: InsightStatus): Insight | null {
  const db = getDashboardDb();
  if (!db) return null;
  const tenant = whereTenant();
  db.query(`UPDATE insights SET status = ? WHERE id = ? ${tenant.clause}`).run(status, id, ...tenant.params);
  return getInsight(id);
}

export function countOpenInsights(): number {
  const db = getDashboardDb();
  if (!db) return 0;
  const tenant = whereTenant();
  const row = db.query(`SELECT COUNT(*) AS count FROM insights WHERE status = 'open' ${tenant.clause}`)
    .get(...tenant.params) as { count: number } | null;
  return row?.count ?? 0;
}

export function resolveDiscoveryInsightsForAsset(assetId: string, resolution: string): number {
  const db = getDashboardDb();
  if (!db) return 0;
  const tenant = whereTenant();
  const now = Date.now();
  const result = db.query(`
    UPDATE insights
    SET status = 'resolved', resolved_at = ?, resolution = ?
    WHERE status = 'open'
      AND source_key LIKE ?
      ${tenant.clause}
  `).run(now, resolution, `discovery:%:${assetId}`, ...tenant.params);
  return (result as { changes: number }).changes;
}

export function resolveStaleInsights(sourceKeyPrefix: string, activeSourceKeys: string[], resolution: string): Insight[] {
  const db = getDashboardDb();
  if (!db) return [];

  const tenant = whereTenant();
  const now = Date.now();
  const activeSet = new Set(activeSourceKeys);

  const openInsights = db.query(`
    SELECT id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
           action_descriptor_id, manual_page_href, status, tenant_id, created_at,
           resolved_at, resolution, source_key
    FROM insights
    WHERE status = 'open'
      AND source_key LIKE ?
      ${tenant.clause}
  `).all(`${sourceKeyPrefix}%`, ...tenant.params) as InsightRow[];

  const toResolve = openInsights.filter((row) => !activeSet.has(row.source_key));

  if (toResolve.length === 0) return [];

  const placeholders = toResolve.map(() => "?").join(",");
  const params = [now, resolution, ...toResolve.map((r) => r.id), ...tenant.params];

  db.query(`
    UPDATE insights
    SET status = 'resolved', resolved_at = ?, resolution = ?
    WHERE id IN (${placeholders}) ${tenant.clause}
  `).run(...params);

  return toResolve.map(mapRow);
}
