# Skills 闭环 Demo（Cursor）

这个项目演示如何在 Cursor 中，基于 skills.sh 的高质量 skills，完成一条完整工程闭环：

需求 -> 开发 -> 自动化测试 -> 发现 bug -> 修复 -> 回归通过

## 项目结构
- `demo-requirement.md`：示例需求
- `demo-prompts.md`：Cursor 对话脚本
- `skills-lock.md`：skills 选型与安装说明
- `runbook.md`：一次完整闭环执行记录
- `skills-lock.json`：skills CLI 生成的锁文件
- `demo-app/`：最小可运行 Web 示例（含 Playwright 测试）
- `demo-app-20260327-1211/`：时间戳目录 · 简易超级玛丽 Canvas 小游戏（端口默认 `4174`）

## 已选最佳 Skills
- 开发：`vercel-react-best-practices`
- 测试：`webapp-testing`
- 自动化：`subagent-driven-development` + `executing-plans`
- 改善代码：`systematic-debugging`
- 辅助：`writing-plans` + `verification-before-completion`

选择依据：优先 skills.sh 中安装量高且社区验证较充分的技能组合，满足你的“开发 + 测试 + 自动化 + 代码改进”目标。

## 快速开始

### 1) 安装 skills（项目级）
在项目根目录执行：

```bash
npx skills add vercel-labs/agent-skills@vercel-react-best-practices -y
npx skills add anthropics/skills@webapp-testing -y
npx skills add obra/superpowers@subagent-driven-development -y
npx skills add obra/superpowers@executing-plans -y
npx skills add obra/superpowers@systematic-debugging -y
npx skills add obra/superpowers@writing-plans -y
npx skills add obra/superpowers@verification-before-completion -y
```

可用 `npx skills ls --json` 验证安装结果。

### 2) 运行 demo-app
```bash
cd demo-app
npm install
npx playwright install chromium
npm test
```

当前代码已处于“修复后”状态，测试应通过。

### 3) 在 Cursor 中演示闭环
按 `demo-prompts.md` 的顺序给 Cursor 发送指令，即可复现完整流程。

## 如果要重新演示“先失败再修复”
1. 在 `demo-app/public/index.html` 把 `subtotal * 0.9` 暂时改回 `subtotal * 0.95`。
2. 运行 `npm test` 观察失败。
3. 再改回 `0.9`，重新测试通过。

## 参考
- Skills 官网目录：[skills.sh](https://skills.sh/)
- 执行证据：见 `runbook.md`
