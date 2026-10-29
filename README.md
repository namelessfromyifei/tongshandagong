# 通山打拱 · 多人联网版

湖北通山地方扑克玩法（屋规版）的 4 人 **2V2 在线对战**游戏。

Node.js 服务器权威：发牌、规则判定、结算、AI 托管全部在服务端完成，浏览器只负责渲染与发送动作。支持房间大厅、AI 补位、断线重连、一场多局与本地语音包播报。

规则基准见 [规格.md](规格.md)（2026-10-19 拍板版），引擎在此基础上增加了若干可配置项与奖金规则（见下文）。

---

## 功能概览

- **房间制对战**：4 位房间号，可随机生成或自选；大厅实时房间列表；房主可删除房间。
- **真人 1–4 人 + AI 补位**：不足 4 人时房主可开启 AI 补位立即开局；全员准备后自动开始。
- **断线重连**：凭房间号 + 昵称回座；对局中掉线保留座位等待重连，未开局掉线超时自动移出。
- **一场多局**：默认 4 局，可设 1/4/8/12/16 局；每局结束累计比分，最后一局后重置准备状态。
- **明独（1 打 3）**：发牌后的确认轮可宣布明独；无炸时可【毁牌】整局重发。
- **完整炸弹体系**：五十K、五十K 大炸、无番炸、番炸、滚笼、王炸，带番数封顶。
- **奖金**：起手 ≥4 王、起手 7/8 张纯牌同点，跑完可向其他三家收奖。
- **微信头像昵称授权**：微信内打开可自动走公众号网页授权，直接使用微信头像和昵称进房；未配置微信时保留手动昵称。
- **真人语音包**：按词条拼接播放（默认通山语音包），支持多包切换。
- **移动端/桌面端适配**：同一套页面，横竖屏自适应。

## 技术栈

| 层 | 实现 |
|---|---|
| 服务端 | Node.js 18+（推荐 20+）、Express、Socket.IO |
| 前端 | 原生 HTML / CSS / JavaScript（无框架、无构建步骤） |
| 规则引擎 | `js/engine.js`，Node 与浏览器共用同一份逻辑 |
| AI | `js/ai.js`，候选生成 + 启发式决策 |
| Android App | Capacitor 7 外壳 + 本地资源包，复用同一套 H5 |

---

## 快速开始

```bash
npm install
npm start                 # 等价于 node server.js，默认端口 8080
```

浏览器打开 <http://localhost:8080>：

1. 配置了微信授权时，在微信内打开会自动获取头像昵称；其他环境手动输入昵称；
2. 【创建房间】（可自选 4 位房号）或从列表/输入房间号【加入房间】；
3. 房主在「对局配置」里调整设置（改动即时保存）；随后所有人点【准备】开局；
4. 真人全部就绪即自动开始（未开 AI 补位需 4 位真人；开启 AI 补位则真人就绪即可，不足由 AI 补齐）。

**本地多开测试**：同一浏览器开两个无痕窗口，或使用两个浏览器，分别加入同一房间号。

无需打包，修改前端文件后刷新即可；修改服务端/引擎需重启 `node server.js`。

---

## 目录结构

```
tongshandagong/
├── server.js              服务器：房间/座位/状态机/AI 托管/掉线处理
├── package.json
├── deploy.sh              云服务器一键部署脚本（Ubuntu/Debian）
├── DEPLOY.md              部署与运维指南
├── 规格.md                 规则拍板文档
├── docs/
│   ├── 协作流程.md         Fork + Pull Request 协作流程
│   └── 微信授权接入.md     公众号网页授权（域名/HTTPS/公众号配置）
├── js/
│   ├── engine.js          规则引擎（纯逻辑，服务端 require / 浏览器全局共用）
│   └── ai.js              AI 候选生成与决策
├── public/                静态资源（Express 托管根目录，同时是 App 的资源包）
│   ├── index.html         大厅 + 牌桌
│   ├── css/style.css
│   ├── js/
│   │   ├── engine.js      引擎副本（浏览器加载）
│   │   ├── ai.js          AI 副本（浏览器加载）
│   │   ├── ui-net.js      联网版牌桌渲染与交互
│   │   ├── net.js         Socket.IO 事件绑定
│   │   ├── screen.js      屏幕适配
│   │   └── app.js         App 外壳适配（沉浸式/返回键，浏览器中不生效）
│   ├── vendor/            socket.io 浏览器客户端（由 sync-vendor 生成）
│   └── voice/             语音包（manifest.json + default/ + tongshan/）
├── android/               Capacitor 生成的 Android 工程（独立 Gradle 项目）
├── capacitor.config.json  App 配置（appId / 本地资源目录 / 服务端地址）
├── tests/                 引擎单测、AI 单测、联机集成测试
└── tools/
    ├── voice-pack-check.js  语音包完整性校验
    └── sync-vendor.js       同步 socket.io 浏览器客户端到 public/vendor/
```

