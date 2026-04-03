// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    headless: true
  },
  webServer: {
    command: "npm start",
    port: 4174,
    reuseExistingServer: true,
    timeout: 30000
  }
});
