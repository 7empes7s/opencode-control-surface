import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { handleApi } from "../api/router.ts";
import {
  getModuleUsage,
  getUsageSummary,
  recordUsageEvents,
  rollupUsageDaily,
  sweepUsageRetention,
} from "./analytics.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function authenticatedRequest(path = "/", init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "x-operator-token": "usage-test-token",
      "x-tenant-id": "mimule",
      "x-real-ip": `usage-${Math.random()}`,
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("first-party usage analytics", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousOperatorToken: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "usage-analytics-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousOperatorToken = process.env.OPERATOR_TOKEN;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    process.env.OPERATOR_TOKEN = "usage-test-token";
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousOperatorToken;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("records valid rows, normalizes paths, and skips malformed rows", () => {
    const tooLong = `/${"x".repeat(512)}`;
    const recorded = recordUsageEvents([
      { path: "/models?tab=health#active" },
      { path: "/jobs#running" },
      { path: "settings" },
      { path: tooLong },
    ], authenticatedRequest());

    expect(recorded).toBe(2);
    const rows = getDashboardDb()!.query("SELECT path, event_type, tenant_id, actor_source FROM usage_events ORDER BY path").all();
    expect(rows).toEqual([
      { path: "/jobs", event_type: "pageview", tenant_id: "mimule", actor_source: "operator-bootstrap" },
      { path: "/models", event_type: "pageview", tenant_id: "mimule", actor_source: "operator-bootstrap" },
    ]);
  });

  test("rejects batches larger than 50 as a whole", () => {
    const events = Array.from({ length: 51 }, (_, index) => ({ path: `/page-${index}` }));
    expect(recordUsageEvents(events, authenticatedRequest())).toBe(0);
    expect(getDashboardDb()!.query("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 0 });
  });

  test("rollup is idempotent and combines pageviews with action audit counts", () => {
    const now = Date.UTC(2026, 6, 12, 12);
    const db = getDashboardDb()!;
    const insertUsage = db.query("INSERT INTO usage_events (id, tenant_id, ts, event_type, path) VALUES (?, 'mimule', ?, 'pageview', ?)");
    insertUsage.run("pv-1", now - DAY_MS, "/models");
    insertUsage.run("pv-2", now - DAY_MS + 1, "/models");
    insertUsage.run("pv-3", now, "/jobs");
    db.query("INSERT INTO action_audit (ts, action_kind, tenant_id) VALUES (?, ?, 'mimule')").run(now, "models.probe");
    db.query("INSERT INTO action_audit (ts, action_kind, tenant_id) VALUES (?, ?, 'mimule')").run(now + 1, "models.probe");

    rollupUsageDaily(now);
    const first = db.query("SELECT day, event_type, path, count FROM usage_daily ORDER BY day, event_type, path").all();
    rollupUsageDaily(now);
    const second = db.query("SELECT day, event_type, path, count FROM usage_daily ORDER BY day, event_type, path").all();

    expect(second).toEqual(first);
    expect(second).toEqual([
      { day: "2026-07-11", event_type: "pageview", path: "/models", count: 2 },
      { day: "2026-07-12", event_type: "action", path: "models.probe", count: 2 },
      { day: "2026-07-12", event_type: "pageview", path: "/jobs", count: 1 },
    ]);
  });

  test("retention removes raw rows older than 90 days only after they are rolled up", () => {
    const now = Date.UTC(2026, 6, 12, 12);
    const oldTs = now - 91 * DAY_MS;
    const db = getDashboardDb()!;
    db.query("INSERT INTO usage_events (id, tenant_id, ts, event_type, path) VALUES ('old', 'mimule', ?, 'pageview', '/old')").run(oldTs);
    db.query("INSERT INTO usage_events (id, tenant_id, ts, event_type, path) VALUES ('recent', 'mimule', ?, 'pageview', '/recent')").run(now - 89 * DAY_MS);
    db.query("INSERT INTO usage_daily (day, tenant_id, event_type, path, count) VALUES ('2020-01-01', 'mimule', 'pageview', '/forever', 7)").run();

    rollupUsageDaily(now);
    expect(sweepUsageRetention(now)).toBe(1);

    expect(db.query("SELECT id FROM usage_events ORDER BY id").all()).toEqual([{ id: "recent" }]);
    expect(db.query("SELECT count FROM usage_daily WHERE path = '/old'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count FROM usage_daily WHERE path = '/forever'").get()).toEqual({ count: 7 });
  });

  test("summarizes pageviews and actions per path with totals", () => {
    const db = getDashboardDb()!;
    const insert = db.query("INSERT INTO usage_daily (day, tenant_id, event_type, path, count) VALUES (?, 'mimule', ?, ?, ?)");
    insert.run("2026-07-01", "pageview", "/models", 5);
    insert.run("2026-07-02", "pageview", "/models", 2);
    insert.run("2026-07-02", "action", "/models", 3);
    insert.run("2026-07-03", "action", "jobs.retry", 4);
    insert.run("2026-06-01", "pageview", "/outside", 99);

    expect(getUsageSummary("2026-07-01", "2026-07-03")).toEqual({
      from: "2026-07-01",
      to: "2026-07-03",
      paths: [
        { path: "/models", pageviews: 7, actions: 3 },
        { path: "jobs.retry", pageviews: 0, actions: 4 },
      ],
      totals: { pageviews: 7, actions: 7 },
    });
  });

  test("summarizes module usage with findings attribution, key union, totals, and earns-its-keep ordering", () => {
    const db = getDashboardDb()!;
    db.exec("ALTER TABLE insights ADD COLUMN updated_at INTEGER");
    const insertUsage = db.query("INSERT INTO usage_daily (day, tenant_id, event_type, path, count) VALUES (?, ?, ?, ?, ?)");
    insertUsage.run("2026-07-01", "mimule", "pageview", "/models", 8);
    insertUsage.run("2026-07-01", "mimule", "action", "/models", 4);
    insertUsage.run("2026-07-02", "mimule", "pageview", "/insights", 12);
    insertUsage.run("2026-07-02", "mimule", "action", "/insights", 4);
    insertUsage.run("2026-07-02", "mimule", "pageview", "/usage-only", 20);
    insertUsage.run("2026-07-02", "other", "action", "/models", 99);
    insertUsage.run("2026-06-30", "mimule", "action", "/outside", 99);

    const insertInsight = db.query(`
      INSERT INTO insights (
        id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
        manual_page_href, status, tenant_id, created_at, resolved_at, updated_at
      ) VALUES (?, 'ops', 'medium', ?, 'summary', 0.9, '[]', ?, ?, ?, ?, ?, ?)
    `);
    const inPeriod = Date.parse("2026-07-02T12:00:00.000Z");
    insertInsight.run("applied-insights", "Applied insight", "/insights?tab=open#finding", "applied", "mimule", inPeriod, null, inPeriod);
    insertInsight.run("resolved-insights", "Resolved insight", "/insights", "resolved", "mimule", inPeriod, inPeriod + 1, inPeriod + 2);
    insertInsight.run("findings-only", "Finding only", "/incidents?view=all", "resolved", "mimule", inPeriod, inPeriod, inPeriod);
    insertInsight.run("out-before", "Before period", "/models", "resolved", "mimule", inPeriod, Date.parse("2026-06-30T23:59:59.999Z"), inPeriod);
    insertInsight.run("out-at-end", "At exclusive end", "/models", "resolved", "mimule", inPeriod, null, Date.parse("2026-07-03T00:00:00.000Z"));
    insertInsight.run("still-open", "Still open", "/models", "open", "mimule", inPeriod, null, inPeriod);
    insertInsight.run("other-tenant", "Other tenant", "/models", "resolved", "other", inPeriod, inPeriod, inPeriod);

    expect(getModuleUsage("2026-07-01", "2026-07-03")).toEqual({
      from: "2026-07-01",
      to: "2026-07-03",
      modules: [
        { path: "/insights", pageviews: 12, actions: 4, findingsActedOn: 2 },
        { path: "/models", pageviews: 8, actions: 4, findingsActedOn: 0 },
        { path: "/incidents", pageviews: 0, actions: 0, findingsActedOn: 1 },
        { path: "/usage-only", pageviews: 20, actions: 0, findingsActedOn: 0 },
      ],
      totals: { pageviews: 40, actions: 8, findingsActedOn: 3 },
    });
  });

  test("returns honest zero module usage for an empty database", () => {
    expect(getModuleUsage("2026-07-01", "2026-07-03")).toEqual({
      from: "2026-07-01",
      to: "2026-07-03",
      modules: [],
      totals: { pageviews: 0, actions: 0, findingsActedOn: 0 },
    });
  });

  test("API records beacons, returns summaries, and rejects unauthenticated requests", async () => {
    const beaconUrl = new URL("http://127.0.0.1:3000/api/usage/beacon");
    const anonymousPost = await handleApi(new Request(beaconUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ path: "/anonymous" }] }),
    }), beaconUrl);
    expect(anonymousPost.status).toBe(401);

    const post = await handleApi(authenticatedRequest("/api/usage/beacon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ path: "/models?tab=all" }] }),
    }), beaconUrl);
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ recorded: 1 });
    expect(getDashboardDb()!.query("SELECT COUNT(*) AS count FROM action_audit").get()).toEqual({ count: 0 });

    rollupUsageDaily(Date.now());
    const summaryUrl = new URL("http://127.0.0.1:3000/api/usage/summary");
    const anonymousGet = await handleApi(new Request(summaryUrl), summaryUrl);
    expect(anonymousGet.status).toBe(401);

    const get = await handleApi(authenticatedRequest("/api/usage/summary"), summaryUrl);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      paths: [{ path: "/models", pageviews: 1, actions: 0 }],
      totals: { pageviews: 1, actions: 0 },
    });
  });

  test("module usage API returns data and rejects bad or unauthenticated requests", async () => {
    const db = getDashboardDb()!;
    db.query("INSERT INTO usage_daily (day, tenant_id, event_type, path, count) VALUES ('2026-07-02', 'mimule', 'pageview', '/reports', 3)").run();

    const modulesUrl = new URL("http://127.0.0.1:3000/api/usage/modules?from=2026-07-01&to=2026-07-03");
    const anonymous = await handleApi(new Request(modulesUrl), modulesUrl);
    expect(anonymous.status).toBe(401);

    const response = await handleApi(authenticatedRequest("/api/usage/modules?from=2026-07-01&to=2026-07-03"), modulesUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      from: "2026-07-01",
      to: "2026-07-03",
      modules: [{ path: "/reports", pageviews: 3, actions: 0, findingsActedOn: 0 }],
      totals: { pageviews: 3, actions: 0, findingsActedOn: 0 },
    });

    const badUrl = new URL("http://127.0.0.1:3000/api/usage/modules?from=not-a-date&to=2026-07-03");
    const bad = await handleApi(authenticatedRequest("/api/usage/modules?from=not-a-date&to=2026-07-03"), badUrl);
    expect(bad.status).toBe(400);
  });
});
