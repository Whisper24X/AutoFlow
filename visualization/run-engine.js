const fs = require("fs/promises");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn, spawnSync, execFile } = require("child_process");
const { runCompose, createAbortError } = require("./cursor-cli-adapter");

const CDP_APP_HOST = "127.0.0.1";

function normalizeCdpDriver(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (s === "cursor_mcp") return "cursor_mcp";
  return "playwright";
}

function normalizeTargetPlatform(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\+/g, "_")
    .replace(/-/g, "_");
  if (s === "app" || s === "mobile") return "app";
  if (s === "web_app" || s === "app_web") return "web_app";
  return "web";
}

function normalizeAppStack(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "expo" || s === "react_native_expo") return "expo";
  return "expo";
}

function normalizeAppTestMode(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (s === "jest") return "jest";
  if (s === "detox") return "detox";
  return "both";
}

function isMemoRequirement(requirement) {
  const text = String(requirement || "").toLowerCase();
  return /备忘录|memo|todo|待办/.test(text);
}

function buildPlatformDefaultConstraintBlock(run) {
  const target = normalizeTargetPlatform(run?.targetPlatform);
  const lines = [
    "## 平台级默认约束（自动注入）",
    "- 禁止仅交付占位页（例如只有 `Generated Requirement Project` 与 `/api/health` 文案）。",
    "- Web 端必须提供至少 1 条可操作主链路，而非静态展示。",
    "- 测试策略不得仅包含 smoke/health，必须覆盖业务交互断言。"
  ];
  if (target === "web_app") {
    lines.push("- 选择 `web_app` 时，Web 与 App 需对齐核心业务能力，不能只完成其中一端。");
  }
  if (isMemoRequirement(run?.requirement)) {
    lines.push("- 识别为“备忘录/Todo”需求时，默认验收基线包含：新增、编辑、删除、完成状态切换、持久化恢复。");
    lines.push("- 持久化默认约束：Web 使用 localStorage，App 使用 AsyncStorage，两端数据模型字段应一致。");
    lines.push("- 测试必须包含至少 1 条“刷新/重启后数据仍在”的用例，禁止只验证标题或空页面。");
  }
  return `${lines.join("\n")}\n`;
}

function waitPort(host, port, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    function probe() {
      const socket = new net.Socket();
      socket.setTimeout(1200);
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("timeout", () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`port ${port} not ready within ${timeoutMs}ms`));
        } else {
          setTimeout(probe, 250);
        }
      });
      socket.connect(port, host);
    }
    probe();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 去掉产物文件顶部的 Skill Evidence 头，便于作为 prompt 注入 */
function stripSkillHeader(md) {
  if (!md) return "";
  return md.replace(/^## Skill Evidence[\s\S]*?\n\n/m, "").trim();
}

async function readArtifactStripped(runDir, name) {
  if (!runDir) return "";
  try {
    const raw = await fs.readFile(path.join(runDir, name), "utf-8");
    return stripSkillHeader(raw);
  } catch {
    return "";
  }
}

/** 列出项目 tests/ 下 Playwright 用例文件（*.spec.js / *.spec.ts） */
async function listPlaywrightSpecFiles(projectPath) {
  const testsDir = path.join(projectPath, "tests");
  try {
    const names = await fs.readdir(testsDir);
    return names.filter(
      (n) =>
        n.endsWith(".spec.js") ||
        n.endsWith(".spec.ts") ||
        n.endsWith(".spec.mjs")
    );
  } catch {
    return [];
  }
}

/**
 * 为 Cursor MCP 提示拼接 tests/ 下 spec 源码摘录（不执行 Playwright，仅作对照）。
 * @param {string} workspacePath
 * @param {string[]} specFiles 仅文件名，如 smoke.spec.js
 */
async function loadPlaywrightSpecSnippetsForMcp(
  workspacePath,
  specFiles,
  opts = {}
) {
  const maxTotal = opts.maxTotalChars ?? 10000;
  const perFile = opts.perFileMax ?? 3200;
  if (!Array.isArray(specFiles) || specFiles.length === 0) return "";
  const sorted = [...specFiles].sort();
  const parts = [];
  let total = 0;
  for (const name of sorted) {
    const rel = path.join("tests", name);
    const fp = path.join(workspacePath, rel);
    let raw;
    try {
      raw = await fs.readFile(fp, "utf-8");
    } catch {
      parts.push(`--- ${rel} ---\n<读取失败>\n\n`);
      total += 40;
      continue;
    }
    const truncated =
      raw.length > perFile
        ? `${raw.slice(0, perFile)}\n... <truncated ${raw.length - perFile} chars>`
        : raw;
    const block = `--- ${rel} ---\n${truncated}\n\n`;
    if (total + block.length > maxTotal) {
      parts.push("...（源码摘录总长度已达上限，已截断）\n");
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join("").trim();
}

function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => {
        data += c.toString();
      });
      res.on("end", () => {
        try {
          resolve({
            statusCode: res.statusCode || 0,
            body: data,
            json: JSON.parse(data)
          });
        } catch {
          resolve({
            statusCode: res.statusCode || 0,
            body: data,
            json: null
          });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("http timeout"));
    });
  });
}

function hasPlaywrightPortConflict(outputText) {
  const text = String(outputText || "").toLowerCase();
  return text.includes("is already used") && text.includes("/api/health");
}

function execFileSafe(bin, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: err ? err.message || String(err) : ""
        });
      }
    );
  });
}

async function listListeningPidsOnPort(port) {
  if (process.platform === "win32") return [];
  const out = await execFileSafe("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], 5000);
  if (!out.ok && !String(out.error).toLowerCase().includes("no such")) return [];
  return [
    ...new Set(
      String(out.stdout || "")
        .split(/\r?\n/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)
    )
  ];
}

async function forceFreePortForExclusiveWebRun(port) {
  const before = await listListeningPidsOnPort(port);
  if (!before.length) return { killed: [], stillBusy: false };
  for (const pid of before) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  await sleep(700);
  const after = await listListeningPidsOnPort(port);
  return { killed: before, stillBusy: after.length > 0, alive: after };
}

async function resolveWorkspaceDevServerLauncher(workspacePath, { preferWeb = false } = {}) {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const nodeBin = process.execPath;
  const fallback = {
    bin: npmBin,
    args: ["start"],
    label: "npm start",
    env: {}
  };
  try {
    const packageJsonPath = path.join(workspacePath, "package.json");
    const rawPkg = await fs.readFile(packageJsonPath, "utf-8");
    const parsedPkg = JSON.parse(rawPkg);
    const scripts = parsedPkg?.scripts || {};
    const startScript = String(scripts.start || "").trim();
    const hasNodeWebServer = await pathExists(path.join(workspacePath, "src", "server.js"));

    if (preferWeb && typeof scripts["start:web"] === "string" && scripts["start:web"].trim()) {
      return {
        bin: npmBin,
        args: ["run", "start:web"],
        label: "npm run start:web",
        env: {}
      };
    }
    if (preferWeb && hasNodeWebServer && /(?:^|\s)(?:npx\s+)?expo\s+start(?:\s|$)/i.test(startScript)) {
      return {
        bin: nodeBin,
        args: [path.join("src", "server.js")],
        label: "node src/server.js",
        env: {}
      };
    }
    if (/(?:^|\s)(?:npx\s+)?expo\s+start(?:\s|$)/i.test(startScript)) {
      return {
        ...fallback,
        env: {
          CI: "1",
          EXPO_NO_DOCTOR: "1"
        }
      };
    }
  } catch {
    return fallback;
  }
  return fallback;
}

/**
 * 启动 workspace 内 npm start（PORT），就绪后执行 fn，结束时 SIGTERM 子进程。
 */
/**
 * 预检：CLI 是否能看到 MCP 列表（不据此改 pass/fail，仅便于对照日志）。
 */
function runCursorAgentMcpListSync(workspacePath, timeoutMs = 12000) {
  try {
    const r = spawnSync("cursor", ["agent", "mcp", "list"], {
      cwd: workspacePath,
      env: process.env,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    });
    return {
      ok: !r.error,
      status: r.status,
      stdout: String(r.stdout || ""),
      stderr: String(r.stderr || ""),
      err: r.error ? r.error.message : ""
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      err: e.message || String(e)
    };
  }
}

function runCursorAgentMcpListToolsSync(workspacePath, serverName, timeoutMs = 20000) {
  try {
    const r = spawnSync("cursor", ["agent", "mcp", "list-tools", serverName], {
      cwd: workspacePath,
      env: process.env,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    });
    return {
      ok: !r.error,
      status: r.status,
      stdout: String(r.stdout || ""),
      stderr: String(r.stderr || ""),
      err: r.error ? r.error.message : ""
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      err: e.message || String(e)
    };
  }
}

async function withWorkspaceDevServer({ workspacePath, port, signal, launcher }, fn) {
  const resolvedLauncher = launcher || (await resolveWorkspaceDevServerLauncher(workspacePath));
  const child = spawn(resolvedLauncher.bin, resolvedLauncher.args, {
    cwd: workspacePath,
    env: { ...process.env, ...resolvedLauncher.env, PORT: String(port) },
    stdio: "pipe"
  });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (!child.killed) child.kill("SIGTERM");
  };
  const onAbort = () => cleanup();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    await waitPort(CDP_APP_HOST, port, 45000);
    await sleep(200);
    return await fn();
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    cleanup();
  }
}

