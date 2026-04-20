const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs/promises");

function createStore() {
  const users = [
    {
      id: "u-1001",
      name: "刘晨",
      status: "active",
      segment: "KA",
      city: "上海",
      owner: "王敏",
      risk: "medium",
      joinedAt: "2025-11-04",
      watchlist: false,
      notes: "最近 30 天活跃，存在大额订单审核记录。"
    },
    {
      id: "u-1002",
      name: "周宁",
      status: "active",
      segment: "SMB",
      city: "杭州",
      owner: "陈飞",
      risk: "low",
      joinedAt: "2025-09-18",
      watchlist: true,
      notes: "续费意愿高，适合营销活动回访。"
    },
    {
      id: "u-1003",
      name: "徐萌",
      status: "suspended",
      segment: "KA",
      city: "北京",
      owner: "林涛",
      risk: "high",
      joinedAt: "2025-06-21",
      watchlist: true,
      notes: "资料变更多次，需人工复核。"
    },
    {
      id: "u-1004",
      name: "宋岚",
      status: "pending",
      segment: "Growth",
      city: "深圳",
      owner: "王敏",
      risk: "medium",
      joinedAt: "2026-01-09",
      watchlist: false,
      notes: "新客导入，待完成首单。"
    }
  ];

  const orders = [
    {
      id: "o-3001",
      userId: "u-1001",
      status: "pending-review",
      amount: 12888,
      channel: "官网",
      createdAt: "2026-04-16 10:20",
      flagged: false,
      paymentState: "paid",
      reviewState: "pending",
      items: ["增长实验包", "年度顾问服务"]
    },
    {
      id: "o-3002",
      userId: "u-1002",
      status: "completed",
      amount: 3880,
      channel: "销售代录",
      createdAt: "2026-04-14 15:05",
      flagged: false,
      paymentState: "paid",
      reviewState: "approved",
      items: ["季度活动包"]
    },
    {
      id: "o-3003",
      userId: "u-1003",
      status: "draft",
      amount: 23999,
      channel: "官网",
      createdAt: "2026-04-18 09:42",
      flagged: true,
      paymentState: "unpaid",
      reviewState: "not-submitted",
      items: ["旗舰升级包", "风控巡检"]
    },
    {
      id: "o-3004",
      userId: "u-1001",
      status: "completed",
      amount: 1280,
      channel: "客服补单",
      createdAt: "2026-03-28 13:10",
      flagged: false,
      paymentState: "paid",
      reviewState: "approved",
      items: ["培训服务"]
    }
  ];

  const reviews = [
    {
      id: "r-5001",
      type: "order",
      targetId: "o-3001",
      relatedUserId: "u-1001",
      title: "大额订单待审核",
      priority: "high",
      status: "pending",
      assignee: "审核组-A",
      createdAt: "2026-04-16 10:30"
    },
    {
      id: "r-5002",
      type: "user",
      targetId: "u-1003",
      relatedUserId: "u-1003",
      title: "用户资料异常复核",
      priority: "high",
      status: "pending",
      assignee: "审核组-B",
      createdAt: "2026-04-17 11:10"
    },
    {
      id: "r-5003",
      type: "order",
      targetId: "o-3002",
      relatedUserId: "u-1002",
      title: "历史订单抽样复核",
      priority: "medium",
      status: "approved",
      assignee: "审核组-C",
      createdAt: "2026-04-14 16:20"
    }
  ];

  return { users, orders, reviews };
}

let store = createStore();

function getUserById(userId) {
  return store.users.find((item) => item.id === userId);
}

function getOrderById(orderId) {
  return store.orders.find((item) => item.id === orderId);
}

function buildDashboard() {
  const pendingReviews = store.reviews.filter((item) => item.status === "pending");
  const flaggedOrders = store.orders.filter((item) => item.flagged);
  const watchlistUsers = store.users.filter((item) => item.watchlist);

  return {
    totals: {
      users: store.users.length,
      pendingReviews: pendingReviews.length,
      flaggedOrders: flaggedOrders.length,
      watchlistUsers: watchlistUsers.length
    },
    recentOrders: store.orders.slice().sort((a, b) => a.id < b.id ? 1 : -1).slice(0, 3).map((order) => ({
      ...order,
      userName: getUserById(order.userId)?.name || "未知用户"
    })),
    reviewQueue: pendingReviews.map((review) => ({
      ...review,
      targetLabel: review.type === "order" ? `订单 ${review.targetId}` : `用户 ${review.targetId}`
    }))
  };
}

function serializeUser(user) {
  const userOrders = store.orders
    .filter((order) => order.userId === user.id)
    .map((order) => ({
      ...order,
      userName: user.name
    }));

  return {
    ...user,
    recentOrders: userOrders
  };
}

function serializeOrder(order) {
  const user = getUserById(order.userId);
  return {
    ...order,
    userName: user?.name || "未知用户",
    userStatus: user?.status || "unknown"
  };
}

const app = express();
const port = Number(process.env.PORT || 4175);
const appDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(__dirname, "../../../..");

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ── Test Runner 路由 ──────────────────────────────────────────
app.use("/test-runner", express.static(path.join(appDir, "test-runner")));
app.use("/playwright-report", express.static(path.join(appDir, "playwright-report")));

