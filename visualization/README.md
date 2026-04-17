# AI 软件工程闭环平台（Skills + CDP）

这是一个可直接运行的本地闭环平台：每个步骤强绑定 `.agents` skill；**步骤 4** 根据 **步骤 2** 架构拆解生成测试用例与 `tests/*.spec.js`；**步骤 5** 在子项目内执行 **`BASE_URL`/`PORT` + `npx playwright test tests`**（与 `tests/*.spec.js` 对齐；`playwright.config` 的 `webServer` 拉起或复用服务），可选改为 `cursor agent` + Cursor MCP，驱动 5→6→7→5 修复回路。

## 核心能力

- 按 `skills-manifest.json` 固定映射执行 1~8 步，运行前先校验 skill 是否存在
- 后端调用 `cursor agent`，在 prompt 中强制注入当前步骤 skill 约束
- 步骤 5 默认在生成项目目录执行 **`npx playwright test tests`**（与 `tests/` 下用例一致）；请求体可传 `cdpDriver: "cursor_mcp"` 改为 MCP 路径（非 `echo` 占位）
- 页面显示每步 skill、CDP 状态卡、结构化失败详情（locator/expected/received）
- 长耗时阶段通过 `cli_heartbeat` 显示“CLI running”动效与计时器，避免卡死感
- 实时透传 `cli_chunk`（stdout/stderr）到日志面板，能看到 CLI 增量输出
- 每个项目目录下 **`.autoflow/report.md`**（及同目录其它步骤产物）输出 skills 证据链 + CDP 执行摘要；**同一工作区多次运行会覆盖更新**该目录
- 每个需求自动创建独立目录：`visualization/projects/<runId>-<slug>/`

## 步骤与 skill 绑定表（strict_per_step）

- 1 需求输入：`writing-plans`
- 2 架构拆解：`writing-plans`
- 3 协作开发：`subagent-driven-development`
- 4 测试用例与策略（对齐步骤2任务）：`webapp-testing`
- 5 UI+API 真测：`webapp-testing`
- 6 失败分析：`systematic-debugging`
- 7 自动修复：`executing-plans` + `verification-before-completion`
- 8 稳定收敛：`verification-before-completion`

## 步骤 4 之后流水线「像被跳过」的原因

引擎按请求体里的 `enabledStepIds` 决定每一步是否执行（见 `run-engine.js` 中 `should(stepId)`）。**步骤 5 是 CDP 真测的硬开关**：若未启用步骤 5，在步骤 4（若启用）完成后会**直接结束主流程**——步骤 5～7 标记为 `skipped`，步骤 8 在仍启用时提示「未执行 CDP，按所选步骤结束」，并打日志「未启用 CDP 测试，流程已按选项结束」。这是**按设计**的行为，不是随机跳过。

常见误解：界面左侧仍可勾选步骤 4、8，但**若步骤 5 未勾选**，提交给 `/api/runs` 的列表里就没有 `5`，后端便不会进入 CDP 真测与 6→7 修复环。页面在取消步骤 5 时会显示橙色说明条；点击运行后日志会有一行 **「本次启用步骤: [...]」**，请确认其中包含 `5`。创建 run 时还可传 **`cdpDriver`**：`"playwright"`（默认）或 `"cursor_mcp"`。

### 如何自查

1. 打开项目下 **`projects/<目录名>/.autoflow/report.md`**，看 **「启用步骤」** 是否包含 `5`；看 **「步骤状态」** 里 5～7 是否为 `skipped`。
2. 看平台日志是否出现 **「未启用 CDP 测试，流程已按选项结束」**。
3. 步骤 4 产物在 **`.autoflow/04_test_strategy.md`**（与 `report.md` 同目录）；步骤 4 成功时日志会有 **「步骤4 产物已写入: …」**（绝对路径）。

### 若启用步骤 5 仍异常

