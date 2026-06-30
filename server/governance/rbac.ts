import { getDashboardDb } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import {
  bootstrapOwnerAllowed,
  constantEqual,
  getAuthenticatedUser,
  type AuthenticatedUser,
} from "../auth/session.ts";

export type RbacRole = "owner" | "operator" | "auditor" | "viewer";

export type RoleBinding = {
  userId: string;
  role: RbacRole;
  tenantId?: string;
  projectId?: string;
};

function getOperatorToken(): string {
  return process.env.OPERATOR_TOKEN || "";
}

function isRole(value: unknown): value is RbacRole {
  return value === "owner" || value === "operator" || value === "auditor" || value === "viewer";
}

function roleFromBinding(userId: string, tenantId: string): RbacRole {
  const db = getDashboardDb();
  if (!db) return "viewer";
  const row = db.query(
    `SELECT role
     FROM governance_role_bindings
     WHERE user_id = ? AND tenant_id = ?
     LIMIT 1`,
  ).get(userId, tenantId) as { role: string } | null;
  return isRole(row?.role) ? row.role : "viewer";
}

export function resolveRole(input?: AuthenticatedUser | Request | string | null, tenantId?: string): RbacRole {
  if (typeof input === "string") {
    const token = getOperatorToken();
    if (input && token && constantEqual(input, token) && bootstrapOwnerAllowed()) return "owner";
    return "viewer";
  }

  const identity = input instanceof Request ? getAuthenticatedUser(input) : input;
  if (!identity) return "viewer";
  if (identity.bootstrapOwner) return "owner";

  const effectiveTenantId = tenantId ?? identity.tenantId ?? getCurrentTenantContext().tenantId;
  if (!identity.userId) return "viewer";
  return roleFromBinding(identity.userId, effectiveTenantId);
}

export function getRoleForRequest(req: Request): RbacRole {
  return resolveRole(req);
}

export function getUserIdForRequest(req: Request): string | null {
  const identity = getAuthenticatedUser(req);
  if (!identity || identity.bootstrapOwner) return identity?.userId ?? null;
  return identity.userId;
}

export function requirePermission(req: Request, action: string): Response | null {
  const role = getRoleForRequest(req);
  if (checkPermission(role, action)) return null;
  const status = getAuthenticatedUser(req) ? 403 : 401;
  return Response.json({ error: status === 401 ? "Please sign in to continue." : "Your role cannot make this change." }, { status });
}

export function requireOwner(req: Request): Response | null {
  const role = getRoleForRequest(req);
  if (role === "owner") return null;
  const status = getAuthenticatedUser(req) ? 403 : 401;
  return Response.json({ error: status === 401 ? "Please sign in to continue." : "Only an owner can make this change." }, { status });
}

export function requireSignedIn(req: Request): Response | null {
  if (getAuthenticatedUser(req)) return null;
  return Response.json({ error: "Please sign in to continue." }, { status: 401 });
}

export function isAuthenticatedForRequest(req: Request): boolean {
  return Boolean(getAuthenticatedUser(req));
}

// Fail-closed: mutations require OPERATOR_TOKEN to be configured. When the
// token is absent the dev-bootstrap path would otherwise grant owner access
// on any deployment where NODE_ENV != "production".
export function canMutate(req: Request): boolean {
  if (!process.env.OPERATOR_TOKEN) return false;
  const role = getRoleForRequest(req);
  return role === "owner" || role === "operator";
}

export function mutationDenied(req: Request): Response {
  const status = getAuthenticatedUser(req) ? 403 : 401;
  return Response.json({ error: status === 401 ? "Please sign in to continue." : "Your role cannot make this change." }, { status });
}

export function requireMutation(req: Request): Response | null {
  if (canMutate(req)) return null;
  return mutationDenied(req);
}

export function requireView(req: Request, action = "audit.view"): Response | null {
  const role = getRoleForRequest(req);
  if (checkPermission(role, action)) return null;
  const status = getAuthenticatedUser(req) ? 403 : 401;
  return Response.json({ error: status === 401 ? "Please sign in to continue." : "Your role cannot view this page." }, { status });
}

export function roleForIdentity(identity: AuthenticatedUser | null, tenantId?: string): RbacRole {
  return resolveRole(identity, tenantId);
}

export function ensureRoleBindingRole(role: string): RbacRole | null {
  return isRole(role) ? role : null;
}

export function isOwnerRequest(req: Request): boolean {
  return getRoleForRequest(req) === "owner";
}

export function legacyTokenIsBootstrapOwner(token: string): boolean {
  const expected = getOperatorToken();
  return Boolean(token && expected && constantEqual(token, expected) && bootstrapOwnerAllowed());
}

export function resolveUserRole(userId: string, tenantId: string): RbacRole {
  return roleFromBinding(userId, tenantId);
}

export function hasAuthenticatedUser(req: Request): boolean {
  return Boolean(getAuthenticatedUser(req));
}

export function authRequiredResponse(): Response {
  return Response.json({ error: "Please sign in to continue." }, { status: 401 });
}

export function forbiddenResponse(): Response {
  return Response.json({ error: "Your role cannot make this change." }, { status: 403 });
}

export function ownerRequiredResponse(): Response {
  return Response.json({ error: "Only an owner can make this change." }, { status: 403 });
}

