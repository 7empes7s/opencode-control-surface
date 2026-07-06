import { randomUUID } from "node:crypto";
import { ok, type ApiEnvelope } from "./types.ts";
import { listInsights } from "../insights/store.ts";
import type { Insight } from "../insights/types.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { writeActionAudit } from "../db/writer.ts";
import { executeActionHandler } from "./execute.ts";
import { complete } from "../gateway/client.ts";
import { approachingWindowMs } from "../reasoner/sla.ts";

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
  mitigatedAt: number | null;
  mutedAt: number | null;
  mutedBy: string | null;
  muteReason: string | null;
  mutedUntil: number | null;
  muteActive: boolean;
  postMortem: string | null;
  escalatedWorkflowId: string | null;
  rootCause: string | null;
  suggestedActions: unknown[];
  evidence: unknown;
  diagnosisHref: string;
  passEvidenceHref: string;
  autoClosed: boolean;
  resolutionSource: "system" | "operator" | null;
  autoCloseReason: string | null;
  autoCloseAt: number | null;
  owner: string | null;
  slaDueAt: number | null;
}

export interface IncidentPostMortemSuggestion {
  suggestion: string;
}

export interface IncidentSlaMetrics {
  meanTimeToAcknowledgeMs: number | null;
  meanTimeToResolveMs: number | null;
  acknowledgedSamples: number;
  resolvedSamples: number;
  // Trailing window (ms) bounding which acknowledged_at/resolved_at samples
  // feed the two means above (task #23 / ULTRAPLAN rider): without this,
  // an incident first-seen years ago that happens to resolve today drags
  // the mean up by its full multi-year age. See MTTX_SAMPLE_WINDOW_MS.
  sampleWindowMs: number;
  oldestOpenAgeMs: number | null;
  // Real deadline-based metrics (ULTRAPLAN P2.3), computed from sla_due_at —
  // same definitions as the sla.ts detector scanner. Muted incidents are
  // excluded from both, matching the detector's mute exclusion.
  slaBreachedOpenCount: number;
  slaDueSoonCount: number;
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
  mitigated_at: number | null;
  muted_at: number | null;
  muted_by: string | null;
  mute_reason: string | null;
  muted_until: number | null;
  post_mortem: string | null;
  escalated_workflow_id: string | null;
  root_cause: string | null;
  suggested_actions_json: string | null;
  evidence_json: string | null;
  owner: string | null;
  sla_due_at: number | null;
};

const POST_MORTEM_SUGGESTION_MODEL = "editorial-heavy";
const POST_MORTEM_SUGGESTION_TIMEOUT_MS = 20_000;

function parseJsonField(value: string | null, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compactText(value: unknown, max = 700): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function parseLlmTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("\n")
    .trim();
}

function safeIso(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return "unknown";
  return new Date(ts).toISOString();
}

function buildPostMortemTemplate(row: ReasonerIncidentRow): string {
  const rootCause = compactText(row.root_cause, 280) || "No representative RCA has been recorded yet.";
  const evidence = compactText(row.evidence_json, 420) || "No representative signals are available.";
  return [
    `${row.title} was tracked as a ${row.failure_class} incident with ${row.occurrence_count} occurrence${row.occurrence_count === 1 ? "" : "s"}.`,
    `It was first seen at ${safeIso(row.first_seen)} and last seen at ${safeIso(row.last_seen)}; current status is ${row.status}.`,
    `The recorded RCA is: ${rootCause}`,
    `Representative signals: ${evidence}`,
    "Suggested follow-up: confirm the remediation held, capture any operator action in the audit trail, and watch for recurrence over the next scheduler cycle.",
  ].join(" ");
}

