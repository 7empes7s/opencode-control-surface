import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import type { TenantContext } from "../tenancy/context.ts";

export const AUTONOMY_LEVELS = [
  "read-only",
  "propose",
  "act-with-approval",
  "autonomous",
] as const;

export type AutonomyLevel = typeof AUTONOMY_LEVELS[number];
export type AgentIdentityDeclarationState = "undeclared" | "unreviewed" | "reviewed";

type IdentitySource = {
  builderAgents?: string[];
  gatewayCallers?: string[];
  auditActors?: string[];
  auditActionKindPrefix?: string;
  harnesses?: string[];
};

export type AgentIdentityDefinition = {
  key: string;
  name: string;
  class: "builder" | "session" | "pipeline-stage" | "broker";
  description: string;
  evidenceCaveats: string[];
  source: IdentitySource;
};

// These are attribution contracts, not permission declarations. They are kept
// explicit so telemetry cannot be silently or fuzzily assigned to an identity.
export const AGENT_IDENTITY_CATALOG: AgentIdentityDefinition[] = [
  {
    key: "codex-builder",
    name: "Codex builder",
    class: "builder",
    description: "The Codex lane used by the Control Surface builder.",
    evidenceCaveats: [],
    source: {
      builderAgents: ["codex"],
      gatewayCallers: ["codex-runner"],
      auditActors: ["codex-runner"],
      harnesses: ["codex"],
    },
  },
  {
    key: "opencode-sessions",
    name: "OpenCode sessions",
    class: "session",
    description: "Managed OpenCode sessions and the builder lane attributed to OpenCode.",
    evidenceCaveats: [],
    source: {
      builderAgents: ["opencode"],
      gatewayCallers: ["opencode-runner"],
      auditActors: ["opencode-runner"],
      harnesses: ["opencode"],
    },
  },
  {
    key: "autopipeline-stages",
    name: "Autopipeline stages",
    class: "pipeline-stage",
    description: "The registered editorial autopipeline actor boundary.",
    evidenceCaveats: [
      "No persisted per-stage execution telemetry is available in the dashboard database; action and gateway records are only actor-bound evidence.",
    ],
    source: {
      gatewayCallers: ["autopipeline", "operator-bootstrap"],
      auditActors: ["autopipeline", "operator-bootstrap"],
    },
  },
  {
    key: "hyperagent-broker",
    name: "Hyperagent broker",
    class: "broker",
    description: "The Hyperagent broker boundary exposed through the Control Surface.",
    evidenceCaveats: [
      "Hyperagent audit records prove Control Surface broker requests. Broker caller attribution is advisory and does not cryptographically prove that a broker action occurred.",
    ],
    source: {
      auditActionKindPrefix: "hyperagent.",
    },
  },
];

export type AgentIdentityDeclaration = {
  autonomyLevel: AutonomyLevel | null;
  capabilities: string[];
  owner: string | null;
  lastReviewedAt: number | null;
  state: AgentIdentityDeclarationState;
  updatedAt: number | null;
  updatedBy: string | null;
};

export type CountEvidence = {
  available: boolean;
  count: number;
  successCount: number | null;
  lastObservedAt: number | null;
};

export type SessionEvidence = {
  available: boolean;
  sessions: number;
  runs: number;
  events: number;
  lastObservedAt: number | null;
};

export type AgentIdentityEvidence = {
  builderPasses: CountEvidence;
  gatewayCalls: CountEvidence;
  actionAudit: CountEvidence;
  sessions: SessionEvidence;
};

export type AgentIdentity = {
  definition: Omit<AgentIdentityDefinition, "source">;
  declaration: AgentIdentityDeclaration;
  evidence: AgentIdentityEvidence;
};

type ProfileRow = {
  identity_key: string;
  autonomy_level: string | null;
  capabilities_json: string;
  owner: string | null;
  last_reviewed_at: number | null;
  updated_at: number;
  updated_by: string | null;
};

type AggregateRow = {
  count: number | null;
  success_count: number | null;
  last_observed_at: number | null;
};

