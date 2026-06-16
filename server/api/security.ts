import { checkToken } from "./actions.ts";
import { requireInsightPermission } from "./insights.ts";
import { runSecurityScan } from "../insights/scanners/security.ts";
import { listInsights } from "../insights/store.ts";
import { ok } from "./types.ts";
import type { Insight } from "../insights/types.ts";
import { computeTrustScore, persistDailyTrustSample, getTrustScoreHistory } from "../security/score.ts";

const SECURITY_CHECKS_COUNT = 5;

export async function trustScoreHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.view");
  if (roleErr) return roleErr;

  const score = computeTrustScore();
  persistDailyTrustSample();

  return Response.json(
    ok({
      ...score,
      history: getTrustScoreHistory(30),
    })
  );
}

export async function securityPostureHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.view");
  if (roleErr) return roleErr;

  const scanResult = runSecurityScan();
  const allInsights = listInsights("all");
  const securityInsights = allInsights.filter((insight) => insight.domain === "security");

  const openFindings = securityInsights.filter((insight) => insight.status === "open");
  const resolvedFindings = securityInsights.filter(
    (insight) => insight.status === "resolved" || insight.status === "applied" || insight.status === "dismissed"
  );

  const hasCriticalOrHigh = openFindings.some(
    (insight) => insight.severity === "critical" || insight.severity === "high"
  );
  const hasMediumOrLow = openFindings.some(
    (insight) => insight.severity === "medium" || insight.severity === "low"
  );

  let posture: "good" | "needs-attention" | "at-risk";
  if (hasCriticalOrHigh) posture = "at-risk";
  else if (hasMediumOrLow) posture = "needs-attention";
  else posture = "good";

  const sortedFindings = [...securityInsights].sort((a, b) => {
    const statusOrder = { open: 0, applied: 1, dismissed: 2, resolved: 3 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;

    const severityRank: Record<Insight["severity"], number> = {
      critical: 5,
      high: 4,
      medium: 3,
      low: 2,
      info: 1,
    };
    return severityRank[b.severity] - severityRank[a.severity] || b.createdAt - a.createdAt;
  });

  return Response.json(
    ok({
      posture,
      openCount: openFindings.length,
      resolvedCount: resolvedFindings.length,
      lastScanAt: scanResult.scannedAt,
      checksRun: SECURITY_CHECKS_COUNT,
      findings: sortedFindings,
    })
  );
}