import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export const DEMO_TENANT_ID = "acme-demo";
export const DEMO_TENANT_NAME = "Acme Robotics (demo)";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type InsightSeed = {
  id: string;
  domain: "cost" | "security" | "build" | "data";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  plainSummary: string;
  confidence: number;
  evidenceRefs: Array<{ label: string; ref: string }>;
  actionDescriptorId: string | null;
  manualPageHref: string;
  status: "open" | "applied" | "dismissed" | "resolved";
  sourceKey: string;
  resolvedAt?: number;
  resolution?: string;
};

const INSIGHT_SEEDS: InsightSeed[] = [
  {
    id: "acme-ins-001",
    domain: "cost",
    severity: "medium",
    title: "OpenAI mini batch is 38% above the weekly free tier",
    plainSummary:
      "Your last 7 days of OpenAI mini calls have run 38% over what the free tier allows. Switching these calls to a free-tier model would save roughly $12 over the next week without changing the output quality.",
    confidence: 0.82,
    evidenceRefs: [{ label: "Cost ledger", ref: "cost_events:acme-cost-001..005" }],
    actionDescriptorId: "mutate-policy:budget",
    manualPageHref: "/insights/cost",
    status: "open",
    sourceKey: "cost.openai.mini.weekly-cap",
  },
  {
    id: "acme-ins-002",
    domain: "security",
    severity: "high",
    title: "Two API keys older than 90 days are still active",
    plainSummary:
      "Two of your gateway API keys are older than 90 days. The control plane flagged them in the last security review. Rotating them now is a one-click action — the new keys will be active in under a minute.",
    confidence: 0.91,
    evidenceRefs: [{ label: "Security scan", ref: "agent_team:acme-stale-keys" }],
    actionDescriptorId: "mutate-policy:gateway-keys",
    manualPageHref: "/insights/security",
    status: "resolved",
    sourceKey: "security.stale-keys",
    resolvedAt: NOW - 2 * DAY,
    resolution: "Rotated both keys; old keys revoked and re-issued.",
  },
  {
    id: "acme-ins-003",
    domain: "build",
    severity: "low",
    title: "Builder pass rolled back the rollout page successfully",
    plainSummary:
      "Yesterday's builder pass on the /rollout page detected a regression and rolled it back. The applied rollback restored the previous UI and the build is green again.",
    confidence: 0.95,
    evidenceRefs: [{ label: "Builder pass", ref: "builder_passes:acme-pass-rollback" }],
    actionDescriptorId: null,
    manualPageHref: "/insights/build",
    status: "applied",
    sourceKey: "build.rollout.rollback-applied",
  },
];

type AgentSeed = {
  id: string;
  name: string;
  kind: "runner" | "service" | "pipeline" | "workflow";
  owner: string;
  purpose: string;
  risk_tier: "low" | "medium" | "high";
};

const AGENT_SEEDS: AgentSeed[] = [
  {
    id: "acme-agent-planner",
    name: "Acme Planner",
    kind: "runner",
    owner: "platform@acme.example",
    purpose: "Plans weekly content briefs and triages incoming scout items.",
    risk_tier: "low",
  },
  {
    id: "acme-agent-archive",
    name: "Acme Archive",
    kind: "service",
    owner: "platform@acme.example",
    purpose: "Nightly archive of finished briefs to cold storage.",
    risk_tier: "low",
  },
];

type GatewayCallSeed = {
  id: number;
  logicalModel: string;
  resolvedModel: string;
  backend: string;
  tier: "free" | "paid";
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costEstimateUsd: number;
};

const GATEWAY_CALL_SEEDS: GatewayCallSeed[] = [
  { id: 71001, logicalModel: "openrouter/free-ultra", resolvedModel: "openrouter/nemotron-3-ultra-free", backend: "openrouter", tier: "free", promptTokens: 412, completionTokens: 188, latencyMs: 1820, costEstimateUsd: 0 },
  { id: 71002, logicalModel: "openrouter/free-ultra", resolvedModel: "openrouter/nemotron-3-ultra-free", backend: "openrouter", tier: "free", promptTokens: 388, completionTokens: 142, latencyMs: 1640, costEstimateUsd: 0 },
  { id: 71003, logicalModel: "openrouter/free-ultra", resolvedModel: "openrouter/nemotron-3-ultra-free", backend: "openrouter", tier: "free", promptTokens: 460, completionTokens: 211, latencyMs: 1932, costEstimateUsd: 0 },
  { id: 71004, logicalModel: "openrouter/free-ultra", resolvedModel: "openrouter/nemotron-3-ultra-free", backend: "openrouter", tier: "free", promptTokens: 402, completionTokens: 156, latencyMs: 1755, costEstimateUsd: 0 },
  { id: 71005, logicalModel: "openai/mini", resolvedModel: "openai/gpt-5-mini", backend: "openai", tier: "paid", promptTokens: 312, completionTokens: 144, latencyMs: 2210, costEstimateUsd: 0.41 },
];

