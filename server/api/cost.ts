import { getDashboardDb } from "../db/dashboard.ts";
import { isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeMetricSample } from "../db/writer.ts";
import { getVastInstance, getVastAccount } from "../adapters/vast.ts";
import { getModelsDetail, type DiscoveryLogEntry } from "../adapters/models.ts";
import { getBudgetSpending } from "../governance/budgets.ts";

// Types based on the plan specification
export interface BudgetDefinition {
  id: string;
  scope_type: string;
  scope_id: string | null;
  tier: string;
  period: string;
  currency: string;
  amount_cents: number;
  warning_pct: number;
  critical_pct: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface CostEvent {
  id: string;
  ts: number;
  source: string;
  logical_model: string | null;
  provider: string | null;
  tier: string;
  workflow_type: string | null;
  workflow_id: string | null;
  project: string | null;
  article_slug: string | null;
  dossier_id: string | null;
  builder_run_id: string | null;
  gateway_call_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number;
  cost_basis: string;
  fallback_reason: string | null;
  metadata_json: string | null;
}

export interface ProviderPrice {
  id: string;
  provider: string;
  logical_model: string | null;
  tier: string;
  input_cents_per_1k: number | null;
  output_cents_per_1k: number | null;
  hourly_cents: number | null;
  effective_from: number;
  effective_to: number | null;
  source_note: string | null;
}

export interface SpendAnomaly {
  id: string;
  ts: number;
  scope_type: string;
  scope_id: string | null;
  baseline_cents: number;
  observed_cents: number;
  multiplier: number;
  status: string;
  alert_firing_id: string | null;
}

type CostAnomalyRow = {
  id: number;
  ts: number;
  kind: string;
  severity: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
  payload_json: string | null;
};

const COST_ANOMALY_EVENT_KINDS = [
  "vast.runway_warning",
  "vast.runway_critical",
  "vast.burn_spike",
  "cost.api_spend_spike",
  "routing.unexpected_cloud_usage",
];

function readRecentCostAnomalies(sinceTs: number, limit = 12) {
  const db = getDashboardDb();
  if (!db) return [];

  const placeholders = COST_ANOMALY_EVENT_KINDS.map(() => "?").join(", ");
  const rows = db.query(`
    SELECT id, ts, kind, severity, entity_type, entity_id, summary, payload_json
    FROM events
    WHERE ts >= ? AND kind IN (${placeholders})
    ORDER BY ts DESC
    LIMIT ?
  `).all(sinceTs, ...COST_ANOMALY_EVENT_KINDS, limit) as CostAnomalyRow[];

  return rows.map((row) => {
    let payload: unknown = null;
    if (row.payload_json) {
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        payload = null;
      }
    }

    return {
      id: String(row.id),
      ts: row.ts,
      kind: row.kind,
      severity: row.severity,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      payload,
    };
  });
}

// Helper function to get spend data
async function getSpendData(fromTs: number, toTs: number, groupBy: string) {
  const db = getDashboardDb();
  if (!db) {
    throw new Error("Database not available");
  }

  let query = `
    SELECT 
      SUM(cost_cents) as total_cents,
      COUNT(*) as event_count
  `;
  
  switch (groupBy) {
    case 'model':
      query += `, logical_model as group_value FROM cost_events WHERE ts >= ? AND ts <= ? GROUP BY logical_model`;
      break;
    case 'workflow':
      query += `, workflow_type as group_value FROM cost_events WHERE ts >= ? AND ts <= ? GROUP BY workflow_type`;
      break;
    case 'article':
      query += `, article_slug as group_value FROM cost_events WHERE ts >= ? AND ts <= ? GROUP BY article_slug`;
      break;
    case 'tier':
      query += `, tier as group_value FROM cost_events WHERE ts >= ? AND ts <= ? GROUP BY tier`;
      break;
    case 'provider':
      query += `, provider as group_value FROM cost_events WHERE ts >= ? AND ts <= ? GROUP BY provider`;
      break;
    default:
      query += `FROM cost_events WHERE ts >= ? AND ts <= ?`;
  }

  const stmt = db.prepare(query);
  return stmt.all(fromTs, toTs);
}

