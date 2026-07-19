#!/usr/bin/env bun
// Read-only evidence collector for an operator-reviewed one-time migration.
// It deliberately performs no classification and writes no registry state.

import { createHash } from "node:crypto";

const upstream = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const limit = 10_000;
const response = await fetch(`${upstream}/session?limit=${limit}`, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`OpenCode session snapshot HTTP ${response.status}`);
const value = await response.json() as unknown;
if (!Array.isArray(value)) throw new Error("OpenCode session snapshot returned a non-array payload");
if (value.length >= limit) throw new Error(`OpenCode session snapshot reached the ${limit} row bound; completeness is not proven`);

const sessions = value.flatMap((item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const row = item as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(row.id)) return [];
  const time = row.time && typeof row.time === "object" ? row.time as Record<string, unknown> : {};
  return [{
    id: row.id,
    title: typeof row.title === "string" ? row.title : null,
    directory: typeof row.directory === "string" ? row.directory : null,
    createdAt: typeof time.created === "number" ? time.created : null,
    updatedAt: typeof time.updated === "number" ? time.updated : null,
  }];
}).sort((a, b) => a.id.localeCompare(b.id));

if (sessions.length !== value.length) throw new Error("OpenCode session snapshot contained malformed rows");
const sortedIdsSha256 = createHash("sha256").update(sessions.map((session) => session.id).join("\n")).digest("hex");
console.log(JSON.stringify({
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  upstream,
  boundedLimit: limit,
  count: sessions.length,
  sortedIdsSha256,
  sessions,
}, null, 2));
