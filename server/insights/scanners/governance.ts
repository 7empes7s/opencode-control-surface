import { existsSync, readFileSync } from "node:fs";
import type { EvidenceRef } from "../../api/types.ts";
import { getServiceStatuses } from "../../adapters/system.ts";
import { getDashboardDb } from "../../db/dashboard.ts";
import { writeActionAudit } from "../../db/writer.ts";
import { computeTrustScore, getTrustScoreHistory } from "../../security/score.ts";
import { upsertInsight, resolveStaleInsights } from "../store.ts";
import type { Insight, InsightInput, InsightSeverity } from "../types.ts";

type ScanResult = {
  scannedAt: number;
  findings: Insight[];
  resolvedCount: number;
};

export type ConfigSelfCheck = {
  id: string;
  ok: boolean;
  severity: InsightSeverity;
  title: string;
  remediation: string;
  evidenceKind: EvidenceRef["kind"];
  evidenceRef: string;
  manualPageHref: string;
};

export type SuspiciousActivitySignal = {
  failedMutations: number;
  unknownActors: number;
  windowMinutes: number;
};

export type SlaIncident = {
  id: string;
  title: string;
  openedAt: number;
  severity: InsightSeverity;
};

export type ComplianceSignal = {
  configured: boolean;
  missingControls: string[];
};

export type SecurityPostureSignal = {
  score: number;
  previousScore: number | null;
};

type GovernanceProbeOverrides = Partial<{
  configSelfChecks: () => ConfigSelfCheck[];
  suspiciousActivity: () => SuspiciousActivitySignal;
  slaIncidents: () => SlaIncident[];
  complianceSignal: () => ComplianceSignal;
  securityPosture: () => SecurityPostureSignal | null;
  staleFeatureFlags: () => InsightInput[];
}>;

let governanceProbeOverrides: GovernanceProbeOverrides | null = null;

const DEFAULT_SENTINEL_HEALTH_PATH = "/var/lib/mimule/product-health.json";
const SLA_BREACH_MS = 4 * 60 * 60 * 1000;
// An incident must also still be recently active to count as a live SLA breach —
// otherwise abandoned, years-old incidents would dominate the score forever.
const SLA_RECENT_MS = 14 * 24 * 60 * 60 * 1000;

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref, redacted: true };
}

function safeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "");
}

