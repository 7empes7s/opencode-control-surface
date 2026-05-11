import { existsSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

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

  return {
    ok: false,
    error: `workspace is outside allowed roots: ${realRequested}`,
  };
}
