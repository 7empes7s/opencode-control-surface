import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import type { ReasonerJob } from "../reasoner/types.ts";
import {
  listPlaybooks,
  applyPlaybookAction,
  recordPlaybookRun,
} from "../reasoner/playbooks.ts";

export async function reasonerJobsHandler(): Promise<Response> {
  if (!isDashboardDbEnabled()) return json([]);
  const db = getDashboardDb()!;
  const rows = db.query(`
    SELECT id, pass_id, run_id, workflow_id, status, attempts, created_at, finished_at, error
    FROM reasoner_jobs
    ORDER BY created_at DESC
    LIMIT 50
  `).all() as Array<{
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
  const rows = db.query(`
    SELECT id, pass_id, run_id, workflow_id, failure_class, root_cause,
           evidence_json, suggested_actions_json, confidence, raw_llm_response, diagnosed_at
    FROM reasoner_diagnoses
    ORDER BY diagnosed_at DESC
    LIMIT 50
  `).all() as Array<{
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
  const row = db.query(`
    SELECT id, pass_id, run_id, workflow_id, failure_class, root_cause,
           evidence_json, suggested_actions_json, confidence, raw_llm_response, diagnosed_at
    FROM reasoner_diagnoses
    WHERE pass_id = ?
    ORDER BY diagnosed_at DESC
    LIMIT 1
  `).get(passId) as {
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
  const statusParam = url?.searchParams.get("status") ?? "open";
  const whereClause = statusParam === "all" ? "" : `WHERE status = '${statusParam === "resolved" ? "resolved" : "open"}'`;
  const rows = db.query(`
    SELECT id, cluster_key, failure_class, title, first_seen, last_seen,
           occurrence_count, representative_pass_id, representative_diagnosis_id, status
    FROM reasoner_incidents
    ${whereClause}
    ORDER BY occurrence_count DESC, last_seen DESC
  `).all() as Array<{
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
  const row = db.query(`
    SELECT id, cluster_key, failure_class, title, first_seen, last_seen,
           occurrence_count, representative_pass_id, representative_diagnosis_id, status
    FROM reasoner_incidents
    WHERE id = ?
  `).get(id) as {
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
    WHERE rim.incident_id = ?
    ORDER BY rim.added_at DESC
  `).all(id) as Array<{
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
  const existing = db.query(`SELECT id FROM reasoner_incidents WHERE id = ?`).get(id);
  if (!existing) return json({ error: "not found" }, 404);
  db.query(`UPDATE reasoner_incidents SET status = 'resolved' WHERE id = ?`).run(id);
  return json({ ok: true });
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
