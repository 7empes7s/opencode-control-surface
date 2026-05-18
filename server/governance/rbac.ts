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

export function resolveRole(token: string): RbacRole {
  if (token && token === getOperatorToken()) return "owner";
  if (token) return "viewer";
  return "viewer";
}

const ROLE_PERMISSIONS: Record<RbacRole, string[]> = {
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
  ],
  auditor: [
    "workflow.view", "builder.view",
    "audit.view",
    "gateway.view", "model.view",
  ],
  viewer: [
    "workflow.view", "builder.view",
    "audit.view",
    "gateway.view", "model.view",
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
  return false;
}

export function getAllowedActions(role: RbacRole): string[] {
  return ROLE_PERMISSIONS[role] ?? [];
}