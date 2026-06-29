import type { EvidenceRef } from "../../api/types.ts";
import {
  discoverAiAssets,
  getAssetDisplayName,
  reconcileDiscoveredAssets,
  type DiscoveredAsset,
} from "../../discovery/reconcile.ts";
import { getDashboardDb } from "../../db/dashboard.ts";
import { writeActionAudit } from "../../db/writer.ts";
import type { Insight, InsightInput, InsightSeverity } from "../types.ts";
import { resolveStaleInsights, upsertInsight } from "../store.ts";

type ScanResult = {
  scannedAt: number;
  assetsSeen: number;
  findings: Insight[];
  resolvedCount: number;
};

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref, redacted: true };
}

function isPublicListener(asset: DiscoveredAsset): boolean {
  return asset.kind === "port" && asset.fingerprint.exposure === "public-listener";
}

function isCredential(asset: DiscoveredAsset): boolean {
  return asset.kind === "credential";
}

function severityForAsset(asset: DiscoveredAsset): InsightSeverity {
  if (isPublicListener(asset)) return "critical";
  if (asset.kind === "backend" || asset.kind === "container") return "high";
  if (isCredential(asset)) return "medium";
  return "medium";
}

function sourceKeyForAsset(asset: DiscoveredAsset): string {
  if (isPublicListener(asset)) return `discovery:exposed-model-endpoint:${asset.id}`;
  if (isCredential(asset)) return `discovery:shadow-api-key:${asset.id}`;
  return `discovery:unregistered-ai-system:${asset.id}`;
}

export function mapDiscoveryAssetToInsight(asset: DiscoveredAsset, now: number): InsightInput | null {
  if (asset.status !== "unregistered") return null;

  const displayName = getAssetDisplayName(asset);
  const sourceKey = sourceKeyForAsset(asset);
  const kindLabel = asset.kind === "cli" ? "CLI" : asset.kind;
  const title = isPublicListener(asset)
    ? "An unregistered model endpoint is publicly listening"
    : isCredential(asset)
      ? "An AI provider key exists outside the governed inventory"
      : "An unregistered AI system was discovered";

  return {
    id: `insight_${sourceKey.replace(/[^a-zA-Z0-9]+/g, "_")}`,
    sourceKey,
    domain: "security",
    severity: severityForAsset(asset),
    title,
    plainSummary: `Discovery found ${kindLabel} "${displayName}" from ${asset.sourceProbe}, but it is not registered in the managed AI inventory. Register it with an owner and criticality, or ignore it with a reason if it is expected.`,
    confidence: isCredential(asset) ? 0.75 : 0.85,
    evidenceRefs: [
      evidence("Discovery asset", "api", `/api/insights?focus=${encodeURIComponent(sourceKey)}`),
      evidence(asset.sourceProbe, asset.kind === "process" ? "command" : "api", asset.signature),
    ],
    actionDescriptorId: null,
    manualPageHref: "/insights",
    createdAt: now,
  };
}

function add(results: Insight[], input: InsightInput, emittedSourceKeys: string[]): void {
  const row = upsertInsight(input);
  if (row) {
    results.push(row);
    if (input.sourceKey) emittedSourceKeys.push(input.sourceKey);
  }
}

export function runDiscoveryScan(): ScanResult {
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  const emittedSourceKeys: string[] = [];
  if (!getDashboardDb()) return { scannedAt, assetsSeen: 0, findings, resolvedCount: 0 };

  const assets = reconcileDiscoveredAssets(discoverAiAssets(), scannedAt);
  for (const asset of assets) {
    const descriptor = mapDiscoveryAssetToInsight(asset, scannedAt);
    if (descriptor) add(findings, descriptor, emittedSourceKeys);
  }

  const resolved = resolveStaleInsights(
    "discovery:",
    emittedSourceKeys,
    "The discovery scanner no longer sees this unregistered AI asset.",
  );
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: "The discovery scanner no longer sees this unregistered AI asset.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }

  return { scannedAt, assetsSeen: assets.length, findings, resolvedCount: resolved.length };
}
