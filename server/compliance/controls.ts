import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import type { TenantContext } from "../tenancy/context.ts";
import type { InsightSeverity } from "../insights/types.ts";

export const SCANNER_KEYS = [
  "security",
  "registry",
  "budget",
  "anomaly",
  "sentinelIncidents",
  "ops",
  "sla",
  "discovery",
  "edge",
  "governance",
  "build",
  "modelRoutes",
] as const;

export type ScannerKey = typeof SCANNER_KEYS[number];
export type ControlStatus = "pass" | "fail" | "error" | "not-covered";

export type ScannerControlBinding = {
  kind: "scanner";
  scanner: ScannerKey;
  failSeverity: "high" | "medium";
};

export type NotCoveredControlBinding = {
  kind: "not-covered";
  reason: string;
};

export type ControlDefinition = {
  id: string;
  name: string;
  description: string;
  category: string;
  frameworkRefs: string[];
  binding: ScannerControlBinding | NotCoveredControlBinding;
};

export const CONTROL_CATALOG: ControlDefinition[] = [
  {
    id: "security-posture",
    name: "Security posture",
    description: "Security controls and secret-handling signals are continuously checked for material exposure.",
    category: "Security",
    frameworkRefs: ["ISO 42001 Annex A.6.2", "SOC 2 CC6.1", "SOC 2 CC7.1"],
    binding: { kind: "scanner", scanner: "security", failSeverity: "high" },
  },
  {
    id: "agent-registry-integrity",
    name: "Agent registry integrity",
    description: "Observed actors are checked against the registered agent inventory and ownership records.",
    category: "Identity & access",
    frameworkRefs: ["ISO 42001 Annex A.5.2", "SOC 2 CC6.2"],
    binding: { kind: "scanner", scanner: "registry", failSeverity: "high" },
  },
  {
    id: "budget-guardrails",
    name: "Budget guardrails",
    description: "Configured AI spending budgets are monitored for material threshold breaches.",
    category: "Cost management",
    frameworkRefs: ["ISO 42001 Annex A.6.2", "SOC 2 CC7.2"],
    binding: { kind: "scanner", scanner: "budget", failSeverity: "high" },
  },
  {
    id: "anomaly-detection",
    name: "Anomaly detection",
    description: "Gateway usage and spend anomalies are detected against recent activity baselines.",
    category: "Monitoring",
    frameworkRefs: ["ISO 42001 Annex A.7.2", "SOC 2 CC7.2"],
    binding: { kind: "scanner", scanner: "anomaly", failSeverity: "medium" },
  },
  {
    id: "incident-detection",
    name: "Incident detection",
    description: "Sentinel health failures are converted into tracked operational incidents.",
    category: "Incident response",
    frameworkRefs: ["ISO 42001 Annex A.7.4", "SOC 2 CC7.3"],
    binding: { kind: "scanner", scanner: "sentinelIncidents", failSeverity: "high" },
  },
  {
    id: "ops-hygiene",
    name: "Operations hygiene",
    description: "Operational health, infrastructure, backup, and workflow hygiene are monitored.",
    category: "Operations",
    frameworkRefs: ["ISO 42001 Annex A.7.2", "SOC 2 CC7.1"],
    binding: { kind: "scanner", scanner: "ops", failSeverity: "high" },
  },
  {
    id: "sla-monitoring",
    name: "SLA monitoring",
    description: "Open incidents are monitored for SLA breaches and approaching deadlines.",
    category: "Incident response",
    frameworkRefs: ["ISO 42001 Annex A.7.4", "SOC 2 CC7.3"],
    binding: { kind: "scanner", scanner: "sla", failSeverity: "medium" },
  },
  {
    id: "shadow-ai-discovery",
    name: "Shadow AI discovery",
    description: "Observed AI assets are reconciled against the registered inventory.",
    category: "AI governance",
    frameworkRefs: ["ISO 42001 Annex A.6.1", "SOC 2 CC7.2"],
    binding: { kind: "scanner", scanner: "discovery", failSeverity: "high" },
  },
  {
    id: "edge-exposure",
    name: "Edge exposure",
    description: "Public endpoints, DNS, TLS, tunnels, and external availability are monitored.",
    category: "Security",
    frameworkRefs: ["ISO 42001 Annex A.6.2", "SOC 2 CC6.6", "SOC 2 CC7.1"],
    binding: { kind: "scanner", scanner: "edge", failSeverity: "high" },
  },
  {
    id: "governance-policy-monitoring",
    name: "Governance policy monitoring",
    description: "Governance policy signals, configuration checks, and compliance regressions are monitored.",
    category: "AI governance",
    frameworkRefs: ["ISO 42001 Annex A.5.3", "SOC 2 CC8.1"],
    binding: { kind: "scanner", scanner: "governance", failSeverity: "medium" },
  },
  {
    id: "build-pipeline-health",
    name: "Build pipeline health",
    description: "Builder and validation failures are monitored as delivery-control evidence.",
    category: "Engineering",
    frameworkRefs: ["ISO 42001 Annex A.8.2", "SOC 2 CC8.1"],
    binding: { kind: "scanner", scanner: "build", failSeverity: "high" },
  },
  {
    id: "model-route-truth",
    name: "Model route truth",
    description: "Active gateway routes are checked against observed route and builder telemetry.",
    category: "AI governance",
    frameworkRefs: ["ISO 42001 Annex A.6.2", "SOC 2 CC7.2"],
    binding: { kind: "scanner", scanner: "modelRoutes", failSeverity: "high" },
  },
  {
    id: "artifact-provenance-c2pa",
    name: "Artifact provenance (C2PA)",
    description: "C2PA artifact provenance coverage is declared but not currently verified.",
    category: "AI governance",
    frameworkRefs: ["ISO 42001 Annex A.6.1", "SOC 2 CC7.2"],
    binding: { kind: "not-covered", reason: "C2PA manifests inside generated artifacts are not verified" },
  },
  {
    id: "agent-identity-review",
    name: "Agent identity review",
    description: "Agent autonomy declarations and periodic human review are not yet implemented.",
    category: "Identity & access",
    frameworkRefs: ["ISO 42001 Annex A.5.2", "SOC 2 CC6.2"],
    binding: { kind: "not-covered", reason: "Agents have no declared autonomy level or periodic review" },
  },
  {
    id: "ai-provider-risk-register",
    name: "AI provider risk register",
    description: "AI-provider vendor risks are not yet recorded in a reviewed risk register.",
    category: "Third-party risk",
    frameworkRefs: ["ISO 42001 Annex A.6.1", "SOC 2 CC9.2"],
    binding: { kind: "not-covered", reason: "No vendor risk register for AI providers" },
  },
  {
    id: "external-saas-ai",
    name: "External SaaS AI",
    description: "External SaaS-layer AI is outside the declared coverage boundary.",
    category: "Scope",
    frameworkRefs: ["ISO 42001 Annex A.4.1", "SOC 2 CC3.2"],
    binding: { kind: "not-covered", reason: "SaaS-layer AI (S-X) is declared out of scope; no coverage claimed" },
  },
];

