import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { readBuilderWorkflow } from "../builder/store.ts";
import { startWorkflowRun } from "../builder/runner.ts";

export type PlaybookAction =
  | "retry-narrow"
  | "retry-continuation"
  | "switch-agent-opencode"
  | "notify-operator"
  | "retry-strict-prompt";

export type Playbook = {
  id: string;
  name: string;
  description: string;
  failureClassPattern: string;
  actions: PlaybookAction[];
  isSafe: boolean;
  createdAt: number;
};

export type PlaybookRunTrigger = "auto" | "operator";

type PlaybookRow = {
  id: string;
  name: string;
  description: string;
  failure_class_pattern: string;
  actions_json: string;
  is_safe: number;
  created_at: number;
};

const BUILT_IN_PLAYBOOKS: Array<Omit<Playbook, "createdAt">> = [
  {
    id: "agent-stalled",
    name: "Retry with narrower scope",
    description: "Re-run the workflow with instructions to reduce scope and preserve progress.",
    failureClassPattern: "agent-stalled",
    actions: ["retry-narrow"],
    isSafe: true,
  },
  {
    id: "pass-timeout",
    name: "Retry with continuation context",
    description: "Re-run the workflow with continuation context after a timeout.",
    failureClassPattern: "pass-timeout",
    actions: ["retry-continuation"],
    isSafe: true,
  },
  {
    id: "codex-exhausted",
    name: "Switch to OpenCode",
    description: "Move OpenCode to the front of the workflow agent order before retrying.",
    failureClassPattern: "codex-exhausted",
    actions: ["switch-agent-opencode"],
    isSafe: true,
  },
  {
    id: "validation-failed",
    name: "Surface to operator",
    description: "Record an operator notification for manual validation triage.",
    failureClassPattern: "validation-failed",
    actions: ["notify-operator"],
    isSafe: false,
  },
  {
    id: "no-result-file",
    name: "Retry with stricter prompt",
    description: "Re-run the workflow with explicit PASS_RESULT output requirements.",
    failureClassPattern: "no-result-file",
    actions: ["retry-strict-prompt"],
    isSafe: true,
  },
];

function rowToPlaybook(row: PlaybookRow): Playbook {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    failureClassPattern: row.failure_class_pattern,
    actions: JSON.parse(row.actions_json) as PlaybookAction[],
    isSafe: row.is_safe === 1,
    createdAt: row.created_at,
  };
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*")) return false;

  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function requireDb(): Database {
  if (!isDashboardDbEnabled()) throw new Error("DASHBOARD_DB disabled");
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard SQLite unavailable");
  return db;
}

export function seedPlaybooks(db: Database): void {
  const existing = db.query(`SELECT COUNT(*) as count FROM reasoner_playbooks`).get() as { count: number } | null;
  if ((existing?.count ?? 0) > 0) return;

  const createdAt = Date.now();
  const insert = db.query(`
    INSERT INTO reasoner_playbooks
      (id, name, description, failure_class_pattern, actions_json, is_safe, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const playbook of BUILT_IN_PLAYBOOKS) {
    insert.run(
      playbook.id,
      playbook.name,
      playbook.description,
      playbook.failureClassPattern,
      JSON.stringify(playbook.actions),
      playbook.isSafe ? 1 : 0,
      createdAt,
    );
  }
}

export function listPlaybooks(db = requireDb()): Playbook[] {
  const rows = db.query(`
    SELECT id, name, description, failure_class_pattern, actions_json, is_safe, created_at
    FROM reasoner_playbooks
    ORDER BY created_at ASC, id ASC
  `).all() as PlaybookRow[];
  return rows.map(rowToPlaybook);
}

export function matchPlaybook(db: Database, failureClass: string): Playbook | null {
  const playbooks = listPlaybooks(db);
  return playbooks.find((playbook) => globMatches(playbook.failureClassPattern, failureClass)) ?? null;
}

export async function applyPlaybookAction(
  action: PlaybookAction,
  workflowId: string,
  runId?: string | null,
  passId?: string | null,
): Promise<string> {
  if (action === "notify-operator") {
    writeActionAudit({
      actor: "reasoner",
      actorSource: "reasoner",
      actionKind: "reasoner.playbook.notify-operator",
      reason: "Reasoner playbook requested operator review",
      targetType: "builder-workflow",
      targetId: workflowId,
      risk: "medium",
      request: { action, workflowId, runId, passId },
      result: "operator notification recorded",
      resultStatus: "success",
    });
    return "operator-notified";
  }

  if (action === "switch-agent-opencode") {
    const db = requireDb();
    const workflow = readBuilderWorkflow(workflowId);
    if (!workflow) throw new Error("workflow not found");

    const agentOrder = [
      "opencode",
      ...workflow.config.agentOrder.filter((entry) => !entry.startsWith("opencode")),
    ];
    const config = { ...workflow.config, agentOrder };
    db.query(`
      UPDATE builder_workflows
      SET config_json = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(config), Date.now(), workflowId);
    return "agent-order-updated";
  }

  const trigger = action === "retry-narrow"
    ? "reasoner-retry-narrow"
    : action === "retry-continuation"
      ? "reasoner-retry-continuation"
      : "reasoner-retry-strict-prompt";
  const run = await startWorkflowRun(workflowId, trigger, "reasoner");
  return run.id;
}

export function recordPlaybookRun(
  db: Database,
  playbookId: string,
  incidentId: string | null,
  passId: string | null,
  triggeredBy: PlaybookRunTrigger,
  actionsApplied: string[],
  result: string,
): string {
  const id = `rpr_${randomUUID()}`;
  db.query(`
    INSERT INTO reasoner_playbook_runs
      (id, playbook_id, incident_id, pass_id, triggered_by, actions_applied_json, result, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    playbookId,
    incidentId,
    passId,
    triggeredBy,
    JSON.stringify(actionsApplied),
    result,
    Date.now(),
  );
  return id;
}
