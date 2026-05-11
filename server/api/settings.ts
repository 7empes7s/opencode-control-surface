import { readOperatorState, writeOperatorState } from "../db/writer.ts";
import { isDashboardDbEnabled } from "../db/dashboard.ts";
import { checkToken } from "./actions.ts";

export function settingsStateHandler(url: URL): Response {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ degraded: true, reason: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const key = url.searchParams.get("key");

  if (key) {
    const value = readOperatorState(key);
    return new Response(JSON.stringify({ key, value }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Return all entries (we'd need to query the DB for all keys - limited implementation)
  // For now return a subset of known keys
  const knownKeys = [
    "last_visit_ts",
    "today.reviewed",
    "snapshot.newsbites.articleCount",
    "snapshot.newsbites.articleCount.midnight",
    "snapshot.queueDepth",
    "snapshot.modelsCheckAt",
    "snapshot.vastRunwayHours"
  ];

  const entries: Array<{ key: string; value: unknown }> = [];
  for (const k of knownKeys) {
    const v = readOperatorState(k);
    if (v !== null) {
      entries.push({ key: k, value: v });
    }
  }

  return new Response(JSON.stringify({ entries }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function settingsStatePutHandler(req: Request, key: string): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ degraded: true, reason: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate key format
  if (!/^[a-z0-9._-]{1,80}$/.test(key)) {
    return new Response(JSON.stringify({ error: "invalid key format" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { value: unknown };
  try {
    body = await req.json() as { value: unknown };
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  writeOperatorState(key, body.value);

  return new Response(JSON.stringify({ ok: true, key, value: body.value }), {
    headers: { "Content-Type": "application/json" },
  });
}

export function settingsAuthStatusHandler(): Response {
  const tokenSet = Boolean(process.env.OPERATOR_TOKEN && process.env.OPERATOR_TOKEN.length > 0);
  const productionMode = tokenSet && process.env.NODE_ENV === "production";
  const dashboardDbEnabled = isDashboardDbEnabled();

  let note = "";
  if (!tokenSet) {
    note = "Operator token not configured - using dev mode (local requests allowed)";
  } else if (!productionMode) {
    note = "Operator token set but not in production mode";
  } else {
    note = "Production mode - operator token required for protected actions";
  }

  return new Response(JSON.stringify({
    tokenSet,
    productionMode,
    dashboardDbEnabled,
    cloudflareHeadersPresent: false,
    note
  }), {
    headers: { "Content-Type": "application/json" },
  });
}