import { aggregateInsights } from "./aggregate.ts";
import { computeAdminHealthScore, writeHealthSample } from "./health.ts";
import { runSecurityScan } from "./scanners/security.ts";
import { runRegistryScan } from "./scanners/registry.ts";
import { runBudgetScan } from "./scanners/budget.ts";
import { runAnomalyScan } from "./scanners/anomaly.ts";
import { runSentinelIncidentScan } from "./scanners/sentinelIncidents.ts";
import { autoCloseRecoveredIncidents, autoResolveStaleIncidents, autoUnmuteExpiredIncidents, detectRecurringIncidents } from "../reasoner/lifecycle.ts";
import { runOpsScan } from "./scanners/ops.ts";
import { runSlaScan } from "./scanners/sla.ts";
import { runDiscoveryScan } from "./scanners/discovery.ts";
import { runEdgeScan } from "./scanners/edge.ts";
import { runGovernanceScan } from "./scanners/governance.ts";
import { runBuildScan } from "./scanners/build.ts";
import { runModelRoutesScan } from "./scanners/modelRoutes.ts";
import { listInsights } from "./store.ts";
import { enrichOpenInsights } from "./ai.ts";
import { autoApplySafeInsights } from "./autoapply.ts";
import { notifyCriticalFindings } from "../notifications/notifier.ts";
import { startModelEvalScheduler, stopModelEvalScheduler } from "../evals/modelEval.ts";
import { maybeGenerateDailyDigest } from "../reporting/digest.ts";
import { recordControlsTick, type ControlTickSummary } from "../compliance/controls.ts";
import type { InsightSeverity } from "./types.ts";

let insightsTimer: ReturnType<typeof setInterval> | null = null;

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function maxFindingSeverity(findings: Array<{ severity: InsightSeverity }>): InsightSeverity | null {
  let maxSeverity: InsightSeverity | null = null;
  for (const finding of findings) {
    if (!maxSeverity || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[maxSeverity]) {
      maxSeverity = finding.severity;
    }
  }
  return maxSeverity;
}

async function runDailyDigestGate(firstBootTick = false): Promise<void> {
  try {
    await maybeGenerateDailyDigest({ firstBootTick });
  } catch (err) {
    console.error("[insights] daily digest failed", err instanceof Error ? err.message : err);
  }
}