// Handler functions
export async function getBudgets(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const scope_type = url.searchParams.get("scope_type") || "";
    const period = url.searchParams.get("period") || "";

    const db = getDashboardDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    let query = "SELECT * FROM governance_budgets WHERE 1=1";
    const params: any[] = [];

    if (scope_type) {
      query += " AND scope = ?";
      params.push(scope_type);
    }

    if (period) {
      // Note: We might need to adjust this based on how period is stored
      // For now, assuming it's stored as a string like "monthly", "daily", etc.
    }

    const stmt = db.prepare(query);
    const budgets = stmt.all(...params);

    // Get spend data for each budget
    const now = Date.now();
    const fromTs = now - 30 * 24 * 60 * 60 * 1000; // Last 30 days
    const spendPromises = budgets.map(async (budget: any) => {
      const spendData = await getSpendData(fromTs, now, "workflow");
      return {
        budget,
        spend: spendData
      };
    });

    const budgetsWithSpend = await Promise.all(spendPromises);

    return Response.json({
      budgets: budgetsWithSpend.map(b => b.budget),
      spendByBudget: budgetsWithSpend.map(b => b.spend)
    });
  } catch (error) {
    console.error("getBudgets failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch budgets" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function createBudget(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const {
      scope_type,
      scope_id,
      tier,
      period,
      amount_cents,
      warning_pct = 0.8,
      critical_pct = 1.0
    } = body;

    if (!scope_type || !tier || !period || !amount_cents) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const db = getDashboardDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const id = `budget_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO governance_budgets 
      (id, scope, project_id, daily_cap_usd, monthly_cap_usd, warn_pct, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Convert cents to USD for the existing schema
    const amount_usd = amount_cents / 100;
    const daily_cap_usd = period === "daily" ? amount_usd : null;
    const monthly_cap_usd = period === "monthly" ? amount_usd : null;

    stmt.run(
      id,
      scope_type,
      scope_id || null,
      daily_cap_usd,
      monthly_cap_usd,
      warning_pct,
      now,
      now
    );

    // Fetch the created budget
    const budgetStmt = db.prepare("SELECT * FROM governance_budgets WHERE id = ?");
    const budget = budgetStmt.get(id);

    return Response.json({ budget });
  } catch (error) {
    console.error("createBudget failed:", error);
    return new Response(JSON.stringify({ error: "Failed to create budget" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function getSpend(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const from = parseInt(url.searchParams.get("from") || "0");
    const to = parseInt(url.searchParams.get("to") || "0");
    const group_by = url.searchParams.get("group_by") || "model";

    const fromTs = from || Date.now() - 30 * 24 * 60 * 60 * 1000; // Default to last 30 days
    const toTs = to || Date.now();

    const totals = await getSpendData(fromTs, toTs, "");
    const groups = await getSpendData(fromTs, toTs, group_by);

    return Response.json({
      totals,
      groups
    });
  } catch (error) {
    console.error("getSpend failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch spend data" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function getVastRunway(_req: Request): Promise<Response> {
  try {
    const [instance, account] = await Promise.all([getVastInstance(), getVastAccount()]);
    const totalUsd = ((account?.balance ?? 0) + (account?.credit ?? 0));
    const hourlyUsd = instance?.hourlyRate ?? null;
    const hourly_cents = hourlyUsd !== null ? Math.round(hourlyUsd * 100) : null;
    const balance_cents = Math.round(totalUsd * 100);
    const hours_remaining = hourlyUsd && totalUsd > 0 ? totalUsd / hourlyUsd : null;
    const days_remaining = hours_remaining !== null ? hours_remaining / 24 : null;

    return Response.json({
      hourly_cents,
      balance_cents,
      hours_remaining,
      days_remaining,
      last_checked_at: Date.now(),
      instance_status: instance?.status ?? null,
    });
  } catch (error) {
    console.error("getVastRunway failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch Vast runway" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function getAttribution(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const entityType = url.pathname.split("/").pop(); // Extract from /api/cost/attribution/:entityType/:entityId
    const entityId = url.searchParams.get("entityId") || "";

    if (!entityType || !entityId) {
      return new Response(JSON.stringify({ error: "Entity type and ID are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const db = getDashboardDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Query cost events for the entity
    let query = "SELECT * FROM cost_events WHERE ";
    const params: any[] = [];

    switch (entityType) {
      case "article":
        query += "article_slug = ?";
        params.push(entityId);
        break;
      case "dossier":
        query += "dossier_id = ?";
        params.push(entityId);
        break;
      case "builder-run":
        query += "builder_run_id = ?";
        params.push(entityId);
        break;
      default:
        return new Response(JSON.stringify({ error: "Unsupported entity type" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
    }

    const stmt = db.prepare(query);
    const events = stmt.all(...params) as Array<{ cost_cents: number | null }>;

    // Calculate totals
    const total_cents = events.reduce((sum, event) => sum + (event.cost_cents || 0), 0);

    return Response.json({
      entity: { type: entityType, id: entityId },
      events,
      totals: {
        total_cents,
        total_usd: total_cents / 100
      }
    });
  } catch (error) {
    console.error("getAttribution failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch attribution data" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function getFallbacks(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const from = parseInt(url.searchParams.get("from") || "0");
    const to = parseInt(url.searchParams.get("to") || "0");

    const fromTs = from || Date.now() - 30 * 24 * 60 * 60 * 1000; // Default to last 30 days
    const toTs = to || Date.now();

    const db = getDashboardDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stmt = db.prepare(`
      SELECT * FROM gateway_calls 
      WHERE ts >= ? AND ts <= ? AND success = 1 AND error_class IS NOT NULL
      ORDER BY ts DESC
    `);

    const fallbacks = stmt.all(fromTs, toTs);

    return Response.json({ fallbacks });
  } catch (error) {
    console.error("getFallbacks failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch fallback data" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

type GatewayRow = {
  logical_model: string | null;
  tier: string | null;
  total_cents: number;
  event_count: number;
};

export async function getRecommendations(_req: Request): Promise<Response> {
  const db = getDashboardDb();
  const recommendations: Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    estimated_savings_pct: number;
    impact: string;
  }> = [];

  if (db) {
    try {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

      // Group spend by model to find high-spend models and cloud vs local patterns
      const byModel = db.query<GatewayRow, [number]>(`
        SELECT logical_model, tier,
               COALESCE(SUM(cost_cents), 0) as total_cents,
               COUNT(*) as event_count
        FROM gateway_calls
        WHERE ts >= ?
        GROUP BY logical_model, tier
        ORDER BY total_cents DESC
        LIMIT 20
      `).all(thirtyDaysAgo);

      const totalCents = byModel.reduce((s, r) => s + r.total_cents, 0);
      const cloudRows = byModel.filter((r) => r.tier === "cloud" || r.tier === "cloud-fast" || r.tier === "cloud-heavy");
      const freeRows = byModel.filter((r) => r.tier === "free" || r.tier === "local");
      const cloudCents = cloudRows.reduce((s, r) => s + r.total_cents, 0);

      if (totalCents > 0 && cloudCents / totalCents > 0.5) {
        const savingsPct = Math.round((cloudCents / totalCents) * 0.4 * 100);
        recommendations.push({
          id: "rec_cloud_to_local",
          type: "model_optimization",
          title: "Shift more traffic to local/free models",
          description: `${Math.round((cloudCents / totalCents) * 100)}% of the last 30 days' spend went to cloud models. Routing lower-stakes tasks (research, summarise) to local free-tier models could reduce cloud spend by ~${savingsPct}%.`,
          estimated_savings_pct: savingsPct,
          impact: "high",
        });
      }

      const topCloud = cloudRows[0];
      const cheaperFree = freeRows[0];
      if (topCloud && cheaperFree && topCloud.total_cents > 0) {
        recommendations.push({
          id: "rec_top_model_swap",
          type: "model_optimization",
          title: `Consider cheaper alternative for ${topCloud.logical_model ?? "top model"}`,
          description: `${topCloud.logical_model ?? "Your top cloud model"} accounts for $${(topCloud.total_cents / 100).toFixed(2)} (${topCloud.event_count} calls). ${cheaperFree.logical_model ?? "A free-tier model"} handled ${cheaperFree.event_count} comparable calls at no cloud cost. Review whether all calls to the cloud model require that tier.`,
          estimated_savings_pct: 30,
          impact: "medium",
        });
      }

      // Flag high-fallback rate (error_class present on successful calls = fallback occurred)
      const fallbackRow = db.query<{ fallback_count: number }, [number]>(`
        SELECT COUNT(*) as fallback_count FROM gateway_calls
        WHERE ts >= ? AND success = 1 AND error_class IS NOT NULL
      `).get(thirtyDaysAgo);

      const totalRow = db.query<{ total: number }, [number]>(`
        SELECT COUNT(*) as total FROM gateway_calls WHERE ts >= ?
      `).get(thirtyDaysAgo);

      const fallbackCount = fallbackRow?.fallback_count ?? 0;
      const totalCount = totalRow?.total ?? 0;
      if (totalCount > 10 && fallbackCount / totalCount > 0.1) {
        recommendations.push({
          id: "rec_fallback_rate",
          type: "reliability",
          title: "High fallback rate detected",
          description: `${fallbackCount} of ${totalCount} gateway calls in the last 30 days hit a fallback path (${Math.round((fallbackCount / totalCount) * 100)}%). Investigate model-health.json for cooldowns piling up; clearing stale cooldowns may eliminate unnecessary cloud fallbacks.`,
          estimated_savings_pct: 10,
          impact: "medium",
        });
      }
    } catch (err) {
      console.warn("getRecommendations DB analysis failed:", err);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      id: "rec_no_data",
      type: "info",
      title: "No spend data yet",
      description: "Once gateway calls are recorded, cost optimisation recommendations will appear here based on actual usage patterns.",
      estimated_savings_pct: 0,
      impact: "none",
    });
  }

  return Response.json({ recommendations, model_used: "usage-analysis-v1" });
}

