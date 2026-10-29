import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:1430",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    colorScheme: "dark",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:1430",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
