import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

const DEMO_TENANT_ID = "showcase-demo";
const DEMO_NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const GENESIS = "genesis";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ts(daysAgo: number, hourOffset = 0): number {
  return DEMO_NOW - daysAgo * DAY + hourOffset * 60 * 60 * 1000;
}

type AuditSeedRow = {
  id: number;
  ts: number;
  actor: string;
  actor_source: string;
  action_kind: string;
  action: string;
  action_id: string;
  reason: string;
  target: string;
  target_type: string;
  target_id: string;
  risk: string;
  args_json: string;
  request_json: string;
  result: string;
  result_status: string;
  result_json: string;
  evidence_json: string;
  job_id: string | null;
  event_id: string;
  rollback_hint: string;
  error: string | null;
  tenant_id: string;
};

function seedAuditChain(db: Database): void {
  const rows: AuditSeedRow[] = [
    {
      id: 9000001001,
      ts: ts(5, 1),
      actor: "Rina Patel",
      actor_source: "dashboard",
      action_kind: "cost.routing.apply_free_first",
      action: "cost.routing.apply_free_first",
      action_id: "demo-cost-free-first",
      reason: "Keep planning and review traffic on free models before using paid fallback.",
      target: "Gateway routing policy",
      target_type: "gateway_policy",
      target_id: "demo-free-first",
      risk: "low",
      args_json: json({ primaryTier: "free", fallbackTier: "paid", monthlyCapCents: 2500 }),
      request_json: json({ requestedBy: "rina@northstar.example", change: "enable free-first routing" }),
      result: "Free-first routing is active for planner, builder, and audit traffic.",
      result_status: "success",
      result_json: json({ savedCentsProjected: 1840, affectedWorkflows: 4 }),
      evidence_json: json([{ label: "Gateway cost ledger", kind: "db", ref: "cost_events:demo-cost-free-first" }]),
      job_id: "demo-job-1",
      event_id: "demo-audit-1",
      rollback_hint: "Set the gateway policy back to paid-only for the demo tenant.",
      error: null,
      tenant_id: DEMO_TENANT_ID,
    },
    {
      id: 9000001002,
      ts: ts(4, 3),
      actor: "Mina Laurent",
      actor_source: "dashboard",
      action_kind: "builder.workflow.start",
      action: "builder.workflow.start",
      action_id: "demo-builder-start",
      reason: "Run the agent-team showcase workflow against the control-surface branch.",
      target: "Agent Team build workflow",
      target_type: "builder_workflow",
      target_id: "demo-wf-agent-team",
      risk: "medium",
      args_json: json({ branch: "showcase/agent-team-proof", validation: "bun run check" }),
      request_json: json({ route: "/agent-team", action: "start workflow" }),
      result: "Workflow started and first validation pass completed.",
      result_status: "success",
      result_json: json({ runId: "demo-run-agent-team", passId: "demo-pass-plan" }),
      evidence_json: json([{ label: "Builder run", kind: "db", ref: "builder_runs:demo-run-agent-team" }]),
      job_id: "demo-job-2",
      event_id: "demo-audit-2",
      rollback_hint: "Pause the workflow and restore the previous branch snapshot.",
      error: null,
      tenant_id: DEMO_TENANT_ID,
    },
    {
      id: 9000001003,
      ts: ts(3, 2),
      actor: "Codex Auditor",
      actor_source: "reasoner",
      action_kind: "reasoner.incident.triage",
      action: "reasoner.incident.triage",
      action_id: "demo-triage-validation",
      reason: "Validation caught a route regression before deploy.",
      target: "Demo validation incident",
      target_type: "reasoner_incident",
      target_id: "demo-ri-validation",
      risk: "low",
      args_json: json({ incidentId: "demo-ri-validation", disposition: "needs rollback" }),
      request_json: json({ source: "builder validation", recommendation: "rollback last UI simplification" }),
      result: "Incident marked triaged with a rollback recommendation.",
      result_status: "success",
      result_json: json({ status: "triaged", recommendedAction: "restore transcript drill-down" }),
      evidence_json: json([{ label: "Reasoner diagnosis", kind: "db", ref: "reasoner_diagnoses:demo-rd-validation" }]),
      job_id: "demo-job-3",
      event_id: "demo-audit-3",
      rollback_hint: "Reopen the incident if the route regresses again.",
      error: null,
      tenant_id: DEMO_TENANT_ID,
    },
    {
      id: 9000001004,
      ts: ts(2, 4),
      actor: "Rina Patel",
      actor_source: "dashboard",
      action_kind: "builder.rollback.apply",
      action: "builder.rollback.apply",
      action_id: "demo-builder-rollback",
      reason: "Restore the richer Agent Team page after validation flagged a missing transcript drill-down.",
      target: "Agent Team page",
      target_type: "builder_run",
      target_id: "demo-run-agent-team",
      risk: "medium",
      args_json: json({ rollbackTo: "last-known-good", affectedRoute: "/agent-team" }),
      request_json: json({ approval: "operator", reason: "preserve existing demo controls" }),
      result: "Rollback applied and the route kept its transcript controls.",
      result_status: "success",
      result_json: json({ restoredControls: ["transcript modal", "project actions", "run cards"] }),
      evidence_json: json([{ label: "Validation", kind: "db", ref: "builder_validations:demo-val-route" }]),
      job_id: "demo-job-4",
      event_id: "demo-audit-4",
      rollback_hint: "Re-run the same workflow if the regression reappears.",
      error: null,
      tenant_id: DEMO_TENANT_ID,
    },
    {
      id: 9000001005,
      ts: ts(1, 5),
      actor: "Mina Laurent",
      actor_source: "dashboard",
      action_kind: "spend_anomaly.triage",
      action: "spend_anomaly.triage",
      action_id: "demo-spend-triage",
      reason: "Review a paid fallback spike and keep the monthly budget under control.",
      target: "Paid fallback spike",
      target_type: "spend_anomaly",
      target_id: "demo-anomaly-paid-fallback",
      risk: "low",
      args_json: json({ anomalyId: "demo-anomaly-paid-fallback", status: "triaged" }),
      request_json: json({ note: "Keep paid fallback enabled only for failed free attempts." }),
      result: "Anomaly triaged; router kept free-first behavior with paid fallback capped.",
      result_status: "success",
      result_json: json({ monthlySavingsCents: 1576, capRemainingCents: 924 }),
      evidence_json: json([{ label: "Spend anomaly", kind: "db", ref: "spend_anomalies:demo-anomaly-paid-fallback" }]),
      job_id: "demo-job-5",
      event_id: "demo-audit-5",
      rollback_hint: "Move the fallback cap back to its prior value.",
      error: null,
      tenant_id: DEMO_TENANT_ID,
    },
  ];

  let prevHash = GENESIS;
  const stmt = db.query(`
    INSERT OR REPLACE INTO action_audit
      (
        id, ts, actor, actor_source, action_kind, action, action_id, reason,
        target, target_type, target_id, risk, args_json, request_json, result,
        result_status, result_json, evidence_json, job_id, event_id, rollback_hint,
        error, tenant_id, prev_hash, row_hash
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    const rowHash = sha256(prevHash + JSON.stringify(row));
    stmt.run(
      row.id,
      row.ts,
      row.actor,
      row.actor_source,
      row.action_kind,
      row.action,
      row.action_id,
      row.reason,
      row.target,
      row.target_type,
      row.target_id,
      row.risk,
      row.args_json,
      row.request_json,
      row.result,
      row.result_status,
      row.result_json,
      row.evidence_json,
      row.job_id,
      row.event_id,
      row.rollback_hint,
      row.error,
      row.tenant_id,
      prevHash,
      rowHash,
    );
    prevHash = rowHash;
  }
}

export function seedDemoData(db: Database): void {
  if (process.env.DEMO_SEED !== "1") {
    return;
  }

  const runSeed = db.transaction(() => {
    db.query(`
      INSERT INTO tenants (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, updated_at = excluded.updated_at
    `).run(DEMO_TENANT_ID, "Northstar Showcase Demo", "active", ts(14), DEMO_NOW);

    db.query(`
      INSERT INTO tenant_settings
        (tenant_id, data_residency_region, storage_root, audit_retention_days, require_two_approvers, sso_required, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        data_residency_region = excluded.data_residency_region,
        storage_root = excluded.storage_root,
        audit_retention_days = excluded.audit_retention_days,
        require_two_approvers = excluded.require_two_approvers,
        sso_required = excluded.sso_required,
        updated_at = excluded.updated_at
    `).run(DEMO_TENANT_ID, "eu-west", "/var/lib/control-surface/demo", 365, 1, 0, DEMO_NOW);

    const priceRows = [
      ["demo-price-free-ultra", "openrouter", "opencode/nemotron-3-ultra-free", "free", 0, 0, null, "OpenRouter free model for builder passes"],
      ["demo-price-free-nano", "openrouter", "openrouter/nvidia/nemotron-3-nano-30b-a3b:free", "free", 0, 0, null, "OpenRouter free model for routing checks"],
      ["demo-price-paid-pro", "openai", "gpt-5.3-codex", "paid", 0.45, 1.35, null, "Paid fallback comparison for complex review"],
      ["demo-price-paid-gemini", "google", "gemini-2.5-pro", "paid", 0.35, 1.05, null, "Paid planner fallback comparison"],
    ] as const;
    for (const row of priceRows) {
      db.query(`
        INSERT OR REPLACE INTO provider_price_catalog
          (id, tenant_id, provider, logical_model, tier, input_cents_per_1k, output_cents_per_1k, hourly_cents, effective_from, effective_to, source_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row[0], DEMO_TENANT_ID, row[1], row[2], row[3], row[4], row[5], row[6], ts(30), null, row[7]);
    }

    const costRows = [
      ["demo-cost-001", ts(6, 1), "gateway", "opencode/nemotron-3-ultra-free", "openrouter", "free", "builder", "demo-wf-agent-team", "control-surface", null, "demo-run-agent-team", 18400, 7100, 0, "provider_free_tier", null, { paidComparisonCents: 17.84, savedCents: 17.84 }],
      ["demo-cost-002", ts(5, 2), "gateway", "openrouter/nvidia/nemotron-3-nano-30b-a3b:free", "openrouter", "free", "cost", "demo-cost-firewall", "gateway", null, null, 12600, 2800, 0, "provider_free_tier", null, { paidComparisonCents: 8.61, savedCents: 8.61 }],
      ["demo-cost-003", ts(4, 3), "gateway", "opencode/nemotron-3-ultra-free", "openrouter", "free", "reasoner", "demo-ri-validation", "reasoner", null, "demo-run-agent-team", 22200, 6300, 0, "provider_free_tier", null, { paidComparisonCents: 18.49, savedCents: 18.49 }],
      ["demo-cost-004", ts(3, 4), "gateway", "gpt-5.3-codex", "openai", "paid", "audit", "demo-wf-agent-team", "control-surface", null, "demo-run-agent-team", 11800, 3900, 10.58, "fallback_estimate", "Free model asked for a stricter code-audit pass.", { freeFirstAttempted: true, fallbackWasCapped: true }],
      ["demo-cost-005", ts(2, 2), "gateway", "openrouter/nvidia/nemotron-3-nano-30b-a3b:free", "openrouter", "free", "content", "demo-insights-inbox", "insights", "showcase-inbox", null, 9100, 2400, 0, "provider_free_tier", null, { paidComparisonCents: 6.38, savedCents: 6.38 }],
      ["demo-cost-006", ts(1, 6), "gateway", "gemini-2.5-pro", "google", "paid", "planner", "demo-wf-agent-team", "control-surface", null, "demo-run-agent-team", 7400, 2100, 4.8, "fallback_estimate", "Capacity retry used paid planner for the final summary.", { freeFirstAttempted: true, fallbackWasCapped: true }],
    ] as const;
    for (const row of costRows) {
      db.query(`
        INSERT OR REPLACE INTO cost_events
          (
            id, tenant_id, ts, source, logical_model, provider, tier, workflow_type,
            workflow_id, project, article_slug, dossier_id, builder_run_id, gateway_call_id,
            input_tokens, output_tokens, cost_cents, cost_basis, fallback_reason, metadata_json
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row[0], DEMO_TENANT_ID, row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], null, row[10], null, row[11], row[12], row[13], row[14], row[15], json(row[16]));
    }

    const anomalyRows = [
      ["demo-anomaly-paid-fallback", ts(1, 7), "workflow", "demo-wf-agent-team", 420, 1538, 3.66, "triaged", "demo-alert-paid-fallback"],
      ["demo-anomaly-content-review", ts(0, -2), "project", "insights-inbox", 180, 522, 2.9, "open", "demo-alert-content-review"],
    ] as const;
    for (const row of anomalyRows) {
      db.query(`
        INSERT OR REPLACE INTO spend_anomalies
          (id, tenant_id, ts, scope_type, scope_id, baseline_cents, observed_cents, multiplier, status, alert_firing_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row[0], DEMO_TENANT_ID, row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8]);
    }

    db.query(`
      INSERT OR REPLACE INTO builder_projects
        (id, name, root, config_json, created_at, updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "demo-project-control-surface",
      "Control Surface Showcase",
      "/opt/opencode-control-surface/.showcase-demo",
      json({ language: "typescript", framework: "bun+react", demo: true }),
      ts(10),
      DEMO_NOW,
      DEMO_TENANT_ID,
    );

    db.query(`
      INSERT OR REPLACE INTO builder_workflows
        (id, project_id, name, mode, status, plan_file, config_json, created_at, updated_at, last_run_id, next_run_at, paused_reason, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "demo-wf-agent-team",
      "demo-project-control-surface",
      "Agent Team build -> audit -> rollback proof",
      "once",
      "ready",
      "SHOWCASE_SPINE_PLAN.md",
      json({
        agentOrder: ["opencode", "codex", "gemini"],
        validationProfile: { commands: ["bun run check", "DASHBOARD_DB=1 bun test server/db/ server/api/"] },
        riskPolicy: { preserveExistingFunctionality: true, rollbackOnRegression: true },
      }),
      ts(8),
      DEMO_NOW,
      "demo-run-agent-team",
      null,
      null,
      DEMO_TENANT_ID,
    );

    db.query(`
      INSERT OR REPLACE INTO builder_runs
        (id, workflow_id, trigger, status, started_at, finished_at, current_pass_id, stop_requested_at,
         stop_requested_by, result_json, error, github_issue_url, github_branch_name, github_commit_hash,
         github_pull_request_url, github_pull_request_status, trace_id, orchestrator_instance_id, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "demo-run-agent-team",
      "demo-wf-agent-team",
      "manual",
      "success",
      ts(4),
      ts(2, 5),
      "demo-pass-rollback",
      null,
      null,
      json({ outcome: "validated rollback", userMessage: "The build was checked, rolled back safely, and left an audit trail." }),
      null,
      null,
      "showcase/agent-team-proof",
      "0f2752e",
      null,
      "not_opened",
      "demo-trace-agent-team",
      "demo-orchestrator-agent-team",
      DEMO_TENANT_ID,
    );

    const passRows = [
      ["demo-pass-plan", 1, "plan", "success", "codex", "openrouter", "opencode/nemotron-3-ultra-free", ts(4), ts(4, 1), ["demo-job-1"], ["demo-val-typecheck"], "Planned a minimal Phase 0 slice with production metadata, seed data, and validation.", null, null, 3, 4, 43],
      ["demo-pass-build", 2, "build", "success", "opencode", "openrouter", "opencode/nemotron-3-ultra-free", ts(4, 1), ts(3, 2), ["demo-job-2"], ["demo-val-unit"], "Implemented the free-first cost proof and alive builder rows for the demo tenant.", null, null, 6, 1, 86],
      ["demo-pass-audit", 3, "audit", "failed", "codex", "openai", "gpt-5.3-codex", ts(3, 2), ts(3, 4), ["demo-job-3"], ["demo-val-route"], "Audit caught a transcript drill-down regression before deploy.", "Restore the last-known-good Agent Team controls.", "ui_regression", 6, 1, 86],
      ["demo-pass-rollback", 4, "rollback", "success", "opencode", "openrouter", "openrouter/nvidia/nemotron-3-nano-30b-a3b:free", ts(2, 3), ts(2, 5), ["demo-job-4", "demo-job-5"], ["demo-val-smoke"], "Rollback restored the route and the final smoke passed.", null, null, 7, 0, 100],
    ] as const;
    for (const row of passRows) {
      db.query(`
        INSERT OR REPLACE INTO builder_passes
          (
            id, run_id, workflow_id, sequence, phase, status, agent, provider, model,
            started_at, finished_at, job_ids_json, validation_ids_json, artifact_ids_json,
            summary, next_instruction, failure_class, error, model_reason, analytics_json,
            plan_items_done, plan_items_remaining, completion_percent, trace_id, tenant_id
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row[0],
        "demo-run-agent-team",
        "demo-wf-agent-team",
        row[1],
        row[2],
        row[3],
        row[4],
        row[5],
        row[6],
        row[7],
        row[8],
        json(row[9]),
        json(row[10]),
        "[]",
        row[11],
        row[12],
        row[13],
        null,
        "Free-first unless validation requires a paid audit fallback.",
        json({ savingsVisible: true, rollbackProof: row[2] === "rollback" }),
        row[14],
        row[15],
        row[16],
        "demo-trace-agent-team",
        DEMO_TENANT_ID,
      );
    }

    const validationRows = [
      ["demo-val-typecheck", "demo-pass-plan", "typecheck", "success", "bun run typecheck", null, ts(4), ts(4, 1), "TypeScript completed with no errors.", null],
      ["demo-val-unit", "demo-pass-build", "test", "success", "DASHBOARD_DB=1 bun test server/db/ server/api/", null, ts(3, 1), ts(3, 2), "Focused DB and API tests passed.", null],
      ["demo-val-route", "demo-pass-audit", "browser", "failed", null, "http://127.0.0.1:3000/agent-team", ts(3, 3), ts(3, 4), "The Agent Team route loaded, but the transcript control was missing. Rollback recommended.", "Transcript control was not visible in the audit viewport."],
      ["demo-val-smoke", "demo-pass-rollback", "smoke", "success", "curl /health && curl /api/version", null, ts(2, 4), ts(2, 5), "Health and version endpoints returned valid JSON after rollback.", null],
    ] as const;
    for (const row of validationRows) {
      db.query(`
        INSERT OR REPLACE INTO builder_validations
          (id, workflow_id, run_id, pass_id, kind, status, command, url, started_at, finished_at, output_tail, artifact_id, error, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row[0], "demo-wf-agent-team", "demo-run-agent-team", row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], null, row[9], DEMO_TENANT_ID);
    }

    const diagnosisRows = [
      ["demo-rd-validation", "demo-pass-audit", "ui_regression", "The route was simplified and the transcript drill-down disappeared.", [{ label: "Browser validation", ref: "builder_validations:demo-val-route" }], [{ label: "Rollback to last-known-good page", safe: true }], "high", ts(3, 4)],
      ["demo-rd-cost", "demo-pass-build", "cost_spike", "Paid fallback was used twice after free models hit capacity.", [{ label: "Spend anomaly", ref: "spend_anomalies:demo-anomaly-paid-fallback" }], [{ label: "Keep free-first routing and cap paid fallback", safe: true }], "medium", ts(1, 8)],
      ["demo-rd-queue", "demo-pass-plan", "queue_delay", "Two agent-team jobs waited for audit capacity before the free fallback picked them up.", [{ label: "Jobs", ref: "jobs:demo-job-3" }], [{ label: "Use free audit tail when paid models are cooled", safe: true }], "medium", ts(0, -1)],
    ] as const;
    for (const row of diagnosisRows) {
      db.query(`
        INSERT OR REPLACE INTO reasoner_diagnoses
          (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json, suggested_actions_json, confidence, raw_llm_response, diagnosed_at, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row[0], row[1], "demo-run-agent-team", "demo-wf-agent-team", row[2], row[3], json(row[4]), json(row[5]), row[6], "Plain-English diagnosis generated for the showcase seed.", row[7], DEMO_TENANT_ID);
    }

    const incidentRows = [
      ["demo-ri-validation", "demo-ui-regression-agent-team", "ui_regression", "Agent Team transcript control was missing", ts(3, 4), ts(2, 4), 2, "demo-pass-audit", "demo-rd-validation", "triaged"],
      ["demo-ri-cost", "demo-paid-fallback-spike", "cost_spike", "Paid fallback spend rose above the demo baseline", ts(1, 8), ts(1, 8), 1, "demo-pass-build", "demo-rd-cost", "open"],
      ["demo-ri-queue", "demo-agent-audit-delay", "queue_delay", "Audit queue waited for paid model capacity", ts(0, -1), ts(0, -1), 1, "demo-pass-plan", "demo-rd-queue", "open"],
    ] as const;
    for (const row of incidentRows) {
      db.query(`
        INSERT OR REPLACE INTO reasoner_incidents
          (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count, representative_pass_id, representative_diagnosis_id, status, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], DEMO_TENANT_ID);
    }

    const jobRows = [
      ["demo-job-1", ts(5, 1), "gateway-policy", "done", "success", "Rina Patel", "Enable free-first routing for showcase workflows.", "gateway_policy", "demo-free-first", "apply routing policy", { primary: "free", fallback: "paid" }, [{ label: "Price catalog", ref: "provider_price_catalog" }], ts(5, 1), ts(5, 2), "Routing policy saved. Free models are preferred and paid fallback is capped.", null, 0],
      ["demo-job-2", ts(4, 1), "builder-run", "done", "success", "Mina Laurent", "Run the agent-team build proof.", "builder_run", "demo-run-agent-team", "start builder workflow", { workflowId: "demo-wf-agent-team" }, [{ label: "Workflow", ref: "builder_workflows:demo-wf-agent-team" }], ts(4, 1), ts(3, 2), "Plan and build passes completed with free-first routing.", null, 0],
      ["demo-job-3", ts(3, 2), "audit", "done", "needs_action", "Codex Auditor", "Check the route before deploy.", "builder_pass", "demo-pass-audit", "run browser audit", { route: "/agent-team" }, [{ label: "Validation", ref: "builder_validations:demo-val-route" }], ts(3, 2), ts(3, 4), "Audit found a missing transcript control and recommended rollback.", "Missing transcript control; rollback recommended.", 1],
      ["demo-job-4", ts(2, 3), "rollback", "done", "success", "Rina Patel", "Restore last-known-good Agent Team controls.", "builder_run", "demo-run-agent-team", "apply rollback", { rollbackTo: "last-known-good" }, [{ label: "Audit row", ref: "action_audit:demo-audit-4" }], ts(2, 3), ts(2, 4), "Rollback completed. Transcript and project controls are visible again.", null, 0],
      ["demo-job-5", ts(1, 5), "cost-review", "done", "success", "Mina Laurent", "Triage paid fallback anomaly.", "spend_anomaly", "demo-anomaly-paid-fallback", "triage anomaly", { status: "triaged" }, [{ label: "Spend anomaly", ref: "spend_anomalies:demo-anomaly-paid-fallback" }], ts(1, 5), ts(1, 6), "Anomaly triaged. Free-first savings remain visible in the cost ledger.", null, 0],
    ] as const;
    for (const row of jobRows) {
      db.query(`
        INSERT OR REPLACE INTO jobs
          (
            id, ts, kind, state, status, actor, reason, target_type, target_id, command,
            request_json, evidence_json, started_at, finished_at, output_tail, error,
            exit_code, max_retries, retry_count, retry_of_job_id, tenant_id
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], json(row[10]), json(row[11]), row[12], row[13], row[14], row[15], row[16], 3, 0, null, DEMO_TENANT_ID);
    }

    seedAuditChain(db);
  });

  runSeed();
}