- **步骤 4 compose 失败**：run 整体 `failed`，不会进入步骤 5。
- **步骤 5 及以后**：查看 `error`、`05_test_round_*.log` 与 CDP 状态卡，属于 CDP/测试失败路径，与「未启用 5 的提前 return」不同。

### 期望跑满测试与修复环时

务必勾选 **步骤 5**（并视需要勾选 6、7），使 `enabledStepIds` 包含 5，引擎才会从 `run-engine.js` 中 CDP 段落继续执行。

## 目录说明

- `skills-manifest.json`：step->skill 固定契约
- `run-engine.js`：主状态机、skills 校验、CDP 真测与修复回路
- `cursor-cli-adapter.js`：compose prompt 注入 skill 约束
- `cdp-test-runner.js`：可选独立脚本（`npm run verify:cdp`），用于不经过步骤 4 时的 **connectOverCDP** 冒烟；**平台步骤 5 默认走子项目 `npx playwright test tests`**
- `platform.html`：前端可视化（steps/skills/CDP/failure）
- `projects/<目录名>/.autoflow/`：与该项目代码同根的**运行证据**（`01_requirement.md`、`04_test_strategy.md`、`05_test_round_*.log`、`report.md` 等）；同一目录再次运行会**覆盖更新**
- `projects/<runId>-<slug>/`：每次需求的独立代码目录（新建时目录名含本次 run 的 UUID 前缀）
- `projects/<runId>-<slug>/tests/`：该项目专属测试目录（含 `smoke.spec.js` 模板）
- `visualization/runs/<uuid>/`：**旧版**独立证据目录；「已完成」列表仍会扫描，新运行不再写入此处

## 目录规范（推荐）

- `visualization/` 只放平台源码与配置（`server.js`、`run-engine.js`、`platform.html` 等）
- `projects/` 下放运行期生成产物与代码；**`.autoflow/`** 仅证据文件，可与项目一并清理
- 需求生成代码只在 `projects/<runId>-<slug>/` 中演进，避免污染平台主代码
- 历史 demo 与演示资产统一放仓库 `archive/`，不与平台源码混放
- `projects/<runId>-<slug>/`：每次需求的独立代码目录（自动创建）

## 启动

```bash
cd /Users/yangcong/AI-testing/AutoFlow/visualization
npm install
npm start
```

