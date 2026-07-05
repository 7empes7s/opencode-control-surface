import { describe, expect, test } from "bun:test";
import {
  approachingWindowMs,
  computeSlaDueAt,
  parseSeverityFromTitle,
  slaWindowMsForTitle,
  SLA_WINDOW_MS,
} from "./sla.ts";

describe("SLA window constants", () => {
  test("critical=4h, high=24h, medium=72h, default=7d", () => {
    expect(SLA_WINDOW_MS.critical).toBe(4 * 60 * 60 * 1000);
    expect(SLA_WINDOW_MS.high).toBe(24 * 60 * 60 * 1000);
    expect(SLA_WINDOW_MS.medium).toBe(72 * 60 * 60 * 1000);
    expect(SLA_WINDOW_MS.default).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("parseSeverityFromTitle", () => {
  test("parses the standard [<severity>/<confidence-or-rank>] prefix", () => {
    expect(parseSeverityFromTitle("[critical/high] Home page down")).toBe("critical");
    expect(parseSeverityFromTitle("[high/medium] litellm.service is down")).toBe("high");
    expect(parseSeverityFromTitle("[medium/high] Data freshness lagging")).toBe("medium");
  });

  test("is case-insensitive", () => {
    expect(parseSeverityFromTitle("[CRITICAL/HIGH] Home page down")).toBe("critical");
    expect(parseSeverityFromTitle("[High/Medium] Something")).toBe("high");
  });

  test("falls back to default for an unrecognized severity token", () => {
    expect(parseSeverityFromTitle("[low/medium] Some minor thing")).toBe("default");
  });

  test("falls back to default for a title with no bracket prefix at all (unparsable)", () => {
    expect(parseSeverityFromTitle("TypeScript compilation failed")).toBe("default");
    expect(parseSeverityFromTitle("")).toBe("default");
  });

  test("falls back to default for a malformed bracket prefix", () => {
    expect(parseSeverityFromTitle("critical/high] Home page down")).toBe("default");
    expect(parseSeverityFromTitle("[criticalhigh] Home page down")).toBe("default");
  });
});

describe("slaWindowMsForTitle / computeSlaDueAt", () => {
  test("resolves the window from the title's severity", () => {
    expect(slaWindowMsForTitle("[critical/high] x")).toBe(4 * 60 * 60 * 1000);
    expect(slaWindowMsForTitle("[high/medium] x")).toBe(24 * 60 * 60 * 1000);
    expect(slaWindowMsForTitle("[medium/high] x")).toBe(72 * 60 * 60 * 1000);
    expect(slaWindowMsForTitle("no severity prefix here")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("computeSlaDueAt = first_seen + window(severity)", () => {
    const firstSeen = 1_000_000;
    expect(computeSlaDueAt("[critical/high] x", firstSeen)).toBe(firstSeen + 4 * 60 * 60 * 1000);
    expect(computeSlaDueAt("[high/medium] x", firstSeen)).toBe(firstSeen + 24 * 60 * 60 * 1000);
    expect(computeSlaDueAt("[medium/high] x", firstSeen)).toBe(firstSeen + 72 * 60 * 60 * 1000);
    expect(computeSlaDueAt("unparsable title", firstSeen)).toBe(firstSeen + 7 * 24 * 60 * 60 * 1000);
  });
});

describe("approachingWindowMs", () => {
  test("is 25% of the window for critical/high (well under the 6h cap)", () => {
    expect(approachingWindowMs("[critical/high] x")).toBe(1 * 60 * 60 * 1000);
    expect(approachingWindowMs("[high/medium] x")).toBe(6 * 60 * 60 * 1000);
  });

  test("is capped at 6h for medium and default windows, which would otherwise exceed it", () => {
    // medium: 72h * 0.25 = 18h, capped to 6h
    expect(approachingWindowMs("[medium/high] x")).toBe(6 * 60 * 60 * 1000);
    // default: 7d * 0.25 = 42h, capped to 6h
    expect(approachingWindowMs("no prefix")).toBe(6 * 60 * 60 * 1000);
  });
});