export function permissionResponse(req: Request, action: string): Response | null {
  if (checkPermission(getRoleForRequest(req), action)) return null;
  return getAuthenticatedUser(req) ? forbiddenResponse() : authRequiredResponse();
}

export function ownerResponse(req: Request): Response | null {
  if (isOwnerRequest(req)) return null;
  return getAuthenticatedUser(req) ? ownerRequiredResponse() : authRequiredResponse();
}

export function signedInResponse(req: Request): Response | null {
  return getAuthenticatedUser(req) ? null : authRequiredResponse();
}

export function mutateResponse(req: Request): Response | null {
  return canMutate(req) ? null : (getAuthenticatedUser(req) ? forbiddenResponse() : authRequiredResponse());
}

export function viewResponse(req: Request, action = "audit.view"): Response | null {
  if (checkPermission(getRoleForRequest(req), action)) return null;
  return getAuthenticatedUser(req) ? Response.json({ error: "Your role cannot view this page." }, { status: 403 }) : authRequiredResponse();
}

export function bootstrapOwnerRole(req: Request): RbacRole | null {
  const identity = getAuthenticatedUser(req);
  return identity?.bootstrapOwner ? "owner" : null;
}

export function resolveRoleForUser(userId: string, tenantId = getCurrentTenantContext().tenantId): RbacRole {
  return roleFromBinding(userId, tenantId);
}

export function resolveRoleForRequest(req: Request): RbacRole {
  return getRoleForRequest(req);
}

export function permissionGuard(action: string): (req: Request) => Response | null {
  return (req: Request) => permissionResponse(req, action);
}

export function ownerGuard(): (req: Request) => Response | null {
  return (req: Request) => ownerResponse(req);
}

export function mutationGuard(): (req: Request) => Response | null {
  return (req: Request) => mutateResponse(req);
}

export function viewGuard(action?: string): (req: Request) => Response | null {
  return (req: Request) => viewResponse(req, action);
}

export function authenticatedGuard(): (req: Request) => Response | null {
  return (req: Request) => signedInResponse(req);
}

export function normalizeRole(role: string): RbacRole | null {
  return ensureRoleBindingRole(role);
}

export function roleFromString(role: string): RbacRole | null {
  return ensureRoleBindingRole(role);
}

export function roleAllows(role: RbacRole, action: string): boolean {
  return checkPermission(role, action);
}

export function requestAllows(req: Request, action: string): boolean {
  return checkPermission(getRoleForRequest(req), action);
}

export function requestUserId(req: Request): string | null {
  return getAuthenticatedUser(req)?.userId ?? null;
}

export function requestTenantId(req: Request): string {
  return getAuthenticatedUser(req)?.tenantId ?? getCurrentTenantContext().tenantId;
}

export function requestIdentity(req: Request): AuthenticatedUser | null {
  return getAuthenticatedUser(req);
}

export function requestRole(req: Request): RbacRole {
  return getRoleForRequest(req);
}

export function userRole(userId: string, tenantId?: string): RbacRole {
  return roleFromBinding(userId, tenantId ?? getCurrentTenantContext().tenantId);
}

export function userHasRole(userId: string, role: RbacRole, tenantId?: string): boolean {
  return userRole(userId, tenantId) === role;
}

export function userCan(userId: string, action: string, tenantId?: string): boolean {
  return checkPermission(userRole(userId, tenantId), action);
}

export function requireUserCan(userId: string, action: string, tenantId?: string): Response | null {
  return userCan(userId, action, tenantId) ? null : forbiddenResponse();
}

export function viewerRole(): RbacRole {
  return "viewer";
}

export const ROLE_PERMISSIONS: Record<RbacRole, string[]> = {
  owner: ["*"],
  operator: [
    "workflow.start", "workflow.stop", "workflow.pause", "workflow.resume",
    "workflow.view", "workflow.create", "workflow.update", "workflow.delete",
    "builder.view", "builder.edit", "builder.execute",
    "pass.view", "pass.create", "pass.cancel",
    "secrets.read", "secrets.write",
    "audit.view", "audit.write",
    "gateway.call", "gateway.view",
    "model.view", "model.select",
    "insights.view", "insights.apply", "insights.dismiss",
  ],
  auditor: [
    "workflow.view", "builder.view",
    "audit.view",
    "gateway.view", "model.view",
    "insights.view",
  ],
  viewer: [
    "workflow.view", "builder.view",
    "audit.view",
    "gateway.view", "model.view",
    "insights.view",
  ],
};

export function checkPermission(role: RbacRole, action: string): boolean {
  const perms = ROLE_PERMISSIONS[role] ?? [];
  if (perms.includes("*")) return true;
  if (perms.includes(action)) return true;
  if (action.startsWith("workflow.") && perms.includes("workflow.*")) return true;
  if (action.startsWith("builder.") && perms.includes("builder.*")) return true;
  if (action.startsWith("audit.") && perms.includes("audit.*")) return true;
  if (action.startsWith("secrets.") && perms.includes("secrets.*")) return true;
  if (action.startsWith("gateway.") && perms.includes("gateway.*")) return true;
  if (action.startsWith("model.") && perms.includes("model.*")) return true;
  if (action.startsWith("pass.") && perms.includes("pass.*")) return true;
  if (action.startsWith("insights.") && perms.includes("insights.*")) return true;
  return false;
}

export function getAllowedActions(role: RbacRole): string[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function permissionsForRole(role: RbacRole): string[] {
  return getAllowedActions(role);
}