app.get("/api/tr/spec/:name", async (req, res) => {
  const file = path.join(appDir, "tests", path.basename(req.params.name));
  try {
    res.type("text").send(await fs.readFile(file, "utf8"));
  } catch {
    res.status(404).end();
  }
});

const CURSOR_MODEL = "composer-2-fast";

function buildFixLoopPrompt(testCmd) {
  return [
    "你是 AI 软件工程流程的执行代理，当前阶段：playwright 测试自动修复闭环。",
    "必须严格按以下 skills 方法执行：playwright-fix-loop。",
    "要求：输出结构化、可执行、简洁；若涉及代码改动，优先最小改动，并给出变更证据。",
    "",
    `在 archive/apps/ops-admin-lab 目录执行以下命令，循环直到全部通过：`,
    testCmd
  ].join("\n");
}

app.post("/api/tr/run", (req, res) => {
  const { testArgs } = req.body;
  const safeArgs = typeof testArgs === "string" ? testArgs.trim() : "";
  const testCmd = `cd archive/apps/ops-admin-lab && npx playwright test${safeArgs ? " " + safeArgs : ""}`;
  const prompt  = buildFixLoopPrompt(testCmd);

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
      "--model", CURSOR_MODEL,
      "--trust",
      "--force",
      "--sandbox", "enabled",
      "--workspace", repoRoot,
      prompt
    ],
    { cwd: repoRoot, env: process.env }
  );

  // stream-json 格式：每行一个 JSON 对象，提取 assistant 消息的文本块
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
      } catch { /* 非 JSON 行直接透传 */ send(trimmed); }
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
    send(`\n[错误] 无法启动 cursor CLI：${err.message}`);
    if (!res.writableEnded) {
      res.write("event: done\ndata: {}\n\n");
      res.end();
    }
  });

  res.on("close", () => {
    if (!child.killed) child.kill("SIGTERM");
  });
});
// ── Test Runner 路由结束 ───────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "ops-admin-lab" });
});

app.post("/api/test/reset", (_req, res) => {
  store = createStore();
  res.json({ ok: true });
});

app.get("/api/dashboard", (_req, res) => {
  res.json(buildDashboard());
});

app.get("/api/users", (req, res) => {
  const search = String(req.query.search || "").trim().toLowerCase();
  const status = String(req.query.status || "all");

  const filtered = store.users.filter((user) => {
    const matchesSearch =
      !search ||
      user.name.toLowerCase().includes(search) ||
      user.id.toLowerCase().includes(search) ||
      user.city.toLowerCase().includes(search);
    const matchesStatus = status === "all" || user.status === status;
    return matchesSearch && matchesStatus;
  });

  res.json({
    items: filtered.map((user) => ({
      ...user,
      orderCount: store.orders.filter((order) => order.userId === user.id).length
    }))
  });
});

app.get("/api/users/:id", (req, res) => {
  const user = getUserById(req.params.id);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(serializeUser(user));
});

app.post("/api/users/:id/watchlist", (req, res) => {
  const user = getUserById(req.params.id);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  user.watchlist = !user.watchlist;
  res.json({ ok: true, user: serializeUser(user) });
});

app.get("/api/orders", (req, res) => {
  const status = String(req.query.status || "all");

  const filtered = store.orders.filter((order) => status === "all" || order.status === status);

  res.json({
    items: filtered.map((order) => serializeOrder(order))
  });
});

app.get("/api/orders/:id", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  res.json(serializeOrder(order));
});

app.post("/api/orders/:id/flag", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  order.flagged = !order.flagged;
  res.json({ ok: true, order: serializeOrder(order) });
});

app.post("/api/orders/:id/submit-review", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  order.status = "pending-review";
  order.reviewState = "pending";

  const existingPending = store.reviews.find(
    (item) => item.targetId === order.id && item.type === "order" && item.status === "pending"
  );

  if (!existingPending) {
    store.reviews.unshift({
      id: `r-${5000 + store.reviews.length + 1}`,
      type: "order",
      targetId: order.id,
      relatedUserId: order.userId,
      title: "订单重新提审",
      priority: "high",
      status: "pending",
      assignee: "审核组-A",
      createdAt: "2026-04-20 09:00"
    });
  }

  res.json({ ok: true, order: serializeOrder(order) });
});

app.get("/api/reviews", (req, res) => {
  const status = String(req.query.status || "all");

  const items = store.reviews
    .filter((review) => status === "all" || review.status === status)
    .map((review) => ({
      ...review,
      relatedUserName: getUserById(review.relatedUserId)?.name || "未知用户"
    }));

  res.json({ items });
});

app.post("/api/reviews/:id/decision", (req, res) => {
  const review = store.reviews.find((item) => item.id === req.params.id);
  const action = req.body?.action;

  if (!review) {
    res.status(404).json({ error: "Review not found" });
    return;
  }

  if (action !== "approve" && action !== "reject") {
    res.status(400).json({ error: "Invalid review action" });
    return;
  }

  review.status = action === "approve" ? "approved" : "rejected";

  if (review.type === "order") {
    const order = getOrderById(review.targetId);
    if (order) {
      order.reviewState = review.status;
      order.status = action === "approve" ? "completed" : "pending-review";
    }
  }

  res.json({ ok: true, review });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.listen(port, () => {
  console.log(`Ops admin lab is running at http://127.0.0.1:${port}`);
});
