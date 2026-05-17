import { randomUUID, createHmac, timingSafeEqual, createCipheriv, randomBytes, createDecipheriv } from "node:crypto";
import { discoverOidcConfig, buildAuthUrl, exchangeCode, verifyIdToken, mapGroupsToRole } from "../sso/oidc.ts";
import { providerDefaults, extractGroupsFromClaims } from "../sso/mappers.ts";
import type { OidcConfig, OidcSession, SsoProviderKind } from "../sso/types.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { checkToken } from "./actions.ts";

const ENCRYPTION_KEY = process.env.SSO_SESSION_KEY ?? "default-dev-key-32-chars-minimum!";

function encrypt(text: string): string {
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, "0"), "utf8");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data: string): string {
  const [ivHex, encryptedHex] = data.split(":");
  if (!ivHex || !encryptedHex) return "";
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, "0"), "utf8");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return decipher.update(encrypted) + decipher.final("utf8");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function operatorOnly(req: Request): Response | null {
  if (!checkToken(req)) return json({ error: "unauthorized" }, 401);
  return null;
}

function ssoCookieName(): string {
  return "sso_session";
}

function parseCookies(req: Request): Record<string, string> {
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

function setCookieHeader(value: string, maxAge: number): string {
  return `${ssoCookieName()}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/`;
}

function getTenantId(req: Request): string {
  const cookies = parseCookies(req);
  return cookies["tenant_id"] ?? "mimule";
}

function readSsoConfig(tenantId: string): OidcConfig | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query<{
    issuer: string;
    client_id: string;
    client_secret_enc: string;
    redirect_uri: string;
    scopes_json: string;
    group_mapping_json: string;
    provider_kind: string;
  }, [string]>(
    "SELECT issuer, client_id, client_secret_enc, redirect_uri, scopes_json, group_mapping_json, provider_kind, enabled FROM sso_configs WHERE tenant_id = ? LIMIT 1"
  ).get(tenantId);
  if (!row) return null;
  return {
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret: decrypt(row.client_secret_enc),
    redirectUri: row.redirect_uri ?? "",
    scopes: JSON.parse(row.scopes_json || "[]"),
    groupMapping: JSON.parse(row.group_mapping_json || "{}"),
  };
}

