# 闭环执行记录（Demo）

## 环境
- OS: darwin 25.3.0
- IDE: Cursor
- 项目路径：`/Users/yangcong/AI-testing/AutoFlow`

## Step 1 - 安装技能
- 执行 `npx skills add ...` 安装 7 个项目级 skills。
- 结果：`npx skills ls --json` 能看到全部技能已安装。

## Step 2 - 开发实现（含故意缺陷）
- 搭建 `demo-app`（Express + 静态页面）。
- 初始缺陷：`SAVE10` 错误按 `0.95` 计算。

## Step 3 - 自动化测试发现问题
- 执行：
  - `cd demo-app`
  - `npm test`
- 失败证据：
  - 预期：`¥180.00`
  - 实际：`¥190.00`
  - 用例：`tests/pricing.spec.js`

## Step 4 - 修复缺陷
- 修改 `demo-app/public/index.html` 折扣计算逻辑：
  - 从 `subtotal * 0.95`
  - 修复为 `subtotal * 0.9`

## Step 5 - 回归验证
- 再次执行 `npm test`
- 结果：`1 passed`

## 结论
已完成“需求 -> 开发 -> 自动化测试 -> 缺陷修复 -> 回归通过”的闭环演示。
