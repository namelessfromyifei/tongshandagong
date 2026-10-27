# 通山打拱 · 多人联网部署指南

> 架构：Node.js(Express) + Socket.IO，服务器权威，AI 补位，断线可重连。
> 目标：推送到个人 GitHub → 云服务器部署 → 玩家用 IP 直接访问（暂不配域名）。

---

## 一、本地结构

```
tongshandagong/
├── server.js          # 服务器（Express + Socket.IO，含 /webhook 自动部署）
├── package.json
├── deploy.sh          # 服务器一键部署脚本（首次安装）
├── redeploy.sh        # 增量重部署脚本（Webhook push 触发）
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
git remote add origin git@github.com:zhanghan4141-oss/tongshandagong.git
git push -u origin main
```

> 若仓库已存在：`git remote add origin ... && git push -u origin main` 即可。
> 注意：自动部署的 Webhook **只认「被推送的仓库」**——推送目标当前为 `zhanghan4141-oss/tongshandagong`，Webhook 必须配在这个仓库上（见四·方式 C）。
> `.gitignore` 已排除 node_modules。

---

## 四、云服务器部署（Ubuntu 示例）

### 方式 A：用脚本（推荐）
```bash
# 上传 deploy.sh 到服务器后
sudo ./deploy.sh   # 会装 Node/PM2、拉代码、装依赖、起服务
```
> 脚本里 `GIT_URL` 未设时跳过克隆，需手动把代码放到 `/home/admin/tongshandagong`。
> 推荐在脚本顶部填好你的 `GIT_URL` 后执行。

### 方式 B：手动
```bash
# 1. 装 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs
# 2. 拉代码
sudo git clone git@github.com:zhanghan4141-oss/tongshandagong.git /home/admin/tongshandagong
cd /home/admin/tongshandagong && sudo npm install --production
# 3. PM2 守护
sudo npm i -g pm2
sudo pm2 start server.js --name tongshandagong
sudo pm2 save && sudo pm2 startup
```

### 方式 C：GitHub Webhook 自动部署（push 后自动更新）

1. **配置密钥**：在 `/home/admin/tongshandagong/ecosystem.config.js`（复制自 `ecosystem.config.example.js`）的 `env` 中设置 `WEBHOOK_SECRET`（与 GitHub 后台一致），然后 `pm2 restart tongshandagong` 使生效。
2. **GitHub 添加 Webhook**：**推送目标仓库**（当前为 `zhanghan4141-oss/tongshandagong`）→ Settings → Webhooks → Add webhook
   - Payload URL：`https://www.zhangyuning.xyz/webhook/deploy`
   - Content type：`application/json`
   - Secret：与上面 `ecosystem.config.js` 里设置的 `WEBHOOK_SECRET` 保持一致（可用 `openssl rand -hex 16` 生成）
   - Events：仅选「Push」（默认已含）
3. **验证**：`curl -s https://www.zhangyuning.xyz/webhook` 应返回 `{"webhook":"ready",...}`。
4. **效果**：push 到 `main`（或 `master`）后，服务器校验签名 → 执行 `redeploy.sh`（git pull → npm install --production → pm2 restart），数十秒内生效。

> 说明：`redeploy.sh` 只做增量更新；首次部署仍用 `deploy.sh` 或方式 B。
> 签名校验失败返回 401 且不触发；部署进行中重复触发会被忽略（409）。

---

## 五、开放端口（关键）

**域名 + HTTPS 上线后**（配置见「七、域名与 HTTPS」）：放行 **TCP 443**（玩家入口）+ **TCP 80**（跳转）；**8080 可只留本机访问或对外关闭**。

裸 IP 直连阶段则需放行（临时/兜底）：
```bash
sudo ufw allow 8080/tcp      # 若用 ufw
```
阿里云/腾讯云/华为云：控制台「安全组」→ 入方向 → 添加对应端口，来源 0.0.0.0/0。

---

## 六、访问

```
玩家访问入口（推荐）：`https://www.zhangyuning.xyz`

