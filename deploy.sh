# 通山打拱 · 云服务器一键部署（Ubuntu/Debian）
# 用法：上传本脚本到服务器，chmod +x deploy.sh && sudo ./deploy.sh
# 说明：直接用 IP 访问（暂不配域名/HTTPS），默认端口 8080
set -e

PORT="${PORT:-8080}"
APP_DIR="${APP_DIR:-/opt/tongshandagong}"
GIT_URL="${GIT_URL:-}"   # 例：git@github.com:你的用户名/tongshandagong.git 或 https://…

echo "==> 1/5 安装 Node.js 20+"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> 2/5 安装 PM2"
if ! command -v pm2 >/dev/null; then
  npm install -g pm2
fi

echo "==> 3/5 拉取代码"
if [ -z "$GIT_URL" ]; then
  echo "  未设置 GIT_URL，跳过克隆（请手动把代码放到 $APP_DIR）"
  mkdir -p "$APP_DIR"
else
  if [ -d "$APP_DIR/.git" ]; then
    cd "$APP_DIR" && git pull
  else
    git clone "$GIT_URL" "$APP_DIR"
  fi
fi

echo "==> 4/5 安装依赖"
cd "$APP_DIR"
npm install --production

echo "==> 5/5 启动服务（PM2 守护，开机自启）"
pm2 start server.js --name tongshandagong
pm2 save
pm2 startup systemd || true

echo ""
echo "✅ 部署完成！"
echo "   访问地址：http://$(hostname -I | awk '{print $1}'):$PORT"
echo "   日志：pm2 logs tongshandagong"
echo "   提示：若外部访问不通，请确认云控制台安全组/防火墙已放行 TCP $PORT"
