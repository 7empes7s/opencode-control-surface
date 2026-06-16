import { readFileSync } from "node:fs";
import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export type TrustCheck = {
  id: string;
  name: string;
  points: number;
  earned: boolean;
  plainSummary: string; // one sentence, plain English
  actionDescriptorId?: string | null; // only when a safe one-click action exists
  manualPageHref: string;
};

export type TrustScore = {
  score: number; // sum of earned points
  maxScore: number; // 100
  checks: TrustCheck[]; // all 10, keep spec order
  improvementActions: TrustCheck[]; // the unearned ones, highest points first
  computedAt: number;
};

const SENTINEL_HEALTH_PATH = "/var/lib/mimule/product-health.json";

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function computeTrustScore(): TrustScore {
  const db = getDashboardDb();
  const tenant = whereTenant();
  const now = Date.now();

  const checks: TrustCheck[] = [
    {
      id: "budget-cap-set",
      name: "Global Budget Cap",
      points: 15,
      earned: false,
      plainSummary: "",
      actionDescriptorId: "mutate-policy:budget:global:set-cap",
      manualPageHref: "/governance",
    },
    {
      id: "no-open-high-security",
      name: "Critical Security Findings",
      points: 15,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/security",
    },
    {
      id: "owner-breadth",
      name: "Owner Breadth",
      points: 10,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/settings",
    },
    {
      id: "real-identity",
      name: "Real Identity",
      points: 10,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/settings",
    },
    {
      id: "actions-attributed",
      name: "Action Attribution",
      points: 10,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/audit",
    },
    {
      id: "policies-loaded",
      name: "Security Policies",
      points: 10,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/governance",
    },
    {
      id: "secrets-vaulted",
      name: "Secrets Management",
      points: 10,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/governance",
    },
    {
      id: "sentinel-health",
      name: "Sentinel Health",
      points: 10,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/",
    },
    {
      id: "agent-liveness",
      name: "Agent Liveness",
      points: 5,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/",
    },
    {
      id: "insights-fresh",
      name: "Insight Freshness",
      points: 5,
      earned: false,
      plainSummary: "",
      actionDescriptorId: null,
      manualPageHref: "/insights",
    },
  ];

  if (!db) {
    return finalizeScore(checks);
  }

  // 1. budget-cap-set
  try {
    const row = db
      .query(
        `SELECT 1 FROM governance_budgets WHERE scope = 'global' AND (daily_cap_usd IS NOT NULL OR monthly_cap_usd IS NOT NULL) ${tenant.clause}`
      )
      .get(...tenant.params);
    const check = checks.find((c) => c.id === "budget-cap-set")!;
    check.earned = !!row;
    check.plainSummary = check.earned
      ? "A global spend cap is active, so no agent can overspend."
      : "No global spend cap is set — one click adds a $5/day safety cap.";
  } catch {}

  // 2. no-open-high-security
  try {
    const row = db
      .query(
        `SELECT 1 FROM insights WHERE domain = 'security' AND status = 'open' AND severity IN ('high', 'critical') ${tenant.clause}`
      )
      .get(...tenant.params);
    const check = checks.find((c) => c.id === "no-open-high-security")!;
    check.earned = !row;
    check.plainSummary = check.earned
      ? "There are no open high or critical security findings."
      : "You have open high or critical security findings that need review.";
  } catch {}

  // 3. owner-breadth
  try {
    const owners = (
      db
        .query(`SELECT COUNT(*) as count FROM governance_role_bindings WHERE role = 'owner' ${tenant.clause}`)
        .get(...tenant.params) as { count: number }
    ).count;
    const total = (
      db
        .query(`SELECT COUNT(*) as count FROM users WHERE 1=1 ${tenant.clause}`)
        .get(...tenant.params) as { count: number }
    ).count;
    const check = checks.find((c) => c.id === "owner-breadth")!;
    // earned when: NOT (owners >= 3 OR (total>0 AND owners*2 > total AND owners > 1))
    const condition = owners >= 3 || (total > 0 && owners * 2 > total && owners > 1);
    check.earned = !condition;
    check.plainSummary = check.earned
      ? "Owner permissions are appropriately restricted."
      : "Ownership is too broad or concentrated — review your admin assignments.";
  } catch {}

  // 4. real-identity
  try {
    const usersCount = (
      db
        .query(`SELECT COUNT(*) as count FROM users WHERE 1=1 ${tenant.clause}`)
        .get(...tenant.params) as { count: number }
    ).count;
    const credsCount = (
      db
        .query(
          `SELECT COUNT(*) as count FROM local_account_credentials WHERE user_id IN (SELECT id FROM users WHERE 1=1 ${tenant.clause})`
        )
        .get(...tenant.params) as { count: number }
    ).count;
    const check = checks.find((c) => c.id === "real-identity")!;
    check.earned = usersCount >= 1 && credsCount >= 1;
    check.plainSummary = check.earned
      ? "Local accounts are configured and verified."
      : "No verified local accounts found — ensure identity provider is linked.";
  } catch {}

  // 5. actions-attributed
  try {
    const row = db
      .query(
        `SELECT 1 FROM action_audit WHERE ts >= ? AND (actor IS NULL OR actor = '') ${tenant.clause}`
      )
      .get(now - 7 * 24 * 3600 * 1000, ...tenant.params);

    const boundaryRow = db
      .query(
        `SELECT target_id, COUNT(*) as count
         FROM action_audit
         WHERE ts >= ? AND action_kind = 'api.unaudited-mutation' ${tenant.clause}
         GROUP BY target_id
         ORDER BY count DESC
         LIMIT 1`
      )
      .get(now - 7 * 24 * 3600 * 1000, ...tenant.params) as { target_id: string | null; count: number } | null;

    const check = checks.find((c) => c.id === "actions-attributed")!;
    check.earned = !row && !boundaryRow;
    if (check.earned) {
      check.plainSummary = "All recent system actions are properly attributed to an actor.";
    } else if (boundaryRow) {
      const endpoint = boundaryRow.target_id ?? "(unknown endpoint)";
      check.plainSummary = `Endpoint ${endpoint} mutated state without its own audit record — add first-class auditing.`;
    } else {
      check.plainSummary = "Some recent actions were anonymous — review audit logs for gaps.";
    }
  } catch {}

  // 6. policies-loaded
  try {
    const row = db
      .query(`SELECT 1 FROM governance_policies WHERE 1=1 ${tenant.clause}`)
      .get(...tenant.params);
    const check = checks.find((c) => c.id === "policies-loaded")!;
    check.earned = !!row;
    check.plainSummary = check.earned
      ? "Security and governance policies are loaded and active."
      : "No governance policies found — the system is running on defaults.";
  } catch {}

  // 7. secrets-vaulted
  try {
    const row = db
      .query(`SELECT 1 FROM governance_secrets WHERE 1=1 ${tenant.clause}`)
      .get(...tenant.params);
    const check = checks.find((c) => c.id === "secrets-vaulted")!;
    check.earned = !!row;
    check.plainSummary = check.earned
      ? "Sensitive credentials are being managed in the secure vault."
      : "The vault is empty — move credentials to governance for safety.";
  } catch {}

  // 8. sentinel-health
  const ph = readJson(SENTINEL_HEALTH_PATH);
  const sentinelCheck = checks.find((c) => c.id === "sentinel-health")!;
  sentinelCheck.earned = (ph?.score ?? 0) >= 90;
  sentinelCheck.plainSummary = sentinelCheck.earned
    ? "The platform sentinel reports high system integrity."
    : "The platform sentinel has detected integrity issues.";

  // 9. agent-liveness
  const agentCheck = checks.find((c) => c.id === "agent-liveness")!;
  agentCheck.earned = !!(ph?.agents && Object.values(ph.agents).every((a: any) => a.ok === true));
  agentCheck.plainSummary = agentCheck.earned
    ? "All configured agents are online and responding correctly."
    : "One or more agents are offline or reporting errors.";

  // 10. insights-fresh
  try {
    const maxCreatedAtRow = db
      .query(`SELECT MAX(created_at) as max_ts FROM insights WHERE 1=1 ${tenant.clause}`)
      .get(...tenant.params) as { max_ts: number | null };
    const maxCreatedAt = maxCreatedAtRow?.max_ts ?? 0;

    const auditRow = db
      .query(
        `SELECT 1 FROM action_audit WHERE action = 'insights.scan' AND ts >= ? ${tenant.clause}`
      )
      .get(now - 24 * 3600 * 1000, ...tenant.params);

    const check = checks.find((c) => c.id === "insights-fresh")!;
    check.earned = maxCreatedAt >= now - 24 * 3600 * 1000 || !!auditRow;
    check.plainSummary = check.earned
      ? "Security insights were updated within the last 24 hours."
      : "Insights are stale — run a fresh security scan now.";
  } catch {}

  return finalizeScore(checks);
}

