import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import type { CredentialHealthSummary, CredentialHealthStatus } from "./types.ts";

const POLICY_VERSION = "credential-observation-v1";
const MAX_EVIDENCE_AGE_MS = 13 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_CREDENTIALS = 64;
const MAX_GATED_MODELS = 256;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CREDENTIAL_STATUSES = new Set<CredentialHealthStatus>([
  "valid",
  "missing",
  "invalid",
  "expired",
  "revoked",
  "quota",
  "rate_limited",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0;
}

function normalizeHttpCode(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  return undefined;
}

function normalizeGatedModels(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_GATED_MODELS) return null;
  const models: string[] = [];
  const seen = new Set<string>();
  for (const model of value) {
    if (typeof model !== "string" || !MODEL_NAME_RE.test(model) || seen.has(model)) return null;
    seen.add(model);
    models.push(model);
  }
  return models;
}

/**
 * Normalize the status-only observation artifact. Any structural or freshness
 * failure rejects the whole file so partial evidence can never influence a
 * model verdict. Unknown artifact fields are deliberately not copied.
 */
export function parseCredentialHealthArtifact(raw: unknown, now = Date.now()): CredentialHealthSummary[] {
  if (!isRecord(raw)
    || raw.schemaVersion !== 1
    || raw.policyVersion !== POLICY_VERSION
    || typeof raw.runId !== "string"
    || !RUN_ID_RE.test(raw.runId)
    || !isTimestamp(raw.generatedAt)
    || !isTimestamp(raw.expiresAt)
    || !isRecord(raw.credentials)
    || !Number.isFinite(now)) {
    return [];
  }

  const generatedAt = raw.generatedAt;
  const expiresAt = raw.expiresAt;
  if (generatedAt > now + MAX_FUTURE_SKEW_MS
    || expiresAt < generatedAt
    || expiresAt - generatedAt > MAX_EVIDENCE_AGE_MS
    || now > expiresAt
    || now - generatedAt > MAX_EVIDENCE_AGE_MS) {
    return [];
  }

  const entries = Object.entries(raw.credentials);
  if (entries.length > MAX_CREDENTIALS) return [];

  const normalized: CredentialHealthSummary[] = [];
  const modelOwners = new Set<string>();
  for (const [envName, rawCredential] of entries) {
    if (!ENV_NAME_RE.test(envName) || !isRecord(rawCredential)) return [];

    const provider = rawCredential.provider;
    const status = rawCredential.status;
    const httpCode = normalizeHttpCode(rawCredential.httpCode);
    const checkedAt = rawCredential.checkedAt;
    const sinceStatus = rawCredential.sinceStatus;
    const gatesModels = normalizeGatedModels(rawCredential.gatesModels);
    const present = rawCredential.present;

    const normalizedSinceStatus = sinceStatus === null
      ? null
      : isTimestamp(sinceStatus)
        ? sinceStatus
        : undefined;

    if (typeof provider !== "string"
      || !PROVIDER_RE.test(provider)
      || typeof status !== "string"
      || !CREDENTIAL_STATUSES.has(status as CredentialHealthStatus)
      || httpCode === undefined
      || !isTimestamp(checkedAt)
      || normalizedSinceStatus === undefined
      || gatesModels === null
      || typeof present !== "boolean") {
      return [];
    }

    if (checkedAt > generatedAt + MAX_FUTURE_SKEW_MS
      || checkedAt > now + MAX_FUTURE_SKEW_MS
      || now - checkedAt > MAX_EVIDENCE_AGE_MS
      || (typeof normalizedSinceStatus === "number" && normalizedSinceStatus > checkedAt)
      || ((status === "missing") !== !present)) {
      return [];
    }

    const successCode = httpCode !== null && httpCode >= 200 && httpCode < 300;
    const credentialFailureCode = httpCode !== null && httpCode >= 400 && httpCode < 500;
    const statusHasSince = normalizedSinceStatus !== null;
    if ((status === "valid" && (!successCode || normalizedSinceStatus !== null))
      || (status === "missing" && (httpCode !== null || normalizedSinceStatus === null))
      || (status !== "valid" && !statusHasSince)
      || (status === "rate_limited" && httpCode !== 429)
      || (status !== "rate_limited" && httpCode === 429)
      || (["invalid", "expired", "revoked"].includes(status)
        && (!credentialFailureCode || httpCode === 402))
      || (status === "quota" && !credentialFailureCode)) {
      return [];
    }
    for (const logicalName of gatesModels) {
      if (modelOwners.has(logicalName)) return [];
      modelOwners.add(logicalName);
    }

    normalized.push({
      envName,
      provider,
      status: status as CredentialHealthStatus,
      httpCode,
      checkedAt,
      sinceStatus: normalizedSinceStatus,
      gatesModels,
      present,
      fresh: true,
    });
  }

  return normalized.sort((a, b) => a.envName.localeCompare(b.envName));
}

export function credentialHealthPath(): string {
  return process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH || "/var/lib/mimule/credential-health.json";
}

export function readCredentialHealth(now = Date.now()): CredentialHealthSummary[] {
  let fd: number | null = null;
  try {
    fd = openSync(
      credentialHealthPath(),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const before = fstatSync(fd);
    if (!before.isFile()
      || before.uid !== 0
      || before.gid !== 0
      || (before.mode & 0o777) !== 0o600
      || before.size <= 0
      || before.size > MAX_ARTIFACT_BYTES) {
      return [];
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(fd);
    if (offset !== buffer.length
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) {
      return [];
    }
    const raw = JSON.parse(buffer.toString("utf8")) as unknown;
    return parseCredentialHealthArtifact(raw, now);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* descriptor already closed */ }
    }
  }
}

export function credentialHealthByModel(
  credentials: readonly CredentialHealthSummary[],
): ReadonlyMap<string, CredentialHealthSummary> {
  const byModel = new Map<string, CredentialHealthSummary>();
  for (const credential of credentials) {
    for (const logicalName of credential.gatesModels) {
      // Stable first-wins behavior keeps a malformed producer from changing
      // attribution order. The strict reader has already removed unsafe data.
      if (!byModel.has(logicalName)) byModel.set(logicalName, credential);
    }
  }
  return byModel;
}