function buildSuggestionPrompt(row: ReasonerIncidentRow): string {
  const timeline = [
    `First seen: ${safeIso(row.first_seen)}`,
    `Last seen: ${safeIso(row.last_seen)}`,
    `Acknowledged: ${safeIso(row.acknowledged_at)}`,
    `Mitigated: ${safeIso(row.mitigated_at)}`,
    `Resolved: ${safeIso(row.resolved_at)}`,
  ].join("\n");

  return [
    "You draft concise, factual post-mortem notes for an internal AI operations control surface.",
    "Use only the incident data below. Do not invent services, people, external impact, or actions.",
    "Write 4-6 plain-English sentences. Cover what happened, likely cause, timeline, representative signals, and one follow-up.",
    "Output text only. No markdown headings, bullets, JSON, or preamble.",
    "",
    `Incident ID: ${row.id}`,
    `Title: ${row.title}`,
    `Failure class: ${row.failure_class}`,
    `Status: ${row.status}`,
    `Occurrence count: ${row.occurrence_count}`,
    `Representative pass: ${row.representative_pass_id}`,
    `Representative diagnosis: ${row.representative_diagnosis_id}`,
    "Timeline:",
    timeline,
    `RCA: ${compactText(row.root_cause, 900) || "(none recorded)"}`,
    `Suggested actions: ${compactText(row.suggested_actions_json, 900) || "[]"}`,
    `Representative signals: ${compactText(row.evidence_json, 1400) || "(none recorded)"}`,
  ].join("\n");
}

export function sanitizePostMortemSuggestion(raw: string): { text: string; usable: boolean } {
  // 1) strip explicit reasoning wrappers
  let t = String(raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<\/?(think|reasoning)>/gi, "")
    .trim();
  // 2) if the remaining text still reads like leaked chain-of-thought, reject it
  const head = t.slice(0, 180).toLowerCase();
  const reasoningStart = /^(the user (wants|is asking|has asked|would like)|okay[,.\s]|let me\b|let's\b|i need to\b|i'?ll\b|i will\b|i should\b|first,?\s+(i|let)|alright[,.\s]|so,?\s+the\b|looking at (the|this)\b|we need to\b|to (write|draft) (this|the|a))/;
  const metaPhrase = /(let me (draft|analyze|write|think|start|begin)|i'?m going to (write|draft|analyze)|the user wants me to|i need to (write|draft|produce)\b|based on the (data|incident)[^.]{0,40}\b(let me|i'?ll|i will)\b)/i;
  const usable = t.length > 0 && !reasoningStart.test(head) && !metaPhrase.test(t.slice(0, 500));
  return { text: t, usable };
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

export interface EscalatableIncident {
  id: string;
  title: string;
  escalatedWorkflowId: string | null;
}

export function getEscalatableIncidents(): EscalatableIncident[] {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const tenantId = getCurrentTenantContext().tenantId;
  const rows = db.query(`
    SELECT id, title, escalated_workflow_id
    FROM reasoner_incidents
    WHERE status = 'open' AND (tenant_id = ? OR tenant_id IS NULL)
    ORDER BY last_seen DESC
    LIMIT 150
  `).all(tenantId) as Array<{ id: string; title: string; escalated_workflow_id: string | null }>;
  return rows.map((row) => ({ id: row.id, title: row.title, escalatedWorkflowId: row.escalated_workflow_id ?? null }));
}

function getReasonerRows(): ReasonerIncidentRow[] {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const tenantId = getCurrentTenantContext().tenantId;
  return db.query(`
    SELECT i.id, i.cluster_key, i.failure_class, i.title, i.first_seen, i.last_seen,
           i.occurrence_count, i.representative_pass_id, i.representative_diagnosis_id,
           i.status, i.acknowledged_at, i.resolved_at, i.mitigated_at,
           i.muted_at, i.muted_by, i.mute_reason, i.muted_until, i.post_mortem,
           i.escalated_workflow_id, i.owner, i.sla_due_at,
           d.root_cause, d.suggested_actions_json, d.evidence_json
    FROM reasoner_incidents i
    LEFT JOIN reasoner_diagnoses d ON d.id = i.representative_diagnosis_id
    WHERE (i.tenant_id = ? OR i.tenant_id IS NULL)
    ORDER BY CASE WHEN i.status = 'open' THEN 0 ELSE 1 END, i.last_seen DESC
    LIMIT 200
  `).all(tenantId) as ReasonerIncidentRow[];
}

function getAutoCloseAudits(): Map<string, { reason: string | null; ts: number }> {
  const map = new Map<string, { reason: string | null; ts: number }>();
  if (!isDashboardDbEnabled()) return map;
  const db = getDashboardDb();
  if (!db) return map;
  const tenantId = getCurrentTenantContext().tenantId;
  const rows = db.query(`
    SELECT target_id, reason, ts FROM action_audit
    WHERE action_kind = 'incidents.auto-close' AND target_type = 'incident'
      AND (tenant_id = ? OR tenant_id IS NULL)
    ORDER BY ts ASC
  `).all(tenantId) as Array<{ target_id: string | null; reason: string | null; ts: number }>;
  for (const r of rows) { if (r.target_id) map.set(r.target_id, { reason: r.reason, ts: r.ts }); }
  return map;
}

