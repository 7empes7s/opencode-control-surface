import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import type { ModelTier } from "./config.ts";

export type GatewayCallRow = {
  id: number;
  ts: number;
  logical_model: string;
  resolved_model: string;
  backend: string;
  tier: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  cost_estimate_usd: number | null;
  success: number;   // 1 = true, 0 = false
  error_class: string | null;
  trace_id: string | null;
  caller: string | null;
};

export type LedgerEntry = {
  logicalModel: string;
  resolvedModel: string;
  backend: string;
  tier: ModelTier;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  costEstimateUsd: number | null;
  success: boolean;
  errorClass: string | null;
  traceId?: string | null;
  caller?: string | null;
};

export function writeLedgerEntry(entry: LedgerEntry): void {
  if (!isDashboardDbEnabled()) return;
  const db = getDashboardDb();
  if (!db) return;
  try {
    db.query(`
      INSERT INTO gateway_calls
        (ts, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens,
         latency_ms, cost_estimate_usd, success, error_class, trace_id, caller)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      entry.logicalModel,
      entry.resolvedModel,
      entry.backend,
      entry.tier,
      entry.promptTokens ?? null,
      entry.completionTokens ?? null,
      entry.latencyMs ?? null,
      entry.costEstimateUsd ?? null,
      entry.success ? 1 : 0,
      entry.errorClass ?? null,
      entry.traceId ?? null,
      entry.caller ?? null,
    );
  } catch (e) {
    console.error("[gateway] ledger write failed:", e);
  }
}

export function readLedger(options: { limit?: number; logicalModel?: string; onlyFailed?: boolean } = {}): GatewayCallRow[] {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const params: (string | number)[] = [];
  const wheres: string[] = [];
  if (options.logicalModel) { wheres.push("logical_model = ?"); params.push(options.logicalModel); }
  if (options.onlyFailed) { wheres.push("success = 0"); }
  const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = options.limit ?? 200;
  params.push(limit);
  try {
    return db.query(`SELECT * FROM gateway_calls ${where} ORDER BY ts DESC LIMIT ?`).all(...(params as Parameters<typeof db.query>)) as GatewayCallRow[];
  } catch {
    return [];
  }
}

export function ledgerStats(since?: number): {
  totalCalls: number;
  successRate: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byModel: Record<string, { calls: number; errors: number; costUsd: number }>;
} {
  if (!isDashboardDbEnabled()) return { totalCalls: 0, successRate: 1, totalCostUsd: 0, avgLatencyMs: 0, byModel: {} };
  const db = getDashboardDb();
  if (!db) return { totalCalls: 0, successRate: 1, totalCostUsd: 0, avgLatencyMs: 0, byModel: {} };
  try {
    const where = since ? `WHERE ts >= ${since}` : "";
    const rows = db.query(`
      SELECT logical_model, COUNT(*) as calls, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as errors,
             SUM(cost_estimate_usd) as cost, AVG(latency_ms) as avg_lat
      FROM gateway_calls ${where}
      GROUP BY logical_model
    `).all() as Array<{ logical_model: string; calls: number; errors: number; cost: number | null; avg_lat: number | null }>;

    const byModel: Record<string, { calls: number; errors: number; costUsd: number }> = {};
    let totalCalls = 0;
    let totalErrors = 0;
    let totalCost = 0;
    let totalLat = 0;

    for (const row of rows) {
      byModel[row.logical_model] = { calls: row.calls, errors: row.errors, costUsd: row.cost ?? 0 };
      totalCalls += row.calls;
      totalErrors += row.errors;
      totalCost += row.cost ?? 0;
      totalLat += (row.avg_lat ?? 0) * row.calls;
    }

    return {
      totalCalls,
      successRate: totalCalls > 0 ? (totalCalls - totalErrors) / totalCalls : 1,
      totalCostUsd: totalCost,
      avgLatencyMs: totalCalls > 0 ? totalLat / totalCalls : 0,
      byModel,
    };
  } catch {
    return { totalCalls: 0, successRate: 1, totalCostUsd: 0, avgLatencyMs: 0, byModel: {} };
  }
}
