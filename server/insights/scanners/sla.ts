// SLA-breach / approaching-SLA detector (ULTRAPLAN P2.3).
//
// Reads open, un-muted reasoner_incidents that carry a resolve-by deadline
// (sla_due_at, set at both incident-creation sites — see
// server/insights/scanners/sentinelIncidents.ts and
// server/reasoner/clustering.ts) and emits ops/high insights when an
// incident has breached its deadline, or is approaching it. Follows the same
// activeKeys/resolveStaleInsights stale-resolve pattern as the other
// scanners (see ops.ts): once an incident resolves, is muted, or its state
// moves from "approaching" to "breached" (or vice versa is impossible, but
// clearing back to neither happens on resolve/mute), the previously-emitted
// insight for the old state auto-resolves on the next scan.
import type { EvidenceRef } from "../../api/types.ts";
import type { Insight, InsightInput } from "../types.ts";
import { getDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import { upsertInsight, resolveStaleInsights } from "../store.ts";
import { writeActionAudit } from "../../db/writer.ts";
import { approachingWindowMs } from "../../reasoner/sla.ts";

type ScanResult = {
  scannedAt: number;
  findings: Insight[];
  resolvedCount: number;
};

export type SlaIncidentRow = {
  id: string;
  title: string;
  first_seen: number;
  sla_due_at: number | null;
  acknowledged_at: number | null;
  owner: string | null;
  muted_at: number | null;
  muted_until: number | null;
};

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref };
}

export function isMuteActive(row: Pick<SlaIncidentRow, "muted_at" | "muted_until">, now: number): boolean {
  if (row.muted_at === null) return false;
  return row.muted_until === null || row.muted_until > now;
}

function fmtDuration(ms: number): string {
  const abs = Math.max(0, ms);
  const hours = abs / (60 * 60 * 1000);
  if (hours < 1) return `${Math.max(1, Math.round(abs / 60_000))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function ownerText(owner: string | null): string {
  const trimmed = owner?.trim();
  return trimmed ? trimmed : "unassigned";
}

// Pure mapping function (data → finding descriptors): deterministic and
// unit-testable without a live dashboard DB.
export function mapSlaFindings(rows: SlaIncidentRow[], now: number): InsightInput[] {
  const out: InsightInput[] = [];
  for (const row of rows) {
    if (row.sla_due_at === null) continue;
    if (isMuteActive(row, now)) continue;

    const ackState = row.acknowledged_at !== null ? "acknowledged" : "not yet acknowledged";
    const actionDescriptorId = row.acknowledged_at === null ? `acknowledge:incident:${row.id}` : null;
    const evidenceRefs = [evidence("Incident", "api", `/api/reasoner/incidents/${row.id}`)];

    if (now > row.sla_due_at) {
      const overdueBy = fmtDuration(now - row.sla_due_at);
      out.push({
        id: `insight_sla_breach_${row.id}`,
        sourceKey: `sla:breach:${row.id}`,
        domain: "ops",
        severity: "high",
        title: "An incident has breached its SLA",
        plainSummary: `"${row.title}" is ${overdueBy} past its resolve-by deadline. Owner: ${ownerText(row.owner)}. It is ${ackState}.`,
        confidence: 0.9,
        evidenceRefs,
        actionDescriptorId,
        manualPageHref: "/incidents",
        createdAt: now,
      });
      continue;
    }

    const window = approachingWindowMs(row.title);
    if (row.sla_due_at - now <= window) {
      const dueIn = fmtDuration(row.sla_due_at - now);
      out.push({
        id: `insight_sla_approaching_${row.id}`,
        sourceKey: `sla:approaching:${row.id}`,
        domain: "ops",
        severity: "high",
        title: "An incident is approaching its SLA deadline",
        plainSummary: `"${row.title}" is due in ${dueIn}. Owner: ${ownerText(row.owner)}. It is ${ackState}.`,
        confidence: 0.85,
        evidenceRefs,
        actionDescriptorId,
        manualPageHref: "/incidents",
        createdAt: now,
      });
    }
  }
  return out;
}

export function getOpenSlaIncidents(): SlaIncidentRow[] {
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant();
  return db.query(`
    SELECT id, title, first_seen, sla_due_at, acknowledged_at, owner, muted_at, muted_until
    FROM reasoner_incidents
    WHERE status = 'open' AND sla_due_at IS NOT NULL ${tenant.clause}
  `).all(...tenant.params) as SlaIncidentRow[];
}

export function runSlaScan(): ScanResult {
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  if (!getDashboardDb()) return { scannedAt, findings, resolvedCount: 0 };

  const rows = getOpenSlaIncidents();
  const descriptors = mapSlaFindings(rows, scannedAt);

  const emittedSourceKeys: string[] = [];
  for (const descriptor of descriptors) {
    const row = upsertInsight(descriptor);
    if (row) {
      findings.push(row);
      if (descriptor.sourceKey) emittedSourceKeys.push(descriptor.sourceKey);
    }
  }

  const resolved = resolveStaleInsights(
    "sla:",
    emittedSourceKeys,
    "The SLA scanner confirmed this incident is no longer breached or approaching its deadline (resolved, muted, or the incident's state moved on).",
  );
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: "The SLA scanner confirmed this condition has cleared.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }

  return { scannedAt, findings, resolvedCount: resolved.length };
}
