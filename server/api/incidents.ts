import { ok, type ApiEnvelope } from "./types.ts";
import { listInsights } from "../insights/store.ts";
import type { Insight } from "../insights/types.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { writeActionAudit } from "../db/writer.ts";
import { executeActionHandler } from "./execute.ts";

export interface IncidentEntry {
  ts: number;
  type: "pipeline-failed" | "doctor-abandoned" | "insight";
  slug: string;
  stage: string;
  errorType: string;
  severity: "error" | "warning";
  insightId?: string;
  sourceKey?: string | null;
  title?: string;
  manualPageHref?: string;
  detectionsHref?: string;
}

export interface ReasonerIncidentEntry {
  id: string;
  clusterKey: string;
  failureClass: string;
  title: string;
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  representativePassId: string;
  representativeDiagnosisId: string;
  status: string;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  postMortem: string | null;
  rootCause: string | null;
  suggestedActions: unknown[];
  evidence: unknown;
  diagnosisHref: string;
  passEvidenceHref: string;
}

export interface IncidentSlaMetrics {
  meanTimeToAcknowledgeMs: number | null;
  meanTimeToResolveMs: number | null;
  acknowledgedSamples: number;
  resolvedSamples: number;
  oldestOpenAgeMs: number | null;
  breachingUnacknowledgedCount: number;
  breachThresholdMs: number;
}

export interface IncidentsDetail {
  entries: IncidentEntry[];
  reasonerIncidents: ReasonerIncidentEntry[];
  sla: IncidentSlaMetrics;
  stats: {
    total: number;
    last24h: number;
    byErrorType: { type: string; count: number }[];
    byStage: { stage: string; count: number }[];
  };
}

type ReasonerIncidentRow = {
  id: string;
  cluster_key: string;
  failure_class: string;
  title: string;
  first_seen: number;
  last_seen: number;
  occurrence_count: number;
  representative_pass_id: string;
  representative_diagnosis_id: string;
  status: string;
  acknowledged_at: number | null;
  resolved_at: number | null;
  post_mortem: string | null;
  root_cause: string | null;
  suggested_actions_json: string | null;
  evidence_json: string | null;
};

const SLA_BREACH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function parseJsonField(value: string | null, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isIncidentGrade(insight: Insight): boolean {
  if (insight.status !== "open") return false;
  if (!["ops", "security", "build"].includes(insight.domain)) return false;
  if (insight.severity === "high" || insight.severity === "critical") return true;
  return (insight.sourceKey ?? "").startsWith("health:sentinel:");
}

function entryFromInsight(insight: Insight): IncidentEntry {
  const source = insight.sourceKey ?? insight.id;
  return {
    ts: insight.createdAt,
    type: "insight",
    slug: source,
    stage: insight.domain,
    errorType: insight.severity,
    severity: insight.severity === "critical" || insight.severity === "high" ? "error" : "warning",
    insightId: insight.id,
    sourceKey: insight.sourceKey,
    title: insight.title,
    manualPageHref: insight.manualPageHref,
    detectionsHref: `/insights?focus=${encodeURIComponent(source)}`,
  };
}

export function getIncidentEntries(): IncidentEntry[] {
  return listInsights("open")
    .filter(isIncidentGrade)
    .map(entryFromInsight)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 500);
}

function getReasonerRows(): ReasonerIncidentRow[] {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const tenantId = getCurrentTenantContext().tenantId;
  return db.query(`
    SELECT i.id, i.cluster_key, i.failure_class, i.title, i.first_seen, i.last_seen,
           i.occurrence_count, i.representative_pass_id, i.representative_diagnosis_id,
           i.status, i.acknowledged_at, i.resolved_at, i.post_mortem,
           d.root_cause, d.suggested_actions_json, d.evidence_json
    FROM reasoner_incidents i
    LEFT JOIN reasoner_diagnoses d ON d.id = i.representative_diagnosis_id
    WHERE (i.tenant_id = ? OR i.tenant_id IS NULL)
    ORDER BY CASE WHEN i.status = 'open' THEN 0 ELSE 1 END, i.last_seen DESC
    LIMIT 200
  `).all(tenantId) as ReasonerIncidentRow[];
}

