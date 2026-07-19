import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKnowFetchForTests } from "../adapters/know.ts";
import { knowHandler } from "./know.ts";

describe("Know detail API", () => {
  let root: string;
  const previous: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "know-api-"));
    for (const name of ["DASHBOARD_KNOW_MANIFEST_PATH", "DASHBOARD_KNOW_HEALTH_PATH", "DASHBOARD_KNOW_OPS_SNAPSHOT_PATH", "DASHBOARD_KNOW_DOCTOR_PATH"]) {
      previous[name] = process.env[name];
    }
    process.env.DASHBOARD_KNOW_MANIFEST_PATH = join(root, "manifest.json");
    process.env.DASHBOARD_KNOW_HEALTH_PATH = join(root, "health.json");
    process.env.DASHBOARD_KNOW_OPS_SNAPSHOT_PATH = join(root, "ops.json");
    process.env.DASHBOARD_KNOW_DOCTOR_PATH = join(root, "doctor.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(process.env.DASHBOARD_KNOW_MANIFEST_PATH, JSON.stringify({
      schemaVersion: 1,
      id: "know",
      product: "know",
      root: "/opt/know/web",
      label: "Know",
      service: "know-web",
      urls: { local: "http://127.0.0.1:3400", public: "https://know.example", healthPath: "/health" },
      artifacts: {
        health: { path: process.env.DASHBOARD_KNOW_HEALTH_PATH, freshnessMinutes: 45 },
        opsSnapshot: { path: process.env.DASHBOARD_KNOW_OPS_SNAPSHOT_PATH, freshnessMinutes: 45 },
        doctor: { path: process.env.DASHBOARD_KNOW_DOCTOR_PATH, freshnessMinutes: 360 },
      },
      workflow: { stages: ["research", "write", "verify", "package"] },
      separation: { owns: ["Know health"], neverReads: ["NewsBites pipeline state"] },
    }));
    writeFileSync(process.env.DASHBOARD_KNOW_HEALTH_PATH, JSON.stringify({ ok: true, score: 100, total: 44, failed: 0, checkedAtISO: "2026-07-19T10:00:00Z", configPresence: { secret: true } }));
    writeFileSync(process.env.DASHBOARD_KNOW_OPS_SNAPSHOT_PATH, JSON.stringify({
      identity: { label: "Know" },
      stories: { total: 8, live: 8, drafts: 0, liveArt: { complete: true } },
      database: { reachable: true, schemaVersion: 3, aggregates: { accounts: 1, events: 73, pushSubscriptions: 0 } },
      capabilities: { reachable: true, magicLink: true, push: true },
      modelHealth: { configuredStageModels: { research: "editorial-heavy" }, logicalModels: { "editorial-heavy": { observed: true, available: false, capability: "heavy", latencyMs: 214 } } },
      email: {
        configured: true,
        transport: "microsoft365-oauth",
        readiness: "ready",
        templates: { total: 13, scenarios: ["magic-link", "welcome", "story-edition"], htmlCoverage: 13, textCoverage: 13, complete: true },
        storyDelivery: {
          preferenceAvailable: true,
          optedIn: 1,
          liveEligible: 8,
          deliveryLog: "absent",
          totals: { delivered: 0, unavailable: 0, failed: 0 },
          last: null,
          // planted forbidden fields — the API must whitelist and drop these:
          recipient: "victim@example.com",
          lastToken: "signin?token=leak-me",
        },
      },
      pipeline: { dossiers: 0, filesByStage: {}, agentRuns: 0, latestModifiedAt: null },
      configPresence: { token: true },
    }));
    writeFileSync(process.env.DASHBOARD_KNOW_DOCTOR_PATH, JSON.stringify({ ok: true, status: "degraded", counts: { pass: 11, warn: 1, fail: 0 }, findings: [{ id: "logical-model-runtime", status: "warn", summary: "no model available" }] }));
    setKnowFetchForTests((async () => Response.json({ service: "know", stories: { total: 8 }, database: { reachable: true } })) as unknown as typeof fetch);
  });

  afterEach(() => {
    setKnowFetchForTests(null);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("returns independent sanitized Know sections", async () => {
    const response = await knowHandler();
    expect(response.status).toBe(200);
    const envelope = await response.json() as { data: Record<string, any>; sourceStatus: Record<string, string> };
    expect(envelope.data.identity.id).toBe("know");
    expect(envelope.data.health.score).toBe(100);
    expect(envelope.data.operations.stories.live).toBe(8);
    expect(envelope.data.models.logicalModels[0].name).toBe("editorial-heavy");
    expect(envelope.data.workflow.stages).toEqual(["research", "write", "verify", "package"]);
    expect(envelope.data.doctor.counts.warn).toBe(1);
    expect(envelope.data.runtime.reachable).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("configPresence");
    expect(JSON.stringify(envelope)).not.toContain("NewsBites queue");
    expect(envelope.sourceStatus.knowHealth).toBe("ok");
  });

  test("exposes sanitized email & delivery aggregates and drops forbidden fields", async () => {
    const envelope = await (await knowHandler()).json() as { data: Record<string, any> };
    const email = envelope.data.email;
    expect(email.available).toBe(true);
    expect(email.configured).toBe(true);
    expect(email.transport).toBe("microsoft365-oauth");
    expect(email.readiness).toBe("ready");
    expect(email.templates.total).toBe(13);
    expect(email.templates.complete).toBe(true);
    expect(email.templates.scenarios).toContain("story-edition");
    expect(email.storyDelivery.optedIn).toBe(1);
    expect(email.storyDelivery.liveEligible).toBe(8);
    expect(email.storyDelivery.deliveryLog).toBe("absent");
    expect(email.storyDelivery.last).toBeNull();
    // Privacy boundary: whitelisted shaping must strip any unexpected passthrough.
    expect(email.storyDelivery).not.toHaveProperty("recipient");
    expect(email.storyDelivery).not.toHaveProperty("lastToken");
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("victim@example.com");
    expect(serialized).not.toContain("leak-me");
    expect(serialized).not.toContain("signin?token=");
  });

  test("degrades gracefully when the ops artifact carries no email block", async () => {
    writeFileSync(process.env.DASHBOARD_KNOW_OPS_SNAPSHOT_PATH!, JSON.stringify({
      stories: { total: 8, live: 8, drafts: 0 },
      database: { reachable: true, schemaVersion: 4, aggregates: { accounts: 1, events: 75, pushSubscriptions: 0 } },
      capabilities: { reachable: true, magicLink: true, push: true },
    }));
    const envelope = await (await knowHandler()).json() as { data: Record<string, any> };
    expect(envelope.data.email.available).toBe(false);
    expect(envelope.data.email.configured).toBeNull();
    expect(envelope.data.email.transport).toBeNull();
    expect(envelope.data.email.templates.scenarios).toEqual([]);
    expect(envelope.data.email.storyDelivery.optedIn).toBeNull();
  });

  test("degrades a malformed artifact without failing the endpoint", async () => {
    writeFileSync(process.env.DASHBOARD_KNOW_DOCTOR_PATH!, "not-json");
    const envelope = await (await knowHandler()).json() as { data: Record<string, any>; sourceStatus: Record<string, string> };
    expect(envelope.data.doctor.artifact.state).toBe("malformed");
    expect(envelope.sourceStatus.knowDoctor).toBe("error");
  });
});
