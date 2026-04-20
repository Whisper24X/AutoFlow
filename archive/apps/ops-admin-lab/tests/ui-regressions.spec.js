const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test.describe("列表筛选与空状态", () => {
  test("用户列表支持无结果提示和状态筛选", async ({ page }) => {
    await page.goto("/users.html");

    await page.getByTestId("user-search").fill("不存在的用户");
    await page.getByTestId("user-status-filter").selectOption("all");
    await page.getByTestId("apply-user-filters").click();
    await expect(page.locator(".empty-state")).toHaveText("没有匹配的数据");

    await page.getByTestId("user-search").fill("");
    await page.getByTestId("user-status-filter").selectOption("suspended");
    await page.getByTestId("apply-user-filters").click();

    await expect(page.getByTestId("user-row-u-1003")).toBeVisible();
    await expect(page.getByTestId("user-row-u-1001")).toBeHidden();
  });

  test("审核列表支持驳回流程和状态筛选", async ({ page }) => {
    await page.goto("/reviews.html");

    await page.getByTestId("reject-review-r-5002").click();
    await expect(page.getByTestId("reviews-flash")).toHaveText("审核 r-5002 已驳回");
    await expect(page.getByTestId("review-status-r-5002")).toHaveText("rejected");

    await expect(page.getByTestId("approve-review-r-5002")).toBeDisabled();
    await expect(page.getByTestId("reject-review-r-5002")).toBeDisabled();

    await page.getByTestId("review-status-filter").selectOption("rejected");
    await page.getByTestId("apply-review-filters").click();

    await expect(page.getByTestId("review-row-r-5002")).toBeVisible();
    await expect(page.getByTestId("review-row-r-5001")).toBeHidden();
  });
});

test.describe("导航状态与深链访问", () => {
  test("订单详情深链打开后保持订单导航高亮", async ({ page }) => {
    await page.goto("/order-detail.html?id=o-3001");

    await expect(page.getByTestId("order-detail-id")).toHaveText("o-3001");
    await expect(page.locator("[data-nav='orders']")).toHaveClass(/active/);
    await expect(page.locator("[data-nav='users']")).not.toHaveClass(/active/);
  });
});
