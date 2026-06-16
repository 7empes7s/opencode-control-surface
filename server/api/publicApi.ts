import type { RegisteredAgent } from "../agents/registry.ts";
import { listAgents } from "../agents/registry.ts";
import { verifyGatewayKey } from "../gateway/keys.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { readActionAudit } from "../db/writer.ts";
import { listInsights } from "../insights/store.ts";
import { computeTrustScore, type TrustScore } from "../security/score.ts";
import { checkToken } from "./actions.ts";
import {
  createWebhook,
  disableWebhook,
  listWebhooksForTenant,
} from "../webhooks/dispatcher.ts";
import { writeActionAudit } from "../db/writer.ts";

const DEFAULT_RATE_LIMIT_PER_MIN = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

type RateLimitStore = Record<string, { count: number; windowStart: number }>;

let activeRateLimitPerMin: number = DEFAULT_RATE_LIMIT_PER_MIN;

export function _setPublicApiRateLimitForTests(limit: number | null): void {
  activeRateLimitPerMin = limit == null ? DEFAULT_RATE_LIMIT_PER_MIN : Math.max(1, limit);
}

export function _getPublicApiRateLimit(): number {
  return activeRateLimitPerMin;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type PublicApiAuth =
  | { kind: "gateway-key"; agentId: string; keyId: string }
  | { kind: "operator-token" }
  | null;

export function authenticatePublicApi(req: Request): PublicApiAuth {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/);
  if (bearerMatch) {
    const plaintext = bearerMatch[1];
    if (plaintext.startsWith("gwk_")) {
      const verified = verifyGatewayKey(plaintext);
      if (verified) {
        return { kind: "gateway-key", agentId: verified.agentId, keyId: verified.keyId };
      }
    }
  }
  const opToken = req.headers.get("x-operator-token") ?? "";
  if (opToken && checkToken(req)) {
    return { kind: "operator-token" };
  }
  return null;
}

function rateLimitBucket(credential: string): RateLimitStore {
  const g = globalThis as unknown as { __publicApiRateLimit?: RateLimitStore };
  if (!g.__publicApiRateLimit) g.__publicApiRateLimit = {};
  return g.__publicApiRateLimit;
}

function checkAndConsumeRate(credential: string, limitPerMin: number): { allowed: boolean; retryAfter: number } {
  const store = rateLimitBucket(credential);
  const now = Date.now();
  const entry = store[credential];
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    store[credential] = { count: 1, windowStart: now };
    return { allowed: true, retryAfter: 0 };
  }
  if (entry.count >= limitPerMin) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000)) };
  }
  entry.count += 1;
  return { allowed: true, retryAfter: 0 };
}

function plainError(message: string, status: number): Response {
  return json({ error: message }, status);
}

function unauthorizedResponse(): Response {
  return plainError("Please provide a valid Bearer gateway key (gwk_*) or an x-operator-token.", 401);
}

function credentialKey(req: Request, auth: PublicApiAuth): string {
  if (auth?.kind === "gateway-key") return `gk:${auth.keyId}`;
  if (auth?.kind === "operator-token") {
    return `op:${req.headers.get("x-operator-token") ?? "unknown"}`;
  }
  return "anon";
}

function withAuth(
  req: Request,
  handler: (auth: Exclude<PublicApiAuth, null>) => Response,
): Response {
  const auth = authenticatePublicApi(req);
  if (!auth) return unauthorizedResponse();
  const credential = credentialKey(req, auth);
  const rate = checkAndConsumeRate(credential, activeRateLimitPerMin);
  if (!rate.allowed) {
    return new Response(JSON.stringify({ error: `Rate limit exceeded (${activeRateLimitPerMin} req/min). Retry in ${rate.retryAfter}s.` }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(rate.retryAfter) },
    });
  }
  return handler(auth);
}

type RedactedAudit = {
  actor: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  resultStatus: string | null;
  ts: number;
};

function redactAuditRows(rows: ReturnType<typeof readActionAudit>): RedactedAudit[] {
  return rows.map((r) => ({
    actor: r.actor ?? null,
    action: r.actionKind,
    targetType: r.targetType ?? null,
    targetId: r.targetId ?? null,
    resultStatus: r.resultStatus ?? null,
    ts: r.ts,
  }));
}

export function publicApiInsightsHandler(req: Request): Response {
  return withAuth(req, () => {
    const insights = listInsights("open");
    return json({
      openCount: insights.length,
      insights: insights.map((i) => ({
        id: i.id,
        domain: i.domain,
        severity: i.severity,
        title: i.title,
        plainSummary: i.plainSummary,
        confidence: i.confidence,
        actionDescriptorId: i.actionDescriptorId,
        manualPageHref: i.manualPageHref,
        createdAt: i.createdAt,
      })),
    });
  });
}

