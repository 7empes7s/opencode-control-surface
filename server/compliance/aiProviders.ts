import { loadGatewayConfig, type GatewayConfig } from "../gateway/config.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import type { TenantContext } from "../tenancy/context.ts";

export const EGRESS_BOUNDARIES = ["external-provider", "private-network", "unknown"] as const;
export const RISK_TREATMENTS = ["accept", "mitigate", "transfer", "avoid"] as const;
export const PROVIDER_ZERO_SUCCESS_WINDOW_MS = 17 * 24 * 60 * 60 * 1000;
export const PROVIDER_ZERO_SUCCESS_MIN_CALLS = 5;
export const PROVIDER_ZERO_SUCCESS_CURRENT_MS = 24 * 60 * 60 * 1000;

export type EgressBoundary = typeof EGRESS_BOUNDARIES[number];
export type RiskTreatment = typeof RISK_TREATMENTS[number];
export type AiProviderDeclarationState = "undeclared" | "unreviewed" | "reviewed";

export type AiProviderDeclaration = {
  dataClasses: string[];
  credentialLocation: string | null;
  egressBoundary: EgressBoundary | null;
  owner: string | null;
  riskLikelihood: number | null;
  riskImpact: number | null;
  treatment: RiskTreatment | null;
  lastReviewedAt: number | null;
  state: AiProviderDeclarationState;
  updatedAt: number | null;
  updatedBy: string | null;
};

export type AiProviderEvidence = {
  available: boolean;
  configuredIdentifiers: string[];
  gatewayIdentifiers: string[];
  builderIdentifiers: string[];
  gateway: {
    calls: number;
    successes: number;
    successRate: number | null;
    firstObservedAt: number | null;
    lastObservedAt: number | null;
    recentCalls: number;
    recentSuccesses: number;
    recentSuccessRate: number | null;
    recentFirstObservedAt: number | null;
    recentLastObservedAt: number | null;
  };
  builderPasses: {
    passes: number;
    successes: number;
    successRate: number | null;
    firstObservedAt: number | null;
    lastObservedAt: number | null;
  };
  routeTruthFindingKinds: Array<"dead-route" | "degraded-route" | "probe-only-route" | "broken-paid-fallback">;
  zeroSuccess17d: boolean;
};

export type AiProvider = {
  key: string;
  declaration: AiProviderDeclaration;
  riskScore: number | null;
  evidence: AiProviderEvidence;
};

export const VENDOR_GROUP_RULE_KINDS = ["key", "prefix"] as const;
export type VendorGroupRuleKind = typeof VENDOR_GROUP_RULE_KINDS[number];

export type AiProviderVendorGroupRule = {
  id: string;
  kind: VendorGroupRuleKind;
  value: string;
  createdAt: number;
  createdBy: string | null;
};

export type AiProviderVendorGroupMember = AiProvider & {
  grouping: {
    operatorCurated: true;
    rule: AiProviderVendorGroupRule;
  };
};

export type AiProviderVendorGroup = {
  key: string;
  name: string;
  declaration: AiProviderDeclaration;
  riskScore: number | null;
  rules: AiProviderVendorGroupRule[];
  members: AiProviderVendorGroupMember[];
  evidence: AiProviderEvidence;
};

export type AiProviderRegister = {
  // Retained for S11 callers that need the complete observed route list. The
  // grouped presentation below is the only vendor-facing view.
  providers: AiProvider[];
  vendorGroups: AiProviderVendorGroup[];
  ungroupedProviders: AiProvider[];
};

export type ProviderDeclarationInput = Omit<AiProviderDeclaration, "state" | "updatedAt" | "updatedBy">;

export type ProviderDeclarationValidation =
  | { ok: true; value: ProviderDeclarationInput }
  | { ok: false; error: string };

type RiskDeclarationRow = {
  data_classes_json: string;
  credential_location: string | null;
  egress_boundary: string | null;
  owner: string | null;
  risk_likelihood: number | null;
  risk_impact: number | null;
  treatment: string | null;
  last_reviewed_at: number | null;
  updated_at: number;
  updated_by: string | null;
};

type ProfileRow = RiskDeclarationRow & {
  provider_key: string;
};

type VendorGroupRow = RiskDeclarationRow & {
  group_key: string;
  name: string;
};

type VendorGroupRuleRow = {
  rule_id: string;
  group_key: string;
  rule_kind: string;
  match_value: string;
  created_at: number;
  created_by: string | null;
};

type GatewayAggregateRow = {
  identifier: string;
  calls: number | null;
  successes: number | null;
  first_observed_at: number | null;
  last_observed_at: number | null;
  recent_calls: number | null;
  recent_successes: number | null;
  recent_first_observed_at: number | null;
  recent_last_observed_at: number | null;
};

type BuilderAggregateRow = {
  identifier: string;
  passes: number | null;
  successes: number | null;
  first_observed_at: number | null;
  last_observed_at: number | null;
};

type RouteTruthRow = { source_key: string };

type Candidate = {
  key: string;
  configuredIdentifiers: Set<string>;
  gatewayIdentifiers: Set<string>;
  builderIdentifiers: Set<string>;
  gateway: AiProviderEvidence["gateway"];
  builderPasses: AiProviderEvidence["builderPasses"];
  routeTruthFindingKinds: Set<AiProviderEvidence["routeTruthFindingKinds"][number]>;
};

const ROUTE_TRUTH_KINDS = ["dead-route", "degraded-route", "probe-only-route", "broken-paid-fallback"] as const;

function emptyGatewayEvidence(): AiProviderEvidence["gateway"] {
  return {
    calls: 0,
    successes: 0,
    successRate: null,
    firstObservedAt: null,
    lastObservedAt: null,
    recentCalls: 0,
    recentSuccesses: 0,
    recentSuccessRate: null,
    recentFirstObservedAt: null,
    recentLastObservedAt: null,
  };
}

