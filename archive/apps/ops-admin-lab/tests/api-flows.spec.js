const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test.describe("基础接口", () => {
  test("健康检查和仪表盘接口返回稳定数据", async ({ request }) => {
    const healthResponse = await request.get("/api/health");
    expect(healthResponse.ok()).toBeTruthy();
    await expect(healthResponse.json()).resolves.toEqual({
      ok: true,
      app: "ops-admin-lab"
    });

    const dashboardResponse = await request.get("/api/dashboard");
    expect(dashboardResponse.ok()).toBeTruthy();

    const dashboard = await dashboardResponse.json();
    expect(dashboard.totals).toEqual({
      users: 4,
      pendingReviews: 2,
      flaggedOrders: 1,
      watchlistUsers: 2
    });
    expect(dashboard.recentOrders).toHaveLength(3);
    expect(dashboard.reviewQueue).toHaveLength(2);
  });
});

test.describe("用户接口", () => {
  test("用户查询支持搜索过滤并返回详情", async ({ request }) => {
    const listResponse = await request.get("/api/users?search=%E5%88%98&status=active");
    expect(listResponse.ok()).toBeTruthy();

    const listData = await listResponse.json();
    expect(listData.items).toHaveLength(1);
    expect(listData.items[0]).toMatchObject({
      id: "u-1001",
      name: "刘晨",
      status: "active",
      orderCount: 2
    });

    const detailResponse = await request.get("/api/users/u-1001");
    expect(detailResponse.ok()).toBeTruthy();

    const detailData = await detailResponse.json();
    expect(detailData.recentOrders).toHaveLength(2);
    expect(detailData.watchlist).toBe(false);
  });

  test("观察名单切换接口会更新用户状态，缺失用户返回 404", async ({ request }) => {
    const toggleResponse = await request.post("/api/users/u-1001/watchlist");
    expect(toggleResponse.ok()).toBeTruthy();

    const toggleData = await toggleResponse.json();
    expect(toggleData.user.watchlist).toBe(true);

    const notFoundResponse = await request.post("/api/users/u-9999/watchlist");
    expect(notFoundResponse.status()).toBe(404);
    await expect(notFoundResponse.json()).resolves.toEqual({ error: "User not found" });
  });
});

test.describe("订单与审核接口", () => {
  test("订单标记和重新提审会同步更新订单与审核队列", async ({ request }) => {
    const flagResponse = await request.post("/api/orders/o-3003/flag");
    expect(flagResponse.ok()).toBeTruthy();

    const flagData = await flagResponse.json();
    expect(flagData.order.flagged).toBe(false);

    const submitResponse = await request.post("/api/orders/o-3003/submit-review");
    expect(submitResponse.ok()).toBeTruthy();

    const submitData = await submitResponse.json();
    expect(submitData.order.status).toBe("pending-review");
    expect(submitData.order.reviewState).toBe("pending");

    const reviewListResponse = await request.get("/api/reviews?status=pending");
    const reviewListData = await reviewListResponse.json();
    expect(reviewListData.items.some((item) => item.targetId === "o-3003" && item.status === "pending")).toBe(true);
  });

  test("审核决策接口支持通过、驳回和非法参数校验", async ({ request }) => {
    const invalidResponse = await request.post("/api/reviews/r-5001/decision", {
      data: { action: "hold" }
    });
    expect(invalidResponse.status()).toBe(400);
    await expect(invalidResponse.json()).resolves.toEqual({ error: "Invalid review action" });

    const approveResponse = await request.post("/api/reviews/r-5001/decision", {
      data: { action: "approve" }
    });
    expect(approveResponse.ok()).toBeTruthy();

    const approvedOrderResponse = await request.get("/api/orders/o-3001");
    const approvedOrder = await approvedOrderResponse.json();
    expect(approvedOrder.status).toBe("completed");
    expect(approvedOrder.reviewState).toBe("approved");

    await request.post("/api/test/reset");

    const rejectResponse = await request.post("/api/reviews/r-5001/decision", {
      data: { action: "reject" }
    });
    expect(rejectResponse.ok()).toBeTruthy();

    const rejectedOrderResponse = await request.get("/api/orders/o-3001");
    const rejectedOrder = await rejectedOrderResponse.json();
    expect(rejectedOrder.status).toBe("pending-review");
    expect(rejectedOrder.reviewState).toBe("rejected");
  });
});
