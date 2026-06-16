import { randomUUID } from "node:crypto";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export type RunnerAgentKind = "codex" | "claude" | "gemini" | "opencode";

export const NON_GATEWAY_CLI_LANES: ReadonlySet<RunnerAgentKind> = new Set<RunnerAgentKind>([
  "codex",
  "claude",
  "gemini",
]);

export function registryAgentIdForLane(agentKind: string): string | null {
  const kind = agentKind.toLowerCase();
  if (kind === "codex" || kind === "claude" || kind === "gemini" || kind === "opencode") {
    return `${kind}-runner`;
  }
  return null;
}

export function isNonGatewayCliLane(agentKind: string | null | undefined): boolean {
  if (!agentKind) return false;
  const kind = agentKind.toLowerCase();
  return kind === "codex" || kind === "claude" || kind === "gemini";
}

export type RecordRunnerUsageOptions = {
  agentKind: string;
  sessionOrRunId: string;
  detail?: string;
};

export function hasRunnerUsageForSession(sessionOrRunId: string): boolean {
  if (!isDashboardDbEnabled()) return false;
  const db = getDashboardDb();
  if (!db) return false;
  try {
    const row = db
      .query(`
        SELECT id FROM cost_events
        WHERE json_extract(metadata_json, '$.sessionOrRunId') = ?
        LIMIT 1
      `)
      .get(sessionOrRunId) as { id: string } | null;
    return row !== null;
  } catch {
    return false;
  }
}

export function recordRunnerUsage(opts: RecordRunnerUsageOptions): void {
  if (!opts || !opts.sessionOrRunId || !opts.agentKind) return;
  if (!isNonGatewayCliLane(opts.agentKind)) return;

  if (!isDashboardDbEnabled()) return;
  const db = getDashboardDb();
  if (!db) return;

  const agentId = registryAgentIdForLane(opts.agentKind);
  if (!agentId) return;

  if (hasRunnerUsageForSession(opts.sessionOrRunId)) return;

  const tenantId = getCurrentTenantContext().tenantId;
  const ts = Date.now();
  const logicalModel = opts.agentKind.toLowerCase();
  const metadata = {
    sessionOrRunId: opts.sessionOrRunId,
    detail: opts.detail ?? null,
    source: "runner",
    lane: logicalModel,
  };
  const metadataJson = JSON.stringify(metadata);

  const costEventId = `cost_runner_${ts}_${randomUUID().slice(0, 8)}`;

  try {
    db.query(`
      INSERT INTO cost_events
        (id, tenant_id, ts, source, logical_model, provider, tier,
         workflow_type, workflow_id, builder_run_id, cost_cents, cost_basis, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      costEventId,
      tenantId,
      ts,
      "runner",
      logicalModel,
      logicalModel,
      "cloud-free",
      "builder",
      opts.sessionOrRunId,
      opts.sessionOrRunId,
      0,
      "cli-unmetered",
      metadataJson,
    );
  } catch (e) {
    console.error("[runner-accounting] cost_events insert failed:", e);
    return;
  }

  try {
    db.query(`
      INSERT INTO gateway_calls
        (ts, logical_model, resolved_model, backend, tier, cost_estimate_usd, success, caller)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts,
      logicalModel,
      logicalModel,
      "cli-direct",
      "cloud-free",
      null,
      1,
      agentId,
    );
  } catch (e) {
    console.error("[runner-accounting] gateway_calls insert failed:", e);
  }
}
