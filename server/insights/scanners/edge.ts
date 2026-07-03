import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import tls from "node:tls";
import type { EvidenceRef } from "../../api/types.ts";
import { getServiceStatuses } from "../../adapters/system.ts";
import { getVastAccount, getVastInstance } from "../../adapters/vast.ts";
import { getDashboardDb } from "../../db/dashboard.ts";
import { writeActionAudit, writeMetricSample } from "../../db/writer.ts";
import { upsertInsight, resolveStaleInsights } from "../store.ts";
import type { Insight, InsightInput, InsightSeverity } from "../types.ts";

type ScanResult = {
  scannedAt: number;
  findings: Insight[];
  resolvedCount: number;
};

export type EdgeTarget = {
  url: string;
  host: string;
  scheme: "http" | "https";
};

export type HttpProbeResult = {
  ok: boolean;
  status: number | null;
  error?: string | null;
};

export type TlsProbeResult = {
  daysRemaining: number | null;
  validTo: string | null;
  error?: string | null;
};

export type DnsProbeResult = {
  ok: boolean;
  address?: string | null;
  error?: string | null;
};

export type TunnelProbeResult = {
  checked: boolean;
  downUnits: string[];
  units: string[];
};

export type VastRunway = {
  runwayHours: number | null;
  balanceUsd: number | null;
  creditUsd: number | null;
  hourlyRateUsd: number | null;
  instanceStatus: string | null;
};

type EdgeProbeOverrides = Partial<{
  discoverTargets: () => EdgeTarget[];
  httpProbe: (target: EdgeTarget) => Promise<HttpProbeResult>;
  tlsProbe: (target: EdgeTarget) => Promise<TlsProbeResult>;
  dnsProbe: (target: EdgeTarget) => Promise<DnsProbeResult>;
  tunnelProbe: () => TunnelProbeResult;
  vastRunway: () => Promise<VastRunway | null>;
}>;

let edgeProbeOverrides: EdgeProbeOverrides | null = null;

const DEFAULT_CONTROL_STATUS_URL = "https://control.techinsiderbytes.com/api/public-status";

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref, redacted: true };
}

function safeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "");
}

export function setEdgeProbeOverridesForTest(overrides: EdgeProbeOverrides | null): void {
  edgeProbeOverrides = overrides;
}

// This box often cannot reach its own public hostname through Cloudflare
// (hairpin NAT) even when the service is genuinely up — so before flagging
// our own control surface as unreachable, confirm via a direct localhost probe.
function isOwnControlSurfaceTarget(target: EdgeTarget): boolean {
  const ownTarget = normalizeTarget(process.env.CONTROL_STATUS_URL || DEFAULT_CONTROL_STATUS_URL);
  return !!ownTarget && target.host === ownTarget.host;
}

function localFallbackTarget(): EdgeTarget {
  const port = process.env.PORT || "3000";
  return { url: `http://127.0.0.1:${port}/api/public-status`, host: "127.0.0.1", scheme: "http" };
}

function normalizeTarget(raw: string): EdgeTarget | null {
  try {
    const url = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return {
      url: url.toString(),
      host: url.hostname,
      scheme: url.protocol === "https:" ? "https" : "http",
    };
  } catch {
    return null;
  }
}