function buildCursorMcpCdpPrompt({
  appUrl,
  appPort,
  testPlanExcerpt = "",
  specFileList = [],
  specSnippets = "",
  mcpPreflight = null
}) {
  const planBlock =
    testPlanExcerpt && String(testPlanExcerpt).trim().length > 0
      ? [
          "",
          "## 步骤4 测试用例与范围（必须据此执行，不得只做首页一带而过）",
          truncate(String(testPlanExcerpt), 8000),
          ""
        ].join("\n")
      : [
          "",
          "（未读到步骤4 产物 `.autoflow/04_test_strategy.md`：请至少验证首页 `/` 的 2xx、document.title 与 GET /api/health。）",
          ""
        ].join("\n");

  const specPathsBlock =
    specFileList && specFileList.length > 0
      ? [
          "",
          "## Playwright 仓库内用例文件（与步骤4 策略一起作为验收依据；不通过 CLI 执行 spec，仅对照行为）",
          specFileList.map((f) => `- tests/${f}`).join("\n"),
          ""
        ].join("\n")
      : "";

  const specSnippetBlock =
    specSnippets && String(specSnippets).trim().length > 0
      ? [
          "",
          "## tests/ 下用例源码摘录（节选，对照其中 test / test.describe 的意图与断言）",
          truncate(String(specSnippets), 10000),
          ""
        ].join("\n")
      : "";

  const preflightBlock =
    mcpPreflight && String(mcpPreflight).trim().length > 0
      ? [
          "",
          "## MCP 预检结果（平台采样）",
          String(mcpPreflight),
          ""
        ].join("\n")
      : "";

  return [
    "步骤5（Cursor MCP 浏览器真测）",
    planBlock,
    specPathsBlock,
    specSnippetBlock,
    preflightBlock,
    "",
    `应用已在本机启动，请在浏览器中打开并验证：${appUrl}`,
    "",
    "硬性要求：",
    "1）使用 Cursor 已启用且可用的「浏览器 / Chrome DevTools」类 MCP 工具完成导航与检查（例如 chrome-devtools-mcp 或 Browser MCP）。不要仅用文字猜测页面内容。",
    "2）同时依据步骤4 的任务→用例映射，以及本提示中的「Playwright 仓库内用例文件」与「用例源码摘录」，覆盖其中 test / test.describe 所涉关键路径（多页面/多 API 时须实际导航或观察网络）。若步骤4 与 spec 冲突，以仓库 tests/ 下自动化用例为准对齐验收。至少包含：首页主文档 2xx、document.title 非空；以及步骤4 P0 与上述 spec 涉及的接口或页面。若无 spec 列表，则以步骤4 为准。",
    `3）若 MCP 支持网络请求，须对 GET http://${CDP_APP_HOST}:${appPort}/api/health 做观测并在最终 JSON 的 api 字段中写入 statusCode 与截断后的 body 预览（至多 500 字符）；无法观测时写明原因。`,
    "",
    "重要（MCP 专用口径，禁止替代验收）：",
    "4）若当前 cursor agent 会话中**看不到**任何可调用的「浏览器 / Chrome DevTools」类 MCP 工具，则**禁止**使用 Playwright、puppeteer、curl、wget、node fetch、手写 HTTP 等非 MCP 手段做页面或接口的「替代验收」或补充证明。",
    "4.1）判定“是否有浏览器 MCP”时，不要以 list_mcp_resources 是否为空作为依据；必须以工具可调用性为准。",
    "4.2）必须先尝试实际调用至少一个浏览器 MCP 工具（如 `list_pages`/`new_page`/`navigate_page`），仅当调用返回“unknown tool / server unavailable / permission denied”等明确错误，才允许走 MCP_UNAVAILABLE 分支。",
    "4.3）若上面的「MCP 预检结果」已显示浏览器 MCP server 为 ready 且有 tools，则默认视为可用；此时输出 MCP_UNAVAILABLE 将被视为不合规。",
    "5）在上述「无 MCP 工具」情况下：只输出下方 JSON，且 ok **必须**为 false；mode 仍为 \"cursor-mcp-ui-check\"；ui 可写 { statusCode: 0, title: \"\" }；api 可写 { statusCode: 0, body: \"\" }；steps 建议为 [\"mcp-missing\"]。",
    "6）error 字段须以 **MCP_UNAVAILABLE** 开头，并简要说明原因；error 内请包含两行用户可复制的自检命令：`cursor agent mcp list` 与 `cursor agent mcp list-tools <你的浏览器MCP服务器名>`。",
    "",
    "流程结束时在回复最后一段输出单独一段 JSON（不要使用 markdown 代码围栏包裹整段 JSON），对象结构需可被下游按「第一个 { 到最后一个 }」整段解析，字段如下：",
    '- mode: 固定字符串 "cursor-mcp-ui-check"',
    "- ok: boolean，仅当上述检查均通过时为 true",
    `- appUrl: 固定 "${appUrl}"`,
    "- ui: { statusCode: number, title: string }",
    "- api: { statusCode: number, body: string }",
    '- steps: string[]，例如 ["ui-mcp-pass","api-health-pass"] 或含 skip 说明；若已对照 tests/ 下某文件可加 "spec:文件名.spec.js" 等标记',
    "- error: string，通过时为空字符串",
    "- finishedAt: ISO8601 时间字符串",
    "",
    "若 MCP 工具可用但页面失败：仍输出该 JSON，且 ok 为 false，error 写明原因（勿用 MCP_UNAVAILABLE 前缀，除非确无浏览器类 MCP）。"
  ].join("\n");
}

const STEP_META = [
  { id: 1, key: "requirement", title: "用户输入需求" },
  { id: 2, key: "architecture", title: "AI 自动拆解系统架构" },
  { id: 3, key: "multiAgentDev", title: "多Agent协作完成开发" },
  { id: 4, key: "testStrategy", title: "自动生成测试用例与策略" },
  { id: 5, key: "executeTests", title: "执行UI+API测试" },
  { id: 6, key: "analyzeFailure", title: "AI分析失败原因" },
  { id: 7, key: "autoFix", title: "自动修复代码" },
  { id: 8, key: "stabilize", title: "持续迭代直到系统稳定" }
];

function now() {
  return new Date().toISOString();
}

function truncate(str, max = 4000) {
  if (!str) return "";
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n...<truncated>`;
}

async function runCommand({
  command,
  cwd,
  timeoutMs = 120000,
  signal,
  env,
  onStdoutChunk,
  onStderrChunk
}) {
  return new Promise((resolve) => {
    const mergedEnv = env ? { ...process.env, ...env } : process.env;
    const child = spawn("sh", ["-lc", command], { cwd, env: mergedEnv });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killedByAbort = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const onAbort = () => {
      killedByAbort = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (c) => {
      const text = c.toString();
      stdout += text;
      if (onStdoutChunk) onStdoutChunk(text);
    });
    child.stderr.on("data", (c) => {
      const text = c.toString();
      stderr += text;
      if (onStderrChunk) onStderrChunk(text);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        timedOut,
        killedByAbort
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        ok: code === 0 && !timedOut && !killedByAbort,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        killedByAbort
      });
    });
  });
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadSkillsContract(baseDir) {
  const manifestPath = path.join(baseDir, "skills-manifest.json");
  const raw = await fs.readFile(manifestPath, "utf-8");
  const parsed = JSON.parse(raw);
  const skillsRoot = path.resolve(baseDir, "..", ".agents", "skills");
  const missing = [];

  for (const step of STEP_META) {
    const cfg = parsed.steps?.[String(step.id)];
    if (!cfg || !Array.isArray(cfg.skills) || cfg.skills.length === 0) {
      throw new Error(`skills-manifest 缺少步骤 ${step.id} 的技能映射`);
    }
    for (const skill of cfg.skills) {
      const skillPath = path.join(skillsRoot, skill);
      // eslint-disable-next-line no-await-in-loop
      if (!(await pathExists(skillPath))) {
        missing.push(`${skill} (${skillPath})`);
      }
    }
  }

  if (missing.length) {
    throw new Error(`skills 缺失: ${missing.join(", ")}`);
  }

  return {
    manifestPath,
    strictMode: parsed.strictMode !== false,
    steps: parsed.steps
  };
}

function buildSkillHeader(step, skillsContract) {
  const cfg = skillsContract.steps[String(step.id)];
  const skills = cfg?.skills || [];
  return [
    `## Skill Evidence`,
    `- step: ${step.id} ${step.title}`,
    `- required_skills: ${skills.join(", ")}`,
    `- strict_mode: ${skillsContract.strictMode ? "true" : "false"}`,
    ``
  ].join("\n");
}

/** 去掉终端/Playwright 的 ANSI 着色序列，避免日志里出现 [2m、[31m 等乱码 */
function stripAnsi(str) {
  return String(str || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function parseFailureDetails(rawText) {
  const text = stripAnsi(rawText || "");
  const locator = text.match(/Locator:\s*(.+)/i)?.[1]?.trim() || "";
  const expected = text.match(/Expected:\s*(.+)/i)?.[1]?.trim() || "";
  const received = text.match(/Received:\s*(.+)/i)?.[1]?.trim() || "";
  const testName = text.match(/›\s+(.+?)\s+─+/)?.[1]?.trim() || "";
  return {
    testName,
    locator,
    expected,
    received
  };
}

/** 从 Playwright 终端输出里抽一行可读失败摘要（用于日志标红与失败卡片） */
function extractPlaywrightFailureOneLiner(rawText) {
  const text = stripAnsi(rawText || "");
  const errLine = text.match(/Error:\s*([^\n]+)/);
  if (errLine) return truncate(errLine[1].trim(), 220);
  const expectFail = text.match(/expect\([^)]*\)[^\n]*\n[^\n]*Error:\s*([^\n]+)/s);
  if (expectFail) return truncate(expectFail[1].trim(), 220);
  const failedTest = text.match(/✘\s+[^\n]+\n[^\n]*?›\s+([^\n]+)/);
  if (failedTest) return truncate(`失败用例: ${failedTest[1].trim()}`, 220);
  const failedCount = text.match(/(\d+)\s+failed/i);
  if (failedCount) return `${failedCount[1]} 个用例失败`;
  const atAssertion = text.match(/expect\([^)]*\)\.[\s\S]{0,200}?Error:\s*([^\n]+)/);
  if (atAssertion) return truncate(stripAnsi(atAssertion[1]).trim(), 220);
  const shortExpect = text.match(/(expect\([^)]{0,120}\)[^\n]{0,160})/);
  if (shortExpect) return truncate(stripAnsi(shortExpect[1]).replace(/\s+/g, " ").trim(), 220);
  return "";
}

