#!/usr/bin/env bun
import { getDashboardDb, initDashboardDb } from "../server/db/dashboard.ts";
import { listInternalVisibilityReceipts } from "../server/agentWorkspace/registry.ts";
import { writeActionAudit } from "../server/db/writer.ts";

if (process.getuid?.() !== 0) {
  console.error("agent-session-audit must run as root");
  process.exit(77);
}
if (!process.argv.includes("--include-internal")) {
  console.error("refusing diagnostic access without explicit --include-internal");
  process.exit(64);
}

const db = initDashboardDb({ enabled: true });
if (!db || !getDashboardDb()) {
  console.error("dashboard database is unavailable");
  process.exit(69);
}

const receipts = listInternalVisibilityReceipts();
const bySource = new Map<string, number>();
for (const receipt of receipts) bySource.set(receipt.source, (bySource.get(receipt.source) ?? 0) + 1);

writeActionAudit({
  actor: `uid:${process.getuid()}`,
  actorSource: "root-diagnostic-cli",
  actionKind: "agent-workspace.internal-audit",
  targetType: "visibility-receipts",
  targetId: "all",
  risk: "low",
  resultStatus: "success",
  result: `Audited ${receipts.length} internal visibility receipts.`,
  request: { includeInternal: true },
});

console.log(JSON.stringify({
  receiptCount: receipts.length,
  bySource: Object.fromEntries([...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))),
  receipts: receipts.slice(0, 500).map((receipt) => ({
    harness: receipt.harness,
    adapterSessionId: receipt.adapterSessionId,
    reason: receipt.reason,
    source: receipt.source,
    recordedAt: receipt.recordedAt,
  })),
  truncated: receipts.length > 500,
}, null, 2));
