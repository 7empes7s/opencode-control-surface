import * as crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LicenseTier,
  LicenseFeature,
  LicenseKey,
  LicenseStatus,
  TIER_FEATURES,
} from "./types.ts";

const DEFAULT_LICENSE_PATH = resolve(
  process.env.HOME ?? "/root",
  ".builder/license.key"
);
const LICENSE_PATH = process.env.BUILDER_LICENSE_PATH ?? DEFAULT_LICENSE_PATH;

export function verifyLicense(keyPath?: string): LicenseStatus {
  const path = keyPath ?? LICENSE_PATH;

  if (!existsSync(path)) {
    return makeSoloStatus();
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const license = JSON.parse(raw) as LicenseKey;

    if (!license.signature || !license.tier || !license.tenantId) {
      return makeSoloStatus();
    }

    const payload = JSON.stringify({
      tier: license.tier,
      tenantId: license.tenantId,
      issuedAt: license.issuedAt,
      expiresAt: license.expiresAt,
      features: license.features,
    });

    const expectedSig = crypto
      .createHmac("sha256", license.tenantId)
      .update(payload)
      .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(license.signature), Buffer.from(expectedSig))) {
      return makeSoloStatus();
    }

    if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
      return makeSoloStatus();
    }

    return {
      tier: license.tier,
      features: license.features,
      tenantId: license.tenantId,
      issuedAt: license.issuedAt,
      expiresAt: license.expiresAt,
      licensed: license.tier !== "solo",
    };
  } catch {
    return makeSoloStatus();
  }
}

export function getActiveLicense(): LicenseStatus {
  return verifyLicense(LICENSE_PATH);
}

export function isFeatureEnabled(feature: LicenseFeature): boolean {
  const status = getActiveLicense();
  const tierFeatures = TIER_FEATURES[status.tier] ?? [];
  return tierFeatures.includes(feature);
}

export function generateLicenseKey(
  tier: LicenseTier,
  tenantId: string,
  secret: string
): string {
  if (tier === "solo") {
    throw new Error("Solo tier does not use license keys");
  }

  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const features = TIER_FEATURES[tier] ?? [];

  const payload = JSON.stringify({ tier, tenantId, issuedAt, expiresAt, features });
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  const license: LicenseKey = { tier, tenantId, issuedAt, expiresAt, features, signature };
  return JSON.stringify(license, null, 2);
}

function makeSoloStatus(): LicenseStatus {
  return {
    tier: "solo",
    features: [],
    tenantId: null,
    issuedAt: null,
    expiresAt: null,
    licensed: false,
  };
}