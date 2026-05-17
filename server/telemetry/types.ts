export type TelemetryEvent = {
  event: string;
  version: string;
  tier: string;
  featureFlags: string[];
  anonymousId: string;
};

export type TelemetryPayload = {
  events: TelemetryEvent[];
  runCount: number;
  passSuccessRate: number;
  passFailRate: number;
  modelUsageHistogram: Record<string, number>;
  shippedAt: string;
};