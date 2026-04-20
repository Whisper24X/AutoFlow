#!/usr/bin/env node
const { spawnSync } = require("child_process");

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const probe = spawnSync(npx, ["detox", "--help"], {
  encoding: "utf-8",
  env: process.env
});

if (probe.status !== 0) {
  console.error("[autoflow] Detox 环境不可用：detox not installed");
  process.exit(1);
}

console.log("[autoflow] 检测到 Detox 可用，但模板项目尚未配置真实 e2e。");
console.log("[autoflow] 默认按通过处理，你可替换 scripts/test 命令接入真实 Detox 套件。");
process.exit(0);
