import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import { checkToken } from "./actions.ts";
import { tenantStore, getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant } from "../db/tenantScope.ts";

export type GatewayTraceCall = {
  ts: number;
  logicalModel: string;
  resolvedModel: string;
  latencyMs: number | null;
  tokens: number;
  success: boolean;
  errorClass: string | null;
};

export type GatewayTrace = {
  traceId: string | null;
  caller: string | null;
  calls: GatewayTraceCall[];
  totalLatencyMs: number;
  totalTokens: number;
  started: number;
};

export type GatewayTracesResponse = {
  traces: GatewayTrace[];
  windowMs: number;
  total: number;
  degraded: boolean;
  reason?: string;
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;

type DbRow = {
  id: number;
  ts: number;
  logical_model: string;
  resolved_model: string;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  success: number;
  error_class: string | null;
  trace_id: string | null;
  caller: string | null;
};

function json<T>(body: ApiEnvelope<T>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readGatewayCallsInWindow(sinceTs: number, limit: number): DbRow[] {
  const db = getDashboardDb();
  if (!db) return [];
  const tenantClause = whereTenant();
  const rows = db.query(
    `SELECT id, ts, logical_model, resolved_model, latency_ms, prompt_tokens, completion_tokens,
            success, error_class, trace_id, caller
     FROM gateway_calls
     WHERE ts >= ?${tenantClause.clause}
     ORDER BY ts DESC
     LIMIT ?`,
  ).all(sinceTs, ...tenantClause.params, limit) as DbRow[];
  return rows;
}

export function buildGatewayTraces(options: { sinceTs?: number; limit?: number } = {}): GatewayTracesResponse {
  const sinceTs = options.sinceTs ?? Date.now() - SEVEN_DAYS_MS;
  const limit = Math.max(1, Math.min(500, options.limit ?? DEFAULT_LIMIT));

  if (!isDashboardDbEnabled()) {
    return { traces: [], windowMs: Date.now() - sinceTs, total: 0, degraded: true, reason: "DASHBOARD_DB disabled" };
  }

  let rows: DbRow[];
  try {
    rows = readGatewayCallsInWindow(sinceTs, limit);
  } catch (error) {
    console.error("[traces] gateway_calls read failed:", error);
    return { traces: [], windowMs: Date.now() - sinceTs, total: 0, degraded: true, reason: "gateway_calls read error" };
  }

  // Group by trace_id when set, else each row is its own single-call group keyed by row id.
  const groups = new Map<string, { traceId: string | null; caller: string | null; calls: GatewayTraceCall[]; started: number }>();
  for (const row of rows) {
    const key = row.trace_id ?? `__row_${row.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        traceId: row.trace_id,
        caller: row.caller,
        calls: [],
        started: row.ts,
      };
      groups.set(key, group);
    }
    const prompt = row.prompt_tokens ?? 0;
    const completion = row.completion_tokens ?? 0;
    group.calls.push({
      ts: row.ts,
      logicalModel: row.logical_model,
      resolvedModel: row.resolved_model,
      latencyMs: row.latency_ms,
      tokens: prompt + completion,
      success: row.success === 1,
      errorClass: row.error_class,
    });
    if (row.ts < group.started) group.started = row.ts;
    if (row.caller && !group.caller) group.caller = row.caller;
  }

  const traces: GatewayTrace[] = [];
  for (const group of groups.values()) {
    let totalLatencyMs = 0;
    let totalTokens = 0;
    for (const call of group.calls) {
      totalLatencyMs += call.latencyMs ?? 0;
      totalTokens += call.tokens;
    }
    traces.push({
      traceId: group.traceId,
      caller: group.caller,
      calls: group.calls,
      totalLatencyMs,
      totalTokens,
      started: group.started,
    });
  }

  traces.sort((a, b) => {
    const aLatest = a.calls.reduce((m, c) => Math.max(m, c.ts), 0);
    const bLatest = b.calls.reduce((m, c) => Math.max(m, c.ts), 0);
    return bLatest - aLatest;
  });

  return { traces, windowMs: Date.now() - sinceTs, total: traces.length, degraded: false };
}

export function gatewayTracesHandler(req: Request, url: URL): Response {
  if (!checkToken(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const limitParam = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
  }

  let daysParam = 7;
  const daysRaw = url.searchParams.get("days");
  if (daysRaw) {
    const parsed = Number.parseInt(daysRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 30) daysParam = parsed;
  }
  const sinceTs = Date.now() - daysParam * 24 * 60 * 60 * 1000;

  const result = tenantStore.run(getCurrentTenantContext(), () =>
    buildGatewayTraces({ sinceTs, limit }),
  );

  return json(ok(result, { traces: result.degraded ? "stale" : "ok" }));
}
