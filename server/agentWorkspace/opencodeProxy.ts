import { randomUUID } from "node:crypto";
import { normalizeWorkspace } from "../api/workspaces.ts";
import { getAuthenticatedUser, withRequestAuthContext } from "../auth/session.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getRoleForRequest } from "../governance/rbac.ts";
import { withTenantContext } from "../tenancy/middleware.ts";
import type { AgentIdentity, AgentSession } from "./registry.ts";
import {
  acquireWriterLease,
  archiveAgentSession,
  appendAgentEvent,
  authorizeAdapterSession,
  getAgentSessionByAdapter,
  isInternalAdapterSession,
  isLegacyOpenCodeVisibilityReady,
  isReservedOpenCodeTitle,
  listAgentSessions,
  rebindWriterLease,
  recordInternalVisibility,
  registerAgentSession,
  releaseWriterLeaseForSession,
} from "./registry.ts";
import { createOpenCodeEventResponse } from "./opencodeEventSpool.ts";

const DEFAULT_OPENCODE_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type OpenCodeSessionPayload = {
  id?: unknown;
  title?: unknown;
  directory?: unknown;
  version?: unknown;
  time?: { created?: unknown; updated?: unknown };
  [key: string]: unknown;
};

let upstreamFetch: FetchLike = fetch;

export type OpenCodeRoute =
  | { kind: "session-list" }
  | { kind: "session-create" }
  | { kind: "session-direct"; sessionId: string; mutation: boolean }
  | { kind: "events" }
  | { kind: "configuration" };

export function classifyOpenCodeRoute(method: string, targetPath: string): OpenCodeRoute | null {
  if (method === "GET" && targetPath === "/session") return { kind: "session-list" };
  if (method === "POST" && targetPath === "/session") return { kind: "session-create" };
  if (method === "GET" && targetPath === "/event") return { kind: "events" };
  if (method === "GET" && (targetPath === "/config" || targetPath === "/config/providers")) {
    return { kind: "configuration" };
  }
  // Kept until the later adapter-migration slice replaces OpenCode's current
  // global model mutation with session-scoped launch configuration.
  if (method === "PATCH" && targetPath === "/global/config") return { kind: "configuration" };

  const direct = targetPath.match(/^\/session\/([^/]+)(?:\/(message|abort|permissions\/[^/]+|permission\/[^/]+))?$/);
  if (!direct) return null;
  let sessionId: string;
  try { sessionId = decodeURIComponent(direct[1]); }
  catch { return null; }
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const suffix = direct[2] ?? "";
  const allowed =
    (method === "GET" && (suffix === "" || suffix === "message")) ||
    (method === "DELETE" && suffix === "") ||
    (method === "POST" && (suffix === "message" || suffix === "abort" || suffix.startsWith("permissions/") || suffix.startsWith("permission/")));
  return allowed ? { kind: "session-direct", sessionId, mutation: method !== "GET" } : null;
}

function jsonError(error: string, status: number, code: string): Response {
  return Response.json({ error, code }, { status });
}

function requestIdentity(req: Request): AgentIdentity | null {
  const user = getAuthenticatedUser(req);
  if (!user) return null;
  return { tenantId: user.tenantId, userId: user.userId, role: getRoleForRequest(req) };
}

async function readBoundedBody(req: Request): Promise<ArrayBuffer | Response> {
  const stated = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(stated) && stated > MAX_BODY_BYTES) return jsonError("request body too large", 413, "BODY_TOO_LARGE");
  const body = await req.arrayBuffer();
  return body.byteLength <= MAX_BODY_BYTES ? body : jsonError("request body too large", 413, "BODY_TOO_LARGE");
}

function forwardHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-operator-token");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  return headers;
}

function cleanUpstreamHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("set-cookie");
  return headers;
}

function titleOf(session: OpenCodeSessionPayload): string {
  return typeof session.title === "string" ? session.title : "OpenCode session";
}

function sessionIdOf(session: OpenCodeSessionPayload): string | null {
  return typeof session.id === "string" && SESSION_ID_RE.test(session.id) ? session.id : null;
}

function filterSessionList(identity: AgentIdentity, value: unknown): OpenCodeSessionPayload[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(listAgentSessions(identity, "opencode").map((session) => session.adapterSessionId));
  const result: OpenCodeSessionPayload[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const session = item as OpenCodeSessionPayload;
    const id = sessionIdOf(session);
    if (!id) continue;
    if (isReservedOpenCodeTitle(session.title)) {
      recordInternalVisibility({
        harness: "opencode",
        adapterSessionId: id,
        reason: "reserved internal producer marker",
        source: "opencode-reserved-marker-v1",
        evidence: { marker: "__mimule_probe_v1__:" },
      });
      continue;
    }
    if (isInternalAdapterSession("opencode", id) || !allowed.has(id)) continue;
    result.push(session);
  }
  return result;
}

