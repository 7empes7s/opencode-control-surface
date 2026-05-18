import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { writeChannelLog } from "../db/writer.ts";
import {
  channelsBriefPreviewHandler,
  channelsBriefSendHandler,
  channelsHandler,
  notificationRulesHandler,
  notificationRuleUpsertHandler,
} from "./channels.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousBriefScriptPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "channels-api-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousBriefScriptPath = process.env.NEWSBITES_BRIEF_SCRIPT_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  if (previousBriefScriptPath === undefined) delete process.env.NEWSBITES_BRIEF_SCRIPT_PATH;
  else process.env.NEWSBITES_BRIEF_SCRIPT_PATH = previousBriefScriptPath;
  rmSync(tempDir, { recursive: true, force: true });
});

async function readJson(response: Response): Promise<any> {
  return response.json();
}

test("channels API returns recent channel log entries", async () => {
  writeChannelLog({
    ts: 10,
    direction: "out",
    summary: "Telegram sent alert",
    payload: { delivery: "ok" },
  });

  const data = await readJson(channelsHandler(new URL("http://localhost/api/channels?limit=10")));

  expect(data.data.degraded).toBe(false);
  expect(data.data.entries).toHaveLength(1);
  expect(data.data.entries[0].summary).toBe("Telegram sent alert");
  expect(data.data.entries[0].payload.delivery).toBe("ok");
});

test("notification rule API upserts rules by kind", async () => {
  const req = new Request("http://localhost/api/notifications/rules", {
    method: "POST",
    body: JSON.stringify({
      kind: "queue.approval_backlog",
      enabled: true,
      threshold: { count: 3 },
      channels: ["telegram", "dashboard"],
    }),
  });

  const created = await readJson(await notificationRuleUpsertHandler(req));
  expect(created.data.rules[0].kind).toBe("queue.approval_backlog");
  expect(created.data.rules[0].enabled).toBe(true);

  const updateReq = new Request("http://localhost/api/notifications/rules", {
    method: "POST",
    body: JSON.stringify({
      kind: "queue.approval_backlog",
      enabled: false,
      threshold: { count: 5 },
      channels: ["dashboard"],
    }),
  });
  await notificationRuleUpsertHandler(updateReq);

  const listed = await readJson(notificationRulesHandler(new URL("http://localhost/api/notifications/rules")));
  expect(listed.data.rules).toHaveLength(1);
  expect(listed.data.rules[0].enabled).toBe(false);
  expect(listed.data.rules[0].threshold.count).toBe(5);
  expect(listed.data.rules[0].channels).toEqual(["dashboard"]);
});

test("brief preview and send actions run configured script and record channel events", async () => {
  const scriptPath = join(tempDir, "brief.sh");
  writeFileSync(scriptPath, "printf '{\"mode\":\"%s\",\"items\":[\"a\"]}' \"$1\"\n");
  process.env.NEWSBITES_BRIEF_SCRIPT_PATH = scriptPath;

  const preview = await readJson(await channelsBriefPreviewHandler());
  expect(preview.ok).toBe(true);
  expect(preview.preview.mode).toBe("dry-run");

  const send = await readJson(await channelsBriefSendHandler());
  expect(send.ok).toBe(true);

  const entries = await readJson(channelsHandler(new URL("http://localhost/api/channels?limit=10")));
  expect(entries.data.entries.map((entry: { summary: string }) => entry.summary)).toContain("Previewed NewsBites Telegram brief");
  expect(entries.data.entries.map((entry: { summary: string }) => entry.summary)).toContain("Sent NewsBites Telegram brief");
});
