import { aggregateInsights } from "./aggregate.ts";
import { computeAdminHealthScore, writeHealthSample } from "./health.ts";
import { runSecurityScan } from "./scanners/security.ts";
import { runRegistryScan } from "./scanners/registry.ts";
import { runBudgetScan } from "./scanners/budget.ts";
import { runAnomalyScan } from "./scanners/anomaly.ts";
import { runSentinelIncidentScan } from "./scanners/sentinelIncidents.ts";
import { runOpsScan } from "./scanners/ops.ts";
import { runDiscoveryScan } from "./scanners/discovery.ts";
import { runEdgeScan } from "./scanners/edge.ts";
import { runGovernanceScan } from "./scanners/governance.ts";
import { runBuildScan } from "./scanners/build.ts";
import { listInsights } from "./store.ts";
import { enrichOpenInsights } from "./ai.ts";
import { autoApplySafeInsights } from "./autoapply.ts";
import { notifyCriticalFindings } from "../notifications/notifier.ts";
import { startModelEvalScheduler, stopModelEvalScheduler } from "../evals/modelEval.ts";
import { generateOperatorDigest, shouldSendWeeklyDigest } from "../reporting/digest.ts";

let insightsTimer: ReturnType<typeof setInterval> | null = null;
let digestTimer: ReturnType<typeof setInterval> | null = null;

async function maybeRunWeeklyDigest(): Promise<void> {
  try {
    if (!shouldSendWeeklyDigest(false)) return;
    await generateOperatorDigest();
  } catch (err) {
    console.error("[insights] weekly digest failed", err instanceof Error ? err.message : err);
  }
}

export async function runInsightsScanOnce(): Promise<{
  aggregated: number;
  securityFindings: number;
  registryFindings: number;
  budgetFindings: number;
  anomalies: number;
  sentinelIncidents: number;
  opsFindings: number;
  discoveryFindings: number;
  edgeFindings: number;
  governanceFindings: number;
  buildFindings: number;
  notifications: { sent: number; deduped: number; scanned: number; skipped: number };
}> {
  const aggregated = aggregateInsights().createdOrUpdated;
  const securityFindings = runSecurityScan().findings.length;
  const registryFindings = runRegistryScan().findings.length;
  const budgetFindings = runBudgetScan().findings.length;
  const anomalies = runAnomalyScan().anomalies;
  let sentinelIncidents = 0;
  try {
    sentinelIncidents = runSentinelIncidentScan().createdOrUpdated;
  } catch (error) {
    console.error("[insights] sentinel incident scan failed", error);
  }
  let opsFindings = 0;
  try {
    opsFindings = runOpsScan().findings.length;
  } catch (error) {
    console.error("[insights] ops scan failed", error);
  }
  let discoveryFindings = 0;
  try {
    discoveryFindings = runDiscoveryScan().findings.length;
  } catch (error) {
    console.error("[insights] discovery scan failed", error);
  }
  let edgeFindings = 0;
  try {
    edgeFindings = (await runEdgeScan()).findings.length;
  } catch (error) {
    console.error("[insights] edge scan failed", error);
  }
  let governanceFindings = 0;
  try {
    governanceFindings = runGovernanceScan().findings.length;
  } catch (error) {
    console.error("[insights] governance scan failed", error);
  }
  let buildFindings = 0;
  try {
    buildFindings = runBuildScan().findings.length;
  } catch (error) {
    console.error("[insights] build scan failed", error);
  }

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

  return { aggregated, securityFindings, registryFindings, budgetFindings, anomalies, sentinelIncidents, opsFindings, discoveryFindings, edgeFindings, governanceFindings, buildFindings, notifications };
}

export function startInsightsScanScheduler(intervalMs = 15 * 60 * 1000): void {
  try {
    runInsightsScanOnce();
  } catch (error) {
    console.error("[insights] initial scan failed", error);
  }

  if (insightsTimer) clearInterval(insightsTimer);
  insightsTimer = setInterval(() => {
    try {
      runInsightsScanOnce();
    } catch (error) {
      console.error("[insights] scheduled scan failed", error);
    }
  }, intervalMs);
  insightsTimer.unref?.();

  if (digestTimer) clearInterval(digestTimer);
  maybeRunWeeklyDigest();
  digestTimer = setInterval(() => {
    void maybeRunWeeklyDigest();
  }, 60 * 60 * 1000);
  digestTimer.unref?.();
}

export function stopInsightsScanScheduler(): void {
  if (insightsTimer) {
    clearInterval(insightsTimer);
    insightsTimer = null;
  }
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
}
