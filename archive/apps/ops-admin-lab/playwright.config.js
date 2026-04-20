// @ts-check
const { defineConfig } = require("@playwright/test");

const testPort = process.env.PLAYWRIGHT_PORT || "4175";
const baseURL = `http://127.0.0.1:${testPort}`;
const reuseOverride = process.env.PLAYWRIGHT_REUSE_SERVER;
const reuseExistingServer =
  reuseOverride === "1" ? true : reuseOverride === "0" ? false : !process.env.CI;
const headedOverride = process.env.PLAYWRIGHT_HEADED === "1";
const slowMo = Number(process.env.PLAYWRIGHT_SLOW_MO || "0");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }]
  ],
  use: {
    baseURL,
    headless: !headedOverride,
    launchOptions: slowMo > 0 ? { slowMo } : undefined,
    trace: "on-first-retry"
  },
  webServer: {
    command: "node src/server.js",
    env: { ...process.env, PORT: testPort },
    url: `${baseURL}/api/health`,
    reuseExistingServer,
    timeout: 30_000
  }
});