> 根目录的 `index.html`、`css/style.css`、`js/ui.js` 是早期单机试玩版残留，`server.js` **不会**加载它们；实际运行的是 `public/` + `js/engine.js` + `js/ai.js`。

---

## 玩法与规则要点

### 牌具与癞子

- 2 副扑克（108 张）+ 王；王总数可设 **8 / 10 / 12**（默认 8，共 112 张）。
- 4 人轮发；默认每家 28 张（王数非 8 时各家可能相差 1 张）。
- 所有王都是**癞子**：在任意组合中可代任意点数，并可指定花色。
- 王**单独出**固定算 3（可设置为算 2）；单独出两张/三张王默认对 3/三 3。

### 叫牌与队伍

- 随机定庄家；庄家从手牌中叫一张非王牌，**另一名持有同点数同花色牌的玩家**即为对家（2V2 队伍成立）。
- 对家身份默认隐藏（**明鸡**）：对家打出叫牌后公开。
- 下一局由本局一游（第一个跑完者）当庄。

### 确认轮：明独 / 毁牌

- 发牌后进入确认轮，四家依次选择【明独】或【不明独】。
- 有人明独 → 立即进入 **1 打 3（硬牌）**，明独者先出牌；其余三家自动成队。
- 全员不明独 → 正常 2V2，庄家先出。
- 确认轮中手牌**没有任何炸**的玩家可【毁牌】，整局作废重发（有炸时服务端拒绝）。

### 牌型

单张、对子、连对（≥2 组连续对子，不含 2）、三条、飞机（≥2 组连续三条，不含 2）。无三带一/三带二。

- 跟牌须同类型、同长度；同点数先出为大，不可再压。
- 炸弹可压任意非炸牌型。

### 炸弹体系

| 类别 | 形态 | 番数（软=含王 / 硬=纯牌） |
|---|---|---|
| 五十K | 5 + 10 + K | 最小炸，不计番 |
| 无番炸 | 4/5/6 张同点 | 0 |
| 番炸 · 同点 | 7 张起 | 7 张 1/2，8 张 2/4，9 张 4/8，逐张翻倍 |
| 番炸 · 滚笼 | 相邻点数多组炸组成环形链 | `2^((每组张数-4)+(组数-2))`，硬炸翻倍 |
| 番炸 · 五十K大炸 | 5/10/K 各 t 张（t≥4，共 3t 张） | t=4 时 2/4，t=5 时 4/8，逐级翻倍 |
| 王炸 | 4 张及以上王 | `2×张数−4`（4 王=4 番，8 王=12 番，12 王=20 番） |

- **大小顺序**：番炸 > 无番炸 > 五十K。
- **五十K**：同花 > 杂；同花按 ♠ > ♥ > ♣ > ♦；杂之间先出为大。
- **同番比较**：王炸最大；五十K大炸比 t；其余从最低一级往上逐级比点数，点数高者胜；逐级相同则组数多者胜。
- **滚笼点数环形**：可跨 A−2，2 与 3 也相邻（`AAAA 2222` 合法）。
- 番数可设封顶 32/64/128 番或不封顶，超过封顶按封顶值计。
- 当前实现中所有炸弹均可领出（屋规原为无番炸不可领出，`legalLead` 已放开）。

### 出牌流程与接风

- 庄家/明独者领出；其余人依次跟牌或过牌。
- 一圈内其余人都过 → 最后出牌者收走本轮分数并领出下一手。
- 最后出牌者已跑完：**明鸡已公开则对家接风**，未公开则由下家接风。
- 一队两人全部跑完即结束；明独局只看名次：明独者一游即胜，其他任意一人先跑完则明独者负。

