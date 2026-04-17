// @ts-check
const { defineConfig } = require("@playwright/test");

// 与默认 4180 错开，避免 reuseExistingServer 命中旧进程导致路由不一致
const testPort = process.env.PLAYWRIGHT_PORT || "4181";
const baseURL = `http://127.0.0.1:${testPort}`;

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    headless: true,
    trace: "on-first-retry"
  },
  webServer: {
    command: `node server.js`,
    env: { ...process.env, PORT: testPort },
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
