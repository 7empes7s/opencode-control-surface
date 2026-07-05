// SLA windows for reasoner/sentinel incidents (ULTRAPLAN P2.3).
//
// Severity is parsed from the existing title-prefix convention
// "[<severity>/<confidence-or-rank>]" that sentinelIncidents.ts already writes
// (e.g. "[high/medium] Home page down"). Incidents whose title doesn't carry
// that prefix (e.g. reasoner/clustering.ts's rootCauseHypothesis-derived
// titles) fall back to the widest "default" window rather than inventing a
// severity that was never recorded.
//
// These are fixed constants for now. ULTRAPLAN T2 will introduce a rules
// engine allowing per-tenant/per-failure-class SLA overrides — do NOT build a
// config UI for this ahead of that; this module is the single place both the
// migration backfill (server/db/dashboard.ts) and the detector
// (server/insights/scanners/sla.ts) read from, so the two can never drift.

export type SlaSeverityBucket = "critical" | "high" | "medium" | "default";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const SLA_WINDOW_MS: Record<SlaSeverityBucket, number> = {
  critical: 4 * HOUR_MS,
  high: 24 * HOUR_MS,
  medium: 72 * HOUR_MS,
  default: 7 * DAY_MS,
};

// Approaching-SLA warning window: 25% of the incident's total window,
// capped at 6h so even a 7-day "default" window doesn't warn nearly two days
// early.
const APPROACHING_FRACTION = 0.25;
const APPROACHING_CAP_MS = 6 * HOUR_MS;

const TITLE_SEVERITY_PREFIX = /^\[\s*([a-z]+)\s*\/[^\]]*]/i;

// Extracts the severity token from a "[<severity>/<confidence-or-rank>] ..."
// title prefix. Returns "default" for anything unparsable or not one of the
// three known severities — never guesses.
export function parseSeverityFromTitle(title: string): SlaSeverityBucket {
  const match = TITLE_SEVERITY_PREFIX.exec(String(title ?? "").trim());
  const raw = match?.[1]?.toLowerCase();
  if (raw === "critical" || raw === "high" || raw === "medium") return raw;
  return "default";
}

export function slaWindowMsForTitle(title: string): number {
  return SLA_WINDOW_MS[parseSeverityFromTitle(title)];
}

// resolve-by deadline = first_seen + window(severity). Acknowledging does NOT
// stop this clock — resolve-by semantics, not ack-by.
export function computeSlaDueAt(title: string, firstSeenMs: number): number {
  return firstSeenMs + slaWindowMsForTitle(title);
}

export function approachingWindowMs(title: string): number {
  return Math.min(slaWindowMsForTitle(title) * APPROACHING_FRACTION, APPROACHING_CAP_MS);
}
