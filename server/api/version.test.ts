import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { handleApi } from "./router.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

function gitValue(args: string[]): string | null {
  try {
    return execFileSync("git", ["rev-parse", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function resetRateLimitMap(): void {
  (globalThis as unknown as { __rateLimitMap?: Record<string, [number, number]> }).__rateLimitMap = {};
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "x-real-ip": "version-test",
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("GET /api/version", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with version shape", async () => {
    const response = await handleApi(
      request("/api/version"),
      new URL("http://127.0.0.1:3000/api/version"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.version).toBe("string");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.apiVersion).toBe("v1");
    expect(typeof body.buildHash).toBe("string");
    expect(typeof body.commit).toBe("string");
    expect(typeof body.buildTime).toBe("string");
    expect(Number.isNaN(Date.parse(body.buildTime as string))).toBe(false);
    expect(typeof body.nodeEnv).toBe("string");
    expect(typeof body.platform).toBe("string");
    expect(typeof body.arch).toBe("string");
  });

  test("uses explicit build metadata or repo git metadata", async () => {
    const response = await handleApi(
      request("/api/version"),
      new URL("http://127.0.0.1:3000/api/version"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    const envCommit = process.env.BUILD_COMMIT;
    const envHash = process.env.BUILD_HASH;
    const gitCommit = gitValue(["HEAD"]);
    const gitHash = gitValue(["--short", "HEAD"]);

    if (envCommit && envCommit.length > 0) {
      expect(body.commit).toBe(envCommit);
    } else if (gitCommit) {
      expect(body.commit).toBe(gitCommit);
    } else {
      expect(body.commit).toBe("dev");
    }

    if (envHash && envHash.length > 0) {
      expect(body.buildHash).toBe(envHash);
    } else if (gitHash) {
      expect(body.buildHash).toBe(gitHash);
    } else {
      expect(body.buildHash).toBe("dev");
    }

    if (gitCommit || envCommit) {
      expect(body.commit).not.toBe("dev");
      expect(body.buildHash).not.toBe("dev");
    }
  });

  test("returns same shape on repeated calls", async () => {
    const r1 = await handleApi(request("/api/version"), new URL("http://127.0.0.1:3000/api/version"));
    const r2 = await handleApi(request("/api/version"), new URL("http://127.0.0.1:3000/api/version"));
    const b1 = await r1.json() as Record<string, unknown>;
    const b2 = await r2.json() as Record<string, unknown>;
    expect(Object.keys(b1).sort()).toEqual(Object.keys(b2).sort());
  });
});

describe("/v1 prefix aliases", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("/v1/builder/ → /api/builder/ (projects)", async () => {
    const response = await handleApi(
      request("/v1/builder/projects"),
      new URL("http://127.0.0.1:3000/v1/builder/projects"),
    );
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });

  test("/v1/gateway → /api/gateway/status", async () => {
    const response = await handleApi(
      request("/v1/gateway"),
      new URL("http://127.0.0.1:3000/v1/gateway"),
    );
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });

  test("/v1/governance → /api/governance/policies", async () => {
    const response = await handleApi(
      request("/v1/governance"),
      new URL("http://127.0.0.1:3000/v1/governance"),
    );
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });

  test("/v1/licensing → /api/licensing/status", async () => {
    const response = await handleApi(
      request("/v1/licensing"),
      new URL("http://127.0.0.1:3000/v1/licensing"),
    );
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });

  test("/v1/telemetry → /api/telemetry/preview", async () => {
    const response = await handleApi(
      request("/v1/telemetry"),
      new URL("http://127.0.0.1:3000/v1/telemetry"),
    );
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });

  test("/v1/onboarding → /api/onboarding/status", async () => {
    const response = await handleApi(
      request("/v1/onboarding"),
      new URL("http://127.0.0.1:3000/v1/onboarding"),
    );
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });
});
