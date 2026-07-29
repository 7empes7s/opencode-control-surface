// Visual/responsive QA sweep for the control-surface preview.
// Visits every route at desktop + mobile viewports, captures screenshots
// and objective layout metrics (horizontal overflow, offending elements,
// console errors). Run from repo root: bun scripts/qa-sweep.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3007";
const OUT = new URL("../shots/qa/", import.meta.url).pathname;

const ROUTES = [
  "/", "/about", "/admin", "/agents", "/agent-team", "/audit", "/autopipeline",
  "/brainstorm", "/builder", "/channels", "/claude", "/codex", "/compliance",
  "/content-health", "/cost", "/data-explorer", "/doctor", "/feature-flags",
  "/finance-intel", "/gateway", "/gemini", "/governance", "/hyperagent",
  "/incidents", "/infra", "/insights", "/install", "/jobs", "/know", "/litellm",
  "/marketplace", "/models", "/newsbites", "/opencode", "/projects", "/reports",
  "/runbooks", "/scout", "/security", "/settings", "/status", "/terminal",
  "/today", "/traces", "/workflows",
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, isMobile: false },
  { name: "mobile", width: 390, height: 844, isMobile: true },
];

const slug = (r) => (r === "/" ? "home" : r.slice(1).replaceAll("/", "_"));

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
  });
  // Authenticate once per context: exchange operator token for a session cookie.
  // (Native fetch, not context.request — playwright-core's cookie parsing breaks under Bun.)
  if (process.env.QA_TOKEN) {
    const res = await fetch(`${BASE}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: process.env.QA_TOKEN }),
    });
    if (!res.ok) {
      console.error(`AUTH FAILED (${res.status}) — aborting sweep`);
      process.exit(2);
    }
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/operator_session=([^;]+)/);
    if (!match) {
      console.error("AUTH: response had no operator_session cookie — aborting");
      process.exit(2);
    }
    await context.addCookies([{ name: "operator_session", value: match[1], url: BASE }]);
    console.log(`auth(${vp.name}): session cookie set`);
  }
  for (const route of ROUTES) {
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    let navError = null;
    try {
      await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2800); // let shell + data fetches settle
    } catch (e) {
      navError = String(e).slice(0, 200);
    }
    let metrics = {};
    try {
      metrics = await page.evaluate(() => {
        const de = document.documentElement;
        const vw = window.innerWidth;
        const overflowX = de.scrollWidth - vw;
        const offenders = [];
        if (overflowX > 1) {
          for (const el of document.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
              const cls = String(el.className?.baseVal ?? el.className ?? "").slice(0, 60);
              offenders.push({ tag: el.tagName.toLowerCase(), cls, w: Math.round(r.width), right: Math.round(r.right) });
              if (offenders.length >= 8) break;
            }
          }
        }
        // tiny tap targets (mobile relevance): visible buttons/links smaller than 24px either dimension
        let tinyTargets = 0;
        for (const el of document.querySelectorAll("button, a, [role='button']")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24)) {
            const cs = getComputedStyle(el);
            if (cs.display !== "none" && cs.visibility !== "hidden") tinyTargets++;
          }
        }
        const authPrompt = !!document.querySelector("[class*='auth'], [class*='login']") &&
          document.body.innerText.toLowerCase().includes("token");
        return {
          scrollW: de.scrollWidth, vw, overflowX,
          offenders, tinyTargets,
          bodyTextPreview: document.body.innerText.slice(0, 120),
        };
      });
    } catch (e) {
      metrics = { evalError: String(e).slice(0, 200) };
    }
    const shot = `${OUT}${slug(route)}-${vp.name}.png`;
    try {
      await page.screenshot({ path: shot, fullPage: true });
    } catch { /* screenshot failed, keep going */ }
    results.push({
      route, viewport: vp.name, navError,
      consoleErrors: consoleErrors.slice(0, 5), pageErrors: pageErrors.slice(0, 5),
      ...metrics,
    });
    await page.close();
  }
  await context.close();
}

await browser.close();
writeFileSync(OUT + "summary.json", JSON.stringify(results, null, 2));

// Compact console report: routes with overflow, JS errors, or nav failures
for (const r of results) {
  const flags = [];
  if (r.navError) flags.push(`NAV:${r.navError}`);
  if (r.overflowX > 1) flags.push(`OVERFLOW_X:+${r.overflowX}px`);
  if (r.pageErrors?.length) flags.push(`PAGEERR:${r.pageErrors.length}`);
  if (r.consoleErrors?.length) flags.push(`CONSOLE:${r.consoleErrors.length}`);
  if (flags.length) console.log(`${r.viewport.padEnd(7)} ${r.route.padEnd(18)} ${flags.join("  ")}`);
}
console.log(`\nDone. ${results.length} page-loads → ${OUT}summary.json`);
