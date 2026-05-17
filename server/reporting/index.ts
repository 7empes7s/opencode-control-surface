import type { ReportTemplate, ReportOutput } from "./types.ts";
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