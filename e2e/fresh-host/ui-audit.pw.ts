import { createHmac } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { ROUTES } from "../routes";

// Fresh-host UI audit (ULTRAPLAN P0.2).
//
// Runs ONLY as the `fresh-host-ui` Playwright project (see playwright.config.ts
// — gated behind FRESH_HOST_UI=1 so a bare `bunx playwright test` never touches
// it) against the throwaway container e2e/fresh-host/run.sh boots. The API
// probe (probe.mjs) already proves every endpoint responds honestly; this
// proves the *rendered* pages do too: every route paints real content with no
// uncaught errors, no MIMULE-specific strings presented as live/real data, and
// no fake "green/active" status pill for a service that cannot exist on a
// fresh host.

const TOKEN = process.env.OPERATOR_TOKEN || "fresh-smoke-token";

function legacySessionValue(token: string): string {
  return createHmac("sha256", token)
    .update("opencode-control-surface.operator-session.v1")
    .digest("base64url");
}

// Same MIMULE-identifier catalogue as probe.mjs — a fresh host has none of
// these systems wired up, so any of these strings appearing as if they were
// live data (rather than clearly-flagged absence) is a dishonesty defect.
const LEAK_STRINGS = ["newsbites", "mimoun", "openclaw", "paperclip", "vast", "techinsiderbytes"];

// Reuse of the contextual-honesty idea from e2e/fresh-host/probe.mjs: a leak
// string is fine as long as text near it clearly reads as "this is absent /
// unconfigured / degraded", rather than presented as real live state.
const HONEST_MARKERS = [
  "not configured", "not_configured", "unconfigured", "unknown", "not found",
  "no such", "not available", "unavailable", "n/a", "not-configured",
  "not connected", "disconnected", "disabled", "missing", "optional",
  "off by operator", "not yet tracked", "not tracked", "no data available",
  "no data", "no gpu probe", "not reachable", "not running", "paused",
  "site down", "inactive", "—",
];

function contextIsHonest(window: string): boolean {
  // Block-level elements (divs, table cells, pill spans...) don't get a space
  // between them in innerText, just a newline -- normalize runs of whitespace
  // so a marker split across sibling elements (e.g. "site" / "down" in two
  // adjacent <div>s) still reads as the phrase "site down".
  const lower = window.replace(/\s+/g, " ").toLowerCase();
  return HONEST_MARKERS.some((marker) => lower.includes(marker));
}

function findLeaks(text: string): Array<{ needle: string; snippet: string }> {
  const lower = text.toLowerCase();
  const leaks: Array<{ needle: string; snippet: string }> = [];
  for (const needle of LEAK_STRINGS) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      const winStart = Math.max(0, idx - 220);
      const winEnd = Math.min(text.length, idx + needle.length + 220);
      const window = text.slice(winStart, winEnd);
      if (!contextIsHonest(window)) {
        leaks.push({ needle, snippet: text.slice(Math.max(0, idx - 60), idx + needle.length + 60).replace(/\s+/g, " ").trim() });
      }
      from = idx + needle.length;
    }
  }
  return leaks;
}

// Phrases a generic unhandled-render crash tends to surface (this app has no
// custom React error boundary component, so a real crash usually just blanks
// #root — but guard the common boundary/host-framework phrasings too). Only
// fires when the phrase basically IS the page (a real crash fallback is
// terse) -- otherwise long-form page content that legitimately discusses
// errors (agent-team transcripts, incident notes, chat history) would trip
// a false positive on a page that rendered perfectly correctly.
const ERROR_BOUNDARY_RE = /(something went wrong|application error|this page (has )?crashed|react error #|unhandled runtime error|minified react error)/i;
const ERROR_BOUNDARY_MAX_LEN = 400;

// Selectors this app actually uses to render a "green/active/ok" liveness
// signal (app/globals.css: .pill.green, .svc-pill.active, .agent-status-dot.active/.ok).
const LIVENESS_SELECTOR = ".pill.green, .svc-pill.active, .agent-status-dot.active, .agent-status-dot.ok";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{
    name: "operator_session",
    value: legacySessionValue(TOKEN),
    url: baseURL ?? "http://localhost:4600",
  }]);
});

