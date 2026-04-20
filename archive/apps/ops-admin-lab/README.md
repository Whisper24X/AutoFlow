# Ops Admin Lab

一个专门为 `.agents/skills/playwright-fix-loop` 准备的多页面后台测试项目。

## 项目目标

- 提供 6 个后台页面，覆盖列表页、详情页和审核工作流
- 用固定 mock 数据保证 Playwright 用例稳定执行
- 用项目内 `npm test` 作为统一测试入口，便于技能做“跑测试 -> 修复 -> 再跑”的闭环

## 页面结构

- `/` 仪表盘
- `/users.html` 用户列表
- `/user-detail.html?id=<userId>` 用户详情
- `/orders.html` 订单列表
- `/order-detail.html?id=<orderId>` 订单详情
- `/reviews.html` 审核工作台

## 运行方式

```bash
npm install
npm start
```

默认端口是 `4175`，也可以通过 `PORT=4185 npm start` 自定义。

## 测试方式

```bash
npm test
```

Playwright 会通过 `playwright.config.js` 自动启动本地服务，并使用 `/api/health` 做就绪探测。

为了避免测试之间互相污染，测试用例会在每次执行前调用 `/api/test/reset` 将内存数据恢复到初始状态。

## 适配 playwright-fix-loop

这个项目满足该技能最关键的几个前提：

- 测试命令固定为 `npm test`
- 服务命令固定为 `npm start`
- 有稳定的本地服务和健康检查接口
- 有可重复的固定测试数据
- 页面与交互足够复杂，适合练习定位与修复
