// Focused probe: /litellm sortable-th-arrow geometry at 390px, steady state.
import { chromium } from "@playwright/test";
const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3007";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
if (process.env.QA_TOKEN) {
  const res = await fetch(`${BASE}/api/auth/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: process.env.QA_TOKEN }),
  });
  const m = (res.headers.get("set-cookie") ?? "").match(/operator_session=([^;]+)/);
  await context.addCookies([{ name: "operator_session", value: m[1], url: BASE }]);
}
const page = await context.newPage();
await page.goto(BASE + "/litellm", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(4000); // steady state
const out = await page.evaluate(() => {
  const arrows = [...document.querySelectorAll(".sortable-th-arrow")].map((el) => {
    const r = el.getBoundingClientRect();
    const chain = [];
    let p = el.parentElement;
    while (p && chain.length < 6) {
      const cs = getComputedStyle(p);
      chain.push({
        el: p.tagName.toLowerCase() + "." + String(p.className ?? "").split(" ")[0],
        ox: cs.overflowX, sw: p.scrollWidth, cw: p.clientWidth,
      });
      p = p.parentElement;
    }
    return { left: Math.round(r.left), right: Math.round(r.right), visible: r.width > 0, chain };
  });
  return { vw: innerWidth, arrows: arrows.filter((a) => a.visible) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
