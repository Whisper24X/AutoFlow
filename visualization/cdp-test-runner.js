const { spawn } = require("child_process");
const path = require("path");
const net = require("net");
const http = require("http");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key.startsWith("--")) {
      args[key.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

/** 去掉无值的 --headed，避免 parseArgs 把下一项误当成 headed 的值 */
function argvWithoutHeadedFlag(argv) {
  return argv.filter((a, idx) => idx < 2 || a !== "--headed");
}

function waitPort(host, port, timeoutMs = 15000) {
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

function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || "pipe"
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** CDP HTTP/WebSocket 与 waitPort 一致，避免与 appHost 混用 */
const CDP_LOOPBACK = "127.0.0.1";

function listLivePages(context) {
  return context.pages().filter((p) => p && !p.isClosed());
}

async function waitForFirstLivePage(context, maxMs = 3000, intervalMs = 100) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const list = listLivePages(context);
    if (list.length > 0) return list;
    await sleep(intervalMs);
  }
  return [];
}

/**
 * 有头模式：先建「测试专用」标签页，再关掉 Chrome 自带的「新标签页」等，
 * 避免 goto 作用在不可见/非前台的 target 上，用户只看到 Google 新标签页。
 */
async function openDedicatedHeadedPage(context) {
  await waitForFirstLivePage(context, 2000, 80);
  const page = await context.newPage();
  await sleep(150);
  for (const p of listLivePages(context)) {
    if (p !== page) {
      try {
        await p.close();
      } catch {
        /* ignore */
      }
    }
  }
  return page;
}

function resolveDefaultContext(browser) {
  if (typeof browser.defaultBrowserContext === "function") {
    try {
      const d = browser.defaultBrowserContext();
      if (d) return d;
    } catch {
      /* ignore */
    }
  }
  const arr = browser.contexts();
  return arr[0] || null;
}

async function main() {
  const headed =
    process.argv.includes("--headed") ||
    String(process.env.AUTOFLOW_CDP_HEADED || "").trim() === "1";
  const args = parseArgs(argvWithoutHeadedFlag(process.argv));
  const workspace = path.resolve(args.workspace || process.cwd());
  const appHost = String(args.appHost || "127.0.0.1");
  const appPort = Number(args.appPort || 4173);
  // 默认避免与常见本机 Chrome / 其它工具抢占的 9222 冲突（可用 --cdpPort 覆盖）
  const cdpPort = Number(args.cdpPort || 19333);
  const timeoutMs = Number(args.timeoutMs || 120000);
  let lingerMs = Number.parseInt(String(args.lingerMs || "0"), 10);
  if (!Number.isFinite(lingerMs) || lingerMs < 0) lingerMs = 0;
  if (headed && lingerMs === 0) lingerMs = 3000;

  const startedAt = new Date().toISOString();
  const summary = {
    mode: "playwright-cdp-real-test",
    workspace,
    startedAt,
    appHost,
    appPort,
    cdpPort,
    appUrl: `http://${appHost}:${appPort}`,
    cdpUrl: `http://${CDP_LOOPBACK}:${cdpPort}`,
    headed,
    lingerMs,
    steps: [],
    ok: false
  };

  let appProc = null;
  let browserProc = null;
  const timeout = setTimeout(() => {
    throw new Error(`CDP test timed out in ${timeoutMs}ms`);
  }, timeoutMs);

  try {
    // 1) 启动待测应用
    appProc = spawnProcess("npm", ["start"], {
      cwd: workspace,
      stdio: "pipe",
      env: { PORT: String(appPort) }
    });
    summary.steps.push("start-app");

    let appStdErr = "";
    appProc.stderr.on("data", (c) => {
      appStdErr += c.toString();
    });

    await waitPort(appHost, appPort, 30000);
    summary.steps.push("app-ready");

    // 2) 启动 CDP 浏览器（Playwright bundled Chromium）
    const { chromium } = require("playwright");
    const executable = chromium.executablePath();
    const chromiumArgs = headed
      ? ["--no-sandbox", `--window-size=1280,800`, `--remote-debugging-port=${cdpPort}`]
      : ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${cdpPort}`];
    browserProc = spawnProcess(executable, chromiumArgs, {
      cwd: workspace,
      stdio: "ignore"
    });
    summary.steps.push("start-cdp-browser");

    await waitPort(CDP_LOOPBACK, cdpPort, 15000);
    await sleep(300);
    const cdpBaseUrl = `http://${CDP_LOOPBACK}:${cdpPort}`;
    const versionUrl = `${cdpBaseUrl}/json/version`;
    let versionInfo;
    try {
      versionInfo = await httpGetJson(versionUrl);
    } catch (e) {
      const cause = e?.message || String(e);
      throw new Error(
        `CDP endpoint not available: httpGet failed url=${versionUrl} cause=${cause}`
      );
    }
    if (!versionInfo.statusCode || versionInfo.statusCode >= 400) {
      const bodyPreview = (versionInfo.body || "").slice(0, 500);
      throw new Error(
        `CDP endpoint not available: status=${versionInfo.statusCode} url=${versionUrl} bodyPreview=${JSON.stringify(bodyPreview)}`
      );
    }
    summary.steps.push("cdp-ready");

    // 3) 使用 Playwright connectOverCDP 做真实 UI 测试
    const browser = await chromium.connectOverCDP(cdpBaseUrl);
    let context = resolveDefaultContext(browser);
    if (!context) {
      context = await browser.newContext();
    }

    let page;
    if (headed) {
      page = await openDedicatedHeadedPage(context);
    } else {
      const livePages = await waitForFirstLivePage(context);
      page = livePages.length > 0 ? livePages[0] : await context.newPage();
    }

    if (headed && typeof page.bringToFront === "function") {
      await page.bringToFront();
    }
    const resp = await page.goto(summary.appUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    if (headed && typeof page.bringToFront === "function") {
      await page.bringToFront();
    }
    const title = await page.title();
    summary.ui = {
      statusCode: resp?.status?.() || 0,
      title
    };
    if (!resp || !resp.ok()) {
      throw new Error(`UI check failed: status=${summary.ui.statusCode}`);
    }
    if (!title || title.trim().length === 0) {
      throw new Error("UI check failed: empty title");
    }
    summary.steps.push("ui-cdp-pass");

    // 4) API 真测（可选）
    const health = await httpGetJson(`http://${appHost}:${appPort}/api/health`, 4000);
    summary.api = {
      statusCode: health.statusCode,
      body: health.body.slice(0, 500)
    };
    if (health.statusCode === 200 && health.json?.ok === true) {
      summary.steps.push("api-health-pass");
    } else {
      summary.steps.push("api-health-skip-or-nonstandard");
    }

    if (lingerMs > 0) {
      summary.steps.push("linger-visible");
      await sleep(lingerMs);
    }

    await page.close();
    await browser.close();
    summary.ok = true;
    summary.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  } catch (error) {
    summary.ok = false;
    summary.error = error.message || String(error);
    summary.finishedAt = new Date().toISOString();
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  } finally {
    clearTimeout(timeout);
    if (appProc && !appProc.killed) appProc.kill("SIGTERM");
    if (browserProc && !browserProc.killed) browserProc.kill("SIGTERM");
  }
}

main();