function emptyBuilderEvidence(): AiProviderEvidence["builderPasses"] {
  return { passes: 0, successes: 0, successRate: null, firstObservedAt: null, lastObservedAt: null };
}

function emptyCandidate(key: string): Candidate {
  return {
    key,
    configuredIdentifiers: new Set(),
    gatewayIdentifiers: new Set(),
    builderIdentifiers: new Set(),
    gateway: emptyGatewayEvidence(),
    builderPasses: emptyBuilderEvidence(),
    routeTruthFindingKinds: new Set(),
  };
}

function rate(successes: number, attempts: number): number | null {
  return attempts === 0 ? null : successes / attempts;
}

function isEgressBoundary(value: unknown): value is EgressBoundary {
  return typeof value === "string" && (EGRESS_BOUNDARIES as readonly string[]).includes(value);
}

function isRiskTreatment(value: unknown): value is RiskTreatment {
  return typeof value === "string" && (RISK_TREATMENTS as readonly string[]).includes(value);
}

function isVendorGroupRuleKind(value: unknown): value is VendorGroupRuleKind {
  return typeof value === "string" && (VENDOR_GROUP_RULE_KINDS as readonly string[]).includes(value);
}

function isRouteTruthKind(value: string): value is AiProviderEvidence["routeTruthFindingKinds"][number] {
  return (ROUTE_TRUTH_KINDS as readonly string[]).includes(value);
}

/**
 * This is intentionally a conservative identifier normalizer, not a vendor
 * lookup. A namespace in an observed `provider/model` string is real evidence;
 * an unqualified route stays unqualified rather than being assigned a guessed
 * commercial provider.
 */
export function providerKeyFromObservedIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return null;
  const namespace = trimmed.split("/")[0]?.trim() ?? "";
  const normalized = namespace.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return normalized || null;
}

function addCandidate(candidates: Map<string, Candidate>, identifier: string, source: "configured" | "gateway" | "builder"): Candidate | null {
  const trimmed = identifier.trim();
  const key = providerKeyFromObservedIdentifier(trimmed);
  if (!key) return null;
  let candidate = candidates.get(key);
  if (!candidate) {
    candidate = emptyCandidate(key);
    candidates.set(key, candidate);
  }
  if (source === "configured") candidate.configuredIdentifiers.add(trimmed);
  if (source === "gateway") candidate.gatewayIdentifiers.add(trimmed);
  if (source === "builder") candidate.builderIdentifiers.add(trimmed);
  return candidate;
}

export function configuredProviderIdentifiers(config = loadGatewayConfig()): string[] {
  const identifiers = new Set<string>();
  for (const entry of Object.values(config.models)) {
    if (entry.model.trim()) identifiers.add(entry.model.trim());
    for (const fallback of entry.fallbackChain) {
      if (fallback.trim()) identifiers.add(fallback.trim());
    }
  }
  return [...identifiers].sort((a, b) => a.localeCompare(b));
}

export function configuredProviderKeys(config: GatewayConfig = loadGatewayConfig()): string[] {
  return [...new Set(configuredProviderIdentifiers(config)
    .map(providerKeyFromObservedIdentifier)
    .filter((key): key is string => key !== null))]
    .sort((a, b) => a.localeCompare(b));
}

function parseDataClasses(value: string): string[] {
  try {
    return parseDeclarationStrings(JSON.parse(value)) ?? [];
  } catch {
    return [];
  }
}

function parseDeclarationStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const normalized = item.trim();
    if (!normalized || normalized.length > 160) return null;
    unique.add(normalized);
  }
  return [...unique];
}

function parseCredentialLocation(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) return undefined;
  // A location/name can never contain an assignment, line break, URL user-info,
  // or a recognisable bearer/key prefix. This is a reference field, not a vault.
  if (/[=\r\n]/.test(normalized) || /:\/\/[^/\s]*@/.test(normalized)) return undefined;
  if (/^(?:bearer\s+|sk-|AIza|ghp_|github_pat_|eyJ)/i.test(normalized)) return undefined;
  // Bare references are deliberately restricted to conventional upper-case
  // environment-variable names. Accepting arbitrary free text here would make
  // a copied credential value indistinguishable from a claimed location.
  const envReference = /^(?:process\.env\.)?[A-Z][A-Z0-9_]{1,127}$/;
  const pathReference = /^\/[A-Za-z0-9_./-]+(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
  return envReference.test(normalized) || pathReference.test(normalized) ? normalized : undefined;
}

function declarationState(value: ProviderDeclarationInput): AiProviderDeclarationState {
  const hasAnyDeclaration = value.dataClasses.length > 0
    || value.credentialLocation !== null
    || (value.egressBoundary !== null && value.egressBoundary !== "unknown")
    || value.owner !== null
    || value.riskLikelihood !== null
    || value.riskImpact !== null
    || value.treatment !== null;
  if (!hasAnyDeclaration) return "undeclared";
  const complete = value.dataClasses.length > 0
    && value.credentialLocation !== null
    && value.egressBoundary !== null
    && value.egressBoundary !== "unknown"
    && value.owner !== null
    && value.riskLikelihood !== null
    && value.riskImpact !== null
    && value.treatment !== null;
  return complete && value.lastReviewedAt !== null ? "reviewed" : "unreviewed";
}

