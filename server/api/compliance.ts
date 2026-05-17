import { generateDpa, listSubprocessors, getSoc2Mapping } from "../compliance/generator.ts";
import { getTenantSettings } from "../tenancy/settings.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { ok, type ApiEnvelope } from "./types.ts";

export function complianceDpaHandler(req: Request): Response {
  const ctx = getTenantContext(req);
  const body = (req as any)._parsedUrl?.searchParams
    ? Object.fromEntries((req as any)._parsedUrl.searchParams)
    : {};
  const customerName = body.customerName ?? "Customer";
  const effectiveDate = body.effectiveDate ?? new Date().toISOString().split("T")[0];

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