type SessionAggregateRow = {
  sessions: number | null;
  runs: number | null;
  events: number | null;
  latest_session_at: number | null;
  latest_run_at: number | null;
  latest_event_at: number | null;
};

export type DeclarationInput = {
  autonomyLevel: AutonomyLevel | null;
  capabilities: string[];
  owner: string | null;
  lastReviewedAt: number | null;
};

export type DeclarationValidation =
  | { ok: true; value: DeclarationInput }
  | { ok: false; error: string };

function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

function parseCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const unique = new Set<string>();
  for (const capability of value) {
    if (typeof capability !== "string") return null;
    const normalized = capability.trim();
    if (!normalized || normalized.length > 160) return null;
    unique.add(normalized);
  }
  return [...unique];
}

function parseStoredCapabilities(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parseCapabilities(parsed) ?? [];
  } catch {
    return [];
  }
}

function declarationState(value: DeclarationInput): AgentIdentityDeclarationState {
  const hasAnyDeclaration = value.autonomyLevel !== null || value.capabilities.length > 0 || value.owner !== null;
  if (!hasAnyDeclaration) return "undeclared";
  if (value.autonomyLevel !== null && value.capabilities.length > 0 && value.owner !== null && value.lastReviewedAt !== null) {
    return "reviewed";
  }
  return "unreviewed";
}

function emptyCountEvidence(available = false): CountEvidence {
  return { available, count: 0, successCount: null, lastObservedAt: null };
}

function emptySessionEvidence(available = false): SessionEvidence {
  return { available, sessions: 0, runs: 0, events: 0, lastObservedAt: null };
}

function emptyEvidence(): AgentIdentityEvidence {
  return {
    builderPasses: emptyCountEvidence(),
    gatewayCalls: emptyCountEvidence(),
    actionAudit: emptyCountEvidence(),
    sessions: emptySessionEvidence(),
  };
}

function inClause(column: string, values: string[]): { sql: string; params: string[] } {
  return { sql: `${column} IN (${values.map(() => "?").join(", ")})`, params: values };
}

function maxTimestamp(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return valid.length === 0 ? null : Math.max(...valid);
}

function readCountEvidence(
  table: "builder_passes" | "gateway_calls" | "action_audit",
  source: IdentitySource,
  ctx?: TenantContext,
): CountEvidence {
  const db = getDashboardDb();
  if (!db) return emptyCountEvidence();
  const tenant = whereTenant(ctx);

  try {
    if (table === "builder_passes") {
      if (!source.builderAgents?.length) return emptyCountEvidence();
      const clause = inClause("agent", source.builderAgents);
      const row = db.query(`
        SELECT COUNT(*) AS count,
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
          MAX(COALESCE(finished_at, started_at)) AS last_observed_at
        FROM builder_passes
        WHERE ${clause.sql} ${tenant.clause}
      `).get(...clause.params, ...tenant.params) as AggregateRow | null;
      return {
        available: true,
        count: Number(row?.count ?? 0),
        successCount: Number(row?.success_count ?? 0),
        lastObservedAt: row?.last_observed_at ?? null,
      };
    }

    if (table === "gateway_calls") {
      if (!source.gatewayCallers?.length) return emptyCountEvidence();
      const clause = inClause("caller", source.gatewayCallers);
      const row = db.query(`
        SELECT COUNT(*) AS count,
          COALESCE(SUM(success), 0) AS success_count,
          MAX(ts) AS last_observed_at
        FROM gateway_calls
        WHERE ${clause.sql} ${tenant.clause}
      `).get(...clause.params, ...tenant.params) as AggregateRow | null;
      return {
        available: true,
        count: Number(row?.count ?? 0),
        successCount: Number(row?.success_count ?? 0),
        lastObservedAt: row?.last_observed_at ?? null,
      };
    }

    const conditions: string[] = [];
    const params: string[] = [];
    if (source.auditActors?.length) {
      const clause = inClause("actor", source.auditActors);
      conditions.push(clause.sql);
      params.push(...clause.params);
    }
    if (source.auditActionKindPrefix) {
      conditions.push("action_kind LIKE ?");
      params.push(`${source.auditActionKindPrefix}%`);
    }
    if (conditions.length === 0) return emptyCountEvidence();
    const row = db.query(`
      SELECT COUNT(*) AS count, MAX(ts) AS last_observed_at
      FROM action_audit
      WHERE (${conditions.join(" OR ")}) ${tenant.clause}
    `).get(...params, ...tenant.params) as AggregateRow | null;
    return {
      available: true,
      count: Number(row?.count ?? 0),
      successCount: null,
      lastObservedAt: row?.last_observed_at ?? null,
    };
  } catch (error) {
    console.error(`[agent-identities] failed to read ${table}`, error);
    return emptyCountEvidence();
  }
}