function parseMobileFailureDetails(rawText) {
  const text = stripAnsi(rawText || "");
  const failureType =
    text.match(/(Jest|Detox|Expo)\s+(?:test|run)\s+failed/i)?.[1] ||
    (text.match(/detox/i) ? "Detox" : text.match(/jest/i) ? "Jest" : "Mobile");
  const errorLine =
    text.match(/(?:FAIL|Error|UnhandledPromiseRejection|AssertionError)[:\s]+([^\n]+)/i)?.[1] ||
    "";
  const fileLine =
    text.match(/(?:at|in)\s+([^\s]+\.(?:test|spec)\.[jt]sx?)/i)?.[1] ||
    text.match(/(__tests__\/[^\s]+)/i)?.[1] ||
    "";
  return {
    testName: fileLine,
    locator: "",
    expected: "",
    received: "",
    failureType,
    errorLine: truncate(errorLine.trim(), 280)
  };
}

function extractMobileFailureOneLiner(rawText) {
  const text = stripAnsi(rawText || "");
  const line =
    text.match(/(?:FAIL|Error|AssertionError)[:\s]+([^\n]+)/i)?.[1] ||
    text.match(/Detox(?:Error)?:\s*([^\n]+)/i)?.[1] ||
    text.match(/Jest(?: failed)?:\s*([^\n]+)/i)?.[1] ||
    "";
  if (line) return truncate(line.trim(), 220);
  if (/detox/i.test(text)) return "Detox 运行失败";
  if (/jest/i.test(text)) return "Jest 运行失败";
  return "";
}

/**
 * 从步骤6 compose 输出中抽取「根因」简短说明（供日志一行展示）
 */
function extractFailureAnalysisBrief(stdout) {
  const t = stripAnsi(stripSkillHeader(stdout || ""));
  const lines = t.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^[-*]\s*\*?\*?root_cause\*?\*?/i.test(line) || /^root_cause[：:\s]/i.test(line)) {
      const rest = line
        .replace(/^[-*]\s*\*?\*?root_cause\*?\*?[：:\s]*/i, "")
        .replace(/^root_cause[：:\s]*/i, "")
        .trim();
      if (rest) return truncate(rest, 300);
      const next = (lines[i + 1] || "").trim();
      if (next && !next.startsWith("#")) return truncate(next, 300);
    }
    if (/^##\s*(根因|失败根因|root)/i.test(line) || /^###\s*(根因|root)/i.test(line)) {
      const next = (lines[i + 1] || "").trim();
      if (next) return truncate(next.replace(/^[-*]\s*/, ""), 300);
    }
  }
  const m = t.match(/root_cause[：:\s]*([^\n]+)/i);
  if (m) return truncate(m[1].trim(), 300);
  const m2 = t.match(/root cause[：:\s]*([^\n]+)/i);
  if (m2) return truncate(m2[1].trim(), 300);
  const m3 = t.match(/失败类型[：:\s]*([^\n]+)/i);
  if (m3) return truncate(m3[1].trim(), 300);
  const m4 = t.match(/failure_type[：:\s]*[`'"]?([^`'"\n]+)/i);
  if (m4) return truncate(m4[1].trim(), 300);
  const flat = t.replace(/\s+/g, " ").trim();
  if (flat.length > 0) return truncate(flat.slice(0, 260), 260);
  return "";
}

function extractJsonBlock(text) {
  const raw = text || "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function sanitizeChunkText(text) {
  if (!text) return "";
  return text.replace(/\r/g, "").trim();
}

async function ensureExistingWorkspaceDirs(workspacePath) {
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(workspacePath, "public"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "src"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "tests"), { recursive: true });
}

async function copyDirIfMissing(srcDir, dstDir) {
  if (!(await pathExists(srcDir))) return;
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);
    // eslint-disable-next-line no-await-in-loop
    if (ent.isDirectory()) await copyDirIfMissing(src, dst);
    else if (!(await pathExists(dst))) {
      // eslint-disable-next-line no-await-in-loop
      await fs.copyFile(src, dst);
    }
  }
}

/** 与 Chrome DevTools MCP 官方文档一致的默认项（含 env，便于 Cursor 识别）。 */
const DEFAULT_CHROME_DEVTOOLS_MCP = {
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@latest"],
  env: {}
};

/**
 * 合并写入 workspace/.cursor/mcp.json：保证存在 chrome-devtools（并补全 env），
 * 保留其余 mcpServers（如 dbhub）。chrome-devtools 写在 JSON 最前，便于阅读。
 * cursor agent 会按 Cursor 版本合并全局 ~/.cursor/mcp.json 与 workspace 配置。
 */
async function ensureWorkspaceChromeDevtoolsMcpTemplate(workspacePath) {
  const cursorDir = path.join(workspacePath, ".cursor");
  const mcpPath = path.join(cursorDir, "mcp.json");
  await fs.mkdir(cursorDir, { recursive: true });
  let parsed = { mcpServers: {} };
  if (await pathExists(mcpPath)) {
    try {
      const raw = await fs.readFile(mcpPath, "utf-8");
      const j = JSON.parse(raw);
      if (j && typeof j.mcpServers === "object" && j.mcpServers) {
        parsed.mcpServers = { ...j.mcpServers };
      }
    } catch {
      parsed.mcpServers = {};
    }
  }
  const prev = parsed.mcpServers["chrome-devtools"];
  let merged;
  if (!prev || typeof prev !== "object") {
    merged = { ...DEFAULT_CHROME_DEVTOOLS_MCP };
  } else {
    merged = {
      command: prev.command || DEFAULT_CHROME_DEVTOOLS_MCP.command,
      args:
        Array.isArray(prev.args) && prev.args.length > 0
          ? [...prev.args]
          : [...DEFAULT_CHROME_DEVTOOLS_MCP.args],
      env:
        prev.env && typeof prev.env === "object" && !Array.isArray(prev.env)
          ? { ...prev.env }
          : {}
    };
  }
  const nextServers = { "chrome-devtools": merged };
  for (const key of Object.keys(parsed.mcpServers)) {
    if (key !== "chrome-devtools") {
      nextServers[key] = parsed.mcpServers[key];
    }
  }
  await fs.writeFile(
    mcpPath,
    `${JSON.stringify({ mcpServers: nextServers }, null, 2)}\n`,
    "utf-8"
  );
}

function incrementalWorkspacePromptNote(run) {
  if (!run.useExistingWorkspace) return "";
  return [
    "",
    "【重要】当前工作区为已有代码库：请在现有实现上做增量修改，避免推倒重来；优先阅读并改动现有文件。",
    ""
  ].join("\n");
}

async function ensureProjectSkeleton(workspacePath, appPort) {
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(workspacePath, "public"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "src"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "tests"), { recursive: true });

  const packageJsonPath = path.join(workspacePath, "package.json");
  const serverPath = path.join(workspacePath, "src", "server.js");
  const indexPath = path.join(workspacePath, "public", "index.html");
  const readmePath = path.join(workspacePath, "README.md");
  const smokeTestPath = path.join(workspacePath, "tests", "smoke.spec.js");

  if (!(await pathExists(packageJsonPath))) {
    const pkg = {
      name: "generated-requirement-project",
      private: true,
      version: "0.0.1",
      scripts: {
        start: "node src/server.js",
        test: "playwright test"
      }
    };
    await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  } else {
    const raw = await fs.readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(raw);
    pkg.scripts = pkg.scripts || {};
    if (!pkg.scripts.start) pkg.scripts.start = "node src/server.js";
    if (!pkg.scripts.test) pkg.scripts.test = "playwright test";
    await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  }

  if (!(await pathExists(serverPath))) {
    const serverCode = [
      "const http = require(\"http\");",
      "const fs = require(\"fs\");",
      "const path = require(\"path\");",
      "",
      `const port = Number(process.env.PORT || ${appPort});`,
      "const publicDir = path.join(__dirname, \"..\", \"public\");",
      "const indexPath = path.join(publicDir, \"index.html\");",
      "",
      "const server = http.createServer((req, res) => {",
      "  if (req.url === \"/api/health\") {",
      "    res.writeHead(200, { \"Content-Type\": \"application/json\" });",
      "    res.end(JSON.stringify({ ok: true, service: \"generated-project\", time: new Date().toISOString() }));",
      "    return;",
      "  }",
      "  fs.readFile(indexPath, \"utf-8\", (err, html) => {",
      "    if (err) {",
      "      res.writeHead(500, { \"Content-Type\": \"text/plain\" });",
      "      res.end(\"index.html not found\");",
      "      return;",
      "    }",
      "    res.writeHead(200, { \"Content-Type\": \"text/html; charset=utf-8\" });",
      "    res.end(html);",
      "  });",
      "});",
      "",
      "server.listen(port, () => {",
      "  console.log(`generated project running: http://127.0.0.1:${port}`);",
      "});",
      ""
    ].join("\n");
    await fs.writeFile(serverPath, serverCode, "utf-8");
  }

  if (!(await pathExists(indexPath))) {
    const html = [
      "<!DOCTYPE html>",
      "<html lang=\"zh-CN\">",
      "<head>",
      "  <meta charset=\"UTF-8\" />",
      "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
      "  <title>Generated Requirement Project</title>",
      "  <style>",
      "    :root {",
      "      --font-sans: system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", sans-serif;",
      "      --font-mono: ui-monospace, \"SF Mono\", Menlo, \"Consolas\", monospace;",
      "    }",
      "    body {",
      "      font-family: var(--font-sans);",
      "      background: #0f172a;",
      "      color: #e2e8f0;",
      "      padding: 24px;",
      "      -webkit-font-smoothing: antialiased;",
      "      -moz-osx-font-smoothing: grayscale;",
      "    }",
      "    code { color: #93c5fd; font-family: var(--font-mono); }",
      "  </style>",
      "</head>",
      "<body>",
      "  <h1>Generated Requirement Project</h1>",
      "  <p>此目录由运行引擎自动创建。后续步骤会基于需求继续补全页面与接口。</p>",
      "  <p>Health: <code>/api/health</code></p>",
      "</body>",
      "</html>",
      ""
    ].join("\n");
    await fs.writeFile(indexPath, html, "utf-8");
  }

  if (!(await pathExists(readmePath))) {
    await fs.writeFile(
      readmePath,
      `# Generated Project\n\n- Workspace: ${workspacePath}\n- Default Port: ${appPort}\n`,
      "utf-8"
    );
  }

  if (!(await pathExists(smokeTestPath))) {
    const smoke = [
      "const { test, expect } = require(\"@playwright/test\");",
      "",
      `const BASE_URL = process.env.BASE_URL || \"http://127.0.0.1:${appPort}\";`,
      "",
      "test(\"smoke: homepage is reachable\", async ({ page }) => {",
      "  const response = await page.goto(BASE_URL, { waitUntil: \"domcontentloaded\" });",
      "  expect(response).toBeTruthy();",
      "  expect(response.ok()).toBeTruthy();",
      "  const title = await page.title();",
      "  expect(title).toBeTruthy();",
      "});",
      ""
    ].join("\n");
    await fs.writeFile(smokeTestPath, smoke, "utf-8");
  }

  await ensureWorkspaceChromeDevtoolsMcpTemplate(workspacePath);
}

