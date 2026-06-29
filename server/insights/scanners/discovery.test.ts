import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import {
  listDiscoveredAssets,
  reconcileDiscoveredAssets,
  type DiscoveredAssetInput,
} from "../../discovery/reconcile.ts";
import { getInsight } from "../store.ts";
import { mapDiscoveryAssetToInsight, runDiscoveryScan } from "./discovery.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "discovery-scanner-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

const assetInput: DiscoveredAssetInput = {
  kind: "process",
  signature: "ollama serve",
  sourceProbe: "proc-cmdline",
  fingerprint: { pid: 123, cmdline: "ollama serve" },
};

describe("discovery inventory reconciliation", () => {
  test("upserts discovered assets and preserves operator status", () => {
    const first = reconcileDiscoveredAssets([assetInput], 1_700_000_000_000);
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("unregistered");
    expect(first[0].firstSeen).toBe(1_700_000_000_000);

    db().query("UPDATE discovered_assets SET status = 'ignored', ignored_reason = 'test fixture' WHERE id = ?")
      .run(first[0].id);

    const second = reconcileDiscoveredAssets([assetInput], 1_700_000_100_000);
    expect(second[0].status).toBe("ignored");
    expect(second[0].firstSeen).toBe(1_700_000_000_000);
    expect(second[0].lastSeen).toBe(1_700_000_100_000);
  });

  test("maps public listeners to critical exposed endpoint findings", () => {
    const [asset] = reconcileDiscoveredAssets([{
      kind: "port",
      signature: "0.0.0.0:8000/vllm",
      sourceProbe: "ss-listen",
      fingerprint: { host: "0.0.0.0", port: 8000, processName: "vllm", exposure: "public-listener" },
    }], 1_700_000_000_000);

    const finding = mapDiscoveryAssetToInsight(asset, 1_700_000_000_000);
    expect(finding).not.toBeNull();
    expect(finding!.sourceKey).toContain("discovery:exposed-model-endpoint:");
    expect(finding!.severity).toBe("critical");
    expect(finding!.domain).toBe("security");
  });
});

describe("discovery scanner", () => {
  test("emits and persists an unregistered AI system finding", () => {
    reconcileDiscoveredAssets([assetInput], Date.now());

    const result = runDiscoveryScan();
    const asset = listDiscoveredAssets("unregistered").find((item) => item.signature === "ollama serve")!;
    const finding = result.findings.find((item) => item.sourceKey === `discovery:unregistered-ai-system:${asset.id}`);

    expect(finding).toBeDefined();
    expect(finding!.title).toBe("An unregistered AI system was discovered");
    expect(finding!.manualPageHref).toBe("/insights");
    expect(getInsight(finding!.id)).not.toBeNull();
  });
});
