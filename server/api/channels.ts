import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDashboardDbEnabled } from "../db/dashboard.ts";
import {
  readChannelLog,
  readNotificationRules,
  upsertNotificationRule,
  writeActionAudit,
  writeChannelLog,
  type ChannelLogRow,
  type NotificationRuleRow,
} from "../db/writer.ts";
import { ok, type ApiEnvelope } from "./types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_NEWSBITES_BRIEF_SCRIPT = "/opt/mimoun/openclaw-config/scripts/newsbites-brief.sh";

type ChannelsResponse = {
  entries: ChannelLogRow[];
  degraded: boolean;
  reason?: string;
};

type NotificationRulesResponse = {
  rules: NotificationRuleRow[];
  degraded: boolean;
  reason?: string;
};

type BriefActionResponse = {
  ok: boolean;
  message: string;
  preview?: unknown;
  output?: string;
};

function json<T>(data: T): Response {
  const envelope: ApiEnvelope<T> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 100;
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : 100;
}

function parseSince(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0;
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function actionJson(body: BriefActionResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function auditBriefAction(input: {
  actionId: string;
  mode: "preview" | "send";
  resultStatus: "success" | "failed";
  result?: string;
  error?: string;
  evidence?: unknown;
}): void {
  writeActionAudit({
    actionKind: "channels.brief",
    actionId: input.actionId,
    targetType: "channel",
    targetId: "telegram",
    risk: input.mode === "send" ? "medium" : "low",
    reason: input.mode === "send" ? "manual Telegram brief send" : "manual Telegram brief preview",
    result: input.result,
    resultStatus: input.resultStatus,
    error: input.error,
    evidence: input.evidence,
    rollbackHint: input.mode === "send" ? "Inspect Telegram delivery logs and channels_log if the message did not arrive." : undefined,
  });
}

function getBriefScriptPath(): string {
  return process.env.NEWSBITES_BRIEF_SCRIPT_PATH || DEFAULT_NEWSBITES_BRIEF_SCRIPT;
}

export function channelsHandler(url: URL): Response {
  if (!isDashboardDbEnabled()) {
    return json<ChannelsResponse>({
      entries: [],
      degraded: true,
      reason: "DASHBOARD_DB disabled",
    });
  }

  const entries = readChannelLog({
    limit: parseLimit(url.searchParams.get("limit")),
    since: parseSince(url.searchParams.get("since")),
    channel: url.searchParams.get("channel") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
  });
  return json<ChannelsResponse>({ entries, degraded: false });
}

export function notificationRulesHandler(url: URL): Response {
  if (!isDashboardDbEnabled()) {
    return json<NotificationRulesResponse>({
      rules: [],
      degraded: true,
      reason: "DASHBOARD_DB disabled",
    });
  }

  const rules = readNotificationRules({
    limit: parseLimit(url.searchParams.get("limit")),
    kind: url.searchParams.get("kind") ?? undefined,
  });
  return json<NotificationRulesResponse>({ rules, degraded: false });
}

export async function notificationRuleUpsertHandler(req: Request, id?: string): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return json<NotificationRulesResponse>({
      rules: [],
      degraded: true,
      reason: "DASHBOARD_DB disabled",
    });
  }

  const body = await req.json().catch(() => null) as {
    kind?: unknown;
    enabled?: unknown;
    threshold?: unknown;
    channels?: unknown;
  } | null;
  const kind = typeof body?.kind === "string" ? body.kind.trim() : "";
  if (!kind) {
    return badRequest("kind is required");
  }

  const rule = upsertNotificationRule({
    id: id ? Number.parseInt(id, 10) : undefined,
    kind,
    enabled: body?.enabled !== false,
    threshold: body?.threshold,
    channels: body?.channels,
  });
  if (!rule) {
    return json<NotificationRulesResponse>({
      rules: [],
      degraded: true,
      reason: "notification rule write failed",
    });
  }

  return json<NotificationRulesResponse>({ rules: [rule], degraded: false });
}

export async function channelsBriefPreviewHandler(): Promise<Response> {
  const scriptPath = getBriefScriptPath();
  try {
    const { stdout, stderr } = await execFileAsync("sh", [scriptPath, "dry-run"], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const preview = parseJsonOutput(stdout);
    writeChannelLog({
      direction: "event",
      summary: "Previewed NewsBites Telegram brief",
      payload: { mode: "dry-run", stderr: stderr.trim() || undefined },
    });
    auditBriefAction({
      actionId: "channels:telegram:brief-preview",
      mode: "preview",
      resultStatus: "success",
      result: "preview generated",
      evidence: [{ label: "Brief dry run", kind: "command", ref: `${scriptPath} dry-run` }],
    });
    return actionJson({ ok: true, message: "preview generated", preview, output: stdout.trim() });
  } catch (error) {
    const message = errorMessage(error);
    auditBriefAction({
      actionId: "channels:telegram:brief-preview",
      mode: "preview",
      resultStatus: "failed",
      error: message,
    });
    return actionJson({ ok: false, message }, 500);
  }
}

export async function channelsBriefSendHandler(): Promise<Response> {
  const scriptPath = getBriefScriptPath();
  try {
    const { stdout, stderr } = await execFileAsync("sh", [scriptPath, "run"], {
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    });
    writeChannelLog({
      direction: "out",
      summary: "Sent NewsBites Telegram brief",
      payload: { mode: "run", stdout: stdout.trim() || undefined, stderr: stderr.trim() || undefined },
    });
    auditBriefAction({
      actionId: "channels:telegram:brief-send",
      mode: "send",
      resultStatus: "success",
      result: "brief sent",
      evidence: [{ label: "Brief send", kind: "command", ref: `${scriptPath} run` }],
    });
    return actionJson({ ok: true, message: "brief sent", output: stdout.trim() });
  } catch (error) {
    const message = errorMessage(error);
    auditBriefAction({
      actionId: "channels:telegram:brief-send",
      mode: "send",
      resultStatus: "failed",
      error: message,
    });
    return actionJson({ ok: false, message }, 500);
  }
}