function hasTable(name: string): boolean {
  const db = getDashboardDb();
  if (!db) return false;
  try {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { name: string } | null;
    return !!row;
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function setGovernanceProbeOverridesForTest(overrides: GovernanceProbeOverrides | null): void {
  governanceProbeOverrides = overrides;
}

export function readConfigSelfChecks(): ConfigSelfCheck[] {
  const checks: ConfigSelfCheck[] = [];
  const tokenPresent = Boolean(process.env.OPERATOR_TOKEN);
  checks.push({
    id: "operator-token",
    ok: tokenPresent,
    severity: "critical",
    title: "Operator token is not configured",
    remediation: "Set OPERATOR_TOKEN in the service environment so all mutating endpoints stay fail-closed and usable by authorized operators.",
    evidenceKind: "api",
    evidenceRef: "OPERATOR_TOKEN presence only",
    manualPageHref: "/install",
  });

  let secretsReadable = true;
  const db = getDashboardDb();
  if (db) {
    try {
      db.query("SELECT COUNT(*) AS count FROM governance_secrets").get();
    } catch {
      secretsReadable = false;
    }
  }
  checks.push({
    id: "secrets-readable",
    ok: secretsReadable,
    severity: "high",
    title: "Secrets metadata is not readable",
    remediation: "Repair the governance secrets store before relying on setup, security, or gateway checks that need secret presence metadata.",
    evidenceKind: "db",
    evidenceRef: "governance_secrets",
    manualPageHref: "/governance",
  });

  const sentinelPath = process.env.SENTINEL_HEALTH_PATH ?? DEFAULT_SENTINEL_HEALTH_PATH;
  const sentinel = readJson(sentinelPath);
  const sentinelTs = typeof sentinel?.checkedAt === "number"
    ? sentinel.checkedAt
    : typeof sentinel?.ts === "number"
      ? sentinel.ts
      : null;
  const sentinelFresh = !!sentinel && (sentinelTs === null || Date.now() - sentinelTs < 2 * 60 * 60 * 1000);
  checks.push({
    id: "sentinel-running",
    ok: sentinelFresh,
    severity: "medium",
    title: "Product sentinel health is missing or stale",
    remediation: "Run or repair the product health sentinel so onboarding and security checks can trust the latest stack status.",
    evidenceKind: "file",
    evidenceRef: sentinelPath,
    manualPageHref: "/install",
  });

  let ingestorFresh = true;
  if (db) {
    try {
      const row = db.query("SELECT MAX(ts) AS ts FROM metric_samples").get() as { ts: number | null } | null;
      ingestorFresh = typeof row?.ts === "number" && Date.now() - row.ts < 5 * 60 * 1000;
    } catch {
      ingestorFresh = false;
    }
  }
  checks.push({
    id: "ingestor-running",
    ok: ingestorFresh,
    severity: "medium",
    title: "Dashboard ingestor has not written recent samples",
    remediation: "Repair the in-process dashboard ingestor so trends, health score, and detector evidence stay fresh.",
    evidenceKind: "db",
    evidenceRef: "metric_samples",
    manualPageHref: "/admin",
  });

  let tunnelOk = true;
  let tunnelRef = "no tunnel service discovered";
  try {
    const tunnelUnits = getServiceStatuses().filter((service) => /cloudflared|tunnel/i.test(service.name));
    tunnelRef = tunnelUnits.map((unit) => `${unit.name}:${unit.status}`).join(", ") || tunnelRef;
    tunnelOk = tunnelUnits.length === 0 || tunnelUnits.every((unit) => unit.status === "active");
  } catch {
    tunnelOk = true;
  }
  checks.push({
    id: "tunnels-up",
    ok: tunnelOk,
    severity: "high",
    title: "Public tunnel service is not active",
    remediation: "Repair the public tunnel before onboarding can declare the control surface reachable.",
    evidenceKind: "api",
    evidenceRef: tunnelRef,
    manualPageHref: "/infra",
  });

  return checks;
}

export function readSuspiciousActivitySignal(): SuspiciousActivitySignal {
  const db = getDashboardDb();
  if (!db) return { failedMutations: 0, unknownActors: 0, windowMinutes: 60 };
  const since = Date.now() - 60 * 60 * 1000;
  try {
    const failed = db.query(`
      SELECT COUNT(*) AS count
      FROM action_audit
      WHERE ts >= ?
        AND result_status = 'failed'
        AND (action_kind LIKE 'mutate-policy.%' OR action_kind LIKE 'start-job.%')
    `).get(since) as { count: number } | null;
    const unknown = db.query(`
      SELECT COUNT(*) AS count
      FROM action_audit
      WHERE ts >= ?
        AND (actor IS NULL OR actor = '' OR lower(actor) IN ('unknown', 'anonymous'))
    `).get(since) as { count: number } | null;
    return { failedMutations: failed?.count ?? 0, unknownActors: unknown?.count ?? 0, windowMinutes: 60 };
  } catch {
    return { failedMutations: 0, unknownActors: 0, windowMinutes: 60 };
  }
}

export function readSlaIncidents(now = Date.now()): SlaIncident[] {
  const db = getDashboardDb();
  if (!db || !hasTable("reasoner_incidents")) return [];
  try {
    const rows = db.query(`
      SELECT id, title, first_seen, last_seen, occurrence_count
      FROM reasoner_incidents
      WHERE status = 'open'
        AND first_seen <= ?
        AND last_seen >= ?
      ORDER BY first_seen ASC
      LIMIT 20
    `).all(now - SLA_BREACH_MS, now - SLA_RECENT_MS) as Array<{ id: string; title: string; first_seen: number; last_seen: number; occurrence_count: number }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      openedAt: row.first_seen,
      severity: row.occurrence_count >= 3 ? "critical" : "high",
    }));
  } catch {
    return [];
  }
}

export function readComplianceSignal(): ComplianceSignal {
  if (!existsSync("server/compliance/generator.ts")) {
    return { configured: false, missingControls: ["compliance module not configured"] };
  }
  if (!hasTable("compliance_controls") && !hasTable("compliance_control_evidence")) {
    return { configured: false, missingControls: ["control matrix not configured"] };
  }
  return { configured: true, missingControls: [] };
}

export function readSecurityPostureSignal(): SecurityPostureSignal | null {
  try {
    const current = computeTrustScore();
    const history = getTrustScoreHistory(30);
    const previous = history.length > 1 ? history[history.length - 2]?.score ?? null : null;
    return { score: current.score, previousScore: previous };
  } catch {
    return null;
  }
}

