# Cursor 对话脚本（Skills 闭环）

以下脚本用于在 Cursor 里演示“需求 -> 开发 -> 测试 -> 修复 -> 回归”。

## 0) 前置准备
- 已在项目级安装 skills（见 `skills-lock.md`）。
- 项目目录：`/Users/yangcong/AI-testing/AutoFlow`

## 1) 需求拆解（writing-plans）
可直接对 Cursor 发送：

```text
请使用 writing-plans 思路，把 demo-requirement.md 拆成可执行任务，按「开发、测试、验证」三段输出。
```

## 2) 开发实现（vercel-react-best-practices + executing-plans）
```text
请按 executing-plans 方式执行开发任务：
1) 在 demo-app 中实现订单计算页面
2) 保持代码结构清晰、可测试
3) 告诉我每一步改了哪些文件
```

## 3) 自动化测试（webapp-testing）
```text
请用 webapp-testing 的实践，为 demo-app 添加 Playwright 用例，覆盖 SAVE10 打九折主流程。
并先运行一次测试，展示失败信息。
```

## 4) 缺陷定位与修复（systematic-debugging）
```text
请使用 systematic-debugging 的方式：
1) 基于失败日志定位根因
2) 修复代码
3) 解释为什么会出现该 bug
```

## 5) 回归与验收（verification-before-completion）
```text
请执行 verification-before-completion：
1) 重新运行自动化测试
2) 给出通过证据
3) 对照 demo-requirement.md 核对验收项
```

## 6) 自动化编排（subagent-driven-development，可选）
```text
请以 subagent-driven-development 的方式，把「测试执行」「日志分析」「修复建议」拆给并行子任务，并汇总最终结果。
```
