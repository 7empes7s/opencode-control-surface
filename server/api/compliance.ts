import { generateDpa, listSubprocessors, getSoc2Mapping } from "../compliance/generator.ts";
import { getTenantSettings } from "../tenancy/settings.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import { exportAuditLog } from "../governance/audit/export.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { buildEvidenceZip } from "../compliance/zipPack.ts";
import { buildComplianceControlStatuses } from "../compliance/evidencePack.ts";

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
  const summary = buildComplianceControlStatuses(ctx.tenantId);

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

const EVIDENCE_PACK_DEFAULT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function parsePeriodValue(value: string | null): number | null | "invalid" {
  if (value === null) return null;
  if (value.trim() === "") return "invalid";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : "invalid";
}

export function complianceEvidenceZipHandler(req: Request): Response {
  const url = new URL(req.url);
  const rawFrom = parsePeriodValue(url.searchParams.get("from"));
  const rawTo = parsePeriodValue(url.searchParams.get("to"));
  if (rawFrom === "invalid" || rawTo === "invalid") {
    return new Response(JSON.stringify({ error: "from and to must be non-negative millisecond timestamps" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = Date.now();
  const periodEnd = rawTo ?? now;
  const periodStart = rawFrom ?? Math.max(0, periodEnd - EVIDENCE_PACK_DEFAULT_PERIOD_MS);
  if (periodStart > periodEnd) {
    return new Response(JSON.stringify({ error: "from must be less than or equal to to" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!isDashboardDbEnabled() || !getDashboardDb()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ctx = getTenantContext(req);
  let zip: Buffer;
  try {
    zip = buildEvidenceZip(periodStart, periodEnd);
  } catch {
    return new Response(JSON.stringify({ error: "Failed to build evidence pack" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  writeActionAudit({
    actorSource: "dashboard",
    actionKind: "compliance.evidence-pack",
    targetType: "compliance",
    targetId: `${periodStart}-${periodEnd}`,
    risk: "low",
    request: { period: { from: periodStart, to: periodEnd } },
    resultStatus: "success",
    resultJson: { bytes: zip.length },
  });

  const tenant = ctx.tenantId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const date = new Date(now).toISOString().slice(0, 10);
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="evidence-pack-${tenant}-${date}.zip"`,
    },
  });
}
