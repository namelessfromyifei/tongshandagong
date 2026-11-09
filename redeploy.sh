#!/usr/bin/env sh
# 通山打拱 · 增量重部署（由 GitHub Webhook 触发，server.js /webhook 调用）
# 仅做：拉最新代码 + 装依赖 + PM2 重启（不再执行首次安装步骤，见 deploy.sh）
set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

# 兼容旧部署：app-update/manifest.json 以前只存在于服务器（未跟踪），现已纳入仓库。
# 若服务器上还有未跟踪的同名文件，git pull 会被拒绝（untracked would be overwritten），先备份再拉。
if [ -f app-update/manifest.json ] && ! git ls-files --error-unmatch app-update/manifest.json >/dev/null 2>&1; then
  BAK="app-update/manifest.json.bak-$(date +%Y%m%d%H%M%S)"
  mv -f app-update/manifest.json "$BAK"
  echo "==> 已备份旧的 app-update/manifest.json → $BAK"
fi

echo "==> git pull"
git pull --ff-only || { echo "git pull 失败，中止部署"; exit 1; }

echo "==> 同步 APK 到 app-update/"
mkdir -p app-update
# 目标文件名取自 manifest 的 apkUrl（tongshandagong-<版本>.apk，下载时带版本）；解析失败退回 latest.apk
APK_NAME=$(node -e 'try{var m=require("./app-update/manifest.json");var u=String(m.apkUrl||"");if(u.indexOf("/app-update/")===0){var n=u.slice(12);if(n&&n.indexOf("/")<0&&n.indexOf("\\")<0&&n.indexOf("..")<0)process.stdout.write(n);}}catch(e){}' 2>/dev/null)
[ -n "$APK_NAME" ] || APK_NAME="latest.apk"
if [ -f release/latest.apk ]; then
  changed=0
  for t in "$APK_NAME" latest.apk; do
    if [ ! -f "app-update/$t" ] || ! cmp -s release/latest.apk "app-update/$t"; then
      cp -f release/latest.apk "app-update/$t"
      changed=1
    fi
  done
  if [ "$changed" = "1" ]; then echo "   已更新 app-update/$APK_NAME"; else echo "   APK 无变化"; fi
else
  echo "   release/latest.apk 不存在，跳过"
fi

echo "==> npm install --production"
npm install --production

echo "==> pm2 restart tongshandagong"
pm2 restart tongshandagong

echo "==> ✅ 部署完成"