### 抓分

5 = 5 分、10 = 10 分、K = 10 分，两副共 **200 分**；每轮由赢家取走。

### 结算

分数口径：`最终分 = round(番值 × 2 × 半番分值)`，默认半番 = 1 分。

**2V2**

- 基础番 = 0.5 × 输方没跑人数（1 或 2）；输方本局抓 0 分则基础翻倍。
- 队内两人同输同赢、全额不除二。
- 滚笼叠加：每个打出的滚笼，打出者跑完归本队、没跑归对方；`Δ = 归赢队番 − 归输队番`。
- 赢队每人 `+(基础 + Δ)`，输队每人 `−(基础 + Δ)`；**Δ 不封底**，先跑完也可能整体倒付。

**明独（硬牌）**

- 明独者胜：三家各输 2 番；明独者负：明独者向三家各输 2 番。
- 叠加滚笼后保持零和：明独者 `±(6 + 3Δ)`，其他三家各 `∓(2 + Δ)`。
- 不适用 0 分翻倍，不看抓分。

**奖金（跑完才生效，四游默认不拿）**

- **王奖金**：起手 ≥4 王，每多 1 王向其他三家各收 1 番（4 王=1 番/家）。
- **硬炸奖**：起手 7 张纯牌同点 → 其他三家各 1 番；8 张及以上 → 各 2 番；多门可累加。
- 开启「尾游也可拿王奖金」后，王奖金四游同样生效；硬炸奖暂无此开关。

### 牌局设置（仅房主，可在一局结束后调整）

| 设置项 | 可选值 | 默认 |
|---|---|---|
| 一场局数 | 1–20（界面 1/4/8/12/16） | 4 |
| 王总数 | 8 / 10 / 12 | 8 |
| 王单出 | 算 3 / 算 2 | 3 |
| 半番分值 | 1–50 | 1 |
| 番数封顶 | 32 / 64 / 128 / 不封顶 | 32 |
| 尾游拿王奖金 | 开 / 关 | 关 |
| 显示剩余张数 | 开 / 关 | 关 |
| 显示牌局信息框 | 开 / 关 | 关 |
| 显示出牌记录框 | 开 / 关 | 关 |
| AI 补位 | 开 / 关 | 关 |

> 对局进行中（发牌到本局结束前）设置锁定。

---

## 服务器行为与配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `ROOM_IDLE_KICK_MS` | `1800000`（30 分钟） | 闲置解散仅限「未开局/场末」；局间（等下一局）不超时；`0` 关闭 |
| `OFFLINE_KICK_MS` | `180000`（3 分钟） | 未开局时真人掉线超时移出座位；`0` 关闭 |
| `AI_TURN_MS` | `1500` | AI 每手间隔（留出语音播报时间） |
| `WX_APPID` / `WX_APPSECRET` | 空 | 已认证服务号 AppID / AppSecret（配置后启用微信网页授权） |
| `WX_OAUTH_BASE` | 按请求 Host 推导 | OAuth 回调基地址，如 `https://game.example.com`；必须与公众号「网页授权域名」一致 |
| `SESSION_SECRET` | 启动时随机 | 微信登录 Cookie 的签名密钥；生产必须固定设置，否则重启后登录态失效 |
| `WEBHOOK_SECRET` | 空 | `/webhook/deploy` 自动部署的 HMAC 验签密钥（需与 GitHub Webhook 一致）；空 = 验签关闭 |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的跨域来源白名单（`http://localhost` 与 App 的 `https://localhost` 已内置放行）；空 = 不限制来源 |
| `WX_MOCK` | 关闭 | `1` 时启用本地模拟授权（仅非 production），用于无公众号时联调 |

- **常驻房间**：`LOVE`、`HOME` 固定存在，不会因闲置或无人被解散，也不能删除。
- **重连**：输入房间号 + 原昵称即可回座；开局后不允许新玩家中途加入。
- **掉线**：未开局超时被移出，座位还原为空位，房主掉线时房主身份移交；对局中掉线保留座位等待重连（不会由 AI 接管、也没有超时代打，重连是唯一恢复路径；一场未结束时任何人不可被踢）。
- **服务端持局**：每次状态变更广播全量快照；客户端渲染所需的叫牌、手牌、当前轮次、结算等均以快照为准。