const STALE_FLAG_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STALE_UNTOUCHED_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function readStaleFeatureFlagFindings(): InsightInput[] {
  if (!hasTable("feature_flags")) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const now = Date.now();
  const staleThreshold = now - STALE_FLAG_WINDOW_MS;
  const untouchedThreshold = now - STALE_UNTOUCHED_WINDOW_MS;

  type FlagRow = { id: string; key: string; label: string | null; enabled: number; rollout_percentage: number; updated_at: number };

  const flags = db.query<FlagRow, [number, number]>(
    `SELECT id, key, label, enabled, rollout_percentage, updated_at
     FROM feature_flags
     WHERE (
       (enabled = 1 AND rollout_percentage = 100 AND updated_at < ?)
       OR
       (updated_at < ?)
     )`,
  ).all(staleThreshold, untouchedThreshold) as FlagRow[];

  const findings: InsightInput[] = [];
  for (const flag of flags) {
    const name = flag.label ?? flag.key;
    if (flag.enabled && flag.rollout_percentage >= 100 && flag.updated_at < staleThreshold) {
      findings.push({
        id: `insight_ops_stale_ff_${safeKey(flag.key)}`,
        sourceKey: `ops:stale-feature-flag:${flag.key}`,
        domain: "ops",
        severity: "low",
        title: `Feature flag "${name}" is fully rolled out and can be removed`,
        plainSummary: `Flag "${flag.key}" has been enabled at 100% rollout for over 30 days without changes. If this feature is stable and permanent, remove the flag from the codebase to reduce dead code and branching complexity.`,
        confidence: 0.85,
        evidenceRefs: [evidence("Feature flags table", "db", "feature_flags")],
        actionDescriptorId: null,
        manualPageHref: "/feature-flags",
        createdAt: now,
      });
    } else if (flag.updated_at < untouchedThreshold) {
      findings.push({
        id: `insight_ops_inactive_ff_${safeKey(flag.key)}`,
        sourceKey: `ops:stale-feature-flag:${flag.key}`,
        domain: "ops",
        severity: "info",
        title: `Feature flag "${name}" has not been modified in 90 days`,
        plainSummary: `Flag "${flag.key}" hasn't changed in over 90 days. Review whether it is still needed — stale flags add maintenance burden and make the codebase harder to reason about.`,
        confidence: 0.75,
        evidenceRefs: [evidence("Feature flags table", "db", "feature_flags")],
        actionDescriptorId: null,
        manualPageHref: "/feature-flags",
        createdAt: now,
      });
    }
  }
  return findings;
}

export function mapConfigSelfCheckFindings(checks: ConfigSelfCheck[], now: number): InsightInput[] {
  return checks.filter((check) => !check.ok).map((check) => ({
    id: `insight_security_config_selfcheck_${safeKey(check.id)}`,
    sourceKey: `security:config-selfcheck:${check.id}`,
    domain: "security",
    severity: check.severity,
    title: check.title,
    plainSummary: check.remediation,
    confidence: 0.9,
    evidenceRefs: [evidence("Self-check evidence", check.evidenceKind, check.evidenceRef)],
    actionDescriptorId: null,
    manualPageHref: check.manualPageHref,
    createdAt: now,
  }));
}

export function mapSuspiciousActivityFindings(signal: SuspiciousActivitySignal, now: number): InsightInput[] {
  if (signal.failedMutations < 5 && signal.unknownActors < 10) return [];
  return [{
    id: "insight_security_suspicious_activity",
    sourceKey: "security:suspicious-activity",
    domain: "security",
    severity: signal.failedMutations >= 10 ? "high" : "medium",
    title: "Suspicious admin activity pattern detected",
    plainSummary: `${signal.failedMutations} failed mutations and ${signal.unknownActors} unattributed audit rows were recorded in the last ${signal.windowMinutes}m. Review the audit log for token misuse, broken automation, or an actor that is not being attributed.`,
    confidence: 0.65,
    evidenceRefs: [evidence("Action audit", "db", "action_audit")],
    actionDescriptorId: null,
    manualPageHref: "/audit",
    createdAt: now,
  }];
}

export function mapSlaBreachFindings(incidents: SlaIncident[], now: number): InsightInput[] {
  return incidents.map((incident) => ({
    id: `insight_ops_sla_breach_${safeKey(incident.id)}`,
    sourceKey: `ops:sla-breach:${incident.id}`,
    domain: "ops",
    severity: incident.severity,
    title: `Incident SLA breached: ${incident.title}`,
    plainSummary: `Incident ${incident.id} has been open for ${Math.round((now - incident.openedAt) / 3_600_000)}h. Acknowledge, mitigate, or close it so critical failures do not age silently.`,
    confidence: 0.8,
    evidenceRefs: [evidence("Incident", "db", `reasoner_incidents:${incident.id}`)],
    actionDescriptorId: `acknowledge:incident:${incident.id}`,
    manualPageHref: "/incidents",
    createdAt: now,
  }));
}

