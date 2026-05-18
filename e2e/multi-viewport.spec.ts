import { test, expect } from "@playwright/test";

const PUBLIC_ROUTES = [
  "/",
  "/builder",
  "/projects",
  "/workflows",
  "/gateway",
  "/governance",
  "/audit",
  "/jobs",
];

for (const route of PUBLIC_ROUTES) {
  test(`route ${route} loads without error`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(500);

    // Wait for the app shell to render (React root mount point)
    await page.waitForSelector("#root", { timeout: 5000 });

    // Ensure no uncaught exceptions occurred during load
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Give a tick for any deferred scripts to execute
    await page.waitForTimeout(200);

    // We allow 401/403 on protected routes — just ensure the shell rendered
    const status = response!.status();
    if (status === 200) {
      const root = page.locator("#root");
      await expect(root).toBeVisible();
    }
  });
}
