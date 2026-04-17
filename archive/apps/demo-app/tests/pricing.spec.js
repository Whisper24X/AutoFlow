const { test, expect } = require("@playwright/test");

test.describe("订单折扣逻辑", () => {
  test("优惠码 SAVE10 应打九折", async ({ page }) => {
    await page.goto("/");

    await page.fill("#price", "100");
    await page.fill("#quantity", "2");
    await page.fill("#coupon", "SAVE10");
    await page.click("#calc-btn");

    await expect(page.locator("#total")).toHaveText("¥180.00");
  });
});
