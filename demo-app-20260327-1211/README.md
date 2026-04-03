# demo-app-20260327-1211 · 简易超级玛丽

按「方式一 + 自动时间戳目录名」生成的前端小游戏：Canvas 平台跳跃、巡逻蘑菇怪、终点旗杆。

## 运行

```bash
cd /Users/yangcong/AI-testing/AutoFlow/demo-app-20260327-1211
npm install
npm start
```

浏览器打开终端提示地址，默认：**http://127.0.0.1:4174**（与旧 `demo-app` 的 4173 错开）。

换端口：`PORT=3000 npm start`。

## 操作

- **← →** 或 **A D**：移动  
- **空格 / ↑ / W**：跳跃  
- **R**：重开  
- 踩蘑菇怪**头顶**可消灭；碰到侧面会失败。

## 测试

```bash
npm test
```

## 文件

- `src/server.js`：静态资源服务  
- `public/index.html`、`public/game.js`：游戏页面与逻辑  
- `tests/game.spec.js`：Playwright 冒烟测试  
