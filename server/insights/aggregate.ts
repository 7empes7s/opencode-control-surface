import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import type { EvidenceRef } from "../api/types.ts";
import type { Insight, InsightInput, InsightSeverity } from "./types.ts";
import { upsertInsight, resolveStaleInsights } from "./store.ts";
import { writeActionAudit } from "../db/writer.ts";
import { readFileSync } from "node:fs";
import { matchPlaybook } from "../reasoner/playbooks.ts";

type AggregateResult = {
  createdOrUpdated: number;
  insights: Insight[];
  resolvedCount: number;
};

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref, redacted: kind === "db" };
}

function normalizeSeverity(value: string | null | undefined, fallback: InsightSeverity = "medium"): InsightSeverity {
  const v = String(value ?? "").toLowerCase();
  if (["critical", "high", "medium", "low", "info"].includes(v)) return v as InsightSeverity;
  if (["error", "failed", "blocker", "severe"].includes(v)) return "high";
  if (["warn", "warning"].includes(v)) return "medium";
  return fallback;
}

function confidenceValue(value: string | number | null | undefined, fallback = 0.72): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  const v = String(value ?? "").toLowerCase();
  if (v === "high") return 0.86;
  if (v === "medium") return 0.68;
  if (v === "low") return 0.45;
  return fallback;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// reasoner-remediate:<playbookId>:<workflowId>:<passId>[:<incidentId>]
function remediateDescriptor(playbookId: string, workflowId: string, passId: string | null, incidentId?: string): string {
  const base = `reasoner-remediate:${playbookId}:${workflowId}:${passId ?? ""}`;
  return incidentId ? `${base}:${incidentId}` : base;
}

function cents(value: number): string {
  if (value >= 100) return `$${(value / 100).toFixed(2)}`;
  return `${value.toFixed(1)} cents`;
}

function addInsight(results: Insight[], input: InsightInput): void {
  const row = upsertInsight(input);
  if (row) results.push(row);
}

function aggregateSpendAnomalies(results: Insight[]): void {
  const db = getDashboardDb();
  if (!db) return;
  const tenant = whereTenant();
  const rows = db.query(`
    SELECT id, tenant_id, ts, scope_type, scope_id, baseline_cents, observed_cents, multiplier, status, alert_firing_id
    FROM spend_anomalies
    WHERE status != 'resolved' ${tenant.clause}
    ORDER BY ts DESC
    LIMIT 50
  `).all(...tenant.params) as Array<{
    id: string;
    tenant_id: string;
    ts: number;
    scope_type: string;
    scope_id: string | null;
    baseline_cents: number;
    observed_cents: number;
    multiplier: number;
    status: string;
    alert_firing_id: string | null;
  }>;

  for (const row of rows) {
    const scope = row.scope_id ? `${row.scope_type} ${row.scope_id}` : row.scope_type;
    const severity = row.multiplier >= 3 ? "high" : row.multiplier >= 1.5 ? "medium" : "low";
    addInsight(results, {
      id: `insight_cost_anomaly_${safeId(row.id)}`,
      sourceKey: `cost:spend_anomaly:${row.id}`,
      domain: "cost",
      severity,
      title: "Spend is running above its normal range",
      plainSummary: `${scope} is spending ${row.multiplier.toFixed(1)} times its usual amount. Expected ${cents(row.baseline_cents)}, observed ${cents(row.observed_cents)}.`,
      confidence: Math.min(0.95, Math.max(0.55, row.multiplier / 4)),
      evidenceRefs: [
        evidence("Spend anomaly", "db", `spend_anomalies:${row.id}`),
        evidence("Cost attribution", "api", `/api/cost/attribution/${row.scope_type}${row.scope_id ? `?entityId=${encodeURIComponent(row.scope_id)}` : ""}`),
      ],
      actionDescriptorId: "start-job:gateway:route-healthiest",
      manualPageHref: "/gateway",
      createdAt: row.ts,
    });
  }
}