type BudgetRow = {
  id: string;
  scope: string;
  project_id: string | null;
  daily_cap_usd: number | null;
  monthly_cap_usd: number | null;
  warn_pct: number;
  created_at: number;
  updated_at: number;
};

type DiscoveryHistoryRow = {
  ts: number;
  event_ts: string;
  new_models_added: string[];
  total_model_count: number | null;
  source: string;
};

async function getRealRunway() {
  try {
    const [instance, account] = await Promise.all([getVastInstance(), getVastAccount()]);
    const totalUsd = ((account?.balance ?? 0) + (account?.credit ?? 0));
    const hourlyUsd = instance?.hourlyRate ?? null;
    return {
      hourly_cents: hourlyUsd !== null ? Math.round(hourlyUsd * 100) : null,
      balance_cents: Math.round(totalUsd * 100),
      hours_remaining: hourlyUsd && totalUsd > 0 ? totalUsd / hourlyUsd : null,
      days_remaining: hourlyUsd && totalUsd > 0 ? totalUsd / hourlyUsd / 24 : null,
      last_checked_at: Date.now(),
      instance_status: instance?.status ?? null,
    };
  } catch {
    return { hourly_cents: null, balance_cents: 0, hours_remaining: null, days_remaining: null, last_checked_at: Date.now(), instance_status: null };
  }
}

