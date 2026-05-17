import { createHash } from "node:crypto";
import type { SkillManifest, InstalledSkill } from "./types.ts";
import { parseManifest, validateManifest } from "./manifest.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { hashBundle, verifySignature } from "./signer.ts";

export function installSkill(
  tenantId: string,
  bundlePath: string,
  manifestJson: string,
): InstalledSkill {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not initialized");

  const manifest = parseManifest(manifestJson);
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid manifest: ${errors.join("; ")}`);
  }

  const bundleHash = hashBundle(bundlePath);
  const verified = verifySignature(manifest, bundleHash);
  if (!verified) {
    throw new Error("Bundle signature verification failed");
  }

  const now = Date.now();
  const id = crypto.randomUUID();

  db.query(`
    INSERT INTO marketplace_skills
      (id, tenant_id, name, version, kind, manifest_json, bundle_path, bundle_hash, installed_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(id, tenantId, manifest.name, manifest.version, manifest.kind, manifestJson, bundlePath, bundleHash, now, now);

  return getSkill(id)!;
}

export function uninstallSkill(id: string): void {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not initialized");

  db.query(`UPDATE marketplace_skills SET status = 'disabled', updated_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function getSkill(id: string): InstalledSkill | null {
  const db = getDashboardDb();
  if (!db) return null;

  const row = db.query(`SELECT * FROM marketplace_skills WHERE id = ?`).get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return rowToInstalledSkill(row);
}

export function listSkills(tenantId: string): InstalledSkill[] {
  const db = getDashboardDb();
  if (!db) return [];

  const rows = db.query(`SELECT * FROM marketplace_skills WHERE tenant_id = ? ORDER BY installed_at DESC`)
    .all(tenantId) as Record<string, unknown>[];
  return rows.map(rowToInstalledSkill);
}

export function enableSkill(id: string): void {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not initialized");

  db.query(`UPDATE marketplace_skills SET status = 'active', updated_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function disableSkill(id: string): void {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not initialized");

  db.query(`UPDATE marketplace_skills SET status = 'disabled', updated_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

function rowToInstalledSkill(row: Record<string, unknown>): InstalledSkill {
  const manifestJson = row.manifest_json as string;
  let entrypoint = "index.ts";
  try {
    const parsed = JSON.parse(manifestJson);
    entrypoint = parsed.entrypoint || "index.ts";
  } catch { /* ignore */ }

  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    version: row.version as string,
    kind: row.kind as InstalledSkill["kind"],
    entrypoint,
    manifestJson,
    bundlePath: row.bundle_path as string,
    bundleHash: row.bundle_hash as string,
    installedAt: row.installed_at as number,
    updatedAt: row.updated_at as number,
    status: row.status as "active" | "disabled" | "error",
    errorMessage: row.error_message as string | undefined,
  };
}