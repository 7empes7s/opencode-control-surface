import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { getServiceStatuses } from "../adapters/system.ts";

export type AgentKind = "runner" | "service" | "pipeline" | "workflow";
export type AgentRiskTier = "low" | "medium" | "high";
export type AgentStatus = "active" | "paused" | "retired";

export type RegisteredAgent = {
  id: string;
  name: string;
  kind: AgentKind;
  owner: string;
  purpose: string;
  riskTier: AgentRiskTier;
  status: AgentStatus;
  modelAccess: string[];
  aliases: string[];
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
  audit7d: number;
  spend30dUsd: number;
};

type AgentRow = {
  id: string;
  name: string;
  kind: AgentKind;
  owner: string;
  purpose: string;
  risk_tier: AgentRiskTier;
  status: AgentStatus;
  model_access: string;
  aliases_json: string;
  created_at: number;
  updated_at: number;
  tenant_id: string | null;
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

type SeedSpec = {
  id: string;
  name: string;
  kind: AgentKind;
  riskTier: AgentRiskTier;
  status: AgentStatus;
  aliases: string[];
  modelAccess: string;
  purpose: string;
};

const SEED_AGENTS: SeedSpec[] = [
  {
    id: "opencode-runner",
    name: "OpenCode Runner",
    kind: "runner",
    riskTier: "medium",
    status: "active",
    aliases: ["opencode"],
    modelAccess: "opencode-go/minimax-m3,opencode/nemotron-3-ultra-free",
    purpose: "Drives the OpenCode CLI as a coding runner; routes local coding tasks to the operator's preferred model.",
  },
  {
    id: "gemini-runner",
    name: "Gemini Runner",
    kind: "runner",
    riskTier: "medium",
    status: "active",
    aliases: ["gemini"],
    modelAccess: "google/gemini-3-flash-preview",
    purpose: "Drives the Gemini CLI as a coding runner; routes local coding tasks to Google's fast preview model.",
  },
  {
    id: "codex-runner",
    name: "Codex Runner",
    kind: "runner",
    riskTier: "medium",
    status: "paused",
    aliases: ["codex"],
    modelAccess: "",
    purpose: "Drives the Codex CLI as a coding runner; currently paused because the upstream quota is exhausted.",
  },
  {
    id: "product-sentinel",
    name: "Product Sentinel",
    kind: "service",
    riskTier: "low",
    status: "active",
    aliases: ["system", "sentinel"],
    modelAccess: "",
    purpose: "Probes the live product every 30 minutes and reports a single Product Health score for the dashboard.",
  },
  {
    id: "insights-scanner",
    name: "Insights Scanner",
    kind: "service",
    riskTier: "low",
    status: "active",
    aliases: ["system"],
    modelAccess: "",
    purpose: "Scans for cost, security, and build findings and auto-resolves insights whose source signal has cleared.",
  },
  {
    id: "reasoner",
    name: "Reasoner",
    kind: "service",
    riskTier: "medium",
    status: "active",
    aliases: ["reasoner"],
    modelAccess: "",
    purpose: "Diagnoses failed builder passes, clusters them into incidents, and proposes playbooks to recover runs.",
  },
  {
    id: "autopipeline",
    name: "NewsBites Autopipeline",
    kind: "pipeline",
    riskTier: "medium",
    status: "active",
    aliases: ["autopipeline", "operator-bootstrap"],
    modelAccess: "editorial-cloud-heavy,editorial-cloud-fast",
    purpose: "Runs the NewsBites editorial pipeline end-to-end: research, write, verify, scout, rank, and publish-prep.",
  },
];

function parseAliases(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function splitModels(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapRow(row: AgentRow): Omit<RegisteredAgent, "lastSeenAt" | "audit7d" | "spend30dUsd"> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    owner: row.owner,
    purpose: row.purpose,
    riskTier: row.risk_tier,
    status: row.status,
    modelAccess: splitModels(row.model_access),
    aliases: parseAliases(row.aliases_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectColumns(includeTenant: boolean): string {
  const cols = [
    "id", "name", "kind", "owner", "purpose", "risk_tier", "status",
    "model_access", "aliases_json", "created_at", "updated_at",
  ];
  if (includeTenant) cols.push("tenant_id");
  return cols.join(", ");
}

function listRows(): AgentRow[] {
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant();
  return db.query(`
    SELECT ${selectColumns(false)} FROM agents WHERE 1=1 ${tenant.clause}
    ORDER BY kind, name
  `).all(...tenant.params) as AgentRow[];
}

function buildAliasInClause(aliases: string[]): { sql: string; params: string[] } {
  if (aliases.length === 0) {
    return { sql: "1=0", params: [] };
  }
  const placeholders = aliases.map(() => "?").join(",");
  return { sql: `actor IN (${placeholders})`, params: aliases };
}

function buildCallerInClause(aliases: string[]): { sql: string; params: string[] } {
  if (aliases.length === 0) {
    return { sql: "1=0", params: [] };
  }
  const placeholders = aliases.map(() => "?").join(",");
  return { sql: `caller IN (${placeholders})`, params: aliases };
}

function readLastSeenForAliases(aliases: string[]): { ts: number | null; audit7d: number } {
  const db = getDashboardDb();
  if (!db || aliases.length === 0) return { ts: null, audit7d: 0 };
  const aliasClause = buildAliasInClause(aliases);
  const tenant = whereTenant();
  const now = Date.now();
  const sevenDaysAgo = now - SEVEN_DAYS_MS;

  const lastRow = db.query(`
    SELECT MAX(ts) AS last_ts FROM action_audit
    WHERE ${aliasClause.sql} ${tenant.clause}
  `).get(...aliasClause.params, ...tenant.params) as { last_ts: number | null } | null;

  const auditRow = db.query(`
    SELECT COUNT(*) AS count FROM action_audit
    WHERE ${aliasClause.sql} AND ts >= ? ${tenant.clause}
  `).get(...aliasClause.params, sevenDaysAgo, ...tenant.params) as { count: number } | null;

  return {
    ts: lastRow?.last_ts ?? null,
    audit7d: auditRow?.count ?? 0,
  };
}

function readSpendForAliases(aliases: string[]): number {
  const db = getDashboardDb();
  if (!db || aliases.length === 0) return 0;
  const callerClause = buildCallerInClause(aliases);
  const tenant = whereTenant();
  const thirtyDaysAgo = Date.now() - THIRTY_DAYS_MS;

  const row = db.query(`
    SELECT COALESCE(SUM(cost_estimate_usd), 0) AS total
    FROM gateway_calls
    WHERE ${callerClause.sql} AND ts >= ? ${tenant.clause}
  `).get(...callerClause.params, thirtyDaysAgo, ...tenant.params) as { total: number | null } | null;

  return row?.total ?? 0;
}

function enrich(row: AgentRow): RegisteredAgent {
  const base = mapRow(row);
  const matchSet = [base.id, ...base.aliases];
  const { ts, audit7d } = readLastSeenForAliases(matchSet);
  const spend = readSpendForAliases(matchSet);
  return {
    ...base,
    lastSeenAt: ts,
    audit7d,
    spend30dUsd: Number(spend.toFixed(6)),
  };
}

// Some seed rows describe agents that only exist because an *external*
// MIMULE-specific service is installed on this host (e.g. the NewsBites
// autopipeline systemd unit). This map is consulted ONLY on first-ever seed
// (INSERT OR IGNORE is a no-op on hosts that already have the row, so this
// never touches the real production DB's existing state) -- on a fresh host
// with no such unit discoverable, seed the honest "paused" status instead of
// unconditionally claiming "active" for infrastructure that isn't there.
const SEED_STATUS_REQUIRES_UNIT: Partial<Record<string, string>> = {
  autopipeline: "newsbites-autopipeline",
};

function resolveSeedStatus(spec: SeedSpec): AgentStatus {
  const requiredUnit = SEED_STATUS_REQUIRES_UNIT[spec.id];
  if (!requiredUnit || spec.status !== "active") return spec.status;
  try {
    const pill = getServiceStatuses().find((p) => p.name === requiredUnit);
    return pill?.status === "active" ? "active" : "paused";
  } catch {
    return "paused";
  }
}

export function seedDefaultAgents(): number {
  const db = getDashboardDb();
  if (!db) return 0;

  const tenantId = getCurrentTenantContext().tenantId;
  const now = Date.now();
  let inserted = 0;

  const stmt = db.query(`
    INSERT OR IGNORE INTO agents
      (id, name, kind, owner, purpose, risk_tier, status, model_access, aliases_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const spec of SEED_AGENTS) {
    const result = stmt.run(
      spec.id,
      spec.name,
      spec.kind,
      "marouane",
      spec.purpose,
      spec.riskTier,
      resolveSeedStatus(spec),
      spec.modelAccess,
      JSON.stringify(spec.aliases),
      now,
      now,
      tenantId,
    );
    if (result.changes > 0) inserted += 1;
  }

  return inserted;
}

export function listAgents(): RegisteredAgent[] {
  return listRows().map(enrich);
}

export function getAgent(id: string): RegisteredAgent | null {
  const db = getDashboardDb();
  if (!db) return null;
  const tenant = whereTenant();
  const row = db.query(`
    SELECT ${selectColumns(false)} FROM agents WHERE id = ? ${tenant.clause}
  `).get(id, ...tenant.params) as AgentRow | null;
  return row ? enrich(row) : null;
}

export type AgentRecentAuditRow = {
  ts: number;
  action: string | null;
  targetType: string | null;
  targetId: string | null;
  resultStatus: string | null;
  reason: string | null;
};

export type AgentPassport = {
  agent: RegisteredAgent;
  recentAudit: AgentRecentAuditRow[];
  gateway: { calls30d: number; spend30dUsd: number; lastCallAt: number | null };
};

export function getAgentPassport(id: string): AgentPassport | null {
  const db = getDashboardDb();
  if (!db) return null;
  const tenant = whereTenant();

  const row = db.query(`
    SELECT ${selectColumns(false)} FROM agents WHERE id = ? ${tenant.clause}
  `).get(id, ...tenant.params) as AgentRow | null;
  if (!row) return null;

  const base = mapRow(row);
  const matchSet = [base.id, ...base.aliases];
  const { ts: lastSeenAt, audit7d } = readLastSeenForAliases(matchSet);

  const auditRows = matchSet.length > 0
    ? db.query(`
        SELECT ts, action, target_type AS targetType, target_id AS targetId,
               result_status AS resultStatus, reason
        FROM action_audit
        WHERE ${buildAliasInClause(matchSet).sql} ${tenant.clause}
        ORDER BY ts DESC
        LIMIT 50
      `).all(...buildAliasInClause(matchSet).params, ...tenant.params) as AgentRecentAuditRow[]
    : [];

  const thirtyDaysAgo = Date.now() - THIRTY_DAYS_MS;
  const gateway = matchSet.length > 0
    ? (() => {
        const clause = buildCallerInClause(matchSet);
        const stats = db.query(`
          SELECT COUNT(*) AS calls, COALESCE(SUM(cost_estimate_usd), 0) AS spend,
                 MAX(ts) AS last_call
          FROM gateway_calls
          WHERE ${clause.sql} AND ts >= ? ${tenant.clause}
        `).get(...clause.params, thirtyDaysAgo, ...tenant.params) as { calls: number; spend: number; last_call: number | null } | null;
        return {
          calls30d: stats?.calls ?? 0,
          spend30dUsd: Number((stats?.spend ?? 0).toFixed(6)),
          lastCallAt: stats?.last_call ?? null,
        };
      })()
    : { calls30d: 0, spend30dUsd: 0, lastCallAt: null };

  const agent: RegisteredAgent = {
    ...base,
    lastSeenAt,
    audit7d,
    spend30dUsd: gateway.spend30dUsd,
  };

  return {
    agent,
    recentAudit: auditRows,
    gateway,
  };
}