### 微信头像昵称授权

微信内打开时会自动发起公众号网页授权：

1. 跳转 `open.weixin.qq.com`，用户点击允许；
2. 回调 `/api/wx/callback`，服务端用 code 换取 `openid`、昵称、头像；
3. 写入签名 HttpOnly Cookie（30 天），页面回跳后自动显示微信头像昵称；
4. 建房/进房时服务端以会话身份为准，客户端传入的昵称会被忽略；
5. 头像随房间快照下发给所有玩家，显示在牌桌头像圈；无头像时用昵称首字兜底。

**前提**：已认证服务号 + 已备案域名 + HTTPS，并在公众号后台把域名配置为「网页授权域名」。仅用 `IP:8080` 访问无法使用微信授权；未配置或授权失败时自动降级为手动昵称。

完整步骤（阿里云备案、Nginx HTTPS、公众号验证文件、常见错误码）见 [docs/微信授权接入.md](docs/微信授权接入.md)。

本地无公众号联调：

```bash
WX_MOCK=1 SESSION_SECRET=dev-secret node server.js
# 打开 http://localhost:8080，昵称行会多出「微信授权」按钮
```

### 部署

见 [DEPLOY.md](DEPLOY.md)。简要流程：

```bash
# 服务器上（Ubuntu/Debian）
# 注意：sudo 默认会剥掉自定义环境变量，`GIT_URL=… sudo ./deploy.sh` 拿不到值；先 export 再 sudo
export GIT_URL=git@github.com:<账号>/tongshandagong.git
sudo ./deploy.sh
```

脚本会安装 Node 20+ / PM2、拉代码、装依赖并守护进程；需在云控制台安全组放行 TCP 8080。

---

## Android App

App 是 **Capacitor 外壳 + 本地资源包**：页面、脚本、语音全部打进 APK（约 5MB），首屏不依赖网络；只有 `/api/*` 和 Socket.IO 走网络。

### 与网页端的关系

- 共用同一份 `public/`、同一套规则引擎和 UI 代码，不维护第二套
- App 内不提供微信网页授权（WebView 里整页跳转会离开本地资源包），使用手动昵称
- App 页面 origin 是 `https://localhost`，与本站不同源，因此 API / Socket 走绝对地址（见 `public/js/net.js` 的 `IS_APP`）；服务端对 `/api` 开了不带凭据的 CORS
- 进入牌桌时由 AndroidManifest 锁定横屏，不再走 `screen.js` 的旋转兜底

### 构建

```bash
npm install
npm run cap:sync      # 同步 socket.io 客户端 + 把 public/ 拷进 android
npm run android:apk   # 产出 android/app/build/outputs/apk/debug/app-debug.apk
```

也可以用 Android Studio 打开 `android/` 目录直接运行到真机。

**指定服务器地址构建**（域名备案前的 IP 内测）：

```bash
node tools/build-apk.js --server http://8.148.29.231
# 或 npm run apk -- --server http://8.148.29.231
```

脚本会临时把地址写进 `public/js/env.js`、按 http/https 调整 Capacitor 配置，构建完自动还原仓库文件；产物在 `dist/tongshandagong-<host>-debug.apk`。

用 IP 走 http 时，服务端需要额外放行一个端口（见 `deploy/nginx-www.zhangyuning.xyz.conf` 里的「IP 直连」server 块），否则 80 端口只会 301 跳到证书不匹配的 https。

### 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node | 20+ | 仅用于跑 Capacitor CLI |
| JDK | 21+ | Capacitor 7 的源码级别是 Java 21；在 `android/gradle.properties` 的 `org.gradle.java.home` 指定 |
| Android SDK | Platform 35 + Build-Tools 35 | 用 Android Studio 的 SDK Manager 安装 |
| Gradle | 8.11.1 | 已在 `android/gradle/wrapper` 固定，并从腾讯云镜像下载 |

> `android/gradle.properties` 里的 JDK 路径、`android/local.properties` 里的 SDK 路径都是本机配置，换机器时要改；`local.properties` 已在 `.gitignore` 中忽略。

