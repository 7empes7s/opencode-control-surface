// Deep mobile geometry probe: finds clipped/overlapping content that
// scrollWidth-based overflow checks miss (masked by overflow-x:hidden).
// Authenticated via QA_TOKEN env var. Run: QA_TOKEN=... bun scripts/qa-mobile-deep.mjs
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

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
});

if (process.env.QA_TOKEN) {
  const res = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: process.env.QA_TOKEN }),
  });
  if (!res.ok) { console.error(`AUTH FAILED ${res.status}`); process.exit(2); }
  const m = (res.headers.get("set-cookie") ?? "").match(/operator_session=([^;]+)/);
  await context.addCookies([{ name: "operator_session", value: m[1], url: BASE }]);
}

const results = [];
for (const route of ROUTES) {
  const page = await context.newPage();
  try {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2800);
    const r = await page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const vis = (el) => {
        const cs = getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0;
      };
      const label = (el) => {
        const cls = String(el.className?.baseVal ?? el.className ?? "").split(" ").filter(Boolean).slice(0, 3).join(".");
        return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`.slice(0, 80);
      };
      // 1. Elements clipped past the right/left viewport edge (regardless of scrollWidth)
      const clipped = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // ignore elements inside horizontally-scrollable containers (legit inner scroll)
        let p = el.parentElement, innerScroll = false;
        while (p) {
          if (p.scrollWidth > p.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(p).overflowX)) { innerScroll = true; break; }
          p = p.parentElement;
        }
        if (innerScroll) continue;
        if (r.right > vw + 2 || r.left < -2) {
          clipped.push({ el: label(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
          if (clipped.length >= 10) break;
        }
      }
      // 2. Fixed/sticky bars and whether page content slides under them
      const bars = [];
      for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.5) continue; // only full-width bars matter
        bars.push({ el: label(el), pos: cs.position, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) });
        if (bars.length >= 8) break;
      }
      // 3. Content obscured by a bottom bar: last meaningful content bottom vs bar top
      const bottomBars = bars.filter((b) => b.bottom > vh - 2 && b.h > 30);
      let obscured = null;
      if (bottomBars.length) {
        const main = document.querySelector("main") ?? document.body;
        const kids = [...main.querySelectorAll("*")].filter((el) => {
          if (!vis(el)) return false;
          const r = el.getBoundingClientRect();
          return r.height > 8 && r.height < vh && r.width > vw * 0.4;
        });
        const lowest = kids.reduce((a, el) => Math.max(a, el.getBoundingClientRect().bottom), 0);
        const barTop = Math.min(...bottomBars.map((b) => b.top));
        // only count if the page isn't scrollable past it (i.e. padding-bottom missing at document end)
        const doc = document.documentElement;
        const atEndScrollable = doc.scrollHeight - (barTop + window.scrollY);
        if (lowest > barTop + 4) {
          obscured = { lowestContentBottom: Math.round(lowest), barTop: Math.round(barTop), overlapPx: Math.round(lowest - barTop), bar: bottomBars[0].el };
        }
      }
      // 4. Inner horizontal scrollers (tables etc.) — informational
      const innerScrollers = [];
      for (const el of document.querySelectorAll("body *")) {
        if (el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) {
          innerScrollers.push({ el: label(el), clientW: el.clientWidth, scrollW: el.scrollWidth });
          if (innerScrollers.length >= 6) break;
        }
      }
      // 5. Root overflow policy
      const bodyCS = getComputedStyle(document.body);
      const htmlCS = getComputedStyle(document.documentElement);
      return {
        clipped, bars, obscured, innerScrollers,
        overflowPolicy: `html:${htmlCS.overflowX} body:${bodyCS.overflowX}`,
        scrollH: document.documentElement.scrollHeight, vh,
      };
    });
    results.push({ route, ...r });
  } catch (e) {
    results.push({ route, error: String(e).slice(0, 200) });
  }
  await page.close();
}
await browser.close();
writeFileSync(OUT + "mobile-deep.json", JSON.stringify(results, null, 2));

for (const r of results) {
  const flags = [];
  if (r.error) flags.push("ERR");
  if (r.clipped?.length) flags.push(`CLIPPED:${r.clipped.length}`);
  if (r.obscured) flags.push(`OBSCURED:+${r.obscured.overlapPx}px by ${r.obscured.bar}`);
  if (r.innerScrollers?.length) flags.push(`INNERSCROLL:${r.innerScrollers.length}`);
  if (flags.length) console.log(`${r.route.padEnd(18)} ${flags.join("  ")}`);
}
console.log(`\nDone → ${OUT}mobile-deep.json`);
