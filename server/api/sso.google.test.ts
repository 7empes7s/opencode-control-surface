import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import {
  ssoCallbackHandler,
  ssoConfigPostHandler,
  ssoConfigGetHandler,
  ssoLoginHandler,
} from "./sso.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevFetch: typeof fetch | undefined;
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "sso-callback-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevFetch = globalThis.fetch;
  previousEncryptionKey = process.env.SSO_SESSION_KEY;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.SSO_SESSION_KEY = "test-session-key-padded-to-32chars";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  if (previousEncryptionKey === undefined) delete process.env.SSO_SESSION_KEY;
  else process.env.SSO_SESSION_KEY = previousEncryptionKey;
  globalThis.fetch = prevFetch as typeof fetch;
  rmSync(tempDir, { recursive: true, force: true });
});

function base64UrlEncode(value: object | string): string {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(json, "utf8").toString("base64url");
}

function makeIdToken(payload: Record<string, unknown>): string {
  const header = base64UrlEncode({ alg: "RS256", typ: "JWT" });
  const body = base64UrlEncode({
    iss: "https://accounts.google.com",
    aud: "google-client-id",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "google-sub-123",
    ...payload,
  });
  return `${header}.${body}.sig`;
}

function installGoogleFetchMock(opts: { idTokenEmail: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({
          access_token: "ya29.fake-access",
          id_token: makeIdToken({ email: opts.idTokenEmail }),
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function seedSsoConfigRow(tenantId: string): void {
  const db = getDashboardDb()!;
  const now = Date.now();
  const cfgId = `sso-cfg-${tenantId}`;
  const stored = `kek:sso:${tenantId}:client_secret#placeholder`;
  db.query(`
    INSERT INTO sso_configs
      (id, tenant_id, provider_kind, issuer, client_id, client_secret_enc, redirect_uri, scopes_json, group_mapping_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cfgId,
    tenantId,
    "google-workspace",
    "https://accounts.google.com",
    "google-client-id",
    stored,
    "https://example.com/api/sso/callback",
    JSON.stringify(["openid", "profile", "email"]),
    JSON.stringify({}),
    1,
    now,
    now,
  );
}

function seedUser(tenantId: string, email: string, id: string): void {
  const db = getDashboardDb()!;
  db.query(`
    INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, email, "Test User", "sso", Date.now(), tenantId);
}

function callbackReq(tenantId: string, code: string, state: string, savedState: string, savedNonce: string): Request {
  const cookie = `sso_state=${encodeURIComponent(`${savedState}:${savedNonce}`)}; tenant_id=${tenantId}`;
  const url = `http://localhost/api/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&provider=google`;
  return new Request(url, { headers: { cookie } });
}

describe("ssoCallbackHandler — Google OIDC flow", () => {
  it("returns 403 with plain English error when the id_token email is not in the users table", async () => {
    seedSsoConfigRow("acme-demo");
    installGoogleFetchMock({ idTokenEmail: "stranger@acme.example" });

    const res = await ssoCallbackHandler(
      callbackReq("acme-demo", "auth-code-1", "state-1", "state-1", "nonce-1"),
    );

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Ask the owner to invite you");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("operator_session=");
  });

  it("writes a 'rejected' audit row for unknown-email attempts", async () => {
    seedSsoConfigRow("acme-demo");
    installGoogleFetchMock({ idTokenEmail: "stranger@acme.example" });
    await ssoCallbackHandler(
      callbackReq("acme-demo", "auth-code-2", "state-2", "state-2", "nonce-2"),
    );
    const db = getDashboardDb()!;
    const rows = db.query<{ action_kind: string; error: string; tenant_id: string }, []>(
      `SELECT action_kind, error, tenant_id FROM action_audit WHERE action_kind = 'sso.callback.rejected'`,
    ).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.tenant_id).toBe("acme-demo");
    expect(rows[0]?.error ?? "").toContain("not registered");
  });

  it("issues the operator_session cookie when the id_token email matches a known user", async () => {
    seedSsoConfigRow("acme-demo");
    seedUser("acme-demo", "owner@acme.example", "u-acme-owner");
    installGoogleFetchMock({ idTokenEmail: "owner@acme.example" });

    const res = await ssoCallbackHandler(
      callbackReq("acme-demo", "auth-code-3", "state-3", "state-3", "nonce-3"),
    );

    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("operator_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("tenant_id=acme-demo");
  });

  it("looks up the user only within the matching tenant (cross-tenant isolation)", async () => {
    seedSsoConfigRow("acme-demo");
    seedUser("mimule", "owner@acme.example", "u-mimule-collision");
    installGoogleFetchMock({ idTokenEmail: "owner@acme.example" });

    const res = await ssoCallbackHandler(
      callbackReq("acme-demo", "auth-code-4", "state-4", "state-4", "nonce-4"),
    );

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Ask the owner to invite you");
  });

  it("rejects when the state cookie is missing", async () => {
    seedSsoConfigRow("acme-demo");
    installGoogleFetchMock({ idTokenEmail: "owner@acme.example" });
    const url = `http://localhost/api/sso/callback?code=foo&state=bar&provider=google`;
    const res = await ssoCallbackHandler(new Request(url));
    expect(res.status).toBe(400);
  });

  it("rejects when the state query param doesn't match the saved state cookie", async () => {
    seedSsoConfigRow("acme-demo");
    installGoogleFetchMock({ idTokenEmail: "owner@acme.example" });
    const cookie = `sso_state=${encodeURIComponent("saved:nonce")}`;
    const url = `http://localhost/api/sso/callback?code=foo&state=mismatch&provider=google`;
    const res = await ssoCallbackHandler(new Request(url, { headers: { cookie } }));
    expect(res.status).toBe(400);
  });
});

describe("ssoConfigPostHandler — operator-only config save with audit", () => {
  function postReq(body: object, withAuth = true): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (withAuth) headers["x-operator-token"] = "test-token";
    return new Request("http://localhost/api/sso/config", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("rejects unauthenticated callers with 401", async () => {
    const res = await ssoConfigPostHandler(postReq({
      providerKind: "google-workspace",
      issuer: "https://accounts.google.com",
      clientId: "x",
      clientSecret: "y",
    }, false));
    expect(res.status).toBe(401);
  });

  it("saves the config and writes an audit row when the caller is allowed", async () => {
    let calls = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const res = await ssoConfigPostHandler(postReq({
        providerKind: "google-workspace",
        issuer: "https://accounts.google.com",
        clientId: "google-client",
        clientSecret: "google-secret",
        redirectUri: "https://example.com/api/sso/callback",
      }));
      expect(res.status).toBe(200);
      expect(calls).toBe(1);
      const db = getDashboardDb()!;
      const cfg = db.query<{ issuer: string; client_id: string }, []>(
        `SELECT issuer, client_id FROM sso_configs WHERE tenant_id = 'mimule'`,
      ).get();
      expect(cfg?.issuer).toBe("https://accounts.google.com");
      expect(cfg?.client_id).toBe("google-client");
      const audit = db.query<{ action_kind: string; tenant_id: string }, []>(
        `SELECT action_kind, tenant_id FROM action_audit WHERE action_kind = 'sso.config.update'`,
      ).all();
      expect(audit.length).toBe(1);
      expect(audit[0]?.tenant_id).toBe("mimule");
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("GET /api/sso/config masks the client_secret", async () => {
    let calls = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      await ssoConfigPostHandler(postReq({
        providerKind: "google-workspace",
        issuer: "https://accounts.google.com",
        clientId: "google-client",
        clientSecret: "google-secret",
      }));
      const getRes = await ssoConfigGetHandler(
        new Request("http://localhost/api/sso/config", { headers: { "x-operator-token": "test-token" } }),
      );
      const body = await getRes.json() as { configured: boolean; config: { clientId: string; clientSecret?: string } };
      expect(body.configured).toBe(true);
      expect(body.config.clientId).toBe("google-client");
      expect(body.config.clientSecret).toBeUndefined();
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe("ssoLoginHandler — ?provider=google", () => {
  it("redirects to Google's auth URL when ?provider=google is set", async () => {
    let calls = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      await ssoConfigPostHandler(new Request("http://localhost/api/sso/config", {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-token": "test-token" },
        body: JSON.stringify({
          providerKind: "google-workspace",
          issuer: "https://accounts.google.com",
          clientId: "google-client",
          clientSecret: "google-secret",
        }),
      }));
      const res = await ssoLoginHandler(
        new Request("http://localhost/api/sso/login?provider=google"),
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location") ?? "";
      expect(location).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(location).toContain("client_id=google-client");
      expect(location).toContain("scope=openid");
    } finally {
      globalThis.fetch = previous;
    }
  });
});
