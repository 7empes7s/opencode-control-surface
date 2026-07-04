import { defineConfig, devices } from "@playwright/test";

// The fresh-host UI audit (e2e/fresh-host/ui-audit.pw.ts) targets a throwaway
// container on FRESH_HOST_URL, not the live :3000 service — it must never run
// as part of a bare `bunx playwright test` / `npm run test:e2e`. It is only
// included in the `projects` list (and therefore only ever executes) when the
// caller opts in via FRESH_HOST_UI=1, which e2e/fresh-host/gate.sh sets before
// invoking `playwright test --project=fresh-host-ui`.
const freshHostUiProject = process.env.FRESH_HOST_UI
  ? [
      {
        name: "fresh-host-ui",
        testDir: "./e2e/fresh-host",
        testMatch: "ui-audit.pw.ts",
        timeout: 45_000,
        use: {
          ...devices["Desktop Chrome"],
          baseURL: process.env.FRESH_HOST_URL || "http://localhost:4600",
        },
      },
    ]
  : [];

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-desktop",
      testIgnore: "**/fresh-host/**",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-tablet",
      testIgnore: "**/fresh-host/**",
      use: { ...devices["iPad Mini"], browserName: "chromium" },
    },
    {
      name: "chromium-mobile",
      testIgnore: "**/fresh-host/**",
      use: { ...devices["iPhone 12"], browserName: "chromium" },
    },
    ...freshHostUiProject,
  ],
});