export async function runInsightsScanOnce(opts: { firstBootTick?: boolean; digestGate?: boolean } = {}): Promise<{
  aggregated: number;
  securityFindings: number;
  registryFindings: number;
  budgetFindings: number;
  anomalies: number;
  sentinelIncidents: number;
  incidentsAutoResolved: number;
  opsFindings: number;
  slaFindings: number;
  discoveryFindings: number;
  edgeFindings: number;
  governanceFindings: number;
  buildFindings: number;
  modelRouteFindings: number;
  notifications: { sent: number; deduped: number; scanned: number; skipped: number };
}> {
  const aggregated = aggregateInsights().createdOrUpdated;
  const controlTick = {} as ControlTickSummary;
  let securityFindings = 0;
  try {
    const securityResult = runSecurityScan();
    securityFindings = securityResult.findings.length;
    controlTick.security = {
      ran: true,
      error: false,
      findingsCount: securityFindings,
      maxSeverity: maxFindingSeverity(securityResult.findings),
    };
  } catch (error) {
    controlTick.security = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] security scan failed", error);
  }
  let registryFindings = 0;
  try {
    const registryResult = runRegistryScan();
    registryFindings = registryResult.findings.length;
    controlTick.registry = {
      ran: true,
      error: false,
      findingsCount: registryFindings,
      maxSeverity: maxFindingSeverity(registryResult.findings),
    };
  } catch (error) {
    controlTick.registry = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] registry scan failed", error);
  }
  let budgetFindings = 0;
  try {
    const budgetResult = runBudgetScan();
    budgetFindings = budgetResult.findings.length;
    controlTick.budget = {
      ran: true,
      error: false,
      findingsCount: budgetFindings,
      maxSeverity: maxFindingSeverity(budgetResult.findings),
    };
  } catch (error) {
    controlTick.budget = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] budget scan failed", error);
  }
  let anomalies = 0;
  try {
    const anomalyResult = runAnomalyScan();
    anomalies = anomalyResult.anomalies;
    controlTick.anomaly = { ran: true, error: false, findingsCount: anomalies, maxSeverity: null };
  } catch (error) {
    controlTick.anomaly = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] anomaly scan failed", error);
  }
  let sentinelIncidents = 0;
  try {
    const sentinelResult = runSentinelIncidentScan();
    sentinelIncidents = sentinelResult.createdOrUpdated;
    controlTick.sentinelIncidents = {
      ran: true,
      error: false,
      findingsCount: sentinelIncidents,
      maxSeverity: null,
    };
    if (sentinelResult.autoClosed > 0) {
      console.log(`[incidents] auto-closed ${sentinelResult.autoClosed} cleared sentinel incidents`);
    }
  } catch (error) {
    controlTick.sentinelIncidents = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] sentinel incident scan failed", error);
  }
  let incidentsAutoResolved = 0;
  try {
    incidentsAutoResolved = autoResolveStaleIncidents().resolvedIds.length;
    if (incidentsAutoResolved > 0) {
      console.log(`[incidents] auto-resolved ${incidentsAutoResolved} stale incidents`);
    }
  } catch (error) {
    console.error("[insights] incident auto-resolve failed", error);
  }
  try {
    const recovered = autoCloseRecoveredIncidents().closedIds.length;
    if (recovered > 0) {
      console.log(`[incidents] auto-closed ${recovered} incidents whose workflow recovered`);
    }
  } catch (error) {
    console.error("[insights] recovered-incident sweep failed", error);
  }
  try {
    const expiredSnoozes = autoUnmuteExpiredIncidents().unmutedIds.length;
    if (expiredSnoozes > 0) {
      console.log(`[incidents] auto-unmuted ${expiredSnoozes} expired snoozes`);
    }
  } catch (error) {
    console.error("[insights] snooze expiry sweep failed", error);
  }
  try {
    const recurrence = detectRecurringIncidents();
    if (recurrence.flagged > 0) {
      console.log(`[incidents] flagged ${recurrence.flagged} recurring condition(s) as insights`);
    }
  } catch (error) {
    console.error("[insights] recurrence detection failed", error);
  }
  let opsFindings = 0;
  try {
    const opsResult = runOpsScan();
    opsFindings = opsResult.findings.length;
    controlTick.ops = {
      ran: true,
      error: false,
      findingsCount: opsFindings,
      maxSeverity: maxFindingSeverity(opsResult.findings),
    };
  } catch (error) {
    controlTick.ops = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] ops scan failed", error);
  }
  let slaFindings = 0;
  try {
    const slaResult = runSlaScan();
    slaFindings = slaResult.findings.length;
    controlTick.sla = {
      ran: true,
      error: false,
      findingsCount: slaFindings,
      maxSeverity: maxFindingSeverity(slaResult.findings),
    };
  } catch (error) {
    controlTick.sla = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] sla scan failed", error);
  }
  let discoveryFindings = 0;
  try {
    const discoveryResult = runDiscoveryScan();
    discoveryFindings = discoveryResult.findings.length;
    controlTick.discovery = {
      ran: true,
      error: false,
      findingsCount: discoveryFindings,
      maxSeverity: maxFindingSeverity(discoveryResult.findings),
    };
  } catch (error) {
    controlTick.discovery = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] discovery scan failed", error);
  }
  let edgeFindings = 0;
  try {
    const edgeResult = await runEdgeScan();
    edgeFindings = edgeResult.findings.length;
    controlTick.edge = {
      ran: true,
      error: false,
      findingsCount: edgeFindings,
      maxSeverity: maxFindingSeverity(edgeResult.findings),
    };
  } catch (error) {
    controlTick.edge = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] edge scan failed", error);
  }
  let governanceFindings = 0;
  try {
    const governanceResult = runGovernanceScan();
    governanceFindings = governanceResult.findings.length;
    controlTick.governance = {
      ran: true,
      error: false,
      findingsCount: governanceFindings,
      maxSeverity: maxFindingSeverity(governanceResult.findings),
    };
  } catch (error) {
    controlTick.governance = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] governance scan failed", error);
  }
  let buildFindings = 0;
  try {
    const buildResult = runBuildScan();
    buildFindings = buildResult.findings.length;
    controlTick.build = {
      ran: true,
      error: false,
      findingsCount: buildFindings,
      maxSeverity: maxFindingSeverity(buildResult.findings),
    };
  } catch (error) {
    controlTick.build = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] build scan failed", error);
  }
  let modelRouteFindings = 0;
  try {
    const modelRouteResult = runModelRoutesScan();
    modelRouteFindings = modelRouteResult.findings.length;
    controlTick.modelRoutes = {
      ran: true,
      error: false,
      findingsCount: modelRouteFindings,
      maxSeverity: maxFindingSeverity(modelRouteResult.findings),
    };
  } catch (error) {
    controlTick.modelRoutes = { ran: false, error: true, findingsCount: 0, maxSeverity: null };
    console.error("[insights] model-routes scan failed", error);
  }

  recordControlsTick(controlTick);

  let notifications = { sent: 0, deduped: 0, scanned: 0, skipped: 0 };
  try {
    const notifyResult = await notifyCriticalFindings();
    notifications = {
      sent: notifyResult.sent,
      deduped: notifyResult.deduped,
      scanned: notifyResult.scanned,
      skipped: notifyResult.skipped,
    };
  } catch (error) {
    console.error("[insights] notifyCriticalFindings failed", error);
  }

  // Fire-and-forget AI reasoning enrichment for open findings. Never blocks the
  // scan (or finding creation); guarded internally against overlapping runs.
  void enrichOpenInsights(listInsights("open")).catch((err) => {
    console.error("[insights] ai enrichment failed", err instanceof Error ? err.message : err);
  });

  // Fire-and-forget auto-apply of safe (allowlisted, non-customer-facing)
  // remediations. Review-tier findings are untouched and wait for a human Apply.
  void autoApplySafeInsights(listInsights("open")).catch((err) => {
    console.error("[insights] auto-apply failed", err instanceof Error ? err.message : err);
  });

  // Write a health score sample so the trend sparkline has data
  try {
    const hs = computeAdminHealthScore();
    writeHealthSample(hs.score);
  } catch { /* ignore */ }

  if (opts.digestGate) {
    await runDailyDigestGate(!!opts.firstBootTick);
  }

  return { aggregated, securityFindings, registryFindings, budgetFindings, anomalies, sentinelIncidents, incidentsAutoResolved, opsFindings, slaFindings, discoveryFindings, edgeFindings, governanceFindings, buildFindings, modelRouteFindings, notifications };
}

export function startInsightsScanScheduler(intervalMs = 15 * 60 * 1000): void {
  try {
    runInsightsScanOnce({ firstBootTick: true, digestGate: true });
  } catch (error) {
    console.error("[insights] initial scan failed", error);
  }

  if (insightsTimer) clearInterval(insightsTimer);
  insightsTimer = setInterval(() => {
    try {
      runInsightsScanOnce({ digestGate: true });
    } catch (error) {
      console.error("[insights] scheduled scan failed", error);
    }
  }, intervalMs);
  insightsTimer.unref?.();
}

export function stopInsightsScanScheduler(): void {
  if (insightsTimer) {
    clearInterval(insightsTimer);
    insightsTimer = null;
  }
}