export type TickScannerSummary = {
  ran: boolean;
  error: boolean;
  findingsCount: number;
  maxSeverity: InsightSeverity | null;
};

export type ControlTickSummary = Record<ScannerKey, TickScannerSummary>;

export type ControlResult = {
  controlId: string;
  ts: number;
  status: ControlStatus;
  findingsCount: number;
  maxSeverity: InsightSeverity | null;
  warnings: number;
};

export type ControlHistoryRow = {
  id: number;
  controlId: string;
  ts: number;
  status: ControlStatus;
  findingsCount: number;
  maxSeverity: InsightSeverity | null;
  evidence: string | null;
};

export type CatalogControl = ControlDefinition & {
  status: ControlStatus | null;
  findingsCount: number;
  maxSeverity: InsightSeverity | null;
  lastCheckedAt: number | null;
  stale: boolean;
};

export type ControlCoverage = {
  total: number;
  automated: number;
  notCovered: number;
  percent: number;
};

export const CONTROL_RESULT_HEARTBEAT_MS = 60 * 60 * 1000;
export const CONTROL_RESULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const CONTROL_STALE_MS = 2 * 60 * 60 * 1000;
export const CONTROL_HISTORY_DEFAULT_LIMIT = 100;
export const CONTROL_HISTORY_MAX_LIMIT = 500;

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function isControlStatus(value: string): value is ControlStatus {
  return value === "pass" || value === "fail" || value === "error" || value === "not-covered";
}