function aggregateModelSwapRecommendation(results: Insight[]): void {
  const db = getDashboardDb();
  if (!db) return;
  const tenant = whereTenant();
  const rows = db.query(`
    SELECT provider, logical_model, tier, input_cents_per_1k, output_cents_per_1k
    FROM provider_price_catalog
    WHERE (input_cents_per_1k IS NOT NULL OR output_cents_per_1k IS NOT NULL)
      ${tenant.clause}
  `).all(...tenant.params) as Array<{
    provider: string;
    logical_model: string | null;
    tier: string;
    input_cents_per_1k: number | null;
    output_cents_per_1k: number | null;
  }>;
  if (rows.length < 2) return;

  const priced = rows.map((row) => ({
    ...row,
    model: row.logical_model ?? row.provider,
    blended: (row.input_cents_per_1k ?? 0) + (row.output_cents_per_1k ?? 0),
    freeSignal: row.tier.includes("free") || row.provider.toLowerCase().includes("free") || (row.logical_model ?? "").toLowerCase().includes("free"),
  })).filter((row) => row.blended > 0);
  if (priced.length < 2) return;

  const current = priced.slice().sort((a, b) => b.blended - a.blended)[0];
  const cheaper = priced
    .filter((row) => row.blended < current.blended && (row.freeSignal || row.tier === "cloud-free" || row.tier === "local"))
    .sort((a, b) => a.blended - b.blended)[0];
  if (!cheaper) return;

  const savingsPct = Math.round((1 - cheaper.blended / current.blended) * 100);
  if (savingsPct < 10) return;

  addInsight(results, {
    id: `insight_cost_model_swap_${safeId(current.model)}_to_${safeId(cheaper.model)}`,
    sourceKey: `cost:model_swap:${current.model}:${cheaper.model}`,
    domain: "cost",
    severity: savingsPct >= 50 ? "high" : "medium",
    title: "A cheaper healthy model route is available",
    plainSummary: `The catalog shows ${cheaper.model} is about ${savingsPct}% cheaper than ${current.model}. Apply will route new gateway traffic to the healthiest free or low-cost model for a limited window.`,
    confidence: 0.78,
    evidenceRefs: [
      evidence("Provider price catalog", "db", "provider_price_catalog"),
      evidence("Gateway status", "api", "/api/gateway/status"),
    ],
    actionDescriptorId: "start-job:gateway:route-healthiest",
    manualPageHref: "/gateway",
    createdAt: Date.now(),
  });
}

function aggregateReasoner(results: Insight[]): void {
  const db = getDashboardDb();
  if (!db) return;
  const tenant = whereTenant();
  const diagnoses = db.query(`
    SELECT id, pass_id, run_id, workflow_id, failure_class, root_cause,
           evidence_json, suggested_actions_json, confidence, diagnosed_at
    FROM reasoner_diagnoses
    WHERE 1=1 ${tenant.clause}
    ORDER BY diagnosed_at DESC
    LIMIT 50
  `).all(...tenant.params) as Array<{
    id: string;
    pass_id: string;
    run_id: string;
    workflow_id: string;
    failure_class: string;
    root_cause: string;
    evidence_json: string;
    suggested_actions_json: string;
    confidence: string;
    diagnosed_at: number;
  }>;

  for (const row of diagnoses) {
    const suggested = parseJson<Array<{ title?: string; description?: string }>>(row.suggested_actions_json, []);
    const firstAction = suggested[0]?.title || suggested[0]?.description;
    const playbook = row.workflow_id ? matchPlaybook(db, row.failure_class) : null;
    const actionDescriptorId = playbook && row.workflow_id
      ? remediateDescriptor(playbook.id, row.workflow_id, row.pass_id ?? null)
      : null;
    addInsight(results, {
      id: `insight_build_diagnosis_${safeId(row.id)}`,
      sourceKey: `build:diagnosis:${row.id}`,
      domain: "build",
      severity: normalizeSeverity(row.failure_class, "medium"),
      title: `Build diagnosis: ${row.failure_class}`,
      plainSummary: firstAction
        ? `${row.root_cause}. Recommended next step: ${firstAction}.`
        : `${row.root_cause}. Open the builder page to inspect the run and choose the next action.`,
      confidence: confidenceValue(row.confidence),
      evidenceRefs: [
        evidence("Reasoner diagnosis", "db", `reasoner_diagnoses:${row.id}`),
        evidence("Builder run", "api", `/api/builder/runs/${row.run_id}`),
      ],
      actionDescriptorId,
      manualPageHref: `/builder?run=${encodeURIComponent(row.run_id)}`,
      createdAt: row.diagnosed_at,
    });
  }

  const incidentTenant = whereTenant(undefined, "i");
  const incidents = db.query(`
    SELECT i.id, i.failure_class, i.title, i.last_seen, i.occurrence_count, i.status,
           i.representative_diagnosis_id,
           d.workflow_id AS rep_workflow_id, d.pass_id AS rep_pass_id
    FROM reasoner_incidents i
    LEFT JOIN reasoner_diagnoses d ON d.id = i.representative_diagnosis_id
    WHERE i.status = 'open' ${incidentTenant.clause}
    ORDER BY i.occurrence_count DESC, i.last_seen DESC
    LIMIT 50
  `).all(...incidentTenant.params) as Array<{
    id: string;
    failure_class: string;
    title: string;
    last_seen: number;
    occurrence_count: number;
    status: string;
    representative_diagnosis_id: string;
    rep_workflow_id: string | null;
    rep_pass_id: string | null;
  }>;

  for (const row of incidents) {
    const wfId = row.rep_workflow_id && row.rep_workflow_id !== "unknown" ? row.rep_workflow_id : null;
    const playbook = wfId ? matchPlaybook(db, row.failure_class) : null;
    const actionDescriptorId = playbook && wfId
      ? remediateDescriptor(playbook.id, wfId, row.rep_pass_id ?? null, row.id)
      : null;
    addInsight(results, {
      id: `insight_build_incident_${safeId(row.id)}`,
      sourceKey: `build:incident:${row.id}`,
      domain: "build",
      severity: row.occurrence_count >= 3 ? "high" : "medium",
      title: row.title,
      plainSummary: `This build issue has happened ${row.occurrence_count} times. Run a doctor scan or open the incident to review the recommended fix.`,
      confidence: 0.74,
      evidenceRefs: [
        evidence("Reasoner incident", "db", `reasoner_incidents:${row.id}`),
        evidence("Incident details", "api", `/api/reasoner/incidents/${row.id}`),
      ],
      actionDescriptorId,
      manualPageHref: `/incidents`,
      createdAt: row.last_seen,
    });
  }
}