function profileToDeclaration(row: RiskDeclarationRow | null): AiProviderDeclaration {
  const input: ProviderDeclarationInput = {
    dataClasses: row ? parseDataClasses(row.data_classes_json) : [],
    credentialLocation: row?.credential_location?.trim() || null,
    egressBoundary: isEgressBoundary(row?.egress_boundary) ? row.egress_boundary : null,
    owner: row?.owner?.trim() || null,
    riskLikelihood: row?.risk_likelihood && Number.isInteger(row.risk_likelihood) ? row.risk_likelihood : null,
    riskImpact: row?.risk_impact && Number.isInteger(row.risk_impact) ? row.risk_impact : null,
    treatment: isRiskTreatment(row?.treatment) ? row.treatment : null,
    lastReviewedAt: row?.last_reviewed_at ?? null,
  };
  return {
    ...input,
    state: declarationState(input),
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

function readProfiles(ctx?: TenantContext): Map<string, ProfileRow> {
  const db = getDashboardDb();
  if (!db) return new Map();
  const tenant = whereTenant(ctx);
  try {
    const rows = db.query(`
      SELECT provider_key, data_classes_json, credential_location, egress_boundary, owner,
        risk_likelihood, risk_impact, treatment, last_reviewed_at, updated_at, updated_by
      FROM ai_provider_risk_profiles
      WHERE 1=1 ${tenant.clause}
    `).all(...tenant.params) as ProfileRow[];
    return new Map(rows.map((row) => [row.provider_key, row]));
  } catch (error) {
    console.error("[ai-providers] failed to read provider profiles", error);
    return new Map();
  }
}

function readVendorGroups(ctx?: TenantContext): VendorGroupRow[] {
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant(ctx);
  try {
    return db.query(`
      SELECT group_key, name, data_classes_json, credential_location, egress_boundary, owner,
        risk_likelihood, risk_impact, treatment, last_reviewed_at, updated_at, updated_by
      FROM ai_provider_vendor_groups
      WHERE 1=1 ${tenant.clause}
      ORDER BY name COLLATE NOCASE ASC, group_key ASC
    `).all(...tenant.params) as VendorGroupRow[];
  } catch (error) {
    console.error("[ai-providers] failed to read vendor groups", error);
    return [];
  }
}

function readVendorGroupRules(ctx?: TenantContext): VendorGroupRuleRow[] {
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant(ctx);
  try {
    return db.query(`
      SELECT rule_id, group_key, rule_kind, match_value, created_at, created_by
      FROM ai_provider_vendor_group_rules
      WHERE 1=1 ${tenant.clause}
      ORDER BY group_key ASC,
        CASE rule_kind WHEN 'key' THEN 0 ELSE 1 END ASC,
        match_value ASC, rule_id ASC
    `).all(...tenant.params) as VendorGroupRuleRow[];
  } catch (error) {
    console.error("[ai-providers] failed to read vendor group rules", error);
    return [];
  }
}

function vendorRuleFromRow(row: VendorGroupRuleRow): AiProviderVendorGroupRule | null {
  if (!isVendorGroupRuleKind(row.rule_kind) || !row.rule_id || !row.match_value) return null;
  return {
    id: row.rule_id,
    kind: row.rule_kind,
    value: row.match_value,
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
  };
}

function rulesByGroup(rows: VendorGroupRuleRow[]): Map<string, AiProviderVendorGroupRule[]> {
  const grouped = new Map<string, AiProviderVendorGroupRule[]>();
  for (const row of rows) {
    const rule = vendorRuleFromRow(row);
    if (!rule) continue;
    const rules = grouped.get(row.group_key) ?? [];
    rules.push(rule);
    grouped.set(row.group_key, rules);
  }
  return grouped;
}

function collectTelemetryCandidates(candidates: Map<string, Candidate>, ctx: TenantContext | undefined, now: number): void {
  const db = getDashboardDb();
  if (!db) return;
  const tenant = whereTenant(ctx);
  const recentSince = now - PROVIDER_ZERO_SUCCESS_WINDOW_MS;

  try {
    const rows = db.query(`
      SELECT resolved_model AS identifier,
        COUNT(*) AS calls,
        COALESCE(SUM(success), 0) AS successes,
        MIN(ts) AS first_observed_at,
        MAX(ts) AS last_observed_at,
        COALESCE(SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END), 0) AS recent_calls,
        COALESCE(SUM(CASE WHEN ts >= ? THEN success ELSE 0 END), 0) AS recent_successes,
        MIN(CASE WHEN ts >= ? THEN ts ELSE NULL END) AS recent_first_observed_at,
        MAX(CASE WHEN ts >= ? THEN ts ELSE NULL END) AS recent_last_observed_at
      FROM gateway_calls
      WHERE resolved_model IS NOT NULL AND TRIM(resolved_model) != '' ${tenant.clause}
      GROUP BY resolved_model
    `).all(recentSince, recentSince, recentSince, recentSince, ...tenant.params) as GatewayAggregateRow[];
    for (const row of rows) {
      const candidate = addCandidate(candidates, row.identifier, "gateway");
      if (!candidate) continue;
      const calls = Number(row.calls ?? 0);
      const successes = Number(row.successes ?? 0);
      const recentCalls = Number(row.recent_calls ?? 0);
      const recentSuccesses = Number(row.recent_successes ?? 0);
      candidate.gateway = {
        calls,
        successes,
        successRate: rate(successes, calls),
        firstObservedAt: row.first_observed_at ?? null,
        lastObservedAt: row.last_observed_at ?? null,
        recentCalls,
        recentSuccesses,
        recentSuccessRate: rate(recentSuccesses, recentCalls),
        recentFirstObservedAt: row.recent_first_observed_at ?? null,
        recentLastObservedAt: row.recent_last_observed_at ?? null,
      };
    }
  } catch (error) {
    console.error("[ai-providers] failed to read gateway evidence", error);
  }

  try {
    const rows = db.query(`
      SELECT provider AS identifier,
        COUNT(*) AS passes,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successes,
        MIN(COALESCE(started_at, finished_at)) AS first_observed_at,
        MAX(COALESCE(finished_at, started_at)) AS last_observed_at
      FROM builder_passes
      WHERE provider IS NOT NULL AND TRIM(provider) != '' ${tenant.clause}
      GROUP BY provider
    `).all(...tenant.params) as BuilderAggregateRow[];
    for (const row of rows) {
      const candidate = addCandidate(candidates, row.identifier, "builder");
      if (!candidate) continue;
      const passes = Number(row.passes ?? 0);
      const successes = Number(row.successes ?? 0);
      candidate.builderPasses = {
        passes,
        successes,
        successRate: rate(successes, passes),
        firstObservedAt: row.first_observed_at ?? null,
        lastObservedAt: row.last_observed_at ?? null,
      };
    }
  } catch (error) {
    console.error("[ai-providers] failed to read builder evidence", error);
  }

  try {
    const rows = db.query(`
      SELECT source_key
      FROM insights
      WHERE status = 'open' AND source_key LIKE 'models:%' ${tenant.clause}
    `).all(...tenant.params) as RouteTruthRow[];
    for (const row of rows) {
      const match = /^models:(dead-route|degraded-route|probe-only-route|broken-paid-fallback):(.+)$/.exec(row.source_key);
      if (!match || !isRouteTruthKind(match[1])) continue;
      const key = providerKeyFromObservedIdentifier(match[2]);
      // S7 confirms an existing route condition; it must not become a separate
      // source of provider inventory. Candidate enumeration stays limited to
      // configuration and first-party gateway/builder telemetry.
      const candidate = key ? candidates.get(key) : null;
      if (candidate) candidate.routeTruthFindingKinds.add(match[1]);
    }
  } catch (error) {
    console.error("[ai-providers] failed to read route-truth evidence", error);
  }
}

function collectCandidates(ctx?: TenantContext, now = Date.now()): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();
  for (const identifier of configuredProviderIdentifiers()) addCandidate(candidates, identifier, "configured");
  collectTelemetryCandidates(candidates, ctx, now);
  return candidates;
}

function hasZeroSuccess17d(gateway: AiProviderEvidence["gateway"], now: number): boolean {
  const windowStart = now - PROVIDER_ZERO_SUCCESS_WINDOW_MS;
  const currentCutoff = now - PROVIDER_ZERO_SUCCESS_CURRENT_MS;
  return gateway.recentCalls >= PROVIDER_ZERO_SUCCESS_MIN_CALLS
    && gateway.recentSuccesses === 0
    && gateway.recentFirstObservedAt !== null
    && gateway.recentFirstObservedAt <= windowStart
    && gateway.recentLastObservedAt !== null
    && gateway.recentLastObservedAt >= currentCutoff;
}

function toProvider(candidate: Candidate, profile: ProfileRow | null, available: boolean, now: number): AiProvider {
  const declaration = profileToDeclaration(profile);
  return {
    key: candidate.key,
    declaration,
    riskScore: declaration.riskLikelihood !== null && declaration.riskImpact !== null
      ? declaration.riskLikelihood * declaration.riskImpact
      : null,
    evidence: {
      available,
      configuredIdentifiers: [...candidate.configuredIdentifiers].sort((a, b) => a.localeCompare(b)),
      gatewayIdentifiers: [...candidate.gatewayIdentifiers].sort((a, b) => a.localeCompare(b)),
      builderIdentifiers: [...candidate.builderIdentifiers].sort((a, b) => a.localeCompare(b)),
      gateway: candidate.gateway,
      builderPasses: candidate.builderPasses,
      routeTruthFindingKinds: [...candidate.routeTruthFindingKinds].sort(),
      zeroSuccess17d: hasZeroSuccess17d(candidate.gateway, now),
    },
  };
}

export function listAiProviderProfiles(ctx?: TenantContext, now = Date.now()): AiProvider[] {
  const candidates = collectCandidates(ctx, now);
  const profiles = readProfiles(ctx);
  const available = getDashboardDb() !== null;
  return [...candidates.values()]
    .map((candidate) => toProvider(candidate, profiles.get(candidate.key) ?? null, available, now))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function matchesVendorRule(rule: AiProviderVendorGroupRule, providerKey: string): boolean {
  return rule.kind === "key" ? rule.value === providerKey : providerKey.startsWith(rule.value);
}

function earliest(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.min(...present) : null;
}

function latest(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.max(...present) : null;
}

function aggregateProviderEvidence(providers: AiProvider[], available: boolean): AiProviderEvidence {
  const configuredIdentifiers = new Set<string>();
  const gatewayIdentifiers = new Set<string>();
  const builderIdentifiers = new Set<string>();
  const routeTruthFindingKinds = new Set<AiProviderEvidence["routeTruthFindingKinds"][number]>();
  let calls = 0;
  let successes = 0;
  let recentCalls = 0;
  let recentSuccesses = 0;
  let passes = 0;
  let passSuccesses = 0;

  for (const provider of providers) {
    for (const identifier of provider.evidence.configuredIdentifiers) configuredIdentifiers.add(identifier);
    for (const identifier of provider.evidence.gatewayIdentifiers) gatewayIdentifiers.add(identifier);
    for (const identifier of provider.evidence.builderIdentifiers) builderIdentifiers.add(identifier);
    for (const finding of provider.evidence.routeTruthFindingKinds) routeTruthFindingKinds.add(finding);
    calls += provider.evidence.gateway.calls;
    successes += provider.evidence.gateway.successes;
    recentCalls += provider.evidence.gateway.recentCalls;
    recentSuccesses += provider.evidence.gateway.recentSuccesses;
    passes += provider.evidence.builderPasses.passes;
    passSuccesses += provider.evidence.builderPasses.successes;
  }

  return {
    available,
    configuredIdentifiers: [...configuredIdentifiers].sort((a, b) => a.localeCompare(b)),
    gatewayIdentifiers: [...gatewayIdentifiers].sort((a, b) => a.localeCompare(b)),
    builderIdentifiers: [...builderIdentifiers].sort((a, b) => a.localeCompare(b)),
    gateway: {
      calls,
      successes,
      successRate: rate(successes, calls),
      firstObservedAt: earliest(providers.map((provider) => provider.evidence.gateway.firstObservedAt)),
      lastObservedAt: latest(providers.map((provider) => provider.evidence.gateway.lastObservedAt)),
      recentCalls,
      recentSuccesses,
      recentSuccessRate: rate(recentSuccesses, recentCalls),
      recentFirstObservedAt: earliest(providers.map((provider) => provider.evidence.gateway.recentFirstObservedAt)),
      recentLastObservedAt: latest(providers.map((provider) => provider.evidence.gateway.recentLastObservedAt)),
    },
    builderPasses: {
      passes,
      successes: passSuccesses,
      successRate: rate(passSuccesses, passes),
      firstObservedAt: earliest(providers.map((provider) => provider.evidence.builderPasses.firstObservedAt)),
      lastObservedAt: latest(providers.map((provider) => provider.evidence.builderPasses.lastObservedAt)),
    },
    routeTruthFindingKinds: [...routeTruthFindingKinds].sort(),
    // A vendor summary must not erase a member route that meets S11's
    // reliability condition just because another member succeeded.
    zeroSuccess17d: providers.some((provider) => provider.evidence.zeroSuccess17d),
  };
}

function groupRiskScore(declaration: AiProviderDeclaration): number | null {
  return declaration.riskLikelihood !== null && declaration.riskImpact !== null
    ? declaration.riskLikelihood * declaration.riskImpact
    : null;
}

export function listAiProviderRegister(ctx?: TenantContext, now = Date.now()): AiProviderRegister {
  const providers = listAiProviderProfiles(ctx, now);
  const groupRows = readVendorGroups(ctx);
  const ruleMap = rulesByGroup(readVendorGroupRules(ctx));
  const assignedKeys = new Set<string>();
  const available = getDashboardDb() !== null;
  const vendorGroups = groupRows.map((group): AiProviderVendorGroup => {
    const rules = ruleMap.get(group.group_key) ?? [];
    const members = providers.flatMap((provider) => {
      const rule = rules.find((candidate) => matchesVendorRule(candidate, provider.key));
      // Rule validation prevents cross-group matches. Keep the read model
      // honest even if a concurrent or legacy corrupt row somehow bypassed
      // that validation: an observed key is presented once, never duplicated.
      if (!rule || assignedKeys.has(provider.key)) return [];
      assignedKeys.add(provider.key);
      return [{ ...provider, grouping: { operatorCurated: true as const, rule } }];
    });
    const declaration = profileToDeclaration(group);
    return {
      key: group.group_key,
      name: group.name,
      declaration,
      riskScore: groupRiskScore(declaration),
      rules,
      members,
      evidence: aggregateProviderEvidence(members, available),
    };
  });

  return {
    providers,
    vendorGroups,
    ungroupedProviders: providers.filter((provider) => !assignedKeys.has(provider.key)),
  };
}

function isVendorGroupKey(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

export function vendorGroupKeyFromName(value: string): string | null {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return isVendorGroupKey(normalized) ? normalized : null;
}

function validateVendorGroupName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 120 || /[\r\n]/.test(name)) return null;
  return name;
}

type VendorGroupInput = { name: string; declaration: ProviderDeclarationInput };

function validateVendorGroupInput(value: unknown, now = Date.now()): { ok: true; value: VendorGroupInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "vendor group must be an object" };
  }
  const body = value as Record<string, unknown>;
  const name = validateVendorGroupName(body.name);
  if (!name) return { ok: false, error: "name must be a non-empty single-line string up to 120 characters" };
  const declaration = validateProviderDeclaration(body.declaration, now);
  if (declaration.ok === false) return declaration;
  return { ok: true, value: { name, declaration: declaration.value } };
}

