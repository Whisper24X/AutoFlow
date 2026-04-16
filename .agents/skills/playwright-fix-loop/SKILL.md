---
name: playwright-fix-loop
description: 自主执行 Playwright 测试修复闭环：运行测试命令，将失败输出交给 systematic-debugging 完成定位与修复，再次运行，循环直到全部通过。当用户要求"跑测试并修复"、"测试失败帮我改"、"直到测试全通过"、"fix until green"时使用。适用于任何使用 Playwright 的 Web 项目，测试命令可为 npm test、yarn test、pnpm test 等。
---

# Playwright 测试自动修复闭环

驱动"跑测试 → 失败交给 systematic-debugging 处理 → 再跑"的外层循环，直到所有测试通过。

**职责划分：**
- `playwright-fix-loop`：负责外层循环（运行测试、传递错误、循环控制）
- `systematic-debugging`：负责每次失败的完整处理（根因调查 + 修复 + 验证）

## 执行流程

重复以下循环，直到测试命令退出码为 0：

### 第 1 步：确认测试命令并运行

从 `package.json` 的 `scripts` 推断测试命令（通常为 `npm test`），在项目目录执行并捕获完整输出。

若退出码为 0，向用户报告全部通过并结束。

### 第 2 步：有失败 → 整体交给 systematic-debugging

将完整的 Playwright 错误输出作为上下文，执行 `.agents/skills/systematic-debugging/SKILL.md` 的完整四阶段流程：

- **Phase 1**：根因调查（读错误、复现、追踪数据流）
- **Phase 2**：模式分析（找可对比的正常代码）
- **Phase 3**：假设验证（最小变更验证假设）
- **Phase 4**：实现修复（改根因、不改测试文件）

systematic-debugging 完成修复后，回到第 1 步。

### 第 3 步：回到第 1 步

再次运行测试。若仍有失败，重复第 2 步处理下一个；直到全绿结束。

## 安全限制

- systematic-debugging 内置了"修复 3 次失败则停止、质疑架构"的 Phase 4.5，本技能直接继承该限制
- 不额外叠加计数逻辑，以 systematic-debugging 的判断为准
- 若 systematic-debugging 判断需要向用户确认，暂停循环等待用户指示，确认后继续
