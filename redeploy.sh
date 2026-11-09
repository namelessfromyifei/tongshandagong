#!/usr/bin/env sh
# 通山打拱 · 增量重部署（由 GitHub Webhook 触发，server.js /webhook 调用）
# 仅做：拉最新代码 + 装依赖 + PM2 重启（不再执行首次安装步骤，见 deploy.sh）
set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "==> git pull"
git pull --ff-only || { echo "git pull 失败，中止部署"; exit 1; }

echo "==> 同步 APK 到 app-update/"
mkdir -p app-update
if [ -f release/latest.apk ]; then
  if [ ! -f app-update/latest.apk ] || ! cmp -s release/latest.apk app-update/latest.apk; then
    cp -f release/latest.apk app-update/latest.apk
    echo "   已更新 app-update/latest.apk"
  else
    echo "   APK 无变化"
  fi
else
  echo "   release/latest.apk 不存在，跳过"
fi

echo "==> npm install --production"
npm install --production

echo "==> pm2 restart tongshandagong"
pm2 restart tongshandagong

echo "==> ✅ 部署完成"