async function upstreamRequest(
  req: Request,
  targetPath: string,
  search: string,
  body?: BodyInit,
  upstreamUrl = DEFAULT_OPENCODE_URL,
): Promise<Response> {
  try {
    return await upstreamFetch(`${upstreamUrl}${targetPath}${search}`, {
      method: req.method,
      headers: forwardHeaders(req),
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return jsonError("OpenCode server unavailable", 502, "UPSTREAM_UNAVAILABLE");
  }
}

async function handleSessionList(req: Request, identity: AgentIdentity, search: string): Promise<Response> {
  const params = new URLSearchParams(search);
  const requested = Number(params.get("limit") ?? 1000);
  params.set("limit", String(Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 1000, 5000))));
  const response = await upstreamRequest(req, "/session", `?${params.toString()}`);
  if (!response.ok) return new Response(response.body, { status: response.status, headers: cleanUpstreamHeaders(response) });
  const value = await response.json().catch(() => null);
  return Response.json(filterSessionList(identity, value));
}

async function handleSessionCreate(req: Request, identity: AgentIdentity, upstreamUrl: string): Promise<Response> {
  const raw = await readBoundedBody(req);
  if (raw instanceof Response) return raw;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>; }
  catch { return jsonError("invalid JSON body", 400, "INVALID_JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return jsonError("invalid JSON body", 400, "INVALID_JSON");
  if (isReservedOpenCodeTitle(payload.title)) {
    return jsonError("the internal probe namespace is reserved", 403, "RESERVED_CLASSIFICATION");
  }
  const workspace = normalizeWorkspace(typeof payload.directory === "string" ? payload.directory : undefined);
  if (workspace.ok === false) return jsonError(workspace.error, 400, "WORKSPACE_NOT_ALLOWED");
  payload.directory = workspace.path;

  const provisionalSessionId = `pending:${randomUUID()}`;
  const lease = acquireWriterLease({
    tenantId: identity.tenantId,
    resourceKey: workspace.path,
    sessionId: provisionalSessionId,
    userId: identity.userId,
  });
  if (!lease.ok) {
    return jsonError("another session already holds the shared-checkout writer lease", 409, "WRITER_LEASE_CONFLICT");
  }

  const headers = forwardHeaders(req);
  headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await upstreamFetch(`${upstreamUrl}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    releaseWriterLeaseForSession(workspace.path, provisionalSessionId);
    return jsonError("OpenCode server unavailable", 502, "UPSTREAM_UNAVAILABLE");
  }
  const responseText = await response.text();
  if (!response.ok) {
    releaseWriterLeaseForSession(workspace.path, provisionalSessionId);
    return new Response(responseText, { status: response.status, headers: cleanUpstreamHeaders(response) });
  }
  let sessionPayload: OpenCodeSessionPayload;
  try { sessionPayload = JSON.parse(responseText) as OpenCodeSessionPayload; }
  catch {
    releaseWriterLeaseForSession(workspace.path, provisionalSessionId);
    return jsonError("OpenCode returned an invalid session", 502, "UPSTREAM_INVALID_RESPONSE");
  }
  const adapterSessionId = sessionIdOf(sessionPayload);
  if (!adapterSessionId) {
    releaseWriterLeaseForSession(workspace.path, provisionalSessionId);
    return jsonError("OpenCode returned an invalid session", 502, "UPSTREAM_INVALID_RESPONSE");
  }
  const session = registerAgentSession({
    tenantId: identity.tenantId,
    ownerUserId: identity.userId,
    harness: "opencode",
    adapterSessionId,
    adapterVersion: typeof sessionPayload.version === "string" ? sessionPayload.version : "v2",
    title: titleOf(sessionPayload),
    workspaceRoot: workspace.path,
    repositoryRoot: workspace.path,
    accessMode: "writer",
    requestedConfig: payload,
    effectiveConfig: sessionPayload,
    createdBy: identity.userId,
    createdAt: typeof sessionPayload.time?.created === "number" ? sessionPayload.time.created : undefined,
    updatedAt: typeof sessionPayload.time?.updated === "number" ? sessionPayload.time.updated : undefined,
  });
  rebindWriterLease(workspace.path, provisionalSessionId, session.id);
  appendAgentEvent({ session, kind: "session.created", payload: { adapterSessionId, workspaceRoot: workspace.path, fenceEpoch: lease.fenceEpoch } });
  writeActionAudit({
    actor: identity.userId,
    actorSource: "agent-workspace",
    actionKind: "opencode.session-create",
    targetType: "agent-session",
    targetId: session.id,
    risk: "medium",
    request: { workspaceRoot: workspace.path },
    resultStatus: "success",
    result: "OpenCode session created through the governed workspace boundary.",
  });
  return new Response(responseText, { status: response.status, headers: { "Content-Type": "application/json" } });
}

async function ensureMutationLease(identity: AgentIdentity, session: AgentSession): Promise<Response | null> {
  if (session.accessMode !== "writer" || !session.workspaceRoot) return null;
  const lease = acquireWriterLease({
    tenantId: identity.tenantId,
    resourceKey: session.workspaceRoot,
    sessionId: session.id,
    userId: identity.userId,
  });
  return lease.ok ? null : jsonError("another session holds the shared-checkout writer lease", 409, "WRITER_LEASE_CONFLICT");
}

async function handleDirect(
  req: Request,
  identity: AgentIdentity,
  route: Extract<OpenCodeRoute, { kind: "session-direct" }>,
  targetPath: string,
  search: string,
  upstreamUrl: string,
): Promise<Response> {
  const session = authorizeAdapterSession(identity, "opencode", route.sessionId, route.mutation);
  if (!session) return jsonError("session not found", 404, "SESSION_NOT_FOUND");
  if (route.mutation && req.method !== "DELETE") {
    const leaseError = await ensureMutationLease(identity, session);
    if (leaseError) return leaseError;
  }
  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await readBoundedBody(req);
    if (raw instanceof Response) return raw;
    body = raw;
  }
  if (req.method === "POST" && targetPath.endsWith("/message") && body) {
    try {
      const requestPayload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      appendAgentEvent({ session, kind: "message.requested", payload: requestPayload });
    } catch { return jsonError("invalid JSON body", 400, "INVALID_JSON"); }
  }
  const response = await upstreamRequest(req, targetPath, search, body, upstreamUrl);
  if (response.ok && req.method === "DELETE") {
    if (session.workspaceRoot) releaseWriterLeaseForSession(session.workspaceRoot, session.id);
    archiveAgentSession(session.id);
    appendAgentEvent({ session, kind: "session.deleted", payload: { adapterSessionId: route.sessionId } });
  } else if (response.ok && route.mutation) {
    appendAgentEvent({ session, kind: "upstream.mutation.accepted", payload: { method: req.method, path: targetPath } });
  }
  if (response.ok && route.mutation) {
    writeActionAudit({
      actor: identity.userId,
      actorSource: "agent-workspace",
      actionKind: `opencode.${req.method.toLowerCase()}`,
      targetType: "agent-session",
      targetId: session.id,
      risk: req.method === "DELETE" ? "high" : "medium",
      request: { path: targetPath },
      resultStatus: "success",
      result: "OpenCode mutation completed through the governed workspace boundary.",
    });
  }
  return new Response(response.body, { status: response.status, headers: cleanUpstreamHeaders(response) });
}

async function handleOpenCodeProxyInner(
  req: Request,
  pathname: string,
  search: string,
  upstreamUrl = DEFAULT_OPENCODE_URL,
): Promise<Response> {
  const identity = requestIdentity(req);
  if (!identity || !process.env.OPERATOR_TOKEN) return jsonError("unauthorized", 401, "UNAUTHORIZED");
  if (!isLegacyOpenCodeVisibilityReady()) {
    return jsonError("OpenCode visibility migration is not ready", 503, "VISIBILITY_NOT_READY");
  }
  const targetPath = pathname.replace(/^\/opencode-api/, "") || "/";
  const route = classifyOpenCodeRoute(req.method, targetPath);
  if (!route) return jsonError("OpenCode route is not allowlisted", 404, "ROUTE_NOT_ALLOWED");
  const mutation = !["GET", "HEAD"].includes(req.method);
  if (mutation && identity.role !== "owner" && identity.role !== "operator") {
    return jsonError("your role cannot mutate agent sessions", 403, "ROLE_FORBIDDEN");
  }
  if (route.kind === "events") return createOpenCodeEventResponse(identity, req.headers.get("last-event-id"));
  if (route.kind === "session-list") return handleSessionList(req, identity, search);
  if (route.kind === "session-create") return handleSessionCreate(req, identity, upstreamUrl);
  if (route.kind === "session-direct") return handleDirect(req, identity, route, targetPath, search, upstreamUrl);

  const raw = req.method === "GET" || req.method === "HEAD" ? undefined : await readBoundedBody(req);
  if (raw instanceof Response) return raw;
  const response = await upstreamRequest(req, targetPath, search, raw, upstreamUrl);
  if (response.ok && mutation) {
    writeActionAudit({
      actor: identity.userId,
      actorSource: "agent-workspace",
      actionKind: "opencode.configuration-update",
      targetType: "opencode-configuration",
      targetId: targetPath,
      risk: "medium",
      request: { path: targetPath },
      resultStatus: "success",
      result: "OpenCode configuration updated through the governed workspace boundary.",
    });
  }
  return new Response(response.body, { status: response.status, headers: cleanUpstreamHeaders(response) });
}

export const handleOpenCodeProxy = withTenantContext(withRequestAuthContext(handleOpenCodeProxyInner));

export function setOpenCodeProxyFetchForTests(value: FetchLike | null): void {
  upstreamFetch = value ?? fetch;
}

export function getRegisteredOpenCodeSession(id: string): AgentSession | null {
  return getAgentSessionByAdapter("opencode", id);
}
