import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { getDashboardDb } from "../db/dashboard.ts";

export type WorkspaceRisk = "low" | "medium" | "high";

export type WorkspaceRoot = {
  path: string;
  label: string;
  risk: WorkspaceRisk;
  writable: boolean;
  note: string;
  service?: string;
  internalUrl?: string;
  publicUrl?: string;
  defaultPlan?: string;
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
  {
    path: "/opt/builder-sandbox",
    label: "Builder Sandbox",
    risk: "low",
    writable: true,
    note: "Disposable scratch workspace for testing builder workflows end-to-end.",
  },
];

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function parseWorkspaceRootConfig(value: string): Partial<WorkspaceRoot> {
  try {
    return JSON.parse(value) as Partial<WorkspaceRoot>;
  } catch {
    return {};
  }
}

export function getProvisionedWorkspaceRoots(): WorkspaceRoot[] {
  const allKey = "BUILDER_PROVISIONED_ROOTS";
  const provisioned = process.env[allKey] ?? "";
  const map = new Map<string, WorkspaceRoot>();
  for (const entry of provisioned.split(",").filter(Boolean)) {
    const labelKey = `BUILDER_ALLOWED_ROOT_${Buffer.from(entry).toString("base64").replace(/[/+=]/g, "_")}`;
    const label = process.env[labelKey] ?? basename(entry);
    map.set(entry, { path: entry, label, risk: "medium", writable: true, note: "Provisioned project" });
  }

  const db = getDashboardDb();
  if (db) {
    try {
      const rows = db.query(`
        SELECT name, root, config_json
        FROM builder_projects
      `).all() as Array<{ name: string; root: string; config_json: string }>;
      for (const row of rows) {
        const config = parseWorkspaceRootConfig(row.config_json);
        map.set(row.root, {
          path: row.root,
          label: config.label ?? row.name ?? basename(row.root),
          risk: config.risk ?? "medium",
          writable: config.writable ?? true,
          note: config.note ?? "Provisioned project",
          service: config.service,
          internalUrl: config.internalUrl,
          publicUrl: config.publicUrl,
          defaultPlan: config.defaultPlan,
        });
      }
    } catch {
      // Keep env-provisioned roots available even if the DB is mid-migration.
    }
  }

  return [...map.values()];
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
  const provisionedRoots = getProvisionedWorkspaceRoots();
  for (const root of provisionedRoots) {
    if (!existsSync(root.path)) continue;
    try {
      const realRoot = realpathSync(root.path);
      if (isWithin(realRequested, realRoot)) {
        return { ok: true, path: realRequested, root };
      }
    } catch { /* skip */ }
  }

  return {
    ok: false,
    error: `workspace is outside allowed roots: ${realRequested}`,
  };
}
