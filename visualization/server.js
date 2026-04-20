const express = require("express");
const http = require("http");
const { spawn, execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const fsSync = require("fs");
const crypto = require("crypto");
const { DEFAULT_MODEL } = require("./cursor-cli-adapter");
const {
  createRunObject,
  startRun,
  normalizeCdpDriver,
  normalizeTargetPlatform,
  normalizeAppStack,
  normalizeAppTestMode
} = require("./run-engine");

const app = express();
const port = process.env.PORT || 4180;
const baseDir = __dirname;
const repoRoot = path.resolve(baseDir, "..");

app.use(express.json({ limit: "1mb" }));

const runs = new Map();
const sseClients = new Map();
const orders = new Map();

/** @type {Map<string, { child: import("child_process").ChildProcess, port: number }>} */
const subProjectSpawnByPath = new Map();
/** @type {Set<string>} */
const subProjectStarting = new Set();

const UUID_DIR_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_READ_MAX = 256 * 1024;

const ORDER_STATUSES = new Set(["pending", "paid", "cancelled"]);

function publicOrder(order) {
  return {
    id: order.id,
    customerName: order.customerName,
    amount: order.amount,
    status: order.status,
    note: order.note,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

function parseOrderPayload(body, { partial }) {
  const errors = [];
  let customerName;
  let amount;
  let status;
  let note;

  if (!partial || body.customerName !== undefined) {
    customerName = String(body?.customerName ?? "").trim();
    if (!customerName) errors.push("customerName 不能为空");
  }

  if (!partial || body.amount !== undefined) {
    const raw = body?.amount;
    amount = typeof raw === "string" ? Number.parseFloat(raw) : Number(raw);
    if (!Number.isFinite(amount) || amount < 0) errors.push("amount 须为非负数字");
  }

  if (!partial || body.status !== undefined) {
    status = String(body?.status ?? "").trim() || "pending";
    if (!ORDER_STATUSES.has(status)) errors.push("status 须为 pending、paid 或 cancelled");
  }

  if (body?.note !== undefined) {
    note = String(body.note ?? "");
  } else if (!partial) {
    note = "";
  }

  return { errors, customerName, amount, status, note };
}

function ensureInsideRepo(targetPath) {
  const normalized = path.resolve(targetPath);
  const relative = path.relative(repoRoot, normalized);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isUnderProjectsRoot(absPath, projectsRootAbs) {
  const child = path.resolve(absPath);
  const root = path.resolve(projectsRootAbs);
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveExistingProjectWorkspace(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const projectsRootAbs = path.resolve(baseDir, "projects");
  let candidate;
  if (path.isAbsolute(trimmed)) {
    candidate = path.resolve(trimmed);
  } else {
    candidate = path.resolve(repoRoot, trimmed);
    if (!isUnderProjectsRoot(candidate, projectsRootAbs)) {
      candidate = path.resolve(projectsRootAbs, trimmed);
    }
  }
  if (!isUnderProjectsRoot(candidate, projectsRootAbs)) {
    throw new Error("已有项目目录必须位于 visualization/projects 下");
  }
  if (!ensureInsideRepo(candidate)) {
    throw new Error("已有项目目录不在仓库内");
  }
  let st;
  try {
    st = await fs.stat(candidate);
  } catch {
    throw new Error("已有项目目录不存在或不可访问");
  }
  if (!st.isDirectory()) {
    throw new Error("已有项目路径不是目录");
  }
  return candidate;
}

function slugifyRequirement(input) {
  const normalized = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const asciiOnly = normalized
    .replace(/[\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = (asciiOnly || "untitled").slice(0, 40).replace(/-+$/g, "");
  return safe || "untitled";
}

function pickProjectPort(runId) {
  const base = 4300;
  const range = 1000;
  let hash = 0;
  for (const ch of runId) {
    hash = (hash * 31 + ch.charCodeAt(0)) % range;
  }
  return base + hash;
}

function pushEvent(runId, type, payload) {
  const run = runs.get(runId);
  if (!run) return;
  const evt = {
    id: ++run.lastEventId,
    type,
    payload,
    at: new Date().toISOString()
  };
  run.events.push(evt);
  if (run.events.length > 2000) {
    run.events = run.events.slice(-1200);
  }

  const clients = sseClients.get(runId) || [];
  for (const res of clients) {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
}

function publicRun(run) {
  return {
    id: run.id,
    status: run.status,
    model: run.model,
    requirement: run.requirement,
    workspacePath: run.workspacePath,
    maxIterations: run.maxIterations,
    iterations: run.iterations,
    currentStep: run.currentStep,
    steps: run.steps,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    lastFailure: run.lastFailure,
    projectPath: run.projectPath,
    appPort: run.appPort,
    enabledStepIds: run.enabledStepIds,
    skillsContract: run.skillsContract,
    cdp: run.cdp,
    reportMarkdown: run.reportMarkdown,
    useExistingWorkspace: Boolean(run.useExistingWorkspace),
    cdpHeaded: Boolean(run.cdpHeaded),
    cdpLingerMs: run.cdpLingerMs,
    cdpDriver: run.cdpDriver || "playwright",
    targetPlatform: run.targetPlatform || "web",
    appStack: run.appStack || "expo",
    appTestMode: run.appTestMode || "both",
    mobile: run.mobile || null,
    artifactDir:
      run.runDir ||
      (run.workspacePath ? path.join(run.workspacePath, ".autoflow") : "")
  };
}

const DEFAULT_ENABLED_STEPS = [1, 2, 3, 4, 5, 6, 7, 8];

function parseEnabledStepIds(body) {
  const raw = body?.enabledStepIds;
  if (raw === undefined || raw === null) return [...DEFAULT_ENABLED_STEPS];
  if (!Array.isArray(raw)) {
    throw new Error("enabledStepIds 须为数组");
  }
  if (raw.length === 0) {
    throw new Error(
      "enabledStepIds 不能为空；省略该字段表示默认全选（步骤 1–8）"
    );
  }
  const ids = [];
  for (const x of raw) {
    const n = typeof x === "number" ? x : Number.parseInt(String(x), 10);
    if (!Number.isFinite(n) || n < 1 || n > 8) {
      throw new Error(`enabledStepIds 含非法步骤（仅允许 1–8）: ${String(x)}`);
    }
    ids.push(n);
  }
  const uniq = [...new Set(ids)].sort((a, b) => a - b);
  if (!uniq.includes(1)) uniq.unshift(1);
  uniq.sort((a, b) => a - b);
  const set = new Set(uniq);
  if (set.has(7) && (!set.has(6) || !set.has(5))) {
    throw new Error("启用步骤 7 时必须同时启用步骤 5 与 6");
  }
  if (set.has(6) && !set.has(5)) {
    throw new Error("启用步骤 6 时必须启用步骤 5");
  }
  return [...set].sort((a, b) => a - b);
}

function markFinished(runId) {
  // 运行结束后保留 SSE 连接，前端可继续拉取最终事件与报告。
  pushEvent(runId, "run_snapshot", publicRun(runs.get(runId)));
}

function parseReportLine(reportText, prefix) {
  const lines = String(reportText || "").split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return "";
}

function extractRequirementPreview(reportText) {
  const text = String(reportText || "");
  const idx = text.search(/^## 需求\s*$/m);
  if (idx === -1) return "";
  const rest = text.slice(idx).split(/\r?\n/).slice(1);
  const buf = [];
  for (const line of rest) {
    if (/^## /.test(line)) break;
    const t = line.trim();
    if (t) buf.push(t);
    if (buf.length >= 2) break;
  }
  const joined = buf.join(" ").trim();
  return joined.length > 160 ? `${joined.slice(0, 157)}...` : joined;
}

function normalizeAppUrl(baseUrlFromReport, appPort) {
  const fromReport = String(baseUrlFromReport || "").trim();
  if (/^https?:\/\//i.test(fromReport)) {
    return fromReport.replace(/\/+$/, "") + "/";
  }
  const p = Number.parseInt(String(appPort), 10);
  if (!Number.isFinite(p) || p <= 0 || p > 65535) return "";
  return `http://127.0.0.1:${p}/`;
}

/**
 * 读取单个 report.md，若为 completed 则返回列表项（含 sortKey）；否则 null。
 * @param {string} reportPath
 * @param {string} listId 列表主键：新项目为项目目录名，旧数据为 runs 下 UUID
 */
async function readCompletedReportEntry(reportPath, listId) {
  if (!ensureInsideRepo(reportPath)) return null;

  let raw;
  try {
    raw = await fs.readFile(reportPath, "utf-8");
  } catch {
    return null;
  }
  if (raw.length > REPORT_READ_MAX) {
    raw = raw.slice(0, REPORT_READ_MAX);
  }

  const status = parseReportLine(raw, "- 状态:");
  if (status !== "completed") return null;

  const projectPathRaw = parseReportLine(raw, "- 项目目录:");
  const projectPathResolved = projectPathRaw ? path.resolve(projectPathRaw) : "";
  const projectPath =
    projectPathRaw && projectPathResolved && ensureInsideRepo(projectPathResolved)
      ? projectPathResolved
      : "";

  const portStr = parseReportLine(raw, "- 应用端口:");
  const appPort = Number.parseInt(portStr, 10);
  const baseUrlLine = parseReportLine(raw, "- baseUrl:");
  const appUrl = normalizeAppUrl(baseUrlLine, Number.isFinite(appPort) ? appPort : portStr);
  const targetPlatform = parseReportLine(raw, "- 目标平台:") || "web";
  const appStack = parseReportLine(raw, "- App 技术栈:") || "";
  const appTestMode = parseReportLine(raw, "- App 测试模式:") || "";

  const finishedAt = parseReportLine(raw, "- 结束:") || null;
  const startedAt = parseReportLine(raw, "- 开始:") || null;
  const requirementPreview = extractRequirementPreview(raw);

  let sortKey = 0;
  const parsed = Date.parse(finishedAt || "");
  if (Number.isFinite(parsed)) sortKey = parsed;
  else {
    try {
      const st = await fs.stat(reportPath);
      sortKey = st.mtimeMs;
    } catch {
      sortKey = 0;
    }
  }

  return {
    id: listId,
    status: "completed",
    finishedAt,
    startedAt,
    projectPath,
    appPort: Number.isFinite(appPort) ? appPort : null,
    appUrl,
    targetPlatform,
    appStack,
    appTestMode,
    requirementPreview,
    sortKey
  };
}

function mergeCompletedEntry(map, entry) {
  const key = entry.projectPath || entry.id || entry.sortKey;
  const prev = map.get(key);
  if (!prev || entry.sortKey >= prev.sortKey) {
    map.set(key, entry);
  }
}

/**
 * 列出 visualization/projects 下的子目录，供前端下拉选择「已有项目」。
 * path 为相对仓库根目录，与 POST /api/runs 的 existingProjectPath 一致。
 */
async function listProjectDirsFromDisk() {
  const projectsRoot = path.join(baseDir, "projects");
  const out = [];
  try {
    const ents = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const full = path.join(projectsRoot, ent.name);
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const rel = path.relative(repoRoot, full);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      out.push({
        name: ent.name,
        path: rel.split(path.sep).join("/"),
        mtimeMs: st.mtimeMs
      });
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.map(({ name, path: p }) => ({ name, path: p }));
}

async function listCompletedRunsFromDisk() {
  const byKey = new Map();

  const runsRoot = path.join(baseDir, "runs");
  try {
    const entries = await fs.readdir(runsRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || !UUID_DIR_RE.test(ent.name)) continue;
      const reportPath = path.resolve(runsRoot, ent.name, "report.md");
      const entry = await readCompletedReportEntry(reportPath, ent.name);
      if (entry) mergeCompletedEntry(byKey, entry);
    }
  } catch {
    // runs 目录不存在时忽略
  }

  const projectsRoot = path.join(baseDir, "projects");
  try {
    const pents = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const e of pents) {
      if (!e.isDirectory()) continue;
      const reportPath = path.resolve(projectsRoot, e.name, ".autoflow", "report.md");
      const entry = await readCompletedReportEntry(reportPath, e.name);
      if (entry) mergeCompletedEntry(byKey, entry);
    }
  } catch {
    // projects 目录不存在时忽略
  }

  const out = [...byKey.values()];
  out.sort((a, b) => b.sortKey - a.sortKey);
  return out.map(({ sortKey: _ignored, ...rest }) => rest);
}

async function sendCompletedRunsList(_req, res) {
  try {
    const list = await listCompletedRunsFromDisk();
    res.json({ runs: list });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}

/**
 * 探测本机被测应用是否在监听（流水线结束后子进程常已退出，链接会打不开）。
 * GET /api/probe-app?port=4774
 */
app.get("/api/probe-app", (req, res) => {
  const port = Number.parseInt(String(req.query.port || ""), 10);
  const targetPlatform = String(req.query.targetPlatform || "web")
    .trim()
    .toLowerCase();
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    res.status(400).json({ error: "port 参数无效" });
    return;
  }
  const probe = http.get(
    {
      hostname: "127.0.0.1",
      port,
      path: "/api/health",
      timeout: 2000,
      agent: false
    },
    (r) => {
      const ok = r.statusCode === 200;
      r.resume();
      if (!ok && (targetPlatform === "app" || targetPlatform === "web_app")) {
        const fallback = http.get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/",
            timeout: 2000,
            agent: false
          },
          (r2) => {
            const ok2 = Number(r2.statusCode) >= 200 && Number(r2.statusCode) < 500;
            r2.resume();
            if (!res.headersSent) {
              res.json({
                ok: ok2,
                port,
                statusCode: r2.statusCode,
                reason: ok2
                  ? "在线（APP 模式，未检测 /api/health）"
                  : `HTTP ${r2.statusCode}（APP 模式探测 /）`
              });
            }
          }
        );
        fallback.on("error", (err2) => {
          if (res.headersSent) return;
          res.json({
            ok: false,
            port,
            reason:
              err2.code === "ECONNREFUSED"
                ? "未监听（需在本机启动子项目）"
                : err2.message || String(err2)
          });
        });
        fallback.on("timeout", () => {
          fallback.destroy();
          if (!res.headersSent) {
            res.json({ ok: false, port, reason: "探测超时" });
          }
        });
        fallback.setTimeout(2000);
        return;
      }
      if (!res.headersSent) {
        res.json({
          ok,
          port,
          statusCode: r.statusCode,
          reason: ok
            ? undefined
            : `HTTP ${r.statusCode}（需存在 /api/health 且返回 200）`
        });
      }
    }
  );
  probe.on("error", (err) => {
    if (res.headersSent) return;
    res.json({
      ok: false,
      port,
      reason: err.code === "ECONNREFUSED" ? "未监听（需在本机启动子项目）" : err.message || String(err)
    });
  });
  probe.on("timeout", () => {
    probe.destroy();
    if (!res.headersSent) {
      res.json({ ok: false, port, reason: "探测超时" });
    }
  });
  probe.setTimeout(2000);
});

function getAndroidSdkRoot() {
  return (
    process.env.ANDROID_SDK_ROOT ||
    process.env.ANDROID_HOME ||
    path.join(os.homedir(), "Library", "Android", "sdk")
  );
}

function getAdbCandidates() {
  const sdk = getAndroidSdkRoot();
  const adbName = process.platform === "win32" ? "adb.exe" : "adb";
  return [path.join(sdk, "platform-tools", adbName), adbName];
}

function getEmulatorCandidates() {
  const sdk = getAndroidSdkRoot();
  const emuName = process.platform === "win32" ? "emulator.exe" : "emulator";
  return [path.join(sdk, "emulator", emuName), emuName];
}

function execFileText(bin, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
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

async function runWithCandidates(candidates, args, timeoutMs = 4000) {
  for (const bin of candidates) {
    const absolute = path.isAbsolute(bin);
    if (absolute && !fsSync.existsSync(bin)) continue;
    const out = await execFileText(bin, args, timeoutMs);
    if (out.ok) return { ...out, bin };
    const missing = /not found|ENOENT|is not recognized/i.test(`${out.error}\n${out.stderr}`);
    if (!missing) return { ...out, bin };
  }
  return {
    ok: false,
    stdout: "",
    stderr: "",
    error: "adb 不可用（请安装 Android Platform Tools）",
    bin: ""
  };
}

function parseAdbDevices(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (line.toLowerCase().startsWith("list of devices")) continue;
    const m = line.match(/^(\S+)\s+(\S+)$/);
    if (!m) continue;
    out.push({ serial: m[1], state: m[2] });
  }
  return out;
}

function parseAvdList(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickAndroidAvdName(avds) {
  const envName = String(process.env.AUTOFLOW_ANDROID_AVD || "").trim();
  if (envName && avds.includes(envName)) return envName;
  return avds[0] || "";
}

function getPreferredLanIp() {
  const nets = os.networkInterfaces();
  const preferredPrefix = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/;
  /** @type {string[]} */
  const candidates = [];
  for (const list of Object.values(nets || {})) {
    for (const n of list || []) {
      if (!n || n.family !== "IPv4" || n.internal) continue;
      if (preferredPrefix.test(n.address)) return n.address;
      candidates.push(n.address);
    }
  }
  return candidates[0] || "127.0.0.1";
}

async function openExpoDeepLinkOnAndroid(deviceSerial, portNum) {
  const urls = [
    `exp://10.0.2.2:${portNum}`,
    `exp://${getPreferredLanIp()}:${portNum}`
  ];
  for (const expUrl of urls) {
    const openRes = await runWithCandidates(
      getAdbCandidates(),
      [
        "-s",
        deviceSerial,
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        expUrl
      ],
      8000
    );
    if (openRes.ok) {
      return { ok: true, usedUrl: expUrl };
    }
  }
  return { ok: false, usedUrl: urls[0] };
}

async function waitForAndroidDeviceReady(timeoutMs = 45000) {
  const started = Date.now();
  let launchedAvd = "";
  let lastState = "unknown";
  while (Date.now() - started < timeoutMs) {
    const adbList = await runWithCandidates(getAdbCandidates(), ["devices"], 5000);
    if (adbList.ok) {
      const devices = parseAdbDevices(adbList.stdout);
      const emulator = devices.find((d) => d.serial.startsWith("emulator-")) || devices[0];
      if (emulator) {
        lastState = emulator.state;
        if (emulator.state === "device") {
          return {
            ok: true,
            serial: emulator.serial,
            state: emulator.state,
            launchedAvd,
            reason: launchedAvd ? `已自动拉起模拟器：${launchedAvd}` : "检测到已连接设备"
          };
        }
        if (emulator.state === "unauthorized") {
          return {
            ok: false,
            serial: emulator.serial,
            state: emulator.state,
            launchedAvd,
            reason: "设备未授权，请在模拟器确认 ADB 授权"
          };
        }
      }
    }

    if (!launchedAvd) {
      const emuList = await runWithCandidates(getEmulatorCandidates(), ["-list-avds"], 7000);
      if (emuList.ok) {
        const avds = parseAvdList(emuList.stdout);
        const chosen = pickAndroidAvdName(avds);
        if (chosen) {
          for (const emuBin of getEmulatorCandidates()) {
            const absolute = path.isAbsolute(emuBin);
            if (absolute && !fsSync.existsSync(emuBin)) continue;
            try {
              const child = spawn(emuBin, [`@${chosen}`], {
                detached: true,
                stdio: "ignore",
                windowsHide: true
              });
              child.unref();
              launchedAvd = chosen;
              break;
            } catch {
              /* try next candidate */
            }
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return {
    ok: false,
    serial: "",
    state: lastState,
    launchedAvd,
    reason: launchedAvd ? `模拟器 ${launchedAvd} 启动超时` : "未检测到可用设备，且未能自动启动模拟器"
  };
}

function probeHttp(port, pathName, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        timeout: timeoutMs,
        agent: false
      },
      (r) => {
        const statusCode = Number(r.statusCode || 0);
        r.resume();
        resolve({ ok: statusCode >= 200 && statusCode < 500, statusCode });
      }
    );
    req.on("error", (err) => resolve({ ok: false, reason: err.message || String(err), statusCode: 0 }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "探测超时", statusCode: 0 });
    });
    req.setTimeout(timeoutMs);
  });
}

/**
 * App 运行层探测：服务监听 + Expo 进程 + ADB + Expo Go（仅 Android）
 * GET /api/probe-mobile?port=4774&projectPath=<abs path>&targetPlatform=app
 */
app.get("/api/probe-mobile", async (req, res) => {
  const port = Number.parseInt(String(req.query.port || ""), 10);
  const projectPath = String(req.query.projectPath || "").trim();
  const targetPlatform = String(req.query.targetPlatform || "app")
    .trim()
    .toLowerCase();
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    res.status(400).json({ error: "port 参数无效" });
    return;
  }

  const health = await probeHttp(port, "/api/health");
  let service = {
    ok: health.statusCode === 200,
    statusCode: health.statusCode || 0,
    reason: health.statusCode === 200 ? "在线（/api/health=200）" : health.reason || "未监听"
  };
  if (!service.ok && (targetPlatform === "app" || targetPlatform === "web_app")) {
    const rootProbe = await probeHttp(port, "/");
    if (rootProbe.ok) {
      service = {
        ok: true,
        statusCode: rootProbe.statusCode || 0,
        reason: "在线（APP 模式，检测 /）"
      };
    }
  }

  let trackedPid = null;
  if (projectPath) {
    const entry = subProjectSpawnByPath.get(path.resolve(projectPath));
    if (entry && entry.child && entry.child.exitCode === null) {
      trackedPid = Number(entry.child.pid || 0) || null;
    }
  }
  const pids = await pidsListeningOnPort(port);
  const listenerPid = pids.length > 0 ? pids[0] : null;
  const expo = {
    ok: Boolean(trackedPid || listenerPid),
    pid: trackedPid || listenerPid || null,
    source: trackedPid ? "tracked" : listenerPid ? "port_listener" : "none"
  };

  let adb = {
    ok: false,
    state: "unknown",
    serial: "",
    reason: "未检测"
  };
  let expoGo = {
    installed: false,
    running: false,
    reason: "未检测"
  };

  const adbList = await runWithCandidates(getAdbCandidates(), ["devices"]);
  if (!adbList.ok) {
    adb.reason = adbList.error || adbList.stderr || "adb 调用失败";
  } else {
    const devices = parseAdbDevices(adbList.stdout);
    const emulatorDevice = devices.find((d) => d.serial.startsWith("emulator-")) || devices[0];
    if (!emulatorDevice) {
      adb.state = "no_device";
      adb.reason = "未发现 Android 设备/模拟器";
    } else {
      adb.serial = emulatorDevice.serial;
      adb.state = emulatorDevice.state;
      adb.ok = emulatorDevice.state === "device";
      adb.reason =
        emulatorDevice.state === "device"
          ? "设备已连接"
          : emulatorDevice.state === "unauthorized"
            ? "设备未授权（请在模拟器确认 ADB 授权）"
            : emulatorDevice.state;
      if (emulatorDevice.state === "device") {
        const pkgCheck = await runWithCandidates(
          getAdbCandidates(),
          ["-s", emulatorDevice.serial, "shell", "pm", "list", "packages", "host.exp.exponent"],
          5000
        );
        if (pkgCheck.ok && /host\.exp\.exponent/.test(pkgCheck.stdout)) {
          expoGo.installed = true;
          expoGo.reason = "已安装";
          const pidCheck = await runWithCandidates(
            getAdbCandidates(),
            ["-s", emulatorDevice.serial, "shell", "pidof", "host.exp.exponent"],
            3000
          );
          expoGo.running = pidCheck.ok && Boolean(String(pidCheck.stdout || "").trim());
          if (expoGo.running) expoGo.reason = "运行中";
        } else {
          expoGo.reason = "未安装 Expo Go";
        }
      }
    }
  }

  let nextAction = "";
  let severity = "ok";
  if (!service.ok) {
    severity = "off";
    nextAction = "先点击“启动子项目”，确认端口在线后再查看移动端状态";
  } else if (!expo.ok) {
    severity = "off";
    nextAction = "未检测到 Expo 进程，请重新启动子项目";
  } else if (adb.state === "no_device") {
    severity = "warn";
    nextAction = "请先启动 Android 模拟器（或连接真机）";
  } else if (adb.state === "unauthorized") {
    severity = "warn";
    nextAction = "请在模拟器确认 ADB 授权（或重启 adb）";
  } else if (adb.state === "device" && !expoGo.installed) {
    severity = "warn";
    nextAction = "请先在模拟器安装 Expo Go";
  } else if (adb.state === "device" && expoGo.installed && !expoGo.running) {
    severity = "warn";
    nextAction = "已连接设备，执行 `npx expo start --android --port <端口>` 打开 App";
  }

  res.json({
    ok: severity === "ok",
    severity,
    port,
    service,
    expo,
    adb,
    expoGo,
    nextAction
  });
});

/**
 * 本机端口是否已有健康检查（与 GET /api/probe-app 判定一致）。
 * @param {number} port
 */
function probeLocalHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/health",
        timeout: 2000,
        agent: false
      },
      (r) => {
        const ok = r.statusCode === 200;
        r.resume();
        resolve(ok);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.setTimeout(2000);
  });
}

/**
 * 本机监听指定 TCP 端口的进程 PID（不含当前 Node 进程）。依赖 lsof（macOS/Linux）或 PowerShell（Windows）。
 * @param {number} tcpPort
 * @returns {Promise<number[]>}
 */
function pidsListeningOnPort(tcpPort) {
  return new Promise((resolve) => {
    const parsePids = (stdout) => {
      const text = stdout.toString().trim();
      if (!text) return [];
      return [
        ...new Set(
          text
            .split(/\r?\n/)
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)
        ),
      ];
    };

    if (process.platform === "win32") {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-NetTCPConnection -LocalPort ${tcpPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique`,
        ],
        { windowsHide: true },
        (err, stdout) => {
          if (err) return resolve([]);
          resolve(parsePids(stdout));
        }
      );
      return;
    }

    execFile(
      "lsof",
      ["-t", `-iTCP:${tcpPort}`, "-sTCP:LISTEN"],
      { windowsHide: true },
      (err, stdout) => {
        if (!err && stdout.toString().trim()) {
          return resolve(parsePids(stdout));
        }
        execFile(
          "lsof",
          ["-ti", `:${tcpPort}`],
          { windowsHide: true },
          (err2, stdout2) => {
            if (err2) return resolve([]);
            resolve(parsePids(stdout2));
          }
        );
      }
    );
  });
}

/**
 * @param {number} pid
 * @returns {Promise<void>}
 */
function killPidForStop(pid) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true },
        () => resolve()
      );
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    resolve();
  });
}

async function validateSubprojectDirForSpawn(absPath) {
  const projectsRoot = path.resolve(baseDir, "projects");
  const resolved = path.resolve(absPath);
  if (!ensureInsideRepo(resolved)) {
    throw new Error("路径不在仓库内");
  }
  if (!isUnderProjectsRoot(resolved, projectsRoot)) {
    throw new Error("仅允许 visualization/projects 下的子项目");
  }
  let st;
  try {
    st = await fs.stat(resolved);
  } catch {
    throw new Error("项目目录不存在");
  }
  if (!st.isDirectory()) {
    throw new Error("项目路径不是目录");
  }
  try {
    await fs.access(path.join(resolved, "package.json"));
  } catch {
    throw new Error("项目目录缺少 package.json");
  }
  return resolved;
}

/**
 * 一键启动子项目：在指定目录执行 npm run start，并设置 PORT。
 * POST /api/start-subproject  body: { projectPath, port }
 */
app.post("/api/start-subproject", async (req, res) => {
  let absPathForStart = null;
  try {
    const body = req.body || {};
    const rawPath = String(body.projectPath || "").trim();
    const targetPlatform = normalizeTargetPlatform(body.targetPlatform || "web");
    const autoLaunchAndroid = body.autoLaunchAndroid !== false;
    const portNum = Number.parseInt(String(body.port ?? ""), 10);
    /** @type {string[]} */
    const setupNotes = [];
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      res.status(400).json({ error: "port 无效" });
      return;
    }
    if (!rawPath) {
      res.status(400).json({ error: "缺少 projectPath" });
      return;
    }

    const absPath = await validateSubprojectDirForSpawn(path.resolve(rawPath));

    if (subProjectStarting.has(absPath)) {
      res.status(429).json({ error: "正在启动中，请稍候再试" });
      return;
    }

    const healthy = await probeLocalHealth(portNum);
    if (healthy) {
      if (autoLaunchAndroid && (targetPlatform === "app" || targetPlatform === "web_app")) {
        const device = await waitForAndroidDeviceReady(50000);
        setupNotes.push(device.reason);
        if (device.ok && device.serial) {
          const openRes = await openExpoDeepLinkOnAndroid(device.serial, portNum);
          if (openRes.ok) {
            setupNotes.push(`已尝试在模拟器打开 ${openRes.usedUrl}`);
          } else {
            setupNotes.push("已启动模拟器，但自动打开 Expo Go 失败，请手动打开 Expo Go");
          }
        }
      }
      console.log(`[AutoFlow] 端口 ${portNum} 已在监听 /api/health，跳过启动`);
      res.json({
        ok: true,
        skipped: true,
        port: portNum,
        setupNotes,
        message: "该端口已可访问 /api/health，无需重复启动"
      });
      return;
    }

    const existing = subProjectSpawnByPath.get(absPath);
    if (existing && existing.child && existing.child.exitCode === null) {
      console.log(
        `[AutoFlow] 子项目已在运行 PORT=${existing.port} PID=${existing.child.pid}`
      );
      res.json({
        ok: true,
        alreadyRunning: true,
        pid: existing.child.pid,
        port: existing.port,
        message: `该子项目已由本平台启动（PID ${existing.child.pid}，端口 ${existing.port}）`
      });
      return;
    }

    subProjectStarting.add(absPath);
    absPathForStart = absPath;

    const logFile = path.join(absPath, ".autoflow", "subproject-server.log");
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    // spawn 的 stdio 需要数字 fd；createWriteStream 在打开完成前 fd 可能为 null，会报错
    let logFd = fsSync.openSync(logFile, "a");
    let logFdClosed = false;
    const closeLogFd = () => {
      if (logFdClosed) return;
      logFdClosed = true;
      try {
        fsSync.closeSync(logFd);
      } catch {
        /* ignore */
      }
    };
    let startCommand = "npm run start";
    let startArgs = ["run", "start"];
    let startBin = process.platform === "win32" ? "npm.cmd" : "npm";
    /** @type {Record<string,string>} */
    const extraEnv = {};
    try {
      const packageJsonPath = path.join(absPath, "package.json");
      const rawPkg = await fs.readFile(packageJsonPath, "utf-8");
      const parsedPkg = JSON.parse(rawPkg);
      const startScript = String(parsedPkg?.scripts?.start || "").trim();
      const hasNodeWebServer = fsSync.existsSync(path.join(absPath, "src", "server.js"));

      if (targetPlatform === "web" && hasNodeWebServer) {
        // Web 调试优先走 node src/server.js，避免 expo web 场景下静态路由与 ESM 入口不一致。
        startCommand = "node src/server.js (web-preferred)";
        startArgs = [path.join("src", "server.js")];
        startBin = process.execPath;
      } else
      if (startScript === "expo start" || startScript === "npx expo start") {
        const hasExpoDep =
          Boolean(parsedPkg?.dependencies?.expo) ||
          Boolean(parsedPkg?.devDependencies?.expo);
        const hasExpoEntry =
          fsSync.existsSync(path.join(absPath, "App.js")) ||
          fsSync.existsSync(path.join(absPath, "App.jsx")) ||
          fsSync.existsSync(path.join(absPath, "App.tsx")) ||
          fsSync.existsSync(path.join(absPath, "app"));

        if (hasExpoDep && hasExpoEntry) {
          const shouldOpenAndroid =
            autoLaunchAndroid && (targetPlatform === "app" || targetPlatform === "web_app");
          if (shouldOpenAndroid) {
            const device = await waitForAndroidDeviceReady(50000);
            setupNotes.push(device.reason);
            startCommand = "CI=1 EXPO_NO_DOCTOR=1 npx expo start --android --port <PORT>";
            startArgs = ["expo", "start", "--android", "--port", String(portNum)];
          } else {
            startCommand = "CI=1 EXPO_NO_DOCTOR=1 npx expo start --port <PORT>";
            startArgs = ["expo", "start", "--port", String(portNum)];
          }
          extraEnv.CI = "1";
          extraEnv.EXPO_NO_DOCTOR = "1";
          startBin = process.platform === "win32" ? "npx.cmd" : "npx";
        } else if (hasNodeWebServer) {
          // 一些项目在步骤生成中会保留 Web 骨架，但 start 脚本被写成 expo。
          // 对这类“伪 Expo 项目”回退到 Node 服务，避免启动即崩溃导致地址不可访问。
          startCommand = "node src/server.js (fallback)";
          startArgs = [path.join("src", "server.js")];
          startBin = process.execPath;
        }
      }
    } catch {
      /* ignore package.json parse error, fallback npm run start */
    }
    fsSync.writeSync(
      logFd,
      Buffer.from(
        `\n--- ${new Date().toISOString()} ${startCommand} (PORT=${portNum}) via AutoFlow ---\n`,
        "utf8"
      )
    );
    if (setupNotes.length) {
      fsSync.writeSync(
        logFd,
        Buffer.from(`${setupNotes.map((s) => `[setup] ${s}`).join("\n")}\n`, "utf8")
      );
    }

    let child;
    try {
      child = spawn(startBin, startArgs, {
        cwd: absPath,
        env: { ...process.env, ...extraEnv, PORT: String(portNum) },
        stdio: ["ignore", logFd, logFd]
      });
    } catch (spawnErr) {
      closeLogFd();
      throw spawnErr;
    }

    subProjectSpawnByPath.set(absPath, { child, port: portNum });

    console.log(
      `[AutoFlow] 子项目已启动 PID=${child.pid} PORT=${portNum} → http://127.0.0.1:${portNum}/`
    );
    console.log(`[AutoFlow] 子项目目录: ${absPath}`);

    child.on("exit", (code, signal) => {
      console.log(
        `[AutoFlow] 子项目进程结束 PORT=${portNum} PID=${child.pid} code=${code} signal=${signal ?? ""}`
      );
      try {
        fsSync.writeSync(
          logFd,
          Buffer.from(`--- exited code=${code} signal=${signal ?? ""} ---\n`, "utf8")
        );
      } catch {
        /* ignore */
      }
      closeLogFd();
      const cur = subProjectSpawnByPath.get(absPath);
      if (cur && cur.child === child) {
        subProjectSpawnByPath.delete(absPath);
      }
    });
    child.on("error", (err) => {
      try {
        fsSync.writeSync(
          logFd,
          Buffer.from(`--- spawn error: ${err.message} ---\n`, "utf8")
        );
      } catch {
        /* ignore */
      }
      closeLogFd();
      const cur = subProjectSpawnByPath.get(absPath);
      if (cur && cur.child === child) {
        subProjectSpawnByPath.delete(absPath);
      }
    });

    res.json({
      ok: true,
      pid: child.pid,
      port: portNum,
      setupNotes,
      logRelative: ".autoflow/subproject-server.log",
      message: `已启动子项目（PID ${child.pid}），日志写入 .autoflow/subproject-server.log`
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: err.message || String(err) });
    }
  } finally {
    if (absPathForStart) {
      subProjectStarting.delete(absPathForStart);
    }
  }
});

/**
 * 停止子项目：优先结束本平台记录的 spawn；若无记录则按端口结束监听进程（解决「启动被跳过 / 可视化重启后无记录」）。
 * POST /api/stop-subproject  body: { projectPath, port? }
 */
app.post("/api/stop-subproject", async (req, res) => {
  try {
    const rawPath = String(req.body?.projectPath || "").trim();
    const portRaw = req.body?.port;
    const portNum =
      portRaw != null && portRaw !== ""
        ? Number.parseInt(String(portRaw), 10)
        : NaN;

    if (!rawPath) {
      res.status(400).json({ error: "缺少 projectPath" });
      return;
    }
    const absPath = await validateSubprojectDirForSpawn(path.resolve(rawPath));
    const platformPort = Number.parseInt(String(port), 10);

    const entry = subProjectSpawnByPath.get(absPath);
    if (entry && entry.child && entry.child.exitCode === null) {
      const { child, port: stoppedPort } = entry;
      try {
        child.kill("SIGTERM");
      } catch (killErr) {
        res.status(500).json({ error: killErr.message || String(killErr) });
        return;
      }
      console.log(
        `[AutoFlow] 已请求停止子项目（记录内）PID=${child.pid} PORT=${stoppedPort}`
      );
      res.json({
        ok: true,
        via: "tracked",
        pid: child.pid,
        port: stoppedPort,
        message: `已向 PID ${child.pid} 发送 SIGTERM（本平台启动记录）。若端口仍被占用，可再点一次「停止」将按端口清理。`,
      });
      return;
    }

    if (entry && entry.child && entry.child.exitCode !== null) {
      subProjectSpawnByPath.delete(absPath);
    }

    if (Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535) {
      if (portNum === platformPort) {
        res.status(400).json({ error: "不能结束可视化平台自身监听的端口" });
        return;
      }
      const pids = await pidsListeningOnPort(portNum);
      if (pids.length === 0) {
        res.json({
          ok: true,
          skipped: true,
          port: portNum,
          message: `端口 ${portNum} 当前无监听进程（可能已结束）。`,
        });
        return;
      }
      for (const pid of pids) {
        await killPidForStop(pid);
      }
      console.log(
        `[AutoFlow] 已按端口停止子项目 PORT=${portNum} PIDs=${pids.join(",")}`
      );
      res.json({
        ok: true,
        via: "port",
        port: portNum,
        pids,
        message: `已结束监听端口 ${portNum} 的进程 PID: ${pids.join(", ")}（无本平台启动记录时按端口回退）。`,
      });
      return;
    }

    res.status(404).json({
      error:
        "本平台没有该子项目的运行记录，且请求未带有效 port。请从列表行点击「停止子项目」（会带上端口），或在终端用 lsof -i :端口 后 kill。",
    });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "compose2-loop-platform",
    time: new Date().toISOString()
  });
});

app.get("/api/orders", (_req, res) => {
  const list = Array.from(orders.values()).map(publicOrder);
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ orders: list });
});

