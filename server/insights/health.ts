import { readFileSync } from "node:fs";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeMetricSample } from "../db/writer.ts";
import { computeTrustScore } from "../security/score.ts";
import { complete } from "../gateway/client.ts";
import type { Insight, InsightSeverity } from "./types.ts";

export type HealthDriver = {
  label: string;
  impact: number;
  link: string;
  filterKey?: string;
};

export type AdminHealthScore = {
  score: number;
  openCritical: number;
  openHigh: number;
  openMedium: number;
  productHealthFails: number;
  trustScore: number;
  stalePenalty: number;
  drivers: HealthDriver[];
  computedAt: number;
};

export type AdminHealthTrendPoint = { ts: number; score: number };

const HEALTH_PATH = "/var/lib/mimule/product-health.json";
const BRIEFING_RETRY_MS = 30 * 60 * 1000;
const BRIEFING_MODEL = "editorial-heavy";
const BRIEFING_CONFIG_PREFIX = "admin_state_of_stack_briefing:";

type ProductHealth = { score: number | null; fails: number; warns: number; findings: unknown[] };
export type AdminBriefing = {
  text: string;
  model: string;
  generatedAt: number;
  dateKey: string;
  source: "llm" | "fallback";
};
type AdminBriefingPromptContext = {
  recentHistory: string[];
  relatedFindings: string[];
};

function readProductHealth(): ProductHealth {
  try {
    return JSON.parse(readFileSync(HEALTH_PATH, "utf8")) as ProductHealth;
  } catch {
    return { score: null, fails: 0, warns: 0, findings: [] };
  }
}

function readOpenInsightsBySource(): { critical: number; high: number; medium: number; insights: Array<{ severity: InsightSeverity; title: string; sourceKey: string | null }> } {
  const db = getDashboardDb();
  if (!db) return { critical: 0, high: 0, medium: 0, insights: [] };
  try {
    const rows = db.query(
      `SELECT severity, title, source_key FROM insights WHERE status = 'open' ORDER BY created_at DESC`,
    ).all() as Array<{ severity: InsightSeverity; title: string; source_key: string | null }>;
    let critical = 0, high = 0, medium = 0;
    const insights = rows.map((r) => {
      if (r.severity === "critical") critical++;
      else if (r.severity === "high") high++;
      else if (r.severity === "medium") medium++;
      return { severity: r.severity, title: r.title, sourceKey: r.source_key };
    });
    return { critical, high, medium, insights };
  } catch {
    return { critical: 0, high: 0, medium: 0, insights: [] };
  }
}

export function computeAdminHealthScore(): AdminHealthScore {
  const { critical, high, medium } = readOpenInsightsBySource();
  const ph = readProductHealth();
  let trust = 100;
  try { trust = computeTrustScore().score; } catch { /* ignore */ }

  const productHealthFails = Math.min(ph.fails, 5);

  const critDeduction = Math.min(critical * 15, 45);
  const highDeduction = Math.min(high * 5, 25);
  const medDeduction = Math.min(medium * 2, 10);
  const phDeduction = productHealthFails * 3;
  const trustDeduction = Math.max(0, Math.round((100 - trust) / 10));

  // stale detector penalty: if DB enabled but no open insights and last metric sample for health is old
  let stalePenalty = 0;
  if (isDashboardDbEnabled()) {
    const db = getDashboardDb();
    if (db) {
      try {
        const lastSample = db.query(
          `SELECT ts FROM metric_samples WHERE source = 'health' AND key = 'admin_health_score' ORDER BY ts DESC LIMIT 1`,
        ).get() as { ts: number } | null;
        if (lastSample) {
          const ageMin = (Date.now() - lastSample.ts) / 60000;
          if (ageMin > 45) stalePenalty = 5;
        }
      } catch { /* ignore */ }
    }
  }

  const raw = 100 - critDeduction - highDeduction - medDeduction - phDeduction - trustDeduction - stalePenalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  const drivers: HealthDriver[] = [];
  if (critDeduction > 0) drivers.push({ label: `${critical} critical finding${critical > 1 ? "s" : ""}`, impact: -critDeduction, link: "/insights?status=open&severity=critical", filterKey: "critical" });
  if (highDeduction > 0) drivers.push({ label: `${high} high-severity finding${high > 1 ? "s" : ""}`, impact: -highDeduction, link: "/insights?status=open&severity=high", filterKey: "high" });
  if (medDeduction > 0) drivers.push({ label: `${medium} medium-severity finding${medium > 1 ? "s" : ""}`, impact: -medDeduction, link: "/insights?status=open&severity=medium", filterKey: "medium" });
  if (phDeduction > 0) drivers.push({ label: `${productHealthFails} product-health fail${productHealthFails > 1 ? "s" : ""}`, impact: -phDeduction, link: "/insights", filterKey: undefined });
  if (trustDeduction > 0) drivers.push({ label: `Security trust at ${trust}/100`, impact: -trustDeduction, link: "/security", filterKey: undefined });
  if (stalePenalty > 0) drivers.push({ label: "Detector scan overdue (>45 min)", impact: -stalePenalty, link: "/insights", filterKey: undefined });

  return {
    score,
    openCritical: critical,
    openHigh: high,
    openMedium: medium,
    productHealthFails,
    trustScore: trust,
    stalePenalty,
    drivers,
    computedAt: Date.now(),
  };
}