function readSessionEvidence(source: IdentitySource, ctx?: TenantContext): SessionEvidence {
  const db = getDashboardDb();
  if (!db || !source.harnesses?.length) return emptySessionEvidence();
  const tenant = whereTenant(ctx, "s");
  const clause = inClause("s.harness", source.harnesses);

  try {
    const row = db.query(`
      SELECT COUNT(DISTINCT s.id) AS sessions,
        COUNT(DISTINCT r.id) AS runs,
        COUNT(DISTINCT e.id) AS events,
        MAX(s.updated_at) AS latest_session_at,
        MAX(COALESCE(r.finished_at, r.started_at, r.created_at)) AS latest_run_at,
        MAX(e.created_at) AS latest_event_at
      FROM agent_sessions s
      LEFT JOIN agent_runs r ON r.session_id = s.id AND r.tenant_id = s.tenant_id
      LEFT JOIN agent_events e ON e.session_id = s.id AND e.tenant_id = s.tenant_id
      WHERE ${clause.sql} AND s.internal = 0 ${tenant.clause}
    `).get(...clause.params, ...tenant.params) as SessionAggregateRow | null;
    return {
      available: true,
      sessions: Number(row?.sessions ?? 0),
      runs: Number(row?.runs ?? 0),
      events: Number(row?.events ?? 0),
      lastObservedAt: maxTimestamp([row?.latest_session_at, row?.latest_run_at, row?.latest_event_at]),
    };
  } catch (error) {
    console.error("[agent-identities] failed to read managed session evidence", error);
    return emptySessionEvidence();
  }
}

