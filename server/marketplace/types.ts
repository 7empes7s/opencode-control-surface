export type SkillKind =
  | "provider-adapter"
  | "agent-adapter"
  | "validator-adapter"
  | "notification-sink"
  | "workflow-skill";

export type SkillPermission =
  | "policy.execute_action"
  | "gateway.call"
  | "vault.read"
  | "vault.write"
  | "builder.spawn_pass"
  | "builder.read";

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  kind: SkillKind;
  entrypoint: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  permissions: SkillPermission[];
  author?: string;
  homepage?: string;
  signature?: string;
}

export interface InstalledSkill {
  id: string;
  tenantId: string;
  name: string;
  version: string;
  kind: SkillKind;
  entrypoint: string;
  manifestJson: string;
  bundlePath: string;
  bundleHash: string;
  installedAt: number;
  updatedAt: number;
  status: "active" | "disabled" | "error";
  errorMessage?: string;
}

export interface SkillRunContext {
  skillId: string;
  tenantId: string;
  instanceId: string;
  permissions: SkillPermission[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}