// Trailing window (task #23 / ULTRAPLAN rider) bounding MTTA/MTTR sample
// eligibility: an incident only counts if it was BORN (first_seen) AND
// completed (acknowledged_at / resolved_at) inside the trailing window —
// "incidents born and completed within the trailing 90d". Bounding only on
// completion recency is not enough: a 2023-era row mass-closed today has a
// recent resolved_at but a multi-year duration that would still skew the
// mean. oldestOpenAgeMs is intentionally NOT bounded by this — it's about
// how old currently-open incidents are, not a resolved sample.
export const MTTX_SAMPLE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function buildSlaMetrics(rows: ReasonerIncidentRow[], now = Date.now()): IncidentSlaMetrics {
  const windowStart = now - MTTX_SAMPLE_WINDOW_MS;
  const ackDurations = rows
    .filter((row) => row.acknowledged_at !== null && row.acknowledged_at >= windowStart && row.first_seen >= windowStart)
    .map((row) => Math.max(0, (row.acknowledged_at ?? row.first_seen) - row.first_seen));
  const resolveDurations = rows
    .filter((row) => row.resolved_at !== null && row.resolved_at >= windowStart && row.first_seen >= windowStart)
    .map((row) => Math.max(0, (row.resolved_at ?? row.first_seen) - row.first_seen));
  const openRows = rows.filter((row) => row.status !== "resolved");
  const oldestOpenAgeMs = openRows.length > 0
    ? Math.max(...openRows.map((row) => Math.max(0, now - row.first_seen)))
    : null;

  // Same definitions as the sla.ts detector: open, un-muted, sla_due_at set.
  const openUnmutedWithDeadline = openRows.filter((row) => row.sla_due_at !== null && !isMuteActive(row, now));
  const slaBreachedOpenCount = openUnmutedWithDeadline.filter((row) => now > (row.sla_due_at as number)).length;
  const slaDueSoonCount = openUnmutedWithDeadline.filter((row) => {
    const dueAt = row.sla_due_at as number;
    if (now > dueAt) return false;
    return dueAt - now <= approachingWindowMs(row.title);
  }).length;

  const mean = (values: number[]) =>
    values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

  return {
    meanTimeToAcknowledgeMs: mean(ackDurations),
    meanTimeToResolveMs: mean(resolveDurations),
    acknowledgedSamples: ackDurations.length,
    resolvedSamples: resolveDurations.length,
    sampleWindowMs: MTTX_SAMPLE_WINDOW_MS,
    oldestOpenAgeMs,
    slaBreachedOpenCount,
    slaDueSoonCount,
  };
}

function isMuteActive(row: Pick<ReasonerIncidentRow, "muted_at" | "muted_until">, now = Date.now()): boolean {
  if (row.muted_at === null) return false;
  return row.muted_until === null || row.muted_until > now;
}

function mapReasonerIncident(row: ReasonerIncidentRow, autoCloseAudits: Map<string, { reason: string | null; ts: number }>): ReasonerIncidentEntry {
  const auto = autoCloseAudits.get(row.id);
  const autoClosed = auto !== undefined;
  const resolutionSource: "system" | "operator" | null = autoClosed ? "system" : (row.status === "resolved" ? "operator" : null);
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
    mitigatedAt: row.mitigated_at ?? null,
    mutedAt: row.muted_at ?? null,
    mutedBy: row.muted_by ?? null,
    muteReason: row.mute_reason ?? null,
    mutedUntil: row.muted_until ?? null,
    muteActive: isMuteActive(row),
    postMortem: row.post_mortem ?? null,
    escalatedWorkflowId: row.escalated_workflow_id ?? null,
    rootCause: row.root_cause ?? null,
    suggestedActions: parseJsonField(row.suggested_actions_json, []) as unknown[],
    evidence: parseJsonField(row.evidence_json, null),
    diagnosisHref: `/api/reasoner/incidents/${encodeURIComponent(row.id)}`,
    passEvidenceHref: `/api/builder/passes/${encodeURIComponent(row.representative_pass_id)}/diagnosis`,
    autoClosed,
    resolutionSource,
    autoCloseReason: auto?.reason ?? null,
    autoCloseAt: auto?.ts ?? null,
    owner: row.owner ?? null,
    slaDueAt: row.sla_due_at ?? null,
  };
}

