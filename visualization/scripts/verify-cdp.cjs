#!/usr/bin/env node
/**
 * 不启动平台、不调用 Cursor，仅验证 cdp-test-runner 与 Playwright CDP 链路。
 * 工作区：环境变量 CDP_WORKSPACE；否则取 visualization/projects/ 下第一个含 package.json 的子目录。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const runner = path.join(root, "cdp-test-runner.js");

let workspace = process.env.CDP_WORKSPACE && String(process.env.CDP_WORKSPACE).trim();
if (!workspace) {
  const projectsDir = path.join(root, "projects");
  let names = [];
  try {
    names = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    console.error(`[verify-cdp] 未找到目录: ${projectsDir}`);
    console.error("[verify-cdp] 请设置 CDP_WORKSPACE 指向含 npm start 的项目路径。");
    process.exit(2);
  }
  const withPkg = names.find((n) => fs.existsSync(path.join(projectsDir, n, "package.json")));
  if (!withPkg) {
    console.error(`[verify-cdp] ${projectsDir} 下无可用子项目（需含 package.json）。`);
    console.error("[verify-cdp] 请先在平台跑一次生成项目，或设置 CDP_WORKSPACE。");
    process.exit(2);
  }
  workspace = path.join(projectsDir, withPkg);
}

const abs = path.resolve(workspace);
const appPort = process.env.CDP_APP_PORT || "4173";
const appHost = process.env.CDP_APP_HOST || "127.0.0.1";

console.error(`[verify-cdp] workspace=${abs}`);
console.error(`[verify-cdp] appHost=${appHost} appPort=${appPort}`);
const passthrough = process.argv.slice(2);
if (passthrough.length) {
  console.error(`[verify-cdp] 透传参数: ${passthrough.join(" ")}`);
}

const r = spawnSync(
  process.execPath,
  [runner, "--workspace", abs, "--appPort", appPort, "--appHost", appHost, ...passthrough],
  { stdio: "inherit", cwd: root, env: process.env }
);

process.exit(r.status === 0 ? 0 : r.status || 1);