export function writeHealthSample(score: number): void {
  try {
    writeMetricSample({ source: "health", key: "admin_health_score", value: score });
  } catch { /* ignore */ }
}

export function getAdminHealthTrend(limit = 24): AdminHealthTrendPoint[] {
  const db = getDashboardDb();
  if (!db) return [];
  try {
    const rows = db.query(
      `SELECT ts, value_json FROM metric_samples WHERE source = 'health' AND key = 'admin_health_score' ORDER BY ts DESC LIMIT ?`,
    ).all(limit) as Array<{ ts: number; value_json: string }>;
    return rows
      .map((r) => ({ ts: r.ts, score: Number(JSON.parse(r.value_json)) }))
      .filter((r) => !Number.isNaN(r.score))
      .reverse();
  } catch {
    return [];
  }
}

// In-memory cache for the daily AI briefing (never blocks callers).
let briefingCache: AdminBriefing | null = null;
let briefingInFlight = false;
let lastBriefingAttemptAt = 0;

function getUtcDateKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function getBriefingConfigKey(dateKey = getUtcDateKey()): string {
  return `${BRIEFING_CONFIG_PREFIX}${dateKey}`;
}

function parseAdminBriefing(value: string | null | undefined): AdminBriefing | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AdminBriefing>;
    if (
      typeof parsed.text === "string" &&
      parsed.text.trim() &&
      typeof parsed.model === "string" &&
      typeof parsed.generatedAt === "number" &&
      typeof parsed.dateKey === "string" &&
      (parsed.source === "llm" || parsed.source === "fallback")
    ) {
      return {
        text: parsed.text,
        model: parsed.model,
        generatedAt: parsed.generatedAt,
        dateKey: parsed.dateKey,
        source: parsed.source,
      };
    }
  } catch { /* ignore malformed cache */ }
  return null;
}

function readPersistedAdminBriefing(dateKey = getUtcDateKey()): AdminBriefing | null {
  const db = isDashboardDbEnabled() ? getDashboardDb() : null;
  if (!db) return null;
  try {
    const row = db.query(
      `SELECT value_json FROM system_configs WHERE key = ?`,
    ).get(getBriefingConfigKey(dateKey)) as { value_json: string } | null;
    return parseAdminBriefing(row?.value_json);
  } catch {
    return null;
  }
}

function persistAdminBriefing(briefing: AdminBriefing): void {
  const db = isDashboardDbEnabled() ? getDashboardDb() : null;
  if (!db) return;
  try {
    db.query(
      `INSERT OR REPLACE INTO system_configs (key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?)`,
    ).run(getBriefingConfigKey(briefing.dateKey), JSON.stringify(briefing), Date.now(), "admin-briefing");
  } catch {
    // Briefing should never break the admin page.
  }
}

function buildFallbackAdminBriefing(score: AdminHealthScore, now = Date.now()): AdminBriefing {
  const driverText = score.drivers.length > 0
    ? score.drivers.slice(0, 2).map((driver) => driver.label).join("; ")
    : "no major score drivers are open";
  const posture = score.score >= 80 ? "stable" : score.score >= 55 ? "watch" : "degraded";
  const text = `State of the stack is ${posture}: Admin Health is ${score.score}/100 with ${score.openCritical} critical, ${score.openHigh} high, and ${score.openMedium} medium open findings. Top signal: ${driverText}.`;
  return {
    text,
    model: "local-summary",
    generatedAt: now,
    dateKey: getUtcDateKey(now),
    source: "fallback",
  };
}

