import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDashboardDb } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

const LEGACY_SESSION_LABEL = "opencode-control-surface.operator-session.v1";
const SESSION_VERSION = 2;
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type AuthenticatedUser = {
  userId: string;
  tenantId: string;
  email?: string | null;
  name?: string | null;
  source: "local" | "sso" | "operator-bootstrap" | "dev-bootstrap";
  bootstrapOwner?: boolean;
};

type SignedSessionPayload = {
  v: number;
  userId: string;
  tenantId: string;
  issuedAt: number;
};

export const authStore = new AsyncLocalStorage<AuthenticatedUser | null>();

export function getCurrentAuthenticatedUser(): AuthenticatedUser | null {
  return authStore.getStore() ?? null;
}

export function withRequestAuthContext<A extends unknown[]>(
  handler: (req: Request, ...args: A) => Response | Promise<Response>,
): (req: Request, ...args: A) => Promise<Response> {
  return async (req: Request, ...args: A): Promise<Response> => {
    const user = getAuthenticatedUser(req);
    return authStore.run(user, () => handler(req, ...args));
  };
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") ?? "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function constantEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function isLocalRequest(req: Request): boolean {
  const host = req.headers.get("host")?.split(":")[0] ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function bootstrapOwnerAllowed(req?: Request): boolean {
  if (req && isLocalRequest(req)) return true;
  return process.env.NODE_ENV !== "production";
}

export function expectedLegacySessionValue(token: string): string {
  return createHmac("sha256", token)
    .update(LEGACY_SESSION_LABEL)
    .digest("base64url");
}

function sessionSecret(): string {
  return process.env.OPERATOR_SESSION_SECRET || process.env.OPERATOR_TOKEN || "dev-only-operator-session-secret";
}

function signPayload(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function encodePayload(payload: SignedSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(value: string): SignedSessionPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SignedSessionPayload>;
    if (parsed.v !== SESSION_VERSION) return null;
    if (!parsed.userId || !parsed.tenantId || !parsed.issuedAt) return null;
    return {
      v: SESSION_VERSION,
      userId: String(parsed.userId),
      tenantId: String(parsed.tenantId),
      issuedAt: Number(parsed.issuedAt),
    };
  } catch {
    return null;
  }
}

export function createOperatorSessionValue(userId: string, tenantId: string): string {
  const payload = encodePayload({ v: SESSION_VERSION, userId, tenantId, issuedAt: Date.now() });
  return `v${SESSION_VERSION}.${payload}.${signPayload(payload)}`;
}

export function issueOperatorSessionCookie(userId: string, tenantId: string): string {
  return [
    `operator_session=${encodeURIComponent(createOperatorSessionValue(userId, tenantId))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ].join("; ");
}

function verifySignedSession(value: string): SignedSessionPayload | null {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== `v${SESSION_VERSION}`) return null;
  const [, payload, signature] = parts;
  if (!constantEqual(signature, signPayload(payload))) return null;
  const decoded = decodePayload(payload);
  if (!decoded) return null;
  if (Date.now() - decoded.issuedAt > SESSION_MAX_AGE_SECONDS * 1000) return null;
  return decoded;
}

function lookupUser(userId: string, tenantId: string): AuthenticatedUser | null {
  const db = getDashboardDb();
  if (!db) return { userId, tenantId, source: "local" };
  const row = db.query(
    `SELECT id, email, name, auth_method
     FROM users
     WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
     LIMIT 1`,
  ).get(userId, tenantId) as { id: string; email: string; name: string | null; auth_method: string } | null;
  if (!row) return null;
  return {
    userId: row.id,
    tenantId,
    email: row.email,
    name: row.name,
    source: row.auth_method === "sso" ? "sso" : "local",
  };
}

export function getAuthenticatedUser(req: Request): AuthenticatedUser | null {
  const ctx = getCurrentTenantContext();
  const cookies = parseCookies(req);
  const sessionCookie = cookies.operator_session || cookies.auth_token || "";
  if (sessionCookie) {
    const signed = verifySignedSession(sessionCookie);
    if (signed) {
      return lookupUser(signed.userId, signed.tenantId) ?? {
        userId: signed.userId,
        tenantId: signed.tenantId,
        source: "local",
      };
    }
  }

  // Token-derived credentials (header, bearer, HMAC legacy cookie) are valid from
  // ANY origin in any mode: possession of the operator token IS operator identity.
  // Only the credential-less dev bootstrap below is origin/mode gated — gating the
  // token paths would lock the operator out of the public URL under
  // NODE_ENV=production (the /api/auth/session exchange issues the legacy cookie).
  const token = process.env.OPERATOR_TOKEN;
  if (token) {
    const headerToken = req.headers.get("x-operator-token");
    if (headerToken && constantEqual(headerToken, token)) {
      return { userId: "operator-bootstrap", tenantId: ctx.tenantId, source: "operator-bootstrap", bootstrapOwner: true };
    }
    const authHeader = req.headers.get("authorization") ?? "";
    const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (bearerMatch?.[1] && constantEqual(bearerMatch[1], token)) {
      return { userId: "operator-bootstrap", tenantId: ctx.tenantId, source: "operator-bootstrap", bootstrapOwner: true };
    }
    if (sessionCookie && constantEqual(sessionCookie, expectedLegacySessionValue(token))) {
      return { userId: "operator-bootstrap", tenantId: ctx.tenantId, source: "operator-bootstrap", bootstrapOwner: true };
    }
    return null;
  }

  if (bootstrapOwnerAllowed(req) && isLocalRequest(req)) {
    return { userId: "dev-bootstrap", tenantId: ctx.tenantId, source: "dev-bootstrap", bootstrapOwner: true };
  }

  return null;
}

export function requireAuthenticated(req: Request): AuthenticatedUser | Response {
  const user = getAuthenticatedUser(req);
  if (user) return user;
  return Response.json({ error: "Please sign in to continue." }, { status: 401 });
}