// Scan the routed page content, not the persistent app chrome:
//  - DashSidebar (outside .dash-main) lists every page by name, including
//    "NewsBites" and "LiteLLM" -- those are this product's own page labels.
//  - DashHeader's .dash-header (inside .dash-main, but app chrome not page
//    content) repeats the current route's nav label + description ("NewsBites
//    -- Articles, deploys, site health") plus a tenant/project breadcrumb --
//    again identification, not a claim about external system state.
// None of that is a leak of live external data; only the routed page body
// (SectionCards, stat rows, tables) can actually fabricate liveness.
// Falls back to the full body for chrome-less layouts (e.g. PublicLayout's
// /status, which renders with no .dash-main at all).
async function mainContentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // innerText requires layout, so read it from the live (attached) nodes --
    // never clone-then-read, a detached clone has no computed style and
    // innerText silently comes back empty.
    const scope = (document.querySelector(".dash-main") as HTMLElement | null) ?? (document.body as HTMLElement);
    let text = scope.innerText || "";
    const header = document.querySelector(".dash-header") as HTMLElement | null;
    const headerText = header?.innerText || "";
    if (headerText) text = text.replace(headerText, "");
    return text;
  });
}

for (const route of ROUTES) {
  test(`fresh-host ui ${route}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const response = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 30_000 });
    expect(response, `no response for ${route}`).not.toBeNull();
    expect(response!.status(), `HTTP status for ${route}`).toBe(200);

    await page.waitForSelector("#root", { timeout: 10_000 });
    // Fresh SQLite DB means the first data fetch settles fast -- but the
    // gateway keeps retrying unreachable model backends in the background
    // (by design, on every page), so real networkidle may never occur. Give
    // initial fetches a short, bounded settle window rather than waiting out
    // a long timeout 41 times over.
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});

    // Uncaught exceptions are always defects.
    expect(pageErrors, `uncaught pageerror events on ${route}`).toEqual([]);

    // No blank body: #root must have rendered real content, not an empty shell.
    const text = await mainContentText(page);
    expect(text.trim().length, `blank body on ${route}`).toBeGreaterThan(0);

    // No React error boundary / crash text rendered IN PLACE of the page --
    // scoped to short bodies so a real page that legitimately discusses
    // errors at length (agent-team transcripts, incident notes) can't trip it.
    const looksLikeCrashFallback = text.length < ERROR_BOUNDARY_MAX_LEN && ERROR_BOUNDARY_RE.test(text);
    expect(looksLikeCrashFallback, `error-boundary/crash text rendered on ${route}: ${text.slice(0, 300)}`).toBe(false);

    // HONESTY: no MIMULE-specific string presented as live data.
    const leaks = findLeaks(text);
    expect(leaks, `MIMULE-string leak(s) on ${route}: ${JSON.stringify(leaks)}`).toEqual([]);

    // NO FAKE LIVENESS: no green/active/ok status pill naming a MIMULE service —
    // there are none on a fresh host, so any such pill is fabricated liveness.
    const fakeLiveness = await page.$$eval(LIVENESS_SELECTOR, (els, needles) => {
      const hits: string[] = [];
      for (const el of els) {
        const container = (el.closest("tr, li, .w-card, .section-card-body") as HTMLElement | null) ?? (el.parentElement as HTMLElement | null) ?? (el as unknown as HTMLElement);
        const ctx = (container.textContent || "").toLowerCase();
        for (const needle of needles) {
          if (ctx.includes(needle)) hits.push(`${needle}: ${(container.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160)}`);
        }
      }
      return hits;
    }, LEAK_STRINGS);
    expect(fakeLiveness, `fake green/active liveness pill for a MIMULE service on ${route}`).toEqual([]);
  });
}
