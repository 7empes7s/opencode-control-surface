import { createHash } from "node:crypto";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export type PromptVersionSummary = {
  name: string;
  version: number;
  contentHash: string;
  updatedAt: number;
};

export type PromptListEntry = {
  name: string;
  version: number;
  updatedAt: number;
};

export type PromptDiffLine = {
  kind: "same" | "added" | "removed";
  text: string;
};

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function defaultTenantId(): string {
  try {
    return getCurrentTenantContext().tenantId;
  } catch {
    return "mimule";
  }
}

export function registerPrompt(
  name: string,
  content: string,
  options: { tenantId?: string } = {},
): { inserted: boolean; version: number; contentHash: string } {
  if (!isDashboardDbEnabled()) {
    return { inserted: false, version: 0, contentHash: hashContent(content) };
  }
  const db = getDashboardDb();
  if (!db) {
    return { inserted: false, version: 0, contentHash: hashContent(content) };
  }

  const tenantId = options.tenantId ?? defaultTenantId();
  const contentHash = hashContent(content);
  const now = Date.now();

  const latest = db.query(
    `SELECT id, name, version, content, content_hash, created_at
     FROM prompts
     WHERE name = ? AND (tenant_id = ? OR tenant_id IS NULL)
     ORDER BY version DESC
     LIMIT 1`,
  ).get(name, tenantId) as
    | { id: string; version: number; content_hash: string; created_at: number }
    | null;

  if (latest && latest.content_hash === contentHash) {
    return { inserted: false, version: latest.version, contentHash };
  }

  const nextVersion = (latest?.version ?? 0) + 1;
  const id = `prompt-${tenantId}-${name}-v${nextVersion}-${now}`;
  db.query(
    `INSERT INTO prompts (id, name, version, content, content_hash, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, nextVersion, content, contentHash, now, tenantId);

  return { inserted: true, version: nextVersion, contentHash };
}

export function getPrompt(
  name: string,
  options: { tenantId?: string; version?: number } = {},
): { name: string; version: number; content: string; contentHash: string; createdAt: number } | null {
  if (!isDashboardDbEnabled()) return null;
  const db = getDashboardDb();
  if (!db) return null;

  const tenantId = options.tenantId ?? defaultTenantId();

  if (options.version !== undefined) {
    const row = db.query(
      `SELECT id, name, version, content, content_hash, created_at
       FROM prompts
       WHERE name = ? AND version = ? AND (tenant_id = ? OR tenant_id IS NULL)
       LIMIT 1`,
    ).get(name, options.version, tenantId) as
      | { id: string; name: string; version: number; content: string; content_hash: string; created_at: number }
      | null;
    if (!row) return null;
    return {
      name: row.name,
      version: row.version,
      content: row.content,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    };
  }

  const row = db.query(
    `SELECT id, name, version, content, content_hash, created_at
     FROM prompts
     WHERE name = ? AND (tenant_id = ? OR tenant_id IS NULL)
     ORDER BY version DESC
     LIMIT 1`,
  ).get(name, tenantId) as
    | { id: string; name: string; version: number; content: string; content_hash: string; created_at: number }
    | null;
  if (!row) return null;
  return {
    name: row.name,
    version: row.version,
    content: row.content,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

export function listPrompts(options: { tenantId?: string } = {}): PromptListEntry[] {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const tenantId = options.tenantId ?? defaultTenantId();

  const rows = db.query(
    `SELECT p.name, p.version, p.created_at
     FROM prompts p
     INNER JOIN (
       SELECT name, MAX(version) AS max_version
       FROM prompts
       WHERE tenant_id = ? OR tenant_id IS NULL
       GROUP BY name
     ) latest
       ON latest.name = p.name AND latest.max_version = p.version
     WHERE p.tenant_id = ? OR p.tenant_id IS NULL
     ORDER BY p.name ASC`,
  ).all(tenantId, tenantId) as Array<{ name: string; version: number; created_at: number }>;

  return rows.map((r) => ({ name: r.name, version: r.version, updatedAt: r.created_at }));
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function diffVersions(
  name: string,
  v1: number,
  v2: number,
  options: { tenantId?: string } = {},
): PromptDiffLine[] {
  const a = getPrompt(name, { ...options, version: v1 });
  const b = getPrompt(name, { ...options, version: v2 });
  if (!a || !b) return [];

  const linesA = splitLines(a.content);
  const linesB = splitLines(b.content);

  const out: PromptDiffLine[] = [];
  const maxLen = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < maxLen; i += 1) {
    const left = linesA[i];
    const right = linesB[i];
    if (left === undefined) {
      out.push({ kind: "added", text: right });
    } else if (right === undefined) {
      out.push({ kind: "removed", text: left });
    } else if (left === right) {
      out.push({ kind: "same", text: left });
    } else {
      out.push({ kind: "removed", text: left });
      out.push({ kind: "added", text: right });
    }
  }
  return out;
}

export function diffVersionsToString(
  name: string,
  v1: number,
  v2: number,
  options: { tenantId?: string } = {},
): string {
  const lines = diffVersions(name, v1, v2, options);
  return lines
    .map((l) => {
      if (l.kind === "added") return `+ ${l.text}`;
      if (l.kind === "removed") return `- ${l.text}`;
      return `  ${l.text}`;
    })
    .join("\n");
}
