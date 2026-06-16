import { randomUUID, createHmac, timingSafeEqual, createCipheriv, randomBytes, createDecipheriv } from "node:crypto";
import { discoverOidcConfig, buildAuthUrl, exchangeCode, verifyIdToken, mapGroupsToRole } from "../sso/oidc.ts";
import { providerDefaults, extractGroupsFromClaims } from "../sso/mappers.ts";
import type { OidcConfig, OidcSession, SsoProviderKind } from "../sso/types.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { checkToken } from "./actions.ts";
import { requireMutation } from "../governance/rbac.ts";
import { issueOperatorSessionCookie } from "../auth/session.ts";
import { writeActionAudit } from "../db/writer.ts";
import { writeSecret, readSecretPlaintext } from "../governance/secrets.ts";
import { getCurrentTenantContext, tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { getCurrentAuthenticatedUser } from "../auth/session.ts";

const ENCRYPTION_KEY = process.env.SSO_SESSION_KEY ?? "default-dev-key-32-chars-minimum!";

function encrypt(text: string): string {
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, "0"), "utf8");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data: string): string {
  if (!data || !data.includes(":")) return "";
  const [ivHex, encryptedHex] = data.split(":");
  if (!ivHex || !encryptedHex) return "";
  if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(encryptedHex)) return "";
  if (ivHex.length !== 32) return "";
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, "0"), "utf8");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    return decipher.update(encrypted) + decipher.final("utf8");
  } catch {
    return "";
  }
}

const KEK_SECRET_PREFIX = "kek:sso:";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function isKekMarker(value: string): boolean {
  return value.startsWith(KEK_SECRET_PREFIX);
}

function secretNameForClient(tenantId: string): string {
  return `sso:${tenantId}:client_secret`;
}

function encryptClientSecretWithKek(plaintext: string, tenantId: string): string | null {
  try {
    const entry = writeSecret(secretNameForClient(tenantId), plaintext, "SSO OIDC client secret");
    return `${KEK_SECRET_PREFIX}${entry.name}#${entry.encryptedValue}`;
  } catch {
    return null;
  }
}

function decryptClientSecretWithKek(marker: string): string | null {
  const name = marker.slice(KEK_SECRET_PREFIX.length).split("#")[0];
  if (!name) return null;
  try {
    return readSecretPlaintext(name);
  } catch {
    return null;
  }
}

function resolveClientSecret(stored: string, tenantId: string): string {
  if (isKekMarker(stored)) {
    const fromKek = decryptClientSecretWithKek(stored);
    if (fromKek !== null) return fromKek;
  }
  return decrypt(stored);
}

function findUserByEmailInTenant(email: string, tenantId: string): { id: string; email: string; name: string | null } | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query(
    `SELECT id, email, name FROM users
     WHERE lower(email) = lower(?)
       AND (tenant_id = ? OR tenant_id IS NULL)
     LIMIT 1`,
  ).get(email, tenantId) as { id: string; email: string; name: string | null } | null;
  return row;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function currentActorLabel(): string {
  const user = getCurrentAuthenticatedUser();
  if (user) return user.email ?? user.name ?? user.userId;
  return "sso";
}

