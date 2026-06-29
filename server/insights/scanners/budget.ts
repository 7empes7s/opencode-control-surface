import { getDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import type { EvidenceRef } from "../../api/types.ts";
import type { Insight } from "../types.ts";
import { upsertInsight, resolveStaleInsights } from "../store.ts";
import { writeActionAudit } from "../../db/writer.ts";
import { checkBudget, type GovernanceBudget } from "../../governance/budgets.ts";

type ScanResult = {
  scannedAt: number;
  findings: Insight[];
  resolvedCount: number;
};

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref, redacted: true };
}

function add(results: Insight[], input: Parameters<typeof upsertInsight>[0], emittedSourceKeys: string[]): void {
  const row = upsertInsight(input);
  if (row) {
    results.push(row);
    if (input.sourceKey) emittedSourceKeys.push(input.sourceKey);
  }
}

function findConfiguredBudgets(db: ReturnType<typeof getDashboardDb>, tenantClause: string, tenantParams: Array<string | number>): GovernanceBudget[] {
  if (!db) return [];
  return db.query(
    `SELECT * FROM governance_budgets
     WHERE (daily_cap_usd IS NOT NULL OR monthly_cap_usd IS NOT NULL) ${tenantClause}
     ORDER BY scope ASC, project_id ASC`,
  ).all(...tenantParams) as GovernanceBudget[];
}

export function runBudgetScan(): ScanResult {
  const db = getDashboardDb();
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  const emittedSourceKeys: string[] = [];
  if (!db) return { scannedAt, findings, resolvedCount: 0 };

  const tenant = whereTenant();
  const configuredBudgets = findConfiguredBudgets(db, tenant.clause, tenant.params);

  if (configuredBudgets.length === 0) {
    const resolved = resolveStaleInsights(
      "budget:",
      emittedSourceKeys,
      "The budget scanner confirmed spending is back under the warning threshold.",
    );
    for (const insight of resolved) {
      writeActionAudit({
        actor: "system",
        actionKind: "insights.auto-resolve",
        targetType: "insight",
        targetId: insight.id,
        risk: "low",
        resultStatus: "success",
        result: "The budget scanner confirmed spending is back under the warning threshold.",
        request: { sourceKey: insight.sourceKey ?? insight.id },
      });
    }
    return { scannedAt, findings, resolvedCount: resolved.length };
  }

  for (const configured of configuredBudgets) {
    const scope = configured.scope === "project" ? "project" : "global";
    const projectId = configured.project_id ?? undefined;
    const subject = scope === "project" ? `project ${projectId}` : "global";
    const keySuffix = scope === "project" ? `project:${projectId}` : "global";
    const idSuffix = scope === "project" ? `project_${projectId}` : "global";
    const check = checkBudget(scope, projectId);

    if (!check.allowed) {
      const cap = check.cap ?? 0;
      const spent = check.spent ?? 0;
      const pct = cap > 0 ? Math.round((spent / cap) * 100) : 100;
      add(findings, {
        id: `insight_budget_exceeded_${idSuffix}`,
        sourceKey: `budget:exceeded:${keySuffix}`,
        domain: "cost",
        severity: "high",
        title: `The ${subject} spend cap has been reached`,
        plainSummary: `Spending is at ${pct}% of the ${check.period ?? "daily"} cap ($${spent.toFixed(2)} of $${cap.toFixed(2)}). New gateway calls for this scope should be blocked until the cap is raised.`,
        confidence: 0.95,
        evidenceRefs: [
          evidence("Budget row", "db", "governance_budgets"),
          evidence(scope === "project" ? "Project spend" : "Gateway spend", "db", scope === "project" ? "cost_events" : "gateway_calls"),
          evidence("Cost page", "api", "/api/cost/summary"),
        ],
        actionDescriptorId: scope === "project" && projectId ? `mutate-policy:budget:project:${encodeURIComponent(projectId)}:set-cap` : "mutate-policy:budget:global:set-cap",
        manualPageHref: scope === "project" ? "/cost" : "/gateway",
        createdAt: scannedAt,
      }, emittedSourceKeys);
    } else if (check.warn) {
      const pct = Math.round((check.pctUsed ?? 0) * 100);
      const cap = check.period === "monthly"
        ? configured.monthly_cap_usd ?? 0
        : configured.daily_cap_usd ?? 0;
      const spent = check.spent ?? 0;
      add(findings, {
        id: `insight_budget_warn_${idSuffix}`,
        sourceKey: `budget:warn:${keySuffix}`,
        domain: "cost",
        severity: "medium",
        title: `Spending is at ${pct}% of the ${subject} cap`,
        plainSummary: `Spending is at ${pct}% of the ${check.period ?? "daily"} cap ($${(spent ?? 0).toFixed(2)} of $${cap.toFixed(2)}). Calls are still going through — raise the cap or slow spend before it hard-stops.`,
        confidence: 0.9,
        evidenceRefs: [
          evidence("Budget row", "db", "governance_budgets"),
          evidence(scope === "project" ? "Project spend" : "Gateway spend", "db", scope === "project" ? "cost_events" : "gateway_calls"),
          evidence("Cost page", "api", "/api/cost/summary"),
        ],
        actionDescriptorId: null,
        manualPageHref: scope === "project" ? "/cost" : "/gateway",
        createdAt: scannedAt,
      }, emittedSourceKeys);
    }
  }

  const resolved = resolveStaleInsights(
    "budget:",
    emittedSourceKeys,
    "The budget scanner confirmed spending is back under the warning threshold.",
  );
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: "The budget scanner confirmed spending is back under the warning threshold.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }
  return { scannedAt, findings, resolvedCount: resolved.length };
}
