import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import { readActionAudit } from "../../db/writer.ts";
import { seedDefaultAgents } from "../../agents/registry.ts";
import { getInsight, listInsights } from "../store.ts";
import { runRegistryScan } from "./registry.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "registry-scanner-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

describe("registry scanner: unregistered actors", () => {
  test("emits an open security insight pointing at /agents for an unknown action_audit actor", () => {
    seedDefaultAgents();
    const now = Date.now();
    db().query(`
      INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
      VALUES (?, 'mystery-bot', 'system', 'tool.run', 'tool.run', 'thing', 'thing-1', 'success', 'mimule')
    `).run(now - 1000);

    const result = runRegistryScan();
    const finding = result.findings.find((f) => f.sourceKey === "registry:unregistered:mystery-bot");

    expect(finding).toBeDefined();
    expect(finding!.status).toBe("open");
    expect(finding!.domain).toBe("security");
    expect(finding!.severity).toBe("medium");
    expect(finding!.manualPageHref).toBe("/agents");
    expect(finding!.actionDescriptorId).toBeNull();
    expect(finding!.title).toBe("An unregistered actor is taking actions");
    expect(finding!.plainSummary).toContain("mystery-bot");

    const persisted = getInsight(`insight_registry_unregistered_mystery-bot`);
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe("open");
  });

  test("does NOT emit an unregistered finding for an actor that is a seeded alias", () => {
    seedDefaultAgents();
    const now = Date.now();
    db().query(`
      INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
      VALUES (?, 'reasoner', 'system', 'reasoner.diagnose', 'reasoner.diagnose', 'pass', 'pass-1', 'success', 'mimule')
    `).run(now - 1000);

    const result = runRegistryScan();
    const reasonerUnregistered = result.findings.find((f) => f.sourceKey === "registry:unregistered:reasoner");
    expect(reasonerUnregistered).toBeUndefined();
  });

  test("auto-resolves a previously emitted unregistered insight once the actor is added to an agent's aliases_json", () => {
    seedDefaultAgents();
    const now = Date.now();
    db().query(`
      INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
      VALUES (?, 'mystery-bot', 'system', 'tool.run', 'tool.run', 'thing', 'thing-1', 'success', 'mimule')
    `).run(now - 1000);

    const first = runRegistryScan();
    expect(first.findings.some((f) => f.sourceKey === "registry:unregistered:mystery-bot")).toBe(true);

    db().query(`
      UPDATE agents SET aliases_json = ? WHERE id = ?
    `).run(JSON.stringify(["opencode", "mystery-bot"]), "opencode-runner");

    const second = runRegistryScan();
    expect(second.findings.some((f) => f.sourceKey === "registry:unregistered:mystery-bot")).toBe(false);
    expect(second.resolvedCount).toBeGreaterThanOrEqual(1);

    const persisted = getInsight("insight_registry_unregistered_mystery-bot");
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe("resolved");
    expect(typeof persisted!.resolvedAt).toBe("number");

    const audit = readActionAudit({ targetType: "insight" });
    expect(audit.some((row) =>
      row.actionKind === "insights.auto-resolve" &&
      row.targetId === "insight_registry_unregistered_mystery-bot" &&
      row.resultStatus === "success"
    )).toBe(true);
  });
});

describe("registry scanner: idle agents", () => {
  test("emits an idle finding for an active agent whose only alias has not been seen in 40 days", () => {
    seedDefaultAgents();
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    db().query(`
      INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
      VALUES (?, 'reasoner', 'system', 'reasoner.diagnose', 'reasoner.diagnose', 'pass', 'pass-old', 'success', 'mimule')
    `).run(fortyDaysAgo);

    const result = runRegistryScan();
    const idle = result.findings.find((f) => f.sourceKey === "registry:idle:reasoner");

    expect(idle).toBeDefined();
    expect(idle!.domain).toBe("build");
    expect(idle!.severity).toBe("low");
    expect(idle!.title).toBe("Agent Reasoner has been idle for a month");
    expect(idle!.manualPageHref).toBe("/agents");
  });

  test("does NOT emit an idle finding for an agent that has never been seen (lastSeenAt null)", () => {
    seedDefaultAgents();

    const result = runRegistryScan();
    const idleForCodex = result.findings.find((f) => f.sourceKey === "registry:idle:codex-runner");
    const idleForInsightScanner = result.findings.find((f) => f.sourceKey === "registry:idle:insights-scanner");

    expect(idleForCodex).toBeUndefined();
    expect(idleForInsightScanner).toBeUndefined();

    const openInsights = listInsights("open");
    expect(openInsights.some((row) => row.sourceKey === "registry:idle:codex-runner")).toBe(false);
  });
});

describe("registry scanner: ownerless agents", () => {
  test("emits an ownerless finding for an agent with a blank owner", () => {
    seedDefaultAgents();
    db().query(`UPDATE agents SET owner = '' WHERE id = ?`).run("opencode-runner");

    const result = runRegistryScan();
    const ownerless = result.findings.find((f) => f.sourceKey === "registry:ownerless:opencode-runner");

    expect(ownerless).toBeDefined();
    expect(ownerless!.domain).toBe("security");
    expect(ownerless!.severity).toBe("medium");
    expect(ownerless!.manualPageHref).toBe("/agents");
    expect(ownerless!.title).toBe("Agent OpenCode Runner has no owner");
  });
});
