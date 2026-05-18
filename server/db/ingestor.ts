import { buildHomeData } from "../api/home.ts";
import { getLiteLLMHealthProbe } from "../api/litellm.ts";
import type { HomeData, SourceStatus } from "../api/types.ts";
import { isDashboardDbEnabled } from "./dashboard.ts";
import { runHomeSampler } from "./sampler.ts";
import { redactForDashboard, writeChannelLog, writeMetricSample } from "./writer.ts";

export type IngestorController = { stop(): void; tick(): Promise<void> };

type BuildHomeDataResult = { data: HomeData; sources: Record<string, SourceStatus> };
type ChannelLogReader = (sinceMs: number) => Promise<string[]>;

let buildHomeDataImpl: () => Promise<BuildHomeDataResult> = buildHomeData;
let liteLLMHealthProbeImpl: typeof getLiteLLMHealthProbe = getLiteLLMHealthProbe;
let channelLogReaderImpl: ChannelLogReader = readOpenClawGatewayLogs;
const seenChannelLogFingerprints = new Set<string>();

export function setBuildHomeDataForTests(fn: typeof buildHomeDataImpl): void {
  buildHomeDataImpl = fn;
}

export function setLiteLLMHealthProbeForTests(fn: typeof liteLLMHealthProbeImpl): void {
  liteLLMHealthProbeImpl = fn;
}

export function setChannelLogReaderForTests(fn: ChannelLogReader): void {
  channelLogReaderImpl = fn;
  seenChannelLogFingerprints.clear();
}

export function parseTelegramChannelLogLine(line: string, fallbackTs = Date.now()): {
  ts: number;
  channel: "telegram";
  direction: "in" | "out" | "event";
  summary: string;
  payload: unknown;
} | null {
  const lower = line.toLowerCase();
  const isTelegramLine = /telegram|paperclip-telegram|callback_query|morning[- ]brief/.test(lower);
  if (!isTelegramLine) {
    return null;
  }

  const timestampMatch = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
  const parsedTs = timestampMatch ? Date.parse(timestampMatch[0].replace(" ", "T")) : Number.NaN;
  const direction = /send|sent|deliver|outbound|to telegram/.test(lower)
    ? "out"
    : /receive|received|incoming|inbound|callback_query|from telegram|update/.test(lower)
      ? "in"
      : "event";
  const redacted = redactForDashboard(line).replace(/\s+/g, " ").trim();

  return {
    ts: Number.isFinite(parsedTs) ? parsedTs : fallbackTs,
    channel: "telegram",
    direction,
    summary: redacted.slice(0, 240),
    payload: { source: "openclaw_gateway", raw: redacted },
  };
}

async function readOpenClawGatewayLogs(sinceMs: number): Promise<string[]> {
  const container = process.env.DASHBOARD_CHANNELS_CONTAINER || "openclaw_gateway";
  const sinceSeconds = Math.max(1, Math.ceil(sinceMs / 1000));
  const proc = Bun.spawn(["docker", "logs", "--since", `${sinceSeconds}s`, "--tail", "200", container], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const message = stderr.trim();
    if (message && !/No such container|Cannot connect to the Docker daemon/i.test(message)) {
      console.warn("[ingestor] channels log probe failed", message);
    }
    return [];
  }

  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

async function sampleChannelLogs(sinceMs: number): Promise<void> {
  if (process.env.DASHBOARD_CHANNELS_LOG_ENABLED === "0") {
    return;
  }

  try {
    const lines = await channelLogReaderImpl(sinceMs);
    const now = Date.now();
    for (const line of lines) {
      const entry = parseTelegramChannelLogLine(line, now);
      if (!entry) {
        continue;
      }

      const fingerprint = `${entry.ts}:${entry.direction}:${entry.summary}`;
      if (seenChannelLogFingerprints.has(fingerprint)) {
        continue;
      }
      seenChannelLogFingerprints.add(fingerprint);
      if (seenChannelLogFingerprints.size > 500) {
        seenChannelLogFingerprints.delete(seenChannelLogFingerprints.values().next().value);
      }

      writeChannelLog(entry);
    }
  } catch (err) {
    console.error("[ingestor] channels log probe failed", err);
  }
}

export function startIngestor(
  options: { intervalMs?: number; litellmProbeIntervalMs?: number; channelsProbeIntervalMs?: number } = {},
): IngestorController | null {
  if (!isDashboardDbEnabled()) {
    return null;
  }

  const intervalMs = options.intervalMs ?? (Number(process.env.DASHBOARD_INGESTOR_INTERVAL_MS) || 30_000);
  const litellmProbeIntervalMs = options.litellmProbeIntervalMs ?? 60_000;
  const channelsProbeIntervalMs = options.channelsProbeIntervalMs ?? 60_000;
  const channelsInitialLookbackMs = Number(process.env.DASHBOARD_CHANNELS_INITIAL_LOOKBACK_MS) || 600_000;
  let lastLiteLLMProbeAt = 0;
  let lastChannelsProbeAt = Date.now() - channelsInitialLookbackMs;
  let stopped = false;
  let inFlight = false;

  async function sampleLiteLLMHealth(): Promise<void> {
    try {
      const probe = await liteLLMHealthProbeImpl();
      writeMetricSample({ source: "litellm", key: "health", value: probe });
    } catch (err) {
      console.error("[ingestor] litellm health probe failed", err);
      writeMetricSample({
        source: "litellm",
        key: "health",
        value: {
          reachable: false,
          healthOk: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const { data } = await buildHomeDataImpl();
      runHomeSampler(data);
      const now = Date.now();
      if (now - lastLiteLLMProbeAt >= litellmProbeIntervalMs) {
        lastLiteLLMProbeAt = now;
        await sampleLiteLLMHealth();
      }
      if (now - lastChannelsProbeAt >= channelsProbeIntervalMs) {
        const sinceMs = now - lastChannelsProbeAt + 1000;
        lastChannelsProbeAt = now;
        await sampleChannelLogs(sinceMs);
      }
    } catch (err) {
      console.error("[ingestor] tick failed", err);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}