function getVendorGroup(groupKey: string, ctx?: TenantContext, now = Date.now()): AiProviderVendorGroup | null {
  return listAiProviderRegister(ctx, now).vendorGroups.find((group) => group.key === groupKey) ?? null;
}

export type SaveAiProviderVendorGroupResult =
  | { ok: true; vendorGroup: AiProviderVendorGroup }
  | { ok: false; status: 400 | 404 | 503; error: string };

function writeVendorGroup(
  groupKey: string,
  input: VendorGroupInput,
  updatedBy: string | null,
  ctx: TenantContext | undefined,
  now: number,
  create: boolean,
): SaveAiProviderVendorGroupResult {
  const db = getDashboardDb();
  if (!db) return { ok: false, status: 503, error: "dashboard database is unavailable" };
  const tenant = whereTenant(ctx);
  try {
    const existing = db.query(`
      SELECT group_key FROM ai_provider_vendor_groups
      WHERE group_key = ? ${tenant.clause}
      LIMIT 1
    `).get(groupKey, ...tenant.params) as { group_key: string } | null;
    if (create && existing) return { ok: false, status: 400, error: `A vendor group already uses key \"${groupKey}\".` };
    if (!create && !existing) return { ok: false, status: 404, error: `No vendor group is registered with key \"${groupKey}\".` };

    if (create) {
      db.query(`
        INSERT INTO ai_provider_vendor_groups
          (tenant_id, group_key, name, data_classes_json, credential_location, egress_boundary, owner,
           risk_likelihood, risk_impact, treatment, last_reviewed_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenant.params[0], groupKey, input.name, JSON.stringify(input.declaration.dataClasses),
        input.declaration.credentialLocation, input.declaration.egressBoundary, input.declaration.owner,
        input.declaration.riskLikelihood, input.declaration.riskImpact, input.declaration.treatment,
        input.declaration.lastReviewedAt, now, updatedBy,
      );
    } else {
      db.query(`
        UPDATE ai_provider_vendor_groups
        SET name = ?, data_classes_json = ?, credential_location = ?, egress_boundary = ?, owner = ?,
          risk_likelihood = ?, risk_impact = ?, treatment = ?, last_reviewed_at = ?, updated_at = ?, updated_by = ?
        WHERE group_key = ? ${tenant.clause}
      `).run(
        input.name, JSON.stringify(input.declaration.dataClasses), input.declaration.credentialLocation,
        input.declaration.egressBoundary, input.declaration.owner, input.declaration.riskLikelihood,
        input.declaration.riskImpact, input.declaration.treatment, input.declaration.lastReviewedAt,
        now, updatedBy, groupKey, ...tenant.params,
      );
    }
  } catch (error) {
    console.error("[ai-providers] failed to save vendor group", error);
    return { ok: false, status: 503, error: "dashboard database is unavailable" };
  }

  const vendorGroup = getVendorGroup(groupKey, ctx, now);
  if (!vendorGroup) return { ok: false, status: 503, error: "vendor group could not be read after save" };
  return { ok: true, vendorGroup };
}

export function createAiProviderVendorGroup(
  value: unknown,
  updatedBy: string | null,
  ctx?: TenantContext,
  now = Date.now(),
): SaveAiProviderVendorGroupResult {
  const validated = validateVendorGroupInput(value, now);
  if (validated.ok === false) return { ok: false, status: 400, error: validated.error };
  const groupKey = vendorGroupKeyFromName(validated.value.name);
  if (!groupKey) return { ok: false, status: 400, error: "name must yield a valid vendor group key" };
  return writeVendorGroup(groupKey, validated.value, updatedBy, ctx, now, true);
}

export function updateAiProviderVendorGroup(
  groupKey: string,
  value: unknown,
  updatedBy: string | null,
  ctx?: TenantContext,
  now = Date.now(),
): SaveAiProviderVendorGroupResult {
  if (!isVendorGroupKey(groupKey)) return { ok: false, status: 404, error: `No vendor group is registered with key \"${groupKey}\".` };
  const validated = validateVendorGroupInput(value, now);
  if (validated.ok === false) return { ok: false, status: 400, error: validated.error };
  return writeVendorGroup(groupKey, validated.value, updatedBy, ctx, now, false);
}

export type DeleteAiProviderVendorGroupResult =
  | { ok: true; groupKey: string }
  | { ok: false; status: 404 | 503; error: string };

export function deleteAiProviderVendorGroup(
  groupKey: string,
  ctx?: TenantContext,
): DeleteAiProviderVendorGroupResult {
  if (!isVendorGroupKey(groupKey)) return { ok: false, status: 404, error: `No vendor group is registered with key \"${groupKey}\".` };
  const db = getDashboardDb();
  if (!db) return { ok: false, status: 503, error: "dashboard database is unavailable" };
  const tenant = whereTenant(ctx);
  try {
    const existing = db.query(`SELECT group_key FROM ai_provider_vendor_groups WHERE group_key = ? ${tenant.clause} LIMIT 1`)
      .get(groupKey, ...tenant.params) as { group_key: string } | null;
    if (!existing) return { ok: false, status: 404, error: `No vendor group is registered with key \"${groupKey}\".` };
    db.query(`DELETE FROM ai_provider_vendor_group_rules WHERE group_key = ? ${tenant.clause}`).run(groupKey, ...tenant.params);
    db.query(`DELETE FROM ai_provider_vendor_groups WHERE group_key = ? ${tenant.clause}`).run(groupKey, ...tenant.params);
  } catch (error) {
    console.error("[ai-providers] failed to delete vendor group", error);
    return { ok: false, status: 503, error: "dashboard database is unavailable" };
  }
  return { ok: true, groupKey };
}

type VendorGroupRuleInput = { kind: VendorGroupRuleKind; value: string };

function validateVendorGroupRuleInput(
  value: unknown,
  candidates: Map<string, Candidate>,
): { ok: true; value: VendorGroupRuleInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "vendor group rule must be an object" };
  }
  const body = value as Record<string, unknown>;
  if (!isVendorGroupRuleKind(body.kind)) return { ok: false, error: "kind must be key or prefix" };
  if (typeof body.value !== "string") return { ok: false, error: "value must be a string" };
  const raw = body.value.trim();
  if (!raw || raw.length > 160) return { ok: false, error: "value must be a non-empty provider key or prefix up to 160 characters" };

  if (body.kind === "key") {
    const key = providerKeyFromObservedIdentifier(raw);
    if (!key || key !== raw || !candidates.has(key)) {
      return { ok: false, error: "key rules must name an exact currently observed provider key" };
    }
    return { ok: true, value: { kind: "key", value: key } };
  }

  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/.test(raw)) {
    return { ok: false, error: "prefix rules must be lower-case provider-key prefixes" };
  }
  if (![...candidates.keys()].some((key) => key.startsWith(raw))) {
    return { ok: false, error: "prefix rules must match at least one currently observed provider key" };
  }
  return { ok: true, value: { kind: "prefix", value: raw } };
}

