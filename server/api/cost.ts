import { getDashboardDb } from "../db/dashboard.ts";
import { isDashboardDbEnabled } from "../db/dashboard.ts";
import { getVastInstance, getVastAccount } from "../adapters/vast.ts";

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

export async function getCostSummary(_req: Request): Promise<Response> {
  const [runway] = await Promise.all([getRealRunway()]);

  if (!isDashboardDbEnabled()) {
    return Response.json({
      budgets: [],
      spend: { totals: [{ total_cents: 0, event_count: 0 }], groups: [] },
      runway,
      fallbacks: [],
      anomalies: [],
      note: "DASHBOARD_DB disabled",
    });
  }

  try {
    const db = getDashboardDb();
    if (!db) {
      return Response.json({
        budgets: [],
        spend: { totals: [{ total_cents: 0, event_count: 0 }], groups: [] },
        runway,
        fallbacks: [],
        anomalies: [],
        note: "database unavailable",
      });
    }

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const monthStartTs = monthStart.getTime();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayStartTs = dayStart.getTime();

    let budgets: BudgetRow[] = [];
    try {
      budgets = db.query("SELECT * FROM governance_budgets ORDER BY created_at DESC").all() as BudgetRow[];
    } catch { /* table may not exist */ }

    // Compute actual spend for each budget period
    const budgetsWithSpend = budgets.map((b) => {
      const capUsd = b.monthly_cap_usd ?? b.daily_cap_usd ?? 0;
      const capCents = Math.round(capUsd * 100);
      const periodStart = b.monthly_cap_usd ? monthStartTs : dayStartTs;
      let usedCents = 0;
      try {
        const row = db!.query<{ used: number }, [number]>(
          "SELECT COALESCE(SUM(cost_cents), 0) as used FROM gateway_calls WHERE ts >= ?"
        ).get(periodStart);
        usedCents = row?.used ?? 0;
      } catch { /* ignore */ }
      const usagePct = capCents > 0 ? usedCents / capCents : 0;
      return { ...b, cap_cents: capCents, used_cents: usedCents, usage_pct: usagePct };
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
      budgets: budgetsWithSpend,
      spend: {
        totals: [{ total_cents: totalCents, event_count: eventCount }],
        groups: spendGroups,
      },
      runway,
      fallbacks,
      anomalies,
    });
  } catch (error) {
    console.error("getCostSummary failed:", error);
    return Response.json({
      budgets: [],
      spend: { totals: [{ total_cents: 0, event_count: 0 }], groups: [] },
      runway,
      fallbacks: [],
      anomalies: [],
      error: "Failed to fetch cost summary",
    });
  }
}
