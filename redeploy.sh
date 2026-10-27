#!/usr/bin/env sh
# 通山打拱 · 增量重部署（由 GitHub Webhook 触发，server.js /webhook 调用）
# 仅做：拉最新代码 + 装依赖 + PM2 重启（不再执行首次安装步骤，见 deploy.sh）
set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "==> git pull"
git pull --ff-only || { echo "git pull 失败，中止部署"; exit 1; }

echo "==> npm install --production"
npm install --production

echo "==> pm2 restart tongshandagong"
pm2 restart tongshandagong

echo "==> ✅ 部署完成"
