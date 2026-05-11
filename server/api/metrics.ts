import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { ok, type ApiEnvelope } from "./types.ts";

export type MetricRow = { ts: number; source: string; key: string; value: unknown };
export type MetricRollup = {
  source: string;
  key: string;
  count: number;
  latestTs: number;
  latestValue: unknown;
  min?: number;
  max?: number;
  avg?: number;
  sum?: number;
  numericCount?: number;
  field?: string;
};
export type MetricsResponse = {
  samples: MetricRow[];
  rollup: MetricRollup[];
  degraded: boolean;
  reason?: string;
};

type DbMetricRow = {
  ts: number;
  source: string;
  key: string;
  value_json: string;
};

type DbRollupRow = {
  source: string;
  key: string;
  count: number;
  latestTs: number;
};

type NumericStats = {
  min: number;
  max: number;
  avg: number;
  sum: number;
  numericCount: number;
};

function response(data: MetricsResponse): Response {
  const envelope: ApiEnvelope<MetricsResponse> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

function parseSince(value: string | null): number {
  const fallback = Date.now() - 24 * 3600 * 1000;
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 200;
  if (!Number.isFinite(parsed)) {
    return 200;
  }
  return Math.max(1, Math.min(1000, parsed));
}

function parseValue(valueJson: string): unknown | undefined {
  try {
    return JSON.parse(valueJson);
  } catch (error) {
    console.error("[metrics] failed to parse value_json", error);
    return undefined;
  }
}

function readFieldValue(value: unknown, field: string): unknown {
  // An explicit empty field selects the root JSON value, allowing numeric scalar samples.
  if (field === "") {
    return value;
  }

  let current = value;
  for (const segment of field.split(".")) {
    if (
      !segment ||
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function calculateNumericStats(values: number[]): NumericStats | null {
  if (values.length === 0) {
    return null;
  }

  let min = values[0];
  let max = values[0];
  let sum = 0;

  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }

  return {
    min,
    max,
    avg: sum / values.length,
    sum,
    numericCount: values.length,
  };
}

export async function metricsHandler(url: URL): Promise<Response> {
  try {
    const db = getDashboardDb();
    if (!isDashboardDbEnabled() || !db) {
      return response({ samples: [], rollup: [], degraded: true, reason: "DASHBOARD_DB disabled" });
    }

    const source = url.searchParams.get("source");
    const key = url.searchParams.get("key");
    const field = url.searchParams.has("field") ? url.searchParams.get("field") ?? "" : null;
    const since = parseSince(url.searchParams.get("since"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const params: Array<string | number> = [since];
    let where = "WHERE ts > ?";

    if (source) {
      where += " AND source = ?";
      params.push(source);
    }

    if (key) {
      where += " AND key = ?";
      params.push(key);
    }

    const sampleRows = db.query(`
      SELECT ts, source, key, value_json
      FROM metric_samples
      ${where}
      ORDER BY ts DESC
      LIMIT ?
    `).all(...params, limit) as DbMetricRow[];

    const samples = sampleRows.flatMap((row) => {
      const value = parseValue(row.value_json);
      if (value === undefined) {
        return [];
      }

      return [{
        ts: row.ts,
        source: row.source,
        key: row.key,
        value,
      }];
    });

    const rollupRows = db.query(`
      SELECT source, key, count(*) AS count, max(ts) AS latestTs
      FROM metric_samples
      ${where}
      GROUP BY source, key
      ORDER BY source, key
    `).all(...params) as DbRollupRow[];

    const rollup = rollupRows.map((row) => {
      const latest = db.query(`
        SELECT value_json
        FROM metric_samples
        WHERE source = ? AND key = ? AND ts = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(row.source, row.key, row.latestTs) as { value_json: string };

      const latestValue = parseValue(latest.value_json) ?? null;
      const result: MetricRollup = {
        source: row.source,
        key: row.key,
        count: row.count,
        latestTs: row.latestTs,
        latestValue,
      };

      if (field !== null) {
        const numericRows = db.query(`
          SELECT value_json
          FROM metric_samples
          WHERE ts > ? AND source = ? AND key = ?
          ORDER BY ts DESC
        `).all(since, row.source, row.key) as Array<{ value_json: string }>;
        const numericValues = numericRows.flatMap((numericRow) => {
          const value = parseValue(numericRow.value_json);
          if (value === undefined) {
            return [];
          }

          const fieldValue = readFieldValue(value, field);
          return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? [fieldValue] : [];
        });
        const stats = calculateNumericStats(numericValues);

        if (stats) {
          result.min = stats.min;
          result.max = stats.max;
          result.avg = stats.avg;
          result.sum = stats.sum;
          result.numericCount = stats.numericCount;
          result.field = field;
        }
      }

      return result;
    });

    return response({ samples, rollup, degraded: false });
  } catch (error) {
    console.error("[metrics] query failed", error);
    return response({ samples: [], rollup: [], degraded: true, reason: "metrics query failed" });
  }
}