async function withTenantIdContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run(testTenantContext({ tenantId, source: "session" }), fn);
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
    clientSecret: resolveClientSecret(row.client_secret_enc, tenantId),
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
  const kekStored = encryptClientSecretWithKek(clientSecret, tenantId);
  const stored = kekStored ?? encrypt(clientSecret);
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
  `).run(randomUUID(), tenantId, providerKind, issuer, clientId, stored, redirectUri, JSON.stringify(scopes), JSON.stringify(groupMapping), enabled ? 1 : 0, now, now);
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
  const guard = requireMutation(req);
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
  writeActionAudit({
    actor: currentActorLabel(),
    actorSource: "dashboard",
    actionKind: "sso.config.update",
    actionId: `sso.config.update.${body.providerKind}`,
    reason: "SSO OIDC config updated via API.",
    targetType: "sso_config",
    targetId: tenantId,
    risk: "medium",
    request: {
      providerKind: body.providerKind,
      issuer: body.issuer,
      clientId: body.clientId,
      redirectUri: body.redirectUri,
      enabled: body.enabled ?? true,
    },
    resultStatus: "success",
    result: "SSO config saved (client secret encrypted via governance KEK when available).",
  });
  return json({ ok: true });
}

export async function ssoLoginHandler(req: Request): Promise<Response> {
  const tenantId = getTenantId(req);
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const config = readSsoConfig(tenantId);
  if (!config) return json({ error: "SSO not configured" }, 400);
  const state = randomUUID();
  const nonce = randomUUID();
  let authUrl: string;
  if (provider === "google" || provider === "google-workspace") {
    if (!config.issuer.includes("google")) {
      return json({ error: "Google provider requested but SSO config issuer is not Google" }, 400);
    }
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
      state,
      nonce,
      access_type: "online",
      prompt: "select_account",
    });
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  } else {
    authUrl = buildAuthUrl(config, state, nonce);
  }
  const response = new Response(null, { status: 302 });
  response.headers.set("Location", authUrl);
  response.headers.set("Set-Cookie", `sso_state=${encodeURIComponent(state + ":" + nonce)}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/api/sso`);
  return response;
}

export async function ssoCallbackHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const provider = url.searchParams.get("provider");
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
  return await withTenantIdContext(tenantId, async () => {
    try {
      return await runSsoCallbackFlow(tenantId, config, provider, savedNonce ?? "", code);
    } catch (err) {
      return json({ error: String(err) }, 400);
    }
  });
}

async function runSsoCallbackFlow(
  tenantId: string,
  config: OidcConfig,
  provider: string | null,
  savedNonce: string,
  code: string,
): Promise<Response> {
  let tokenRes: { accessToken: string; idToken?: string; expiresIn: number };
  let meta: { issuer: string; authorizationUrl: string; tokenUrl: string };
  if (provider === "google" || provider === "google-workspace") {
    tokenRes = await exchangeGoogleCode(config, code);
    meta = {
      issuer: "https://accounts.google.com",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: GOOGLE_TOKEN_URL,
    };
  } else {
    meta = await discoverOidcConfig(config.issuer);
    tokenRes = await exchangeCode(config, code, meta);
  }
  if (!tokenRes.idToken) return json({ error: "no id_token in response" }, 400);
  const claims = await verifyIdToken(tokenRes.idToken, meta, savedNonce ?? "");
  const email = (claims.email ?? "").trim();
  if (!email) {
    return jsonError("Your Google account didn't return an email address. Ask the owner to enable the email scope.", 403);
  }
  const user = findUserByEmailInTenant(email, tenantId);
  if (!user) {
    writeActionAudit({
      actor: email,
      actorSource: "sso",
      actionKind: "sso.callback.rejected",
      actionId: "sso.callback.email-unknown",
      reason: "Unknown email attempted to sign in via SSO.",
      targetType: "sso",
      targetId: tenantId,
      risk: "medium",
      request: { email, provider: provider ?? "generic-oidc" },
      resultStatus: "failed",
      result: "Rejected: email not in users table for tenant",
      error: "Email is not registered for this tenant. Ask the owner to invite you.",
    });
    return jsonError("Ask the owner to invite you — that email isn't registered for this tenant.", 403);
  }
  if (provider === "google" || provider === "google-workspace") {
    const response = new Response(null, { status: 302 });
    response.headers.set("Location", "/");
    response.headers.set("Set-Cookie", [
      issueOperatorSessionCookie(user.id, tenantId),
      `tenant_id=${tenantId}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/`,
    ].join(", "));
    writeActionAudit({
      actor: email,
      actorSource: "sso",
      actionKind: "sso.callback.success",
      actionId: "sso.callback.google",
      reason: "Google OIDC sign-in completed for known user.",
      targetType: "user",
      targetId: user.id,
      risk: "low",
      request: { email, provider },
      resultStatus: "success",
      result: "Issued operator session cookie for known user.",
    });
    return response;
  }
  const groups = extractGroupsFromClaims(claims, config.issuer.includes("microsoft") ? "azure-ad" : config.issuer.includes("keycloak") ? "keycloak" : "generic-oidc");
  const role = mapGroupsToRole(groups, config.groupMapping);
  const session: OidcSession = {
    sub: claims.sub,
    email,
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
}

async function exchangeGoogleCode(
  config: { clientId: string; clientSecret: string; redirectUri: string },
  code: string,
): Promise<{ accessToken: string; idToken?: string; expiresIn: number }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed: ${res.status} ${errText}`);
  }
  const tokenRes = await res.json() as Record<string, unknown>;
  return {
    accessToken: tokenRes.access_token as string,
    idToken: tokenRes.id_token as string | undefined,
    expiresIn: (tokenRes.expires_in as number) || 3600,
  };
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

export async function ssoConfigPostHandler(req: Request): Promise<Response> {
  const guard = requireMutation(req);
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
  writeActionAudit({
    actor: currentActorLabel(),
    actorSource: getCurrentTenantContext().source,
    actionKind: "sso.config.update",
    actionId: `sso.config.update.${body.providerKind}`,
    reason: "SSO OIDC config updated via POST /api/sso/config.",
    targetType: "sso_config",
    targetId: tenantId,
    risk: "medium",
    request: {
      providerKind: body.providerKind,
      issuer: body.issuer,
      clientId: body.clientId,
      redirectUri: body.redirectUri,
      enabled: body.enabled ?? true,
    },
    resultStatus: "success",
    result: "SSO config saved (client secret encrypted via governance KEK when available).",
  });
  return json({ ok: true });
}
