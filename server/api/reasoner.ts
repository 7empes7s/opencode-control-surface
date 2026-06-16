import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import type { ReasonerJob } from "../reasoner/types.ts";
import {
  listPlaybooks,
  applyPlaybookAction,
  recordPlaybookRun,
} from "../reasoner/playbooks.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { gatewayComplete } from "../gateway/router.ts";
import { readActionAudit, writeActionAudit } from "../db/writer.ts";
import { getPrompt, registerPrompt } from "../prompts/registry.ts";

const POST_MORTEM_TIMEOUT_MS = 60_000;
const POST_MORTEM_MODEL = "editorial-cloud-heavy";
const POST_MORTEM_CALLER = "incident-postmortem";
const POST_MORTEM_AUDIT_RELATED_LIMIT = 20;
const POST_MORTEM_PROMPT_NAME = "incident-postmortem.system";

const POST_MORTEM_SYSTEM_PROMPT = `You write concise incident post-mortems for an internal control-plane product.
Given the incident fields and related audit rows, produce a 4-7 sentence post-mortem in plain English for the operator.
Cover: (1) what happened, (2) why it was flagged, (3) what automated or human actions were attempted, (4) outcome of the resolution, and (5) one specific follow-up recommendation.
Be factual, terse, and avoid speculation. Do not start with phrases like "The incident" or "This incident". Output the post-mortem text only — no headings, no JSON, no preamble.`;

let postMortemPromptRegistered = false;

function resolvePostMortemSystemPrompt(): string {
  if (isDashboardDbEnabled()) {
    if (!postMortemPromptRegistered) {
      try {
        registerPrompt(POST_MORTEM_PROMPT_NAME, POST_MORTEM_SYSTEM_PROMPT);
        postMortemPromptRegistered = true;
      } catch (err) {
        console.warn(`[reasoner] failed to register ${POST_MORTEM_PROMPT_NAME}:`, err instanceof Error ? err.message : err);
      }
    }
    try {
      const stored = getPrompt(POST_MORTEM_PROMPT_NAME);
      if (stored && stored.content && stored.content.trim().length > 0) {
        return stored.content;
      }
    } catch (err) {
      console.warn(`[reasoner] failed to read ${POST_MORTEM_PROMPT_NAME} from registry:`, err instanceof Error ? err.message : err);
    }
  }
  return POST_MORTEM_SYSTEM_PROMPT;
}

type IncidentRow = {
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
  tenant_id: string | null;
};

type DiagnosisRow = {
  id: string;
  pass_id: string;
  failure_class: string;
  root_cause: string;
  confidence: string;
  evidence_json: string;
  suggested_actions_json: string;
};

function buildPostMortemUserContent(incident: IncidentRow, relatedAudit: unknown[], diagnosis: DiagnosisRow | null): string {
  const incidentLines = [
    `Incident ID: ${incident.id}`,
    `Cluster key: ${incident.cluster_key}`,
    `Failure class: ${incident.failure_class}`,
    `Title: ${incident.title}`,
    `Status: ${incident.status}`,
    `First seen: ${new Date(incident.first_seen).toISOString()}`,
    `Last seen: ${new Date(incident.last_seen).toISOString()}`,
    `Occurrence count: ${incident.occurrence_count}`,
    `Representative pass: ${incident.representative_pass_id}`,
  ].join("\n");

  const diagnosisLines = diagnosis
    ? [
        "",
        "Representative diagnosis:",
        `  root_cause: ${diagnosis.root_cause}`,
        `  confidence: ${diagnosis.confidence}`,
        `  evidence: ${diagnosis.evidence_json}`,
        `  suggested_actions: ${diagnosis.suggested_actions_json}`,
      ].join("\n")
    : "";

  const auditLines = relatedAudit.length === 0
    ? "\nRelated audit rows: (none)"
    : `\nRelated audit rows (up to ${POST_MORTEM_AUDIT_RELATED_LIMIT}):\n${JSON.stringify(relatedAudit, null, 2)}`;

  return `${incidentLines}${diagnosisLines}${auditLines}`;
}