export function buildIncidentsDetail(): IncidentsDetail {
  const all = getIncidentEntries();
  const reasonerRows = getReasonerRows();
  const autoCloseAudits = getAutoCloseAudits();

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
    reasonerIncidents: reasonerRows.map((row) => mapReasonerIncident(row, autoCloseAudits)),
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

export async function incidentMitigateHandler(id: string): Promise<Response> {
  return executeActionHandler(new Request("http://control.local/api/actions/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId: `mitigate:incident:${id}` }),
  }));
}

export async function incidentAssignHandler(id: string, req: Request): Promise<Response> {
  let body: { owner?: string } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    body = {};
  }
  const owner = typeof body.owner === "string" ? body.owner.trim() : "";
  return executeActionHandler(new Request("http://control.local/api/actions/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionId: `assign:incident:${id}`,
      params: { owner },
    }),
  }));
}

export async function incidentMuteHandler(id: string, req: Request): Promise<Response> {
  let body: { reason?: string; durationMs?: number } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    body = {};
  }
  const durationMs = typeof body.durationMs === "number" && Number.isFinite(body.durationMs) && body.durationMs > 0
    ? body.durationMs
    : undefined;
  return executeActionHandler(new Request("http://control.local/api/actions/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionId: `mute:incident:${id}`,
      confirmed: true,
      reason: body.reason?.trim() || "Muted from incidents page",
      ...(durationMs !== undefined ? { params: { durationMs } } : {}),
    }),
  }));
}

export async function incidentUnmuteHandler(id: string, req: Request): Promise<Response> {
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
      actionId: `unmute:incident:${id}`,
      confirmed: true,
      reason: body.reason?.trim() || "Unmuted from incidents page",
    }),
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

// Bulk acknowledge/resolve/mute (ULTRAPLAN A1). Fans out to the exact same
// single-action path (executeActionHandler → routeAndExecute) each per-id
// route above already uses, so every target gets its own action_audit row
// with the single-action's existing risk/confirm/reason enforcement and
// tenant scoping — nothing here duplicates the mutation logic. A shared
// batchId links the resulting rows (see execute.ts ExecuteRequest.batchId).
const BULK_INCIDENT_ACTIONS = new Set(["acknowledge", "resolve", "mute"]);
export const BULK_INCIDENT_MAX_IDS = 50;

interface BulkIncidentActionResult {
  id: string;
  ok: boolean;
  error?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function incidentsBulkHandler(req: Request): Promise<Response> {
  let body: { action?: string; ids?: unknown; reason?: string; durationMs?: number } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "invalid JSON body", code: "BAD_REQUEST" }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!BULK_INCIDENT_ACTIONS.has(action)) {
    return jsonResponse({ ok: false, error: `unknown bulk action: ${action || "(none)"}`, code: "BAD_REQUEST" }, 400);
  }

  const rawIds = Array.isArray(body.ids) ? body.ids : [];
  const ids = Array.from(new Set(rawIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)));
  if (ids.length === 0) {
    return jsonResponse({ ok: false, error: "ids are required", code: "BAD_REQUEST" }, 400);
  }
  if (ids.length > BULK_INCIDENT_MAX_IDS) {
    return jsonResponse({
      ok: false,
      error: `too many ids: max ${BULK_INCIDENT_MAX_IDS} per batch, got ${ids.length}`,
      code: "BAD_REQUEST",
    }, 400);
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const durationMs = typeof body.durationMs === "number" && Number.isFinite(body.durationMs) && body.durationMs > 0
    ? body.durationMs
    : undefined;
  // Same reason defaults the single-target handlers apply (incidentResolveHandler /
  // incidentMuteHandler above) — reason enforcement is not loosened, just given
  // the same honest default when the operator didn't type one.
  const defaultReason = action === "mute"
    ? "Bulk muted from incidents page"
    : action === "resolve"
      ? "Bulk resolved from incidents page"
      : undefined;

  const batchId = `batch_${randomUUID()}`;
  const results: BulkIncidentActionResult[] = [];

  for (const id of ids) {
    try {
      const execReq = new Request("http://control.local/api/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: `${action}:incident:${id}`,
          confirmed: true,
          reason: reason || defaultReason,
          batchId,
          ...(action === "mute" && durationMs !== undefined ? { params: { durationMs } } : {}),
        }),
      });
      const res = await executeActionHandler(execReq);
      const json = await res.json().catch(() => ({ ok: false, error: "invalid response from action executor" })) as { ok: boolean; error?: string };
      results.push({ id, ok: json.ok === true, error: json.ok ? undefined : (json.error ?? "action failed") });
    } catch (err) {
      // Per-target failure isolation: one bad id must never abort the batch.
      results.push({ id, ok: false, error: err instanceof Error ? err.message : "unexpected error" });
    }
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const verb = action === "acknowledge" ? "acknowledged" : action === "resolve" ? "resolved" : "muted";
  const message = failed.length === 0
    ? `${succeeded.length} ${verb}.`
    : `${succeeded.length} ${verb}, ${failed.length} failed: ${failed.map((f) => `${f.id} — ${f.error}`).join("; ")}`;

  return jsonResponse({
    ok: true,
    action,
    batchId,
    results,
    summary: { total: results.length, succeeded: succeeded.length, failed: failed.length },
    message,
  });
}