function isInsightSeverity(value: string | null): value is InsightSeverity {
  return value === "info" || value === "low" || value === "medium" || value === "high" || value === "critical";
}

function meetsFailSeverity(maxSeverity: InsightSeverity | null, failSeverity: ScannerControlBinding["failSeverity"]): boolean {
  return maxSeverity !== null && SEVERITY_RANK[maxSeverity] >= SEVERITY_RANK[failSeverity];
}

export function evaluateControlTick(
  catalog: readonly ControlDefinition[],
  tickSummary: ControlTickSummary,
  now: number,
): ControlResult[] {
  const results: ControlResult[] = [];

  for (const control of catalog) {
    if (control.binding.kind === "not-covered") {
      results.push({
        controlId: control.id,
        ts: now,
        status: "not-covered",
        findingsCount: 0,
        maxSeverity: null,
        warnings: 0,
      });
      continue;
    }

    const summary = tickSummary[control.binding.scanner];
    if (!summary) continue;

    if (summary.error) {
      results.push({
        controlId: control.id,
        ts: now,
        status: "error",
        findingsCount: 0,
        maxSeverity: null,
        warnings: 0,
      });
      continue;
    }

    if (!summary.ran) continue;

    const failed = meetsFailSeverity(summary.maxSeverity, control.binding.failSeverity);
    results.push({
      controlId: control.id,
      ts: now,
      status: failed ? "fail" : "pass",
      findingsCount: Math.max(0, summary.findingsCount),
      maxSeverity: summary.maxSeverity,
      warnings: failed ? 0 : Math.max(0, summary.findingsCount),
    });
  }

  return results;
}

type StoredControlResultRow = {
  id: number;
  control_id: string;
  ts: number;
  status: string;
  findings_count: number;
  max_severity: string | null;
  evidence: string | null;
};

function evidenceFor(control: ControlDefinition, result: ControlResult): string {
  if (control.binding.kind === "not-covered") {
    return JSON.stringify({ reason: control.binding.reason });
  }
  return JSON.stringify({
    scanner: control.binding.scanner,
    failSeverity: control.binding.failSeverity,
    warnings: result.warnings,
  });
}

function toHistoryRow(row: StoredControlResultRow): ControlHistoryRow | null {
  if (!isControlStatus(row.status)) return null;
  return {
    id: Number(row.id),
    controlId: row.control_id,
    ts: Number(row.ts),
    status: row.status,
    findingsCount: Number(row.findings_count),
    maxSeverity: isInsightSeverity(row.max_severity) ? row.max_severity : null,
    evidence: row.evidence,
  };
}

function changedSinceLatest(latest: StoredControlResultRow | null, result: ControlResult, now: number): boolean {
  if (!latest) return true;
  return latest.status !== result.status
    || Number(latest.findings_count) !== result.findingsCount
    || latest.max_severity !== result.maxSeverity
    || now - Number(latest.ts) >= CONTROL_RESULT_HEARTBEAT_MS;
}