async function ensureExpoProjectSkeleton(workspacePath, appPort, baseDir) {
  await fs.mkdir(workspacePath, { recursive: true });
  const templateDir = path.join(baseDir, "templates", "mobile-expo");
  await copyDirIfMissing(templateDir, workspacePath);
  const packageJsonPath = path.join(workspacePath, "package.json");
  const readmePath = path.join(workspacePath, "README.md");
  if (!(await pathExists(packageJsonPath))) {
    const pkg = {
      name: "generated-expo-app",
      private: true,
      version: "0.0.1",
      scripts: {
        start: "npx expo start",
        "test:app": "npm run test:app:jest && npm run test:app:detox",
        "test:app:jest": "node ./scripts/mobile-jest-placeholder.cjs",
        "test:app:detox": "node ./scripts/mobile-detox-placeholder.cjs"
      }
    };
    await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  }
  if (!(await pathExists(readmePath))) {
    await fs.writeFile(
      readmePath,
      [
        "# Generated Expo App",
        "",
        `- Workspace: ${workspacePath}`,
        `- Default App Port: ${appPort}`,
        "- Scripts: `npm run test:app:jest`, `npm run test:app:detox`, `npm run test:app`"
      ].join("\n"),
      "utf-8"
    );
  }
  await ensureWorkspaceChromeDevtoolsMcpTemplate(workspacePath);
}

function buildReport(run) {
  const lines = [];
  lines.push(`# 运行报告 ${run.id}`);
  lines.push("");
  lines.push(`- 状态: ${run.status}`);
  lines.push(`- 模型: ${run.model}`);
  lines.push(`- 工作目录: ${run.workspacePath}`);
  lines.push(`- 项目目录: ${run.projectPath || run.workspacePath}`);
  lines.push(`- 证据目录: ${run.runDir || "-"}`);
  lines.push(`- 使用已有项目目录: ${run.useExistingWorkspace ? "是" : "否"}`);
  lines.push(`- 目标平台: ${run.targetPlatform || "web"}`);
  lines.push(`- App 技术栈: ${run.appStack || "expo"}`);
  lines.push(`- App 测试模式: ${run.appTestMode || "both"}`);
  lines.push(`- 应用端口: ${run.appPort || "-"}`);
  lines.push(`- 最大迭代: ${run.maxIterations}`);
  lines.push(`- 实际迭代: ${run.iterations}`);
  lines.push(`- 开始: ${run.startedAt || "-"}`);
  lines.push(`- 结束: ${run.finishedAt || "-"}`);
  lines.push(`- 启用步骤: ${(run.enabledStepIds || [1, 2, 3, 4, 5, 6, 7, 8]).join(", ")}`);
  lines.push(
    `- CDP 有头模式: ${run.cdpHeaded ? `是（lingerMs: ${run.cdpLingerMs ?? 3000}）` : "否"}`
  );
  lines.push(`- CDP 驱动: ${run.cdpDriver || "playwright"}`);
  lines.push("");
  lines.push(`- skills契约: ${run.skillsContract?.manifestPath || "-"}`);
  lines.push(`- strict_mode: ${run.skillsContract?.strictMode ? "true" : "false"}`);
  lines.push(`- CDP模式: ${run.cdp?.mode || "playwright-project-tests"}`);
  lines.push(
    `- tests/ 用例文件: ${(run.cdp?.testsDirSpecFiles || []).join(", ") || "-"}`
  );
  lines.push(`- 测试目录: ${run.testsPath || "-"}`);
  lines.push(`- smoke模板: ${run.smokeTestPath || "-"}`);
  lines.push(`- 移动测试命令: ${(run.mobile?.commands || []).join(" | ") || "-"}`);
  lines.push("");
  lines.push("## Playwright 可视化报告");
  {
    const proj = run.projectPath || run.workspacePath;
    if (proj) {
      const htmlReport = path.join(proj, "playwright-report", "index.html");
      const zhSummary = path.join(proj, "playwright-report", "summary-zh.html");
      lines.push(
        `- 生成位置（步骤5 跑测后）: \`${htmlReport}\`（需在子项目 \`playwright.config.js\` 中启用 \`html\` reporter）`
      );
      lines.push(
        `- 中文摘要（通过/失败标识与说明）: \`${zhSummary}\`（由自定义 reporter \`playwright-reporter-zh-summary.js\` 生成）`
      );
      lines.push(`- 查看命令: \`cd ${proj} && npx playwright show-report\``);
    } else {
      lines.push("- （无项目目录）");
    }
  }
  lines.push("");
  lines.push("## 需求");
  lines.push(run.requirement || "(empty)");
  lines.push("");
  lines.push("## 步骤状态");
  run.steps.forEach((s) => {
    lines.push(
      `- ${s.id}. ${s.title} -> ${s.status}${s.hint ? ` (${s.hint})` : ""} [skills: ${(s.requiredSkills || []).join(", ")}]`
    );
  });
  lines.push("");
  lines.push("## CDP 测试摘要");
  lines.push(`- 最后轮次: ${run.cdp?.lastRound || 0}`);
  lines.push(`- baseUrl: ${run.cdp?.baseUrl || "-"}`);
  lines.push(`- 最后状态: ${run.cdp?.lastStatus || "-"}`);
  lines.push("");
  lines.push("## 失败摘要");
  lines.push(run.lastFailure || "无");
  lines.push("");
  lines.push("## 移动端测试结果");
  lines.push(`- 最后状态: ${run.mobile?.lastStatus || "-"}`);
  lines.push(`- 最后轮次: ${run.mobile?.lastRound || 0}`);
  lines.push(`- 降级策略触发: ${run.mobile?.degradedDetox ? "是（Detox 环境不足）" : "否"}`);
  lines.push(`- 产物目录: ${run.runDir || "-"}`);
  return lines.join("\n");
}