app.post("/api/orders", (req, res) => {
  const parsed = parseOrderPayload(req.body || {}, { partial: false });
  if (parsed.errors.length) {
    res.status(400).json({ error: parsed.errors.join("；") });
    return;
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const order = {
    id,
    customerName: parsed.customerName,
    amount: parsed.amount,
    status: parsed.status,
    note: parsed.note,
    createdAt: now,
    updatedAt: now
  };
  orders.set(id, order);
  res.status(201).json({ order: publicOrder(order) });
});

app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    res.status(404).json({ error: "订单不存在" });
    return;
  }
  res.json({ order: publicOrder(order) });
});

app.put("/api/orders/:id", (req, res) => {
  const existing = orders.get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "订单不存在" });
    return;
  }
  const parsed = parseOrderPayload(req.body || {}, { partial: false });
  if (parsed.errors.length) {
    res.status(400).json({ error: parsed.errors.join("；") });
    return;
  }
  const updated = {
    ...existing,
    customerName: parsed.customerName,
    amount: parsed.amount,
    status: parsed.status,
    note: parsed.note,
    updatedAt: new Date().toISOString()
  };
  orders.set(req.params.id, updated);
  res.json({ order: publicOrder(updated) });
});

app.delete("/api/orders/:id", (req, res) => {
  const id = req.params.id;
  if (!orders.has(id)) {
    res.status(404).json({ error: "订单不存在" });
    return;
  }
  orders.delete(id);
  res.status(204).end();
});

