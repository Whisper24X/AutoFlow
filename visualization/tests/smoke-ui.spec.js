const { test, expect } = require("@playwright/test");

test.describe("step5 minimum gate - UI smoke", () => {
  test("platform home renders key controls", async ({ page }) => {
    const resp = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(resp).toBeTruthy();
    expect(resp.status()).toBe(200);

    await expect(page).toHaveTitle(/AutoFlow/);
    await expect(page.locator("h1")).toHaveText("AutoFlow");
    await expect(page.getByRole("button", { name: "一键运行闭环" })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止运行" })).toBeDisabled();

    const stepToggles = page.locator('[id^="step-enable-"]');
    await expect(stepToggles).toHaveCount(8);
    await expect(page.locator("#step-enable-1")).toBeChecked();
    await expect(page.locator("#step-enable-1")).toBeDisabled();
    await expect(page.locator("#step-enable-5")).toBeChecked();
  });
});