export function recordControlsTick(
  tickSummary: ControlTickSummary,
  now = Date.now(),
  ctx?: TenantContext,
): void {
  const db = getDashboardDb();
  if (!db) return;

  try {
    const tenant = whereTenant(ctx);
    const controlsById = new Map(CONTROL_CATALOG.map((control) => [control.id, control]));
    const latestFor = db.query(`
      SELECT id, control_id, ts, status, findings_count, max_severity, evidence
      FROM control_results
      WHERE control_id = ? ${tenant.clause}
      ORDER BY ts DESC, id DESC
      LIMIT 1
    `);
    const insert = db.query(`
      INSERT INTO control_results
        (tenant_id, control_id, ts, status, findings_count, max_severity, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let wrote = false;

    for (const result of evaluateControlTick(CONTROL_CATALOG, tickSummary, now)) {
      const control = controlsById.get(result.controlId);
      if (!control) continue;
      const latest = latestFor.get(result.controlId, ...tenant.params) as StoredControlResultRow | null;
      if (!changedSinceLatest(latest, result, now)) continue;

      insert.run(
        tenant.params[0],
        result.controlId,
        result.ts,
        result.status,
        result.findingsCount,
        result.maxSeverity,
        evidenceFor(control, result),
      );
      wrote = true;
    }

    if (wrote) {
      db.query(`DELETE FROM control_results WHERE ts < ? ${tenant.clause}`)
        .run(now - CONTROL_RESULT_RETENTION_MS, ...tenant.params);
    }
  } catch (error) {
    console.error("[controls] failed to record control tick", error);
  }
}

export function controlCoverage(catalog: readonly ControlDefinition[] = CONTROL_CATALOG): ControlCoverage {
  const automated = catalog.filter((control) => control.binding.kind === "scanner").length;
  const total = catalog.length;
  return {
    total,
    automated,
    notCovered: total - automated,
    percent: total === 0 ? 0 : Math.round((automated / total) * 100),
  };
}

export function listCatalogControls(now = Date.now(), ctx?: TenantContext): {
  controls: CatalogControl[];
  coverage: ControlCoverage;
} {
  const db = getDashboardDb();
  const tenant = whereTenant(ctx);
  const latestByControl = new Map<string, ControlHistoryRow>();

  if (db) {
    try {
      const placeholders = CONTROL_CATALOG.map(() => "?").join(", ");
      const rows = db.query(`
        SELECT id, control_id, ts, status, findings_count, max_severity, evidence
        FROM control_results
        WHERE control_id IN (${placeholders}) ${tenant.clause}
        ORDER BY control_id ASC, ts DESC, id DESC
      `).all(...CONTROL_CATALOG.map((control) => control.id), ...tenant.params) as StoredControlResultRow[];
      for (const row of rows) {
        if (latestByControl.has(row.control_id)) continue;
        const historyRow = toHistoryRow(row);
        if (historyRow) latestByControl.set(row.control_id, historyRow);
      }
    } catch (error) {
      console.error("[controls] failed to read control catalog", error);
    }
  }

  return {
    controls: CONTROL_CATALOG.map((control) => {
      const latest = latestByControl.get(control.id) ?? null;
      const automated = control.binding.kind === "scanner";
      return {
        ...control,
        status: latest?.status ?? null,
        findingsCount: latest?.findingsCount ?? 0,
        maxSeverity: latest?.maxSeverity ?? null,
        lastCheckedAt: latest?.ts ?? null,
        stale: automated && latest !== null && now - latest.ts > CONTROL_STALE_MS,
      };
    }),
    coverage: controlCoverage(),
  };
}

export function normalizeControlHistoryLimit(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return CONTROL_HISTORY_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return CONTROL_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(CONTROL_HISTORY_MAX_LIMIT, Math.floor(parsed)));
}

export function listControlHistory(
  controlId: string,
  limit: string | number | null | undefined = CONTROL_HISTORY_DEFAULT_LIMIT,
  ctx?: TenantContext,
): ControlHistoryRow[] {
  if (!CONTROL_CATALOG.some((control) => control.id === controlId)) return [];
  const db = getDashboardDb();
  if (!db) return [];

  try {
    const tenant = whereTenant(ctx);
    const rows = db.query(`
      SELECT id, control_id, ts, status, findings_count, max_severity, evidence
      FROM control_results
      WHERE control_id = ? ${tenant.clause}
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(controlId, ...tenant.params, normalizeControlHistoryLimit(limit)) as StoredControlResultRow[];
    return rows.map(toHistoryRow).filter((row): row is ControlHistoryRow => row !== null);
  } catch (error) {
    console.error("[controls] failed to read control history", error);
    return [];
  }
}
