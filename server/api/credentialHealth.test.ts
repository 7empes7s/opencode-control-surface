import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCredentialHealthArtifact, readCredentialHealth } from "./credentialHealth.ts";

const NOW = Date.UTC(2026, 6, 18, 20, 0, 0);
let tempDir: string | null = null;
let previousPath: string | undefined;

function validArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyVersion: "credential-observation-v1",
    runId: "non-secret-run-id",
    generatedAt: NOW - 60_000,
    expiresAt: NOW + 60 * 60 * 1000,
    credentials: {
      OPENCODE_GO_API_KEY: {
        provider: "opencode-go",
        status: "expired",
        httpCode: 401,
        checkedAt: NOW - 90_000,
        sinceStatus: NOW - 3_600_000,
        gatesModels: ["coding-go-minimax-m3"],
        present: true,
        secretValue: "RAW_SECRET_SENTINEL",
        providerBody: "RAW_BODY_SENTINEL",
      },
    },
    topLevelSecret: "RAW_TOP_SENTINEL",
    ...overrides,
  };
}

afterEach(() => {
  if (previousPath === undefined) delete process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH;
  else process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH = previousPath;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

test("strict parser returns only allowlisted status fields", () => {
  const parsed = parseCredentialHealthArtifact(validArtifact(), NOW);

  expect(parsed).toEqual([{
    envName: "OPENCODE_GO_API_KEY",
    provider: "opencode-go",
    status: "expired",
    httpCode: 401,
    checkedAt: NOW - 90_000,
    sinceStatus: NOW - 3_600_000,
    gatesModels: ["coding-go-minimax-m3"],
    present: true,
    fresh: true,
  }]);
  expect(JSON.stringify(parsed)).not.toContain("RAW_SECRET_SENTINEL");
  expect(JSON.stringify(parsed)).not.toContain("RAW_BODY_SENTINEL");
  expect(JSON.stringify(parsed)).not.toContain("RAW_TOP_SENTINEL");
});

test("stale, future-dated, expired, malformed, and unknown-schema artifacts fail open", () => {
  const tooOld = validArtifact({ generatedAt: NOW - 13 * 60 * 60 * 1000 - 1 });
  const future = validArtifact({ generatedAt: NOW + 5 * 60 * 1000 + 1, expiresAt: NOW + 60 * 60 * 1000 });
  const expired = validArtifact({ expiresAt: NOW - 1 });
  const wrongSchema = validArtifact({ schemaVersion: 2 });
  const badRunId = validArtifact({ runId: "contains spaces" });
  const overlongLifetime = validArtifact({ expiresAt: NOW + 14 * 60 * 60 * 1000 });
  const malformed = validArtifact({ credentials: { "bad env": { status: "expired" } } });
  const unknownStatus = validArtifact({
    credentials: {
      OPENCODE_GO_API_KEY: {
        provider: "opencode-go",
        status: "compromised",
        httpCode: 401,
        checkedAt: NOW - 1,
        sinceStatus: NOW - 2,
        gatesModels: [],
        present: true,
      },
    },
  });

  for (const artifact of [tooOld, future, expired, wrongSchema, badRunId, overlongLifetime, malformed, unknownStatus, null, []]) {
    expect(parseCredentialHealthArtifact(artifact, NOW)).toEqual([]);
  }
});

test("bounded gatesModels and status consistency reject the whole artifact", () => {
  const tooManyModels = Array.from({ length: 257 }, (_, index) => `model-${index}`);
  const badGates = validArtifact({
    credentials: {
      OPENCODE_GO_API_KEY: {
        provider: "opencode-go",
        status: "missing",
        httpCode: null,
        checkedAt: NOW - 1,
        sinceStatus: NOW - 2,
        gatesModels: tooManyModels,
        present: true,
      },
    },
  });
  expect(parseCredentialHealthArtifact(badGates, NOW)).toEqual([]);

  const badValid = validArtifact({
    credentials: {
      OPENCODE_GO_API_KEY: {
        provider: "opencode-go",
        status: "valid",
        httpCode: 200,
        checkedAt: NOW - 1,
        sinceStatus: NOW - 2,
        gatesModels: ["coding-go-minimax-m3"],
        present: true,
      },
    },
  });
  expect(parseCredentialHealthArtifact(badValid, NOW)).toEqual([]);

  const duplicateModel = validArtifact({
    credentials: {
      FIRST_API_KEY: {
        provider: "first",
        status: "valid",
        httpCode: 200,
        checkedAt: NOW - 1,
        sinceStatus: null,
        gatesModels: ["shared-model"],
        present: true,
      },
      SECOND_API_KEY: {
        provider: "second",
        status: "valid",
        httpCode: 200,
        checkedAt: NOW - 1,
        sinceStatus: null,
        gatesModels: ["shared-model"],
        present: true,
      },
    },
  });
  expect(parseCredentialHealthArtifact(duplicateModel, NOW)).toEqual([]);

  const contradictoryCode = validArtifact({
    credentials: {
      OPENCODE_GO_API_KEY: {
        provider: "opencode-go",
        status: "invalid",
        httpCode: 429,
        checkedAt: NOW - 1,
        sinceStatus: NOW - 2,
        gatesModels: ["coding-go-minimax-m3"],
        present: true,
      },
    },
  });
  expect(parseCredentialHealthArtifact(contradictoryCode, NOW)).toEqual([]);

  const missingSince = validArtifact({
    credentials: {
      OPENCODE_GO_API_KEY: {
        provider: "opencode-go",
        status: "invalid",
        httpCode: 401,
        checkedAt: NOW - 1,
        sinceStatus: null,
        gatesModels: ["coding-go-minimax-m3"],
        present: true,
      },
    },
  });
  expect(parseCredentialHealthArtifact(missingSince, NOW)).toEqual([]);
});

test("reader requires one root-owned 0600 regular file and fails open otherwise", () => {
  previousPath = process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH;
  tempDir = mkdtempSync(join(tmpdir(), "credential-health-reader-"));
  process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH = join(tempDir, "credential-health.json");

  expect(readCredentialHealth(NOW)).toEqual([]);
  writeFileSync(process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH, "not-json");
  expect(readCredentialHealth(NOW)).toEqual([]);
  writeFileSync(process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH, JSON.stringify(validArtifact()));
  expect(readCredentialHealth(NOW)).toEqual([]);
  chmodSync(process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH, 0o600);
  expect(readCredentialHealth(NOW)).toHaveLength(1);

  const regularTarget = join(tempDir, "regular-target.json");
  writeFileSync(regularTarget, JSON.stringify(validArtifact()), { mode: 0o600 });
  rmSync(process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH);
  symlinkSync(regularTarget, process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH);
  expect(readCredentialHealth(NOW)).toEqual([]);
});
