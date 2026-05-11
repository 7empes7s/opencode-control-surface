import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { ok, type ApiEnvelope } from "./types.ts";

export type EventRow = {
  id: number;
  ts: number;
  kind: string;
  severity: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  payload: unknown;
  dedupeKey: string | null;
};

export type EventsResponse = {
  events: EventRow[];
  degraded: boolean;
  reason?: string;
};

type DbEventRow = {
  id: number;
  ts: number;
  kind: string;
  severity: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
  payload_json: string | null;
  dedupe_key: string | null;
};

function response(data: EventsResponse): Response {
  const envelope: ApiEnvelope<EventsResponse> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 100;
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.max(1, Math.min(500, parsed));
}

function parseSince(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSeverity(value: string | null): "info" | "warn" | "error" | null {
  if (value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}

function parsePayload(payloadJson: string | null): unknown {
  if (!payloadJson) {
    return null;
  }

  try {
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

export async function eventsHandler(url: URL): Promise<Response> {
  try {
    const db = getDashboardDb();
    if (!isDashboardDbEnabled() || !db) {
      return response({ events: [], degraded: true, reason: "DASHBOARD_DB disabled" });
    }

    const limit = parseLimit(url.searchParams.get("limit"));
    const since = parseSince(url.searchParams.get("since"));
    const kind = url.searchParams.get("kind");
    const severity = parseSeverity(url.searchParams.get("severity"));
    const params: Array<string | number> = [since];
    let sql = `
      SELECT id, ts, kind, severity, entity_type, entity_id, summary, payload_json, dedupe_key
      FROM events
      WHERE ts > ?
    `;

    if (kind) {
      sql += " AND kind = ?";
      params.push(kind);
    }

    if (severity) {
      sql += " AND severity = ?";
      params.push(severity);
    }

    sql += " ORDER BY ts DESC LIMIT ?";
    params.push(limit);

    const rows = db.query(sql).all(...params) as DbEventRow[];
    const events = rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      kind: row.kind,
      severity: row.severity,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      payload: parsePayload(row.payload_json),
      dedupeKey: row.dedupe_key,
    }));

    return response({ events, degraded: false });
  } catch (error) {
    console.error("[events] query failed", error);
    return response({ events: [], degraded: true, reason: "events query failed" });
  }
}