// 与 /api/runs/:id 无路径冲突；前端应优先使用本接口拉取历史已完成列表。
app.get("/api/completed-runs", sendCompletedRunsList);

app.get("/api/project-dirs", async (_req, res) => {
  try {
    const dirs = await listProjectDirsFromDisk();
    res.json({ dirs });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/runs", async (req, res) => {
  const requirement = String(req.body?.requirement || "").trim();
  const model = String(req.body?.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const maxIterations = Math.min(
    10,
    Math.max(1, Number.parseInt(req.body?.maxIterations, 10) || 3)
  );
  if (!requirement) {
    res.status(400).json({ error: "requirement 不能为空" });
    return;
  }

  let enabledStepIds;
  try {
    enabledStepIds = parseEnabledStepIds(req.body || {});
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
    return;
  }

  const cdpHeaded = Boolean(req.body?.cdpHeaded);
  const cdpLingerMsRaw = Number.parseInt(req.body?.cdpLingerMs, 10);
  const cdpLingerMs = Number.isFinite(cdpLingerMsRaw)
    ? Math.min(60000, Math.max(0, cdpLingerMsRaw))
    : 3000;
  const cdpDriver = normalizeCdpDriver(req.body?.cdpDriver);
  const targetPlatform = normalizeTargetPlatform(req.body?.targetPlatform);
  const appStack = normalizeAppStack(req.body?.appStack);
  const appTestMode = normalizeAppTestMode(req.body?.appTestMode);

  const id = crypto.randomUUID();
  const projectsRoot = path.join(baseDir, "projects");
  await fs.mkdir(projectsRoot, { recursive: true });

  const existingRaw =
    String(req.body?.existingProjectPath || "").trim() ||
    String(req.body?.baseProjectPath || "").trim();

  let workspacePath;
  let useExistingWorkspace = false;
  if (existingRaw) {
    try {
      workspacePath = await resolveExistingProjectWorkspace(existingRaw);
      useExistingWorkspace = true;
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
      return;
    }
  } else {
    const slug = slugifyRequirement(requirement);
    const projectPath = path.join(projectsRoot, `${id}-${slug}`);
    workspacePath = path.resolve(projectPath);
    if (!ensureInsideRepo(workspacePath)) {
      res.status(400).json({ error: "生成的项目目录不在仓库内" });
      return;
    }
  }

  const portKey = path.basename(workspacePath);
  const run = createRunObject({
    id,
    requirement,
    model,
    workspacePath,
    maxIterations,
    projectPath: workspacePath,
    appPort: pickProjectPort(portKey),
    enabledStepIds,
    useExistingWorkspace,
    cdpHeaded,
    cdpLingerMs,
    cdpDriver,
    targetPlatform,
    appStack,
    appTestMode
  });
  run.events = [];
  run.lastEventId = 0;
  runs.set(id, run);

  res.status(201).json({ run: publicRun(run) });

  startRun({
    run,
    emit: pushEvent,
    markFinished,
    baseDir
  }).catch((err) => {
    pushEvent(id, "run_failed", {
      error: err.message || String(err),
      at: new Date().toISOString()
    });
  });
});

app.get("/api/runs/completed", sendCompletedRunsList);

app.get("/api/runs/:id", async (req, res) => {
  // 若误将本路由注册在 /api/runs/completed 之前，"completed" 会被当成 :id 导致「run 不存在」。
  if (req.params.id === "completed") {
    try {
      const list = await listCompletedRunsFromDisk();
      res.json({ runs: list });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
    return;
  }
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run 不存在" });
    return;
  }
  res.json({ run: publicRun(run) });
});

app.get("/api/runs/:id/events", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run 不存在" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`event: ready\n`);
  res.write(
    `data: ${JSON.stringify({ at: new Date().toISOString(), runId: run.id })}\n\n`
  );

  for (const evt of run.events) {
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  const arr = sseClients.get(run.id) || [];
  arr.push(res);
  sseClients.set(run.id, arr);

  req.on("close", () => {
    const clients = sseClients.get(run.id) || [];
    const next = clients.filter((client) => client !== res);
    sseClients.set(run.id, next);
  });
});

app.post("/api/runs/:id/stop", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run 不存在" });
    return;
  }
  if (run.status !== "running" || !run.abortController) {
    res.status(409).json({ error: `当前状态 ${run.status} 无法停止` });
    return;
  }

  run.abortController.abort();
  pushEvent(run.id, "run_stop_requested", { at: new Date().toISOString() });
  res.json({ ok: true });
});

