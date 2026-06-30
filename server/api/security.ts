import { checkToken } from "./actions.ts";
import { requireInsightPermission } from "./insights.ts";
import { runSecurityScan } from "../insights/scanners/security.ts";
import { listInsights } from "../insights/store.ts";
import { ok } from "./types.ts";
import type { Insight } from "../insights/types.ts";
import { computeTrustScore, persistDailyTrustSample, getTrustScoreHistory } from "../security/score.ts";
import { listSecrets } from "../governance/secrets.ts";

const SECURITY_CHECKS_COUNT = 5;
const ROTATION_RECOMMENDED_AFTER_DAYS = 90;

type SecuritySecretExposureFinding = {
  id: string;
  sourceKey: string;
  title: string;
  severity: Insight["severity"];
  status: Insight["status"];
  href: string;
};

type SecuritySecretLifecycleEntry = {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  ageDays: number;
  rotationRecommended: boolean;
  exposureFindingCount: number;
  exposureFindings: SecuritySecretExposureFinding[];
};

function ageDays(updatedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000)));
}

function exposureLink(sourceKey: string): string {
  return `/insights?focus=${encodeURIComponent(sourceKey)}`;
}

function toExposureFinding(insight: Insight): SecuritySecretExposureFinding | null {
  if (!insight.sourceKey) return null;
  return {
    id: insight.id,
    sourceKey: insight.sourceKey,
    title: insight.title,
    severity: insight.severity,
    status: insight.status,
    href: exposureLink(insight.sourceKey),
  };
}

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

export async function securitySecretsHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.view");
  if (roleErr) return roleErr;

  runSecurityScan();

  const now = Date.now();
  const allInsights = listInsights("all");
  const exposureInsights = allInsights
    .filter((insight) => insight.domain === "security" && insight.status === "open")
    .filter((insight) =>
      insight.sourceKey?.startsWith("security:weak_secret:") ||
      insight.sourceKey === "security:audit_secret_leak_signal"
    );
  const globalExposureFindings = exposureInsights
    .filter((insight) => insight.sourceKey === "security:audit_secret_leak_signal")
    .map(toExposureFinding)
    .filter((finding): finding is SecuritySecretExposureFinding => Boolean(finding));

  const secrets: SecuritySecretLifecycleEntry[] = listSecrets().map((secret) => {
    const secretAgeDays = ageDays(secret.updatedAt, now);
    const weakSecretFindings = exposureInsights
      .filter((insight) => insight.sourceKey === `security:weak_secret:${secret.id}`)
      .map(toExposureFinding)
      .filter((finding): finding is SecuritySecretExposureFinding => Boolean(finding));
    const exposureFindings = [...weakSecretFindings, ...globalExposureFindings];

    return {
      id: secret.id,
      name: secret.name,
      description: secret.description,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      ageDays: secretAgeDays,
      rotationRecommended: secretAgeDays >= ROTATION_RECOMMENDED_AFTER_DAYS,
      exposureFindingCount: exposureFindings.length,
      exposureFindings,
    };
  });

  return Response.json(
    ok({
      rotationRecommendedAfterDays: ROTATION_RECOMMENDED_AFTER_DAYS,
      secrets,
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
