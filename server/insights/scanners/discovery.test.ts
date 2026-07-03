import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import {
  listDiscoveredAssets,
  reconcileDiscoveredAssets,
  stableProcessSignature,
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
  test("emits and persists an unregistered AI system finding for a currently-present asset", () => {
    const result = runDiscoveryScan([assetInput]);
    const asset = listDiscoveredAssets("unregistered").find((item) => item.signature === "ollama serve")!;
    const finding = result.findings.find((item) => item.sourceKey === `discovery:unregistered-ai-system:${asset.id}`);

    expect(finding).toBeDefined();
    expect(finding!.title).toBe("An unregistered AI system was discovered");
    expect(finding!.manualPageHref).toBe("/insights");
    expect(getInsight(finding!.id)).not.toBeNull();
  });

  test("does NOT flag historical assets that are no longer present, and auto-resolves their insights", () => {
    const t0 = Date.now();
    const first = runDiscoveryScan([assetInput], t0);
    expect(first.findings).toHaveLength(1);
    const insightId = first.findings[0].id;

    // Next scan: the asset has vanished (process exited). The registry keeps the row,
    // but the inbox must not — and the open insight auto-resolves with an audit entry.
    const second = runDiscoveryScan([], t0 + 60_000);
    expect(second.findings).toHaveLength(0);
    expect(second.resolvedCount).toBe(1);
    expect(getInsight(insightId)!.status).toBe("resolved");

    const audit = getDashboardDb()!.query(`
      SELECT action_kind FROM action_audit WHERE target_id = ? AND action_kind = 'insights.auto-resolve'
    `).get(insightId) as { action_kind: string } | null;
    expect(audit?.action_kind).toBe("insights.auto-resolve");
  });

  test("re-appearing assets re-open a finding on the same stable identity", () => {
    const t0 = Date.now();
    runDiscoveryScan([assetInput], t0);
    runDiscoveryScan([], t0 + 60_000);
    const third = runDiscoveryScan([assetInput], t0 + 120_000);
    expect(third.findings).toHaveLength(1);

    // Same asset id both times — identity is stable, not per-invocation.
    const assets = listDiscoveredAssets("unregistered").filter((item) => item.signature === "ollama serve");
    expect(assets).toHaveLength(1);
  });

  test("prunes unregistered assets past the retention window but keeps operator-decided rows", () => {
    const old = Date.now() - 45 * 24 * 60 * 60 * 1000;
    reconcileDiscoveredAssets([assetInput], old);
    reconcileDiscoveredAssets([{ ...assetInput, signature: "vllm serve" }], old);
    getDashboardDb()!.query("UPDATE discovered_assets SET status = 'ignored', ignored_reason = 'known' WHERE signature = 'vllm serve'").run();

    reconcileDiscoveredAssets([], Date.now());
    const signatures = listDiscoveredAssets().map((a) => a.signature);
    expect(signatures).not.toContain("ollama serve");
    expect(signatures).toContain("vllm serve");
  });
});

describe("stable process signatures", () => {
  test("collapses per-session cmdline churn to one identity", () => {
    const a = stableProcessSignature("node /usr/bin/opencode serve --port 4096 --hostname 0.0.0.0");
    const b = stableProcessSignature("node /usr/bin/opencode serve --port 5011 --hostname 127.0.0.1");
    expect(a).toBe(b);
    expect(a).toContain("opencode");
  });

  test("keeps distinct AI systems distinct", () => {
    const opencode = stableProcessSignature("node /usr/bin/opencode serve --port 4096");
    const mcp = stableProcessSignature("node /usr/bin/mcp-server-filesystem /opt/ai-vault");
    expect(opencode).not.toBe(mcp);
  });

  test("collapses shell-snapshot noise from CLI sessions", () => {
    const a = stableProcessSignature("/bin/bash -c source /root/.claude/shell-snapshots/snapshot-bash-111-aa.sh");
    const b = stableProcessSignature("/bin/bash -c source /root/.claude/shell-snapshots/snapshot-bash-222-bb.sh");
    expect(a).toBe(b);
  });
});
