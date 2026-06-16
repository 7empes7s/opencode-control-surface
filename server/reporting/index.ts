import type { ReportTemplate, ReportOutput } from "./types.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { runGatewayCallsReport } from "./templates/gateway-calls.ts";
import { runDeniedActionsReport } from "./templates/denied-actions.ts";
import { runSecretAccessesReport } from "./templates/secret-accesses.ts";
import { runUserActivityReport } from "./templates/user-activity.ts";
import { runChainVerifierReport } from "./templates/chain-verifier.ts";

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: "gateway-calls",
    name: "Gateway Calls",
    description: "All gateway API calls within the specified time range",
    params: {
      tenantId: { type: "string", required: true },
      fromTs: { type: "number", required: true },
      toTs: { type: "number", required: true },
    },
  },
  {
    id: "denied-actions",
    name: "Denied Actions",
    description: "All denied actions due to policy violations",
    params: {
      tenantId: { type: "string", required: true },
      fromTs: { type: "number", required: true },
      toTs: { type: "number", required: true },
    },
  },
  {
    id: "secret-accesses",
    name: "Secret Accesses",
    description: "All vault secret read operations",
    params: {
      tenantId: { type: "string", required: true },
      fromTs: { type: "number", required: true },
      toTs: { type: "number", required: true },
    },
  },
  {
    id: "user-activity",
    name: "User Activity",
    description: "Aggregated user activity counts and time ranges",
    params: {
      tenantId: { type: "string", required: true },
      fromTs: { type: "number", required: true },
      toTs: { type: "number", required: true },
    },
  },
  {
    id: "chain-verifier",
    name: "Chain Verifier",
    description: "Verifies hash chain integrity on audit rows within time range",
    params: {
      tenantId: { type: "string", required: true },
      fromTs: { type: "number", required: true },
      toTs: { type: "number", required: true },
    },
  },
  {
    id: "daily-pipeline",
    name: "Daily Pipeline",
    description: "Daily autopipeline activity grouped by action and result",
    params: {
      tenantId: { type: "string", required: true },
      fromTs: { type: "number", required: true },
      toTs: { type: "number", required: true },
    },
  },
  {
    id: "weekly-content-health",
    name: "Weekly Content Health",
    description: "Weekly content-health findings grouped by kind and severity",
    params: {
      tenantId: { type: "string", required: true },
      fromTs: { type: "number", required: true },
      toTs: { type: "number", required: true },
    },
  },
];

export async function runReport(
  templateId: string,
  params: { tenantId: string; fromTs: number; toTs: number },
): Promise<ReportOutput> {
  let rows: Record<string, unknown>[];

  switch (templateId) {
    case "gateway-calls":
      rows = await runGatewayCallsReport(params);
      break;
    case "denied-actions":
      rows = await runDeniedActionsReport(params);
      break;
    case "secret-accesses":
      rows = await runSecretAccessesReport(params);
      break;
    case "user-activity":
      rows = await runUserActivityReport(params);
      break;
    case "chain-verifier":
      rows = await runChainVerifierReport(params);
      break;
    case "daily-pipeline":
      rows = await runDailyPipelineReport(params);
      break;
    case "weekly-content-health":
      rows = await runWeeklyContentHealthReport(params);
      break;
    default:
      throw new Error(`Unknown template: ${templateId}`);
  }

  return {
    templateId,
    rows,
    rowCount: rows.length,
    generatedAt: Date.now(),
  };
}

async function runDailyPipelineReport(params: { tenantId: string; fromTs: number; toTs: number }): Promise<Record<string, unknown>[]> {
  const db = getDashboardDb();
  if (!db) return [];

  const rows = db.query(`
    SELECT
      action_kind,
      COALESCE(target_type, '') AS target_type,
      COALESCE(result_status, result, 'unknown') AS result_status,
      COUNT(*) AS action_count,
      MIN(ts) AS first_ts,
      MAX(ts) AS last_ts
    FROM action_audit
    WHERE tenant_id = ?
      AND ts >= ?
      AND ts <= ?
      AND (
        action_kind LIKE '%pipeline%'
        OR target_type = 'autopipeline'
        OR target LIKE '%pipeline%'
      )
    GROUP BY action_kind, target_type, result_status
    ORDER BY action_count DESC, last_ts DESC
  `).all(params.tenantId, params.fromTs, params.toTs);

  return rows as Record<string, unknown>[];
}

async function runWeeklyContentHealthReport(params: { tenantId: string; fromTs: number; toTs: number }): Promise<Record<string, unknown>[]> {
  const db = getDashboardDb();
  if (!db) return [];

  const rows = db.query(`
    SELECT
      kind,
      severity,
      COALESCE(entity_type, '') AS entity_type,
      COUNT(*) AS finding_count,
      COUNT(DISTINCT entity_id) AS entity_count,
      MIN(ts) AS first_ts,
      MAX(ts) AS last_ts
    FROM events
    WHERE tenant_id = ?
      AND ts >= ?
      AND ts <= ?
      AND (
        kind LIKE 'article.%'
        OR kind LIKE 'content.%'
        OR entity_type = 'article'
      )
    GROUP BY kind, severity, entity_type
    ORDER BY finding_count DESC, last_ts DESC
  `).all(params.tenantId, params.fromTs, params.toTs);

  return rows as Record<string, unknown>[];
}
