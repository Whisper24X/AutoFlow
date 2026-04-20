// @ts-check
const { defineConfig } = require("@playwright/test");

// 测试服务独占 4177，与 dev(4175) 和 test-runner(4176) 完全隔离，互不干扰
const testPort = process.env.PLAYWRIGHT_PORT || "4177";
const baseURL = `http://127.0.0.1:${testPort}`;
const reuseOverride = process.env.PLAYWRIGHT_REUSE_SERVER;
// baseURL 已有健康响应时复用该进程，避免端口占用导致失败。必须独占启动时设置 PLAYWRIGHT_REUSE_SERVER=0。
const reuseExistingServer = reuseOverride !== "0";
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