调试/兜底（域名不可用时）：`http://服务器公网IP:8080`
```

### 微信头像昵称授权（可选）

仅用 IP 访问时无法使用微信网页授权。需要：

1. 已认证服务号 + 已备案域名 + HTTPS（这三项现已就绪）；
2. 公众号后台把域名配置为「网页授权域名」；
3. 启动时设置 `WX_APPID`、`WX_APPSECRET`、`WX_OAUTH_BASE`、`SESSION_SECRET`。

完整步骤（Nginx 配置、验证文件、错误码）见 [docs/微信授权接入.md](docs/微信授权接入.md)。未配置时游戏自动降级为手动昵称，不影响现有部署。

玩家输入昵称 → 创建房间（4 位房间码）→ 朋友输房间码加入。人不满 4 用 AI 补位，房主可点「AI补位」随时开关，人齐点「开始对局」。

---

## 七、域名与 HTTPS（www.zhangyuning.xyz）

> 现状：域名已备案并解析、HTTPS 证书已就绪（云厂商免费证书）、Nginx 已可访问。玩家入口为 **https://www.zhangyuning.xyz**，裸域 `zhangyuning.xyz` 通过 80 端口 301 跳转到 www。Nginx 将 443 全部反代到本机 Node 的 8080。

### 7.1 服务器端对齐要点（Nginx）

完整反代示例见 [docs/nginx-https.conf.example](docs/nginx-https.conf.example)（真域名、裸域跳转、Socket.IO 升级头、Webhook 透传一应俱全）。以下是重点核对项：

1. **Socket.IO 长连接**：`proxy_http_version 1.1;` + `proxy_set_header Upgrade $http_upgrade;` + `proxy_set_header Connection "upgrade";`，缺了它对局/聊天长连接会断。
2. **协议识别**：`proxy_set_header X-Forwarded-Proto $scheme;` —— server.js 已设 `trust proxy=1`，靠这个头识别 https（Cookie 的 Secure 标记、协议判断）。
3. **Webhook 原样透传**：`proxy_pass` 默认逐字节转发请求体，GitHub 的 HMAC 验签不受影响；**切勿**开启 gzip 解压/改写后再转发。`client_max_body_size 1m;` 与 `express.raw(limit:'1mb')` 对齐。
4. **裸域跳转**：80 端口 `return 301 https://www.zhangyuning.xyz$request_uri;`（裸域与 www 统一跳）；若还要 `https://zhangyuning.xyz` 也能访问，需另签一张裸域证书。
5. **端口**：安全组 + ufw 放行 443；80 参与跳转建议一并放行；8080 可收窄为仅本机。

### 7.2 仓库与 Webhook 对齐

Webhook 只认「被推送的仓库」。当前推送目标为 `zhanghan4141-oss/tongshandagong`，因此：

```bash
# 服务器上的仓库 remote 指向同一仓库，否则 redeploy.sh 的 git pull 会拉旧仓
cd /home/admin/tongshandagong && git remote set-url origin git@github.com:zhanghan4141-oss/tongshandagong.git
```

GitHub 后台 Webhook 确认配在 `zhanghan4141-oss/tongshandagong`：
- Payload URL：`https://www.zhangyuning.xyz/webhook/deploy`
- Content type：`application/json`
- Secret：与服务器 `ecosystem.config.js` 的 `WEBHOOK_SECRET` 一致
- Events：仅 Push

```bash
curl -s https://www.zhangyuning.xyz/webhook   # 期待 {"webhook":"ready",...}
```

### 7.3 线上配置建议（ecosystem.config.js）

```js
ALLOWED_ORIGINS: 'https://www.zhangyuning.xyz',   // 收紧跨域白名单；见下方注意
WX_OAUTH_BASE:   'https://www.zhangyuning.xyz',    // 与公众号「网页授权域名」一致
```

> 注意：启用 `ALLOWED_ORIGINS` 后仅白名单来源可连（本地 localhost、App 的 `https://localhost` 已内置放行）。**在玩家全部切到域名前不要启用**，否则仍走 `http://IP:8080` 直连的玩家会被拒。

### 7.4 上线验证清单

- [ ] `https://www.zhangyuning.xyz` 打开大厅 → 建房 / 加入 4 人（Socket.IO 走 wss）
- [ ] `curl -s https://www.zhangyuning.xyz/webhook` 返回 ready
- [ ] push 到 `zhanghan4141-oss/main` 后，`pm2 logs` 数十秒内出现部署日志
- [ ] `http://zhangyuning.xyz` 与 `http://www.zhangyuning.xyz` 均 301 到 `https://www.zhangyuning.xyz`
- [ ] 微信头像昵称授权可用（公众号网页授权域名 = www.zhangyuning.xyz）

---

## 八、常见问题

- **外网访问不了**：安全组/防火墙没放行 8080，或服务器用的不是公网 IP（NAT）。
- **想换端口**：`PORT=3000 pm2 restart tongshandagong --update-env`。
- **断线**：掉线后重连归位（房间号 + 昵称/微信），座位保留不踢；一场未结束时任何人不可被踢
  （离线踢出仅在建房等待或一场整体结束后生效）。想提前收场：4 位在线真人房可发起
  「提前结束本场」共识，其余三家全同意才生效。
- **日志**：`pm2 logs tongshandagong`。

> 域名 + HTTPS 已上线，配置见「七、域名与 HTTPS」。证书为云厂商免费 DV（一年期），到期前在云控制台重签并替换 `/etc/nginx/ssl/` 下的 pem/key，再 `sudo systemctl reload nginx`。