const COST_EVENT_SEEDS: Array<{ id: string; gatewayCallId: number; costCents: number; tier: "free" | "paid"; workflowType: string; workflowId: string; project: string }> = [
  { id: "acme-cost-001", gatewayCallId: 71001, costCents: 0, tier: "free", workflowType: "builder", workflowId: "acme-wf-brief", project: "acme-briefs" },
  { id: "acme-cost-002", gatewayCallId: 71002, costCents: 0, tier: "free", workflowType: "scout", workflowId: "acme-scout-2026-06-09", project: "acme-briefs" },
  { id: "acme-cost-003", gatewayCallId: 71003, costCents: 0, tier: "free", workflowType: "reasoner", workflowId: "acme-ri-stale", project: "acme-briefs" },
  { id: "acme-cost-004", gatewayCallId: 71004, costCents: 0, tier: "free", workflowType: "cost", workflowId: "acme-cost-firewall", project: "acme-briefs" },
  { id: "acme-cost-005", gatewayCallId: 71005, costCents: 41, tier: "paid", workflowType: "audit", workflowId: "acme-wf-brief", project: "acme-briefs" },
];

const AUDIT_SEEDS: Array<{ id: number; ts: number; actor: string; actionKind: string; actionId: string; reason: string; risk: "low" | "medium" | "high"; resultStatus: "success" | "failed"; result: string }> = [
  {
    id: 710001,
    ts: NOW - 3 * DAY,
    actor: "Pat Singh",
    actionKind: "sso.config.update",
    actionId: "sso.config.update.google",
    reason: "Connect the workspace Google account to SSO for the demo tenant.",
    risk: "medium",
    resultStatus: "success",
    result: "Google OIDC config saved (client secret encrypted via governance KEK).",
  },
  {
    id: 710002,
    ts: NOW - 1 * DAY,
    actor: "Pat Singh",
    actionKind: "insights.apply",
    actionId: "mutate-policy:gateway-keys",
    reason: "Rotate the two stale gateway API keys flagged in the security review.",
    risk: "medium",
    resultStatus: "success",
    result: "Two keys rotated and the security insight was marked resolved.",
  },
];

