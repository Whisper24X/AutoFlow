# Skills 选型与锁定

## 目标映射
- 开发 skills：`vercel-react-best-practices`
- 测试 skills：`webapp-testing`
- 自动化 skills：`subagent-driven-development`、`executing-plans`
- 改善代码 skills：`systematic-debugging`
- 闭环辅助：`writing-plans`、`verification-before-completion`

## 本地项目安装命令
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

## 已安装位置
- 项目级目录：`.agents/skills/`
- 锁文件：`skills-lock.json`

## 一键恢复
如果要在新环境恢复 skills：

```bash
npx skills experimental_install
```

## skills.sh 来源页面
- <https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices>
- <https://skills.sh/anthropics/skills/webapp-testing>
- <https://skills.sh/obra/superpowers/executing-plans>
- <https://skills.sh/obra/superpowers/subagent-driven-development>
- <https://skills.sh/obra/superpowers/systematic-debugging>
- <https://skills.sh/obra/superpowers/writing-plans>
- <https://skills.sh/obra/superpowers/verification-before-completion>
