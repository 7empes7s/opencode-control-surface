import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

// Authenticate with the origin-scoped operator session cookie (the same value
// POST /api/auth/session issues) so pages render their real content. A global
// Authorization header would leak onto cross-origin requests (fonts.gstatic.com)
// and fail their CORS preflight — cookies stay on localhost.
function operatorToken(): string {
  if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN;
  try {
    const env = readFileSync("/etc/control-surface/secrets.env", "utf8");
    const match = env.match(/^OPERATOR_TOKEN=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* fall through */ }
  return "";
}

function legacySessionValue(token: string): string {
  return createHmac("sha256", token)
    .update("opencode-control-surface.operator-session.v1")
    .digest("base64url");
}

test.beforeEach(async ({ context, baseURL }) => {
  const token = operatorToken();
  if (!token) return;
  await context.addCookies([{
    name: "operator_session",
    value: legacySessionValue(token),
    url: baseURL ?? "http://localhost:3000",
  }]);
});

// Every static route in app/App.tsx (param/wildcard routes excluded; "/" is the
// catch-all DashHome). Keep in sync with the router — a missing entry here means
// a page ships with zero viewport coverage.
const ROUTES = [
  "/",
  "/status",
  "/opencode",
  "/codex",
  "/claude",
  "/gemini",
  "/admin",
  "/autopipeline",
  "/insights",
  "/security",
  "/agents",
  "/scout",
  "/doctor",
  "/models",
  "/litellm",
  "/newsbites",
  "/infra",
  "/incidents",
  "/jobs",
  "/agent-team",
  "/audit",
  "/today",
  "/settings",
  "/builder",
  "/brainstorm",
  "/governance",
  "/traces",
  "/gateway",
  "/workflows",
  "/projects",
  "/about",
  "/marketplace",
  "/install",
  "/cost",
  "/finance-intel",
  "/channels",
  "/content-health",
  "/reports",
  "/data-explorer",
  "/compliance",
  "/feature-flags",
];

// Console noise that is not a page defect: transient backend probe failures the
// UI is designed to degrade around, and stream reconnects in a headless run.
const BENIGN_CONSOLE = [
  /WebSocket/i,
  /EventSource/i,
  /the server responded with a status of (401|403|429|502|503|504)/i,
  /net::ERR_(ABORTED|CONNECTION_REFUSED)/i,
  /Download the React DevTools/i,
];

function isBenign(text: string): boolean {
  return BENIGN_CONSOLE.some((re) => re.test(text));
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });
}

for (const route of ROUTES) {
  test(`route ${route}`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && !isBenign(msg.text())) consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response, `no response for ${route}`).not.toBeNull();
    expect(response!.status(), `HTTP status for ${route}`).toBe(200);

    await page.waitForSelector("#root", { timeout: 10_000 });
    // Let data fetches settle enough for layout to take its real shape.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // Uncaught exceptions are always defects.
    expect(pageErrors, `uncaught page errors on ${route}`).toEqual([]);
    expect(consoleErrors, `console errors on ${route}`).toEqual([]);

    // The page body must never scroll horizontally — wide content scrolls
    // inside its own container (.table-wrap etc.). Allow 1px for rounding.
    const overflow = await horizontalOverflow(page);
    expect(overflow, `horizontal page overflow on ${route} (${testInfo.project.name})`).toBeLessThanOrEqual(1);

    if (testInfo.project.name === "chromium-mobile") {
      // Mobile bottom tab bar: present on dashboard pages (hidden only on bare
      // chat layouts) and it must not cover the end of the page content.
      const bottomNav = page.locator(".dash-bottomnav");
      const bare = await page.locator(".dash-main.bare").count();
      if (bare === 0 && (await bottomNav.count()) > 0 && (await bottomNav.isVisible())) {
        const navBox = await bottomNav.boundingBox();
        // Clearance is provided by .dash-content / .dash-page bottom padding
        // (globals.css mobile block) — measure whichever is largest.
        const clearance = await page.evaluate(() => {
          const pads = [".dash-content", ".dash-page"]
            .map((sel) => document.querySelector(sel))
            .filter((el): el is Element => el !== null)
            .map((el) => parseFloat(getComputedStyle(el).paddingBottom || "0"));
          return pads.length ? Math.max(...pads) : null;
        });
        if (navBox && clearance !== null) {
          expect(
            clearance,
            `mobile: content padding-bottom (${clearance}px) must clear the bottom tab bar (${navBox.height}px) on ${route}`,
          ).toBeGreaterThanOrEqual(navBox.height - 1);
        }
      }
    }
  });
}
