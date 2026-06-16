import { aggregateInsights } from "./aggregate.ts";
import { runSecurityScan } from "./scanners/security.ts";
import { runRegistryScan } from "./scanners/registry.ts";
import { runBudgetScan } from "./scanners/budget.ts";
import { runAnomalyScan } from "./scanners/anomaly.ts";
import { runSentinelIncidentScan } from "./scanners/sentinelIncidents.ts";
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

  return { aggregated, securityFindings, registryFindings, budgetFindings, anomalies, sentinelIncidents, notifications };
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