export function discoverPublicTargets(): EdgeTarget[] {
  const urls = new Set<string>();
  for (const value of (process.env.PUBLIC_URLS ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    urls.add(value);
  }
  // Only monitor the operator's OWN public status URL when they've actually
  // configured one (CONTROL_STATUS_URL, or derivable from PUBLIC_HOSTNAME /
  // PUBLIC_BASE_URL / DASHBOARD_PUBLIC_URL), or when this really does look
  // like the known MIMULE host (existing production installs never set those
  // env vars and rely on the hardcoded default -- /opt/newsbites is a cheap,
  // reliable marker that this is that specific VPS, not just any install of
  // this software). Unconditionally adding DEFAULT_CONTROL_STATUS_URL would
  // make every fresh install of this software silently send outbound
  // DNS/TLS/HTTP probes at techinsiderbytes.com and report the results as if
  // they were this host's own edge health.
  const looksLikeKnownMimuleHost = existsSync("/opt/newsbites");
  const ownUrl = process.env.CONTROL_STATUS_URL
    || (process.env.PUBLIC_HOSTNAME ? `https://${process.env.PUBLIC_HOSTNAME}/api/public-status` : null)
    || (process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/public-status` : null)
    || (process.env.DASHBOARD_PUBLIC_URL ? `${process.env.DASHBOARD_PUBLIC_URL.replace(/\/$/, "")}/api/public-status` : null)
    || (looksLikeKnownMimuleHost ? DEFAULT_CONTROL_STATUS_URL : null);
  if (ownUrl) urls.add(ownUrl);

  const db = getDashboardDb();
  if (db) {
    try {
      const rows = db.query(`
        SELECT fingerprint_json
        FROM discovered_assets
        WHERE kind = 'backend'
        ORDER BY last_seen DESC
        LIMIT 100
      `).all() as Array<{ fingerprint_json: string }>;
      for (const row of rows) {
        try {
          const fp = JSON.parse(row.fingerprint_json) as { url?: unknown };
          if (typeof fp.url === "string" && /^https?:\/\//.test(fp.url)) urls.add(fp.url);
        } catch {
          // Ignore malformed asset fingerprints.
        }
      }
    } catch {
      // Fresh DBs or older installs may not have discovery assets yet.
    }
  }

  const out: EdgeTarget[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const target = normalizeTarget(raw);
    if (!target || seen.has(target.url)) continue;
    seen.add(target.url);
    out.push(target);
  }
  return out;
}

async function defaultHttpProbe(target: EdgeTarget): Promise<HttpProbeResult> {
  try {
    let res = await fetch(target.url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    if (res.status >= 400) {
      res = await fetch(target.url, { method: "GET", signal: AbortSignal.timeout(5000) });
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : "fetch failed" };
  }
}

async function defaultDnsProbe(target: EdgeTarget): Promise<DnsProbeResult> {
  try {
    const result = await lookup(target.host);
    return { ok: true, address: result.address };
  } catch (error) {
    return { ok: false, address: null, error: error instanceof Error ? error.message : "dns lookup failed" };
  }
}

async function defaultTlsProbe(target: EdgeTarget): Promise<TlsProbeResult> {
  if (target.scheme !== "https") return { daysRemaining: null, validTo: null };
  return new Promise((resolve) => {
    const socket = tls.connect({ host: target.host, port: 443, servername: target.host, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const validTo = typeof cert.valid_to === "string" ? cert.valid_to : null;
      const expiresAt = validTo ? Date.parse(validTo) : Number.NaN;
      resolve({
        daysRemaining: Number.isFinite(expiresAt) ? Math.floor((expiresAt - Date.now()) / 86_400_000) : null,
        validTo,
      });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ daysRemaining: null, validTo: null, error: "tls timeout" });
    });
    socket.on("error", (error) => resolve({ daysRemaining: null, validTo: null, error: error.message }));
  });
}

function defaultTunnelProbe(): TunnelProbeResult {
  try {
    const units = getServiceStatuses()
      .filter((service) => /cloudflared|tunnel/i.test(service.name))
      .map((service) => ({ name: service.name, status: service.status }));
    return {
      checked: units.length > 0,
      units: units.map((unit) => unit.name),
      downUnits: units.filter((unit) => unit.status !== "active").map((unit) => unit.name),
    };
  } catch {
    return { checked: false, units: [], downUnits: [] };
  }
}

async function defaultVastRunway(): Promise<VastRunway | null> {
  try {
    const [instance, account] = await Promise.all([getVastInstance(), getVastAccount()]);
    const balanceUsd = account?.balance ?? null;
    const creditUsd = account?.credit ?? null;
    const hourlyRateUsd = instance?.hourlyRate ?? null;
    const totalUsd = (balanceUsd ?? 0) + (creditUsd ?? 0);
    return {
      runwayHours: hourlyRateUsd && totalUsd > 0 ? totalUsd / hourlyRateUsd : null,
      balanceUsd,
      creditUsd,
      hourlyRateUsd,
      instanceStatus: instance?.status ?? null,
    };
  } catch {
    return null;
  }
}

function latestEdgeHttpWasOk(host: string): boolean {
  const db = getDashboardDb();
  if (!db) return false;
  try {
    const row = db.query(`
      SELECT value_json
      FROM metric_samples
      WHERE source = ? AND key = ?
      ORDER BY ts DESC
      LIMIT 1
    `).get("edge", `${host}.http`) as { value_json: string } | null;
    if (!row) return false;
    const value = JSON.parse(row.value_json) as { ok?: unknown };
    return value.ok === true;
  } catch {
    return false;
  }
}

function sampleEdge(sourceKey: string, value: Record<string, unknown>): void {
  try {
    writeMetricSample({ source: "edge", key: sourceKey, value });
  } catch {
    // Sampling must never block finding creation.
  }
}

export function mapHttpFinding(target: EdgeTarget, result: HttpProbeResult, now: number, wasPreviouslyOk = false): InsightInput[] {
  if (result.ok) return [];
  return [{
    id: `insight_edge_site_unreachable_${safeKey(target.host)}`,
    sourceKey: `edge:site-unreachable:${target.host}`,
    domain: "ops",
    severity: wasPreviouslyOk ? "critical" : "high",
    title: `${target.host} is unreachable`,
    plainSummary: `The public endpoint returned ${result.status ?? result.error ?? "no response"}. Check DNS, tunnel, TLS, and the service behind this public surface before users hit a silent outage.`,
    confidence: result.status === null ? 0.75 : 0.9,
    evidenceRefs: [evidence("Public endpoint", "api", target.url)],
    actionDescriptorId: null,
    manualPageHref: "/infra",
    createdAt: now,
  }];
}

export function mapCertFinding(target: EdgeTarget, result: TlsProbeResult, now: number): InsightInput[] {
  if (target.scheme !== "https" || result.daysRemaining === null || result.daysRemaining >= 14) return [];
  return [{
    id: `insight_edge_cert_expiring_${safeKey(target.host)}`,
    sourceKey: `edge:cert-expiring:${target.host}`,
    domain: "ops",
    severity: result.daysRemaining < 3 ? "critical" : "medium",
    title: `TLS certificate for ${target.host} is expiring`,
    plainSummary: `The certificate expires in ${result.daysRemaining} day(s). Renew it before browsers and API clients reject the public endpoint.`,
    confidence: 0.9,
    evidenceRefs: [evidence("TLS certificate", "api", `${target.host} valid_to=${result.validTo ?? "unknown"}`)],
    actionDescriptorId: null,
    manualPageHref: "/infra",
    createdAt: now,
  }];
}

export function mapDnsFinding(target: EdgeTarget, result: DnsProbeResult, now: number): InsightInput[] {
  if (result.ok) return [];
  return [{
    id: `insight_edge_dns_fail_${safeKey(target.host)}`,
    sourceKey: `edge:dns-fail:${target.host}`,
    domain: "ops",
    severity: "critical",
    title: `${target.host} does not resolve`,
    plainSummary: `DNS lookup failed for ${target.host}. Repair the public DNS record before health checks and users can reach the service.`,
    confidence: 0.9,
    evidenceRefs: [evidence("DNS lookup", "command", `lookup ${target.host}`)],
    actionDescriptorId: null,
    manualPageHref: "/infra",
    createdAt: now,
  }];
}

export function mapTunnelFinding(result: TunnelProbeResult, now: number): InsightInput[] {
  if (!result.checked || result.downUnits.length === 0) return [];
  return [{
    id: "insight_edge_tunnel_down",
    sourceKey: "edge:tunnel-down",
    domain: "ops",
    severity: "critical",
    title: "Public tunnel is down",
    plainSummary: `${result.downUnits.join(", ")} is not active. Restart or repair the tunnel before public endpoints become unreachable.`,
    confidence: 0.85,
    evidenceRefs: [evidence("Tunnel services", "api", result.units.join(", "))],
    actionDescriptorId: result.downUnits.includes("cloudflared") ? "start-job:service:cloudflared" : null,
    manualPageHref: "/infra",
    createdAt: now,
  }];
}

export function mapVastBalanceFinding(runway: VastRunway | null, now: number): InsightInput[] {
  if (!runway || runway.runwayHours === null || runway.runwayHours >= 24) return [];
  const severity: InsightSeverity = runway.runwayHours < 12 ? "critical" : "medium";
  return [{
    id: "insight_cost_vast_balance_low",
    sourceKey: "cost:vast-balance-low",
    domain: "cost",
    severity,
    title: "Vast.ai balance runway is low",
    plainSummary: `Vast runway is about ${Math.round(runway.runwayHours * 10) / 10}h at the current hourly rate. Add balance or reduce GPU burn before local model capacity disappears.`,
    confidence: 0.85,
    evidenceRefs: [evidence("Vast runway", "api", "/api/cost/runway/vast")],
    actionDescriptorId: null,
    manualPageHref: "/cost",
    createdAt: now,
  }];
}

function add(results: Insight[], input: InsightInput, emittedSourceKeys: string[]): void {
  const row = upsertInsight(input);
  if (row) {
    results.push(row);
    if (input.sourceKey) emittedSourceKeys.push(input.sourceKey);
  }
}

export async function runEdgeScan(): Promise<ScanResult> {
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  if (!getDashboardDb()) return { scannedAt, findings, resolvedCount: 0 };

  const descriptors: InsightInput[] = [];
  const collect = async (fn: () => InsightInput[] | Promise<InsightInput[]>): Promise<void> => {
    try {
      descriptors.push(...await fn());
    } catch (err) {
      console.error("[edge-scan] detector failed", err instanceof Error ? err.message : err);
    }
  };

  const discoverTargets = edgeProbeOverrides?.discoverTargets ?? discoverPublicTargets;
  const httpProbe = edgeProbeOverrides?.httpProbe ?? defaultHttpProbe;
  const tlsProbe = edgeProbeOverrides?.tlsProbe ?? defaultTlsProbe;
  const dnsProbe = edgeProbeOverrides?.dnsProbe ?? defaultDnsProbe;
  const tunnelProbe = edgeProbeOverrides?.tunnelProbe ?? defaultTunnelProbe;
  const vastRunway = edgeProbeOverrides?.vastRunway ?? defaultVastRunway;

  const targets = discoverTargets();
  for (const target of targets) {
    await collect(async () => {
      const previousOk = latestEdgeHttpWasOk(target.host);
      const result = await httpProbe(target);
      sampleEdge(`${target.host}.http`, { ok: result.ok, status: result.status, url: target.url });
      if (!result.ok && isOwnControlSurfaceTarget(target)) {
        const local = await httpProbe(localFallbackTarget());
        sampleEdge(`${target.host}.http-local-fallback`, { ok: local.ok, status: local.status });
        if (local.ok) return [];
      }
      return mapHttpFinding(target, result, scannedAt, previousOk);
    });
    await collect(async () => {
      const result = await dnsProbe(target);
      sampleEdge(`${target.host}.dns`, { ok: result.ok, address: result.address ?? null });
      return mapDnsFinding(target, result, scannedAt);
    });
    if (target.scheme === "https") {
      await collect(async () => {
        const result = await tlsProbe(target);
        sampleEdge(`${target.host}.tls`, { daysRemaining: result.daysRemaining, validTo: result.validTo });
        return mapCertFinding(target, result, scannedAt);
      });
    }
  }

  await collect(() => mapTunnelFinding(tunnelProbe(), scannedAt));
  await collect(async () => {
    const runway = await vastRunway();
    if (runway) {
      sampleEdge("vast.runway", runway as Record<string, unknown>);
    }
    return mapVastBalanceFinding(runway, scannedAt);
  });

  const emittedSourceKeys: string[] = [];
  for (const descriptor of descriptors) add(findings, descriptor, emittedSourceKeys);

  const resolved = [
    ...resolveStaleInsights("edge:", emittedSourceKeys, "The edge scanner confirmed this condition has cleared."),
    ...resolveStaleInsights("cost:vast-balance", emittedSourceKeys, "The Vast runway scanner confirmed runway is back above threshold."),
  ];
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: insight.sourceKey?.startsWith("cost:")
        ? "The Vast runway scanner confirmed runway is back above threshold."
        : "The edge scanner confirmed this condition has cleared.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }

  return { scannedAt, findings, resolvedCount: resolved.length };
}