function readAdminBriefingPromptContext(limit = 8): AdminBriefingPromptContext {
  const db = isDashboardDbEnabled() ? getDashboardDb() : null;
  if (!db) return { recentHistory: [], relatedFindings: [] };
  try {
    const recentRows = db.query(
      `SELECT domain, severity, title, status, source_key, created_at
       FROM insights
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(limit) as Array<{
      domain: string;
      severity: string;
      title: string;
      status: string;
      source_key: string | null;
      created_at: number;
    }>;
    const recentHistory = recentRows.map((row) => {
      const ageMin = Math.max(0, Math.round((Date.now() - row.created_at) / 60000));
      const source = row.source_key ? ` source=${row.source_key}` : "";
      return `${row.severity}/${row.domain}/${row.status}: ${row.title}${source} (${ageMin}m ago)`;
    });

    const relatedRows = db.query(
      `SELECT domain, severity, source_key, COUNT(*) AS count, MAX(created_at) AS last_seen
       FROM insights
       WHERE status = 'open'
       GROUP BY domain, severity, COALESCE(source_key, '')
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 5
           WHEN 'high' THEN 4
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 2
           ELSE 1
         END DESC,
         count DESC,
         last_seen DESC
       LIMIT ?`,
    ).all(limit) as Array<{
      domain: string;
      severity: string;
      source_key: string | null;
      count: number;
      last_seen: number;
    }>;
    const relatedFindings = relatedRows.map((row) => {
      const source = row.source_key ? `source=${row.source_key}` : "no source key";
      return `${row.count} open ${row.severity}/${row.domain} finding${row.count === 1 ? "" : "s"} (${source})`;
    });

    return { recentHistory, relatedFindings };
  } catch {
    return { recentHistory: [], relatedFindings: [] };
  }
}

export function getAdminBriefing(): AdminBriefing {
  const dateKey = getUtcDateKey();
  if (briefingCache?.dateKey === dateKey) {
    return briefingCache;
  }
  const persisted = readPersistedAdminBriefing(dateKey);
  if (persisted) {
    briefingCache = persisted;
    return persisted;
  }
  briefingCache = buildFallbackAdminBriefing(computeAdminHealthScore());
  return briefingCache;
}

export async function refreshAdminBriefingIfStale(): Promise<void> {
  const now = Date.now();
  if (briefingInFlight) return;
  const current = getAdminBriefing();
  if (current.source === "llm" && current.dateKey === getUtcDateKey(now)) return;
  if (now - lastBriefingAttemptAt < BRIEFING_RETRY_MS) return;
  briefingInFlight = true;
  lastBriefingAttemptAt = now;
  try {
    const hs = computeAdminHealthScore();
    const context = readAdminBriefingPromptContext();
    const prompt = [
      "You are a concise site-reliability advisor for an AI-operated media and software stack.",
      "Write a 2-3 sentence 'State of the Stack' briefing for the operator. Plain English only.",
      "Be specific about what's currently wrong and what's healthy. Use recent history and related findings to connect likely root causes. Avoid generic filler.",
      "",
      `Admin Health Score: ${hs.score}/100`,
      `Open findings: ${hs.openCritical} critical, ${hs.openHigh} high, ${hs.openMedium} medium`,
      `Product Health: ${hs.productHealthFails} fails`,
      `Security Trust: ${hs.trustScore}/100`,
      hs.drivers.length > 0 ? `Top drivers dragging score down: ${hs.drivers.map((d) => d.label).join("; ")}` : "No major score drivers right now.",
      "",
      context.recentHistory.length > 0 ? `Recent finding history:\n- ${context.recentHistory.join("\n- ")}` : "Recent finding history: none recorded.",
      "",
      context.relatedFindings.length > 0 ? `Related open finding clusters:\n- ${context.relatedFindings.join("\n- ")}` : "Related open finding clusters: none recorded.",
    ].join("\n");
    const res = await complete(BRIEFING_MODEL, [{ role: "user", content: prompt }], {
      maxTokens: 200,
      timeoutMs: 15_000,
      caller: "admin-briefing",
    });
    const text = (res.choices?.[0]?.message?.content ?? "").trim();
    if (text) {
      briefingCache = {
        text,
        model: res.model ?? BRIEFING_MODEL,
        generatedAt: now,
        dateKey: getUtcDateKey(now),
        source: "llm",
      };
      persistAdminBriefing(briefingCache);
    }
  } catch {
    // never block; stale cache or null is fine
  } finally {
    briefingInFlight = false;
  }
}

export function resetAdminBriefingCacheForTest(): void {
  briefingCache = null;
  briefingInFlight = false;
  lastBriefingAttemptAt = 0;
}
