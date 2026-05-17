import type { OidcConfig, OidcProviderMeta, OidcTokenResponse, OidcClaims, Role } from "./types.ts";

const DISCOVERY_CACHE = new Map<string, { meta: OidcProviderMeta; expiresAt: number }>();

function getCachedDiscovery(issuer: string): OidcProviderMeta | null {
  const entry = DISCOVERY_CACHE.get(issuer);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    DISCOVERY_CACHE.delete(issuer);
    return null;
  }
  return entry.meta;
}

function setCachedDiscovery(issuer: string, meta: OidcProviderMeta): void {
  DISCOVERY_CACHE.set(issuer, { meta, expiresAt: Date.now() + 3600 * 1000 });
}

export async function discoverOidcConfig(issuer: string): Promise<OidcProviderMeta> {
  const cached = getCachedDiscovery(issuer);
  if (cached) return cached;

  const configUrl = issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const res = await fetch(configUrl, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed for ${issuer}: ${res.status} ${res.statusText}`);
  }
  const doc = await res.json() as Record<string, string>;

  const meta: OidcProviderMeta = {
    issuer: doc.issuer || issuer,
    authorizationUrl: doc.authorization_endpoint || "",
    tokenUrl: doc.token_endpoint || "",
    userInfoUrl: doc.userinfo_endpoint,
    jwksUrl: doc.jwks_uri,
    endSessionUrl: doc.end_session_endpoint,
  };

  setCachedDiscovery(issuer, meta);
  return meta;
}

export function buildAuthUrl(config: OidcConfig, state: string, nonce: string): string {
  const base = config.issuer.replace(/\/$/, "");
  const authEndpoint = `${base}/authorize`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
    nonce,
  });
  return `${authEndpoint}?${params.toString()}`;
}

export async function exchangeCode(
  config: OidcConfig,
  code: string,
  meta: OidcProviderMeta,
): Promise<OidcTokenResponse> {
  const res = await fetch(meta.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${errText}`);
  }

  const tokenRes = await res.json() as Record<string, unknown>;
  return {
    accessToken: tokenRes.access_token as string,
    idToken: tokenRes.id_token as string | undefined,
    tokenType: tokenRes.token_type as string || "Bearer",
    expiresIn: tokenRes.expires_in as number || 0,
    refreshToken: tokenRes.refresh_token as string | undefined,
    scope: tokenRes.scope as string | undefined,
  };
}

export async function verifyIdToken(
  idToken: string,
  meta: OidcProviderMeta,
  nonce: string,
): Promise<OidcClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const payloadStr = Buffer.from(parts[1], "base64url").toString("utf8");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    throw new Error("Invalid JWT payload JSON");
  }

  const claims = payload as OidcClaims;
  const now = Math.floor(Date.now() / 1000);

  if (claims.exp && claims.exp < now) {
    throw new Error("ID token expired");
  }
  if (claims.iat && claims.iat > now + 60) {
    throw new Error("ID token issued in the future");
  }
  if (claims.iss !== meta.issuer) {
    throw new Error(`Issuer mismatch: expected ${meta.issuer}, got ${claims.iss}`);
  }
  if (claims.nonce && claims.nonce !== nonce) {
    throw new Error("Nonce mismatch");
  }

  return claims;
}

export function mapGroupsToRole(
  groups: string[],
  mapping: Record<string, string>,
): Role {
  for (const [pattern, role] of Object.entries(mapping)) {
    if (groups.includes(pattern)) {
      const resolved = role as Role;
      if (resolved === "operator" || resolved === "viewer" || resolved === "admin") {
        return resolved;
      }
    }
  }
  return "viewer";
}