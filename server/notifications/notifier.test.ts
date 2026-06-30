import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit, readOperatorState, writeActionAudit, writeOperatorState } from "../db/writer.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { notifyCriticalFindings, __test_only } from "./notifier.ts";
import { upsertInsight } from "../insights/store.ts";
import { sendTelegramAlert } from "./telegram.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevChat: string | undefined;
let prevFetch: typeof fetch | null | undefined;
let prevBaseUrl: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "notifier-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.TELEGRAM_BOT_TOKEN;
  prevChat = process.env.TELEGRAM_CHAT_ID;
  prevFetch = globalThis.fetch;
  prevBaseUrl = process.env.CONTROL_SURFACE_BASE_URL;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.TELEGRAM_BOT_TOKEN = "notifier-test-token";
  process.env.TELEGRAM_CHAT_ID = "notifier-chat";
  process.env.CONTROL_SURFACE_BASE_URL = "https://control.test.local/app";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = prevToken;
  if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = prevChat;
  if (prevBaseUrl === undefined) delete process.env.CONTROL_SURFACE_BASE_URL;
  else process.env.CONTROL_SURFACE_BASE_URL = prevBaseUrl;
  if (prevFetch === undefined) {
    (globalThis as { __notifierTestFetch?: typeof fetch }).__notifierTestFetch = undefined;
  } else {
    globalThis.fetch = prevFetch;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

function installTelegramMock(capture: { calls: Array<{ url: string; body: string }> }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    capture.calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function capturedTelegramText(capture: { calls: Array<{ body: string }> }, index = 0): string {
  const raw = capture.calls[index]?.body ?? "{}";
  const parsed = JSON.parse(raw) as { text?: string };
  return parsed.text ?? "";
}

describe("notifyCriticalFindings — dedupe behavior", () => {
  test("seeds default notification rule on first run", async () => {
    const capture = { calls: [] as Array<{ url: string; body: string }> };
    installTelegramMock(capture);

    const result = await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    expect(result.ruleEnabled).toBe(true);
    expect(result.sent).toBe(0);
    expect(capture.calls.length).toBe(0);

    const db = getDashboardDb()!;
    const rule = db.query(`SELECT id, kind, enabled, channels_json FROM notification_rules WHERE kind = ?`)
      .get("insight.critical-high") as { id: number; kind: string; enabled: number; channels_json: string } | null;
    expect(rule).not.toBeNull();
    expect(rule!.enabled).toBe(1);
    const channels = JSON.parse(rule!.channels_json) as string[];
    expect(channels).toContain("telegram");
  });

  test("sends 1 message for a seeded high insight; second run sends 0 (dedupe)", async () => {
    const capture = { calls: [] as Array<{ url: string; body: string }> };
    installTelegramMock(capture);

    withTenant("mimule", () => {
      upsertInsight({
        id: "ins_high_1",
        domain: "security",
        severity: "high",
        title: "Test high finding",
        plainSummary: "Something to fix right away.",
        confidence: 0.9,
        evidenceRefs: [],
        actionDescriptorId: null,
        manualPageHref: "/insights",
        createdAt: Date.now(),
        sourceKey: "test:high-1",
      });
    });

    const first = await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    expect(first.ruleEnabled).toBe(true);
    expect(first.scanned).toBe(1);
    expect(first.sent).toBe(1);
    expect(first.deduped).toBe(0);
    expect(capture.calls.length).toBe(1);
    const messageText = capturedTelegramText(capture);
    expect(messageText).toContain("https://control.test.local/insights?focus=test%3Ahigh-1");
    expect(messageText).toContain("Auto-fix activity:");

    const auditRows = readActionAudit({ actionKind: "notify.telegram" });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].targetId).toBe("ins_high_1");
    expect(auditRows[0].resultStatus).toBe("success");

    const second = await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    expect(second.scanned).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.deduped).toBe(1);
    expect(capture.calls.length).toBe(1);

    const auditAfter = readActionAudit({ actionKind: "notify.telegram" });
    expect(auditAfter.length).toBe(1);
  });

  test("does not notify for medium/low/open-without-notify-rule insight", async () => {
    const capture = { calls: [] as Array<{ url: string; body: string }> };
    installTelegramMock(capture);

    withTenant("mimule", () => {
      upsertInsight({
        id: "ins_medium_1",
        domain: "cost",
        severity: "medium",
        title: "Some medium finding",
        plainSummary: "Not urgent.",
        confidence: 0.7,
        evidenceRefs: [],
        actionDescriptorId: null,
        manualPageHref: "/insights",
        createdAt: Date.now(),
        sourceKey: "test:medium-1",
      });
    });

    const result = await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    expect(result.scanned).toBe(0);
    expect(result.sent).toBe(0);
    expect(capture.calls.length).toBe(0);
  });

  test("critical severity also notifies; second run is deduped", async () => {
    const capture = { calls: [] as Array<{ url: string; body: string }> };
    installTelegramMock(capture);

    withTenant("mimule", () => {
      upsertInsight({
        id: "ins_crit_1",
        domain: "security",
        severity: "critical",
        title: "Critical test",
        plainSummary: "Fix immediately.",
        confidence: 0.95,
        evidenceRefs: [],
        actionDescriptorId: null,
        manualPageHref: "/insights",
        createdAt: Date.now(),
        sourceKey: "test:crit-1",
      });
    });

    const first = await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    expect(first.sent).toBe(1);
    expect(capture.calls.length).toBe(1);
    const second = await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    expect(second.sent).toBe(0);
    expect(second.deduped).toBe(1);
  });

  test("message includes auto-apply activity summary from existing audit rows", async () => {
    const capture = { calls: [] as Array<{ url: string; body: string }> };
    installTelegramMock(capture);

    withTenant("mimule", () => {
      const now = Date.now();
      writeActionAudit({
        actor: "system",
        actorSource: "scheduler",
        actionKind: "insights.auto-apply",
        actionId: "mutate-policy:model:old-model:cooldown-clear",
        targetType: "insight",
        targetId: "auto-1",
        resultStatus: "success",
        result: "auto-cleared cooldown",
      });
      upsertInsight({
        id: "insight_autoapply_flapping_test",
        domain: "security",
        severity: "high",
        title: "Auto-apply circuit breaker tripped",
        plainSummary: "Auto-apply failed repeatedly and was left for review.",
        confidence: 0.9,
        evidenceRefs: [],
        actionDescriptorId: null,
        manualPageHref: "/insights",
        createdAt: now,
        sourceKey: "security:autoapply-flapping:test",
      });
      upsertInsight({
        id: "ins_high_activity",
        domain: "ops",
        severity: "high",
        title: "High finding with handled activity",
        plainSummary: "The system detected this after auto-fixes ran.",
        confidence: 0.9,
        evidenceRefs: [],
        actionDescriptorId: null,
        manualPageHref: "/insights",
        createdAt: now,
        sourceKey: "ops:activity:1",
      });
    });

    const result = await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    expect(result.sent).toBe(2);
    const combinedText = capture.calls.map((_, index) => capturedTelegramText(capture, index)).join("\n---\n");
    expect(combinedText).toContain("Auto-fix activity handled:");
    expect(combinedText).toContain("auto-cleared 1 expired cooldown");
    expect(combinedText).toContain("1 flapping finding sent to review");
    expect(combinedText).toContain("https://control.test.local/insights?focus=ops%3Aactivity%3A1");
  });

  test("returns ruleEnabled=false and short-circuits when rule disabled", async () => {
    const capture = { calls: [] as Array<{ url: string; body: string }> };
    installTelegramMock(capture);

    withTenant("mimule", () => {
      const db = getDashboardDb()!;
      db.query(`
        INSERT INTO notification_rules (kind, enabled, threshold_json, channels_json, updated_at)
        VALUES (?, 0, ?, ?, ?)
      `).run(
        __test_only.DEFAULT_RULE_KIND,
        JSON.stringify({ severities: ["critical", "high"] }),
        JSON.stringify(["telegram"]),
        Date.now(),
      );
      upsertInsight({
        id: "ins_high_disabled",
        domain: "security",
        severity: "high",
        title: "High but rule disabled",
        plainSummary: "Should be skipped.",
        confidence: 0.9,
        evidenceRefs: [],
        actionDescriptorId: null,
        manualPageHref: "/insights",
        createdAt: Date.now(),
        sourceKey: "test:high-disabled",
      });
    });

    const result = await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    expect(result.ruleEnabled).toBe(false);
    expect(result.sent).toBe(0);
    expect(capture.calls.length).toBe(0);
  });

  test("notified-map persists to operator_state", async () => {
    const capture = { calls: [] as Array<{ url: string; body: string }> };
    installTelegramMock(capture);

    withTenant("mimule", () => {
      upsertInsight({
        id: "ins_persist_1",
        domain: "build",
        severity: "high",
        title: "Persist me",
        plainSummary: "Persist dedupe.",
        confidence: 0.9,
        evidenceRefs: [],
        actionDescriptorId: null,
        manualPageHref: "/insights",
        createdAt: Date.now(),
        sourceKey: "test:persist-1",
      });
    });

    await withTenant("mimule", () => notifyCriticalFindings(15 * 60 * 1000));
    const stored = readOperatorState(__test_only.NOTIFIED_MARKER_KEY) as Record<string, number> | null;
    expect(stored).not.toBeNull();
    expect(stored!["ins_persist_1"]).toBeGreaterThan(0);
  });
});

describe("sendTelegramAlert — env-less (notifier path)", () => {
  test("returns false without throwing when env is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const ok = await sendTelegramAlert("hello");
    expect(ok).toBe(false);
  });

  test("re-seeds notified map without losing prior ids", async () => {
    writeOperatorState(__test_only.NOTIFIED_MARKER_KEY, { prior_id: 12345 });
    const map = __test_only.readNotifiedMap();
    expect(map["prior_id"]).toBe(12345);
    map["new_id"] = Date.now();
    __test_only.writeNotifiedMap(map);
    const round = readOperatorState(__test_only.NOTIFIED_MARKER_KEY) as Record<string, number>;
    expect(round["prior_id"]).toBe(12345);
    expect(round["new_id"]).toBeGreaterThan(0);
  });
});
