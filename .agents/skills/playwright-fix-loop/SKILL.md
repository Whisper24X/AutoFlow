---
name: playwright-fix-loop
description: 自主执行 Playwright 测试修复闭环：运行测试命令，读取失败输出，定位并修复源代码 bug，再次运行，循环直到全部通过。当用户要求"跑测试并修复"、"测试失败帮我改"、"直到测试全通过"、"fix until green"时使用。适用于任何使用 Playwright 的 Web 项目，测试命令可为 npm test、yarn test、pnpm test 等。
---

# Playwright 测试自动修复闭环

自主执行"跑测试 → 读错误 → 定位代码 → 修复 → 再跑"，无需人工介入，直到所有测试通过。

## 执行流程

重复以下循环，直到测试命令退出码为 0：

### 第 1 步：确认测试命令并运行

从 `package.json` 的 `scripts` 推断测试命令（通常为 `npm test`），在项目目录执行并捕获完整输出。

若退出码为 0，向用户报告通过并结束。

### 第 2 步：解析失败输出

从 Playwright 错误输出中提取：

- **失败的测试名称**：`› 测试描述文字`
- **断言类型**：`toHaveText` / `toBeVisible` / `toHaveValue` / `toEqual` 等
- **Expected / Received**：期望值与实际值
- **Locator**：操作的页面元素（CSS 选择器、role、text 等）
- **出错位置**：`at tests/xxx.spec.js:行号` — 理解测试意图

### 第 3 步：反查业务代码根因

根据断言类型选择追踪策略：

| 断言类型 | 追踪方向 |
|---|---|
| `toHaveText` / `toHaveValue` | 找对该元素赋值/写入的业务逻辑 |
| `toBeVisible` / `toBeHidden` | 找控制该元素显示/隐藏的条件逻辑 |
| `toEqual` / `toBe` | 找数据计算或状态变更的逻辑 |
| `toHaveURL` / `toHaveTitle` | 找路由跳转或页面初始化逻辑 |

步骤：
1. 根据 Locator（ID、class、role、text）在源文件中定位相关代码
2. `Read` 相关文件，理解数据流：输入来源 → 中间处理 → 最终输出
3. 对比 Expected vs Received，确定逻辑错误所在

### 第 4 步：最小化修复

- 用 `StrReplace` 精确替换出错的那一行或片段
- 每次只改一处，不做无关重构
- 只修改业务代码，不修改测试文件（`.spec.js` / `.spec.ts`）

### 第 5 步：回到第 1 步

再次运行测试，处理下一个失败，直到全绿。

## 安全限制

- 同一个测试失败修复超过 **3 次**仍未通过 → 停止循环，向用户说明情况，等待指示
- 若修复后出现新的测试失败，优先处理新失败，旧失败计数重置

## 示例

**示例 1 — 值计算错误（toHaveText）**

```
Locator:  locator('#total')
Expected: "¥180.00"
Received: "¥198.00"
```

追踪：`#total` ← `calculateTotal()` ← 折扣系数写错 → `StrReplace` 修正系数

**示例 2 — 元素不可见（toBeVisible）**

```
Locator:  locator('.success-banner')
Expected: visible
Received: hidden
```

追踪：`.success-banner` 的显示条件 ← 提交逻辑返回值 ← 找到状态未正确更新 → 修复

**示例 3 — 表单值错误（toHaveValue）**

```
Locator:  locator('#username')
Expected: "alice"
Received: ""
```

追踪：`#username` 的默认值或填充逻辑 ← 找到初始化代码 → 修复
