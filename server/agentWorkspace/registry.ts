import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { RbacRole } from "../governance/rbac.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import type { AgentAccessMode, AgentHarness } from "./adapter.ts";

export const OPENCODE_INTERNAL_MARKER = "__mimule_probe_v1__:";
const LEGACY_RECEIPT_PATH = new URL("../../config/opencode-legacy-hidden-sessions.json", import.meta.url);
const LEGACY_VISIBLE_OPENCODE_PATH = new URL("../../config/opencode-legacy-visible-sessions.json", import.meta.url);
const LEGACY_HARNESS_FILES: Array<{ harness: Exclude<AgentHarness, "terminal" | "opencode">; path: string }> = [
  { harness: "codex", path: "/var/lib/control-surface/codex-sessions.json" },
  { harness: "claude", path: "/var/lib/control-surface/claude-sessions.json" },
  { harness: "gemini", path: "/var/lib/control-surface/gemini-sessions.json" },
];

const ROLE_RANK: Record<RbacRole, number> = { viewer: 0, auditor: 1, operator: 2, owner: 3 };

export type AgentIdentity = {
  tenantId: string;
  userId: string;
  role: RbacRole;
};

export type AgentSession = {
  id: string;
  tenantId: string;
  ownerUserId: string;
  harness: AgentHarness;
  adapterSessionId: string;
  adapterVersion: string;
  title: string;
  status: string;
  visibility: "private" | "tenant";
  acl: string[];
  requiredRole: RbacRole;
  repositoryRoot: string | null;
  workspaceRoot: string | null;
  isolationMode: string;
  accessMode: AgentAccessMode;
  requestedConfig: Record<string, unknown>;
  effectiveConfig: Record<string, unknown>;
  internal: boolean;
  registryRevision: number;
  eventSequence: number;
  traceId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

type SessionRow = {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  harness: AgentHarness;
  adapter_session_id: string;
  adapter_version: string;
  title: string;
  status: string;
  visibility: "private" | "tenant";
  acl_json: string;
  required_role: RbacRole;
  repository_root: string | null;
  workspace_root: string | null;
  isolation_mode: string;
  access_mode: AgentAccessMode;
  requested_config_json: string;
  effective_config_json: string;
  internal: number;
  registry_revision: number;
  event_sequence: number;
  trace_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type LegacyReceiptFile = {
  schemaVersion: 1;
  migrationId: string;
  capturedAt: string;
  evidence: string;
  upstreamCount: number;
  expectedCount: number;
  sortedIdsSha256: string;
  sessionIds: string[];
};

type LegacyVisibleOpenCodeFile = {
  schemaVersion: 1;
  migrationId: string;
  expectedCount: number;
  sortedIdsSha256: string;
  sessions: Array<{
    id: string;
    title: string;
    directory: string;
    version?: string;
    createdAt?: number;
    updatedAt?: number;
  }>;
};

export type RegisterAgentSessionInput = {
  id?: string;
  tenantId: string;
  ownerUserId: string;
  harness: AgentHarness;
  adapterSessionId: string;
  adapterVersion: string;
  title: string;
  status?: string;
  visibility?: "private" | "tenant";
  acl?: string[];
  requiredRole?: RbacRole;
  repositoryRoot?: string | null;
  workspaceRoot?: string | null;
  isolationMode?: string;
  accessMode?: AgentAccessMode;
  requestedConfig?: Record<string, unknown>;
  effectiveConfig?: Record<string, unknown>;
  internal?: boolean;
  traceId?: string | null;
  createdBy: string;
  createdAt?: number;
  updatedAt?: number;
};

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStrings(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    harness: row.harness,
    adapterSessionId: row.adapter_session_id,
    adapterVersion: row.adapter_version,
    title: row.title,
    status: row.status,
    visibility: row.visibility,
    acl: parseStrings(row.acl_json),
    requiredRole: row.required_role,
    repositoryRoot: row.repository_root,
    workspaceRoot: row.workspace_root,
    isolationMode: row.isolation_mode,
    accessMode: row.access_mode,
    requestedConfig: parseObject(row.requested_config_json),
    effectiveConfig: parseObject(row.effective_config_json),
    internal: row.internal === 1,
    registryRevision: row.registry_revision,
    eventSequence: row.event_sequence,
    traceId: row.trace_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function getDb() {
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard database is unavailable");
  return db;
}

function canonicalLeaseKey(resourceKey: string): string {
  try {
    const real = realpathSync(resourceKey);
    const stat = statSync(real);
    return `${real}#${stat.dev}:${stat.ino}`;
  } catch {
    // Callers validate workspaces before launch. Keeping a deterministic
    // fallback makes isolated unit fixtures and expired-row cleanup safe.
    return resourceKey;
  }
}

export function isReservedOpenCodeTitle(title: unknown): boolean {
  return typeof title === "string" && title.startsWith(OPENCODE_INTERNAL_MARKER);
}

export function recordInternalVisibility(input: {
  harness: AgentHarness;
  adapterSessionId: string;
  reason: string;
  source: string;
  evidence?: Record<string, unknown>;
  recordedAt?: number;
}): void {
  const db = getDb();
  const id = `visibility:${input.harness}:${input.adapterSessionId}`;
  db.query(`
    INSERT OR IGNORE INTO visibility_receipts
      (id, harness, adapter_session_id, classification, reason, source, evidence_json, recorded_at)
    VALUES (?, ?, ?, 'internal', ?, ?, ?, ?)
  `).run(
    id,
    input.harness,
    input.adapterSessionId,
    input.reason,
    input.source,
    safeJson(input.evidence),
    input.recordedAt ?? Date.now(),
  );

  // Visibility receipts are immutable and authoritative. A later import or
  // title edit may update display data, but can never make the session normal.
  db.query(`
    UPDATE agent_sessions
    SET internal = 1, registry_revision = registry_revision + 1, updated_at = ?
    WHERE harness = ? AND adapter_session_id = ? AND internal = 0
  `).run(Date.now(), input.harness, input.adapterSessionId);
}

export function isInternalAdapterSession(harness: AgentHarness, adapterSessionId: string): boolean {
  const db = getDashboardDb();
  if (!db) return true;
  const row = db.query(`
    SELECT 1 AS found FROM visibility_receipts
    WHERE harness = ? AND adapter_session_id = ?
    LIMIT 1
  `).get(harness, adapterSessionId) as { found: number } | null;
  return Boolean(row);
}

export function seedLegacyOpenCodeVisibilityReceipts(): number {
  const parsed = JSON.parse(readFileSync(LEGACY_RECEIPT_PATH, "utf8")) as LegacyReceiptFile;
  if (parsed.schemaVersion !== 1 || !parsed.migrationId || !Array.isArray(parsed.sessionIds)) {
    throw new Error("invalid OpenCode legacy visibility receipt");
  }
  const ids = [...new Set(parsed.sessionIds)];
  if (ids.length !== parsed.sessionIds.length || ids.some((id) => !/^ses_[A-Za-z0-9]+$/.test(id))) {
    throw new Error("invalid OpenCode legacy visibility session id set");
  }
  const sortedIds = [...ids].sort();
  const digest = createHash("sha256").update(sortedIds.join("\n")).digest("hex");
  if (parsed.expectedCount !== ids.length || parsed.sortedIdsSha256 !== digest || parsed.upstreamCount < ids.length) {
    throw new Error("OpenCode legacy visibility receipt count or digest mismatch");
  }
  const db = getDb();
  const before = db.query(`
    SELECT COUNT(*) AS count FROM visibility_receipts
    WHERE source = ?
  `).get(parsed.migrationId) as { count: number };
  const tx = db.transaction(() => {
    for (const id of ids) {
      recordInternalVisibility({
        harness: "opencode",
        adapterSessionId: id,
        reason: "verified legacy probe session",
        source: parsed.migrationId,
        evidence: {
          capturedAt: parsed.capturedAt,
          evidence: parsed.evidence,
          setSize: ids.length,
        },
      });
    }
  });
  tx();
  const after = db.query(`
    SELECT COUNT(*) AS count FROM visibility_receipts
    WHERE source = ?
  `).get(parsed.migrationId) as { count: number };
  return Math.max(0, after.count - before.count);
}

export function isLegacyOpenCodeVisibilityReady(): boolean {
  const db = getDashboardDb();
  if (!db) return false;
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_RECEIPT_PATH, "utf8")) as LegacyReceiptFile;
    const row = db.query(`
      SELECT COUNT(*) AS count FROM visibility_receipts
      WHERE harness = 'opencode' AND source = ?
    `).get(parsed.migrationId) as { count: number } | null;
    return parsed.expectedCount > 0 && row?.count === parsed.expectedCount;
  } catch {
    return false;
  }
}

