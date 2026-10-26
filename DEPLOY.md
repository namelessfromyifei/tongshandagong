# 通山打拱 · 多人联网部署指南

> 架构：Node.js(Express) + Socket.IO，服务器权威，AI 补位，断线可重连。
> 目标：推送到个人 GitHub → 云服务器部署 → 玩家用 IP 直接访问（暂不配域名）。

---

## 一、本地结构

```
tongshandagong/
├── server.js          # 服务器（Express + Socket.IO）
├── package.json
├── deploy.sh          # 服务器一键部署脚本
├── js/                # 引擎/AI（服务端 Node 复用，浏览器也加载）
├── public/            # 前端静态资源（浏览器加载）
│   ├── index.html     # 房间/大厅 + 牌桌
│   ├── css/style.css
│   └── js/{engine,ai,ui-net,net}.js
└── tests/             # 引擎测试 + 联调脚本
```

---

## 二、本地开发运行

```bash
npm install            # 已装则跳过
node server.js         # 默认 8080，PORT=3000 node server.js 可改
```

打开 `http://localhost:8080`，输入昵称 → 创建房间（或输房间号加入）→ 开始。

**多开测试**：同一浏览器用两个隐身窗口，或两个浏览器，各进一个房间/加入同一房间码。

---

## 三、推送到 GitHub

```bash
cd tongshandagong
git init
git add .
git commit -m "通山打拱多人联网版"
git remote add origin git@github.com:你的用户名/tongshandagong.git
git push -u origin main
```

> 若仓库已存在：`git remote add origin ... && git push -u origin main` 即可。
> `.gitignore` 已排除 node_modules。

---

## 四、云服务器部署（Ubuntu 示例）

### 方式 A：用脚本（推荐）
```bash
# 上传 deploy.sh 到服务器后
sudo ./deploy.sh   # 会装 Node/PM2、拉代码、装依赖、起服务
```
> 脚本里 `GIT_URL` 未设时跳过克隆，需手动把代码放到 `/opt/tongshandagong`。
> 推荐在脚本顶部填好你的 `GIT_URL` 后执行。

### 方式 B：手动
```bash
# 1. 装 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs
# 2. 拉代码
sudo git clone git@github.com:你的用户名/tongshandagong.git /opt/tongshandagong
cd /opt/tongshandagong && sudo npm install --production
# 3. PM2 守护
sudo npm i -g pm2
sudo pm2 start server.js --name tongshandagong
sudo pm2 save && sudo pm2 startup
```

---

## 五、开放端口（关键）

云控制台安全组 + 服务器防火墙都要放行 **TCP 8080**（或你改的 PORT）：

```bash
sudo ufw allow 8080/tcp      # 若用 ufw
```
阿里云/腾讯云/华为云：控制台「安全组」→ 入方向 → 添加 TCP 8080，来源 0.0.0.0/0。

---

## 六、访问

```
http://服务器公网IP:8080
```

### 微信头像昵称授权（可选）

仅用 IP 访问时无法使用微信网页授权。需要：

1. 已认证服务号 + 已备案域名 + HTTPS；
2. 公众号后台把域名配置为「网页授权域名」；
3. 启动时设置 `WX_APPID`、`WX_APPSECRET`、`WX_OAUTH_BASE`、`SESSION_SECRET`。

完整步骤（Nginx 配置、验证文件、错误码）见 [docs/微信授权接入.md](docs/微信授权接入.md)。未配置时游戏自动降级为手动昵称，不影响现有部署。

玩家输入昵称 → 创建房间（4 位房间码）→ 朋友输房间码加入。人不满 4 用 AI 补位，房主可点「AI补位」随时开关，人齐点「开始对局」。

---

## 七、常见问题

- **外网访问不了**：安全组/防火墙没放行 8080，或服务器用的不是公网 IP（NAT）。
- **想换端口**：`PORT=3000 pm2 restart tongshandagong --update-env`。
- **断线**：掉线后重连归位（房间号 + 昵称/微信），座位保留不踢；一场未结束时任何人不可被踢
  （离线踢出仅在建房等待或一场整体结束后生效）。想提前收场：4 位在线真人房可发起
  「提前结束本场」共识，其余三家全同意才生效。
- **日志**：`pm2 logs tongshandagong`。

> 后续想上域名 + HTTPS：买域名备案（国内服务器必须），Nginx 反代 443 → 8080，配 certbot 证书。可另行加。