export async function incidentEscalateHandler(id: string, req: Request): Promise<Response> {
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
      actionId: `escalate:incident:${id}`,
      confirmed: true,
      reason: body.reason?.trim() || "Escalated from incidents page",
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

export async function incidentSuggestPostMortemHandler(id: string): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    const envelope: ApiEnvelope<IncidentPostMortemSuggestion> = ok({ suggestion: "" }, { incidents: "error" });
    return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
  }
  const db = getDashboardDb();
  if (!db) {
    const envelope: ApiEnvelope<IncidentPostMortemSuggestion> = ok({ suggestion: "" }, { incidents: "error" });
    return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
  }

  const tenantId = getCurrentTenantContext().tenantId;
  const row = db.query(`
    SELECT i.id, i.cluster_key, i.failure_class, i.title, i.first_seen, i.last_seen,
           i.occurrence_count, i.representative_pass_id, i.representative_diagnosis_id,
           i.status, i.acknowledged_at, i.resolved_at, i.mitigated_at, i.post_mortem,
           d.root_cause, d.suggested_actions_json, d.evidence_json
    FROM reasoner_incidents i
    LEFT JOIN reasoner_diagnoses d ON d.id = i.representative_diagnosis_id
    WHERE i.id = ? AND (i.tenant_id = ? OR i.tenant_id IS NULL)
    LIMIT 1
  `).get(id, tenantId) as ReasonerIncidentRow | null;

  if (!row) {
    return new Response(JSON.stringify({ ok: false, error: "incident not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const fallback = buildPostMortemTemplate(row);
  let suggestion = fallback;
  let source: "ai" | "template" = "template";
  let errorMessage: string | null = null;

  try {
    const response = await complete(
      POST_MORTEM_SUGGESTION_MODEL,
      [{ role: "user", content: buildSuggestionPrompt(row) }],
      {
        temperature: 0.2,
        maxTokens: 420,
        timeoutMs: POST_MORTEM_SUGGESTION_TIMEOUT_MS,
        caller: "incident-postmortem-suggest",
      },
    );
    const content = parseLlmTextContent(response.choices?.[0]?.message?.content);
    const cleaned = sanitizePostMortemSuggestion(content);
    if (cleaned.usable) {
      suggestion = cleaned.text.slice(0, 5000);
      source = "ai";
    }
    // else: keep the deterministic buildPostMortemTemplate() fallback already assigned to `suggestion`
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  try {
    writeActionAudit({
      actionKind: "post-mortem.incident.suggest",
      actionId: `suggest-postmortem:incident:${id}`,
      targetType: "incident",
      targetId: id,
      risk: "low",
      request: { model: POST_MORTEM_SUGGESTION_MODEL },
      result: source === "ai" ? "AI post-mortem suggestion generated" : "template post-mortem suggestion generated",
      resultStatus: "success",
      resultJson: { source, suggestionLength: suggestion.length },
      error: errorMessage ? errorMessage.slice(0, 400) : undefined,
    });
  } catch {
    /* Audit is best-effort; a draft suggestion must never fail because of audit storage. */
  }

  const envelope: ApiEnvelope<IncidentPostMortemSuggestion> = ok({ suggestion });
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}
