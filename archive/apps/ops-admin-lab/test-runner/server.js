// Test Runner 独立服务
// 端口 4176，与 ops-admin-lab (4175) 完全隔离
// 启动：node test-runner/server.js

const express = require("express");
const path    = require("path");
const fs      = require("fs/promises");
const { spawn } = require("child_process");

const app      = express();
const PORT     = Number(process.env.TR_PORT || 4176);
const trDir    = __dirname;                                      // test-runner/
const appDir   = path.resolve(trDir, "..");                      // ops-admin-lab/
const repoRoot = path.resolve(trDir, "../../../..");             // AutoFlow/

const CURSOR_MODEL = "composer-2";

app.use(express.json());

// 静态文件：test-runner UI 本身
app.use(express.static(trDir));

// 静态文件：Playwright HTML 报告
app.use("/playwright-report", express.static(path.join(appDir, "playwright-report")));

// ── GET /api/tr/spec/:name ─────────────────────────────────────
// 读取 tests/ 目录下的 spec 文件内容，返回纯文本
app.get("/api/tr/spec/:name", async (req, res) => {
  const file = path.join(appDir, "tests", path.basename(req.params.name));
  try {
    res.type("text").send(await fs.readFile(file, "utf8"));
  } catch {
    res.status(404).end();
  }
});

// ── POST /api/tr/run ──────────────────────────────────────────
// 用 cursor-agent 执行 playwright-fix-loop，SSE 实时推流
function buildFixLoopPrompt(testCmd) {
  return [
    "你是 AI 软件工程流程的执行代理，当前阶段：playwright 测试自动修复闭环。",
    "必须严格按以下 skills 方法执行：playwright-fix-loop。",
    "要求：输出结构化、可执行、简洁；若涉及代码改动，优先最小改动，并给出变更证据。",
    "",
    "在 archive/apps/ops-admin-lab 目录执行以下命令，循环直到全部通过：",
    testCmd
  ].join("\n");
}

app.post("/api/tr/run", (req, res) => {
  const { testArgs } = req.body;
  const safeArgs = typeof testArgs === "string" ? testArgs.trim() : "";
  const testCmd  = `cd archive/apps/ops-admin-lab && PLAYWRIGHT_HEADED=1 PLAYWRIGHT_SLOW_MO=800 npx playwright test${safeArgs ? " " + safeArgs : ""}`;
  const prompt   = buildFixLoopPrompt(testCmd);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (text) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
  };

  const child = spawn(
    "cursor-agent",
    [
      "-p",
      "--output-format", "stream-json",
      "--model",  CURSOR_MODEL,
      "--trust",
      "--force",
      "--sandbox", "enabled",
      "--workspace", repoRoot,
      prompt
    ],
    { cwd: repoRoot, env: process.env }
  );

  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const j = JSON.parse(trimmed);
        if (j.type === "assistant" && Array.isArray(j.message?.content)) {
          for (const block of j.message.content) {
            if (block.type === "text" && block.text) send(block.text);
          }
        }
      } catch { send(trimmed); }
    }
  });

  child.stderr.on("data", (chunk) => send(chunk.toString()));

  child.on("close", (code) => {
    send(`\n── 完成，exit ${code} ──`);
    if (!res.writableEnded) {
      res.write("event: done\ndata: {}\n\n");
      res.end();
    }
  });

  child.on("error", (err) => {
    send(`\n[错误] 无法启动 cursor-agent：${err.message}`);
    if (!res.writableEnded) {
      res.write("event: done\ndata: {}\n\n");
      res.end();
    }
  });

  // 监听响应侧断开（客户端关闭），避免误 kill child
  res.on("close", () => {
    if (!child.killed) child.kill("SIGTERM");
  });
});

// ── 健康检查 ──────────────────────────────────────────────────
app.get("/api/tr/health", (_req, res) => {
  res.json({ ok: true, service: "test-runner", port: PORT });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Test Runner 已启动：http://127.0.0.1:${PORT}`);
  console.log(`  UI:     http://127.0.0.1:${PORT}/`);
  console.log(`  Report: http://127.0.0.1:${PORT}/playwright-report/`);
});