export function publicApiAgentsHandler(req: Request): Response {
  return withAuth(req, () => {
    const agents: RegisteredAgent[] = listAgents();
    return json({
      count: agents.length,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        owner: a.owner,
        purpose: a.purpose,
        riskTier: a.riskTier,
        status: a.status,
        modelAccess: a.modelAccess,
        lastSeenAt: a.lastSeenAt,
        audit7d: a.audit7d,
        spend30dUsd: a.spend30dUsd,
      })),
    });
  });
}

export function publicApiAuditHandler(req: Request): Response {
  return withAuth(req, () => {
    const rows = readActionAudit({}).slice(0, 100);
    return json({
      count: rows.length,
      rows: redactAuditRows(rows),
    });
  });
}

export function publicApiTrustScoreHandler(req: Request): Response {
  return withAuth(req, () => {
    const score: TrustScore = computeTrustScore();
    return json({
      score: score.score,
      maxScore: score.maxScore,
      computedAt: score.computedAt,
      unearnedChecks: score.improvementActions.slice(0, 5).map((c) => ({
        id: c.id,
        name: c.name,
        points: c.points,
        plainSummary: c.plainSummary,
        manualPageHref: c.manualPageHref,
      })),
    });
  });
}

export function publicApiCostHandler(req: Request): Response {
  return withAuth(req, () => {
    if (!isDashboardDbEnabled()) {
      return json({ enabled: false, totalCostUsd: 0, calls: 0 });
    }
    const db = getDashboardDb();
    if (!db) {
      return json({ enabled: false, totalCostUsd: 0, calls: 0 });
    }
    const tenant = whereTenant();
    const now = Date.now();
    const since = now - 30 * 24 * 60 * 60 * 1000;
    const row = db.query(`
      SELECT
        COUNT(*) AS calls,
        COALESCE(SUM(cost_estimate_usd), 0) AS total_cost
      FROM gateway_calls
      WHERE ts >= ? ${tenant.clause}
    `).get(since, ...tenant.params) as { calls: number; total_cost: number } | null;
    const calls = Number(row?.calls ?? 0);
    const totalCostUsd = Number(Number(row?.total_cost ?? 0).toFixed(4));
    return json({
      enabled: true,
      window: "30d",
      calls,
      totalCostUsd,
      averageCostPerCallUsd: calls > 0 ? Number((totalCostUsd / calls).toFixed(6)) : 0,
    });
  });
}

// ── Management API (operator token, x-operator-token or checkToken) ──────────

function authFromOperatorToken(req: Request): { allowed: boolean } {
  return { allowed: checkToken(req) };
}

export function webhooksListHandler(req: Request): Response {
  const guard = authFromOperatorToken(req);
  if (!guard.allowed) return plainError("Please sign in to manage webhooks.", 401);
  const list = listWebhooksForTenant();
  return json({ count: list.length, webhooks: list });
}

export async function webhooksCreateHandler(req: Request): Promise<Response> {
  if (!checkToken(req)) return plainError("Please sign in to manage webhooks.", 401);
  let body: { url?: string; events?: string[] };
  try {
    body = await req.json() as { url?: string; events?: string[] };
  } catch {
    return plainError("invalid json body", 400);
  }
  if (!body.url || typeof body.url !== "string") return plainError("url is required", 400);
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return plainError("events must be a non-empty array of event names", 400);
  }

  let created: Awaited<ReturnType<typeof createWebhook>>;
  try {
    created = createWebhook({ url: body.url, events: body.events });
  } catch (err) {
    return plainError(err instanceof Error ? err.message : "invalid webhook", 400);
  }
  if (!created) return plainError("Failed to create webhook. Is the dashboard database enabled?", 500);

  writeActionAudit({
    actor: "operator",
    actorSource: "dashboard",
    actionKind: "webhooks.create",
    targetType: "webhook",
    targetId: created.webhook.id,
    risk: "medium",
    request: { url: created.webhook.url, events: created.webhook.events },
    resultStatus: "success",
    result: "webhook created",
  });

  return json({
    webhook: created.webhook,
    secret: created.secret,
    secretMessage: "Save the secret now — it will not be shown again. Use it to verify X-CS-Signature on incoming deliveries.",
  }, 201);
}

export function webhooksDisableHandler(req: Request, id: string): Response {
  if (!checkToken(req)) return plainError("Please sign in to manage webhooks.", 401);
  if (!id) return plainError("webhook id is required", 400);
  const ok = disableWebhook(id);
  if (!ok) return plainError("webhook not found", 404);
  writeActionAudit({
    actor: "operator",
    actorSource: "dashboard",
    actionKind: "webhooks.disable",
    targetType: "webhook",
    targetId: id,
    risk: "low",
    request: { id },
    resultStatus: "success",
    result: "webhook disabled",
  });
  return json({ ok: true, id, status: "disabled" });
}