/**
 * 托管子项目下的 Playwright HTML 报告（playwright-report/）。
 * - run 在内存内：使用 run.projectPath / workspacePath。
 * - run 已不在内存（如可视化重启）：可带 ?projectPath= 经校验后的子项目绝对路径，仍可从磁盘打开。
 */
app.use("/api/runs/:id/playwright-report", (req, res, next) => {
  void (async () => {
    try {
      let projectPathResolved = null;
      const run = runs.get(req.params.id);
      if (run) {
        projectPathResolved = run.projectPath || run.workspacePath;
      } else {
        const raw = String(req.query.projectPath || "").trim();
        if (!raw) {
          res.status(404).json({
            error:
              "run 不在内存（可能已重启可视化）。请从本页「打开测试报告」自动带上 projectPath，或手动在 URL 增加 ?projectPath=<子项目绝对路径>"
          });
          return;
        }
        projectPathResolved = await validateSubprojectDirForSpawn(path.resolve(raw));
      }
      if (!projectPathResolved) {
        res.status(404).json({ error: "无项目路径" });
        return;
      }
      const root = path.join(projectPathResolved, "playwright-report");
      let st;
      try {
        st = fsSync.statSync(root);
      } catch {
        res
          .status(404)
          .json({
            error: "未找到 playwright-report，请先运行测试（步骤5）并启用 html reporter"
          });
        return;
      }
      if (!st.isDirectory()) {
        res.status(404).json({ error: "playwright-report 不是目录" });
        return;
      }
      const pathOnly = (req.url || "/").split("?")[0] || "/";
      req.url = pathOnly;
      const opts = { index: "index.html", fallthrough: false };
      express.static(root, opts)(req, res, next);
    } catch (err) {
      if (!res.headersSent) {
        res.status(400).json({ error: err.message || String(err) });
      } else {
        next(err);
      }
    }
  })();
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "platform.html"));
});

app.use(express.static(path.join(__dirname)));

app.listen(port, () => {
  console.log(`可视化平台: http://127.0.0.1:${port}/`);
});
