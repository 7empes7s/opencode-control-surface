import { ManifestError } from "./types.ts";
import type { SkillManifest, SkillPermission } from "./types.ts";

const VALID_PERMISSIONS = new Set<SkillPermission>([
  "policy.execute_action",
  "gateway.call",
  "vault.read",
  "vault.write",
  "builder.spawn_pass",
  "builder.read",
]);

const VALID_KINDS = [
  "provider-adapter",
  "agent-adapter",
  "validator-adapter",
  "notification-sink",
  "workflow-skill",
] as const;

function isValidSlug(name: string | undefined): boolean {
  if (!name || typeof name !== "string") return false;
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}

function isValidSemver(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version);
}

export function parseManifest(jsonString: string): SkillManifest {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new ManifestError("Manifest must be valid JSON");
  }

  const name = data.name;
  if (!name || typeof name !== "string") {
    throw new ManifestError("Manifest must have a string 'name' field");
  }

  const version = data.version;
  if (!version || typeof version !== "string") {
    throw new ManifestError("Manifest must have a string 'version' field");
  }

  const kind = data.kind;
  if (!kind || typeof kind !== "string") {
    throw new ManifestError("Manifest must have a string 'kind' field");
  }

  const entrypoint = data.entrypoint;
  if (!entrypoint || typeof entrypoint !== "string") {
    throw new ManifestError("Manifest must have a string 'entrypoint' field");
  }

  return {
    name,
    version,
    description: (data.description as string) || "",
    kind: kind as SkillManifest["kind"],
    entrypoint,
    inputs: (data.inputs as Record<string, unknown>) || {},
    outputs: (data.outputs as Record<string, unknown>) || {},
    permissions: (data.permissions as SkillPermission[]) || [],
    author: data.author as string | undefined,
    homepage: data.homepage as string | undefined,
    signature: data.signature as string | undefined,
  };
}

export function validateManifest(m: SkillManifest): string[] {
  const errors: string[] = [];

  if (!isValidSlug(m.name)) {
    errors.push("name must be a lowercase slug (a-z, 0-9, -), max 64 chars, starting with a letter or digit");
  }

  if (!isValidSemver(m.version)) {
    errors.push("version must be semver in format X.Y.Z");
  }

  if (!VALID_KINDS.includes(m.kind)) {
    errors.push(`kind must be one of: ${VALID_KINDS.join(", ")}`);
  }

  if (!m.entrypoint || typeof m.entrypoint !== "string") {
    errors.push("entrypoint must be a non-empty string");
  } else if (m.entrypoint.includes("..")) {
    errors.push("entrypoint cannot contain '..' (path traversal)");
  } else if (!/\.(ts|js)$/.test(m.entrypoint)) {
    errors.push("entrypoint must be a .ts or .js file");
  }

  if (!Array.isArray(m.permissions)) {
    errors.push("permissions must be an array");
  } else {
    for (const perm of m.permissions) {
      if (!VALID_PERMISSIONS.has(perm as SkillPermission)) {
        errors.push(`unknown permission: '${perm}'`);
      }
    }
  }

  return errors;
}