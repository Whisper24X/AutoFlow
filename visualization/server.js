const express = require("express");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const crypto = require("crypto");
const { DEFAULT_MODEL } = require("./cursor-cli-adapter");
const { createRunObject, startRun, normalizeCdpDriver } = require("./run-engine");

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
    const portNum = Number.parseInt(String(body.port ?? ""), 10);
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
      console.log(`[AutoFlow] 端口 ${portNum} 已在监听 /api/health，跳过启动`);
      res.json({
        ok: true,
        skipped: true,
        port: portNum,
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
    fsSync.writeSync(
      logFd,
      Buffer.from(
        `\n--- ${new Date().toISOString()} npm run start (PORT=${portNum}) via AutoFlow ---\n`,
        "utf8"
      )
    );

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    let child;
    try {
      child = spawn(npmCmd, ["run", "start"], {
        cwd: absPath,
        env: { ...process.env, PORT: String(portNum) },
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
 * 停止由本平台一键启动的子项目（向记录的 npm 子进程发 SIGTERM）。
 * POST /api/stop-subproject  body: { projectPath }
 */
app.post("/api/stop-subproject", async (req, res) => {
  try {
    const rawPath = String(req.body?.projectPath || "").trim();
    if (!rawPath) {
      res.status(400).json({ error: "缺少 projectPath" });
      return;
    }
    const absPath = await validateSubprojectDirForSpawn(path.resolve(rawPath));
    const entry = subProjectSpawnByPath.get(absPath);
    if (!entry || !entry.child) {
      res.status(404).json({
        error:
          "本平台没有正在运行的该子项目记录（可能未用「启动子项目」拉起、或已退出、或可视化服务已重启）。可在终端用 kill PID 或按端口结束进程。"
      });
      return;
    }
    const { child, port: stoppedPort } = entry;
    if (child.exitCode !== null) {
      subProjectSpawnByPath.delete(absPath);
      res.status(404).json({ error: "子进程已结束" });
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch (killErr) {
      res.status(500).json({ error: killErr.message || String(killErr) });
      return;
    }
    console.log(
      `[AutoFlow] 已请求停止子项目 PID=${child.pid} PORT=${stoppedPort}`
    );
    res.json({
      ok: true,
      pid: child.pid,
      port: stoppedPort,
      message: `已向 PID ${child.pid} 发送停止信号（SIGTERM）；若端口仍占用，请在终端执行 lsof -i :${stoppedPort} 后 kill 对应进程`
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
    cdpDriver
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
 * 托管当前内存 run 对应子项目下的 Playwright HTML 报告（playwright-report/），
 * 供平台页「打开测试报告」在新标签页查看。run 不在内存或服务重启后返回 404。
 */
app.use("/api/runs/:id/playwright-report", (req, res, next) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run 不存在" });
    return;
  }
  const projectPath = run.projectPath || run.workspacePath;
  const root = path.join(projectPath, "playwright-report");
  let st;
  try {
    st = fsSync.statSync(root);
  } catch {
    res
      .status(404)
      .json({ error: "未找到 playwright-report，请先运行测试（步骤5）并启用 html reporter" });
    return;
  }
  if (!st.isDirectory()) {
    res.status(404).json({ error: "playwright-report 不是目录" });
    return;
  }
  const opts = { index: "index.html", fallthrough: false };
  express.static(root, opts)(req, res, next);
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "platform.html"));
});

app.use(express.static(path.join(__dirname)));

app.listen(port, () => {
  console.log(`可视化平台: http://127.0.0.1:${port}/`);
});