访问 [http://127.0.0.1:4180/](http://127.0.0.1:4180/)。

## CDP 真测前置

- 已安装 Cursor CLI，且 `cursor --help` 可执行
- 已完成 `cursor agent login`
- 目标工作目录可执行 `npm start`
- 已安装 Playwright 运行依赖（首次真测会调用 `playwright` Chromium）

### CDP 与 MCP（自检）

- **默认（推荐）**：步骤 5 在 workspace 执行 **`BASE_URL=http://127.0.0.1:<appPort> PORT=<appPort> npx playwright test tests`**，由项目内 `playwright.config.js` 的 **`webServer`** 启动或复用 `node src/server.js`，跑 **`tests/` 下全部 `*.spec.js`**；**不经过** Cursor MCP。需要单独验证 CDP 连接时可另用 [cdp-test-runner.js](cdp-test-runner.js) / `npm run verify:cdp`。若在 CI 需要禁止复用服务，可再加 **`CI=1`**。
- **Playwright 可视化 HTML 报告**：在子项目 `playwright.config.js` 的 `reporter` 中加入 **`html`**（例如 `outputFolder: "playwright-report", open: "never"`），步骤 5 跑测后会在项目根生成 **`playwright-report/`**；在**该子项目目录**执行 **`npx playwright show-report`** 即可用浏览器打开。流水线生成的 **`report.md`** 中也会写明路径与命令（见 `run-engine.js` 的 `buildReport`）。
- **可选：步骤 5 使用 Cursor MCP**：在平台「步骤 5 CDP 驱动」中选择 **Cursor MCP** 时，后端会先在本机 `npm start` 拉起应用，再调用 **`cursor agent`**，由代理使用你在 Cursor 中已启用的 **浏览器 / Chrome DevTools 类 MCP**（例如 chrome-devtools-mcp）完成打开 `http://127.0.0.1:<appPort>/` 等验收；与 Playwright runner 二选一。
  - **无人值守 /「权益全部允许」**：引擎在 MCP 轮次会传 **`--trust --approve-mcps --force`**（`cursor agent --help`：`--approve-mcps` 自动批准 MCP 服务器，`--force`/`--yolo` 在非交互下尽量放行）。若仍出现 `User rejected MCP`，请先 **升级 Cursor CLI**，再核对 `cursor agent mcp list` 是否为 `ready`。
  - **配置**：在 Cursor 中按官方文档配置 MCP（全局或项目的 `mcp.json`）。CLI 侧可执行 `cursor agent mcp list` / `cursor agent mcp list-tools <名称>` 自检是否可见服务器与工具。
  - **注意**：MCP 依赖本机 Cursor CLI、登录与 MCP 授权；无图形环境或未启用浏览器 MCP 时易失败。自动化/CI 建议仍用 **Playwright**。若 CLI 下 MCP 工具异常，可先回退到默认驱动或见 [Cursor 论坛相关讨论](https://forum.cursor.com)。
  - **与「CDP 有头」关系**：MCP 模式下「有头/停留」由 MCP 与浏览器行为决定，平台侧的 **CDP 有头** 开关**不生效**（前端选 MCP 时会禁用该勾选）。

#### 为何日志里写「无 MCP」或步骤 5 得到 `ok: false`

- **平台调的是 `cursor agent` 子进程**，不是 Cursor IDE 里 Composer/Chat 的 MCP 会话；两者加载的 MCP 列表可能不一致（版本、工作区信任、`mcp.json` 作用域、CLI 已知限制等）。
- **若 CLI 会话里没有任何浏览器 / DevTools 类 MCP 工具**，按设计代理应输出 **`ok: false`**，并在 `error` 中说明原因；这不是「平台坏了」，而是 **MCP 未对该 CLI 会话生效**。
- **自检（与跑平台同一终端）**：
  - `cursor agent mcp list`：是否列出 chrome-devtools（或你配置的浏览器 MCP 名称）。
  - `cursor agent mcp list-tools <名称>`：是否列出导航、快照等工具。
- **配置建议**：除全局 `~/.cursor/mcp.json` 外，可在 **`visualization/`** 或本次 **`projects/<id>-<slug>/`** 下放置 `.cursor/mcp.json` 做实验（部分环境下 CLI 对全局配置不敏感，论坛有讨论）。
- **若 CLI 始终无浏览器 MCP**：请把步骤 5 驱动改回 **Playwright**；平台会在 `.autoflow/05_mcp_preflight_round_*.log` 中保存预检原始输出（便于对照）。
- **命令行快速验证（与平台步骤 5 默认 Playwright 路径使用同一 runner）**：

```bash
cd visualization
npm install
npx playwright install chromium   # 首次或换机后
npm run verify:cdp
```

成功时进程退出码为 `0`，且 stdout 末尾 JSON 中 `ok: true`、`steps` 含 `ui-cdp-pass`。可用环境变量 `CDP_WORKSPACE` 指定项目目录；未设置时自动使用 `projects/` 下第一个含 `package.json` 的子目录。

**有头模式（本机弹出 Chromium 窗口）**：默认无头。任选其一：

- `npm run verify:cdp -- --headed`（可选再传 `--lingerMs 5000` 控制关窗前停留毫秒数；有头且省略 `lingerMs` 时 runner 默认约 3 秒）
- `AUTOFLOW_CDP_HEADED=1 npm run verify:cdp`
- 直接调用：`node cdp-test-runner.js --workspace "<项目路径>" --appPort 4173 --appHost 127.0.0.1 --headed`

有头时 JSON 中会包含 `headed: true`、`lingerMs`；`steps` 在关窗前多一步 `linger-visible`。无图形环境的服务器上可能失败，属预期。

有头模式下会**复用浏览器启动后的首个标签页**并 `bringToFront`，再 `goto` 被测地址，避免你仍盯着 `about:blank` 而测试实际在后台新标签执行。

### 经平台 UI 验证步骤 5（与本地 `npx playwright test tests` 对照）

1. 在网页「流水线步骤」中**勾选步骤 5**（及需要的 6、7）。**CDP 驱动**选 **Playwright（默认）** 时：步骤 5 执行 **`npx playwright test tests`**（环境变量 `BASE_URL`/`PORT`）；勾选 **「CDP 有头模式」** 时追加 **`--headed`**（**停留毫秒**对当前路径**不生效**，仅历史/`verify:cdp` 语义）。选 **Cursor MCP** 时请先在本机配置好浏览器类 MCP。
2. 日志中：Playwright 路径应出现 **「步骤5启用 Playwright」**与「已发现 tests/ 用例文件」；MCP 路径应出现 **「步骤5启用 Cursor MCP 浏览器验页」**。`CDP 真测状态` 卡片在 Playwright 成功时可能无 JSON 摘要（Playwright 文本输出）；MCP 时多为 `cursor-mcp-ui-check`。
3. 查看 **`.autoflow/05_test_round_*.log`**：Playwright 时为 **Playwright 列表/断言输出**；MCP 时为 agent 输出 + 末尾摘要 JSON。MCP 模式下另有 **`.autoflow/05_mcp_preflight_round_*.log`**。

## 独立目录策略（默认开启）

- 创建 run 时不再使用手动 `workspacePath`
- 系统统一在 `visualization/projects/<runId>-<slug>/` 创建并执行项目
- 留空「已有项目目录」时每次 **新建** `projects/<uuid>-<slug>/`；填写同一已有目录则 **复用** 该项目并在其 `.autoflow/` **覆盖** 证据文件
- 页面与报告都会显示本次 `projectPath` 与 `appPort`
- 初始化会自动创建 `tests/` 与 `tests/smoke.spec.js`，保证每项目独立测试目录

## 验收检查清单（失败 -> 修复 -> 通过）

1. 页面 `CDP 真测状态` 卡片在旧版对照中曾使用 `mode=playwright-cdp-real-test`；当前默认路径为 **`playwright-project-tests`**（子项目 `npx playwright test tests`）
2. 首轮失败时，看到步骤 6/7 激活，且失败卡显示 `locator/expected/received`
3. 进入下一轮后步骤 5 再次执行，直到通过或达到最大迭代
4. `projects/.../.autoflow/report.md` 包含：
   - 每步 skills 记录
   - CDP 摘要（baseUrl/round/status）
   - 最终失败或通过结论
5. 长步骤期间“CLI running”状态条持续跳动，计时器每秒递增
6. 日志区可看到 `stdout/stderr` 增量输出，不再长时间静默
7. 若心跳中断超过 7 秒，页面提示“CLI 仍在执行，等待返回中...”
8. 运行结束后动效收敛到 `CLI completed/failed/stopped`
9. 同一 `projectPath` 再次运行时 **`appPort` 稳定**（按项目目录名派生），`.autoflow` 下报告与日志被更新而非新建另一套顶层 `runs/` 目录
10. 每个新项目目录下均存在 `tests/smoke.spec.js`

## 运行中动效事件说明

- `cli_heartbeat`：后端每 1.5 秒发送，包含 `stepId/phase/elapsedMs`
- `cli_chunk`：CLI 输出分块透传，包含 `stream(stdout|stderr)/text`
- `cli_phase_done`：单阶段执行结束提示，用于前端收敛与日志标记

## 清理建议

- 清理历史生成项目与证据：删除 `visualization/projects/*`（内含各项目的 `.autoflow/`）
- 若仍保留旧数据：可另删 `visualization/runs/*`（旧版独立证据目录）
- 不会影响平台主代码（`server.js/run-engine.js/platform.html`）
