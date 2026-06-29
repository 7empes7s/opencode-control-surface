import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import { getInsight } from "../store.ts";
import {
  mapCertFinding,
  mapDnsFinding,
  mapHttpFinding,
  mapTunnelFinding,
  mapVastBalanceFinding,
  runEdgeScan,
  setEdgeProbeOverridesForTest,
  type EdgeTarget,
} from "./edge.ts";

const NOW = 1_700_000_000_000;
const TARGET: EdgeTarget = { url: "https://example.test/status", host: "example.test", scheme: "https" };

describe("edge scanner: pure mapping", () => {
  test("unreachable HTTP target emits high or critical depending on previous health", () => {
    const first = mapHttpFinding(TARGET, { ok: false, status: 503 }, NOW, false)[0];
    expect(first.sourceKey).toBe("edge:site-unreachable:example.test");
    expect(first.severity).toBe("high");
    expect(first.manualPageHref).toBe("/infra");

    const regressed = mapHttpFinding(TARGET, { ok: false, status: null, error: "timeout" }, NOW, true)[0];
    expect(regressed.severity).toBe("critical");
  });

  test("expiring certificate tiers warning and critical severities", () => {
    const warn = mapCertFinding(TARGET, { daysRemaining: 10, validTo: "Jul 10 00:00:00 2026 GMT" }, NOW)[0];
    expect(warn.sourceKey).toBe("edge:cert-expiring:example.test");
    expect(warn.severity).toBe("medium");

    const critical = mapCertFinding(TARGET, { daysRemaining: 2, validTo: "Jul 01 00:00:00 2026 GMT" }, NOW)[0];
    expect(critical.severity).toBe("critical");
  });

  test("DNS failure and tunnel down emit ops findings", () => {
    expect(mapDnsFinding(TARGET, { ok: false, error: "ENOTFOUND" }, NOW)[0].sourceKey).toBe("edge:dns-fail:example.test");
    const tunnel = mapTunnelFinding({ checked: true, units: ["cloudflared"], downUnits: ["cloudflared"] }, NOW)[0];
    expect(tunnel.sourceKey).toBe("edge:tunnel-down");
    expect(tunnel.actionDescriptorId).toBe("start-job:service:cloudflared");
  });

  test("low Vast runway emits cost finding", () => {
    const warn = mapVastBalanceFinding({
      runwayHours: 18,
      balanceUsd: 9,
      creditUsd: 0,
      hourlyRateUsd: 0.5,
      instanceStatus: "running",
    }, NOW)[0];
    expect(warn.sourceKey).toBe("cost:vast-balance-low");
    expect(warn.domain).toBe("cost");
    expect(warn.severity).toBe("medium");

    const critical = mapVastBalanceFinding({
      runwayHours: 5,
      balanceUsd: 2.5,
      creditUsd: 0,
      hourlyRateUsd: 0.5,
      instanceStatus: "running",
    }, NOW)[0];
    expect(critical.severity).toBe("critical");
  });
});

describe("edge scanner: runEdgeScan integration", () => {
  let tempDir: string;
  let prevDb: string | undefined;
  let prevDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "edge-scanner-test-"));
    prevDb = process.env.DASHBOARD_DB;
    prevDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    setEdgeProbeOverridesForTest(null);
    closeDashboardDb();
    if (prevDb === undefined) delete process.env.DASHBOARD_DB; else process.env.DASHBOARD_DB = prevDb;
    if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH; else process.env.DASHBOARD_DB_PATH = prevDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("mocked probes create findings, write samples, and stale-resolve when healthy", async () => {
    setEdgeProbeOverridesForTest({
      discoverTargets: () => [TARGET],
      httpProbe: async () => ({ ok: false, status: 503 }),
      dnsProbe: async () => ({ ok: false, error: "ENOTFOUND" }),
      tlsProbe: async () => ({ daysRemaining: 2, validTo: "Jul 01 00:00:00 2026 GMT" }),
      tunnelProbe: () => ({ checked: true, units: ["cloudflared"], downUnits: ["cloudflared"] }),
      vastRunway: async () => ({ runwayHours: 6, balanceUsd: 3, creditUsd: 0, hourlyRateUsd: 0.5, instanceStatus: "running" }),
    });

    const triggered = await runEdgeScan();
    expect(triggered.findings.some((f) => f.sourceKey === "edge:site-unreachable:example.test")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "edge:dns-fail:example.test")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "edge:cert-expiring:example.test")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "edge:tunnel-down")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "cost:vast-balance-low")).toBe(true);

    const sampleCount = getDashboardDb()!.query("SELECT COUNT(*) AS count FROM metric_samples WHERE source = 'edge'")
      .get() as { count: number };
    expect(sampleCount.count).toBeGreaterThanOrEqual(4);

    setEdgeProbeOverridesForTest({
      discoverTargets: () => [TARGET],
      httpProbe: async () => ({ ok: true, status: 200 }),
      dnsProbe: async () => ({ ok: true, address: "203.0.113.10" }),
      tlsProbe: async () => ({ daysRemaining: 90, validTo: "Sep 27 00:00:00 2026 GMT" }),
      tunnelProbe: () => ({ checked: true, units: ["cloudflared"], downUnits: [] }),
      vastRunway: async () => ({ runwayHours: 48, balanceUsd: 24, creditUsd: 0, hourlyRateUsd: 0.5, instanceStatus: "running" }),
    });

    const cleared = await runEdgeScan();
    expect(cleared.resolvedCount).toBeGreaterThanOrEqual(5);
    expect(getInsight("insight_edge_site_unreachable_example.test")?.status).toBe("resolved");
    expect(getInsight("insight_edge_dns_fail_example.test")?.status).toBe("resolved");
    expect(getInsight("insight_edge_cert_expiring_example.test")?.status).toBe("resolved");
    expect(getInsight("insight_edge_tunnel_down")?.status).toBe("resolved");
    expect(getInsight("insight_cost_vast_balance_low")?.status).toBe("resolved");
  });
});