function buildSlaMetrics(rows: ReasonerIncidentRow[], now = Date.now()): IncidentSlaMetrics {
  const ackDurations = rows
    .filter((row) => row.acknowledged_at !== null)
    .map((row) => Math.max(0, (row.acknowledged_at ?? row.first_seen) - row.first_seen));
  const resolveDurations = rows
    .filter((row) => row.resolved_at !== null)
    .map((row) => Math.max(0, (row.resolved_at ?? row.first_seen) - row.first_seen));
  const openRows = rows.filter((row) => row.status !== "resolved");
  const oldestOpenAgeMs = openRows.length > 0
    ? Math.max(...openRows.map((row) => Math.max(0, now - row.first_seen)))
    : null;
  const breachingUnacknowledgedCount = openRows.filter((row) =>
    row.acknowledged_at === null && now - row.first_seen > SLA_BREACH_THRESHOLD_MS
  ).length;

  const mean = (values: number[]) =>
    values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

  return {
    meanTimeToAcknowledgeMs: mean(ackDurations),
    meanTimeToResolveMs: mean(resolveDurations),
    acknowledgedSamples: ackDurations.length,
    resolvedSamples: resolveDurations.length,
    oldestOpenAgeMs,
    breachingUnacknowledgedCount,
    breachThresholdMs: SLA_BREACH_THRESHOLD_MS,
  };
}

function mapReasonerIncident(row: ReasonerIncidentRow): ReasonerIncidentEntry {
  return {
    id: row.id,
    clusterKey: row.cluster_key,
    failureClass: row.failure_class,
    title: row.title,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    occurrenceCount: row.occurrence_count,
    representativePassId: row.representative_pass_id,
    representativeDiagnosisId: row.representative_diagnosis_id,
    status: row.status,
    acknowledgedAt: row.acknowledged_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    postMortem: row.post_mortem ?? null,
    rootCause: row.root_cause ?? null,
    suggestedActions: parseJsonField(row.suggested_actions_json, []) as unknown[],
    evidence: parseJsonField(row.evidence_json, null),
    diagnosisHref: `/api/reasoner/incidents/${encodeURIComponent(row.id)}`,
    passEvidenceHref: `/api/builder/passes/${encodeURIComponent(row.representative_pass_id)}/diagnosis`,
  };
}

export function buildIncidentsDetail(): IncidentsDetail {
  const all = getIncidentEntries();
  const reasonerRows = getReasonerRows();

  const now = Date.now();
  const window24h = 24 * 60 * 60 * 1000;

  const errorTypeMap = new Map<string, number>();
  const stageMap = new Map<string, number>();
  let last24h = 0;

  for (const e of all) {
    if (now - e.ts < window24h) last24h++;
    errorTypeMap.set(e.errorType, (errorTypeMap.get(e.errorType) ?? 0) + 1);
    stageMap.set(e.stage, (stageMap.get(e.stage) ?? 0) + 1);
  }

  const byErrorType = [...errorTypeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([type, count]) => ({ type, count }));

  const byStage = [...stageMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stage, count]) => ({ stage, count }));

  return {
    entries: all,
    reasonerIncidents: reasonerRows.map(mapReasonerIncident),
    sla: buildSlaMetrics(reasonerRows, now),
    stats: { total: all.length, last24h, byErrorType, byStage },
  };
}

export async function incidentsHandler(): Promise<Response> {
  const data = buildIncidentsDetail();
  const envelope: ApiEnvelope<IncidentsDetail> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

export async function incidentAckHandler(id: string): Promise<Response> {
  return executeActionHandler(new Request("http://control.local/api/actions/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId: `acknowledge:incident:${id}` }),
  }));
}

export async function incidentResolveHandler(id: string, req: Request): Promise<Response> {
  let body: { reason?: string } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    body = {};
  }
  return executeActionHandler(new Request("http://control.local/api/actions/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionId: `resolve:incident:${id}`,
      confirmed: true,
      reason: body.reason?.trim() || "Resolved from incidents page",
    }),
  }));
}

export async function incidentPostMortemHandler(id: string, req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: "database unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  const db = getDashboardDb();
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: "database unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { postMortem?: unknown } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const postMortem = typeof body.postMortem === "string" ? body.postMortem.slice(0, 20_000) : "";
  const tenantId = getCurrentTenantContext().tenantId;
  const existing = db.query(`
    SELECT id FROM reasoner_incidents
    WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
  `).get(id, tenantId) as { id: string } | null;
  if (!existing) {
    return new Response(JSON.stringify({ ok: false, error: "incident not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  db.query(`
    UPDATE reasoner_incidents
    SET post_mortem = ?
    WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
  `).run(postMortem, id, tenantId);
  writeActionAudit({
    actionKind: "post-mortem.incident",
    actionId: `post-mortem:incident:${id}`,
    targetType: "incident",
    targetId: id,
    risk: "low",
    request: { postMortemLength: postMortem.length },
    result: `incident ${id} post-mortem saved`,
    resultStatus: "success",
  });

  return new Response(JSON.stringify({ ok: true, postMortem, message: "post-mortem saved" }), {
    headers: { "Content-Type": "application/json" },
  });
}
