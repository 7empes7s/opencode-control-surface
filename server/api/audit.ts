import { isDashboardDbEnabled } from "../db/dashboard.ts";
import { readActionAudit, type ActionAuditRow } from "../db/writer.ts";
import { ok, type ApiEnvelope } from "./types.ts";

export type ActionAuditResponse = {
  audit: ActionAuditRow[];
  degraded: boolean;
  reason?: string;
};

function response(data: ActionAuditResponse): Response {
  const envelope: ApiEnvelope<ActionAuditResponse> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 100;
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.max(1, Math.min(500, parsed));
}

export async function actionAuditHandler(url: URL): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return response({ audit: [], degraded: true, reason: "DASHBOARD_DB disabled" });
  }

  const audit = readActionAudit({
    limit: parseLimit(url.searchParams.get("limit")),
    targetType: url.searchParams.get("targetType") ?? undefined,
    resultStatus: url.searchParams.get("resultStatus") ?? undefined,
    actionKind: url.searchParams.get("actionKind") ?? undefined,
  });
  return response({ audit, degraded: false });
}
