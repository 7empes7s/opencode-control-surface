import { getDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE_DAYS = 8;
const BASELINE_MIN_ACTIVE_DAYS = 3;
const CALL_MULTIPLIER = 3;
const CALL_FLOOR = 20;
const COST_MULTIPLIER = 3;
const COST_FLOOR_CENTS = 100;

type AnomalyScanResult = {
  scannedAt: number;
  anomalies: number;
};

type DailyRow = {
  logical_model: string;
  caller: string | null;
  day_start: number;
  calls: number;
  cost_cents: number;
};

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

export function runAnomalyScan(): AnomalyScanResult {
  const db = getDashboardDb();
  const scannedAt = Date.now();
  if (!db) return { scannedAt, anomalies: 0 };

  const tenant = whereTenant();
  const todayStart = startOfUtcDay(scannedAt);
  const baselineStart = todayStart - BASELINE_DAYS * ONE_DAY_MS;

  const rows = db.query(`
    SELECT
      logical_model,
      caller,
      CAST(ts / 86400000 AS INTEGER) * 86400000 AS day_start,
      COUNT(*) AS calls,
      COALESCE(SUM(COALESCE(cost_estimate_usd, 0)) * 100, 0) AS cost_cents
    FROM gateway_calls
    WHERE ts >= ? ${tenant.clause}
    GROUP BY logical_model, caller, day_start
  `).all(baselineStart, ...tenant.params) as Array<{
    logical_model: string;
    caller: string | null;
    day_start: number;
    calls: number;
    cost_cents: number;
  }>;

  if (rows.length === 0) return { scannedAt, anomalies: 0 };

  const byPair = new Map<string, DailyRow[]>();
  for (const row of rows) {
    const key = `${row.logical_model}\u0000${row.caller ?? ""}`;
    let bucket = byPair.get(key);
    if (!bucket) {
      bucket = [];
      byPair.set(key, bucket);
    }
    bucket.push({
      logical_model: row.logical_model,
      caller: row.caller,
      day_start: Number(row.day_start),
      calls: Number(row.calls),
      cost_cents: Number(row.cost_cents),
    });
  }

  const existingToday = new Set<string>();
  const existingRows = db.query(`
    SELECT scope_type, scope_id
    FROM spend_anomalies
    WHERE ts >= ? AND (${tenant.clause.replace(/^ AND /, "")})
  `).all(todayStart, ...tenant.params) as Array<{
    scope_type: string;
    scope_id: string | null;
  }>;
  for (const row of existingRows) {
    existingToday.add(`${row.scope_type}\u0000${row.scope_id ?? ""}`);
  }

  let inserted = 0;

  for (const bucket of byPair.values()) {
    const today = bucket.find((row) => row.day_start === todayStart);
    if (!today) continue;

    const baseline = bucket.filter((row) => row.day_start < todayStart && row.day_start >= baselineStart);
    if (baseline.length < BASELINE_MIN_ACTIVE_DAYS) continue;

    let baselineCallSum = 0;
    let baselineCostSum = 0;
    for (const day of baseline) {
      baselineCallSum += day.calls;
      baselineCostSum += day.cost_cents;
    }
    const baselineAvgCalls = baselineCallSum / baseline.length;
    const baselineAvgCents = baselineCostSum / baseline.length;

    const callsAnomaly = today.calls > baselineAvgCalls * CALL_MULTIPLIER && today.calls >= CALL_FLOOR;
    const costAnomaly = today.cost_cents > baselineAvgCents * COST_MULTIPLIER && today.cost_cents >= COST_FLOOR_CENTS;
    if (!callsAnomaly && !costAnomaly) continue;

    const caller = today.caller ?? "(unknown)";
    const scopeId = `${today.logical_model}|${caller}`;
    const dedupeKey = `cost:anomaly-scan\u0000${scopeId}`;
    if (existingToday.has(dedupeKey)) continue;

    const observedCents = today.cost_cents;
    const baselineCents = Math.max(baselineAvgCents, 0.01);
    const multiplier = observedCents / baselineCents;

    db.query(`
      INSERT OR IGNORE INTO spend_anomalies
        (id, tenant_id, ts, scope_type, scope_id, baseline_cents, observed_cents, multiplier, status)
      VALUES (?, ?, ?, 'cost:anomaly-scan', ?, ?, ?, ?, 'open')
    `).run(
      `spend_anomaly_${safeId(scopeId)}_${todayStart}`,
      tenant.params[0],
      scannedAt,
      scopeId,
      baselineCents,
      observedCents,
      multiplier,
    );

    existingToday.add(dedupeKey);
    inserted += 1;
  }

  return { scannedAt, anomalies: inserted };
}