function rulesConflict(
  existing: Array<{ groupKey: string; rule: AiProviderVendorGroupRule }>,
  proposedGroupKey: string,
  proposed: VendorGroupRuleInput,
): string | null {
  for (const { groupKey, rule } of existing) {
    if (groupKey === proposedGroupKey) {
      if (rule.kind === proposed.kind && rule.value === proposed.value) {
        return "that operator-curated rule already exists for this vendor group";
      }
      continue;
    }
    const overlaps = proposed.kind === "prefix" && rule.kind === "prefix"
      ? proposed.value.startsWith(rule.value) || rule.value.startsWith(proposed.value)
      : proposed.kind === "prefix" && rule.kind === "key"
        ? rule.value.startsWith(proposed.value)
        : proposed.kind === "key" && rule.kind === "prefix"
          ? proposed.value.startsWith(rule.value)
          : proposed.value === rule.value;
    if (overlaps) {
      return `rule conflicts with the operator-curated ${rule.kind} rule \"${rule.value}\" in vendor group \"${groupKey}\"`;
    }
  }
  return null;
}

export type SaveAiProviderVendorGroupRuleResult =
  | { ok: true; rule: AiProviderVendorGroupRule; vendorGroup: AiProviderVendorGroup }
  | { ok: false; status: 400 | 404 | 503; error: string };