function writeSsoConfig(
  tenantId: string,
  providerKind: SsoProviderKind,
  issuer: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  scopes: string[],
  groupMapping: Record<string, "operator" | "viewer" | "admin">,
  enabled: boolean,
): void {
  const db = getDashboardDb();
  if (!db) return;
  const now = Date.now();
  db.query(`
    INSERT INTO sso_configs (id, tenant_id, provider_kind, issuer, client_id, client_secret_enc, redirect_uri, scopes_json, group_mapping_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      provider_kind = excluded.provider_kind,
      issuer = excluded.issuer,
      client_id = excluded.client_id,
      client_secret_enc = excluded.client_secret_enc,
      redirect_uri = excluded.redirect_uri,
      scopes_json = excluded.scopes_json,
      group_mapping_json = excluded.group_mapping_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(randomUUID(), tenantId, providerKind, issuer, clientId, encrypt(clientSecret), redirectUri, JSON.stringify(scopes), JSON.stringify(groupMapping), enabled ? 1 : 0, now, now);
}

function readSsoSession(sessionId: string): OidcSession | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query<{
    sub: string;
    email: string;
    role: string;
    groups_json: string;
    access_token_enc: string;
    expires_at: number;
  }, [string]>(
    "SELECT sub, email, role, groups_json, access_token_enc, expires_at FROM sso_sessions WHERE id = ?"
  ).get(sessionId);
  if (!row) return null;
  return {
    sub: row.sub,
    email: row.email ?? "",
    groups: JSON.parse(row.groups_json || "[]"),
    role: row.role as "operator" | "viewer" | "admin",
    accessToken: decrypt(row.access_token_enc),
    expiresAt: row.expires_at,
  };
}

function writeSsoSession(session: OidcSession, tenantId: string, id: string): void {
  const db = getDashboardDb();
  if (!db) return;
  db.query(`
    INSERT INTO sso_sessions (id, tenant_id, sub, email, role, groups_json, access_token_enc, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sub = excluded.sub,
      email = excluded.email,
      role = excluded.role,
      groups_json = excluded.groups_json,
      access_token_enc = excluded.access_token_enc,
      expires_at = excluded.expires_at
  `).run(id, tenantId, session.sub, session.email, session.role, JSON.stringify(session.groups), encrypt(session.accessToken), session.expiresAt, Date.now());
}

function deleteSsoSession(sessionId: string): void {
  const db = getDashboardDb();
  if (!db) return;
  db.query("DELETE FROM sso_sessions WHERE id = ?").run(sessionId);
}

function getCurrentSession(req: Request): { sessionId: string; session: OidcSession } | null {
  const cookies = parseCookies(req);
  const sessionId = cookies[ssoCookieName()];
  if (!sessionId) return null;
  const session = readSsoSession(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    deleteSsoSession(sessionId);
    return null;
  }
  return { sessionId, session };
}

export async function ssoConfigGetHandler(req: Request): Promise<Response> {
  const guard = operatorOnly(req);
  if (guard) return guard;
  const tenantId = getTenantId(req);
  const config = readSsoConfig(tenantId);
  if (!config) return json({ configured: false });
  const { clientSecret: _unused, ...safeConfig } = config;
  void _unused;
  return json({ configured: true, config: safeConfig });
}

export async function ssoConfigPutHandler(req: Request): Promise<Response> {
  const guard = operatorOnly(req);
  if (guard) return guard;
  const tenantId = getTenantId(req);
  let body: {
    providerKind?: SsoProviderKind;
    issuer?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    scopes?: string[];
    groupMapping?: Record<string, "operator" | "viewer" | "admin">;
    enabled?: boolean;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.providerKind || !body.issuer || !body.clientId || !body.clientSecret) {
    return json({ error: "providerKind, issuer, clientId, clientSecret are required" }, 400);
  }
  if (body.enabled !== false) {
    try {
      await discoverOidcConfig(body.issuer);
    } catch {
      return json({ error: "issuer not reachable — OIDC discovery failed" }, 400);
    }
  }
  const defaults = providerDefaults(body.providerKind);
  writeSsoConfig(
    tenantId,
    body.providerKind,
    body.issuer,
    body.clientId,
    body.clientSecret,
    body.redirectUri ?? defaults.redirectUri ?? "",
    body.scopes ?? defaults.scopes ?? ["openid", "profile", "email"],
    body.groupMapping ?? defaults.groupMapping ?? {},
    body.enabled ?? true,
  );
  return json({ ok: true });
}

export async function ssoLoginHandler(req: Request): Promise<Response> {
  const tenantId = getTenantId(req);
  const config = readSsoConfig(tenantId);
  if (!config) return json({ error: "SSO not configured" }, 400);
  const state = randomUUID();
  const nonce = randomUUID();
  const url = buildAuthUrl(config, state, nonce);
  const response = new Response(null, { status: 302 });
  response.headers.set("Location", url);
  response.headers.set("Set-Cookie", `sso_state=${encodeURIComponent(state + ":" + nonce)}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/api/sso`);
  return response;
}

export async function ssoCallbackHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  if (errorParam) return json({ error: errorParam }, 400);
  if (!code || !stateParam) return json({ error: "missing code or state" }, 400);
  const cookies = parseCookies(req);
  const stateCookie = cookies["sso_state"];
  if (!stateCookie) return json({ error: "missing state cookie" }, 400);
  const [savedState, savedNonce] = stateCookie.split(":");
  if (savedState !== stateParam) return json({ error: "state mismatch" }, 400);
  const tenantId = getTenantId(req);
  const config = readSsoConfig(tenantId);
  if (!config) return json({ error: "SSO not configured" }, 400);
  try {
    const meta = await discoverOidcConfig(config.issuer);
    const tokenRes = await exchangeCode(config, code, meta);
    if (!tokenRes.idToken) return json({ error: "no id_token in response" }, 400);
    const claims = await verifyIdToken(tokenRes.idToken, meta, savedNonce ?? "");
    const groups = extractGroupsFromClaims(claims, config.issuer.includes("microsoft") ? "azure-ad" : config.issuer.includes("keycloak") ? "keycloak" : "generic-oidc");
    const role = mapGroupsToRole(groups, config.groupMapping);
    const session: OidcSession = {
      sub: claims.sub,
      email: claims.email ?? "",
      groups,
      role,
      accessToken: tokenRes.accessToken,
      expiresAt: Date.now() + (tokenRes.expiresIn || 3600) * 1000,
    };
    const sessionId = randomUUID();
    writeSsoSession(session, tenantId, sessionId);
    const response = new Response(null, { status: 302 });
    response.headers.set("Location", "/");
    response.headers.set("Set-Cookie", [
      setCookieHeader(sessionId, Math.floor((session.expiresAt - Date.now()) / 1000)),
      `tenant_id=${tenantId}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/`,
    ].join(", "));
    return response;
  } catch (err) {
    return json({ error: String(err) }, 400);
  }
}

export async function ssoLogoutHandler(req: Request): Promise<Response> {
  const { sessionId } = getCurrentSession(req) ?? {};
  if (sessionId) deleteSsoSession(sessionId);
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
  response.headers.set("Set-Cookie", `${ssoCookieName()}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
  return response;
}

export function ssoSessionHandler(req: Request): Response {
  const result = getCurrentSession(req);
  if (!result) return json({ authenticated: false });
  return json({
    authenticated: true,
    session: {
      sub: result.session.sub,
      email: result.session.email,
      groups: result.session.groups,
      role: result.session.role,
      expiresAt: result.session.expiresAt,
    },
  });
}