### 发布

- 调试包（debug）可直接安装，用于内测分发
- 正式包需要在 `android/app/build.gradle` 配置 signingConfig，keystore 文件不入库（`.gitignore` 已忽略 `*.jks` / `*.keystore`），**务必备份**
- 包名 `xyz.zhangyuning.dagong` 一旦上架不可更改

---

## 测试与工具

运行测试前先安装依赖；联机 e2e（mask-check / endseries-check / host-check / exit-check）会**自动起专用端口的测试服务器**，无需提前启动 8080。

| 命令 | 说明 | 依赖服务端 |
|---|---|---|
| `npm test` | 一键全量：引擎单测 + AI 单测 + 双副本一致性 + 四个联机 e2e | 否 |
| `npm run test:engine` | 仅引擎/AI 单测 + 双副本一致性 | 否 |
| `node tests/engine.test.js` | 引擎单测（牌具/牌型/比较/结算/流程/模拟；断言数随用例增减，不再写死） | 否 |
| `node tests/ai-sanity.js` | AI 行为单测（不乱出王、不炸队友等） | 否 |
| `node tests/check-sync.js` | js/ 与 public/js/ 的引擎/AI 双副本一致性 | 否 |
| `node tests/mask-check.js` | 快照脱敏 e2e（3 真人 + AI 补位自动打完一局，逐帧校验脱敏/结算） | 否（自动起服务） |
| `node tests/endseries-check.js` | 提前结束本场（共识收场）e2e | 否（自动起服务） |
| `node tests/host-check.js` | 房主机制（hostSeat/删房）e2e | 否（自动起服务） |
| `node tests/exit-check.js` | 局末退出口径 / 离线顶替 / start 收权 e2e | 否（自动起服务） |
| `node tests/net-sim.js` | 1 真人 + 3 AI 自动打完整局（联调脚本，需先起 8080 服务） | 是 |
| `node tests/cdp-mobile-check.js` | 移动端布局裁剪检查（需调试端口 9224 的 Chrome） | 是 |
| `node tests/wx-auth.js` | 微信授权（WX_MOCK）流程、Cookie 签名、Socket 身份覆盖 | 否（自起测试服务） |
| `node tests/aifill.js` / `tests/multiplayer.js` | 旧联机集成脚本（供参考，未纳入 npm test） | 是 |

联机测试可用 `URL=http://host:port node tests/multiplayer.js` 指定服务器地址。

---

## 语音包

- 默认包：`public/voice/tongshan/`（通山真人语音）；`public/voice/default/` 为备用包。
- 词条映射在 `public/voice/manifest.json`，客户端可用 `localStorage.tsVoicePack` 指定包名。
- 播放优先走语音包；缺词条时兜底到可用的近似词条（如 9+ 王炸词条缺失时报「炸弹」），实在不可播才静默（`public/js/ui-net.js` 中 `TTS_FALLBACK=false`，改为 `true` 可回退系统 TTS）。
- 新增/替换音频后运行 `node tools/voice-pack-check.js` 检查缺漏。

---

## 开发注意

1. **引擎有两份副本**：`js/engine.js`、`js/ai.js` 供服务端使用，`public/js/` 下是浏览器加载的同名副本。修改规则时**两份必须同步**，否则服务端判定与前端提示会不一致。
2. **根目录旧文件不参与运行**：`index.html`、`css/`、`js/ui.js` 属于早期单机版，可忽略或后续清理。
3. **规则以引擎为准**：`规格.md` 是拍板记录，`js/engine.js` 中的可配置扩展（王总数、王单出值、封顶、奖金、五十K大炸等）属于后续增量。
4. **不改 `public/` 的引用路径**：`public/index.html` 以站点根为基准加载 `js/engine.js` 等资源。

## 文档

- [规格.md](规格.md) — 规则拍板与决策记录
- [DEPLOY.md](DEPLOY.md) — 部署与运维
- [docs/协作流程.md](docs/协作流程.md) — Fork + PR 协作流程
- [docs/微信授权接入.md](docs/微信授权接入.md) — 公众号网页授权与域名/HTTPS 配置
- [public/voice/README.md](public/voice/README.md) — 语音包制作与接入
