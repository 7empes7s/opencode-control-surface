import { getDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import type { EvidenceRef } from "../../api/types.ts";
import type { Insight } from "../types.ts";
import { upsertInsight, resolveStaleInsights } from "../store.ts";
import { writeActionAudit } from "../../db/writer.ts";

type ScanResult = {
  scannedAt: number;
  findings: Insight[];
  resolvedCount: number;
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Internal control-surface service accounts. These act on the system by
// design and must never be flagged as "unregistered actors". 'anonymous' is
// also treated as internal. Real registered agents come from the agents table.
export const INTERNAL_SYSTEM_ACTORS: ReadonlySet<string> = new Set([
  "anonymous",
  "system",
  "operator",
  "operator-bootstrap",
  "dev-bootstrap",
  "brainstorm-planner",
  "insights-notifier",
  "reasoner",
]);

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref, redacted: true };
}

function add(results: Insight[], input: Parameters<typeof upsertInsight>[0], emittedSourceKeys: string[]): void {
  const row = upsertInsight(input);
  if (row) {
    results.push(row);
    if (input.sourceKey) emittedSourceKeys.push(input.sourceKey);
  }
}

function parseAliases(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

type AgentAliasRow = {
  id: string;
  name: string;
  owner: string | null;
  status: string;
  aliases_json: string;
};

function collectAllAliases(): { aliasSet: Set<string>; idleCandidates: Array<{ id: string; name: string; aliases: string[] }>; ownerless: Array<{ id: string; name: string }> } {
  const db = getDashboardDb();
  if (!db) return { aliasSet: new Set(), idleCandidates: [], ownerless: [] };

  const tenant = whereTenant();
  const rows = db.query(`
    SELECT id, name, owner, status, aliases_json
    FROM agents
    WHERE 1=1 ${tenant.clause}
  `).all(...tenant.params) as AgentAliasRow[];

  const aliasSet = new Set<string>();
  const idleCandidates: Array<{ id: string; name: string; aliases: string[] }> = [];
  const ownerless: Array<{ id: string; name: string }> = [];

  for (const row of rows) {
    aliasSet.add(row.id);
    const aliases = parseAliases(row.aliases_json);
    for (const a of aliases) {
      if (a) aliasSet.add(a);
    }
    if (row.status === "active") {
      idleCandidates.push({ id: row.id, name: row.name, aliases });
    }
    if (!row.owner || row.owner.trim() === "") {
      ownerless.push({ id: row.id, name: row.name });
    }
  }

  return { aliasSet, idleCandidates, ownerless };
}

function readLastSeenForAliases(aliases: string[]): number | null {
  const db = getDashboardDb();
  if (!db || aliases.length === 0) return null;
  const placeholders = aliases.map(() => "?").join(",");
  const tenant = whereTenant();
  const row = db.query(`
    SELECT MAX(ts) AS last_ts FROM action_audit
    WHERE actor IN (${placeholders}) ${tenant.clause}
  `).get(...aliases, ...tenant.params) as { last_ts: number | null } | null;
  return row?.last_ts ?? null;
}

export function runRegistryScan(): ScanResult {
  const db = getDashboardDb();
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  const emittedSourceKeys: string[] = [];
  if (!db) return { scannedAt, findings, resolvedCount: 0 };

  const tenant = whereTenant();
  const thirtyDaysAgo = scannedAt - THIRTY_DAYS_MS;

  // 1. Unregistered actors: distinct action_audit.actor + gateway_calls.caller
  //    from the last 30 days that don't match any registered alias.
  const { aliasSet, idleCandidates, ownerless } = collectAllAliases();

  const auditActors = db.query(`
    SELECT DISTINCT actor
    FROM action_audit
    WHERE actor IS NOT NULL
      AND actor != ''
      AND actor != 'anonymous'
      AND ts >= ? ${tenant.clause}
  `).all(thirtyDaysAgo, ...tenant.params) as Array<{ actor: string }>;

  const gatewayCallers = db.query(`
    SELECT DISTINCT caller
    FROM gateway_calls
    WHERE caller IS NOT NULL
      AND caller != ''
      AND caller != 'anonymous'
      AND ts >= ? ${tenant.clause}
  `).all(thirtyDaysAgo, ...tenant.params) as Array<{ caller: string }>;

  const isInternal = (a: string) => INTERNAL_SYSTEM_ACTORS.has(a);

  const unregistered = new Set<string>();
  for (const { actor } of auditActors) {
    if (!aliasSet.has(actor) && !isInternal(actor)) unregistered.add(actor);
  }
  for (const { caller } of gatewayCallers) {
    if (!aliasSet.has(caller) && !isInternal(caller)) unregistered.add(caller);
  }

  for (const actor of unregistered) {
    add(findings, {
      id: `insight_registry_unregistered_${actor}`,
      sourceKey: `registry:unregistered:${actor}`,
      domain: "security",
      severity: "medium",
      title: "An unregistered actor is taking actions",
      plainSummary: `The actor "${actor}" is taking actions in the system but is not registered as an agent on the agents page. Register it on /agents so the dashboard can account for what it does.`,
      confidence: 0.82,
      evidenceRefs: [
        evidence("Audit + gateway actors", "db", "action_audit,gateway_calls"),
        evidence("Agents page", "api", "/api/agent-registry"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/agents",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  }

  // 2. Idle agents: status='active' with lastSeenAt > 30 days ago (and not null).
  for (const candidate of idleCandidates) {
    const lastSeenAt = readLastSeenForAliases(candidate.aliases);
    if (lastSeenAt === null) continue;
    if (lastSeenAt >= thirtyDaysAgo) continue;
    add(findings, {
      id: `insight_registry_idle_${candidate.id}`,
      sourceKey: `registry:idle:${candidate.id}`,
      domain: "build",
      severity: "low",
      title: `Agent ${candidate.name} has been idle for a month`,
      plainSummary: `The agent "${candidate.name}" (id: ${candidate.id}) is still marked active but has not taken any action in over 30 days. Pause or retire it on /agents so the registry stays honest.`,
      confidence: 0.78,
      evidenceRefs: [
        evidence("Agent row", "db", `agents:${candidate.id}`),
        evidence("Last seen audit", "db", "action_audit"),
        evidence("Agents page", "api", "/api/agent-registry"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/agents",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  }

  // 3. Ownerless agents: owner empty/blank.
  for (const o of ownerless) {
    add(findings, {
      id: `insight_registry_ownerless_${o.id}`,
      sourceKey: `registry:ownerless:${o.id}`,
      domain: "security",
      severity: "medium",
      title: `Agent ${o.name} has no owner`,
      plainSummary: `The agent "${o.name}" (id: ${o.id}) does not have an owner recorded. Set an owner on /agents so accountability is clear for every active agent.`,
      confidence: 0.8,
      evidenceRefs: [
        evidence("Agent row", "db", `agents:${o.id}`),
        evidence("Agents page", "api", "/api/agent-registry"),
      ],
      actionDescriptorId: null,
      manualPageHref: "/agents",
      createdAt: scannedAt,
    }, emittedSourceKeys);
  }

  const resolved = resolveStaleInsights(
    "registry:",
    emittedSourceKeys,
    "The registry scanner confirmed this is no longer the case."
  );
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: "The registry scanner confirmed this is no longer the case.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }
  return { scannedAt, findings, resolvedCount: resolved.length };
}