export function importLegacyAgentSessions(): { opencode: number; codex: number; claude: number; gemini: number } {
  const counts = { opencode: 0, codex: 0, claude: 0, gemini: 0 };
  const visible = JSON.parse(readFileSync(LEGACY_VISIBLE_OPENCODE_PATH, "utf8")) as LegacyVisibleOpenCodeFile;
  const visibleIds = visible.sessions.map((session) => session.id).sort();
  const visibleDigest = createHash("sha256").update(visibleIds.join("\n")).digest("hex");
  if (
    visible.schemaVersion !== 1 ||
    visible.expectedCount !== visible.sessions.length ||
    visible.sortedIdsSha256 !== visibleDigest ||
    visible.sessions.some((session) => !/^ses_[A-Za-z0-9]+$/.test(session.id))
  ) {
    throw new Error("invalid visible OpenCode legacy import manifest");
  }
  for (const session of visible.sessions) {
    if (getAgentSessionByAdapter("opencode", session.id)) continue;
    registerAgentSession({
      tenantId: "mimule",
      ownerUserId: "operator-bootstrap",
      harness: "opencode",
      adapterSessionId: session.id,
      adapterVersion: session.version ?? "legacy-v2",
      title: session.title,
      status: "restored",
      workspaceRoot: session.directory,
      repositoryRoot: session.directory,
      accessMode: "writer",
      requestedConfig: { legacyImport: visible.migrationId },
      effectiveConfig: { directory: session.directory },
      createdBy: "legacy-import",
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    counts.opencode += 1;
  }

  for (const spec of LEGACY_HARNESS_FILES) {
    if (!existsSync(spec.path)) continue;
    chmodSync(spec.path, 0o600);
    let sessions: unknown[] = [];
    try {
      const parsed = JSON.parse(readFileSync(spec.path, "utf8")) as { sessions?: unknown };
      sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch {
      continue;
    }
    for (const value of sessions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const session = value as Record<string, unknown>;
      const id = typeof session.id === "string" ? session.id : null;
      if (!id || getAgentSessionByAdapter(spec.harness, id)) continue;
      registerAgentSession({
        tenantId: "mimule",
        ownerUserId: "operator-bootstrap",
        harness: spec.harness,
        adapterSessionId: id,
        adapterVersion: "legacy-json-v1",
        title: typeof session.title === "string" ? session.title : `${spec.harness} session`,
        status: session.running === true ? "stale" : "restored",
        workspaceRoot: typeof session.directory === "string" ? session.directory : null,
        repositoryRoot: typeof session.directory === "string" ? session.directory : null,
        accessMode: "writer",
        requestedConfig: { legacyImport: `legacy-${spec.harness}-json-v1` },
        effectiveConfig: {},
        createdBy: "legacy-import",
        createdAt: typeof session.createdAt === "number" ? session.createdAt : undefined,
        updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : undefined,
      });
      counts[spec.harness] += 1;
    }
  }
  return counts;
}

export function registerAgentSession(input: RegisterAgentSessionInput): AgentSession {
  const db = getDb();
  const now = input.updatedAt ?? Date.now();
  const createdAt = input.createdAt ?? now;
  const internal = input.internal === true || isInternalAdapterSession(input.harness, input.adapterSessionId);
  const id = input.id ?? `${input.harness}:${input.adapterSessionId}`;
  db.query(`
    INSERT INTO agent_sessions (
      id, tenant_id, owner_user_id, harness, adapter_session_id, adapter_version,
      title, status, visibility, acl_json, required_role, repository_root,
      workspace_root, isolation_mode, access_mode, requested_config_json,
      effective_config_json, internal, registry_revision, event_sequence,
      trace_id, created_by, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, NULL)
    ON CONFLICT(harness, adapter_session_id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      effective_config_json = excluded.effective_config_json,
      internal = CASE WHEN agent_sessions.internal = 1 OR excluded.internal = 1 THEN 1 ELSE 0 END,
      registry_revision = agent_sessions.registry_revision + 1,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.tenantId,
    input.ownerUserId,
    input.harness,
    input.adapterSessionId,
    input.adapterVersion,
    input.title,
    input.status ?? "ready",
    input.visibility ?? "private",
    safeJson(input.acl ?? []),
    input.requiredRole ?? "viewer",
    input.repositoryRoot ?? null,
    input.workspaceRoot ?? null,
    input.isolationMode ?? "shared-checkout",
    input.accessMode ?? "writer",
    safeJson(input.requestedConfig),
    safeJson(input.effectiveConfig),
    internal ? 1 : 0,
    input.traceId ?? randomUUID(),
    input.createdBy,
    createdAt,
    now,
  );
  const session = getAgentSessionByAdapter(input.harness, input.adapterSessionId);
  if (!session) throw new Error("agent session registration failed");
  return session;
}

export function getAgentSessionByAdapter(harness: AgentHarness, adapterSessionId: string): AgentSession | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query(`
    SELECT * FROM agent_sessions
    WHERE harness = ? AND adapter_session_id = ?
    LIMIT 1
  `).get(harness, adapterSessionId) as SessionRow | null;
  return row ? mapSession(row) : null;
}

export function canViewAgentSession(identity: AgentIdentity, session: AgentSession): boolean {
  if (session.internal || session.archivedAt !== null || session.tenantId !== identity.tenantId) return false;
  if (ROLE_RANK[identity.role] < ROLE_RANK[session.requiredRole]) return false;
  if (session.ownerUserId === identity.userId) return true;
  if (session.acl.includes(identity.userId)) return true;
  return session.visibility === "tenant";
}

export function canMutateAgentSession(identity: AgentIdentity, session: AgentSession): boolean {
  if (!canViewAgentSession(identity, session)) return false;
  if (session.ownerUserId === identity.userId) return true;
  return session.acl.includes(identity.userId) && (identity.role === "owner" || identity.role === "operator");
}

export function authorizeAdapterSession(
  identity: AgentIdentity,
  harness: AgentHarness,
  adapterSessionId: string,
  mutation = false,
): AgentSession | null {
  if (isInternalAdapterSession(harness, adapterSessionId)) return null;
  const session = getAgentSessionByAdapter(harness, adapterSessionId);
  if (!session) return null;
  return (mutation ? canMutateAgentSession(identity, session) : canViewAgentSession(identity, session)) ? session : null;
}

export function listAgentSessions(identity: AgentIdentity, harness?: AgentHarness): AgentSession[] {
  const db = getDashboardDb();
  if (!db) return [];
  const rows = db.query(`
    SELECT * FROM agent_sessions
    WHERE tenant_id = ? AND archived_at IS NULL
      ${harness ? "AND harness = ?" : ""}
    ORDER BY updated_at DESC
  `).all(...(harness ? [identity.tenantId, harness] : [identity.tenantId])) as SessionRow[];
  return rows.map(mapSession).filter((session) => canViewAgentSession(identity, session));
}

export function archiveAgentSession(sessionId: string, now = Date.now()): boolean {
  const result = getDb().query(`
    UPDATE agent_sessions
    SET status = 'archived', archived_at = ?, updated_at = ?,
        registry_revision = registry_revision + 1
    WHERE id = ? AND archived_at IS NULL
  `).run(now, now, sessionId);
  return result.changes === 1;
}

export type AgentEvent = {
  id: string;
  sessionId: string;
  runId: string | null;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  createdAt: number;
};

export type AgentRun = {
  id: string;
  sessionId: string;
  tenantId: string;
  ownerUserId: string;
  adapterRunId: string | null;
  idempotencyKey: string;
  status: string;
  requestedConfig: Record<string, unknown>;
  effectiveConfig: Record<string, unknown>;
  supervisor: Record<string, unknown>;
  registryRevision: number;
  eventSequence: number;
  traceId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
};

type RunRow = {
  id: string;
  session_id: string;
  tenant_id: string;
  owner_user_id: string;
  adapter_run_id: string | null;
  idempotency_key: string;
  status: string;
  requested_config_json: string;
  effective_config_json: string;
  supervisor_json: string;
  registry_revision: number;
  event_sequence: number;
  trace_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
};

function mapRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    adapterRunId: row.adapter_run_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    requestedConfig: parseObject(row.requested_config_json),
    effectiveConfig: parseObject(row.effective_config_json),
    supervisor: parseObject(row.supervisor_json),
    registryRevision: row.registry_revision,
    eventSequence: row.event_sequence,
    traceId: row.trace_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

export function createAgentRun(input: {
  session: AgentSession;
  idempotencyKey: string;
  requestedConfig?: Record<string, unknown>;
  effectiveConfig?: Record<string, unknown>;
  supervisor?: Record<string, unknown>;
  adapterRunId?: string | null;
  status?: string;
  createdAt?: number;
}): AgentRun {
  const db = getDb();
  const existing = db.query(`
    SELECT * FROM agent_runs WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1
  `).get(input.session.tenantId, input.idempotencyKey) as RunRow | null;
  if (existing) {
    if (existing.session_id !== input.session.id || existing.owner_user_id !== input.session.ownerUserId) {
      throw new Error("idempotency key is already bound to another session");
    }
    return mapRun(existing);
  }
  const id = randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  db.query(`
    INSERT INTO agent_runs (
      id, session_id, tenant_id, owner_user_id, adapter_run_id, idempotency_key,
      status, requested_config_json, effective_config_json, supervisor_json,
      registry_revision, event_sequence, trace_id, created_at, started_at,
      finished_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL, NULL)
  `).run(
    id,
    input.session.id,
    input.session.tenantId,
    input.session.ownerUserId,
    input.adapterRunId ?? null,
    input.idempotencyKey,
    input.status ?? "queued",
    safeJson(input.requestedConfig),
    safeJson(input.effectiveConfig),
    safeJson(input.supervisor),
    input.session.traceId ?? randomUUID(),
    createdAt,
    input.status === "running" ? createdAt : null,
  );
  const row = db.query("SELECT * FROM agent_runs WHERE id = ?").get(id) as RunRow | null;
  if (!row) throw new Error("agent run creation failed");
  return mapRun(row);
}

export function listAgentRuns(identity: AgentIdentity, sessionId: string): AgentRun[] {
  const session = listAgentSessions(identity).find((item) => item.id === sessionId);
  if (!session) return [];
  return (getDb().query(`
    SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC
  `).all(sessionId) as RunRow[]).map(mapRun);
}

export function markUnreconciledAgentRunsStale(now = Date.now()): number {
  const result = getDb().query(`
    UPDATE agent_runs
    SET status = 'stale', registry_revision = registry_revision + 1,
        finished_at = COALESCE(finished_at, ?),
        error = COALESCE(error, 'control surface restarted before adapter reconciliation')
    WHERE status IN ('queued', 'running')
  `).run(now);
  return result.changes;
}

export function appendAgentEvent(input: {
  session: AgentSession;
  runId?: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt?: number;
}): AgentEvent {
  const db = getDb();
  const createdAt = input.createdAt ?? Date.now();
  const payloadJson = safeJson(input.payload);
  const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
  const id = randomUUID();
  let sequence = 0;
  const tx = db.transaction(() => {
    const updated = db.query(`
      UPDATE agent_sessions
      SET event_sequence = event_sequence + 1,
          registry_revision = registry_revision + 1,
          updated_at = ?
      WHERE id = ?
      RETURNING event_sequence
    `).get(createdAt, input.session.id) as { event_sequence: number } | null;
    if (!updated) throw new Error("agent session disappeared while appending event");
    sequence = updated.event_sequence;
    if (input.runId) {
      db.query(`
        UPDATE agent_runs
        SET event_sequence = event_sequence + 1,
            registry_revision = registry_revision + 1
        WHERE id = ? AND session_id = ?
      `).run(input.runId, input.session.id);
    }
    db.query(`
      INSERT INTO agent_events (
        id, session_id, run_id, tenant_id, owner_user_id, sequence,
        kind, payload_json, payload_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.session.id,
      input.runId ?? null,
      input.session.tenantId,
      input.session.ownerUserId,
      sequence,
      input.kind,
      payloadJson,
      payloadSha256,
      createdAt,
    );
  });
  tx();
  return { id, sessionId: input.session.id, runId: input.runId ?? null, sequence, kind: input.kind, payload: input.payload, payloadSha256, createdAt };
}

export function listAgentEvents(identity: AgentIdentity, sessionId: string, after = 0, limit = 500): AgentEvent[] {
  const db = getDashboardDb();
  if (!db) return [];
  const row = db.query("SELECT * FROM agent_sessions WHERE id = ? LIMIT 1").get(sessionId) as SessionRow | null;
  if (!row || !canViewAgentSession(identity, mapSession(row))) return [];
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = db.query(`
    SELECT id, session_id, run_id, sequence, kind, payload_json, payload_sha256, created_at
    FROM agent_events
    WHERE session_id = ? AND sequence > ?
    ORDER BY sequence ASC
    LIMIT ?
  `).all(sessionId, Math.max(0, Math.floor(after)), boundedLimit) as Array<{
    id: string;
    session_id: string;
    run_id: string | null;
    sequence: number;
    kind: string;
    payload_json: string;
    payload_sha256: string;
    created_at: number;
  }>;
  return rows.map((event) => ({
    id: event.id,
    sessionId: event.session_id,
    runId: event.run_id,
    sequence: event.sequence,
    kind: event.kind,
    payload: parseObject(event.payload_json),
    payloadSha256: event.payload_sha256,
    createdAt: event.created_at,
  }));
}

export type LeaseResult =
  | { ok: true; fenceEpoch: number; revision: number }
  | { ok: false; holderSessionId: string | null; fenceEpoch: number; expiresAt: number | null };

export function acquireWriterLease(input: {
  tenantId: string;
  resourceType?: "repository" | "worktree";
  resourceKey: string;
  sessionId: string;
  userId: string;
  ttlMs?: number;
  now?: number;
}): LeaseResult {
  const db = getDb();
  const now = input.now ?? Date.now();
  const expiresAt = now + Math.max(30_000, Math.min(input.ttlMs ?? 30 * 60_000, 24 * 60 * 60_000));
  const resourceType = input.resourceType ?? "repository";
  const resourceKey = canonicalLeaseKey(input.resourceKey);
  let result: LeaseResult = { ok: false, holderSessionId: null, fenceEpoch: 0, expiresAt: null };
  const tx = db.transaction(() => {
    const current = db.query(`
      SELECT tenant_id, holder_session_id, status, fence_epoch, revision, expires_at
      FROM leases
      WHERE resource_type = ? AND resource_key = ?
    `).get(resourceType, resourceKey) as {
      tenant_id: string;
      holder_session_id: string | null;
      status: string;
      fence_epoch: number;
      revision: number;
      expires_at: number | null;
    } | null;
    const active = current?.status === "active" && (current.expires_at ?? 0) > now;
    if (active && (current?.tenant_id !== input.tenantId || current.holder_session_id !== input.sessionId)) {
      result = { ok: false, holderSessionId: current.holder_session_id, fenceEpoch: current.fence_epoch, expiresAt: current.expires_at };
      return;
    }
    const fenceEpoch = (current?.fence_epoch ?? 0) + (active ? 0 : 1);
    const revision = (current?.revision ?? 0) + 1;
    db.query(`
      INSERT INTO leases (
        resource_type, resource_key, tenant_id, holder_session_id, holder_user_id,
        mode, status, fence_epoch, revision, acquired_at, expires_at, released_at
      ) VALUES (?, ?, ?, ?, ?, 'writer', 'active', ?, ?, ?, ?, NULL)
      ON CONFLICT(resource_type, resource_key) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        holder_session_id = excluded.holder_session_id,
        holder_user_id = excluded.holder_user_id,
        mode = 'writer', status = 'active', fence_epoch = excluded.fence_epoch,
        revision = excluded.revision, acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at, released_at = NULL
    `).run(resourceType, resourceKey, input.tenantId, input.sessionId, input.userId, fenceEpoch, revision, now, expiresAt);
    result = { ok: true, fenceEpoch, revision };
  });
  tx();
  return result;
}

export function rebindWriterLease(resourceKey: string, provisionalSessionId: string, sessionId: string): void {
  getDb().query(`
    UPDATE leases
    SET holder_session_id = ?, revision = revision + 1
    WHERE resource_type = 'repository' AND resource_key = ?
      AND holder_session_id = ? AND status = 'active'
  `).run(sessionId, canonicalLeaseKey(resourceKey), provisionalSessionId);
}

export function releaseWriterLease(input: { resourceKey: string; sessionId: string; fenceEpoch: number; now?: number }): boolean {
  const result = getDb().query(`
    UPDATE leases
    SET status = 'released', released_at = ?, expires_at = ?, revision = revision + 1
    WHERE resource_type = 'repository' AND resource_key = ?
      AND holder_session_id = ? AND fence_epoch = ? AND status = 'active'
  `).run(input.now ?? Date.now(), input.now ?? Date.now(), canonicalLeaseKey(input.resourceKey), input.sessionId, input.fenceEpoch);
  return result.changes === 1;
}

export function releaseWriterLeaseForSession(resourceKey: string, sessionId: string, now = Date.now()): boolean {
  const result = getDb().query(`
    UPDATE leases
    SET status = 'released', released_at = ?, expires_at = ?, revision = revision + 1
    WHERE resource_type = 'repository' AND resource_key = ?
      AND holder_session_id = ? AND status = 'active'
  `).run(now, now, canonicalLeaseKey(resourceKey), sessionId);
  return result.changes === 1;
}

export function listInternalVisibilityReceipts(): Array<{
  harness: string;
  adapterSessionId: string;
  reason: string;
  source: string;
  recordedAt: number;
}> {
  const db = getDb();
  return db.query(`
    SELECT harness, adapter_session_id, reason, source, recorded_at
    FROM visibility_receipts
    ORDER BY recorded_at, adapter_session_id
  `).all().map((row) => {
    const item = row as { harness: string; adapter_session_id: string; reason: string; source: string; recorded_at: number };
    return { harness: item.harness, adapterSessionId: item.adapter_session_id, reason: item.reason, source: item.source, recordedAt: item.recorded_at };
  });
}
