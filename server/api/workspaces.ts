import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

export type WorkspaceRisk = "low" | "medium" | "high";

export type WorkspaceRoot = {
  path: string;
  label: string;
  risk: WorkspaceRisk;
  writable: boolean;
  note: string;
};

export const WORKSPACE_ROOTS: WorkspaceRoot[] = [
  {
    path: "/opt/opencode-control-surface",
    label: "Control Surface",
    risk: "medium",
    writable: true,
    note: "Dashboard V4 app and server.",
  },
  {
    path: "/opt/newsbites",
    label: "NewsBites",
    risk: "high",
    writable: true,
    note: "Live production site.",
  },
  {
    path: "/opt/mimoun",
    label: "Mimule/OpenClaw",
    risk: "high",
    writable: true,
    note: "Telegram bot and editorial workspace.",
  },
  {
    path: "/opt/paperclip",
    label: "Paperclip",
    risk: "high",
    writable: true,
    note: "Editorial agent orchestration platform.",
  },
  {
    path: "/opt",
    label: "Operations",
    risk: "high",
    writable: true,
    note: "Operational services and backups.",
  },
  {
    path: "/root",
    label: "Root workspace",
    risk: "high",
    writable: true,
    note: "Plans, agent config, and local credentials; use deliberately.",
  },
];

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function getProvisionedRoots(): Map<string, string> {
  const allKey = "BUILDER_PROVISIONED_ROOTS";
  const provisioned = process.env[allKey] ?? "";
  const map = new Map<string, string>();
  for (const entry of provisioned.split(",").filter(Boolean)) {
    // Try to look up label from env var key
    const labelKey = `BUILDER_ALLOWED_ROOT_${Buffer.from(entry).toString("base64").replace(/[/+=]/g, "_")}`;
    const label = process.env[labelKey] ?? basename(entry);
    map.set(entry, label);
  }
  return map;
}

export function normalizeWorkspace(input?: string): { ok: true; path: string; root: WorkspaceRoot } | { ok: false; error: string } {
  const requested = resolve(input?.trim() || "/opt");

  if (!existsSync(requested)) {
    return { ok: false, error: `workspace does not exist: ${requested}` };
  }

  let realRequested: string;
  try {
    const st = statSync(requested);
    if (!st.isDirectory()) return { ok: false, error: `workspace is not a directory: ${requested}` };
    realRequested = realpathSync(requested);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  for (const root of WORKSPACE_ROOTS) {
    if (!existsSync(root.path)) continue;
    const realRoot = realpathSync(root.path);
    if (isWithin(realRequested, realRoot)) {
      return { ok: true, path: realRequested, root };
    }
  }

  // Check dynamically provisioned roots
  const provisionedRoots = getProvisionedRoots();
  for (const [rootPath] of provisionedRoots) {
    if (!existsSync(rootPath)) continue;
    try {
      const realRoot = realpathSync(rootPath);
      if (isWithin(realRequested, realRoot)) {
        const label = provisionedRoots.get(rootPath) ?? basename(rootPath);
        return {
          ok: true,
          path: realRequested,
          root: { path: rootPath, label, risk: "medium", writable: true, note: "Provisioned project" },
        };
      }
    } catch { /* skip */ }
  }

  return {
    ok: false,
    error: `workspace is outside allowed roots: ${realRequested}`,
  };
}
