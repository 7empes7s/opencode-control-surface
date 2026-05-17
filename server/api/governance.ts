import { loadPolicyDocument, evaluatePolicy } from "../governance/policy.ts";
import { resolveRole, checkPermission, getAllowedActions } from "../governance/rbac.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { randomUUID } from "node:crypto";
import { writeSecret, readSecretPlaintext, listSecrets, deleteSecret } from "../governance/secrets.ts";
import { checkBudget, upsertBudget, getBudgetSpending } from "../governance/budgets.ts";
import { getRetentionPolicy, setRetentionPolicy } from "../governance/retention.ts";

const DEFAULT_POLICY_PATH = "/etc/tib-builder/policies/default.yaml";
let loadedPolicies: Awaited<ReturnType<typeof loadPolicyDocument>>[] = [];

export async function loadPolicies() {
  loadedPolicies = [];
  const doc = await loadPolicyDocument(DEFAULT_POLICY_PATH);
  if (doc) loadedPolicies.push(doc);
}

export function getGovernanceRole(req: Request): string {
  const token = req.headers.get("x-operator-token") || "";
  return resolveRole(token);
}

export function requireRole(action: string) {
  return (req: Request) => {
    const role = getGovernanceRole(req);
    if (!checkPermission(role as "owner" | "operator" | "auditor" | "viewer", action)) {
      return new Response(JSON.stringify({ error: "Forbidden", role, required: action }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return null;
  };
}

export async function governancePoliciesHandler(): Promise<Response> {
  await loadPolicies();
  const db = getDashboardDb();
  const decisions = db
    ? db
        .query("SELECT COUNT(*) as count FROM governance_policy_decisions")
        .all()
        .pop()
    : { count: 0 };

  return Response.json({
    policies: loadedPolicies.map((p) => ({
      name: p.name,
      version: p.version,
      ruleCount: p.rules.length,
      path: DEFAULT_POLICY_PATH,
    })),
    decisionCount: (decisions as { count: number }).count,
  });
}

export async function governancePoliciesReloadHandler(): Promise<Response> {
  await loadPolicies();
  return Response.json({ ok: true, count: loadedPolicies.length });
}

export async function governanceRbacMeHandler(req: Request): Promise<Response> {
  const role = getGovernanceRole(req);
  return Response.json({
    role,
    allowedActions: getAllowedActions(role as "owner" | "operator" | "auditor" | "viewer"),
  });
}

export async function governanceApprovalsListHandler(): Promise<Response> {
  const db = getDashboardDb();
  if (!db) return Response.json({ error: "db not available" }, { status: 500 });
  const pending = db
    .query("SELECT * FROM governance_approvals WHERE decision IS NULL ORDER BY requested_at DESC")
    .all();
  const completed = db
    .query("SELECT * FROM governance_approvals WHERE decision IS NOT NULL ORDER BY decided_at DESC LIMIT 50")
    .all();
  return Response.json({ pending, completed });
}

export async function governanceApprovalDecideHandler(
  req: Request,
  runId: string,
  decision: "approve" | "reject",
): Promise<Response> {
  const roleErr = requireRole("secrets.write")?.(req);
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => ({}));
  const reason: string | undefined = body.reason;
  const db = getDashboardDb();
  if (!db) return Response.json({ error: "db not available" }, { status: 500 });

  const existing = db
    .query("SELECT * FROM governance_approvals WHERE run_id = ? AND decision IS NULL")
    .all(runId);

  if (!existing.length) {
    return Response.json({ error: "approval not found" }, { status: 404 });
  }

  const now = Date.now();
  db.query(
    "UPDATE governance_approvals SET decided_at = ?, decided_by = ?, decision = ?, reason = ? WHERE run_id = ? AND decision IS NULL",
  ).run(now, "owner", decision, reason ?? null, runId);

  if (decision === "approve") {
    try {
      const { startWorkflowRun } = await import("../builder/runner.ts");
      const run = db.query("SELECT workflow_id FROM builder_runs WHERE id = ?").get(runId) as { workflow_id: string } | null;
      if (run) {
        await startWorkflowRun(run.workflow_id, "approved", "owner");
      }
    } catch (e) {
      console.error("[governance] approve trigger failed:", e);
    }
  }

  return Response.json({ ok: true });
}

export async function governanceSecretsListHandler(req: Request): Promise<Response> {
  const roleErr = requireRole("secrets.read")?.(req);
  if (roleErr) return roleErr;
  try {
    const secrets = listSecrets();
    return Response.json({ secrets });
  } catch {
    return Response.json({ error: "failed to list secrets" }, { status: 500 });
  }
}

export async function governanceSecretsWriteHandler(req: Request): Promise<Response> {
  const roleErr = requireRole("secrets.write")?.(req);
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.value) {
    return Response.json({ error: "name and value required" }, { status: 400 });
  }
  try {
    const entry = writeSecret(body.name, body.value, body.description ?? "");
    return Response.json({ ok: true, id: entry.id, name: entry.name });
  } catch {
    return Response.json({ error: "failed to write secret" }, { status: 500 });
  }
}

export async function governanceSecretsDeleteHandler(req: Request, name: string): Promise<Response> {
  const roleErr = requireRole("secrets.write")?.(req);
  if (roleErr) return roleErr;
  try {
    const deleted = deleteSecret(name);
    return Response.json({ ok: deleted });
  } catch {
    return Response.json({ error: "failed to delete secret" }, { status: 500 });
  }
}

export async function governanceBudgetsListHandler(): Promise<Response> {
  const db = getDashboardDb();
  if (!db) return Response.json({ error: "db not available" }, { status: 500 });
  const budgets = db.query("SELECT * FROM governance_budgets").all();
  const spending = getBudgetSpending("global", undefined);
  return Response.json({ budgets, spending });
}

export async function governanceBudgetsWriteHandler(req: Request): Promise<Response> {
  const roleErr = requireRole("secrets.write")?.(req);
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => null);
  if (!body?.scope) {
    return Response.json({ error: "scope required" }, { status: 400 });
  }
  const scope = body.scope as "global" | "project";
  upsertBudget(scope, {
    dailyCapUsd: body.dailyCapUsd,
    monthlyCapUsd: body.monthlyCapUsd,
    warnPct: body.warnPct,
    projectId: body.projectId,
  });
  return Response.json({ ok: true });
}

export async function governanceRetentionHandler(): Promise<Response> {
  return Response.json(getRetentionPolicy());
}

export async function governanceRetentionWriteHandler(req: Request): Promise<Response> {
  const roleErr = requireRole("secrets.write")?.(req);
  if (roleErr) return roleErr;
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "body required" }, { status: 400 });
  setRetentionPolicy({
    tracesTtlDays: body.tracesTtlDays,
    runDirsTtlDays: body.runDirsTtlDays,
    auditLogRetainForever: body.auditLogRetainForever,
  });
  return Response.json({ ok: true, policy: getRetentionPolicy() });
}

export async function evaluatePolicyForEvent(event: string, ctx: Record<string, unknown>): Promise<void> {
  for (const doc of loadedPolicies) {
    const decision = evaluatePolicy(doc, { event, ...ctx } as Parameters<typeof evaluatePolicy>[1]);
    if (decision.effect !== "log-only") {
      const db = getDashboardDb();
      if (db) {
        db.query(
          "INSERT INTO governance_policy_decisions (id, policy_id, event_type, effect, rule_name, reason, context_json, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          crypto.randomUUID(),
          doc.name,
          event,
          decision.effect,
          decision.ruleName ?? null,
          decision.reason,
          JSON.stringify(ctx),
          Date.now(),
        );
      }
    }
  }
}