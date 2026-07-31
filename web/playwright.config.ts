import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  expect: { timeout: 6_000 },
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../output/playwright/report" }]],
  use: {
    baseURL: "http://127.0.0.1:4321",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4321",
    cwd: ".",
    url: "http://127.0.0.1:4321",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  outputDir: "../output/playwright/test-results",
});
