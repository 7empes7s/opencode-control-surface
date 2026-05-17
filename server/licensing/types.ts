export type LicenseTier = "solo" | "team" | "enterprise" | "cloud";

export type LicenseFeature =
  | "sso"
  | "audit-export"
  | "data-residency"
  | "4-eyes"
  | "telemetry"
  | "cloud-tier";

export interface LicenseKey {
  tier: LicenseTier;
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  features: LicenseFeature[];
  signature: string;
}

export interface LicenseStatus {
  tier: LicenseTier;
  features: LicenseFeature[];
  tenantId: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  licensed: boolean;
}

export const TIER_FEATURES: Record<LicenseTier, LicenseFeature[]> = {
  solo: [],
  team: ["sso", "audit-export", "4-eyes"],
  enterprise: ["sso", "audit-export", "data-residency", "4-eyes", "telemetry"],
  cloud: ["sso", "audit-export", "data-residency", "4-eyes", "telemetry", "cloud-tier"],
};