async function startRun({
  run,
  emit,
  markFinished,
  baseDir
}) {
  const controller = new AbortController();
  run.abortController = controller;

  const runDir = path.join(run.workspacePath, ".autoflow");
  await fs.mkdir(runDir, { recursive: true });
  run.runDir = runDir;

  function emitLog(message, level = "info") {
    emit(run.id, "log", { level, message, at: now() });
  }

  function setStep(stepId, status, hint = "") {
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.status = status;
    step.hint = hint;
    step.updatedAt = now();
    run.currentStep = stepId;
    emit(run.id, "step_status", {
      stepId,
      status,
      hint,
      requiredSkills: step.requiredSkills || [],
      at: step.updatedAt
    });
  }

  async function saveArtifact(name, content) {
    const target = path.join(runDir, name);
    await fs.writeFile(target, content || "", "utf-8");
    return target;
  }

  async function finishRunCompleted() {
    run.status = "completed";
    run.finishedAt = now();
    run.reportMarkdown = buildReport(run);
    await saveArtifact("report.md", run.reportMarkdown);
    emit(run.id, "run_finished", {
      at: run.finishedAt,
      iterations: run.iterations,
      status: run.status
    });
    markFinished(run.id);
  }

  function createCliChunkEmitter({ stepId, phase, minIntervalMs = 200 }) {
    let lastEmitMs = 0;
    return (stream, chunkText) => {
      const cleaned = sanitizeChunkText(chunkText);
      if (!cleaned) return;
      const nowMs = Date.now();
      if (nowMs - lastEmitMs < minIntervalMs) return;
      lastEmitMs = nowMs;
      emit(run.id, "cli_chunk", {
        stepId,
        phase,
        stream,
        text: truncate(cleaned, 800),
        at: now()
      });
    };
  }

  async function withCliHeartbeat({ stepId, phase, message }, task) {
    const startedMs = Date.now();
    const sendHeartbeat = () => {
      emit(run.id, "cli_heartbeat", {
        stepId,
        phase,
        message,
        elapsedMs: Date.now() - startedMs,
        at: now()
      });
    };
    sendHeartbeat();
    const timer = setInterval(sendHeartbeat, 1500);
    try {
      return await task();
    } finally {
      clearInterval(timer);
      sendHeartbeat();
    }
  }

  async function runComposeStep(stepId, stepName, promptBody, timeoutMs, phase = "compose") {
    const step = run.steps.find((s) => s.id === stepId);
    const requiredSkills = step?.requiredSkills || [];
    const isMcpUiPhase =
      typeof phase === "string" && phase.startsWith("cdp_mcp_round");
    // MCP 浏览器验页阶段以步骤5硬约束为唯一准绳，避免被通用 webapp-testing skill 误导到 Playwright 口径。
    const effectiveRequiredSkills = isMcpUiPhase ? [] : requiredSkills;
    const approveMcps =
      typeof phase === "string" && phase.startsWith("cdp_mcp_round");
    const chunkMs =
      typeof phase === "string" && phase.startsWith("cdp_") ? 60 : 200;
    const emitChunk = createCliChunkEmitter({
      stepId,
      phase,
      minIntervalMs: chunkMs
    });
    const result = await withCliHeartbeat(
      { stepId, phase, message: `${stepName} 执行中` },
      () =>
        runCompose({
          stepName,
          promptBody,
          model: run.model,
          workspacePath: run.workspacePath,
          timeoutMs,
          signal: controller.signal,
          approveMcps,
          requiredSkills: effectiveRequiredSkills,
          onStdoutChunk: (text) => emitChunk("stdout", text),
          onStderrChunk: (text) => emitChunk("stderr", text)
        })
    );
    emit(run.id, "cli_phase_done", {
      stepId,
      phase,
      message: `${stepName} 执行完成`,
      at: now()
    });
    return result;
  }

  try {
    const isMobileTarget =
      run.targetPlatform === "app" || run.targetPlatform === "web_app";
    const isWebTarget =
      run.targetPlatform === "web" || run.targetPlatform === "web_app";
    const platformDefaultConstraintBlock = buildPlatformDefaultConstraintBlock(run);
    if (run.useExistingWorkspace) {
      await ensureExistingWorkspaceDirs(run.workspacePath);
    } else {
      if (run.targetPlatform === "app" || run.targetPlatform === "web_app") {
        await ensureExpoProjectSkeleton(run.workspacePath, run.appPort || 4173, baseDir);
      }
      if (run.targetPlatform === "web" || run.targetPlatform === "web_app") {
        await ensureProjectSkeleton(run.workspacePath, run.appPort || 4173);
      }
    }
    run.projectPath = run.projectPath || run.workspacePath;
    run.testsPath = path.join(run.projectPath, "tests");
    run.smokeTestPath = path.join(run.testsPath, "smoke.spec.js");

    run.skillsContract = await loadSkillsContract(baseDir);
    run.steps.forEach((step) => {
      const cfg = run.skillsContract.steps[String(step.id)];
      step.requiredSkills = cfg.skills;
      step.updatedAt = now();
    });
    if (isWebTarget && normalizeCdpDriver(run.cdpDriver) === "cursor_mcp") {
      const step5 = run.steps.find((s) => s.id === 5);
      if (step5 && Array.isArray(step5.requiredSkills)) {
        // Cursor MCP 验页路径下，不注入 webapp-testing skill，避免被 Playwright 语义干扰。
        step5.requiredSkills = step5.requiredSkills.filter((s) => s !== "webapp-testing");
      }
    }

    run.status = "running";
    run.startedAt = now();
    emit(run.id, "run_started", {
      runId: run.id,
      model: run.model,
      workspacePath: run.workspacePath,
      projectPath: run.projectPath,
      testsPath: run.testsPath,
      smokeTestPath: run.smokeTestPath,
      appPort: run.appPort,
      useExistingWorkspace: Boolean(run.useExistingWorkspace),
      cdpHeaded: Boolean(run.cdpHeaded),
      cdpLingerMs: run.cdpLingerMs,
      cdpDriver: run.cdpDriver || "playwright",
      targetPlatform: run.targetPlatform || "web",
      appStack: run.appStack || "expo",
      appTestMode: run.appTestMode || "both",
      artifactDir: run.runDir,
      at: run.startedAt
    });
    emit(run.id, "skills_contract_loaded", {
      manifestPath: run.skillsContract.manifestPath,
      strictMode: run.skillsContract.strictMode,
      steps: run.steps.map((s) => ({ id: s.id, skills: s.requiredSkills })),
      at: now()
    });

    const enabledArr =
      Array.isArray(run.enabledStepIds) && run.enabledStepIds.length > 0
        ? run.enabledStepIds
        : [1, 2, 3, 4, 5, 6, 7, 8];
    const enabledSet = new Set(enabledArr);
    const should = (stepId) => enabledSet.has(stepId);

    setStep(1, "active", "接收需求并标准化");
    await saveArtifact(
      "01_requirement.md",
      `${buildSkillHeader(run.steps[0], run.skillsContract)}${run.requirement}`
    );
    setStep(1, "done", "需求已写入运行目录");

    if (should(2)) {
      setStep(2, "active", "调用 compose 拆解架构");
    const architecture = await runComposeStep(
      2,
      "步骤2 架构拆解",
      [
        "请基于以下需求输出系统架构拆解：模块、数据流、接口、风险。",
        "要求输出 markdown，小白可读。",
        platformDefaultConstraintBlock,
        incrementalWorkspacePromptNote(run),
        run.requirement
      ].join("\n"),
        180000,
        "architecture_compose"
      );
      if (!architecture.ok) {
        throw new Error(`步骤2失败: ${truncate(architecture.stderr || architecture.stdout, 600)}`);
      }
      await saveArtifact(
        "02_architecture.md",
        `${buildSkillHeader(run.steps[1], run.skillsContract)}${architecture.stdout}`
      );
      emitLog(
        `步骤2完成，模型: ${architecture.modelUsed}，skills: ${run.steps[1].requiredSkills.join(", ")}`,
        "ok"
      );
      setStep(2, "done", "架构拆解完成");
    } else {
      setStep(2, "skipped", "本 run 未启用");
    }

    if (should(3)) {
      setStep(3, "active", "调用 compose 多Agent开发");
    const devResult = await runComposeStep(
      3,
      "步骤3 多Agent协作开发",
      [
        "你需要扮演多Agent协作（规划/实现/审查）完成开发。",
        "优先最小改动；必要时可写代码。",
        "不要停留在骨架页/占位页，必须交付可交互功能与可验证行为。",
        "输出：你做了什么、改了哪些文件、待验证项。",
        platformDefaultConstraintBlock,
        incrementalWorkspacePromptNote(run),
        `需求:\n${run.requirement}`
      ].join("\n"),
        8 * 60 * 1000,
        "multi_agent_dev_compose"
      );
      if (!devResult.ok) {
        throw new Error(`步骤3失败: ${truncate(devResult.stderr || devResult.stdout, 600)}`);
      }
      await saveArtifact(
        "03_multi_agent_dev.md",
        `${buildSkillHeader(run.steps[2], run.skillsContract)}${devResult.stdout}`
      );
      setStep(3, "done", "多Agent开发完成");
    } else {
      setStep(3, "skipped", "本 run 未启用");
    }

    if (should(4)) {
      setStep(4, "active", "生成测试用例与策略");
      const architectureBody = await readArtifactStripped(runDir, "02_architecture.md");
      const archBlock =
        architectureBody.trim().length > 0
          ? [
              "",
              "## 步骤2 架构拆解（你必须据此建立「任务→测试用例」映射）",
              "",
              "```markdown",
              truncate(architectureBody, 12000),
              "```",
              ""
            ].join("\n")
          : [
              "",
              "【说明】本 run 未找到 `02_architecture.md` 或步骤2未执行：请在文档中注明「无步骤2拆解，采用需求+代码驱动」，并仍给出可执行用例。",
              ""
            ].join("\n");
      const strategy = await runComposeStep(
        4,
        "步骤4 测试用例与策略生成",
        [
          "你正在执行「步骤4：根据步骤2任务生成测试用例与策略」。",
          "",
          "**输入优先级**：下列「步骤2 架构拆解」优先于单纯需求；请结合当前仓库 `src/`、`public/`、`tests/` 现状落地。",
          "**强制输出**：",
          "1）从步骤2中的模块/任务/接口/风险，逐条映射为可执行测试用例（Playwright `test()` 标题级或 `test.describe` 级），并给出 P0/P1/P2 与失败判定。",
          "2）在 `tests/` 下**新增或修改** `*.spec.js`，确保与上述用例一致且可运行；禁止 echo 占位命令。",
          "3）文档中必须包含：**任务→用例矩阵**（覆盖步骤2主要任务；若无步骤2则说明退化策略）。",
          "4）必须提供 Playwright + CDP 交叉校验思路（如 Runtime.evaluate 与 DOM 断言一致），并与 `tests/*.spec.js` 对齐。",
          "5）给出与步骤5一致的本地命令（端口由平台注入，文档中可用占位说明）：`BASE_URL=http://127.0.0.1:<端口> PORT=<端口> npx playwright test tests`（可选 `CI=1` 强制每次新启 webServer）。",
          "6）禁止只生成 smoke/health 通过型用例；至少包含业务交互断言（如 CRUD、状态流转、持久化恢复）。",
          isMobileTarget
            ? "7）若目标平台包含 app：补充 Expo 移动端测试矩阵（Jest/Detox），并给出 `npm run test:app:jest` 与 `npm run test:app:detox` 的执行前提、失败判定与回归路径。"
            : "",
          platformDefaultConstraintBlock,
          incrementalWorkspacePromptNote(run),
          archBlock,
          `需求:\n${run.requirement}`
        ].join("\n"),
        180000,
        "test_strategy_compose"
      );
      if (!strategy.ok) {
        throw new Error(`步骤4失败: ${truncate(strategy.stderr || strategy.stdout, 600)}`);
      }
      const strategyPath = await saveArtifact(
        "04_test_strategy.md",
        `${buildSkillHeader(run.steps[3], run.skillsContract)}${strategy.stdout}`
      );
      setStep(4, "done", "测试用例与策略已生成");
      emitLog(`步骤4 产物已写入: ${strategyPath}`, "ok");
    } else {
      setStep(4, "skipped", "本 run 未启用");
    }

    if (!should(5)) {
      setStep(5, "skipped", "本 run 未启用");
      setStep(6, "skipped", "本 run 未启用");
      setStep(7, "skipped", "本 run 未启用");
      run.iterations = 0;
      if (should(8)) {
        setStep(8, "active", "汇总所选步骤结果");
        setStep(8, "done", "未执行 CDP，按所选步骤结束");
        emitLog("未启用 CDP 测试，流程已按选项结束", "ok");
      } else {
        setStep(8, "skipped", "本 run 未启用");
      }
      await finishRunCompleted();
      return;
    }

    const appPort = Number(run.appPort || 4173);
    const appUrl = `http://${CDP_APP_HOST}:${appPort}`;
    const useMcpCdp = isWebTarget && normalizeCdpDriver(run.cdpDriver) === "cursor_mcp";
    const headedPlaywright =
      isWebTarget && !useMcpCdp && run.cdpHeaded ? " --headed" : "";
    const testCommand = useMcpCdp
      ? `cursor agent (MCP UI check) workspace=${run.workspacePath} appUrl=${appUrl}`
      : `npx playwright test tests${headedPlaywright}`;
    async function buildPlaywrightStep5Env(round) {
      const env = {
        BASE_URL: appUrl,
        PORT: String(appPort),
        PLAYWRIGHT_PORT: String(appPort),
        CI: "1",
        PLAYWRIGHT_REUSE_SERVER: "0"
      };
      const exclusive = await forceFreePortForExclusiveWebRun(appPort);
      if (exclusive.killed.length) {
        emitLog(
          `步骤5 第 ${round} 轮：独占启动前已停止端口 ${appPort} 上进程 PID=${exclusive.killed.join(",")}`,
          exclusive.stillBusy ? "warn" : "run"
        );
      }
      if (exclusive.stillBusy) {
        env.PLAYWRIGHT_REUSE_SERVER = "1";
        emitLog(
          `步骤5 第 ${round} 轮：端口 ${appPort} 仍被占用（PID=${(exclusive.alive || []).join(",") || "-"})，回退启用 PLAYWRIGHT_REUSE_SERVER=1`,
          "warn"
        );
        return env;
      }
      try {
        const health = await httpGetJson(`${appUrl}/api/health`, 1800);
        if (Number(health.statusCode) > 0) {
          env.PLAYWRIGHT_REUSE_SERVER = "1";
          emitLog(
            `步骤5 第 ${round} 轮：端口 ${appPort} 已有服务响应(/api/health=${health.statusCode})，启用 PLAYWRIGHT_REUSE_SERVER=1 以避免端口冲突`,
            "warn"
          );
        }
      } catch {
        /* 端口未就绪时按独占模式启动，避免误连旧服务 */
      }
      return env;
    }
    const step4TestPlanExcerpt = await readArtifactStripped(
      run.runDir,
      "04_test_strategy.md"
    );
    const testsDirSpecs = isWebTarget ? await listPlaywrightSpecFiles(run.workspacePath) : [];
    run.cdp = {
      mode: isWebTarget
        ? (useMcpCdp ? "cursor-mcp-ui-check" : "playwright-project-tests")
        : "mobile-app-tests",
      driver: isWebTarget ? (useMcpCdp ? "cursor_mcp" : "playwright") : "expo",
      baseUrl: isWebTarget ? appUrl : "-",
      testsDirSpecFiles: testsDirSpecs,
      lastRound: 0,
      lastStatus: "pending",
      passedRounds: 0,
      failedRounds: 0
    };
    run.mobile = {
      stack: run.appStack || "expo",
      mode: run.appTestMode || "both",
      commands: [],
      lastRound: 0,
      lastStatus: "pending",
      degradedDetox: false
    };
    if (isWebTarget && useMcpCdp) {
      emitLog(
        `步骤5启用 Cursor MCP 浏览器验页（cursor agent）；有头/停留由本机浏览器与 MCP 决定，与「CDP 有头」开关无关。appUrl=${appUrl}`,
        "run"
      );
    } else if (isWebTarget) {
      emitLog(
        `步骤5启用 Playwright：工作区 ${run.workspacePath}，执行命令 \`${testCommand}\`（环境 BASE_URL=${appUrl} PORT=${appPort}）。已发现 tests/ 用例文件：${
          testsDirSpecs.length ? testsDirSpecs.join(", ") : "无"
        }`,
        testsDirSpecs.length ? "run" : "warn"
      );
    }
    if (isMobileTarget) {
      emitLog(
        `步骤5包含 Expo App 测试，模式=${run.appTestMode || "both"}（Jest/Detox）`,
        "run"
      );
    }

    let mcpSpecSnippets = "";
    if (isWebTarget && useMcpCdp) {
      await ensureWorkspaceChromeDevtoolsMcpTemplate(run.workspacePath);
      mcpSpecSnippets = await loadPlaywrightSpecSnippetsForMcp(
        run.workspacePath,
        testsDirSpecs
      );
      if (testsDirSpecs.length) {
        emitLog(
          `步骤5 MCP 提示将注入 ${testsDirSpecs.length} 个 spec 路径及源码摘录（约 ${mcpSpecSnippets.length} 字符）`,
          "run"
        );
      } else {
        emitLog(
          "步骤5 MCP：未发现 tests/ 下 *.spec.*，验收仅依赖步骤4 文档或兜底首页与 /api/health",
          "warn"
        );
      }
    }

    async function runMobileRound(i) {
      const mode = normalizeAppTestMode(run.appTestMode);
      const commands = [];
      if (mode === "jest" || mode === "both") {
        commands.push({ label: "Jest", command: "npm run test:app:jest", optional: false });
      }
      if (mode === "detox" || mode === "both") {
        commands.push({
          label: "Detox",
          command: "npm run test:app:detox",
          optional: mode === "both"
        });
      }
      if (commands.length === 0) {
        commands.push({ label: "App", command: "npm run test:app", optional: false });
      }
      run.mobile.commands = commands.map((x) => x.command);
      const outputs = [];
      let ok = true;
      let degradedDetox = false;
      for (const cmd of commands) {
        emitLog(`步骤5 第 ${i} 轮：执行移动端 ${cmd.label} 命令 \`${cmd.command}\``, "run");
        const result = await runCommand({
          command: cmd.command,
          cwd: run.workspacePath,
          timeoutMs: 8 * 60 * 1000,
          signal: controller.signal
        });
        const out = `${result.stdout}\n${result.stderr}`.trim();
        outputs.push(`## ${cmd.label}\n${out || "(empty)"}`);
        if (!result.ok) {
          const low = out.toLowerCase();
          const detoxEnvMissing =
            cmd.label === "Detox" &&
            (low.includes("simulator") ||
              low.includes("emulator") ||
              low.includes("no booted device") ||
              low.includes("device not found") ||
              low.includes("detox not installed"));
          if (cmd.optional && detoxEnvMissing) {
            degradedDetox = true;
            emitLog(
              `步骤5 第 ${i} 轮：Detox 环境不可用，按降级策略跳过 Detox 并继续（Jest 结果仍作为通过依据）`,
              "warn"
            );
            continue;
          }
          ok = false;
          break;
        }
      }
      return {
        ok,
        output: outputs.join("\n\n"),
        degradedDetox
      };
    }

    let passed = false;
    let lastTestOutput = "";

    for (let i = 1; i <= run.maxIterations; i += 1) {
      run.iterations = i;
      const driverLabel = isWebTarget
        ? (useMcpCdp ? "Cursor MCP" : "Playwright(tests/)")
        : "Expo App Tests";
      emitLog(
        `步骤5 第 ${i}/${run.maxIterations} 轮开始（${driverLabel}${isMobileTarget && isWebTarget ? " + Expo" : ""}）`,
        "run"
      );
      setStep(5, "active", `第 ${i} 轮：准备中（${driverLabel}）…`);
      const roundPhase = useMcpCdp ? `cdp_mcp_round_${i}` : `cdp_test_round_${i}`;
      const emitTestChunk = useMcpCdp || !isWebTarget
        ? null
        : createCliChunkEmitter({
            stepId: 5,
            phase: roundPhase,
            minIntervalMs: 60
          });

      let webResult = { ok: true, stdout: "", stderr: "", timedOut: false, killedByAbort: false };
      if (isWebTarget) {
        webResult = await withCliHeartbeat(
          {
            stepId: 5,
            phase: roundPhase,
            message: `第 ${i} 轮 ${useMcpCdp ? "MCP" : "Playwright tests"} 执行中`
          },
          () =>
            useMcpCdp
              ? (async () => {
                  const devServerLauncher = await resolveWorkspaceDevServerLauncher(
                    run.workspacePath,
                    { preferWeb: true }
                  );
                  emitLog(
                    `步骤5 第 ${i} 轮：正在启动 ${devServerLauncher.label}（PORT=${appPort}），等待端口就绪…`,
                    "run"
                  );
                  setStep(5, "active", `第 ${i} 轮：启动应用并等待端口 ${appPort}…`);
                  return withWorkspaceDevServer(
                    {
                      workspacePath: run.workspacePath,
                      port: appPort,
                      signal: controller.signal,
                      launcher: devServerLauncher
                    },
                    async () => {
                      emitLog(
                        `步骤5 第 ${i} 轮：应用已监听端口 ${appPort}，正在调用 cursor agent（MCP 浏览器验页）`,
                        "run"
                      );
                      const pf = runCursorAgentMcpListSync(run.workspacePath, 45000);
                      const toolsPf = runCursorAgentMcpListToolsSync(
                        run.workspacePath,
                        "chrome-devtools",
                        25000
                      );
                      const pfText = [
                        `exit_status=${pf.status == null ? "null" : pf.status}`,
                        pf.err ? `spawn_error=${pf.err}` : "",
                        "--- stdout ---",
                        pf.stdout || "(empty)",
                        "--- stderr ---",
                        pf.stderr || "(empty)",
                        "",
                        "=== list-tools chrome-devtools ===",
                        `exit_status=${toolsPf.status == null ? "null" : toolsPf.status}`,
                        toolsPf.err ? `spawn_error=${toolsPf.err}` : "",
                        "--- stdout ---",
                        toolsPf.stdout || "(empty)",
                        "--- stderr ---",
                        toolsPf.stderr || "(empty)"
                      ]
                        .filter(Boolean)
                        .join("\n");
                      await saveArtifact(`05_mcp_preflight_round_${i}.log`, pfText);
                      const mcpPreflightPrompt = truncate(pfText, 3000);
                      const compose = await runComposeStep(
                        5,
                        "步骤5 MCP浏览器验页",
                        buildCursorMcpCdpPrompt({
                          appUrl,
                          appPort,
                          testPlanExcerpt: step4TestPlanExcerpt,
                          specFileList: testsDirSpecs,
                          specSnippets: mcpSpecSnippets,
                          mcpPreflight: mcpPreflightPrompt
                        }),
                        180000,
                        roundPhase
                      );
                      const out = `${compose.stdout}\n${compose.stderr}`.trim();
                      let summaryJson = extractJsonBlock(out);
                      let roundOk = compose.ok;
                      if (summaryJson && summaryJson.ok === false) roundOk = false;
                      if (roundOk && summaryJson) {
                        try {
                          const health = await httpGetJson(`${appUrl}/api/health`, 4000);
                          summaryJson = {
                            ...summaryJson,
                            mode: "cursor-mcp-ui-check",
                            appUrl,
                            api: {
                              statusCode: health.statusCode,
                              body: (health.body || "").slice(0, 500)
                            }
                          };
                        } catch {
                          /* ignore */
                        }
                      }
                      const mergedOut = summaryJson
                        ? `${out}\n${JSON.stringify(summaryJson, null, 2)}`
                        : out;
                      return {
                        ok: roundOk,
                        stdout: mergedOut,
                        stderr: compose.stderr || "",
                        timedOut: compose.timedOut,
                        killedByAbort: compose.killedByAbort
                      };
                    }
                  );
                })()
              : (async () => {
                  const firstEnv = await buildPlaywrightStep5Env(i);
                  let first = await runCommand({
                    command: testCommand,
                    cwd: run.workspacePath,
                    env: firstEnv,
                    timeoutMs: 300000,
                    signal: controller.signal,
                    onStdoutChunk: (text) => emitTestChunk("stdout", text),
                    onStderrChunk: (text) => emitTestChunk("stderr", text)
                  });
                  const firstOut = `${first.stdout}\n${first.stderr}`;
                  if (!first.ok && hasPlaywrightPortConflict(firstOut) && firstEnv.PLAYWRIGHT_REUSE_SERVER !== "1") {
                    emitLog(
                      `步骤5 第 ${i} 轮：检测到 Playwright 端口冲突，自动切换 PLAYWRIGHT_REUSE_SERVER=1 重试一次`,
                      "warn"
                    );
                    const retryEnv = { ...firstEnv, PLAYWRIGHT_REUSE_SERVER: "1" };
                    const retry = await runCommand({
                      command: testCommand,
                      cwd: run.workspacePath,
                      env: retryEnv,
                      timeoutMs: 300000,
                      signal: controller.signal,
                      onStdoutChunk: (text) => emitTestChunk("stdout", text),
                      onStderrChunk: (text) => emitTestChunk("stderr", text)
                    });
                    const mergedStdout = `${first.stdout}\n\n[AutoFlow Retry] retry with PLAYWRIGHT_REUSE_SERVER=1\n${retry.stdout}`.trim();
                    const mergedStderr = `${first.stderr}\n\n${retry.stderr}`.trim();
                    first = {
                      ...retry,
                      stdout: mergedStdout,
                      stderr: mergedStderr
                    };
                  }
                  return first;
                })()
        );
      }

      let mobileResult = { ok: true, output: "", degradedDetox: false };
      if (isMobileTarget) {
        mobileResult = await withCliHeartbeat(
          {
            stepId: 5,
            phase: `mobile_test_round_${i}`,
            message: `第 ${i} 轮 Expo 移动端测试执行中`
          },
          () => runMobileRound(i)
        );
      }
      run.mobile.lastRound = i;
      run.mobile.degradedDetox = Boolean(mobileResult.degradedDetox);
      run.mobile.lastStatus = mobileResult.ok ? "passed" : "failed";
      const webOutput = `${webResult.stdout}\n${webResult.stderr}`.trim();
      const mergedOutput = [
        isWebTarget ? `## Web\n${webOutput || "(empty)"}` : "",
        isMobileTarget ? `## App\n${mobileResult.output || "(empty)"}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");
      lastTestOutput = mergedOutput.trim();
      await saveArtifact(`05_test_round_${i}.log`, lastTestOutput);
      if (isMobileTarget) {
        await saveArtifact(`05_mobile_test_round_${i}.log`, mobileResult.output || "");
      }
      const testOk = webResult.ok && mobileResult.ok;
      if (testOk) {
        emitLog(`步骤5 第 ${i} 轮本轮结束：通过`, "ok");
      } else {
        const webBrief = !webResult.ok ? extractPlaywrightFailureOneLiner(webOutput) : "";
        const mobileBrief = !mobileResult.ok ? extractMobileFailureOneLiner(mobileResult.output) : "";
        const failBrief = [webBrief, mobileBrief].filter(Boolean).join(" | ");
        emitLog(
          `步骤5 第 ${i} 轮本轮结束：未通过${failBrief ? ` — ${failBrief}` : ""}`,
          "error"
        );
      }
      run.cdp.lastRound = i;
      const cdpJson = isWebTarget ? extractJsonBlock(webOutput) : null;
      if (cdpJson) {
        emit(run.id, "cdp_status", {
          round: i,
          summary: cdpJson,
          at: now()
        });
      }

      if (testOk) {
        setStep(5, "done", `第 ${i} 轮测试通过`);
        run.cdp.passedRounds += 1;
        run.cdp.lastStatus = "passed";
        run.mobile.lastStatus = "passed";
        if (should(6)) setStep(6, "done", "无需失败分析");
        else setStep(6, "skipped", "本 run 未启用");
        if (should(7)) setStep(7, "done", "无需自动修复");
        else setStep(7, "skipped", "本 run 未启用");
        passed = true;
        emitLog(`第 ${i} 轮测试通过`, "ok");
        break;
      }

      const failedDriver = !webResult.ok
        ? (useMcpCdp ? "cursor_mcp" : "playwright")
        : "mobile_expo";
      const failedOutput = !webResult.ok ? webOutput : mobileResult.output;
      const failureDetails =
        failedDriver === "mobile_expo"
          ? parseMobileFailureDetails(failedOutput)
          : parseFailureDetails(failedOutput);
      const failBriefForCard =
        failedDriver === "mobile_expo"
          ? extractMobileFailureOneLiner(failedOutput)
          : extractPlaywrightFailureOneLiner(failedOutput);
      run.lastFailure = truncate(lastTestOutput, 6000);
      run.cdp.failedRounds += 1;
      run.cdp.lastStatus = "failed";
      run.mobile.lastStatus = mobileResult.ok ? "passed" : "failed";
      setStep(5, "error", `第 ${i} 轮失败`);
      const mcpSummary =
        failedDriver === "cursor_mcp" && cdpJson && typeof cdpJson === "object"
          ? {
              mode: cdpJson.mode,
              ok: cdpJson.ok,
              error: cdpJson.error,
              steps: cdpJson.steps
            }
          : null;
      emit(run.id, "test_failed", {
        round: i,
        testCommand: failedDriver === "mobile_expo" ? (run.mobile.commands || []).join(" && ") : testCommand,
        brief: failBriefForCard,
        details: failureDetails,
        output: truncate(lastTestOutput, 4000),
        driver: failedDriver,
        mcpSummary,
        at: now()
      });

      const step6PromptBody = failedDriver === "cursor_mcp"
        ? [
            "以下是步骤 5（Cursor MCP / chrome-devtools-mcp）真测失败时的完整输出（含 agent 说明与末尾 JSON）。",
            "说明：此类失败**不是** Playwright 的 locator 断言；可能是 MCP 工具不可用、User rejected MCP、JSON 内 ok:false、页面未达预期等。",
            "请结构化输出（供步骤 7 接续修复或给出用户侧操作）：",
            "- failure_type（例如：mcp_unavailable / tool_rejected / user_rejected_mcp / ui_check / api_health / timeout / agent_exit_error）",
            "- mcp_json_summary（若有）：引用输出末尾 JSON 中的 mode、ok、error、steps、ui、api）",
            "- root_cause（技术原因与责任边界：应用代码 vs MCP/Cursor 配置）",
            "- fix_plan（最小改动；若仅需改 MCP 配置/批准/Chrome，请写清操作步骤，勿假装修了业务代码）",
            "- handoff_to_step7（明确下一步应由「改代码」还是「改环境/MCP」完成）",
            "",
            truncate(lastTestOutput, 12000)
          ].join("\n")
        : failedDriver === "mobile_expo"
          ? [
              "以下是步骤5移动端测试（Expo + Jest/Detox）失败输出。",
              "请结构化输出：",
              "- failure_type（jest_fail / detox_fail / expo_env / script_error 等）",
              "- failed_test_name（若可提取）",
              "- root_cause",
              "- fix_plan(最小改动)",
              "- fallback（如 Detox 环境不足时如何保留 Jest 回归）",
              "",
              truncate(lastTestOutput, 12000)
            ].join("\n")
        : [
            "以下是步骤5项目测试（npx playwright test tests）失败输出。请结构化输出：",
            "- failed_test_name",
            "- assertion_type",
            "- locator",
            "- expected",
            "- received",
            "- root_cause",
            "- fix_plan(最小改动)",
            "",
            truncate(lastTestOutput, 12000)
          ].join("\n");

      if (should(6) && should(7)) {
        setStep(6, "active", `第 ${i} 轮失败分析`);
        const analysis = await runComposeStep(
          6,
          failedDriver === "cursor_mcp"
            ? "步骤6 失败根因分析（MCP）"
            : failedDriver === "mobile_expo"
              ? "步骤6 失败根因分析（Mobile）"
              : "步骤6 失败根因分析",
          step6PromptBody,
          180000,
          `failure_analysis_round_${i}`
        );
        if (!analysis.ok) {
          throw new Error(`步骤6失败: ${truncate(analysis.stderr || analysis.stdout, 600)}`);
        }
        await saveArtifact(
          `06_failure_analysis_round_${i}.md`,
          `${buildSkillHeader(run.steps[5], run.skillsContract)}${analysis.stdout}`
        );
        setStep(6, "done", `第 ${i} 轮根因定位完成`);
        {
          const analysisBrief = extractFailureAnalysisBrief(analysis.stdout);
          emitLog(
            `【步骤6】根因摘要：${
              analysisBrief ||
              "（未能从模型输出解析，请打开 .autoflow/06_failure_analysis_round_*.md）"
            }`,
            "run"
          );
        }
        emit(run.id, "structured_failure", {
          round: i,
          details: failureDetails,
          driver: failedDriver,
          mcpSummary: failedDriver === "cursor_mcp" ? mcpSummary : null,
          at: now()
        });

        setStep(7, "active", `第 ${i} 轮自动修复`);
        const step7Intro = failedDriver === "cursor_mcp"
          ? [
              "请根据步骤 6 的失败分析与下列原始输出执行最小化修复或给出可执行结论。",
              "步骤 5 来自 chrome-devtools-mcp / Cursor MCP：若根因是 MCP 未批准、User rejected MCP、CLI 未加载 MCP，则**优先**在结论中说明用户需在 Cursor 中完成的配置/批准；仅当根因明确为应用 HTTP/标题/API/页面逻辑时再改业务代码。",
              "硬性要求：不得修改测试意图；优先修业务代码（仅当适用时）；给出修复证据或环境配置说明与回归方式。",
              ""
            ].join("\n")
          : failedDriver === "mobile_expo"
            ? [
                "请根据失败分析与下列输出执行最小化修复（Expo + Jest/Detox）。",
                "硬性要求：优先修业务代码或测试脚本，不得删除测试意图；若 Detox 环境受限，需给出可执行降级方案并保留 Jest 回归。",
                ""
              ].join("\n")
          : [
              "请根据失败分析和原始输出执行最小化修复。",
              "硬性要求：不得修改测试意图；优先修业务代码；给出修复证据与回归说明。",
              ""
            ].join("\n");
        const fix = await runComposeStep(
          7,
          failedDriver === "cursor_mcp"
            ? "步骤7 自动修复代码（承接 MCP 失败分析）"
            : failedDriver === "mobile_expo"
              ? "步骤7 自动修复代码（承接移动端失败分析）"
              : "步骤7 自动修复代码",
          [
            step7Intro,
            "失败分析：",
            analysis.stdout,
            "",
            "原始失败输出：",
            truncate(lastTestOutput, 12000)
          ].join("\n"),
          8 * 60 * 1000,
          `auto_fix_round_${i}`
        );
        if (!fix.ok) {
          throw new Error(`步骤7失败: ${truncate(fix.stderr || fix.stdout, 600)}`);
        }
        await saveArtifact(
          `07_fix_round_${i}.md`,
          `${buildSkillHeader(run.steps[6], run.skillsContract)}${fix.stdout}`
        );
        setStep(7, "done", `第 ${i} 轮修复完成`);
        emit(run.id, "loop_round", {
          round: i,
          message: "失败分析与修复已完成，准备再次执行测试",
          at: now()
        });
      } else {
        setStep(6, "skipped", "本 run 未启用");
        setStep(7, "skipped", "本 run 未启用");
        throw new Error(
          `步骤5 第 ${i} 轮失败且未同时启用步骤 6 与 7，无法自动修复。输出摘要：\n${truncate(lastTestOutput, 800)}`
        );
      }
    }

    if (!passed) {
      if (should(8)) {
        setStep(8, "active", "汇总稳定性结果");
        setStep(8, "error", `达到最大迭代 ${run.maxIterations} 仍未通过`);
      } else {
        setStep(8, "skipped", "本 run 未启用");
      }
      throw new Error(
        `已达到最大迭代 ${run.maxIterations}，测试仍失败。最后输出：\n${truncate(run.lastFailure, 1200)}`
      );
    }

    if (should(8)) {
      setStep(8, "active", "汇总稳定性结果");
      setStep(8, "done", "系统稳定，流程完成");
      emitLog(
        `步骤8完成，skills: ${run.steps[7].requiredSkills.join(", ")}，CDP状态: ${run.cdp.lastStatus}`,
        "ok"
      );
    } else {
      setStep(8, "skipped", "本 run 未启用");
      emitLog(`流程完成（未启用步骤 8），CDP状态: ${run.cdp.lastStatus}`, "ok");
    }

    await finishRunCompleted();
  } catch (err) {
    if (controller.signal.aborted) {
      run.status = "stopped";
      run.finishedAt = now();
      run.error = createAbortError("运行被手动停止").message;
      emit(run.id, "run_stopped", { at: run.finishedAt });
      markFinished(run.id);
      return;
    }

    if (run.currentStep) {
      const step = run.steps.find((s) => s.id === run.currentStep);
      if (step && step.status === "active") {
        step.status = "error";
        step.hint = "执行失败";
        step.updatedAt = now();
        emit(run.id, "step_status", {
          stepId: step.id,
          status: step.status,
          hint: step.hint,
          requiredSkills: step.requiredSkills || [],
          at: step.updatedAt
        });
      }
    }

    run.status = "failed";
    run.finishedAt = now();
    run.error = err.message || String(err);
    if (!run.lastFailure) {
      run.lastFailure = truncate(run.error, 4000);
    }
    run.reportMarkdown = buildReport(run);
    await fs.writeFile(path.join(run.runDir, "report.md"), run.reportMarkdown, "utf-8");
    emit(run.id, "run_failed", {
      at: run.finishedAt,
      error: run.error
    });
    markFinished(run.id);
  }
}

function createInitialSteps() {
  return STEP_META.map((s) => ({
    id: s.id,
    key: s.key,
    title: s.title,
    requiredSkills: [],
    status: "pending",
    hint: "",
    updatedAt: now()
  }));
}

function createRunObject({
  id,
  requirement,
  model,
  workspacePath,
  maxIterations,
  projectPath = "",
  appPort = 4173,
  testsPath = "",
  smokeTestPath = "",
  enabledStepIds = [1, 2, 3, 4, 5, 6, 7, 8],
  useExistingWorkspace = false,
  cdpHeaded = false,
  cdpLingerMs = 3000,
  cdpDriver,
  targetPlatform = "web",
  appStack = "expo",
  appTestMode = "both"
}) {
  return {
    id,
    requirement,
    model,
    workspacePath,
    projectPath,
    appPort,
    testsPath,
    smokeTestPath,
    enabledStepIds: [...enabledStepIds].sort((a, b) => a - b),
    useExistingWorkspace: Boolean(useExistingWorkspace),
    cdpHeaded: Boolean(cdpHeaded),
    cdpLingerMs: Number.isFinite(Number(cdpLingerMs)) && Number(cdpLingerMs) >= 0 ? Number(cdpLingerMs) : 3000,
    cdpDriver: normalizeCdpDriver(cdpDriver),
    targetPlatform: normalizeTargetPlatform(targetPlatform),
    appStack: normalizeAppStack(appStack),
    appTestMode: normalizeAppTestMode(appTestMode),
    maxIterations,
    iterations: 0,
    status: "queued",
    currentStep: null,
    steps: createInitialSteps(),
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    lastFailure: "",
    error: "",
    skillsContract: null,
    cdp: null,
    mobile: null,
    reportMarkdown: "",
    runDir: "",
    abortController: null
  };
}

module.exports = {
  createRunObject,
  startRun,
  normalizeCdpDriver,
  normalizeTargetPlatform,
  normalizeAppStack,
  normalizeAppTestMode
};
