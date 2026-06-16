import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { readOperatorState, writeOperatorState } from "../db/writer.ts";
import type { ModelTier } from "./config.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export type GatewayCallRow = {
  id: number;
  ts: number;
  tenant_id: string;
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
    const tenantContext = getCurrentTenantContext();
    const ts = Date.now();
    
    // Write to gateway_calls table
    db.query(`
      INSERT INTO gateway_calls
        (ts, tenant_id, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens,
         latency_ms, cost_estimate_usd, success, error_class, trace_id, caller)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts,
      tenantContext.tenantId,
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
    
    // Write a cost_events row for every call that has token usage OR a cost estimate
    // (including 0 / unpriced). Free-first routing estimates $0 — those $0 rows are
    // the product story ("free-first keeps spend at zero") and they also keep
    // budget math honest (it runs against cost_events).
    const hasUsage = entry.promptTokens != null || entry.completionTokens != null;
    if (entry.costEstimateUsd !== null || hasUsage) {
      const costCents = Math.round((entry.costEstimateUsd ?? 0) * 100);
      const costBasis: string =
        entry.costEstimateUsd == null
          ? "unpriced"
          : entry.costEstimateUsd === 0
            ? "free-tier"
            : "litellm-cost-estimate";

      db.query(`
        INSERT INTO cost_events
          (id, ts, tenant_id, source, logical_model, provider, tier,
           input_tokens, output_tokens, cost_cents, cost_basis, fallback_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `cost_${ts}_${Math.random().toString(36).substr(2, 9)}`,
        ts,
        tenantContext.tenantId,
        "gateway",
        entry.logicalModel,
        entry.backend,
        entry.tier,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        costCents,
        costBasis,
        entry.errorClass ? "fallback-trigger" : null,
      );
    }
  } catch (e) {
    console.error("[gateway] ledger write failed:", e);
  }
}

export function readLedger(options: { limit?: number; logicalModel?: string; onlyFailed?: boolean } = {}): GatewayCallRow[] {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const tenantContext = getCurrentTenantContext();
  const params: (string | number)[] = [];
  const wheres: string[] = [];
  
  // Scope to tenant_id with back-compat for NULL values
  if (tenantContext.tenantId === "mimule") {
    wheres.push("(tenant_id = ? OR tenant_id IS NULL)");
  } else {
    wheres.push("tenant_id = ?");
  }
  params.push(tenantContext.tenantId);
  
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

export function backfillCostEventsOnce(): number {
  if (!isDashboardDbEnabled()) return 0;
  const db = getDashboardDb();
  if (!db) return 0;
  if (readOperatorState("cost_backfill_v1") !== null) return 0;

  const rows = db.query(`
    SELECT gc.id, gc.ts, gc.tenant_id, gc.logical_model, gc.resolved_model, gc.backend,
           gc.tier, gc.prompt_tokens, gc.completion_tokens, gc.cost_estimate_usd, gc.error_class
    FROM gateway_calls gc
    LEFT JOIN cost_events ce
      ON ce.tenant_id = gc.tenant_id
     AND ce.source = 'gateway-backfill'
     AND ce.gateway_call_id = CAST(gc.id AS TEXT)
    WHERE ce.id IS NULL
  `).all() as Array<{
    id: number;
    ts: number;
    tenant_id: string;
    logical_model: string;
    resolved_model: string;
    backend: string;
    tier: string;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cost_estimate_usd: number | null;
    error_class: string | null;
  }>;

  let inserted = 0;
  const insert = db.prepare(`
    INSERT INTO cost_events
      (id, ts, tenant_id, source, logical_model, provider, tier,
       input_tokens, output_tokens, cost_cents, cost_basis, fallback_reason, gateway_call_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    const costCents = Math.round((row.cost_estimate_usd ?? 0) * 100);
    const costBasis: string =
      row.cost_estimate_usd == null
        ? "unpriced"
        : row.cost_estimate_usd === 0
          ? "free-tier"
          : "litellm-cost-estimate";
    insert.run(
      `cost_backfill_${row.id}_${Math.random().toString(36).slice(2, 9)}`,
      row.ts,
      row.tenant_id,
      "gateway-backfill",
      row.logical_model,
      row.backend,
      row.tier,
      row.prompt_tokens,
      row.completion_tokens,
      costCents,
      costBasis,
      row.error_class ? "fallback-trigger" : null,
      String(row.id),
    );
    inserted += 1;
  }

  writeOperatorState("cost_backfill_v1", { ranAt: Date.now(), inserted });
  return inserted;
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
    const tenantContext = getCurrentTenantContext();
    const whereClause = since ? `WHERE ts >= ${since}` : "";
    const tenantWhere = tenantContext.tenantId === "mimule" 
      ? `(tenant_id = '${tenantContext.tenantId}' OR tenant_id IS NULL)` 
      : `tenant_id = '${tenantContext.tenantId}'`;
    const fullWhere = whereClause 
      ? `${whereClause} AND ${tenantWhere}` 
      : `WHERE ${tenantWhere}`;
      
    const rows = db.query(`
      SELECT logical_model, COUNT(*) as calls, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as errors,
             SUM(cost_estimate_usd) as cost, AVG(latency_ms) as avg_lat
      FROM gateway_calls ${fullWhere}
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
