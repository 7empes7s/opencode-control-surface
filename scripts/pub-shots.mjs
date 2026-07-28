import { chromium } from "playwright";
const browser = await chromium.launch();
for (const vp of [{ width: 1440, height: 900, tag: "desktop" }, { width: 390, height: 844, tag: "mobile" }]) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.goto("http://127.0.0.1:3007/status", { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `/opt/control-surface-preview/shots/status-${vp.tag}.png` });
  console.log("ok", vp.tag);
  await page.close();
}
await browser.close();
