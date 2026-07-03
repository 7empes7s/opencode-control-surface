import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { detectRecurringIncidents } from "../reasoner/lifecycle.ts";
import { buildActionCatalog } from "./actionDescriptors.ts";
import { handleApi } from "./router.ts";

describe("incident escalate-to-workflow action", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousOperatorToken: string | undefined;
  const createdPlanFiles: string[] = [];

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "incidents-escalate-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousOperatorToken = process.env.OPERATOR_TOKEN;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    process.env.OPERATOR_TOKEN = "test-token";
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousOperatorToken;
    rmSync(tempDir, { recursive: true, force: true });
    for (const file of createdPlanFiles.splice(0)) rmSync(file, { force: true });
  });

  function apiReq(path: string, options: RequestInit = {}, token = "test-token") {
    const headers = new Headers(options.headers);
    if (token) headers.set("x-operator-token", token);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return new Request(`http://localhost${path}`, { ...options, headers });
  }

  function seedDiagnosis(id: string, passId: string) {
    getDashboardDb()!.query(`
      INSERT INTO reasoner_diagnoses
        (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json,
         suggested_actions_json, confidence, diagnosed_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      passId,
      `run-${id}`,
      `workflow-${id}`,
      "build_failure",
      `Root cause for ${id}`,
      JSON.stringify({ log: `evidence-${id}` }),
      JSON.stringify(["Restart the failed build step"]),
      "high",
      1_000,
      "mimule",
    );
  }

  function seedIncident(input: {
    id: string;
    representativePassId?: string;
    escalatedWorkflowId?: string | null;
  }) {
    const passId = input.representativePassId ?? `pass-${input.id}`;
    const diagnosisId = `diagnosis-${input.id}`;
    seedDiagnosis(diagnosisId, passId);
    getDashboardDb()!.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, escalated_workflow_id, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      `${input.id}:cluster`,
      "build_failure",
      `Incident ${input.id}`,
      1_000,
      2_000,
      3,
      passId,
      diagnosisId,
      "open",
      input.escalatedWorkflowId ?? null,
      "mimule",
    );
  }

  // Registers a hermetic builder project + source workflow + representative
  // pass so the escalation can resolve the incident's project.
  function seedSourceWorkflow(passId: string): string {
    const projectRoot = join(tempDir, "project");
    mkdirSync(projectRoot, { recursive: true });
    const db = getDashboardDb()!;
    const now = Date.now();
    db.query(`
      INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `project:${projectRoot}`,
      "Escalate Test Project",
      projectRoot,
      JSON.stringify({ root: projectRoot, label: "Escalate Test Project", risk: "low", writable: true, note: "test project" }),
      now,
      now,
      "mimule",
    );
    db.query(`
      INSERT INTO builder_workflows
        (id, project_id, tenant_id, name, mode, status, plan_file, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "bw_source",
      `project:${projectRoot}`,
      "mimule",
      "source workflow",
      "once",
      "done",
      join(projectRoot, "PLAN.md"),
      JSON.stringify({
        projectRoot,
        validationProfile: { commands: [], internal: ["echo ok"], runtime: [], public: [] },
      }),
      now,
      now,
    );
    db.query(`
      INSERT INTO builder_passes (id, run_id, workflow_id, sequence, phase, status)
      VALUES (?, 'br_source', 'bw_source', 1, 'build', 'failed')
    `).run(passId);
    return projectRoot;
  }

  async function escalate(id: string): Promise<Response> {
    const res = await handleApi(
      apiReq(`/api/incidents/${id}/escalate`, { method: "POST", body: JSON.stringify({ reason: "own the fix" }) }),
      new URL(`http://localhost/api/incidents/${id}/escalate`),
    );
    return res;
  }

  it("creates a draft one-pass workflow seeded with incident context, stamps the incident, and audits", async () => {
    const projectRoot = seedSourceWorkflow("bp_escalate_1");
    seedIncident({ id: "ri_escalate_1", representativePassId: "bp_escalate_1" });

    const res = await escalate("ri_escalate_1");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; action: string; result: { workflowId: string; planFile: string } };
    expect(body.ok).toBe(true);
    expect(body.action).toBe("escalate");
    const { workflowId, planFile } = body.result;
    createdPlanFiles.push(planFile);
    expect(workflowId).toMatch(/^bw_/);

    const db = getDashboardDb()!;
    const workflow = db.query(`
      SELECT project_id, mode, status, plan_file, config_json FROM builder_workflows WHERE id = ?
    `).get(workflowId) as { project_id: string; mode: string; status: string; plan_file: string; config_json: string };
    expect(workflow.mode).toBe("once");
    expect(workflow.status).toBe("draft");
    expect(workflow.project_id).toBe(`project:${projectRoot}`);
    expect(workflow.plan_file).toBe(planFile);
    const config = JSON.parse(workflow.config_json) as { projectRoot: string; riskPolicy: { maxPasses: number }; gitPolicy: { commit: string; push: string } };
    expect(config.projectRoot).toBe(projectRoot);
    expect(config.riskPolicy.maxPasses).toBe(1);
    expect(config.gitPolicy.commit).toBe("manual");
    expect(config.gitPolicy.push).toBe("never");

    expect(existsSync(planFile)).toBe(true);
    const plan = readFileSync(planFile, "utf8");
    expect(plan).toContain("Incident ri_escalate_1");
    expect(plan).toContain("Failure class: build_failure");
    expect(plan).toContain("Root cause for diagnosis-ri_escalate_1");
    expect(plan).toContain("Restart the failed build step");
    expect(plan).toContain("evidence-diagnosis-ri_escalate_1");
    expect(plan).toContain("Incident drawer: /incidents");
    expect(plan).toContain("/api/reasoner/incidents/ri_escalate_1");

    const incidentRow = db.query(`
      SELECT escalated_workflow_id FROM reasoner_incidents WHERE id = ?
    `).get("ri_escalate_1") as { escalated_workflow_id: string | null };
    expect(incidentRow.escalated_workflow_id).toBe(workflowId);

    const audit = db.query(`
      SELECT action_id, risk, result_status, result_json FROM action_audit
      WHERE action_kind = 'incidents.escalate' AND target_id = ?
    `).get("ri_escalate_1") as { action_id: string; risk: string; result_status: string; result_json: string } | null;
    expect(audit?.action_id).toBe("escalate:incident:ri_escalate_1");
    expect(audit?.risk).toBe("medium");
    expect(audit?.result_status).toBe("success");
    expect(JSON.parse(audit!.result_json).workflowId).toBe(workflowId);
  });

  it("is idempotent: double-escalate returns the existing workflow without duplicating it", async () => {
    seedSourceWorkflow("bp_escalate_2");
    seedIncident({ id: "ri_escalate_2", representativePassId: "bp_escalate_2" });

    const first = await escalate("ri_escalate_2");
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { ok: boolean; result: { workflowId: string; planFile: string } };
    createdPlanFiles.push(firstBody.result.planFile);

    const second = await escalate("ri_escalate_2");
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { ok: boolean; result: { workflowId: string; alreadyEscalated?: boolean } };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.result.workflowId).toBe(firstBody.result.workflowId);
    expect(secondBody.result.alreadyEscalated).toBe(true);

    const count = (getDashboardDb()!.query(`
      SELECT COUNT(*) AS n FROM builder_workflows WHERE id != 'bw_source'
    `).get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it("returns NOT_FOUND for a missing incident instead of crashing", async () => {
    const res = await escalate("ri_missing");
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("falls back to the control-surface repo when the incident's workflow is not resolvable", async () => {
    seedIncident({ id: "ri_escalate_orphan", representativePassId: "sentinel:api-health" });

    const res = await escalate("ri_escalate_orphan");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; result: { workflowId: string; planFile: string } };
    createdPlanFiles.push(body.result.planFile);
    expect(body.ok).toBe(true);

    const workflow = getDashboardDb()!.query(`
      SELECT config_json FROM builder_workflows WHERE id = ?
    `).get(body.result.workflowId) as { config_json: string };
    const config = JSON.parse(workflow.config_json) as { projectRoot: string; validationProfile: { internal: string[] } };
    expect(config.projectRoot).toBe("/opt/opencode-control-surface");
    expect(config.validationProfile.internal.length).toBeGreaterThan(0);
  });

  it("exposes an Escalate to workflow descriptor for open incidents, disabled once escalated", () => {
    const actions = buildActionCatalog({
      reasonerIncidents: [
        { id: "ri_cat_open", title: "Flapping build", escalatedWorkflowId: null },
        { id: "ri_cat_done", title: "Already owned", escalatedWorkflowId: "bw_existing" },
      ],
    });
    const escalations = actions.filter((action) => action.kind === "escalate");
    expect(escalations).toHaveLength(2);

    const open = escalations.find((action) => action.targetId === "ri_cat_open")!;
    expect(open.id).toBe("escalate:incident:ri_cat_open");
    expect(open.label).toBe("Escalate to workflow");
    expect(open.risk).toBe("medium");
    expect(open.confirm).toBe(false);
    expect(open.disabled).toBe(false);
    expect(open.sourceRoute).toBe("/incidents");

    const done = escalations.find((action) => action.targetId === "ri_cat_done")!;
    expect(done.disabled).toBe(true);
    expect(done.disabledReason).toContain("bw_existing");
  });

  it("attaches the escalate action for the group's latest incident to recurrence insights", () => {
    const now = Date.now();
    const db = getDashboardDb()!;
    const DAY_MS = 24 * 60 * 60 * 1000;
    for (const [id, ageDays] of [["ri_flap_a", 1], ["ri_flap_b", 2], ["ri_flap_c", 3]] as const) {
      db.query(`
        INSERT INTO reasoner_incidents
          (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
           representative_pass_id, representative_diagnosis_id, status, tenant_id)
        VALUES (?, ?, 'sentinel_health', '[high/high] api /health failing', ?, ?, 1, ?, ?, 'open', 'mimule')
      `).run(id, `cluster_${id}`, now - ageDays * DAY_MS, now - ageDays * DAY_MS, `pass_${id}`, `diag_${id}`);
    }

    const { flagged } = detectRecurringIncidents(now);
    expect(flagged).toBe(1);

    const insight = db.query(`
      SELECT action_descriptor_id FROM insights WHERE source_key LIKE 'remediation:recurrence:%'
    `).get() as { action_descriptor_id: string | null } | null;
    expect(insight?.action_descriptor_id).toBe("escalate:incident:ri_flap_a");
  });
});