function finalizeScore(checks: TrustCheck[]): TrustScore {
  const score = checks.reduce((acc, c) => acc + (c.earned ? c.points : 0), 0);
  const improvementActions = checks
    .filter((c) => !c.earned)
    .sort((a, b) => b.points - a.points);

  return {
    score,
    maxScore: 100,
    checks,
    improvementActions,
    computedAt: Date.now(),
  };
}

export function persistDailyTrustSample(): void {
  const db = getDashboardDb();
  if (!db) return;

  const { tenantId } = getCurrentTenantContext();
  const score = computeTrustScore();

  // Get current UTC day start
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();

  try {
    const existing = db
      .query(
        "SELECT 1 FROM metric_samples WHERE source = 'trust-score' AND key = 'daily' AND tenant_id = ? AND ts = ?"
      )
      .get(tenantId, todayStart);

    if (!existing) {
      db.query(
        "INSERT INTO metric_samples (ts, source, key, value_json, tenant_id) VALUES (?, ?, ?, ?, ?)"
      ).run(
        todayStart,
        "trust-score",
        "daily",
        JSON.stringify({ score: score.score, maxScore: score.maxScore }),
        tenantId
      );
    }
  } catch (err) {
    console.error("Failed to persist daily trust sample", err);
  }
}

export function getTrustScoreHistory(days: number = 30): Array<{ ts: number; score: number }> {
  const db = getDashboardDb();
  if (!db) return [];

  const { tenantId } = getCurrentTenantContext();
  const cutoff = Date.now() - days * 24 * 3600 * 1000;

  try {
    const rows = db
      .query(
        "SELECT ts, value_json FROM metric_samples WHERE source = 'trust-score' AND key = 'daily' AND tenant_id = ? AND ts >= ? ORDER BY ts ASC"
      )
      .all(tenantId, cutoff) as Array<{ ts: number; value_json: string }>;

    return rows.map((r) => {
      const val = JSON.parse(r.value_json);
      return { ts: r.ts, score: val.score };
    });
  } catch {
    return [];
  }
}