export function saveAiProviderVendorGroupRule(
  groupKey: string,
  value: unknown,
  updatedBy: string | null,
  ctx?: TenantContext,
  now = Date.now(),
): SaveAiProviderVendorGroupRuleResult {
  if (!isVendorGroupKey(groupKey)) return { ok: false, status: 404, error: `No vendor group is registered with key \"${groupKey}\".` };
  const db = getDashboardDb();
  if (!db) return { ok: false, status: 503, error: "dashboard database is unavailable" };
  const candidates = collectCandidates(ctx, now);
  const validated = validateVendorGroupRuleInput(value, candidates);
  if (validated.ok === false) return { ok: false, status: 400, error: validated.error };
  const tenant = whereTenant(ctx);

  try {
    const group = db.query(`SELECT group_key FROM ai_provider_vendor_groups WHERE group_key = ? ${tenant.clause} LIMIT 1`)
      .get(groupKey, ...tenant.params) as { group_key: string } | null;
    if (!group) return { ok: false, status: 404, error: `No vendor group is registered with key \"${groupKey}\".` };
    const rows = readVendorGroupRules(ctx);
    const existing = rows.flatMap((row) => {
      const rule = vendorRuleFromRow(row);
      return rule ? [{ groupKey: row.group_key, rule }] : [];
    });
    const conflict = rulesConflict(existing, groupKey, validated.value);
    if (conflict) return { ok: false, status: 400, error: conflict };

    const rule: AiProviderVendorGroupRule = {
      id: crypto.randomUUID(),
      kind: validated.value.kind,
      value: validated.value.value,
      createdAt: now,
      createdBy: updatedBy,
    };
    db.query(`
      INSERT INTO ai_provider_vendor_group_rules
        (tenant_id, rule_id, group_key, rule_kind, match_value, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tenant.params[0], rule.id, groupKey, rule.kind, rule.value, now, updatedBy);
    const vendorGroup = getVendorGroup(groupKey, ctx, now);
    if (!vendorGroup) return { ok: false, status: 503, error: "vendor group could not be read after rule save" };
    return { ok: true, rule, vendorGroup };
  } catch (error) {
    console.error("[ai-providers] failed to save vendor group rule", error);
    return { ok: false, status: 503, error: "dashboard database is unavailable" };
  }
}

export type DeleteAiProviderVendorGroupRuleResult =
  | { ok: true; ruleId: string; vendorGroup: AiProviderVendorGroup }
  | { ok: false; status: 404 | 503; error: string };

export function deleteAiProviderVendorGroupRule(
  groupKey: string,
  ruleId: string,
  ctx?: TenantContext,
  now = Date.now(),
): DeleteAiProviderVendorGroupRuleResult {
  if (!isVendorGroupKey(groupKey) || !/^[0-9a-f-]{36}$/i.test(ruleId)) {
    return { ok: false, status: 404, error: "No vendor group rule is registered at this path." };
  }
  const db = getDashboardDb();
  if (!db) return { ok: false, status: 503, error: "dashboard database is unavailable" };
  const tenant = whereTenant(ctx);
  try {
    const group = db.query(`SELECT group_key FROM ai_provider_vendor_groups WHERE group_key = ? ${tenant.clause} LIMIT 1`)
      .get(groupKey, ...tenant.params) as { group_key: string } | null;
    if (!group) return { ok: false, status: 404, error: `No vendor group is registered with key \"${groupKey}\".` };
    const rule = db.query(`
      SELECT rule_id FROM ai_provider_vendor_group_rules
      WHERE group_key = ? AND rule_id = ? ${tenant.clause}
      LIMIT 1
    `).get(groupKey, ruleId, ...tenant.params) as { rule_id: string } | null;
    if (!rule) return { ok: false, status: 404, error: "No vendor group rule is registered at this path." };
    db.query(`DELETE FROM ai_provider_vendor_group_rules WHERE group_key = ? AND rule_id = ? ${tenant.clause}`)
      .run(groupKey, ruleId, ...tenant.params);
  } catch (error) {
    console.error("[ai-providers] failed to delete vendor group rule", error);
    return { ok: false, status: 503, error: "dashboard database is unavailable" };
  }
  const vendorGroup = getVendorGroup(groupKey, ctx, now);
  if (!vendorGroup) return { ok: false, status: 503, error: "vendor group could not be read after rule deletion" };
  return { ok: true, ruleId, vendorGroup };
}

export function getAiProviderProfile(providerKey: string, ctx?: TenantContext, now = Date.now()): AiProvider | null {
  const normalized = providerKeyFromObservedIdentifier(providerKey);
  if (!normalized || normalized !== providerKey) return null;
  return listAiProviderProfiles(ctx, now).find((provider) => provider.key === normalized) ?? null;
}

export function validateProviderDeclaration(value: unknown, now = Date.now()): ProviderDeclarationValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "declaration must be an object" };
  }
  const body = value as Record<string, unknown>;
  const required = ["dataClasses", "credentialLocation", "egressBoundary", "owner", "riskLikelihood", "riskImpact", "treatment", "lastReviewedAt"];
  if (required.some((field) => !(field in body))) {
    return { ok: false, error: "declaration must include every provider-risk field" };
  }

  const dataClasses = parseDeclarationStrings(body.dataClasses);
  if (!dataClasses) return { ok: false, error: "dataClasses must be an array of up to 32 non-empty strings" };

  const credentialLocation = parseCredentialLocation(body.credentialLocation);
  if (credentialLocation === undefined) {
    return { ok: false, error: "credentialLocation must be a path or variable name only; never a credential value" };
  }

  const egressBoundary = body.egressBoundary === null ? null : isEgressBoundary(body.egressBoundary) ? body.egressBoundary : undefined;
  if (egressBoundary === undefined) return { ok: false, error: "egressBoundary must be a supported boundary or null" };

  const owner = body.owner === null ? null : typeof body.owner === "string" ? body.owner.trim() || null : undefined;
  if (owner === undefined || (typeof body.owner === "string" && body.owner.length > 200)) {
    return { ok: false, error: "owner must be a string up to 200 characters or null" };
  }

  const likelihood = body.riskLikelihood === null ? null : Number.isInteger(body.riskLikelihood) && Number(body.riskLikelihood) >= 1 && Number(body.riskLikelihood) <= 5 ? Number(body.riskLikelihood) : undefined;
  const impact = body.riskImpact === null ? null : Number.isInteger(body.riskImpact) && Number(body.riskImpact) >= 1 && Number(body.riskImpact) <= 5 ? Number(body.riskImpact) : undefined;
  if (likelihood === undefined || impact === undefined) return { ok: false, error: "riskLikelihood and riskImpact must be integers from 1 to 5 or null" };
  if ((likelihood === null) !== (impact === null)) return { ok: false, error: "riskLikelihood and riskImpact must be set together" };

  const treatment = body.treatment === null ? null : isRiskTreatment(body.treatment) ? body.treatment : undefined;
  if (treatment === undefined) return { ok: false, error: "treatment must be a supported treatment or null" };

  const lastReviewedAt = body.lastReviewedAt === null
    ? null
    : typeof body.lastReviewedAt === "number" && Number.isSafeInteger(body.lastReviewedAt) && body.lastReviewedAt > 0 && body.lastReviewedAt <= now
      ? body.lastReviewedAt
      : undefined;
  if (lastReviewedAt === undefined) return { ok: false, error: "lastReviewedAt must be a non-future millisecond timestamp or null" };

  const input: ProviderDeclarationInput = {
    dataClasses,
    credentialLocation,
    egressBoundary,
    owner,
    riskLikelihood: likelihood,
    riskImpact: impact,
    treatment,
    lastReviewedAt,
  };
  if (lastReviewedAt !== null && declarationState(input) !== "reviewed") {
    return { ok: false, error: "a review date requires complete provider risk, ownership, egress, credential-location, and data-class declarations" };
  }
  return { ok: true, value: input };
}

