import { buildHomeData } from "../api/home.ts";
import type { HomeData, SourceStatus } from "../api/types.ts";
import { isDashboardDbEnabled } from "./dashboard.ts";
import { runHomeSampler } from "./sampler.ts";

export type IngestorController = { stop(): void; tick(): Promise<void> };

type BuildHomeDataResult = { data: HomeData; sources: Record<string, SourceStatus> };

let buildHomeDataImpl: () => Promise<BuildHomeDataResult> = buildHomeData;

export function setBuildHomeDataForTests(fn: typeof buildHomeDataImpl): void {
  buildHomeDataImpl = fn;
}

export function startIngestor(options: { intervalMs?: number } = {}): IngestorController | null {
  if (!isDashboardDbEnabled()) {
    return null;
  }

  const intervalMs = options.intervalMs ?? (Number(process.env.DASHBOARD_INGESTOR_INTERVAL_MS) || 30_000);
  let stopped = false;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const { data } = await buildHomeDataImpl();
      runHomeSampler(data);
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
