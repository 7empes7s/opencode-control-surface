import { getDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import type { EvidenceRef } from "../../api/types.ts";
import type { Insight, InsightSeverity } from "../types.ts";
import { upsertInsight, resolveStaleInsights } from "../store.ts";
import { writeActionAudit } from "../../db/writer.ts";

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

function severityForOwners(ownerCount: number, totalCount: number): InsightSeverity {
  if (ownerCount >= 5) return "critical";
  if (ownerCount >= 3) return "high";
  if (totalCount > 0 && ownerCount / totalCount > 0.5 && ownerCount > 1) return "medium";
  return "low";
}

export function runSecurityScan(): ScanResult {
  const db = getDashboardDb();
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  const emittedSourceKeys: string[] = [];
  if (!db) return { scannedAt, findings, resolvedCount: 0 };

  const tenant = whereTenant();

  const weakSecrets = db.query(`
    SELECT id, name, key_id, encrypted_value, encrypted_dek, iv
    FROM governance_secrets
    WHERE (
      encrypted_value IS NULL OR encrypted_value = ''
      OR encrypted_dek IS NULL OR encrypted_dek = ''
      OR iv IS NULL OR iv = ''
      OR lower(key_id) IN ('plain', 'plaintext', 'none', 'unencrypted')
    ) ${tenant.clause}
    LIMIT 20
  `).all(...tenant.params) as Array<{ id: string; name: string; key_id: string | null }>;

  for (const row of weakSecrets) {
    add(findings, {
      id: `insight_security_secret_storage_${row.id}`,
      sourceKey: `security:weak_secret:${row.id}`,
      domain: "security",
      severity: "critical",
      title: "A secret is not fully protected",
      plainSummary: `The secret named ${row.name} is missing one of the encryption fields the vault expects. Rotate it and store it through the governance secrets page.`,
      confidence: 0.92,
      evidenceRefs: [
        evidence("Secret metadata", "db", `governance_secrets:${row.id}`),
        evidence("Secrets page", "api", "/api/governance/secrets"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/governance",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  }

  const possibleLeaks = db.query(`
    SELECT COUNT(*) AS count
    FROM action_audit
    WHERE (
      request_json LIKE '%sk-%'
      OR result_json LIKE '%sk-%'
      OR error LIKE '%Bearer %'
      OR error LIKE '%api_key=%'
      OR error LIKE '%password=%'
      OR error LIKE '%token=%'
    ) ${tenant.clause}
  `).get(...tenant.params) as { count: number } | null;

  if ((possibleLeaks?.count ?? 0) > 0) {
    add(findings, {
      id: "insight_security_audit_secret_leak_signal",
      sourceKey: "security:audit_secret_leak_signal",
      domain: "security",
      severity: "high",
      title: "Audit history may contain exposed credentials",
      plainSummary: "Recent audit rows include text patterns that look like credentials. Review the audit export, rotate any exposed values, and keep redaction enabled for future actions.",
      confidence: 0.76,
      evidenceRefs: [
        evidence("Audit rows", "db", "action_audit"),
        evidence("Audit page", "api", "/api/actions/audit"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/audit",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  }

  const roleCounts = db.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN role = 'owner' THEN 1 ELSE 0 END) AS owners
    FROM governance_role_bindings
    WHERE 1=1 ${tenant.clause}
  `).get(...tenant.params) as { total: number; owners: number | null } | null;

  const ownerCount = roleCounts?.owners ?? 0;
  const totalCount = roleCounts?.total ?? 0;
  if (ownerCount >= 3 || (totalCount > 0 && ownerCount / totalCount > 0.5 && ownerCount > 1)) {
    add(findings, {
      id: "insight_security_too_many_owners",
      sourceKey: "security:too_many_owners",
      domain: "security",
      severity: severityForOwners(ownerCount, totalCount),
      title: "Owner access is broader than expected",
      plainSummary: `${ownerCount} users have owner access. Keep owners to the smallest practical group and move day-to-day operators to the operator role.`,
      confidence: 0.84,
      evidenceRefs: [
        evidence("Role bindings", "db", "governance_role_bindings"),
        evidence("RBAC page", "api", "/api/governance/rbac/me"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/settings",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  }

  const logOnly = db.query(`
    SELECT COUNT(*) AS count
    FROM governance_policy_decisions
    WHERE lower(effect) IN ('log-only', 'log_only', 'audit', 'monitor') ${tenant.clause}
  `).get(...tenant.params) as { count: number } | null;

  if ((logOnly?.count ?? 0) > 0) {
    add(findings, {
      id: "insight_security_policies_log_only",
      sourceKey: "security:policies_log_only",
      domain: "security",
      severity: "medium",
      title: "Some policies are only logging decisions",
      plainSummary: "Governance has policies that record decisions without enforcing them. Review these rules and switch important controls to enforce mode before the showcase.",
      confidence: 0.8,
      evidenceRefs: [
        evidence("Policy decisions", "db", "governance_policy_decisions"),
        evidence("Governance policies", "api", "/api/governance/policies"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/governance",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  }

  const activeAgents = db.query(`
    SELECT COUNT(*) AS count
    FROM builder_workflows
    WHERE status IN ('active', 'running') ${tenant.clause}
  `).get(...tenant.params) as { count: number } | null;
  const budgetCaps = db.query(`
    SELECT COUNT(*) AS count
    FROM governance_budgets
    WHERE (daily_cap_usd IS NOT NULL OR monthly_cap_usd IS NOT NULL) ${tenant.clause}
  `).get(...tenant.params) as { count: number } | null;

  if ((activeAgents?.count ?? 0) > 0 && (budgetCaps?.count ?? 0) === 0) {
    add(findings, {
      id: "insight_security_agents_without_budget_cap",
      sourceKey: "security:agents_without_budget_cap",
      domain: "security",
      severity: "high",
      title: "Active agents do not have a budget cap",
      plainSummary: "At least one agent workflow is active, but no daily or monthly budget cap is configured. Add a budget cap before letting autonomous runs continue.",
      confidence: 0.88,
      evidenceRefs: [
        evidence("Active workflows", "db", "builder_workflows"),
        evidence("Budget settings", "api", "/api/governance/budgets"),
      ],
      actionDescriptorId: "mutate-policy:budget:global:set-cap",
      manualPageHref: "/governance",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  }

  const resolved = resolveStaleInsights(
    "security:",
    emittedSourceKeys,
    "The security scanner confirmed this is no longer the case."
  );
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: "The security scanner confirmed this is no longer the case.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }
  return { scannedAt, findings, resolvedCount: resolved.length };
}

