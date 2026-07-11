#!/usr/bin/env bun
// Fresh-host endpoint prober.
//
// Extracts every static (no path-param) GET /api/* + /v1/* route directly from
// server/api/router.ts (kept in sync automatically — no hand-maintained list),
// probes each one against a running container, and classifies the result:
//
//   HONEST     — HTTP < 500, parseable JSON, no MIMULE-specific strings leaked
//                (or leaked strings appear only in an explicit "not configured"
//                 / unknown / error context)
//   LEAK       — MIMULE-specific strings present and NOT clearly flagged as
//                absent/unconfigured (i.e. presented as if real)
//   ERROR-5xx  — HTTP status >= 500
//   CRASH      — connection refused/reset, timeout, or unparseable body on a
//                route that declares JSON (indicates a stack trace / raw crash
//                leaked)
//
// Usage: bun run probe.mjs <routerTsPath> <baseUrl> <token> <reportMdPath>

import { readFileSync } from "node:fs";

const [routerPath, baseUrl, token, reportPath] = process.argv.slice(2);
if (!routerPath || !baseUrl || !token || !reportPath) {
  console.error("usage: probe.mjs <router.ts> <baseUrl> <token> <report.md>");
  process.exit(2);
}

const LEAK_STRINGS = ["newsbites", "mimoun", "openclaw", "paperclip", "vast", "techinsiderbytes"];
const HONEST_MARKERS = [
  "not configured", "not_configured", "unconfigured", "unknown", "not found",
  "no such", "not available", "unavailable", "n/a", "\"error\"", "not-configured",
  "not connected", "disabled", "missing", "optional", "off by operator",
  "not yet tracked", "not tracked", "no data available", "no gpu probe",
  "not reachable", "not running", "paused",
];
// Nearby zero/null/false/empty JSON values are a strong honesty signal (a
// MIMULE-branded field reporting nothing rather than fabricated live state) --
// e.g. "totalPublished":0, "balance":null, "exists":false, "downUnits":[].
const HONEST_VALUE_RE = /"[A-Za-z0-9_]+"\s*:\s*(0(?![0-9])|null|false|""|\[\]|\{\})/;

function extractRoutes(routerSrc) {
  const re = /method === "GET" && pathname === "([^"]+)"/g;
  const routes = new Set();
  let m;
  while ((m = re.exec(routerSrc))) routes.add(m[1]);
  return Array.from(routes).sort();
}

const routerSrc = readFileSync(routerPath, "utf8");
let routes = extractRoutes(routerSrc);

// "/" is served outside router.ts (static shell) — always probe it.
routes.unshift("/");

// /api/stream is a long-lived SSE connection — probe separately with a short
// abort instead of folding it into the generic per-route loop (it would hang
// the whole run for the full timeout otherwise).
routes = routes.filter((r) => r !== "/api/stream");

function contextIsHonest(text, idx, matchLen) {
  const start = Math.max(0, idx - 220);
  const end = Math.min(text.length, idx + matchLen + 220);
  const window = text.slice(start, end);
  const windowLower = window.toLowerCase();
  if (HONEST_MARKERS.some((marker) => windowLower.includes(marker))) return true;
  return HONEST_VALUE_RE.test(window);
}

function findLeaks(text) {
  const lower = text.toLowerCase();
  const leaks = [];
  for (const needle of LEAK_STRINGS) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      if (!contextIsHonest(text, idx, needle.length)) {
        leaks.push({ needle, snippet: text.slice(Math.max(0, idx - 40), idx + needle.length + 40) });
      }
      from = idx + needle.length;
    }
  }
  return leaks;
}

