// Probe v3: measure fixed-bar geometry + end-of-scroll content overlap at 390px.
// Corrects v2's OBSCURED false positive by measuring at scroll bottom.
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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: process.env.QA_TOKEN }),
  });
  if (!res.ok) { console.error(`AUTH FAILED ${res.status}`); process.exit(2); }
  const m = (res.headers.get("set-cookie") ?? "").match(/operator_session=([^;]+)/);
  await context.addCookies([{ name: "operator_session", value: m[1], url: BASE }]);
}

const results = [];
for (const route of ROUTES) {
  const page = await context.newPage();
  let nav = null;
  for (let attempt = 0; attempt < 2 && !nav; attempt++) {
    try {
      await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 20000 });
      nav = "ok";
    } catch (e) {
      if (attempt === 1) nav = String(e).split("\n")[0].slice(0, 120);
      await page.waitForTimeout(1000);
    }
  }
  if (nav !== "ok") { results.push({ route, navError: nav }); await page.close(); continue; }
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async () => {
    const vw = innerWidth, vh = innerHeight;
    const rectOf = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { pos: cs.position, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), display: cs.display };
    };
    const bars = {
      topbar: rectOf("header.v5-topbar"),
      tabbar: rectOf("nav.v5-tabbar"),
      dock: rectOf("div.terminal-dock"),
    };
    // scroll to absolute bottom, let layout settle, then measure last content
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((res2) => setTimeout(res2, 600));
    const tabbarEl = document.querySelector("nav.v5-tabbar");
    const dockEl = document.querySelector("div.terminal-dock");
    const barTop = Math.min(
      tabbarEl ? tabbarEl.getBoundingClientRect().top : Infinity,
      dockEl && getComputedStyle(dockEl).display !== "none" ? dockEl.getBoundingClientRect().top : Infinity,
    );
    const main = document.querySelector("main") ?? document.body;
    let lowest = 0, lowestEl = "";
    for (const el of main.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.position === "fixed" || cs.position === "sticky") continue;
      const r = el.getBoundingClientRect();
      if (r.height < 8 || r.width < vw * 0.3) continue;
      if (r.bottom > lowest) { lowest = r.bottom; lowestEl = el.tagName.toLowerCase() + "." + String(el.className?.baseVal ?? el.className ?? "").split(" ")[0]; }
    }
    return {
      bars,
      endOverlapPx: Math.round(lowest - barTop),
      lowestEl: lowestEl.slice(0, 60),
      scrollH: document.documentElement.scrollHeight,
      scrollY: Math.round(window.scrollY),
    };
  });
  results.push({ route, ...r });
  await page.close();
}
await browser.close();
writeFileSync(OUT + "mobile-bars.json", JSON.stringify(results, null, 2));

console.log("route               dockBottom tabbarTop dockOverlap endOverlap lowestElement");
for (const r of results) {
  if (r.navError) { console.log(`${r.route.padEnd(18)} NAV: ${r.navError}`); continue; }
  const dockBottom = r.bars.dock?.display !== "none" ? r.bars.dock?.bottom : "-";
  const tabTop = r.bars.tabbar?.top ?? "-";
  const dockOverlap = (r.bars.dock && r.bars.tabbar && r.bars.dock.display !== "none")
    ? r.bars.dock.bottom - r.bars.tabbar.top : "-";
  console.log(`${r.route.padEnd(18)} ${String(dockBottom).padStart(10)} ${String(tabTop).padStart(10)} ${String(dockOverlap).padStart(11)} ${String(r.endOverlapPx).padStart(10)}  ${r.lowestEl}`);
}
console.log(`\nDone → ${OUT}mobile-bars.json`);
