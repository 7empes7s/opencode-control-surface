import { readFileSync } from "node:fs";
import { getDashboardDb } from "../db/dashboard.ts";
import { readSelfCorrection } from "./agent-team.ts";
import { computeTrustScore } from "../security/score.ts";

// Phase 5 — the numbers slide, from REAL sources (no invented figures):
//  - self-correction: builds audited / shipped / safely rolled back (the auditor catching bugs)
//  - builder runs: success / failed / canceled
//  - models: discovered + free-available (the affordability / free-first story)
//  - platform health: the sentinel's own live score
//  - uptime
const MODEL_HEALTH = "/var/lib/mimule/model-health.json";
const SENTINEL_HEALTH = "/var/lib/mimule/product-health.json";

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function isFreeModel(m: any): boolean {
  const tier = String(m?.pricingTier ?? "");
  const id = String(m?.modelId ?? "");
  return tier.includes("free") || id.includes("free") || m?.provider === "openrouter" || m?.provider === "groq" || m?.provider === "cerebras";
}

export function showcaseMetricsHandler(): Response {
  // Self-correction (auditor reviewing + rolling back)
  const sc = readSelfCorrection();

  // Builder runs
  const builds = { success: 0, failed: 0, canceled: 0, successRate: 0 };
  try {
    const db = getDashboardDb();
    if (db) {
      const rows = db.query("SELECT status, COUNT(*) as c FROM builder_runs GROUP BY status").all() as Array<{ status: string; c: number }>;
      for (const r of rows) {
        if (r.status === "success") builds.success = r.c;
        else if (r.status === "failed") builds.failed = r.c;
        else if (r.status === "canceled") builds.canceled = r.c;
      }
      const total = builds.success + builds.failed + builds.canceled;
      builds.successRate = total ? Math.round((builds.success / total) * 100) : 0;
    }
  } catch { /* keep defaults */ }

  // Models — affordability / free-first
  const mlist: any[] = readJson(MODEL_HEALTH)?.models ?? [];
  const models = {
    discovered: mlist.length,
    available: mlist.filter((m) => m.available).length,
    free: mlist.filter(isFreeModel).length,
    freeAvailable: mlist.filter((m) => m.available && isFreeModel(m)).length,
  };

  // Platform health — the sentinel's own live self-assessment
  const ph = readJson(SENTINEL_HEALTH);
  const health = {
    sentinelScore: ph?.score ?? null,
    fails: ph?.fails ?? null,
    warns: ph?.warns ?? null,
    checkedAt: ph?.checkedAtISO ?? null,
  };

  let uptimeSec = 0;
  try { uptimeSec = Math.floor(parseFloat(readFileSync("/proc/uptime", "utf8").split(" ")[0])); } catch { /* n/a */ }

  let ts: any = null;
  try { ts = computeTrustScore(); } catch { /* null on error */ }

  return Response.json({
    data: {
      // headline figures for the slide
      headline: {
        buildsAudited: sc.summary.audited,
        buildsShipped: sc.summary.shipped,
        buildsRolledBack: sc.summary.rolledBack,
        selfCorrectionCaught: sc.summary.rolledBack,
        selfCorrectionRate: sc.summary.audited > 0 ? Math.round((sc.summary.rolledBack / sc.summary.audited) * 100) : 0,
        headlineSentence: `${sc.summary.audited} builds audited — ${sc.summary.shipped} shipped, ${sc.summary.rolledBack} caught by the auditor and safely rolled back.`,
        modelsDiscovered: models.discovered,
        freeModelsAvailable: models.freeAvailable,
        platformHealth: health.sentinelScore,
        uptimeDays: Math.floor(uptimeSec / 86400),
        trustScore: ts?.score ?? null,
        trustScoreMax: ts?.maxScore ?? null,
      },
      selfCorrection: sc.summary,
      builds,
      models,
      health,
      uptimeSec,
      generatedAt: new Date().toISOString(),
    },
  });
}