function seedTenantRow(db: Database): void {
  db.query(`
    INSERT INTO tenants (id, name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(DEMO_TENANT_ID, DEMO_TENANT_NAME, "active", NOW - 14 * DAY, NOW);
}

function seedTenantSettings(db: Database): void {
  db.query(`
    INSERT INTO tenant_settings
      (tenant_id, data_residency_region, storage_root, audit_retention_days, require_two_approvers, sso_required, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      data_residency_region = excluded.data_residency_region,
      storage_root = excluded.storage_root,
      audit_retention_days = excluded.audit_retention_days,
      updated_at = excluded.updated_at
  `).run(DEMO_TENANT_ID, "us-east", "/var/lib/control-surface/acme-demo", 90, 0, 1, NOW);
}

function seedAgents(db: Database): void {
  const stmt = db.query(`
    INSERT INTO agents
      (id, name, kind, owner, purpose, risk_tier, status, model_access, aliases_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, 'active', '', '[]', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      owner = excluded.owner,
      purpose = excluded.purpose,
      risk_tier = excluded.risk_tier,
      updated_at = excluded.updated_at,
      tenant_id = excluded.tenant_id
  `);
  for (const a of AGENT_SEEDS) {
    stmt.run(a.id, a.name, a.kind, a.owner, a.purpose, a.risk_tier, NOW - 10 * DAY, NOW, DEMO_TENANT_ID);
  }
}

function seedBudget(db: Database): void {
  db.query(`
    INSERT INTO governance_budgets
      (id, scope, project_id, daily_cap_usd, monthly_cap_usd, warn_pct, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      scope = excluded.scope,
      daily_cap_usd = excluded.daily_cap_usd,
      monthly_cap_usd = excluded.monthly_cap_usd,
      warn_pct = excluded.warn_pct,
      updated_at = excluded.updated_at,
      tenant_id = excluded.tenant_id
  `).run(
    "acme-budget-global",
    "global",
    null,
    5,
    80,
    0.8,
    NOW - 7 * DAY,
    NOW,
    DEMO_TENANT_ID,
  );
}

function seedInsights(db: Database): void {
  const stmt = db.query(`
    INSERT INTO insights
      (id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
       action_descriptor_id, manual_page_href, status, tenant_id, created_at, source_key, resolved_at, resolution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      domain = excluded.domain,
      severity = excluded.severity,
      title = excluded.title,
      plain_summary = excluded.plain_summary,
      confidence = excluded.confidence,
      evidence_refs_json = excluded.evidence_refs_json,
      action_descriptor_id = excluded.action_descriptor_id,
      manual_page_href = excluded.manual_page_href,
      status = excluded.status,
      tenant_id = excluded.tenant_id,
      source_key = excluded.source_key,
      resolved_at = excluded.resolved_at,
      resolution = excluded.resolution
  `);
  for (const i of INSIGHT_SEEDS) {
    stmt.run(
      i.id,
      i.domain,
      i.severity,
      i.title,
      i.plainSummary,
      i.confidence,
      JSON.stringify(i.evidenceRefs),
      i.actionDescriptorId,
      i.manualPageHref,
      i.status,
      DEMO_TENANT_ID,
      NOW - 4 * DAY,
      i.sourceKey,
      i.resolvedAt ?? null,
      i.resolution ?? null,
    );
  }
}

function seedGatewayCalls(db: Database): void {
  const callStmt = db.query(`
    INSERT OR REPLACE INTO gateway_calls
      (id, ts, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens,
       latency_ms, cost_estimate_usd, success, caller, trace_id, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  for (const g of GATEWAY_CALL_SEEDS) {
    callStmt.run(
      g.id,
      NOW - (GATEWAY_CALL_SEEDS.length - GATEWAY_CALL_SEEDS.indexOf(g)) * 30 * 60 * 1000,
      g.logicalModel,
      g.resolvedModel,
      g.backend,
      g.tier,
      g.promptTokens,
      g.completionTokens,
      g.latencyMs,
      g.costEstimateUsd,
      "acme-agent-planner",
      `trace-acme-${g.id}`,
      DEMO_TENANT_ID,
    );
  }

  const costStmt = db.query(`
    INSERT OR REPLACE INTO cost_events
      (id, tenant_id, ts, source, logical_model, provider, tier, workflow_type,
       workflow_id, project, article_slug, dossier_id, builder_run_id, gateway_call_id,
       input_tokens, output_tokens, cost_cents, cost_basis, fallback_reason, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)
  `);
  for (const c of COST_EVENT_SEEDS) {
    const call = GATEWAY_CALL_SEEDS.find((g) => g.id === c.gatewayCallId);
    if (!call) continue;
    costStmt.run(
      c.id,
      DEMO_TENANT_ID,
      NOW - (COST_EVENT_SEEDS.length - COST_EVENT_SEEDS.indexOf(c)) * 30 * 60 * 1000,
      "gateway",
      call.logicalModel,
      call.backend,
      c.tier,
      c.workflowType,
      c.workflowId,
      c.project,
      call.id,
      call.promptTokens,
      call.completionTokens,
      c.costCents,
      c.tier === "free" ? "provider_free_tier" : "fallback_estimate",
      JSON.stringify({ source: "demo-tenant-seed" }),
    );
  }
}

function seedAudit(db: Database): void {
  const stmt = db.query(`
    INSERT OR REPLACE INTO action_audit
      (id, ts, user_id, actor, actor_source, action_kind, action, action_id, reason,
       target, target_type, target_id, risk, args_json, request_json, result,
       result_status, result_json, evidence_json, job_id, event_id, rollback_hint,
       error, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of AUDIT_SEEDS) {
    stmt.run(
      a.id,
      a.ts,
      null,
      a.actor,
      "dashboard",
      a.actionKind,
      a.actionKind,
      a.actionId,
      a.reason,
      a.actionKind.startsWith("sso") ? "SSO config" : a.actionKind.startsWith("insights") ? "Insight" : "Action",
      a.actionKind.startsWith("sso") ? "sso_config" : "insight",
      a.actionId,
      a.risk,
      JSON.stringify({ reason: a.reason }),
      JSON.stringify({ reason: a.reason }),
      a.result,
      a.resultStatus,
      JSON.stringify({ result: a.result }),
      JSON.stringify([{ label: "Seed", kind: "demo-tenant", ref: DEMO_TENANT_ID }]),
      null,
      `seed-acme-audit-${a.id}`,
      a.actionKind === "sso.config.update" ? "Delete the sso_configs row for the demo tenant to revert." : "Re-open the insight to retry the action.",
      null,
      DEMO_TENANT_ID,
    );
  }
}

export function seedDemoTenant(db: Database): void {
  if (process.env.DEMO_TENANT !== "1") return;

  const seed = db.transaction(() => {
    seedTenantRow(db);
    seedTenantSettings(db);
    seedAgents(db);
    seedBudget(db);
    seedInsights(db);
    seedGatewayCalls(db);
    seedAudit(db);
  });

  seed();
}

export function _demoSeedIds(): {
  tenantId: string;
  agentIds: string[];
  budgetId: string;
  insightIds: string[];
  gatewayCallIds: number[];
  costEventIds: string[];
  auditIds: number[];
} {
  return {
    tenantId: DEMO_TENANT_ID,
    agentIds: AGENT_SEEDS.map((a) => a.id),
    budgetId: "acme-budget-global",
    insightIds: INSIGHT_SEEDS.map((i) => i.id),
    gatewayCallIds: GATEWAY_CALL_SEEDS.map((g) => g.id),
    costEventIds: COST_EVENT_SEEDS.map((c) => c.id),
    auditIds: AUDIT_SEEDS.map((a) => a.id),
  };
}

export function _resetDemoSeedState(): void {
  // Reserved for tests that want a clean slate. Not used by production seed.
  void randomUUID;
}
