import type { HealthBucket, HealthState } from "../../server/api/types";

export type ModelsSortKey =
  | "logicalName"
  | "healthState"
  | "qualityStatus"
  | "provider"
  | "contextWindow"
  | "latency"
  | "recentFailures";

export interface ModelHealthRow {
  logicalName: string;
  provider?: string | null;
  providerType?: string | null;
  qualityStatus?: string | null;
  healthState?: HealthState | null;
  healthBucket?: HealthBucket | null;
  healthReason?: string | null;
  contextWindow?: number | null;
  latency?: number | null;
  recentFailures?: number | null;
}

export type HealthBadgeColor = "green" | "amber" | "blue" | "orange" | "red" | "maroon" | "gray";

export interface HealthBadgePresentation {
  label: HealthState;
  color: HealthBadgeColor;
}

export interface HealthRecoveryCallout {
  lead: string;
  detail: string;
}

export interface ModelHealthPresentation {
  state: HealthState;
  bucket: HealthBucket;
  reason: string;
  badge: HealthBadgePresentation;
  recoveryCallout: HealthRecoveryCallout | null;
}

export const HEALTH_STATE_BADGES: Readonly<Record<HealthState, HealthBadgePresentation>> = {
  live: { label: "live", color: "green" },
  limited: { label: "limited", color: "amber" },
  slow: { label: "slow", color: "blue" },
  degraded: { label: "degraded", color: "orange" },
  dead: { label: "dead", color: "red" },
  hang: { label: "hang", color: "maroon" },
  unknown: { label: "unknown", color: "gray" },
};

export const HEALTH_STATE_SORT_RANK: Readonly<Record<HealthState, number>> = {
  live: 0,
  limited: 1,
  slow: 2,
  degraded: 3,
  dead: 4,
  hang: 5,
  unknown: 6,
};

export const HEALTH_GROUPS: ReadonlyArray<{
  bucket: HealthBucket;
  label: string;
  states: readonly HealthState[];
  statesLabel: string;
}> = [
  {
    bucket: "healthy",
    label: "Healthy",
    states: ["live", "limited", "slow"],
    statesLabel: "live · limited · slow",
  },
  {
    bucket: "unhealthy",
    label: "Needs attention",
    states: ["degraded", "dead", "hang"],
    statesLabel: "degraded · dead · hang",
  },
  {
    bucket: "unknown",
    label: "Unobserved",
    states: ["unknown"],
    statesLabel: "insufficient evidence",
  },
];

const UNKNOWN_REASON = "health evidence is unavailable for this row";

const DEGRADED_RECOVERY_CALLOUT: HealthRecoveryCallout = {
  lead: "Proven route needs recovery:",
  detail: "fix its credential or quota; do not drop its earned history.",
};

export function modelHealthState(model: ModelHealthRow): HealthState {
  return model.healthState ?? "unknown";
}

export function modelHealthBucket(model: ModelHealthRow): HealthBucket {
  return model.healthBucket ?? "unknown";
}

export function modelHealthReason(model: ModelHealthRow): string {
  return model.healthReason?.trim() || UNKNOWN_REASON;
}

export function healthStateBadge(state: HealthState): HealthBadgePresentation {
  return HEALTH_STATE_BADGES[state];
}

export function modelHealthView(model: ModelHealthRow): ModelHealthPresentation {
  const state = modelHealthState(model);
  return {
    state,
    bucket: modelHealthBucket(model),
    reason: modelHealthReason(model),
    badge: healthStateBadge(state),
    recoveryCallout: state === "degraded" ? DEGRADED_RECOVERY_CALLOUT : null,
  };
}

export function modelHealthFilterText(model: ModelHealthRow): string {
  return [
    model.logicalName,
    model.provider,
    model.providerType,
    model.qualityStatus,
    modelHealthState(model),
    modelHealthBucket(model),
    modelHealthReason(model),
  ].join(" ");
}

export function modelHealthSortValue(model: ModelHealthRow, key: ModelsSortKey): string | number {
  switch (key) {
    case "logicalName": return model.logicalName;
    case "healthState": return HEALTH_STATE_SORT_RANK[modelHealthState(model)];
    case "qualityStatus": return model.qualityStatus ?? "";
    case "provider": return model.provider ?? "";
    case "contextWindow": return model.contextWindow ?? 0;
    case "latency": return model.latency ?? Infinity;
    case "recentFailures": return model.recentFailures ?? 0;
  }
}

export function groupVisibleModels<T extends ModelHealthRow>(rows: readonly T[]) {
  return HEALTH_GROUPS.map((group) => ({
    ...group,
    rows: rows.filter((model) => modelHealthBucket(model) === group.bucket),
  })).filter((group) => group.rows.length > 0);
}

export function healthSummaryItems(summary: Partial<Record<HealthBucket, number>>) {
  return [
    { bucket: "healthy" as const, label: "healthy", color: "green" as const, count: summary.healthy ?? 0 },
    { bucket: "unhealthy" as const, label: "needs attention", color: "red" as const, count: summary.unhealthy ?? 0 },
    { bucket: "unknown" as const, label: "unobserved", color: "gray" as const, count: summary.unknown ?? 0 },
  ];
}
