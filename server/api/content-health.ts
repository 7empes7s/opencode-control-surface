import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { runContentHealthScan } from "../db/sampler.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { ok, type ApiEnvelope } from "./types.ts";

const CONTENT_HEALTH_KINDS = [
  "article.missing_image",
  "article.thin_digest",
  "article.invalid_vertical",
  "article.broken_link",
  "content.near_duplicate",
  "content.vertical_concentration",
  "content.vertical_gap",
] as const;

type ContentHealthKind = (typeof CONTENT_HEALTH_KINDS)[number];

export type ContentHealthFinding = {
  id: number;
  ts: number;
  kind: ContentHealthKind;
  severity: string;
  slug: string | null;
  title: string | null;
  vertical: string | null;
  path: string | null;
  summary: string;
  payload: unknown;
  dedupeKey: string | null;
};

export type ContentHealthSummary = {
  total: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
  affectedArticles: number;
  latestTs: number | null;
};

export type ContentHealthResponse = {
  findings: ContentHealthFinding[];
  summary: ContentHealthSummary;
  degraded: boolean;
  reason?: string;
};

export type ContentHealthRunResponse = ContentHealthResponse & {
  scan: {
    generatedFindings: number;
  };
};

type DbContentHealthRow = {
  id: number;
  ts: number;
  kind: string;
  severity: string;
  entity_id: string | null;
  summary: string;
  payload_json: string | null;
  dedupe_key: string | null;
};

type DbPersistedFindingRow = {
  id: number;
  ts: number;
  slug: string;
  finding: string;
  severity: string;
  payload_json: string | null;
};

function response<T extends ContentHealthResponse | ContentHealthRunResponse>(data: T): Response {
  const envelope: ApiEnvelope<T> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

function emptySummary(): ContentHealthSummary {
  return {
    total: 0,
    byKind: {},
    bySeverity: {},
    affectedArticles: 0,
    latestTs: null,
  };
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 100;
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.max(1, Math.min(500, parsed));
}

function parseSince(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
  if (!payloadJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isContentHealthKind(kind: string): kind is ContentHealthKind {
  return (CONTENT_HEALTH_KINDS as readonly string[]).includes(kind);
}

export function summarizeContentHealth(findings: ContentHealthFinding[]): ContentHealthSummary {
  const articles = new Set<string>();
  const summary = emptySummary();

  for (const finding of findings) {
    summary.total += 1;
    summary.byKind[finding.kind] = (summary.byKind[finding.kind] ?? 0) + 1;
    summary.bySeverity[finding.severity] = (summary.bySeverity[finding.severity] ?? 0) + 1;
    summary.latestTs = summary.latestTs === null ? finding.ts : Math.max(summary.latestTs, finding.ts);
    if (finding.slug) {
      articles.add(finding.slug);
    }
  }

  summary.affectedArticles = articles.size;
  return summary;
}

function mapContentHealthRow(row: DbContentHealthRow): ContentHealthFinding | null {
  if (!isContentHealthKind(row.kind)) {
    return null;
  }

  const payload = parsePayload(row.payload_json);
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    severity: row.severity,
    slug: stringField(payload, "slug") ?? row.entity_id,
    title: stringField(payload, "title"),
    vertical: stringField(payload, "vertical"),
    path: stringField(payload, "path"),
    summary: row.summary,
    payload,
    dedupeKey: row.dedupe_key,
  };
}

function mapPersistedFindingRow(row: DbPersistedFindingRow): ContentHealthFinding | null {
  if (!isContentHealthKind(row.finding)) {
    return null;
  }

  const payload = parsePayload(row.payload_json);
  return {
    id: row.id,
    ts: row.ts,
    kind: row.finding,
    severity: row.severity,
    slug: row.slug,
    title: stringField(payload, "title"),
    vertical: stringField(payload, "vertical"),
    path: stringField(payload, "path"),
    summary: stringField(payload, "detail") ?? row.finding,
    payload,
    dedupeKey: null,
  };
}

export async function contentHealthHandler(url: URL): Promise<Response> {
  try {
    const db = getDashboardDb();
    if (!isDashboardDbEnabled() || !db) {
      return response({ findings: [], summary: emptySummary(), degraded: true, reason: "DASHBOARD_DB disabled" });
    }

    const limit = parseLimit(url.searchParams.get("limit"));
    const since = parseSince(url.searchParams.get("since"));
    const severity = url.searchParams.get("severity");
    const kind = url.searchParams.get("kind");
    const tenant = whereTenant();
    const params: Array<string | number> = [since, ...CONTENT_HEALTH_KINDS, ...tenant.params];
    let sql = `
      SELECT id, ts, kind, severity, entity_id, summary, payload_json, dedupe_key
      FROM events
      WHERE ts > ?
        AND kind IN (${CONTENT_HEALTH_KINDS.map(() => "?").join(", ")})
        ${tenant.clause}
    `;

    if (kind && isContentHealthKind(kind)) {
      sql += " AND kind = ?";
      params.push(kind);
    }

    if (severity) {
      sql += " AND severity = ?";
      params.push(severity);
    }

    sql += " ORDER BY ts DESC, id DESC LIMIT ?";
    params.push(limit);

    const rows = db.query(sql).all(...params) as DbContentHealthRow[];
    const persistedParams: Array<string | number> = [since, ...tenant.params];
    let persistedSql = `
      SELECT id, ts, slug, finding, severity, payload_json
      FROM content_health_findings
      WHERE ts > ?
        ${tenant.clause}
    `;
    if (kind && isContentHealthKind(kind)) {
      persistedSql += " AND finding = ?";
      persistedParams.push(kind);
    }
    if (severity) {
      persistedSql += " AND severity = ?";
      persistedParams.push(severity);
    }
    persistedSql += " ORDER BY ts DESC, id DESC LIMIT ?";
    persistedParams.push(limit);

    const persistedRows = db.query(persistedSql).all(...persistedParams) as DbPersistedFindingRow[];
    const findings = [...rows.map(mapContentHealthRow), ...persistedRows.map(mapPersistedFindingRow)]
      .filter((finding): finding is ContentHealthFinding => finding !== null);
    findings.sort((a, b) => b.ts - a.ts || b.id - a.id);

    return response({ findings: findings.slice(0, limit), summary: summarizeContentHealth(findings.slice(0, limit)), degraded: false });
  } catch (error) {
    console.error("[content-health] query failed", error);
    return response({ findings: [], summary: emptySummary(), degraded: true, reason: "content health query failed" });
  }
}

export async function contentHealthRunHandler(url: URL): Promise<Response> {
  try {
    const db = getDashboardDb();
    if (!isDashboardDbEnabled() || !db) {
      return response({
        findings: [],
        summary: emptySummary(),
        degraded: true,
        reason: "DASHBOARD_DB disabled",
        scan: { generatedFindings: 0 },
      });
    }

    const generatedFindings = await runContentHealthScan({ probeExternalLinks: true });
    const readback = await contentHealthHandler(url);
    const envelope = await readback.json() as ApiEnvelope<ContentHealthResponse>;
    return response({ ...envelope.data, scan: { generatedFindings } });
  } catch (error) {
    console.error("[content-health] on-demand scan failed", error);
    return response({
      findings: [],
      summary: emptySummary(),
      degraded: true,
      reason: "content health scan failed",
      scan: { generatedFindings: 0 },
    });
  }
}
