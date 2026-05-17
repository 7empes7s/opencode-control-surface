import { readOperatorState, writeOperatorState } from "../db/writer.ts";
import { getActiveLicense } from "../licensing/index.ts";
import { TelemetryPayload } from "./types.ts";

export function collectTelemetryPayload(): TelemetryPayload {
  const telemetry = readOperatorState("builder_telemetry") as Record<string, unknown> ?? {};

  const runCount = ((telemetry.builderRunCount as number) ?? 0);
  const passSuccess = ((telemetry.builderPassSuccess as number) ?? 0);
  const passFail = ((telemetry.builderPassFail as number) ?? 0);
  const total = passSuccess + passFail;
  const successRate = total > 0 ? passSuccess / total : 0;
  const failRate = total > 0 ? passFail / total : 0;

  const rawHistogram = (telemetry.modelUsageHistogram as Record<string, number>) ?? {};
  const modelUsageHistogram: Record<string, number> = {};
  for (const [model, count] of Object.entries(rawHistogram)) {
    modelUsageHistogram[model] = typeof count === "number" ? count : 0;
  }

  return {
    events: [],
    runCount,
    passSuccessRate: successRate,
    passFailRate: failRate,
    modelUsageHistogram,
    shippedAt: new Date().toISOString(),
  };
}

export async function shipTelemetry(endpoint: string): Promise<void> {
  const consent = getTelemetryConsent();
  if (!consent) return;

  const payload = collectTelemetryPayload();

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // no-op on network errors
  }
}

export function getTelemetryConsent(): boolean {
  const consent = readOperatorState("telemetryConsent");
  return consent === true;
}

export function setTelemetryConsent(consent: boolean): void {
  writeOperatorState("telemetryConsent", consent);
}