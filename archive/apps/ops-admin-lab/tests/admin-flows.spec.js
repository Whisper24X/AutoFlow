const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test.describe("总览与导航", () => {
  test("仪表盘展示稳定统计数据并支持核心导航", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "运营总览" })).toBeVisible();
    await expect(page.getByTestId("stat-users")).toHaveText("4");
    await expect(page.getByTestId("stat-pending-reviews")).toHaveText("2");
    await expect(page.getByTestId("stat-flagged-orders")).toHaveText("1");
    await expect(page.getByTestId("stat-watchlist-users")).toHaveText("2");

    await expect(page.getByTestId("order-row-o-3003")).toBeVisible();
    await page.getByRole("link", { name: "进入审核工作台" }).click();
    await expect(page).toHaveURL(/reviews\.html$/);
    await expect(page.getByRole("heading", { name: "审核工作台" })).toBeVisible();
  });
});

test.describe("用户与订单流程", () => {
  test("用户页支持筛选并可在详情页切换观察名单", async ({ page }) => {
    await page.goto("/users.html");

    await expect(page.getByTestId("user-row-u-1001")).toBeVisible();
    await expect(page.getByTestId("user-row-u-1002")).toBeHidden();

    await page.getByTestId("user-link-u-1001").click();
    await expect(page).toHaveURL(/user-detail\.html\?id=u-1001$/);
    await expect(page.getByTestId("user-detail-name")).toHaveText("刘晨");
    await expect(page.getByTestId("user-watchlist-state")).toHaveText("正常");

    await page.getByTestId("toggle-watchlist").click();
    await expect(page.getByTestId("user-flash")).toHaveText("观察名单状态已更新");
    await expect(page.getByTestId("user-watchlist-state")).toHaveText("观察中");
    await expect(page.getByTestId("order-row-o-3001")).toBeVisible();
  });

  test("订单页支持草稿流转、详情更新和跨页跳转", async ({ page }) => {
    await page.goto("/orders.html");

    await page.getByTestId("order-status-filter").selectOption("draft");
    await page.getByTestId("apply-order-filters").click();
    await expect(page.getByTestId("order-row-o-3003")).toBeVisible();
    await expect(page.getByTestId("order-row-o-3001")).toBeHidden();

    await page.getByTestId("order-link-o-3003").click();
    await expect(page).toHaveURL(/order-detail\.html\?id=o-3003$/);
    await expect(page.getByTestId("order-detail-id")).toHaveText("o-3003");
    await expect(page.getByTestId("order-flag-state")).toHaveText("已标记异常");

    await page.getByTestId("toggle-order-flag").click();
    await expect(page.getByTestId("order-flash")).toHaveText("订单标记状态已更新");
    await expect(page.getByTestId("order-flag-state")).toHaveText("正常");

    await page.getByTestId("submit-order-review").click();
    await expect(page.getByTestId("order-flash")).toHaveText("订单已提交审核");
    await expect(page.getByTestId("order-review-state")).toContainText("pending");
    await expect(page.getByTestId("order-detail-status")).toContainText("pending-review");

    await page.getByTestId("order-user-link").click();
    await expect(page).toHaveURL(/user-detail\.html\?id=u-1003$/);
    await expect(page.getByTestId("user-detail-name")).toHaveText("徐萌");
  });
});

test.describe("审核流程", () => {
  test("审核页支持审批操作并跳转到关联详情页", async ({ page }) => {
    await page.goto("/reviews.html");

    await expect(page.getByTestId("review-row-r-5001")).toBeVisible();
    await expect(page.getByTestId("review-status-r-5001")).toHaveText("pending");

    await page.getByTestId("approve-review-r-5001").click();
    await expect(page.getByTestId("reviews-flash")).toHaveText("审核 r-5001 已通过");
    await expect(page.getByTestId("review-status-r-5001")).toHaveText("approved");

    await page.goto("/reviews.html");
    await page.getByTestId("review-target-r-5002").click();
    await expect(page).toHaveURL(/user-detail\.html\?id=u-1003$/);
    await expect(page.getByTestId("user-detail-risk")).toContainText("high");
  });
});
