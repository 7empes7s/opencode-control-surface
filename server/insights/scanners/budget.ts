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

function findConfiguredBudget(db: ReturnType<typeof getDashboardDb>, tenantClause: string, tenantParams: Array<string | number>): GovernanceBudget | null {
  if (!db) return null;
  const rows = db.query(
    `SELECT * FROM governance_budgets WHERE scope = ? ${tenantClause} LIMIT 1`,
  ).all("global", ...tenantParams) as GovernanceBudget[];
  return rows[0] ?? null;
}

export function runBudgetScan(): ScanResult {
  const db = getDashboardDb();
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  const emittedSourceKeys: string[] = [];
  if (!db) return { scannedAt, findings, resolvedCount: 0 };

  const tenant = whereTenant();
  const configured = findConfiguredBudget(db, tenant.clause, tenant.params);

  if (!configured) {
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

  const check = checkBudget("global");

  if (!check.allowed) {
    const cap = check.cap ?? 0;
    const spent = check.spent ?? 0;
    const pct = cap > 0 ? Math.round((spent / cap) * 100) : 100;
    add(findings, {
      id: "insight_budget_exceeded_global",
      sourceKey: "budget:exceeded:global",
      domain: "cost",
      severity: "high",
      title: "The global spend cap has been reached",
      plainSummary: `Spending is at ${pct}% of the ${check.period ?? "daily"} cap ($${spent.toFixed(2)} of $${cap.toFixed(2)}). New gateway calls are being blocked until the cap is raised.`,
      confidence: 0.95,
      evidenceRefs: [
        evidence("Budget row", "db", "governance_budgets"),
        evidence("Gateway spend", "db", "gateway_calls"),
        evidence("Gateway page", "api", "/gateway"),
      ],
      actionDescriptorId: "mutate-policy:budget:global:set-cap",
      manualPageHref: "/gateway",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  } else if (check.warn) {
    const pct = Math.round((check.pctUsed ?? 0) * 100);
    const cap = check.period === "monthly"
      ? configured.monthly_cap_usd ?? 0
      : configured.daily_cap_usd ?? 0;
    const spent = check.period === "monthly"
      ? check.spent ?? 0
      : check.spent ?? 0;
    add(findings, {
      id: "insight_budget_warn_global",
      sourceKey: "budget:warn:global",
      domain: "cost",
      severity: "medium",
      title: `Spending is at ${pct}% of the global cap`,
      plainSummary: `Spending is at ${pct}% of the ${check.period ?? "daily"} cap ($${(spent ?? 0).toFixed(2)} of $${cap.toFixed(2)}). New gateway calls are still going through — raise the cap or slow spend before it hard-stops.`,
      confidence: 0.9,
      evidenceRefs: [
        evidence("Budget row", "db", "governance_budgets"),
        evidence("Gateway spend", "db", "gateway_calls"),
        evidence("Gateway page", "api", "/gateway"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/gateway",
      createdAt: scannedAt,
    }, emittedSourceKeys);
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
