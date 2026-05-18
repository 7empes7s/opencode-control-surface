import { getDashboardDb } from "../db/dashboard.ts";
import { isDashboardDbEnabled } from "../db/dashboard.ts";

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

export async function getVastRunway(req: Request): Promise<Response> {
  try {
    // For now, we'll return mock data
    // In a real implementation, this would fetch from Vast.ai API or system state
    const hourly_cents = 13.8; // $0.138/hr * 100 (in cents)
    const balance_cents = 5000; // $50 * 100 (in cents)
    const hours_remaining = balance_cents / hourly_cents;
    const days_remaining = hours_remaining / 24;
    const last_checked_at = Date.now();

    return Response.json({
      hourly_cents,
      balance_cents,
      hours_remaining,
      days_remaining,
      last_checked_at
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

export async function getRecommendations(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { scope_type, scope_id } = body;

    // Mock recommendations - in a real implementation, this would analyze usage patterns
    const recommendations = [
      {
        id: "rec_1",
        type: "model_optimization",
        title: "Switch to cheaper model for research tasks",
        description: "Consider using gemma4-26b-free instead of deepseek-v3 for research tasks to save ~40% cost",
        estimated_savings_pct: 40,
        impact: "low"
      },
      {
        id: "rec_2",
        type: "batch_processing",
        title: "Batch small requests",
        description: "Group small API calls into batches to reduce overhead and costs",
        estimated_savings_pct: 15,
        impact: "medium"
      }
    ];

    return Response.json({
      recommendations,
      model_used: "cost-recommender-v1"
    });
  } catch (error) {
    console.error("getRecommendations failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch recommendations" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function getCostSummary(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const db = getDashboardDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const budgets = db.query("SELECT * FROM governance_budgets ORDER BY created_at DESC").all();

    const spendTotalsRows = db.query<{total_cents: number, event_count: number}, [number]>(
      "SELECT COALESCE(SUM(cost_cents), 0) as total_cents, COUNT(*) as event_count FROM gateway_calls WHERE ts >= ?"
    ).get(thirtyDaysAgo);

    const spendGroupsRows = db.query<{total_cents: number, event_count: number, group_value: string}, [number]>(
      `SELECT COALESCE(SUM(cost_cents), 0) as total_cents, COUNT(*) as event_count,
              COALESCE(provider, 'unknown') as group_value
       FROM gateway_calls WHERE ts >= ?
       GROUP BY COALESCE(provider, 'unknown')
       ORDER BY total_cents DESC LIMIT 20`
    ).all(thirtyDaysAgo);

    const fallbackRows = db.query(
      `SELECT * FROM gateway_calls
       WHERE ts >= ? AND success = 1 AND error_class IS NOT NULL
       ORDER BY ts DESC LIMIT 100`
    ).all(thirtyDaysAgo);

    const runway = {
      hourly_cents: 138,
      balance_cents: 5000,
      hours_remaining: 36,
      days_remaining: 1.5,
      last_checked_at: now,
    };

    return Response.json({
      budgets,
      spend: {
        totals: [spendTotalsRows ?? { total_cents: 0, event_count: 0 }],
        groups: spendGroupsRows ?? [],
      },
      runway,
      fallbacks: fallbackRows ?? [],
    });
  } catch (error) {
    console.error("getCostSummary failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch cost summary" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}