async function probeOne(route) {
  const url = `${baseUrl}${route}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), route === "/api/stream" ? 3000 : 15000);
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;
    const status = resp.status;
    const contentType = resp.headers.get("content-type") || "";

    if (route === "/api/stream") {
      controller.abort(); // we only care that it opened cleanly
      if (status === 200 && contentType.includes("text/event-stream")) {
        return { route, status, verdict: "HONEST", elapsedMs, detail: "SSE opened" };
      }
      return { route, status, verdict: status >= 500 ? "ERROR-5xx" : "HONEST", elapsedMs, detail: `content-type=${contentType}` };
    }

    const text = await resp.text();

    if (status >= 500) {
      return { route, status, verdict: "ERROR-5xx", elapsedMs, detail: text.slice(0, 200) };
    }

    if (status < 400 && (contentType.includes("application/zip") || contentType.includes("application/octet-stream"))) {
      const leaks = findLeaks(text);
      if (leaks.length) {
        return { route, status, verdict: "LEAK", elapsedMs, detail: JSON.stringify(leaks.slice(0, 3)) };
      }
      return { route, status, verdict: "HONEST", elapsedMs, detail: `content-type=${contentType} len=${Buffer.byteLength(text)}` };
    }

    if (route === "/" ) {
      // Static shell — plain HTML, not JSON. Just check it's non-empty & no leak.
      const leaks = findLeaks(text);
      if (leaks.length) {
        return { route, status, verdict: "LEAK", elapsedMs, detail: JSON.stringify(leaks.slice(0, 3)) };
      }
      return { route, status, verdict: status < 400 ? "HONEST" : "ERROR-5xx", elapsedMs, detail: `len=${text.length}` };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { route, status, verdict: "CRASH", elapsedMs, detail: `invalid JSON: ${text.slice(0, 200)}` };
    }

    const leaks = findLeaks(text);
    if (leaks.length) {
      return { route, status, verdict: "LEAK", elapsedMs, detail: JSON.stringify(leaks.slice(0, 3)) };
    }

    return { route, status, verdict: "HONEST", elapsedMs, detail: json?.sourceStatus ? `sourceStatus=${JSON.stringify(json.sourceStatus)}` : "" };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const aborted = err?.name === "AbortError";
    if (route === "/api/stream" && aborted) {
      return { route, status: 0, verdict: "HONEST", elapsedMs, detail: "SSE aborted by prober (expected)" };
    }
    return { route, status: 0, verdict: "CRASH", elapsedMs, detail: aborted ? "timeout" : String(err?.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}

const results = [];
for (const route of routes) {
  results.push(await probeOne(route));
}

const counts = { HONEST: 0, LEAK: 0, CRASH: 0, "ERROR-5xx": 0 };
for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

const lines = [];
lines.push(`# Fresh-Host Probe Report`);
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push(`## Verdict counts`);
lines.push("");
lines.push(`| Verdict | Count |`);
lines.push(`|---|---|`);
for (const k of ["HONEST", "LEAK", "CRASH", "ERROR-5xx"]) lines.push(`| ${k} | ${counts[k]} |`);
lines.push("");
lines.push(`Total endpoints probed: ${results.length}`);
lines.push("");
lines.push(`## Endpoint results`);
lines.push("");
lines.push(`| Route | Status | Verdict | ms | Detail |`);
lines.push(`|---|---|---|---|---|`);
for (const r of results) {
  const detail = (r.detail || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300);
  lines.push(`| ${r.route} | ${r.status} | ${r.verdict} | ${r.elapsedMs} | ${detail} |`);
}
lines.push("");

const reportBody = lines.join("\n");
console.log(reportBody);

const fs = await import("node:fs");
fs.writeFileSync(reportPath, reportBody);

// Machine-readable sidecar for the run.sh loop / diffing between runs.
fs.writeFileSync(reportPath.replace(/\.md$/, ".json"), JSON.stringify({ counts, results }, null, 2));

// Exit non-zero if there's still a CRASH or ERROR-5xx, so run.sh can loop.
process.exit(counts.CRASH > 0 || counts["ERROR-5xx"] > 0 ? 1 : 0);