function aggregateContentHealth(results: Insight[]): void {
  const db = getDashboardDb();
  if (!db) return;
  const tenant = whereTenant();
  const rows = db.query(`
    SELECT id, ts, slug, finding, severity, payload_json
    FROM content_health_findings
    WHERE 1=1 ${tenant.clause}
    ORDER BY ts DESC
    LIMIT 50
  `).all(...tenant.params) as Array<{
    id: number;
    ts: number;
    slug: string;
    finding: string;
    severity: string;
    payload_json: string | null;
  }>;

  for (const row of rows) {
    addInsight(results, {
      id: `insight_data_content_${row.id}`,
      sourceKey: `data:content_health:${row.id}`,
      domain: "data",
      severity: normalizeSeverity(row.severity),
      title: `Content health needs attention for ${row.slug}`,
      plainSummary: `${row.finding}. Open the article workflow to review the affected content and source evidence.`,
      confidence: 0.7,
      evidenceRefs: [
        evidence("Content health finding", "db", `content_health_findings:${row.id}`),
        evidence("NewsBites detail", "api", "/api/newsbites"),
      ],
      actionDescriptorId: `open-source:article:${row.slug}`,
      manualPageHref: `/newsbites`,
      createdAt: row.ts,
    });
  }
}

// The Product Health Sentinel probes the LIVE product every 30 min and writes a
// scorecard. Surface its open findings as native insights so they appear in the
// Insights Inbox — pre-flagged — instead of only on a phone or the DashHome tile.
const DEFAULT_SENTINEL_HEALTH_PATH = "/var/lib/mimule/product-health.json";

function sentinelDomain(id: string): Insight["domain"] {
  const s = id.toLowerCase();
  if (s.includes("secur") || s.includes("secret") || s.includes("role")) return "security";
  if (s.includes("audit") || s.includes("event") || s.includes("modelhealth")) return "data";
  if (s.includes("gateway") || s.includes("cost")) return "cost";
  return "build";
}

function getSentinelHealthPath(): string {
  return process.env.SENTINEL_HEALTH_PATH ?? DEFAULT_SENTINEL_HEALTH_PATH;
}

function aggregateSentinel(results: Insight[]): string[] | null {
  const emittedSourceKeys: string[] = [];
  let card: { findings?: Array<Record<string, unknown>>; checkedAt?: number };
  try {
    card = JSON.parse(readFileSync(getSentinelHealthPath(), "utf8"));
  } catch {
    return null;
  }
  const findings = Array.isArray(card.findings) ? card.findings : [];
  const ts = ((card.checkedAt as number) ?? Math.floor(Date.now() / 1000)) * 1000;
  for (const f of findings) {
    const status = String(f.status ?? "");
    if (status !== "fail" && status !== "warn") continue;
    const fid = String(f.id ?? "");
    const severity: InsightSeverity = status === "fail"
      ? normalizeSeverity(String(f.severity ?? "high"), "high")
      : "low";
    const sourceKey = `health:sentinel:${fid}`;
    addInsight(results, {
      id: `insight_health_${fid.replace(/[^a-z0-9]+/gi, "_")}`,
      sourceKey,
      domain: sentinelDomain(fid),
      severity,
      title: `Product health: ${String(f.name ?? fid)}`,
      plainSummary: `${String(f.detail ?? "")} — detected by the Product Health Sentinel on the live site.`,
      confidence: 0.9,
      evidenceRefs: [
        evidence("Product health scorecard", "file", getSentinelHealthPath()),
        evidence("Live health endpoint", "api", "/api/product-health"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/",
      createdAt: ts,
    });
    emittedSourceKeys.push(sourceKey);
  }
  return emittedSourceKeys;
}

export function aggregateInsights(): AggregateResult {
  const results: Insight[] = [];
  aggregateSpendAnomalies(results);
  aggregateModelSwapRecommendation(results);
  aggregateReasoner(results);
  aggregateContentHealth(results);
  const sentinelSourceKeys = aggregateSentinel(results);
  if (sentinelSourceKeys !== null) {
    const resolved = resolveStaleInsights(
      "health:sentinel:",
      sentinelSourceKeys,
      "The Product Health Sentinel confirmed this endpoint is healthy again."
    );
    for (const insight of resolved) {
      writeActionAudit({
        actor: "system",
        actionKind: "insights.auto-resolve",
        targetType: "insight",
        targetId: insight.id,
        risk: "low",
        resultStatus: "success",
        result: "The Product Health Sentinel confirmed this endpoint is healthy again.",
        request: { sourceKey: insight.sourceKey ?? insight.id },
      });
    }
    return { createdOrUpdated: results.length, insights: results, resolvedCount: resolved.length };
  }
  return { createdOrUpdated: results.length, insights: results, resolvedCount: 0 };
}

