# AutoFlow 工程化仓库

当前仓库按“核心平台 + 归档示例 + skills 元数据”组织，核心入口是 `visualization`。

## 核心保留结构

- `visualization/`：Compose 2.0 一键闭环平台（前端 + API + 运行引擎）
  - `runs/`：每次运行证据产物（建议忽略，不入库）
  - `projects/`：每次需求自动生成的独立代码目录（建议忽略，不入库）
- `skills-lock.json`、`skills-lock.md`：skills 锁与说明
- `.agents/`：本地技能目录（含 `playwright-fix-loop`）
- `.claude/`、`.commandcode/`：若存在则按本地工具链保留

## 历史模块（已归档）

- `archive/apps/demo-app/`：订单折扣测试闭环示例
- `archive/apps/demo-app-20260327-1211/`：超级玛丽示例
- `archive/docs/`：历史演示文档（`demo-requirement.md`、`demo-prompts.md`、`runbook.md`）

## playwright-fix-loop 技能使用方式

`playwright-fix-loop` 是本项目内置的自定义技能，位于 `.agents/skills/playwright-fix-loop/SKILL.md`。

**作用：** 驱动"跑测试 → 失败交给 `systematic-debugging` 处理 → 再跑"的外层循环，直到所有测试通过，无需人工介入。

**触发方式：** 在 Cursor Agent 模式下，在输入框选择该技能后发送：

```
/playwright-fix-loop
```

**执行逻辑（两个技能联动）：**

```
playwright-fix-loop（外层循环驱动）
  └─ 运行测试
       ├─ 全部通过 → 结束，报告用户
       └─ 有失败 → systematic-debugging（完整四阶段处理）
                       ├─ Phase 1：根因调查（读错误、追踪数据流）
                       ├─ Phase 2：模式分析（找可对比的正常代码）
                       ├─ Phase 3：假设验证（最小变更验证假设）
                       └─ Phase 4：实现修复（改根因，不改测试文件）
                             └─ 修复完成 → 回到运行测试
```

**安全保护：** 由 `systematic-debugging` 内置的 Phase 4.5 负责：同一问题修复 3 次仍失败时，停止并质疑架构设计，等待用户指示。

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
cd archive/apps/demo-app
npm install
npx playwright install chromium
npm test
```

当前代码已处于"修复后"状态，测试应通过。

### 3) 平台快速启动

```bash
cd visualization
npm install
npm start
```

打开：`http://127.0.0.1:4180/`

### 4) 在 Cursor 中演示闭环
按 `archive/docs/demo-prompts.md` 的顺序给 Cursor 发送指令，即可复现完整流程。

## 如果要重新演示"先失败再修复"
1. 在 `archive/apps/demo-app/public/index.html` 把 `subtotal * 0.9` 暂时改回 `subtotal * 0.95`（在该目录下执行后续 `npm test`）。
2. 运行 `npm test` 观察失败。
3. 再改回 `0.9`，重新测试通过。

## 可安全清理项（可再生）

以下目录删除后可通过安装/测试命令恢复：

- `node_modules/`
- `visualization/node_modules`
- `visualization/runs`
- `visualization/projects`
- `visualization/test-results`
- `visualization/playwright-report`
- `archive/apps/**/node_modules`
- `archive/apps/**/test-results`
- `archive/apps/**/playwright-report`

## 一键恢复建议

```bash
# 根工作区（如需）
npm install

# 核心平台
cd visualization && npm install

# 若需要运行历史 demo（归档目录）
cd ../archive/apps/demo-app && npm install
```

## 参考

- Skills 官网目录：[skills.sh](https://skills.sh/)
- 平台详细说明：`visualization/README.md`
- 执行证据：见 `archive/docs/runbook.md`
