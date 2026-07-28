// V5 visual verification — screenshots key routes at desktop + mobile widths.
// Usage: bun run scripts/v5-shots.mjs [route ...]
// Reads OPERATOR_TOKEN from /etc/control-surface/secrets.env (never printed).
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";

const BASE = process.env.SHOT_BASE || "http://127.0.0.1:3007";
const OUT = new URL("../shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const token = readFileSync("/etc/control-surface/secrets.env", "utf8")
  .split("\n").find((l) => l.startsWith("OPERATOR_TOKEN="))?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
if (!token) { console.error("no OPERATOR_TOKEN"); process.exit(1); }

const DEFAULT_ROUTES = ["/", "/autopipeline", "/models", "/incidents", "/reports", "/opencode", "/today", "/newsbites", "/infra", "/doctor"];
const routes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROUTES;

const browser = await chromium.launch();

async function newCtx(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const res = await page.request.post(`${BASE}/api/auth/session`, {
    data: { token }, headers: { "Content-Type": "application/json" },
  });
  if (!res.ok()) { console.error("auth failed", res.status()); process.exit(1); }
  return ctx;
}

for (const vp of [{ width: 1440, height: 900, tag: "desktop" }, { width: 390, height: 844, tag: "mobile" }]) {
  const ctx = await newCtx({ width: vp.width, height: vp.height });
  const page = await ctx.newPage();
  for (const route of routes) {
    const name = (route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "_")) + `-${vp.tag}.png`;
    try {
      await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(3500);
      await page.screenshot({ path: OUT + name });
      console.log("ok", name);
    } catch (e) {
      console.log("FAIL", name, String(e).slice(0, 120));
    }
  }
  await ctx.close();
}
await browser.close();
console.log("done ->", OUT);
