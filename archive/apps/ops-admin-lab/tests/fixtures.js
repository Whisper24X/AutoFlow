// 共享浏览器窗口 fixture
// sharedPage / sharedContext 是 worker 级，整个 worker 只创建一次。
// test-scoped 的 page 直接复用 sharedPage，实现全程一个窗口。
const { test: base, expect } = require("@playwright/test");

exports.test = base.extend({
  // worker 级：一个 worker 内所有 test 共用同一个 BrowserContext
  sharedContext: [
    async ({ browser }, use) => {
      const ctx = await browser.newContext();
      await use(ctx);
      await ctx.close();
    },
    { scope: "worker" }
  ],

  // worker 级：整个 worker 只开一个 Page（即一个窗口）
  sharedPage: [
    async ({ sharedContext }, use) => {
      const pg = await sharedContext.newPage();
      await use(pg);
      await pg.close();
    },
    { scope: "worker" }
  ],

  // 覆盖 test 级的 page，直接指向 sharedPage（不关闭，让窗口保持）
  page: async ({ sharedPage }, use) => {
    await use(sharedPage);
  },
});

exports.expect = expect;
