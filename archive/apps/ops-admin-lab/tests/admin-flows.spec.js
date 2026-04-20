const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test.describe("总览与导航", () => {
  test("仪表盘展示稳定统计数据并支持核心导航", async ({ page }) => {
    await test.step("打开首页", async () => {
      await page.goto("/");
    });

    await test.step("验证页面标题为「运营总览」", async () => {
      await expect(page.getByRole("heading", { name: "运营总览" })).toBeVisible();
    });

    await test.step("验证统计数据：用户数 4、待审 2、异常订单 1、观察名单 2", async () => {
      await expect(page.getByTestId("stat-users")).toHaveText("4");
      await expect(page.getByTestId("stat-pending-reviews")).toHaveText("2");
      await expect(page.getByTestId("stat-flagged-orders")).toHaveText("1");
      await expect(page.getByTestId("stat-watchlist-users")).toHaveText("2");
    });

    await test.step("验证最近订单列表中包含 o-3003", async () => {
      await expect(page.getByTestId("order-row-o-3003")).toBeVisible();
    });

    await test.step("点击「进入审核工作台」跳转到审核页", async () => {
      await page.getByRole("link", { name: "进入审核工作台" }).click();
      await expect(page).toHaveURL(/reviews\.html$/);
      await expect(page.getByRole("heading", { name: "审核工作台" })).toBeVisible();
    });
  });
});

test.describe("用户与订单流程", () => {
  test("用户页支持筛选并可在详情页切换观察名单", async ({ page }) => {
    await test.step("打开用户列表页", async () => {
      await page.goto("/users.html");
    });

    await test.step("验证用户 u-1001 可见、u-1002 不可见（初始过滤生效）", async () => {
      await expect(page.getByTestId("user-row-u-1001")).toBeVisible();
      await expect(page.getByTestId("user-row-u-1002")).toBeHidden();
    });

    await test.step("点击 u-1001 进入用户详情页", async () => {
      await page.getByTestId("user-link-u-1001").click();
      await expect(page).toHaveURL(/user-detail\.html\?id=u-1001$/);
    });

    await test.step("验证用户详情：姓名「刘晨」、观察名单状态「正常」", async () => {
      await expect(page.getByTestId("user-detail-name")).toHaveText("刘晨");
      await expect(page.getByTestId("user-watchlist-state")).toHaveText("正常");
    });

    await test.step("切换观察名单状态并验证提示与状态更新", async () => {
      await page.getByTestId("toggle-watchlist").click();
      await expect(page.getByTestId("user-flash")).toHaveText("观察名单状态已更新");
      await expect(page.getByTestId("user-watchlist-state")).toHaveText("观察中");
    });

    await test.step("验证该用户的订单 o-3001 在详情页可见", async () => {
      await expect(page.getByTestId("order-row-o-3001")).toBeVisible();
    });
  });

  test("订单页支持草稿流转、详情更新和跨页跳转", async ({ page }) => {
    await test.step("打开订单列表页", async () => {
      await page.goto("/orders.html");
    });

    await test.step("按状态「草稿」筛选订单并验证结果", async () => {
      await page.getByTestId("order-status-filter").selectOption("draft");
      await page.getByTestId("apply-order-filters").click();
      await expect(page.getByTestId("order-row-o-3003")).toBeVisible();
      await expect(page.getByTestId("order-row-o-3001")).toBeHidden();
    });

    await test.step("点击 o-3003 进入订单详情页", async () => {
      await page.getByTestId("order-link-o-3003").click();
      await expect(page).toHaveURL(/order-detail\.html\?id=o-3003$/);
    });

    await test.step("验证订单详情：ID 和异常标记状态", async () => {
      await expect(page.getByTestId("order-detail-id")).toHaveText("o-3003");
      await expect(page.getByTestId("order-flag-state")).toHaveText("已标记异常");
    });

    await test.step("取消异常标记并验证提示与状态更新", async () => {
      await page.getByTestId("toggle-order-flag").click();
      await expect(page.getByTestId("order-flash")).toHaveText("订单标记状态已更新");
      await expect(page.getByTestId("order-flag-state")).toHaveText("正常");
    });

    await test.step("提交审核并验证订单状态变为待审核", async () => {
      await page.getByTestId("submit-order-review").click();
      await expect(page.getByTestId("order-flash")).toHaveText("订单已提交审核");
      await expect(page.getByTestId("order-review-state")).toContainText("pending");
      await expect(page.getByTestId("order-detail-status")).toContainText("pending-review");
    });

    await test.step("通过订单关联用户链接跳转到用户详情页", async () => {
      await page.getByTestId("order-user-link").click();
      await expect(page).toHaveURL(/user-detail\.html\?id=u-1003$/);
      await expect(page.getByTestId("user-detail-name")).toHaveText("徐萌");
    });
  });
});

test.describe("审核流程", () => {
  test("审核页支持审批操作并跳转到关联详情页", async ({ page }) => {
    await test.step("打开审核工作台页面", async () => {
      await page.goto("/reviews.html");
    });

    await test.step("验证审核记录 r-5001 可见且状态为 pending", async () => {
      await expect(page.getByTestId("review-row-r-5001")).toBeVisible();
      await expect(page.getByTestId("review-status-r-5001")).toHaveText("pending");
    });

    await test.step("通过审核 r-5001 并验证提示与状态更新为 approved", async () => {
      await page.getByTestId("approve-review-r-5001").click();
      await expect(page.getByTestId("reviews-flash")).toHaveText("审核 r-5001 已通过");
      await expect(page.getByTestId("review-status-r-5001")).toHaveText("approved");
    });

    await test.step("重新打开审核页，点击 r-5002 关联目标跳转到用户详情", async () => {
      await page.goto("/reviews.html");
      await page.getByTestId("review-target-r-5002").click();
      await expect(page).toHaveURL(/user-detail\.html\?id=u-1003$/);
      await expect(page.getByTestId("user-detail-risk")).toContainText("high");
    });
  });
});