function persistModelDiscoveryEvents(): void {
  try {
    const detail = getModelsDetail();
    for (const entry of detail.discoveryLog.slice(-100)) {
      writeMetricSample({
        source: "model-discovery",
        key: "event",
        value: {
          eventTs: entry.ts,
          newModelsAdded: entry.newModelsAdded,
          totalModelCount: entry.totalModelCount,
          source: "model-discovery-log",
        },
      });
    }
  } catch {
    // Missing model-discovery-log.jsonl is expected on fresh installs.
  }
}

function readModelDiscoveryHistory(limit = 100): DiscoveryHistoryRow[] {
  const db = getDashboardDb();
  if (!db) return [];

  persistModelDiscoveryEvents();

  let rows: Array<{ ts: number; value_json: string }> = [];
  try {
    rows = db.query(`
      SELECT ts, value_json
      FROM metric_samples
      WHERE source = ? AND key = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all("model-discovery", "event", limit) as Array<{ ts: number; value_json: string }>;
  } catch {
    rows = [];
  }

  if (rows.length === 0) {
    try {
      rows = db.query(`
        SELECT ts, value_json
        FROM metric_samples
        WHERE source = ? AND key = ?
        ORDER BY ts DESC
        LIMIT ?
      `).all("models", "health", limit) as Array<{ ts: number; value_json: string }>;
      return rows.map((row) => {
        let total = 0;
        try {
          const value = JSON.parse(row.value_json) as { healthy?: unknown; degraded?: unknown; down?: unknown };
          total = Number(value.healthy ?? 0) + Number(value.degraded ?? 0) + Number(value.down ?? 0);
        } catch {
          total = 0;
        }
        return {
          ts: row.ts,
          event_ts: new Date(row.ts).toISOString(),
          new_models_added: [],
          total_model_count: Number.isFinite(total) ? total : null,
          source: "models-health-sample",
        };
      });
    } catch {
      return [];
    }
  }

  const seen = new Set<string>();
  const out: DiscoveryHistoryRow[] = [];
  for (const row of rows) {
    try {
      const value = JSON.parse(row.value_json) as {
        eventTs?: unknown;
        newModelsAdded?: unknown;
        totalModelCount?: unknown;
        source?: unknown;
      };
      const eventTs = typeof value.eventTs === "string" ? value.eventTs : new Date(row.ts).toISOString();
      if (seen.has(eventTs)) continue;
      seen.add(eventTs);
      out.push({
        ts: row.ts,
        event_ts: eventTs,
        new_models_added: Array.isArray(value.newModelsAdded) ? value.newModelsAdded.map(String) : [],
        total_model_count: typeof value.totalModelCount === "number" ? value.totalModelCount : null,
        source: typeof value.source === "string" ? value.source : "model-discovery",
      });
    } catch {
      // Ignore malformed samples.
    }
  }
  return out.slice(0, limit);
}

export interface CostHeadline {
  monthToDateCents: number | null;
  projectedMonthEndCents: number | null;
  savedVsPaidBaselineCents: number | null;
  freeShare: number | null;
}

const NULL_HEADLINE: CostHeadline = {
  monthToDateCents: null,
  projectedMonthEndCents: null,
  savedVsPaidBaselineCents: null,
  freeShare: null,
};

export function computeCostHeadline(now = Date.now()): CostHeadline {
  const db = getDashboardDb();
  if (!db) return { ...NULL_HEADLINE };

  try {
    const nowDate = new Date(now);
    const year = nowDate.getUTCFullYear();
    const month = nowDate.getUTCMonth();
    const monthStart = Date.UTC(year, month, 1);
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const elapsedDays = (now - monthStart) / (24 * 60 * 60 * 1000);

    const totalsRow = db.query<{ total_calls: number; total_usd: number | null; free_calls: number }, [number, number]>(`
      SELECT COUNT(*) as total_calls,
             SUM(cost_estimate_usd) as total_usd,
             SUM(CASE WHEN cost_estimate_usd = 0 THEN 1 ELSE 0 END) as free_calls
      FROM gateway_calls
      WHERE ts >= ? AND ts <= ?
    `).get(monthStart, now);

    const totalCalls = totalsRow?.total_calls ?? 0;
    if (totalCalls === 0) return { ...NULL_HEADLINE };

    const monthToDateCents = totalsRow?.total_usd == null ? null : Math.round(totalsRow.total_usd * 100);
    const projectedMonthEndCents = monthToDateCents === null || elapsedDays < 2
      ? null
      : Math.round((monthToDateCents / elapsedDays) * daysInMonth);
    const freeCalls = totalsRow?.free_calls ?? 0;
    const freeShare = freeCalls / totalCalls;

    let savedVsPaidBaselineCents: number | null = null;
    if (freeCalls === 0) {
      savedVsPaidBaselineCents = 0;
    } else {
      const baseline = db.query<{ input_cents_per_1k: number; output_cents_per_1k: number }, []>(`
        SELECT input_cents_per_1k, output_cents_per_1k
        FROM provider_price_catalog
        WHERE tier = 'cloud-paid' AND input_cents_per_1k IS NOT NULL AND output_cents_per_1k IS NOT NULL
        ORDER BY (input_cents_per_1k + output_cents_per_1k) ASC
        LIMIT 1
      `).get();

      const freeTokensRow = db.query<{ prompt_tokens: number | null; completion_tokens: number | null; missing_tokens: number }, [number, number]>(`
        SELECT SUM(prompt_tokens) as prompt_tokens,
               SUM(completion_tokens) as completion_tokens,
               SUM(CASE WHEN prompt_tokens IS NULL OR completion_tokens IS NULL THEN 1 ELSE 0 END) as missing_tokens
        FROM gateway_calls
        WHERE ts >= ? AND ts <= ? AND cost_estimate_usd = 0
      `).get(monthStart, now);

      // Never invent a number: savings need a paid baseline and token counts on every free call.
      if (baseline && freeTokensRow && freeTokensRow.missing_tokens === 0
        && freeTokensRow.prompt_tokens !== null && freeTokensRow.completion_tokens !== null) {
        savedVsPaidBaselineCents = Math.round(
          (freeTokensRow.prompt_tokens / 1000) * baseline.input_cents_per_1k
          + (freeTokensRow.completion_tokens / 1000) * baseline.output_cents_per_1k,
        );
      }
    }

    return { monthToDateCents, projectedMonthEndCents, savedVsPaidBaselineCents, freeShare };
  } catch {
    return { ...NULL_HEADLINE };
  }
}

export async function getCostSummary(_req: Request): Promise<Response> {
  const [runway] = await Promise.all([getRealRunway()]);

  if (!isDashboardDbEnabled()) {
    return Response.json({
      data: {
        headline: { ...NULL_HEADLINE },
        budgets: [],
        spend: { totals: [{ total_cents: 0, event_count: 0 }], groups: [] },
        runway,
        fallbacks: [],
        anomalies: [],
        discoveryHistory: [],
        note: "DASHBOARD_DB disabled",
      },
    });
  }

  try {
    const db = getDashboardDb();
    if (!db) {
      return Response.json({
        data: {
          headline: { ...NULL_HEADLINE },
          budgets: [],
          spend: { totals: [{ total_cents: 0, event_count: 0 }], groups: [] },
          runway,
          fallbacks: [],
          anomalies: [],
          discoveryHistory: [],
          note: "database unavailable",
        },
      });
    }

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    let budgets: BudgetRow[] = [];
    try {
      budgets = db.query("SELECT * FROM governance_budgets ORDER BY created_at DESC").all() as BudgetRow[];
    } catch { /* table may not exist */ }

    // Compute actual spend for each budget period
    const budgetsWithSpend = budgets.map((b) => {
      const spending = getBudgetSpending(b.scope === "project" ? "project" : "global", b.project_id ?? undefined);
      const dailyPct = b.daily_cap_usd ? spending.daily / b.daily_cap_usd : 0;
      const monthlyPct = b.monthly_cap_usd ? spending.monthly / b.monthly_cap_usd : 0;
      const capUsd = monthlyPct >= dailyPct ? b.monthly_cap_usd ?? b.daily_cap_usd ?? 0 : b.daily_cap_usd ?? b.monthly_cap_usd ?? 0;
      const capCents = Math.round(capUsd * 100);
      const usedCents = Math.round((monthlyPct >= dailyPct ? spending.monthly : spending.daily) * 100);
      const usagePct = capCents > 0 ? usedCents / capCents : 0;
      return {
        ...b,
        cap_cents: capCents,
        used_cents: usedCents,
        daily_used_cents: Math.round(spending.daily * 100),
        monthly_used_cents: Math.round(spending.monthly * 100),
        usage_pct: usagePct,
      };
    });

    let totalCents = 0;
    let eventCount = 0;
    try {
      const row = db.query<{total_cents: number, event_count: number}, [number]>(
        "SELECT COALESCE(SUM(cost_cents), 0) as total_cents, COUNT(*) as event_count FROM gateway_calls WHERE ts >= ?"
      ).get(thirtyDaysAgo);
      if (row) { totalCents = row.total_cents; eventCount = row.event_count; }
    } catch { /* cost_cents column may not exist */ }

    let spendGroups: unknown[] = [];
    try {
      spendGroups = db.query(
        `SELECT COALESCE(logical_model, 'unknown') as group_value, COALESCE(SUM(cost_cents), 0) as total_cents, COUNT(*) as event_count
         FROM gateway_calls WHERE ts >= ? GROUP BY COALESCE(logical_model, 'unknown') ORDER BY total_cents DESC LIMIT 20`
      ).all(thirtyDaysAgo) ?? [];
    } catch { /* column may not exist */ }

    let fallbacks: unknown[] = [];
    try {
      fallbacks = db.query(
        `SELECT * FROM gateway_calls WHERE ts >= ? AND success = 1 AND error_class IS NOT NULL ORDER BY ts DESC LIMIT 100`
      ).all(thirtyDaysAgo) ?? [];
    } catch { /* error_class may not exist */ }

    const anomalies = readRecentCostAnomalies(thirtyDaysAgo);

    return Response.json({
      data: {
        headline: computeCostHeadline(now),
        budgets: budgetsWithSpend,
        spend: {
          totals: [{ total_cents: totalCents, event_count: eventCount }],
          groups: spendGroups,
        },
        runway,
        fallbacks,
        anomalies,
        discoveryHistory: readModelDiscoveryHistory(),
      },
    });
  } catch (error) {
    console.error("getCostSummary failed:", error);
    return Response.json({
      data: {
        headline: { ...NULL_HEADLINE },
        budgets: [],
        spend: { totals: [{ total_cents: 0, event_count: 0 }], groups: [] },
        runway,
        fallbacks: [],
        anomalies: [],
        discoveryHistory: [],
        error: "Failed to fetch cost summary",
      },
    });
  }
}
