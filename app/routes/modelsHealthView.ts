import type {
  CredentialHealthStatus,
  CredentialHealthSummary,
  HealthBucket,
  HealthState,
} from "../../server/api/types";

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
  credentialHealth?: CredentialHealthSummary | null;
  credentialBlocked?: boolean | null;
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

export interface CredentialHealthPresentation {
  envName: string;
  status: CredentialHealthStatus;
  statusLabel: string;
  statusColor: HealthBadgeColor;
  freshnessLabel: "fresh" | "stale";
  freshnessColor: "green" | "gray";
  checkedAge: string;
  gatedModelCount: number;
  gatedModels: string[];
  guidance: string;
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
    model.credentialHealth?.envName,
    model.credentialHealth?.status,
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

export function credentialStatusGuidance(status: CredentialHealthStatus): string {
  switch (status) {
    case "valid": return "Credential check passed; no action needed.";
    case "missing": return "Configure this provider credential before expecting gated models to serve.";
    case "invalid": return "Rotate the credential; the provider rejected it.";
    case "expired": return "Rotate the expired credential.";
    case "revoked": return "Issue a replacement credential; this one was revoked.";
    case "quota": return "Restore provider quota or billing capacity.";
    case "rate_limited": return "Wait and back off before checking again.";
    case "unknown": return "Investigate provider access; the credential check was inconclusive.";
  }
}

function credentialStatusColor(status: CredentialHealthStatus): HealthBadgeColor {
  if (status === "valid") return "green";
  if (status === "invalid" || status === "expired" || status === "revoked") return "red";
  if (status === "missing" || status === "quota" || status === "rate_limited") return "amber";
  return "gray";
}

function formatCredentialAge(checkedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Fixed-field projection used by the UI; raw artifact fields have no render path. */
export function credentialHealthView(
  credential: CredentialHealthSummary,
  now = Date.now(),
): CredentialHealthPresentation {
  return {
    envName: credential.envName,
    status: credential.status,
    statusLabel: credential.status.replace("_", " "),
    statusColor: credentialStatusColor(credential.status),
    freshnessLabel: credential.fresh ? "fresh" : "stale",
    freshnessColor: credential.fresh ? "green" : "gray",
    checkedAge: formatCredentialAge(credential.checkedAt, now),
    gatedModelCount: credential.gatesModels.length,
    gatedModels: [...credential.gatesModels],
    guidance: credentialStatusGuidance(credential.status),
  };
}
