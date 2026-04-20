#!/usr/bin/env bash
# 重启 ops-admin-lab 两个服务
# 用法：bash restart.sh

set -e
cd "$(dirname "$0")"

echo "🔄 停止旧进程..."
lsof -ti:4175 | xargs kill -9 2>/dev/null || true   # dev server
lsof -ti:4176 | xargs kill -9 2>/dev/null || true   # test-runner
lsof -ti:4177 | xargs kill -9 2>/dev/null || true   # playwright test server (独立端口)
sleep 1

echo "🚀 启动应用服务 (4175)..."
npm run dev &

echo "🚀 启动 Test Runner (4176)..."
node test-runner/server.js &

sleep 2

echo ""
echo "✅ 服务已就绪"
echo "   应用:        http://127.0.0.1:4175"
echo "   Test Runner: http://127.0.0.1:4176"