export type SaveAiProviderDeclarationResult =
  | { ok: true; provider: AiProvider }
  | { ok: false; status: 400 | 404 | 503; error: string };

export function saveAiProviderDeclaration(
  providerKey: string,
  value: unknown,
  updatedBy: string | null,
  ctx?: TenantContext,
  now = Date.now(),
): SaveAiProviderDeclarationResult {
  const normalized = providerKeyFromObservedIdentifier(providerKey);
  if (!normalized || normalized !== providerKey || !collectCandidates(ctx, now).has(normalized)) {
    return { ok: false, status: 404, error: `No observed AI provider is registered with key \"${providerKey}\".` };
  }
  const validated = validateProviderDeclaration(value, now);
  if (validated.ok === false) return { ok: false, status: 400, error: validated.error };

  const db = getDashboardDb();
  if (!db) return { ok: false, status: 503, error: "dashboard database is unavailable" };
  const tenant = whereTenant(ctx);
  try {
    db.query(`
      INSERT INTO ai_provider_risk_profiles
        (tenant_id, provider_key, data_classes_json, credential_location, egress_boundary, owner,
         risk_likelihood, risk_impact, treatment, last_reviewed_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, provider_key) DO UPDATE SET
        data_classes_json = excluded.data_classes_json,
        credential_location = excluded.credential_location,
        egress_boundary = excluded.egress_boundary,
        owner = excluded.owner,
        risk_likelihood = excluded.risk_likelihood,
        risk_impact = excluded.risk_impact,
        treatment = excluded.treatment,
        last_reviewed_at = excluded.last_reviewed_at,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(
      tenant.params[0],
      normalized,
      JSON.stringify(validated.value.dataClasses),
      validated.value.credentialLocation,
      validated.value.egressBoundary,
      validated.value.owner,
      validated.value.riskLikelihood,
      validated.value.riskImpact,
      validated.value.treatment,
      validated.value.lastReviewedAt,
      now,
      updatedBy,
    );
  } catch (error) {
    console.error("[ai-providers] failed to save provider declaration", error);
    return { ok: false, status: 503, error: "dashboard database is unavailable" };
  }

  const provider = getAiProviderProfile(normalized, ctx, now);
  if (!provider) return { ok: false, status: 503, error: "provider profile could not be read after save" };
  return { ok: true, provider };
}
