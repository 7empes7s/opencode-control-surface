import { readFileSync } from "node:fs";

// Written every 30 min by the Product Health Sentinel (mimule-product-sentinel.py),
// which probes the LIVE product (pages, APIs, data freshness, deploy consistency,
// invariants) and auto-enqueues deduped fix jobs. This surfaces that scorecard
// in-product so health is visible on the dashboard, not discovered on a phone.
const HEALTH_PATH = "/var/lib/mimule/product-health.json";

export function productHealthHandler(): Response {
  try {
    const raw = JSON.parse(readFileSync(HEALTH_PATH, "utf8"));
    return Response.json(raw);
  } catch {
    return Response.json({
      score: null, fails: 0, warns: 0, findings: [],
      checkedAtISO: null, error: "sentinel has not run yet",
    });
  }
}
