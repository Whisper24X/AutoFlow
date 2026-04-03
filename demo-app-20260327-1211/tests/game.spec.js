const { test, expect } = require("@playwright/test");

test.describe("简易超级玛丽", () => {
  test("页面加载且画布存在", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("canvas#game")).toBeVisible();
    await expect(page).toHaveTitle(/超级玛丽/);
  });
});
