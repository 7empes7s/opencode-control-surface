import { getDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import type { EvidenceRef } from "../../api/types.ts";
import { matchPlaybook } from "../../reasoner/playbooks.ts";
import { signatureFor, upsertAiAnalysis } from "../ai.ts";
import { resolveStaleInsights, upsertInsight } from "../store.ts";
import type { Insight, InsightInput, InsightSeverity } from "../types.ts";

type DiagnosisRow = {
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
  run_status: string | null;
  workflow_live: string | null;
};

type IncidentRow = {
  id: string;
  failure_class: string;
  title: string;
  last_seen: number;
  occurrence_count: number;
  representative_diagnosis_id: string;
  root_cause: string | null;
  suggested_actions_json: string | null;
  confidence: string | null;
  rep_run_id: string | null;
  rep_workflow_id: string | null;
  rep_pass_id: string | null;
  run_status: string | null;
};

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref, redacted: kind === "db" };
}

function severityForFailureClass(failureClass: string, occurrenceCount = 1): InsightSeverity {
  const normalized = failureClass.toLowerCase();
  if (normalized.includes("infra") || normalized.includes("crash") || normalized.includes("config")) return "critical";
  if (normalized.includes("validation") || normalized.includes("timeout") || normalized.includes("failed")) return "high";
  if (occurrenceCount >= 3) return "high";
  return "medium";
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

function suggestedActionText(value: string | null | undefined): string {
  const parsed = parseJson<Array<string | { title?: string; description?: string }>>(value, []);
  const first = parsed[0];
  if (typeof first === "string") return first;
  return first?.title ?? first?.description ?? "Open the builder page, inspect the run, and choose the safest remediation.";
}

function diagnosisText(row: Pick<DiagnosisRow, "root_cause" | "suggested_actions_json">): string {
  const action = suggestedActionText(row.suggested_actions_json);
  return `${row.root_cause}. Recommended next step: ${action}.`;
}

function isResolvedRun(status: string | null): boolean {
  if (!status) return false;
  return ["success", "succeeded", "completed", "done", "resolved"].includes(status.toLowerCase());
}

function remediateDescriptor(playbookId: string, workflowId: string, passId: string | null, incidentId?: string): string {
  const base = `reasoner-remediate:${playbookId}:${workflowId}:${passId ?? ""}`;
  return incidentId ? `${base}:${incidentId}` : base;
}

function prefillBuildAnalysis(insight: Insight, summary: string, rootCause: string, recommendedAction: string, confidence: number): void {
  upsertAiAnalysis({
    signature: signatureFor(insight),
    insightId: insight.id,
    summary,
    rootCause,
    recommendedAction,
    confidence,
    model: "reasoner-diagnosis",
    generatedAt: insight.createdAt,
  });
}

export function mapReasonerBuildFindings(now = Date.now()): InsightInput[] {
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant(undefined, "d");
  const inputs: InsightInput[] = [];

  const diagnoses = db.query(`
    SELECT d.id, d.pass_id, d.run_id, d.workflow_id, d.failure_class, d.root_cause,
           d.evidence_json, d.suggested_actions_json, d.confidence, d.diagnosed_at,
           r.status AS run_status,
           w.id AS workflow_live
    FROM reasoner_diagnoses d
    LEFT JOIN builder_runs r ON r.id = d.run_id
    LEFT JOIN builder_workflows w ON w.id = d.workflow_id
    WHERE d.failure_class != 'sentinel_health' ${tenant.clause}
    ORDER BY d.diagnosed_at DESC
    LIMIT 50
  `).all(...tenant.params) as DiagnosisRow[];

  for (const row of diagnoses) {
    if (!row.workflow_live && !row.run_status) continue;
    if (isResolvedRun(row.run_status)) continue;
    const playbook = row.workflow_id ? matchPlaybook(db, row.failure_class) : null;
    const recommendedAction = suggestedActionText(row.suggested_actions_json);
    const sourceKey = `build:${row.run_id || row.failure_class}`;
    inputs.push({
      // id derives from sourceKey (not the diagnosis id) so the same run maps to
      // one stable row across scans — insights has UNIQUE(tenant_id, source_key)
      // but upsertInsight only conflict-handles the id PK, so a new diagnosis id
      // reusing an existing sourceKey would otherwise throw and crash startup.
      id: `insight_${sourceKey.replace(/[^a-z0-9]+/gi, "_")}`,
      sourceKey,
      domain: "build",
      severity: severityForFailureClass(row.failure_class),
      title: `Build diagnosis: ${row.failure_class}`,
      plainSummary: diagnosisText(row),
      confidence: confidenceValue(row.confidence),
      evidenceRefs: [
        evidence("Reasoner diagnosis", "db", `reasoner_diagnoses:${row.id}`),
        evidence("Builder run", "api", `/api/builder/runs/${encodeURIComponent(row.run_id)}`),
      ],
      actionDescriptorId: playbook ? remediateDescriptor(playbook.id, row.workflow_id, row.pass_id) : null,
      manualPageHref: `/insights?focus=${encodeURIComponent(sourceKey)}`,
      createdAt: row.diagnosed_at || now,
    });
    void recommendedAction;
  }

  const incidentTenant = whereTenant(undefined, "i");
  const incidents = db.query(`
    SELECT i.id, i.failure_class, i.title, i.last_seen, i.occurrence_count,
           i.representative_diagnosis_id,
           d.root_cause, d.suggested_actions_json, d.confidence,
           d.run_id AS rep_run_id, d.workflow_id AS rep_workflow_id, d.pass_id AS rep_pass_id,
           r.status AS run_status
    FROM reasoner_incidents i
    LEFT JOIN reasoner_diagnoses d ON d.id = i.representative_diagnosis_id
    LEFT JOIN builder_runs r ON r.id = d.run_id
    WHERE i.status = 'open'
      AND i.failure_class != 'sentinel_health'
      ${incidentTenant.clause}
    ORDER BY i.occurrence_count DESC, i.last_seen DESC
    LIMIT 50
  `).all(...incidentTenant.params) as IncidentRow[];

  for (const row of incidents) {
    if (isResolvedRun(row.run_status)) continue;
    const wfId = row.rep_workflow_id && row.rep_workflow_id !== "unknown" ? row.rep_workflow_id : null;
    const playbook = wfId ? matchPlaybook(db, row.failure_class) : null;
    const recommendedAction = suggestedActionText(row.suggested_actions_json);
    const sourceKey = `build:failure:${row.failure_class}`;
    inputs.push({
      // id derives from sourceKey (see diagnosis note) — multiple incidents of the
      // same failure class collapse to one stable row.
      id: `insight_${sourceKey.replace(/[^a-z0-9]+/gi, "_")}`,
      sourceKey,
      domain: "build",
      severity: severityForFailureClass(row.failure_class, row.occurrence_count),
      title: row.title,
      plainSummary: `${row.root_cause ?? row.title}. This build issue has happened ${row.occurrence_count} times. Recommended next step: ${recommendedAction}.`,
      confidence: confidenceValue(row.confidence, 0.74),
      evidenceRefs: [
        evidence("Reasoner incident", "db", `reasoner_incidents:${row.id}`),
        evidence("Incident details", "api", `/api/reasoner/incidents/${row.id}`),
      ],
      actionDescriptorId: playbook && wfId ? remediateDescriptor(playbook.id, wfId, row.rep_pass_id ?? null, row.id) : null,
      manualPageHref: `/insights?focus=${encodeURIComponent(sourceKey)}`,
      createdAt: row.last_seen,
    });
  }

  return inputs;
}

export function runBuildScan(): { findings: Insight[]; resolved: Insight[] } {
  const inputs = mapReasonerBuildFindings();
  const findings: Insight[] = [];
  const emittedSourceKeys: string[] = [];
  const seenSourceKeys = new Set<string>();

  for (const input of inputs) {
    // Defense-in-depth: never upsert two findings with the same sourceKey in one
    // scan (they would collide on the UNIQUE(tenant_id, source_key) index).
    // Inputs are ordered most-relevant-first, so the first one per key wins.
    if (input.sourceKey) {
      if (seenSourceKeys.has(input.sourceKey)) continue;
      seenSourceKeys.add(input.sourceKey);
    }
    const row = upsertInsight(input);
    if (!row) continue;
    findings.push(row);
    if (input.sourceKey) emittedSourceKeys.push(input.sourceKey);
    const rootCause = input.plainSummary.split(". Recommended next step:")[0] || input.plainSummary;
    const recommendedAction = input.plainSummary.includes("Recommended next step:")
      ? input.plainSummary.split("Recommended next step:").slice(1).join("Recommended next step:").trim()
      : "Open the linked builder context and apply the matched playbook when appropriate.";
    prefillBuildAnalysis(row, input.plainSummary, rootCause, recommendedAction, row.confidence);
  }

  const resolved = resolveStaleInsights(
    "build:",
    emittedSourceKeys,
    "The reasoner no longer reports this build failure, or the builder run was resolved or superseded.",
  );

  return { findings, resolved };
}