async function generateAndStorePostMortem(incident: IncidentRow): Promise<{ postMortemId: number | null; postMortemText: string | null }> {
  if (!isDashboardDbEnabled()) return { postMortemId: null, postMortemText: null };
  const db = getDashboardDb();
  if (!db) return { postMortemId: null, postMortemText: null };

  const diagnosis = db.query(`
    SELECT id, pass_id, failure_class, root_cause, confidence, evidence_json, suggested_actions_json
    FROM reasoner_diagnoses
    WHERE id = ?
    LIMIT 1
  `).get(incident.representative_diagnosis_id) as DiagnosisRow | null;

  const relatedAudit = readActionAudit({
    limit: POST_MORTEM_AUDIT_RELATED_LIMIT,
  });

  const userContent = buildPostMortemUserContent(incident, relatedAudit, diagnosis);
  const systemPrompt = resolvePostMortemSystemPrompt();

  let postMortemText: string;
  try {
    const completion = await gatewayComplete(
      POST_MORTEM_MODEL,
      {
        model: POST_MORTEM_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
      },
      { timeoutMs: POST_MORTEM_TIMEOUT_MS, caller: POST_MORTEM_CALLER },
    );
    const message = completion.choices?.[0]?.message;
    const content = typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? (message?.content as Array<{ type?: string; text?: string }>)
            .filter((p) => p?.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n")
        : "";
    postMortemText = content.trim();
    if (!postMortemText) {
      console.warn(`[reasoner] post-mortem LLM returned empty content for incident ${incident.id}`);
      return { postMortemId: null, postMortemText: null };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[reasoner] post-mortem LLM call failed for incident ${incident.id}: ${message.slice(0, 200)}`);
    return { postMortemId: null, postMortemText: null };
  }

  const path = `reasoner/incidents/${incident.id}/post-mortem`;
  const summary = postMortemText.length > 4000 ? `${postMortemText.slice(0, 3997)}...` : postMortemText;

  let postMortemId: number | null = null;
  try {
    const result = db.query(`
      INSERT INTO report_archive (ts, kind, path, summary)
      VALUES (?, ?, ?, ?)
    `).run(Date.now(), "post-mortem", path, summary);
    postMortemId = Number(result.lastInsertRowid);
  } catch (err) {
    console.error(`[reasoner] failed to store post-mortem for incident ${incident.id}`, err);
    return { postMortemId: null, postMortemText: postMortemText };
  }

  try {
    writeActionAudit({
      actor: POST_MORTEM_CALLER,
      actorSource: "gateway",
      actionKind: "reasoner.postmortem.generated",
      targetType: "reasoner-incident",
      targetId: incident.id,
      risk: "low",
      resultStatus: "success",
      resultJson: { postMortemId, path, bytes: postMortemText.length },
    });
  } catch (auditErr) {
    console.error("[reasoner] failed to write post-mortem audit row", auditErr);
  }

  return { postMortemId, postMortemText };
}

export async function reasonerJobsHandler(): Promise<Response> {
  if (!isDashboardDbEnabled()) return json([]);
  const db = getDashboardDb()!;
  const tenantId = getCurrentTenantContext().tenantId;
  const rows = db.query(`
    SELECT id, pass_id, run_id, workflow_id, status, attempts, created_at, finished_at, error
    FROM reasoner_jobs
    WHERE tenant_id = ? OR tenant_id IS NULL
    ORDER BY created_at DESC
    LIMIT 50
  `).all(tenantId) as Array<{
    id: string;
    pass_id: string;
    run_id: string;
    workflow_id: string;
    status: string;
    attempts: number;
    created_at: number;
    finished_at: number | null;
    error: string | null;
  }>;
  const jobs: ReasonerJob[] = rows.map((r) => ({
    id: r.id,
    passId: r.pass_id,
    runId: r.run_id,
    workflowId: r.workflow_id,
    status: r.status as ReasonerJob["status"],
    attempts: r.attempts,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? undefined,
  }));
  return json(jobs);
}

export async function reasonerDiagnosesHandler(): Promise<Response> {
  if (!isDashboardDbEnabled()) return json([]);
  const db = getDashboardDb()!;
  const tenantId = getCurrentTenantContext().tenantId;
  const rows = db.query(`
    SELECT id, pass_id, run_id, workflow_id, failure_class, root_cause,
           evidence_json, suggested_actions_json, confidence, raw_llm_response, diagnosed_at
    FROM reasoner_diagnoses
    WHERE tenant_id = ? OR tenant_id IS NULL
    ORDER BY diagnosed_at DESC
    LIMIT 50
  `).all(tenantId) as Array<{
    id: string;
    pass_id: string;
    run_id: string;
    workflow_id: string;
    failure_class: string;
    root_cause: string;
    evidence_json: string;
    suggested_actions_json: string;
    confidence: string;
    raw_llm_response: string | null;
    diagnosed_at: number;
  }>;
  return json(rows.map((r) => ({
    id: r.id,
    passId: r.pass_id,
    runId: r.run_id,
    workflowId: r.workflow_id,
    failureClass: r.failure_class,
    rootCauseHypothesis: r.root_cause,
    evidence: JSON.parse(r.evidence_json),
    suggestedActions: JSON.parse(r.suggested_actions_json),
    confidence: r.confidence,
    rawLLMResponse: r.raw_llm_response,
    diagnosedAt: r.diagnosed_at,
  })));
}

export async function reasonerDiagnosisByPassHandler(passId: string): Promise<Response> {
  if (!isDashboardDbEnabled()) return json({ error: "not found" }, 404);
  const db = getDashboardDb()!;
  const tenantId = getCurrentTenantContext().tenantId;
  const row = db.query(`
    SELECT id, pass_id, run_id, workflow_id, failure_class, root_cause,
           evidence_json, suggested_actions_json, confidence, raw_llm_response, diagnosed_at
    FROM reasoner_diagnoses
    WHERE pass_id = ? AND (tenant_id = ? OR tenant_id IS NULL)
    ORDER BY diagnosed_at DESC
    LIMIT 1
  `).get(passId, tenantId) as {
    id: string;
    pass_id: string;
    run_id: string;
    workflow_id: string;
    failure_class: string;
    root_cause: string;
    evidence_json: string;
    suggested_actions_json: string;
    confidence: string;
    raw_llm_response: string | null;
    diagnosed_at: number;
  } | null;
  if (!row) return json({ error: "not found" }, 404);
  return json({
    id: row.id,
    passId: row.pass_id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    failureClass: row.failure_class,
    rootCauseHypothesis: row.root_cause,
    evidence: JSON.parse(row.evidence_json),
    suggestedActions: JSON.parse(row.suggested_actions_json),
    confidence: row.confidence,
    rawLLMResponse: row.raw_llm_response,
    diagnosedAt: row.diagnosed_at,
  });
}

export async function reasonerIncidentsHandler(url?: URL): Promise<Response> {
  if (!isDashboardDbEnabled()) return json([]);
  const db = getDashboardDb()!;
  const tenantId = getCurrentTenantContext().tenantId;
  const statusParam = url?.searchParams.get("status") ?? "open";
  const whereClause = statusParam === "all" ? "" : `AND status = '${statusParam === "resolved" ? "resolved" : "open"}'`;
  const rows = db.query(`
    SELECT id, cluster_key, failure_class, title, first_seen, last_seen,
           occurrence_count, representative_pass_id, representative_diagnosis_id, status
    FROM reasoner_incidents
    WHERE (tenant_id = ? OR tenant_id IS NULL) ${whereClause}
    ORDER BY occurrence_count DESC, last_seen DESC
  `).all(tenantId) as Array<{
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
  }>;
  return json(rows.map((r) => ({
    id: r.id,
    clusterKey: r.cluster_key,
    failureClass: r.failure_class,
    title: r.title,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    occurrenceCount: r.occurrence_count,
    representativePassId: r.representative_pass_id,
    representativeDiagnosisId: r.representative_diagnosis_id,
    status: r.status,
  })));
}

export async function reasonerIncidentByIdHandler(id: string): Promise<Response> {
  if (!isDashboardDbEnabled()) return json({ error: "not found" }, 404);
  const db = getDashboardDb()!;
  const tenantId = getCurrentTenantContext().tenantId;
  const row = db.query(`
    SELECT id, cluster_key, failure_class, title, first_seen, last_seen,
           occurrence_count, representative_pass_id, representative_diagnosis_id, status
    FROM reasoner_incidents
    WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
  `).get(id, tenantId) as {
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
  } | null;
  if (!row) return json({ error: "not found" }, 404);

  const members = db.query(`
    SELECT rim.id, rim.pass_id, rim.diagnosis_id, rim.added_at,
           rd.failure_class, rd.root_cause, rd.confidence
    FROM reasoner_incident_members rim
    JOIN reasoner_diagnoses rd ON rd.id = rim.diagnosis_id
    WHERE rim.incident_id = ? AND (rim.tenant_id = ? OR rim.tenant_id IS NULL)
    ORDER BY rim.added_at DESC
  `).all(id, tenantId) as Array<{
    id: string;
    pass_id: string;
    diagnosis_id: string;
    added_at: number;
    failure_class: string;
    root_cause: string;
    confidence: string;
  }>;

  return json({
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
    members: members.map((m) => ({
      id: m.id,
      passId: m.pass_id,
      diagnosisId: m.diagnosis_id,
      addedAt: m.added_at,
      failureClass: m.failure_class,
      rootCause: m.root_cause,
      confidence: m.confidence,
    })),
  });
}

export async function reasonerResolveIncidentHandler(id: string): Promise<Response> {
  if (!isDashboardDbEnabled()) return json({ error: "not found" }, 404);
  const db = getDashboardDb()!;
  const tenantId = getCurrentTenantContext().tenantId;
  const existing = db.query(`
    SELECT id, cluster_key, failure_class, title, first_seen, last_seen,
           occurrence_count, representative_pass_id, representative_diagnosis_id, status, tenant_id
    FROM reasoner_incidents
    WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
  `).get(id, tenantId) as IncidentRow | undefined;
  if (!existing) return json({ error: "not found" }, 404);
  db.query(`UPDATE reasoner_incidents SET status = 'resolved' WHERE id = ?`).run(id);
  const incidentForPostMortem: IncidentRow = { ...existing, status: "resolved" };

  let postMortemId: number | null = null;
  try {
    const result = await generateAndStorePostMortem(incidentForPostMortem);
    postMortemId = result.postMortemId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[reasoner] post-mortem generation failed for ${id}: ${message.slice(0, 200)}`);
  }

  return json({ ok: true, postMortemId });
}

export async function reasonerIncidentPostMortemHandler(id: string): Promise<Response> {
  if (!isDashboardDbEnabled()) return json({ error: "not found" }, 404);
  const db = getDashboardDb()!;
  const tenantId = getCurrentTenantContext().tenantId;
  const incident = db.query(`
    SELECT id FROM reasoner_incidents
    WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
  `).get(id, tenantId) as { id: string } | null;
  if (!incident) return json({ error: "not found" }, 404);

  const path = `reasoner/incidents/${id}/post-mortem`;
  const row = db.query(`
    SELECT id, ts, kind, path, summary
    FROM report_archive
    WHERE kind = 'post-mortem' AND path = ?
    ORDER BY ts DESC, id DESC
    LIMIT 1
  `).get(path) as { id: number; ts: number; kind: string; path: string; summary: string | null } | null;
  if (!row) return json({ error: "not found" }, 404);

  return json({
    id: row.id,
    incidentId: id,
    kind: row.kind,
    path: row.path,
    text: row.summary ?? "",
    createdAt: row.ts,
  });
}

export async function reasonerPlaybooksHandler(): Promise<Response> {
  if (!isDashboardDbEnabled()) return json([]);
  const db = getDashboardDb()!;
  return json(listPlaybooks(db));
}

export async function reasonerApplyPlaybookHandler(playbookId: string, req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) return json({ error: "not found" }, 404);
  const db = getDashboardDb()!;

  let body: { workflowId?: string; incidentId?: string; passId?: string } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.workflowId) return json({ error: "workflowId is required" }, 400);

  const playbook = listPlaybooks(db).find((p) => p.id === playbookId);
  if (!playbook) return json({ error: "not found" }, 404);

  const results: string[] = [];
  for (const action of playbook.actions) {
    const result = await applyPlaybookAction(action, body.workflowId, body.passId ?? null, null);
    results.push(result);
  }

  recordPlaybookRun(
    db,
    playbookId,
    body.incidentId ?? null,
    body.passId ?? null,
    "operator",
    playbook.actions,
    results.join(","),
  );

  return json({ ok: true, results });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
