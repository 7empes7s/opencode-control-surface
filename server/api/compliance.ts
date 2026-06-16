import { generateDpa, listSubprocessors, getSoc2Mapping } from "../compliance/generator.ts";
import { getTenantSettings } from "../tenancy/settings.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import { exportAuditLog } from "../governance/audit/export.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";

export function complianceDpaHandler(req: Request): Response {
  const ctx = getTenantContext(req);
  const url = new URL(req.url);
  const customerName = url.searchParams.get("customerName") ?? "Customer";
  const effectiveDate = url.searchParams.get("effectiveDate") ?? new Date().toISOString().split("T")[0];

  const dpa = generateDpa(ctx.tenantId, customerName, effectiveDate);
  const envelope: ApiEnvelope<{ document: string }> = ok({ document: dpa });
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export function complianceSubprocessorsHandler(): Response {
  const subproc = listSubprocessors();
  const envelope: ApiEnvelope<{ subprocessors: string[] }> = ok({ subprocessors: subproc });
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export function complianceSoc2MappingHandler(): Response {
  const mapping = getSoc2Mapping();
  const envelope: ApiEnvelope<{ mapping: Array<{ criteria: string; feature: string; notes: string }> }> =
    ok({ mapping });
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export function complianceSummaryHandler(req: Request): Response {
  const ctx = getTenantContext(req);
  const settings = getTenantSettings(ctx.tenantId);
  const subproc = listSubprocessors();
  const mapping = getSoc2Mapping();

  const summary = {
    tenantId: ctx.tenantId,
    dataResidencyRegion: settings.dataResidencyRegion,
    auditRetentionDays: settings.auditRetentionDays,
    requireTwoApprovers: settings.requireTwoApprovers,
    ssoRequired: settings.ssoRequired,
    subprocessorCount: subproc.length,
    soc2ControlCount: mapping.filter((m) =>
      m.criteria.startsWith("CC6") || m.criteria.startsWith("CC7") ||
      m.criteria.startsWith("CC8") || m.criteria.startsWith("CC9")
    ).length,
  };

  const envelope: ApiEnvelope<typeof summary> = ok(summary);
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function complianceEvidenceBundleHandler(
  req: Request,
): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ctx = getTenantContext(req);
  const db = getDashboardDb()!;
  
  // Get all the evidence components
  const settings = getTenantSettings(ctx.tenantId);
  const subproc = listSubprocessors();
  const mapping = getSoc2Mapping();
  const dpa = generateDpa(ctx.tenantId, "Customer", new Date().toISOString().split("T")[0]);
  
  // Get recent audit logs (last 30 days)
  const fromTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const toTs = Date.now();
  
  const auditLogs: string[] = [];
  for await (const chunk of exportAuditLog({ 
    tenantId: ctx.tenantId, 
    fromTs, 
    toTs, 
    format: "jsonl" 
  })) {
    auditLogs.push(chunk);
  }
  
  // Create a comprehensive evidence bundle
  const evidenceBundle = {
    generatedAt: new Date().toISOString(),
    tenantId: ctx.tenantId,
    components: {
      tenantSettings: settings,
      subprocessors: subproc,
      soc2Mapping: mapping,
      dpa: dpa,
      auditLogs: auditLogs.join(""),
      summary: {
        auditLogCount: auditLogs.length > 0 ? auditLogs.join("").split("\n").filter(line => line.trim()).length : 0,
        dateRange: { from: new Date(fromTs).toISOString(), to: new Date(toTs).toISOString() }
      }
    }
  };

  // Return as JSON download
  return new Response(JSON.stringify(evidenceBundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="evidence-bundle-${ctx.tenantId}-${Date.now()}.json"`,
    },
  });
}