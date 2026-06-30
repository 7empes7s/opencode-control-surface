import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import { getInsight } from "../store.ts";
import {
  mapComplianceFindings,
  mapConfigSelfCheckFindings,
  mapSecurityPostureFindings,
  mapSlaBreachFindings,
  mapSuspiciousActivityFindings,
  readSlaIncidents,
  readStaleFeatureFlagFindings,
  runGovernanceScan,
  setGovernanceProbeOverridesForTest,
  type ConfigSelfCheck,
} from "./governance.ts";

const NOW = 1_700_000_000_000;

function failingConfigCheck(overrides: Partial<ConfigSelfCheck> = {}): ConfigSelfCheck {
  return {
    id: "operator-token",
    ok: false,
    severity: "critical",
    title: "Operator token is not configured",
    remediation: "Set OPERATOR_TOKEN before enabling mutations.",
    evidenceKind: "api",
    evidenceRef: "OPERATOR_TOKEN presence only",
    manualPageHref: "/install",
    ...overrides,
  };
}

describe("governance scanner: pure mapping", () => {
  test("config self-check gaps emit security findings without secret values", () => {
    const out = mapConfigSelfCheckFindings([failingConfigCheck()], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].sourceKey).toBe("security:config-selfcheck:operator-token");
    expect(out[0].severity).toBe("critical");
    expect(out[0].manualPageHref).toBe("/install");
    expect(JSON.stringify(out[0].evidenceRefs)).not.toContain("test-token");
  });

  test("suspicious activity requires a bounded burst", () => {
    expect(mapSuspiciousActivityFindings({ failedMutations: 4, unknownActors: 0, windowMinutes: 60 }, NOW)).toHaveLength(0);
    const out = mapSuspiciousActivityFindings({ failedMutations: 6, unknownActors: 1, windowMinutes: 60 }, NOW);
    expect(out[0].sourceKey).toBe("security:suspicious-activity");
    expect(out[0].manualPageHref).toBe("/audit");
  });

  test("SLA breach warning maps open aged incidents to ops findings", () => {
    const out = mapSlaBreachFindings([{ id: "inc_1", title: "Critical failure", openedAt: NOW - 5 * 60 * 60 * 1000, severity: "high" }], NOW);
    expect(out[0].sourceKey).toBe("ops:sla-breach:inc_1");
    expect(out[0].manualPageHref).toBe("/incidents");
    expect(out[0].actionDescriptorId).toBe("acknowledge:incident:inc_1");
  });

  test("compliance emits honest not-configured finding when controls are absent", () => {
    const out = mapComplianceFindings({ configured: false, missingControls: ["control matrix not configured"] }, NOW);
    expect(out[0].sourceKey).toBe("security:compliance-module-not-configured");
    expect(out[0].severity).toBe("info");
    expect(out[0].manualPageHref).toBe("/compliance");
  });

  test("low or regressed posture emits a trust-score finding", () => {
    const low = mapSecurityPostureFindings({ score: 45, previousScore: null }, NOW)[0];
    expect(low.sourceKey).toBe("security:posture-regression");
    expect(low.severity).toBe("high");

    const regressed = mapSecurityPostureFindings({ score: 75, previousScore: 90 }, NOW)[0];
    expect(regressed.title).toContain("regressed");
  });
});

describe("governance scanner: runGovernanceScan integration", () => {
  let tempDir: string;
  let prevDb: string | undefined;
  let prevDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "governance-scanner-test-"));
    prevDb = process.env.DASHBOARD_DB;
    prevDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    setGovernanceProbeOverridesForTest(null);
    closeDashboardDb();
    if (prevDb === undefined) delete process.env.DASHBOARD_DB; else process.env.DASHBOARD_DB = prevDb;
    if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH; else process.env.DASHBOARD_DB_PATH = prevDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("mocked governance probes create and stale-resolve findings", () => {
    setGovernanceProbeOverridesForTest({
      configSelfChecks: () => [failingConfigCheck()],
      suspiciousActivity: () => ({ failedMutations: 7, unknownActors: 0, windowMinutes: 60 }),
      slaIncidents: () => [{ id: "inc_1", title: "Critical failure", openedAt: Date.now() - 5 * 60 * 60 * 1000, severity: "high" }],
      complianceSignal: () => ({ configured: false, missingControls: ["control matrix not configured"] }),
      securityPosture: () => ({ score: 55, previousScore: null }),
      staleFeatureFlags: () => readStaleFeatureFlagFindings(),
    });

    const triggered = runGovernanceScan();
    expect(triggered.findings.some((f) => f.sourceKey === "security:config-selfcheck:operator-token")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "security:suspicious-activity")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "ops:sla-breach:inc_1")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "security:compliance-module-not-configured")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "security:posture-regression")).toBe(true);

    setGovernanceProbeOverridesForTest({
      configSelfChecks: () => [{ ...failingConfigCheck(), ok: true }],
      suspiciousActivity: () => ({ failedMutations: 0, unknownActors: 0, windowMinutes: 60 }),
      slaIncidents: () => [],
      complianceSignal: () => ({ configured: true, missingControls: [] }),
      securityPosture: () => ({ score: 95, previousScore: null }),
      staleFeatureFlags: () => [],
    });

    const cleared = runGovernanceScan();
    expect(cleared.resolvedCount).toBeGreaterThanOrEqual(5);
    expect(getInsight("insight_security_config_selfcheck_operator-token")?.status).toBe("resolved");
    expect(getInsight("insight_security_suspicious_activity")?.status).toBe("resolved");
    expect(getInsight("insight_ops_sla_breach_inc_1")?.status).toBe("resolved");
    expect(getInsight("insight_security_compliance_module_not_configured")?.status).toBe("resolved");
    expect(getInsight("insight_security_posture_regression")?.status).toBe("resolved");
  });

  test("readSlaIncidents ignores abandoned incidents but still flags recently-active aged ones", () => {
    const db = getDashboardDb()!;
    const insertIncident = (row: {
      id: string;
      clusterKey: string;
      firstSeen: number;
      lastSeen: number;
    }) => {
      db.query(`
        INSERT OR REPLACE INTO reasoner_incidents
          (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count, representative_pass_id, representative_diagnosis_id, status)
        VALUES (?, ?, 'test_failure', ?, ?, ?, 1, 'pass_x', 'diag_x', 'open')
      `).run(row.id, row.clusterKey, `Incident ${row.id}`, row.firstSeen, row.lastSeen);
    };

    // Long-open (well past the 4h SLA threshold) but last active 1 day ago — a live breach.
    insertIncident({
      id: "inc_recent_aged",
      clusterKey: "cluster_recent_aged",
      firstSeen: NOW - 30 * 24 * 60 * 60 * 1000,
      lastSeen: NOW - 1 * 24 * 60 * 60 * 1000,
    });
    // Open for 3 years but last active 3 years ago — abandoned data, not a current breach.
    insertIncident({
      id: "inc_3yr_stale",
      clusterKey: "cluster_3yr_stale",
      firstSeen: NOW - 3 * 365 * 24 * 60 * 60 * 1000,
      lastSeen: NOW - 3 * 365 * 24 * 60 * 60 * 1000,
    });

    const incidents = readSlaIncidents(NOW);
    expect(incidents.some((incident) => incident.id === "inc_recent_aged")).toBe(true);
    expect(incidents.some((incident) => incident.id === "inc_3yr_stale")).toBe(false);
  });
});