function profileToDeclaration(row: ProfileRow | null): AgentIdentityDeclaration {
  const input: DeclarationInput = {
    autonomyLevel: isAutonomyLevel(row?.autonomy_level) ? row.autonomy_level : null,
    capabilities: row ? parseStoredCapabilities(row.capabilities_json) : [],
    owner: row?.owner?.trim() || null,
    lastReviewedAt: row?.last_reviewed_at ?? null,
  };
  return {
    ...input,
    state: declarationState(input),
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

function readProfile(identityKey: string, ctx?: TenantContext): ProfileRow | null {
  const db = getDashboardDb();
  if (!db) return null;
  const tenant = whereTenant(ctx);
  try {
    return db.query(`
      SELECT identity_key, autonomy_level, capabilities_json, owner,
        last_reviewed_at, updated_at, updated_by
      FROM agent_identity_profiles
      WHERE identity_key = ? ${tenant.clause}
      LIMIT 1
    `).get(identityKey, ...tenant.params) as ProfileRow | null;
  } catch (error) {
    console.error("[agent-identities] failed to read identity profile", error);
    return null;
  }
}

export function getAgentIdentity(identityKey: string, ctx?: TenantContext): AgentIdentity | null {
  const definition = AGENT_IDENTITY_CATALOG.find((identity) => identity.key === identityKey);
  if (!definition) return null;

  const db = getDashboardDb();
  const evidence = db
    ? {
      builderPasses: readCountEvidence("builder_passes", definition.source, ctx),
      gatewayCalls: readCountEvidence("gateway_calls", definition.source, ctx),
      actionAudit: readCountEvidence("action_audit", definition.source, ctx),
      sessions: readSessionEvidence(definition.source, ctx),
    }
    : emptyEvidence();

  return {
    definition: {
      key: definition.key,
      name: definition.name,
      class: definition.class,
      description: definition.description,
      evidenceCaveats: definition.evidenceCaveats,
    },
    declaration: profileToDeclaration(readProfile(identityKey, ctx)),
    evidence,
  };
}

export function listAgentIdentities(ctx?: TenantContext): AgentIdentity[] {
  return AGENT_IDENTITY_CATALOG.map((identity) => getAgentIdentity(identity.key, ctx)).filter((identity): identity is AgentIdentity => identity !== null);
}

export function validateDeclaration(value: unknown, now = Date.now()): DeclarationValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "declaration must be an object" };
  }
  const body = value as Record<string, unknown>;
  const autonomyLevel = body.autonomyLevel === null ? null : isAutonomyLevel(body.autonomyLevel) ? body.autonomyLevel : undefined;
  if (autonomyLevel === undefined) return { ok: false, error: "autonomyLevel must be a supported autonomy level or null" };

  const capabilities = parseCapabilities(body.capabilities);
  if (!capabilities) return { ok: false, error: "capabilities must be an array of up to 32 non-empty capability strings" };

  const owner = body.owner === null ? null : typeof body.owner === "string" ? body.owner.trim() || null : undefined;
  if (owner === undefined || (typeof body.owner === "string" && body.owner.length > 200)) {
    return { ok: false, error: "owner must be a string up to 200 characters or null" };
  }

  const lastReviewedAt = body.lastReviewedAt === null
    ? null
    : typeof body.lastReviewedAt === "number" && Number.isSafeInteger(body.lastReviewedAt) && body.lastReviewedAt > 0 && body.lastReviewedAt <= now
      ? body.lastReviewedAt
      : undefined;
  if (lastReviewedAt === undefined) return { ok: false, error: "lastReviewedAt must be a non-future millisecond timestamp or null" };

  const input: DeclarationInput = { autonomyLevel, capabilities, owner, lastReviewedAt };
  const complete = input.autonomyLevel !== null && input.capabilities.length > 0 && input.owner !== null;
  if (input.lastReviewedAt !== null && !complete) {
    return { ok: false, error: "a review date requires autonomy, at least one capability, and an owner" };
  }
  if (declarationState(input) === "undeclared" && input.lastReviewedAt !== null) {
    return { ok: false, error: "an undeclared identity cannot have a review date" };
  }
  return { ok: true, value: input };
}

export type SaveIdentityDeclarationResult =
  | { ok: true; identity: AgentIdentity }
  | { ok: false; status: 400 | 404 | 503; error: string };

export function saveAgentIdentityDeclaration(
  identityKey: string,
  value: unknown,
  updatedBy: string | null,
  ctx?: TenantContext,
  now = Date.now(),
): SaveIdentityDeclarationResult {
  if (!AGENT_IDENTITY_CATALOG.some((identity) => identity.key === identityKey)) {
    return { ok: false, status: 404, error: `No agent identity is registered with key \"${identityKey}\".` };
  }
  const validated = validateDeclaration(value, now);
  if (validated.ok === false) return { ok: false, status: 400, error: validated.error };

  const db = getDashboardDb();
  if (!db) return { ok: false, status: 503, error: "dashboard database is unavailable" };
  const tenant = whereTenant(ctx);

  try {
    db.query(`
      INSERT INTO agent_identity_profiles
        (tenant_id, identity_key, autonomy_level, capabilities_json, owner, last_reviewed_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, identity_key) DO UPDATE SET
        autonomy_level = excluded.autonomy_level,
        capabilities_json = excluded.capabilities_json,
        owner = excluded.owner,
        last_reviewed_at = excluded.last_reviewed_at,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(
      tenant.params[0],
      identityKey,
      validated.value.autonomyLevel,
      JSON.stringify(validated.value.capabilities),
      validated.value.owner,
      validated.value.lastReviewedAt,
      now,
      updatedBy,
    );
  } catch (error) {
    console.error("[agent-identities] failed to save identity declaration", error);
    return { ok: false, status: 503, error: "dashboard database is unavailable" };
  }

  const identity = getAgentIdentity(identityKey, ctx);
  if (!identity) return { ok: false, status: 503, error: "identity profile could not be read after save" };
  return { ok: true, identity };
}
