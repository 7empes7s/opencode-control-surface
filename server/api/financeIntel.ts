import { Database } from "bun:sqlite";
import { getObservabilityDb, initObservabilityDb } from "../db/observability.ts";
import { FinanceRunRow, PortfolioConfigRow, FinanceEnrichmentRow, LiteLLMRoutingLogRow } from "../db/observability.ts";
import { ok } from "./types.ts";

// Helper function to safely get DB connection
function getDb(): Database | null {
  try {
    return getObservabilityDb() ?? initObservabilityDb();
  } catch (error) {
    console.error("[finance-intel] DB connection failed:", error);
    return null;
  }
}

function mapFinanceRun(row: FinanceRunRow): Record<string, unknown> {
  return {
    ...row,
    runAt: row.run_at,
    articleCount: row.insights_count ?? 0,
    avgProcessingTimeMs: row.duration_ms ?? 0,
  };
}

function mapFinanceEnrichment(row: FinanceEnrichmentRow): Record<string, unknown> {
  return {
    ...row,
    articleSlug: row.article_slug,
    ticker: row.tickers_extracted ?? "",
    confidence: String(row.confidence ?? ""),
    enrichedAt: row.run_at,
  };
}

// GET /api/finance-intel/runs - Get recent finance runs
export async function getFinanceRuns(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "20");
  
  const db = getDb();
  if (!db) {
    return new Response(JSON.stringify({ error: "Database unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const runs = db.query<FinanceRunRow, [number]>(
      "SELECT * FROM finance_runs ORDER BY run_at DESC LIMIT ?"
    ).all(limit);

    return new Response(JSON.stringify(ok(runs.map(mapFinanceRun), {})), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[finance-intel] getFinanceRuns failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch finance runs" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// GET /api/finance-intel/enrichments - Get recent finance enrichments
export async function getFinanceEnrichments(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "50");
  
  const db = getDb();
  if (!db) {
    return new Response(JSON.stringify({ error: "Database unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const enrichments = db.query<FinanceEnrichmentRow, [number]>(
      "SELECT * FROM finance_enrichments ORDER BY run_at DESC LIMIT ?"
    ).all(limit);

    return new Response(JSON.stringify(ok(enrichments.map(mapFinanceEnrichment), {})), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[finance-intel] getFinanceEnrichments failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch finance enrichments" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// GET /api/finance-intel/routing-logs - Get recent LiteLLM routing logs
export async function getRoutingLogs(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "50");
  
  const db = getDb();
  if (!db) {
    return new Response(JSON.stringify({ error: "Database unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const logs = db.query<LiteLLMRoutingLogRow, [number]>(
      "SELECT * FROM litellm_routing_log WHERE logical_name LIKE '%finance%' ORDER BY logged_at DESC LIMIT ?"
    ).all(limit);

    return new Response(JSON.stringify(ok(logs, {})), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[finance-intel] getRoutingLogs failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch routing logs" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// GET /api/finance-intel/portfolio-configs - Get portfolio configurations
export async function getPortfolioConfigs(req: Request): Promise<Response> {
  const db = getDb();
  if (!db) {
    return new Response(JSON.stringify({ error: "Database unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const configs = db.query<PortfolioConfigRow, []>(
      "SELECT * FROM portfolio_configs ORDER BY created_at DESC"
    ).all();

    return new Response(JSON.stringify(ok({ portfolio: configs }, {})), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[finance-intel] getPortfolioConfigs failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch portfolio configs" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// POST /api/finance-intel/portfolio-configs - Create/update portfolio configuration
export async function upsertPortfolioConfig(req: Request): Promise<Response> {
  const db = getDb();
  if (!db) {
    return new Response(JSON.stringify({ error: "Database unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.json();
    const { 
      id, name, risk_tolerance, confidence_threshold, timeframe_pref, 
      watchlist, excluded_verticals, article_window_days, analyst_persona 
    } = body;

    // Validate required fields
    if (!name) {
      return new Response(JSON.stringify({ error: "Name is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const now = new Date().toISOString();
    
    // Upsert portfolio config
    db.query(`
      INSERT INTO portfolio_configs 
      (id, name, risk_tolerance, confidence_threshold, timeframe_pref, 
       watchlist, excluded_verticals, article_window_days, analyst_persona, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        risk_tolerance = ?, confidence_threshold = ?, timeframe_pref = ?,
        watchlist = ?, excluded_verticals = ?, article_window_days = ?,
        analyst_persona = ?, updated_at = ?
    `).run(
      id || crypto.randomUUID(), name, risk_tolerance || 5, confidence_threshold || 0.60, timeframe_pref || 'all',
      JSON.stringify(watchlist || []), JSON.stringify(excluded_verticals || []), article_window_days || 14, analyst_persona || '',
      now, now,
      risk_tolerance || 5, confidence_threshold || 0.60, timeframe_pref || 'all',
      JSON.stringify(watchlist || []), JSON.stringify(excluded_verticals || []), article_window_days || 14, analyst_persona || '',
      now
    );

    return new Response(JSON.stringify({ ...ok({ success: true }, {}), success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[finance-intel] upsertPortfolioConfig failed:", error);
    return new Response(JSON.stringify({ error: "Failed to save portfolio config" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// GET /api/finance-intel/stats - Get summary statistics
export async function getFinanceStats(req: Request): Promise<Response> {
  const db = getDb();
  if (!db) {
    return new Response(JSON.stringify({ error: "Database unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    // Get counts for various entities
    const runCountResult = db.query<{count: number}, []>("SELECT COUNT(*) as count FROM finance_runs").get();
    const runCount = runCountResult?.count || 0;
    
    const enrichmentCountResult = db.query<{count: number}, []>("SELECT COUNT(*) as count FROM finance_enrichments").get();
    const enrichmentCount = enrichmentCountResult?.count || 0;
    
    const configCountResult = db.query<{count: number}, []>("SELECT COUNT(*) as count FROM portfolio_configs").get();
    const configCount = configCountResult?.count || 0;
    
    // Get recent successful runs
    const recentRuns = db.query<{status: string, count: number}, []>(
      "SELECT status, COUNT(*) as count FROM finance_runs GROUP BY status"
    ).all();

    return new Response(JSON.stringify(ok({
      totalRuns: runCount,
      totalEnrichments: enrichmentCount,
      avgDurationMs: 0,
      activePortfolios: configCount,
      runCount,
      enrichmentCount,
      configCount,
      runStatusDistribution: recentRuns
    }, {})), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[finance-intel] getFinanceStats failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch stats" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// POST /api/finance-intel/trigger-analysis - Trigger a new finance analysis
export async function triggerAnalysis(req: Request): Promise<Response> {
  try {
    // In a real implementation, this would trigger the actual analysis
    // For now, return a success response
    return new Response(JSON.stringify({
      ...ok({
      success: true,
      message: "Analysis triggered successfully",
      jobId: crypto.randomUUID()
      }, {}),
      success: true,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[finance-intel] triggerAnalysis failed:", error);
    return new Response(JSON.stringify({ error: "Failed to trigger analysis" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