export function mapComplianceFindings(signal: ComplianceSignal, now: number): InsightInput[] {
  if (signal.configured && signal.missingControls.length === 0) return [];
  if (!signal.configured) {
    return [{
      id: "insight_security_compliance_module_not_configured",
      sourceKey: "security:compliance-module-not-configured",
      domain: "security",
      severity: "info",
      title: "Compliance controls are not configured",
      plainSummary: "The compliance document/export module exists, but no control matrix or evidence-status module is configured yet. Treat compliance readiness as unknown until controls and evidence freshness are wired.",
      confidence: 0.95,
      evidenceRefs: [evidence("Compliance module", "api", "/api/compliance/summary")],
      actionDescriptorId: null,
      manualPageHref: "/compliance",
      createdAt: now,
    }];
  }
  return [{
    id: "insight_security_compliance_gaps",
    sourceKey: "security:compliance-gaps",
    domain: "security",
    severity: "medium",
    title: "Compliance controls have gaps",
    plainSummary: `${signal.missingControls.length} compliance control(s) are missing evidence or status. Review the compliance page and attach current evidence.`,
    confidence: 0.8,
    evidenceRefs: [evidence("Compliance controls", "db", "compliance_controls")],
    actionDescriptorId: null,
    manualPageHref: "/compliance",
    createdAt: now,
  }];
}

export function mapSecurityPostureFindings(signal: SecurityPostureSignal | null, now: number): InsightInput[] {
  if (!signal) return [];
  const regressed = signal.previousScore !== null && signal.previousScore - signal.score >= 10;
  if (signal.score >= 70 && !regressed) return [];
  return [{
    id: "insight_security_posture_regression",
    sourceKey: "security:posture-regression",
    domain: "security",
    severity: signal.score < 50 ? "high" : "medium",
    title: regressed ? "Security trust score regressed" : "Security trust score is low",
    plainSummary: regressed
      ? `Security trust score dropped from ${signal.previousScore} to ${signal.score}. Review the trust score drivers and remediate the highest-impact failed checks.`
      : `Security trust score is ${signal.score}/100. Review the failed trust checks and remediate the highest-impact items first.`,
    confidence: 0.8,
    evidenceRefs: [evidence("Security trust score", "api", "/api/security/trust-score")],
    actionDescriptorId: null,
    manualPageHref: "/security",
    createdAt: now,
  }];
}

function add(results: Insight[], input: InsightInput, emittedSourceKeys: string[]): void {
  const row = upsertInsight(input);
  if (row) {
    results.push(row);
    if (input.sourceKey) emittedSourceKeys.push(input.sourceKey);
  }
}

export function runGovernanceScan(): ScanResult {
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  if (!getDashboardDb()) return { scannedAt, findings, resolvedCount: 0 };

  const descriptors: InsightInput[] = [];
  const collect = (fn: () => InsightInput[]): void => {
    try {
      descriptors.push(...fn());
    } catch (err) {
      console.error("[governance-scan] detector failed", err instanceof Error ? err.message : err);
    }
  };

  collect(() => mapConfigSelfCheckFindings((governanceProbeOverrides?.configSelfChecks ?? readConfigSelfChecks)(), scannedAt));
  collect(() => mapSuspiciousActivityFindings((governanceProbeOverrides?.suspiciousActivity ?? readSuspiciousActivitySignal)(), scannedAt));
  collect(() => mapSlaBreachFindings((governanceProbeOverrides?.slaIncidents ?? (() => readSlaIncidents(scannedAt)))(), scannedAt));
  collect(() => mapComplianceFindings((governanceProbeOverrides?.complianceSignal ?? readComplianceSignal)(), scannedAt));
  collect(() => mapSecurityPostureFindings((governanceProbeOverrides?.securityPosture ?? readSecurityPostureSignal)(), scannedAt));
  collect(() => (governanceProbeOverrides?.staleFeatureFlags ?? readStaleFeatureFlagFindings)());

  const emittedSourceKeys: string[] = [];
  for (const descriptor of descriptors) add(findings, descriptor, emittedSourceKeys);

  const resolved = [
    ...resolveStaleInsights("security:config-selfcheck:", emittedSourceKeys, "The governance scanner confirmed this configuration self-check is now passing."),
    ...resolveStaleInsights("security:suspicious-activity", emittedSourceKeys, "The governance scanner no longer sees this suspicious activity pattern."),
    ...resolveStaleInsights("security:posture-regression", emittedSourceKeys, "The governance scanner confirmed security posture recovered."),
    ...resolveStaleInsights("security:compliance-", emittedSourceKeys, "The governance scanner confirmed this compliance gap cleared."),
    ...resolveStaleInsights("ops:sla-breach:", emittedSourceKeys, "The governance scanner confirmed this SLA breach is no longer open."),
    ...resolveStaleInsights("ops:stale-feature-flag:", emittedSourceKeys, "The feature flag is no longer stale or has been removed."),
  ];
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: "The governance scanner confirmed this condition cleared.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }

  return { scannedAt, findings, resolvedCount: resolved.length };
}
