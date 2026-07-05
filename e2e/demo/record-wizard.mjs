#!/usr/bin/env node
// SPEC 6 (ULTRAPLAN P1.3) -- first-run wizard + honest tour clip.
//
// Standalone Playwright script (NOT a test -- run with `node`, not
// `playwright test`) that drives a real chromium browser against the
// cs-demorec container left running by record-cold-install.sh, records a
// 1280x720 video of the session, and saves it as
// e2e/demo/clips/first-run-wizard.webm.
//
// Real human path, no cookie injection:
//   login screen (token from the container's env file) -> home shows the
//   first-run banner -> type an install name -> Finish setup -> banner gone
//   -> switch to the "Northstar Showcase Demo" tenant via the header pill ->
//   a short honest tour: insights inbox (Scan now), /today, /cost.
//
// Usage:
//   node e2e/demo/record-wizard.mjs [baseUrl] [envFilePath]
//   defaults: baseUrl=http://localhost:4620
//             envFilePath=/tmp/cs-demorec-work/src/control-surface.env
//             (the env file record-cold-install.sh's container writes)
//
// Hard rails: never touches the live :3000 service. Reads the operator
// token from the container's own generated env file -- never hardcodes or
// injects a session cookie.
import { chromium } from "playwright";
import { readFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = path.join(__dirname, "clips");
const FINAL_PATH = path.join(CLIPS_DIR, "first-run-wizard.webm");

const BASE_URL = process.argv[2] || "http://localhost:4620";
const ENV_FILE = process.argv[3] || "/tmp/cs-demorec-work/src/control-surface.env";

function readOperatorToken(envFile) {
  const contents = readFileSync(envFile, "utf8");
  const match = contents.match(/^OPERATOR_TOKEN=(.+)$/m);
  if (!match) throw new Error(`OPERATOR_TOKEN not found in ${envFile}`);
  return match[1].trim();
}

async function pause(page, ms) {
  // Deliberate pacing so the clip is watchable by a human, not a speedrun.
  await page.waitForTimeout(ms);
}

async function main() {
  mkdirSync(CLIPS_DIR, { recursive: true });

  const token = readOperatorToken(ENV_FILE);
  console.log(`[record-wizard] operator token loaded from ${ENV_FILE}`);
  console.log(`[record-wizard] recording against ${BASE_URL}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: CLIPS_DIR, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const video = page.video();
  if (!video) throw new Error("recordVideo did not attach to the page");

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  try {
    // ── Login screen (real 401 -> auth-required modal, not cookie injection) ──
    console.log("[record-wizard] step: login");
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await pause(page, 1200);
    await page.locator(".modal-box input.modal-input").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".modal-box input.modal-input").fill(token);
    await pause(page, 500);
    await page.getByRole("button", { name: "Authenticate" }).click();
    await pause(page, 1800);

    // ── First-run wizard ──────────────────────────────────────────────────
    console.log("[record-wizard] step: first-run wizard");
    const bannerLocator = page.getByText("Welcome — name this installation to finish setup.");
    if (await bannerLocator.isVisible().catch(() => false)) {
      await pause(page, 1000);
      await page.locator('input[aria-label="Installation name"]').fill("Northstar Robotics");
      await pause(page, 700);
      await page.getByRole("button", { name: "Finish setup" }).click();
      await pause(page, 1500);
    } else {
      console.log("[record-wizard] setup already completed on this container -- skipping wizard fill (idempotent run)");
    }

    // ── Switch to the demo tenant ─────────────────────────────────────────
    console.log("[record-wizard] step: switch tenant");
    await pause(page, 800);
    await page.locator(".ctx-pill").first().click();
    await pause(page, 600);
    await page.getByRole("button", { name: "Northstar Showcase Demo" }).click();
    await pause(page, 1200);

    // ── Honest tour: insights inbox ───────────────────────────────────────
    console.log("[record-wizard] step: insights inbox tour");
    await page.goto(BASE_URL + "/insights", { waitUntil: "domcontentloaded" });
    await pause(page, 1500);
    await page.getByRole("button", { name: /Scan now/i }).click();
    await pause(page, 2200);
    const costChip = page.locator(".filter-chip", { hasText: "Cost" }).first();
    if (await costChip.isVisible().catch(() => false)) {
      await costChip.click();
      await pause(page, 1200);
    }
    const firstCard = page.locator(".insight-card").first();
    if (await firstCard.isVisible().catch(() => false)) {
      const evidenceBtn = firstCard.getByRole("button", { name: /Evidence/i });
      if (await evidenceBtn.isVisible().catch(() => false)) {
        await evidenceBtn.click();
        await pause(page, 2000);
      }
    }

    // ── Honest tour: /today ───────────────────────────────────────────────
    console.log("[record-wizard] step: /today tour");
    await page.goto(BASE_URL + "/today", { waitUntil: "domcontentloaded" });
    await pause(page, 2200);

    // ── Honest tour: /cost ────────────────────────────────────────────────
    console.log("[record-wizard] step: /cost tour");
    await page.goto(BASE_URL + "/cost", { waitUntil: "domcontentloaded" });
    await pause(page, 2200);
  } finally {
    await context.close();
    await browser.close();
  }

  if (pageErrors.length > 0) {
    console.error("[record-wizard] uncaught page errors during recording:", pageErrors);
  }

  // Playwright names the video file itself (a hash-based filename inside
  // CLIPS_DIR); move it to the fixed name the spec asks for. video.path()
  // only resolves once the owning context/page has fully closed and the
  // recording is flushed to disk -- which just happened above.
  const recordedPath = await video.path();
  renameSync(recordedPath, FINAL_PATH);

  console.log(`[record-wizard] clip written: ${FINAL_PATH}`);
  if (pageErrors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[record-wizard] FAILED:", err);
  process.exitCode = 1;
});
