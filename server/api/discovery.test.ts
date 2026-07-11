import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";
import { DISCOVERY_SOURCES, reconcileDiscoveredAssets, listDiscoveredAssets, type DiscoveredAssetInput } from "../discovery/reconcile.ts";
import { upsertInsight } from "../insights/store.ts";
import {
  discoveryListAssetsHandler,
  discoveryBulkRegisterHandler,
  discoveryBulkIgnoreHandler,
  discoveryRegisterAssetHandler,
  discoveryIgnoreAssetHandler,
  discoveryUpdateAssetHandler,
  discoveryRescanHandler,
  runDiscoveryScan,
} from "./discovery.ts";
import type { ApiEnvelope } from "./types.ts";
import type { DiscoveredAsset } from "../discovery/reconcile.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

const TOKEN = "test-token-discovery";

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "discovery-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = TOKEN;
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function authed(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function noToken(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

const SAMPLE_ASSET: DiscoveredAssetInput = {
  kind: "process",
  signature: "ollama serve",
  sourceProbe: "proc-cmdline",
  fingerprint: { pid: 42, cmdline: "ollama serve" },
};

function seedAsset(): DiscoveredAsset {
  const [asset] = reconcileDiscoveredAssets([SAMPLE_ASSET], Date.now());
  return asset;
}

function seedInsightForAsset(assetId: string): void {
  upsertInsight({
    id: `insight_discovery_unregistered_ai_system_${assetId}`,
    sourceKey: `discovery:unregistered-ai-system:${assetId}`,
    domain: "security",
    severity: "medium",
    title: "An unregistered AI system was discovered",
    plainSummary: "test",
    confidence: 0.85,
    evidenceRefs: [],
    actionDescriptorId: null,
    manualPageHref: "/insights",
    createdAt: Date.now(),
  });
}

describe("GET /api/discovery/assets", () => {
  test("rejects unauthenticated requests with 401", () => {
    const res = discoveryListAssetsHandler(
      noToken("GET", "/api/discovery/assets"),
      new URL("http://localhost/api/discovery/assets"),
    );
    expect(res.status).toBe(401);
  });

  test("returns empty list when no assets seeded", () => {
    const res = discoveryListAssetsHandler(
      authed("GET", "/api/discovery/assets"),
      new URL("http://localhost/api/discovery/assets"),
    );
    expect(res.status).toBe(200);
  });

  test("returns seeded unregistered asset", async () => {
    seedAsset();
    const res = discoveryListAssetsHandler(
      authed("GET", "/api/discovery/assets"),
      new URL("http://localhost/api/discovery/assets"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as ApiEnvelope<DiscoveredAsset[]>;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.some((a) => a.signature === "ollama serve")).toBe(true);
  });

  test("filters by status query param", async () => {
    seedAsset();
    const url = new URL("http://localhost/api/discovery/assets?status=unregistered");
    const res = discoveryListAssetsHandler(authed("GET", "/api/discovery/assets?status=unregistered"), url);
    const body = await res.json() as ApiEnvelope<DiscoveredAsset[]>;
    expect(body.data.every((a) => a.status === "unregistered")).toBe(true);
  });
});

describe("POST /api/discovery/assets/:id/register", () => {
  test("rejects unauthenticated requests with 401", async () => {
    const asset = seedAsset();
    const res = await discoveryRegisterAssetHandler(
      noToken("POST", `/api/discovery/assets/${asset.id}/register`),
      asset.id,
    );
    expect(res.status).toBe(401);
  });

  test("returns 404 for unknown asset id", async () => {
    const res = await discoveryRegisterAssetHandler(
      authed("POST", "/api/discovery/assets/unknown-xyz/register", {}),
      "unknown-xyz",
    );
    expect(res.status).toBe(404);
  });

  test("registers asset: status flips, audit row written, insight resolved", async () => {
    const asset = seedAsset();
    seedInsightForAsset(asset.id);

    const res = await discoveryRegisterAssetHandler(
      authed("POST", `/api/discovery/assets/${asset.id}/register`, {
        name: "My Ollama",
        owner: "ops-team",
        criticality: "high",
      }),
      asset.id,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as ApiEnvelope<{ asset: DiscoveredAsset; insightsResolved: number }>;
    expect(body.data.asset.status).toBe("registered");
    expect(body.data.asset.registeredName).toBe("My Ollama");
    expect(body.data.asset.owner).toBe("ops-team");
    expect(body.data.asset.criticality).toBe("high");
    expect(body.data.insightsResolved).toBe(1);

    // Verify DB
    const persisted = listDiscoveredAssets("registered");
    expect(persisted.some((a) => a.id === asset.id)).toBe(true);

    // Verify audit row
    const audit = readActionAudit({ limit: 10 });
    expect(audit.some((row) => row.actionKind === "discovery.asset.register" && row.targetId === asset.id)).toBe(true);
  });
});

describe("POST /api/discovery/assets/:id/ignore", () => {
  test("rejects unauthenticated requests with 401", async () => {
    const asset = seedAsset();
    const res = await discoveryIgnoreAssetHandler(
      noToken("POST", `/api/discovery/assets/${asset.id}/ignore`),
      asset.id,
    );
    expect(res.status).toBe(401);
  });

  test("ignores asset with reason and resolves insight", async () => {
    const asset = seedAsset();
    seedInsightForAsset(asset.id);

    const res = await discoveryIgnoreAssetHandler(
      authed("POST", `/api/discovery/assets/${asset.id}/ignore`, { reason: "dev machine only" }),
      asset.id,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as ApiEnvelope<{ ignored: boolean; insightsResolved: number }>;
    expect(body.data.ignored).toBe(true);
    expect(body.data.insightsResolved).toBe(1);

    const persisted = listDiscoveredAssets("ignored");
    const found = persisted.find((a) => a.id === asset.id);
    expect(found).toBeDefined();
    expect(found!.ignoredReason).toBe("dev machine only");

    const audit = readActionAudit({ limit: 10 });
    expect(audit.some((row) => row.actionKind === "discovery.asset.ignore" && row.targetId === asset.id)).toBe(true);
  });
});

describe("bulk discovery asset mutations", () => {
  test("bulk-register processes two assets, resolves insights, and writes per-asset bulk audits", async () => {
    const assets = reconcileDiscoveredAssets([
      SAMPLE_ASSET,
      {
        kind: "cli",
        signature: "synthetic-codex",
        sourceProbe: "path-scan",
        fingerprint: { name: "synthetic-codex" },
      },
    ], Date.now());
    assets.forEach((asset) => seedInsightForAsset(asset.id));

    const res = await discoveryBulkRegisterHandler(authed("POST", "/api/discovery/assets/bulk-register", {
      assetIds: assets.map((asset) => asset.id),
      owner: "platform",
      criticality: "high",
      attachedService: "ai-runtime",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as ApiEnvelope<{ processed: number; notFoundIds: string[]; insightsResolved: number }>;
    expect(body.data).toEqual({ processed: 2, notFoundIds: [], insightsResolved: 2 });
    expect(listDiscoveredAssets("registered").filter((asset) => assets.some((seeded) => seeded.id === asset.id))).toHaveLength(2);

    const audits = readActionAudit({ actionKind: "discovery.asset.register" })
      .filter((row) => assets.some((asset) => asset.id === row.targetId));
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => (row.request as { bulk?: boolean } | null)?.bulk === true)).toBe(true);
  });

  test("bulk-register collects unknown ids", async () => {
    const asset = seedAsset();
    const res = await discoveryBulkRegisterHandler(authed("POST", "/api/discovery/assets/bulk-register", {
      assetIds: [asset.id, "unknown-asset"],
    }));
    const body = await res.json() as ApiEnvelope<{ processed: number; notFoundIds: string[]; insightsResolved: number }>;
    expect(body.data).toEqual({ processed: 1, notFoundIds: ["unknown-asset"], insightsResolved: 0 });
  });

  test("bulk endpoints reject empty and over-100 batches", async () => {
    const empty = await discoveryBulkRegisterHandler(authed("POST", "/api/discovery/assets/bulk-register", { assetIds: [] }));
    expect(empty.status).toBe(400);
    const tooMany = await discoveryBulkIgnoreHandler(authed("POST", "/api/discovery/assets/bulk-ignore", {
      assetIds: Array.from({ length: 101 }, (_, index) => `asset-${index}`),
    }));
    expect(tooMany.status).toBe(400);
  });
});

describe("PATCH /api/discovery/assets/:id", () => {
  test("returns 404 for an unknown asset", async () => {
    const res = await discoveryUpdateAssetHandler(
      authed("PATCH", "/api/discovery/assets/unknown", { owner: "ops" }),
      "unknown",
    );
    expect(res.status).toBe(404);
  });

  test("returns 409 for an unregistered asset", async () => {
    const asset = seedAsset();
    const res = await discoveryUpdateAssetHandler(
      authed("PATCH", `/api/discovery/assets/${asset.id}`, { owner: "ops" }),
      asset.id,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Only registered assets can be edited" });
  });

  test("updates owner and criticality with before/after audit", async () => {
    const asset = seedAsset();
    await discoveryRegisterAssetHandler(authed("POST", `/api/discovery/assets/${asset.id}/register`, {
      owner: "old-owner",
      criticality: "low",
    }), asset.id);

    const res = await discoveryUpdateAssetHandler(
      authed("PATCH", `/api/discovery/assets/${asset.id}`, { owner: "new-owner", criticality: "critical" }),
      asset.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as ApiEnvelope<{ asset: DiscoveredAsset }>;
    expect(body.data.asset.owner).toBe("new-owner");
    expect(body.data.asset.criticality).toBe("critical");
    const [audit] = readActionAudit({ actionKind: "discovery.asset.update" });
    expect(audit?.risk).toBe("low");
    expect(audit?.request).toEqual({
      before: { owner: "old-owner", criticality: "low" },
      after: { owner: "new-owner", criticality: "critical" },
    });
  });
});

describe("POST /api/discovery/rescan", () => {
  test("rejects unauthenticated requests with 401", async () => {
    const res = await discoveryRescanHandler(noToken("POST", "/api/discovery/rescan"));
    expect(res.status).toBe(401);
  });

  test("runs rescan and returns assetCount + audit row", async () => {
    const originals = { ...DISCOVERY_SOURCES };
    try {
      for (const source of Object.keys(DISCOVERY_SOURCES)) {
        (DISCOVERY_SOURCES as Record<string, () => DiscoveredAssetInput[]>)[source] = () => [];
      }
      const res = await discoveryRescanHandler(authed("POST", "/api/discovery/rescan"));
      expect(res.status).toBe(200);
      const body = await res.json() as ApiEnvelope<{ assetsFound: number; scannedAt: number }>;
      expect(body.data.assetsFound).toBe(0);
      expect(body.data.scannedAt).toBeGreaterThan(0);

      const audit = readActionAudit({ limit: 10 });
      expect(audit.some((row) => row.actionKind === "discovery.rescan" && row.targetId === "all")).toBe(true);
    } finally {
      Object.assign(DISCOVERY_SOURCES, originals);
    }
  });

  test("rejects an unknown source without scanning", async () => {
    const res = await discoveryRescanHandler(authed("POST", "/api/discovery/rescan", { source: "bogus" }));
    expect(res.status).toBe(400);
  });

  test("runDiscoveryScan executes only the selected source", () => {
    const original = DISCOVERY_SOURCES["proc-cmdline"];
    let calls = 0;
    try {
      DISCOVERY_SOURCES["proc-cmdline"] = () => {
        calls += 1;
        return [SAMPLE_ASSET];
      };
      const result = runDiscoveryScan("proc-cmdline");
      expect(result.assetsFound).toBe(1);
      expect(calls).toBe(1);
      expect(listDiscoveredAssets().some((asset) => asset.signature === SAMPLE_ASSET.signature)).toBe(true);
    } finally {
      DISCOVERY_SOURCES["proc-cmdline"] = original;
    }
  });
});
