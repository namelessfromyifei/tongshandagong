/* =========================================================
 * 通山打拱 · 多人联网服务器
 * 架构：服务器权威。每房间持一个 G（engine.js），
 *       真人动作经 WebSocket 校验执行，AI 座位自动托管，
 *       每次状态变更广播全量快照给房间内所有连接。
 * 运行：node server.js  （默认端口 8080，环境变量 PORT 可改）
 * ========================================================= */
"use strict";
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const compression = require('compression');
const { Server } = require('socket.io');
const { execFile } = require('child_process');
const TS = require('./js/engine.js');
const TSAI = require('./js/ai.js');
const { insertHistory, getHistory } = require('./db');

const PORT = process.env.PORT || 8080;
// 房间闲置自动解散（毫秒）；设为 0 可关闭。仅「未开局/场结束」计时，默认 30 分钟；
// 局间（等下一局）不超时；create/join/准备会重置计时。
const IDLE_KICK_MS = Number(process.env.ROOM_IDLE_KICK_MS || 30*60*1000); // 闲置解散仅限「未开局/场结束」且 30 分钟；局间（等下一局）不超时
// 未开局时真人掉线超过该时长（毫秒）→ 踢出座位还原为 AI；默认 3 分钟。
// 未开场/场末：非房主真人掉线满此时间 → 房主牌桌上出现「踢出房间」按钮（房主手动踢）
const OFFLINE_KICK_WAIT_MS = Number(process.env.OFFLINE_KICK_WAIT_MS || 30*1000);
// 未开场/场末：房主掉线超过此时间 → 自动移出房间（座位还原空位）
const HOST_OFFLINE_KICK_MS = Number(process.env.HOST_OFFLINE_KICK_MS || 5*60*1000);
// AI 每手间隔：留足语音播报时间（默认 1.5 秒，可用 AI_TURN_MS 调整）
const AI_TURN_MS = Number(process.env.AI_TURN_MS || 1500);

/* ---------- 微信网页授权 ----------
 * 公众号 H5：OAuth2 scope=snsapi_userinfo，服务端换取昵称/头像/openid。
 * 未配置 WX_APPID/WX_APPSECRET 时自动降级为手动昵称。
 * WX_MOCK=1 仅供本地联调（production 下强制关闭）。
 * 要求：已认证服务号 + 公众号后台配置的「网页授权域名」+ HTTPS。
 */
const WX_APPID = (process.env.WX_APPID || '').trim();
const WX_SECRET = (process.env.WX_APPSECRET || '').trim();
const WX_OAUTH_BASE = (process.env.WX_OAUTH_BASE || '').trim().replace(/\/+$/, '');
const WX_MOCK = process.env.WX_MOCK === '1' && process.env.NODE_ENV !== 'production';
const WX_ENABLED = !!(WX_APPID && WX_SECRET) || WX_MOCK;
const WX_SCOPE = 'snsapi_userinfo';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_AGE = 30 * 24 * 60 * 60; // 30 天（秒）
if (!process.env.SESSION_SECRET) {
  console.warn('[wx] 未设置 SESSION_SECRET，本次启动的微信登录态在重启后失效');
}
if (WX_ENABLED && !WX_MOCK && !WX_OAUTH_BASE) {
  console.warn('[wx] 未设置 WX_OAUTH_BASE，将按请求 Host 推导回调地址；请确认与公众号「网页授权域名」一致');
}

/* ---------- CORS / 来源白名单 ----------
 * ALLOWED_ORIGINS（逗号分隔）配置后启用白名单模式；未配置保持 *（向后兼容）。
 * 白名单模式：浏览器跨域只放行列出的来源；无 Origin 头的非浏览器
 * （Native App / Node 测试客户端）始终放行（浏览器跨站请求必然携带 Origin）。
 * 本地开发与 Capacitor App（webview origin=https://localhost）默认放行。 */
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean));
const CORS_RESTRICTED = ALLOWED_ORIGINS.size>0;
const CORS_LOCAL = new Set(['https://localhost','http://localhost','http://localhost:80','http://localhost:8080','capacitor://localhost']);
function originAllowed(origin){
  if(!origin) return true;          // 无 Origin 头：非浏览器客户端
  if(!CORS_RESTRICTED) return true; // 未启用白名单：保持开放
  const o=String(origin).toLowerCase();
  return CORS_LOCAL.has(o) || ALLOWED_ORIGINS.has(o);
}
if(CORS_RESTRICTED) console.log('[cors] 启用来源白名单：' + [...ALLOWED_ORIGINS].join(', '));
else console.warn('[cors] 未设置 ALLOWED_ORIGINS，CORS 保持开放（生产可配置收紧）');

const app = express();
app.set('trust proxy', 1); // 反向代理（Nginx）下正确识别 https
app.use(compression());    // gzip 静态/JSON（Socket.IO 报文自身已压缩）
const server = http.createServer(app);
// 缩短心跳，断线更快被发现（默认 ping 约 25s）
const io = new Server(server, {
  pingInterval: 5000, pingTimeout: 5000,
  cors: { origin: (origin, cb) => cb(null, originAllowed(origin)), credentials: false },
});

/* ---------- CORS：Android App 从 https://localhost 读取 API ----------
 * App 的页面在本地资源包里，origin 是 https://localhost，与本站不同源。
 * App 不使用 Cookie（身份走手动昵称），允许不带凭据的跨域即可。
 * 来源白名单见上方 CORS 配置（未设 ALLOWED_ORIGINS 时仍开放）。 */
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin || '';
  if(!originAllowed(origin)){ res.status(403).send('跨域来源不被允许'); return; }
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if(req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- GitHub Webhook：push 自动部署 ----------
 * GitHub → 仓库 → Settings → Webhooks → Add webhook：
 *   Payload URL: https://你的域名/webhook/deploy
 *   Content type: application/json；Secret: WEBHOOK_SECRET（见 ecosystem.config.js）
 *   事件：仅 Push（默认已含）
 * 服务端用 X-Hub-Signature-256（HMAC-SHA256）校验，main/master 分支 push 触发 redeploy.sh。 */
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || '').trim();
if(!WEBHOOK_SECRET) console.warn('[webhook] 未设置 WEBHOOK_SECRET，/webhook 自动部署校验已关闭');
function verifyWebhookSig(raw, header){
  if(!WEBHOOK_SECRET || !raw || !raw.length) return false;
  const sig = String(header || '').replace(/^sha256=/i, '').trim();
  if(!/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
let _deployBusy = false;
function triggerDeploy(){
  if(_deployBusy){ console.warn('[webhook] 部署进行中，忽略本次触发'); return false; }
  _deployBusy = true;
  const script = path.join(__dirname, 'redeploy.sh');
  const child = execFile('sh', [script], { cwd: __dirname }, (err) => {
    _deployBusy = false;
    console.log('[webhook] 部署' + (err ? ('失败：' + err.message) : '完成'));
  });
  if(child.stdout) child.stdout.on('data', d => console.log('[deploy]', String(d).trim()));
  if(child.stderr) child.stderr.on('data', d => console.error('[deploy]', String(d).trim()));
  return true;
}
app.post('/webhook/deploy', express.raw({ type: ['application/json', 'application/*+json', '*/*'], limit: '1mb' }), (req, res) => {
  const sig = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'];
  if(!verifyWebhookSig(req.body, sig)){ res.status(401).json({ ok:false, error:'signature mismatch' }); return; }
  const event = String(req.headers['x-github-event'] || '');
  let payload = {}; try{ payload = JSON.parse((req.body || '').toString('utf8') || '{}'); }catch(e){}
  const ref = payload && payload.ref ? String(payload.ref) : '';
  if(event === 'push' && /^refs\/heads\/(main|master)$/.test(ref)){
    const started = triggerDeploy();
    res.status(started ? 200 : 409).json({ ok:true, deploying:started });
  } else {
    res.json({ ok:true, ignored:true });
  }
});
app.get('/webhook', (req, res) => res.json({ ok:true, webhook:'ready', secret: !!WEBHOOK_SECRET }));

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- 微信授权：Cookie / 会话 ---------- */
function parseCookies(header){
  const out = {};
  if(!header) return out;
  for(const part of String(header).split(';')){
    const i = part.indexOf('=');
    if(i < 0) continue;
    const k = part.slice(0, i).trim();
    if(!k) continue;
    try{ out[k] = decodeURIComponent(part.slice(i + 1).trim()); }catch(e){ out[k] = ''; }
  }
  return out;
}
function signValue(payload){
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
function encodeSession(profile){
  const payload = Buffer.from(JSON.stringify({
    openid: profile.openid,
    nickname: profile.nickname,
    avatar: profile.avatar || '',
    exp: Date.now() + SESSION_AGE * 1000,
  })).toString('base64url');
  return payload + '.' + signValue(payload);
}
function decodeSession(value){
  if(!value || value.indexOf('.') < 0) return null;
  const i = value.lastIndexOf('.');
  const payload = value.slice(0, i), sig = value.slice(i + 1);
  const expected = signValue(payload);
  if(sig.length !== expected.length) return null;
  try{
    if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  }catch(e){ return null; }
  try{
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if(!p || !p.openid || !p.exp || p.exp < Date.now()) return null;
    return p;
  }catch(e){ return null; }
}
function sessionFromRequest(req){
  return decodeSession(parseCookies(req.headers && req.headers.cookie).ts_wx);
}
function sessionFromSocket(socket){
  return decodeSession(parseCookies(socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie).ts_wx);
}
function cookieHeader(name, value, opts){
  opts = opts || {};
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if(opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if(opts.httpOnly) parts.push('HttpOnly');
  if(opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if(opts.secure) parts.push('Secure');
  return parts.join('; ');
}
function isSecureReq(req){
  return !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
}
function appendCookie(res, name, value, opts){
  res.append('Set-Cookie', cookieHeader(name, value, Object.assign({httpOnly:true, sameSite:'Lax', secure:isSecureReq(res.req)}, opts)));
}
function clearCookie(res, name){
  res.append('Set-Cookie', cookieHeader(name, '', {maxAge:0, httpOnly:true, sameSite:'Lax', secure:isSecureReq(res.req)}));
}
function safeNext(v){
  if(typeof v !== 'string' || !v) return '/';
  if(v[0] !== '/' || v[1] === '/' || v[1] === '\\') return '/';
  return v.slice(0, 300);
}
function requestBaseUrl(req){
  if(WX_OAUTH_BASE) return WX_OAUTH_BASE;
  return `${isSecureReq(req) ? 'https' : req.protocol}://${req.get('host')}`;
}
function cleanNickname(raw){
  // 双保险（与客户端 esc() 配合）：昵称会出现在多个渲染面，这里顺带剥掉 HTML 敏感字符，
  // 防止任何渲染路径把昵称当标签结构解析（详见审计：#tableMsg innerHTML 反弹点）。
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>"&]/g, '')
    .trim();
  if(!s) return '玩家';
  const chars = Array.from(s);
  if(chars.length > 24) s = chars.slice(0, 24).join('');
  return s;
}
function normalizeAvatar(url){
  if(typeof url !== 'string') return '';
  if(/^\/[^/]/.test(url)) return url; // 站内相对地址（WX_MOCK 头像）
  if(!/^https?:\/\//i.test(url)) return '';
  // 微信头像统一走 https，避免 HTTPS 页面混入 http 资源；取 132px 尺寸
  return url.replace(/^http:\/\//i, 'https://').replace(/\/0$/, '/132');
}
// 页面/接口使用的身份：微信授权优先，未授权时才使用手动昵称
function identityOf(data, session){
  if(session){
    return {
      name: cleanNickname(session.nickname),
      avatar: normalizeAvatar(session.avatar),
      openid: String(session.openid || ''),
    };
  }
  return {
    name: cleanNickname(data && data.name),
    avatar: '',
    openid: '',
  };
}
async function fetchJson(url, timeoutMs){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try{
    const r = await fetch(url, {signal: ctrl.signal, headers: {'Accept': 'application/json'}});
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 微信授权：路由 ---------- */
app.get('/api/wx/config', (req, res) => {
  const ready = WX_ENABLED && (WX_MOCK || !!WX_OAUTH_BASE); // 授权基址就绪才允许自动跳授权，避免跳进微信错误页
  res.set('Cache-Control', 'no-store').json({
    enabled: WX_ENABLED,
    ready,
    mock: WX_MOCK,
    wechat: /MicroMessenger/i.test(req.get('user-agent') || ''),
  });
});
app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = sessionFromRequest(req);
  if(!s) return res.json({ok:false});
  res.json({ok:true, profile:{nickname: cleanNickname(s.nickname), avatar: normalizeAvatar(s.avatar)}});
});
app.get('/api/wx/logout', (req, res) => {
  clearCookie(res, 'ts_wx');
  const next = safeNext(req.query.next);
  const sep = next.indexOf('?') >= 0 ? '&' : '?';
  res.redirect(next + sep + 'wxmanual=1');
});
app.get('/api/wx/start', (req, res) => {
  if(!WX_ENABLED) return res.redirect('/?wxerr=unconfigured');
  const next = safeNext(req.query.next);
  const state = crypto.randomBytes(16).toString('hex');
  appendCookie(res, 'ts_wx_state', state, {maxAge: 600});
  appendCookie(res, 'ts_wx_next', next, {maxAge: 600});
  if(WX_MOCK){
    return res.redirect('/api/wx/callback?code=mock&state=' + encodeURIComponent(state));
  }
  const redirectUri = requestBaseUrl(req) + '/api/wx/callback';
  const url = 'https://open.weixin.qq.com/connect/oauth2/authorize?' + new URLSearchParams({
    appid: WX_APPID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: WX_SCOPE,
    state,
  }).toString() + '#wechat_redirect';
  res.redirect(url);
});
app.get('/api/wx/callback', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const next = safeNext(cookies.ts_wx_next);
  const expectedState = cookies.ts_wx_state;
  const state = String(req.query.state || '');
  clearCookie(res, 'ts_wx_state');
  clearCookie(res, 'ts_wx_next');
  if(!WX_ENABLED) return res.redirect('/?wxerr=unconfigured');
  if(!req.query.code || !expectedState || state !== expectedState) return res.redirect('/?wxerr=state');
  try{
    let profile;
    if(WX_MOCK){
      profile = {
        openid: 'mock-openid-' + (process.env.WX_MOCK_OPENID || 'dev'),
        nickname: process.env.WX_MOCK_NAME || '微信测试用户',
        avatar: '/api/wx/mock-avatar.svg',
      };
    } else {
      const tokenUrl = 'https://api.weixin.qq.com/sns/oauth2/access_token?' + new URLSearchParams({
        appid: WX_APPID,
        secret: WX_SECRET,
        code: String(req.query.code),
        grant_type: 'authorization_code',
      }).toString();
      const token = await fetchJson(tokenUrl);
      if(token.errcode) throw new Error(`access_token errcode=${token.errcode} ${token.errmsg || ''}`);
      const infoUrl = 'https://api.weixin.qq.com/sns/userinfo?' + new URLSearchParams({
        access_token: token.access_token,
        openid: token.openid,
        lang: 'zh_CN',
      }).toString();
      const info = await fetchJson(infoUrl);
      if(info.errcode) throw new Error(`userinfo errcode=${info.errcode} ${info.errmsg || ''}`);
      profile = {
        openid: String(info.openid || token.openid || ''),
        nickname: info.nickname || '微信用户',
        avatar: info.headimgurl || '',
      };
    }
    if(!profile.openid) throw new Error('empty openid');
    appendCookie(res, 'ts_wx', encodeSession(profile), {maxAge: SESSION_AGE});
    res.redirect(next);
  }catch(e){
    console.error('[wx] 网页授权失败：', e && e.message ? e.message : e);
    res.redirect('/?wxerr=oauth');
  }
});
// 本地联调用的占位头像（WX_MOCK=1 才会被引用）
app.get('/api/wx/mock-avatar.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(
    '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="132" viewBox="0 0 132 132">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#22c55e"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs>' +
    '<rect width="132" height="132" rx="66" fill="url(#g)"/>' +
    '<text x="66" y="86" font-size="64" text-anchor="middle" fill="#fff" font-family="sans-serif">微</text></svg>'
  );
});

/* ---------- 房间管理 ---------- */
const rooms = new Map(); // code -> room

function makeCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';
  do{ c=''; for(let i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)]; }
  while(rooms.has(c));
  return c;
}

// 房间号规范化：4 位大写字母/数字白名单；不合法返回 null。
// create 自定义号与 join/rejoin/deleteRoom 统一入口，从源头掐断房间号注入。
function roomCodeOf(v){
  const s=String(v==null?'':v).toUpperCase().trim();
  return /^[A-Z0-9]{4}$/.test(s) ? s : null;
}

function createRoom(code){
  code = code || makeCode();
  const room = {
    code,
    seats: [ // 4 个座位：{type:'ai'|'human', socketId, name, offline}
      {type:'ai', name:'A家'}, {type:'ai', name:'B家'},
      {type:'ai', name:'C家'}, {type:'ai', name:'D家'},
    ],
    hostSeat: 0,        // 房主座位号（与座位归属解耦：房主移交/退出不再物理挪座位）
    aiFill: false,      // AI 补位开关（默认关，房主手动开）
    humanCount: 0,
    ready: [false,false,false,false], // 每座位是否准备（AI 座位视为自动准备）
    G: null,            // 当前局（null = 等待开局）
    aiTimer: null,
    idleTimer: null,    // 牌局结束后的闲置自动解散计时器
    offlineTimers: {},  // 座位号 -> 未开局掉线踢出计时器（seatIdx -> timeout）
    historyCache: getHistory(code), // 本房历史分数内存缓存（最近 10 场，启动时从 DB 加载；快照直接读它，不每次查库）
    recentKicks: [],    // 近期被踢玩家（{name,openid,at}，rejoin 命中时给明确「已被移出」提示）
    settings: {         // 牌局设置（房主可调）
      rounds: 4,        // 一轮打多少局（默认 4；界面可选 1/4/8/12/16）
      showRemain: false, // 是否显示剩余张数（默认关，关闭时显示固定"10张"）
      showCorner: false, // 是否显示牌桌信息框（叫牌/局数/半番等），默认不显示
      showLog: false,    // 是否显示出牌记录框（右上角日志），默认不显示
      aiAuto: false,     // 是否允许玩家开启「AI出牌」代打按钮（默认关）
      kings: 8,         // 王总数 8/10/12
      jokerValue: 3,    // 王单出算 3 或 2
      tailBonus: false, // 未跑完者能否拿王奖金（决策D：默认关）
      fanCap: 32,       // 笼数封顶：32/64/128，0=不封顶（超过按封顶值计）
      halfFan: 1,       // 半番=几分（1~50，默认 1）
    },
    series: {           // 一轮（多局）累计
      active: false, roundCount: 0, totals: [0,0,0,0],
    },
    roundSeq: 0,        // 房间内累计对局数（跨场唯一，供前端判断换局）
  };
  rooms.set(code, room);
  return room;
}

/* ---------- 广播 ---------- */
// 配置锁定：一场（多局）未结束时（含局间等待下一局）所有设置不可改、不可直接开局；
// 未开局（G 为空）或本场已结束（seriesOver，等玩家准备开下一场）才可改。
function configLocked(room){
  return !!(room.G && !room.seriesOver);
}
// 把 settings 映射为引擎 cfg
function makeCfg(room){
  return {
    kings: room.settings.kings,
    jokerValue: room.settings.jokerValue,
    tailBonus: room.settings.tailBonus,
    fanCap: room.settings.fanCap,
    halfFan: room.settings.halfFan,
  };
}
// 逐键白名单应用对局设置（create 带初始设置与 setSettings 共用，防非法值 / __proto__ 污染；
// 未知键一律忽略，不 Object.assign 整份对象）
function applySettings(r, data){
  if(!r || !data || typeof data !== 'object') return;
  const s = r.settings;
  if(data.rounds!=null){ const n=Number(data.rounds); if(n>=1&&n<=20) s.rounds=Math.floor(n); }
  if(data.showRemain!=null) s.showRemain=!!data.showRemain;
  if(data.showCorner!=null) s.showCorner=!!data.showCorner;
  if(data.showLog!=null) s.showLog=!!data.showLog;
  if(data.kings!=null) s.kings=[8,10,12].includes(Number(data.kings))?Number(data.kings):8;
  if(data.jokerValue!=null) s.jokerValue=Number(data.jokerValue)===2?2:3;
  if(data.tailBonus!=null) s.tailBonus=!!data.tailBonus;
  if(data.fanCap!=null){ const n=Number(data.fanCap); s.fanCap=[32,64,128,0].includes(n)?n:32; }
  if(data.halfFan!=null){ const n=Math.round(Number(data.halfFan)); s.halfFan=Math.min(50,Math.max(1,n||1)); }
  if(data.aiFill!=null) r.aiFill=!!data.aiFill;
  if(data.aiAuto!=null) s.aiAuto=!!data.aiAuto;
}
// 房间无人时恢复对局配置默认（房主改过的设置随最后一人退出/被踢而还原，新进房从默认开始）
function resetRoomSettings(room){
  if(!room) return;
  room.settings = {
    rounds: 4, showRemain: false, showCorner: false, showLog: false,
    aiAuto: false, kings: 8, jokerValue: 3, tailBonus: false, fanCap: 32, halfFan: 1,
  };
  room.aiFill = false;
}
// 对比设置快照与当前值，返回「变化的字段」中文描述（供 setSettings 广播给全房）
function settingChanges(old, room){
  const s = room.settings;
  const on = v => v ? '开' : '关';
  const ch = [];
  if(old.rounds !== s.rounds) ch.push(`局数 ${s.rounds}`);
  if(old.kings !== s.kings) ch.push(`王总数 ${s.kings}`);
  if(old.jokerValue !== s.jokerValue) ch.push(`王单出算 ${s.jokerValue}`);
  if(old.halfFan !== s.halfFan) ch.push(`半番 ${s.halfFan}`);
  if(old.fanCap !== s.fanCap) ch.push(`笼数封顶 ${s.fanCap===0?'不封顶':s.fanCap}`);
  if(old.tailBonus !== s.tailBonus) ch.push(`未跑可拿王奖金 ${on(s.tailBonus)}`);
  if(old.showRemain !== s.showRemain) ch.push(`显示剩余张数 ${on(s.showRemain)}`);
  if(old.showCorner !== s.showCorner) ch.push(`牌局信息框 ${on(s.showCorner)}`);
  if(old.showLog !== s.showLog) ch.push(`出牌记录 ${on(s.showLog)}`);
  if(old.aiFill !== room.aiFill) ch.push(`AI补位 ${on(room.aiFill)}`);
  if(old.aiAuto !== s.aiAuto) ch.push(`AI代打 ${on(s.aiAuto)}`);
  return ch;
}
// 标记"刚结束的这局是否为一场的最后一局"，随快照带给客户端（避免客户端猜错）
function markLast(room){
  if(room.G && room.G.ended && room.G.lastSeries===undefined){
    room.G.lastSeries = (room.series.roundCount + 1) >= room.settings.rounds;
  }
}
function snapshot(room){
  return {
    code: room.code,
    aiFill: room.aiFill,
    ready: room.ready,
    settings: Object.assign({aiFill: room.aiFill}, room.settings),
    series: room.series,
    hostSeat: room.hostSeat, // 房主座位号（与座位归属解耦）：客户端据此显示「你是房主」/设置按钮
    seats: room.seats.map(s=>({name:s.name, type:s.type, offline:!!s.offline, offlineAt:s.offlineAt||0, avatar:s.avatar||'', humanCount:room.humanCount})),
    seriesOver: !!room.seriesOver, // 本场已结束：G 仍保留（牌桌冻结），等玩家准备开下一场
    earlyEnded: !!room.earlyEnded, // 本场系「提前结束」收场（局间共识收场）：局数文案显示「本场(已)提前结束」
    history: room.historyCache || [],  // 本房历史分数（内存缓存，最近 10 场）
    endVote: room.endVote ? { requester: room.endVote.requester, need: room.endVote.need, agree: room.endVote.agree.size } : null,
    endVote: room.endVote ? {requester:room.endVote.requester, name:room.seats[room.endVote.requester].name} : null,
    G: room.G,
  };
}

/* ---------- 按接收者脱敏 ----------
 * 原则：局中（未到局末）不派发对方手牌与王数，明鸡未公开前不派发对家身份；
 *      不派发 seed/rnd（防用种子复刻发牌）；对家/明鸡关系只对本人按 youArePartner 下发；
 *      局末（G.ended）全量公开（摊牌显示各家剩余牌）。 */
// 2V2 某玩家的真实队友（观战『队友牌』据此下发，客户端不再本地推算，避免明鸡未公开前的错认）
function mateOf(G, viewer){
  if(!G || G.mode==='hard') return -1;
  if(viewer===G.landlord) return G.partner;
  if(viewer===G.partner) return G.landlord;
  for(let i=0;i<4;i++) if(i!==G.landlord && i!==G.partner && i!==viewer) return i;
  return -1;
}
function maskGame(G, seatIdx){
  if(!G || G.ended) return G; // 局末摊牌：剩余手牌 / 对家归属全公开
  const c={}; for(const k in G) c[k]=G[k];
  delete c.seed; delete c.rnd;
  const is2v2 = G.mode!=='hard';
  const viewerOut = (seatIdx>=0) ? !!G.seats[seatIdx].out : false;
  const mate = (is2v2 && viewerOut) ? mateOf(G, seatIdx) : -1;
  c.seats=G.seats.map((s,i)=>{
    const sc=Object.assign({}, s);
    sc.handCount = s.hand.length;
    if(i===seatIdx || i===mate) return sc;        // 自己 / 出局观战的队友：全程完整
    sc.hand = [];
    sc.kings = s.kingPlayed ? s.kings : 0;        // 该家首张王打出（报王）前隐藏王数
    sc.hardBombBonus = 0;
    return sc;
  });
  if(is2v2 && seatIdx>=0) c._mate = mateOf(G, seatIdx); // 观战『队友牌』用
  if(G.mode!=='hard' && !(G.revealed || G.ended)){
    c.partner = -1;                               // 明鸡未公开：对家身份不派发（仅 youArePartner）
    for(const s of c.seats){ s.isLandlord=null; s.isPartner=null; }
  }
  return c;
}
function snapshotFor(room, seatIdx, base){
  const snap = Object.assign({}, base); // 浅拷贝基础快照，G 按座位脱敏替换（其余字段各成员共享）
  const G = room.G;
  snap.G = G ? maskGame(G, seatIdx) : null;
  snap.youArePartner = !!(G && seatIdx>=0 && G.partner===seatIdx);
  if(G && G.ended && room.lastSettle) snap.settle = room.lastSettle;
  return snap;
}
// 按接收者分发脱敏快照：入座者拿本人视角，游离 socket 拿公共视角（全隐藏）。
// 全量快照只生成一次（base），各成员仅做脱敏差异——省掉重复的 seats.map/getHistory/mask 序列化开销。
function broadcast(room){
  const base = snapshot(room);
  const seats=room.seats;
  const memberIds=io.sockets.adapter.rooms.get(room.code)||[];
  for(const id of memberIds){
    const so=io.sockets.sockets.get(id);
    if(!so) continue;
    let seatIdx=-1;
    for(let i=0;i<4;i++){ if(seats[i] && seats[i].socketId===id){ seatIdx=i; break; } }
    so.emit('state', snapshotFor(room, seatIdx, base));
  }
}
/* ---------- 提前结束本场（在线真人共识表决） ----------
 * 规则：一场未结束时任何人不可被动踢；"场进行中"可经在线真人共识提前收场。
 * 满员真人房（4 座皆真人）：维持决策 A——4 位真人且全员在线才可发起，全票同意才生效。
 * 含 AI 座/真人不足 4 的房：门禁放宽——任意在线真人可发起，票数门槛 = 发起时「在线真人
 *   人数」（离线真人座与 AI 座不占票、不阻塞）；仅一名在线真人时发起即收场。
 * 任一人反对或 30 秒未全票 → 作废。生效以已完成局累计收场；请求时局中则本局废弃不计分，
 * 随后进入"本场结束"冻结态。 */
const END_VOTE_MS = 30000;
function seriesInProgress(room){ return !!(room && room.G && !room.seriesOver); }
function clearEndVote(room){
  if(!room || !room.endVote) return;
  if(room.endVote.timer){ clearTimeout(room.endVote.timer); room.endVote.timer=null; }
  room.endVote=null;
}
function cancelEndVote(room, why){
  clearEndVote(room);
  if(why) logLine(room, why);
  broadcast(room);
}
function finalizeEndSeries(room){
  if(!room || !room.endVote) return;
  clearEndVote(room);
  const curGame = (room.G && !room.G.ended) ? room.G : null;
  if(curGame) logLine(room, '提前收场：本局进行中，直接废弃（不计分）');
  logLine(room, '══════ 本场提前结束（共识）══════');
  logLine(room, `已完成局累计：${room.series.totals.map((t,i)=>`${room.seats[i].name} ${t>0?'+':''}${t}分`).join('｜')}`);
  // 提前收场：
  //  - 局中结束：丢掉当前局，客户端回到「刚进房间」状态（牌桌清空、准备提示回出牌区）
  //  - 局间结束（本局已结束、等下一局）：保留牌局，按正常场末处理（冻结牌桌 + 本场结算）
  if(curGame) room.G = null;
  else if(room.G) room.G.lastSeries = true;
  // 累计/轮数保留（同自然场末 finishRoom）：冻结屏与计分板继续显示提前收场时的场分；
  // 新的一场开始时才由 startRound 归零。此前这里清零 → 提前收场后「本场(分)」列恒为 0。
  room.series.active=false; room.series.lastRound=null;
  room.ready=[false,false,false,false];
  room.earlyEnded=true;          // 提前收场标记：客户端据此把局数文案改为「本场提前结束」
  room.seriesOver=true;
  clearAllOfflineKicks(room); clearIdleKick(room);
  scheduleIdleKick(room);                               // 场结束后可闲置解散
  pushRoomHistory(room);                                // 提前收场：本场结束，记一条历史分数
  broadcast(room);
}
/* ---------- 应变：本地房间码列表（LOVE/HOME 等常驻房不可删除、不闲置解散） ---------- */
const PRESERVE_ROOMS = new Set(['LOVE','HOME','AAAA','BBBB','CCCC','DDDD','EEEE']);
function isPreserve(code){ return PRESERVE_ROOMS.has(code); }

/* ---------- 牌局结束后房间闲置超时自动解散 ---------- */
function clearIdleKick(room){
  if(room && room.idleTimer){ clearTimeout(room.idleTimer); room.idleTimer=null; }
}
function scheduleIdleKick(room){
  if(!(IDLE_KICK_MS>0)) return;
  clearIdleKick(room);
  // 常驻房（LOVE/HOME）不设闲置解散
  if(isPreserve(room.code)) return;
  room.idleTimer=setTimeout(()=>{ kickIdleRoom(room); }, IDLE_KICK_MS);
}
function kickIdleRoom(room){
  room.idleTimer=null;
  // 房间已被删除，或同号房间已被新房间替换 → 忽略
  if(rooms.get(room.code)!==room) return;
  // 常驻房（LOVE/HOME）即使闲置也不解散
  if(isPreserve(room.code)){ clearIdleKick(room); return; }
  // 只有牌局已结束（本局已结束或本场已无当前局）才解散
  if(room.G && !room.G.ended) return;
  const socks=[];
  for(const s of room.seats){
    if(s.socketId){ const so=io.sockets.sockets.get(s.socketId); if(so) socks.push(so); }
  }
  for(const so of socks){ try{ so.emit('roomClosed'); }catch(e){} }
  rooms.delete(room.code);
  for(const so of socks){ if(so.data){ so.data.room=null; so.data.seat=-1; } } // 清理成员绑定，防闭包盯住已删房间
  // 断开连接，避免服务端闭包仍指向已删除的房间（客户端会自动重连回大厅）
  for(const so of socks){ try{ so.disconnect(true); }catch(e){} }
}

/* ---------- 未开局掉线踢出：真人掉线超过时长（默认3分钟）且牌局未开始 → 座位还原 AI ---------- */
function clearAllOfflineKicks(room){
  if(!room || !room.offlineTimers) return;
  for(const k of Object.keys(room.offlineTimers)){
    const t=room.offlineTimers[k];
    if(t){ clearTimeout(t); delete room.offlineTimers[k]; }
  }
}
function clearOfflineKick(room, seatIdx){
  if(!room || !room.offlineTimers) return;
  const t=room.offlineTimers[seatIdx];
  if(t){ clearTimeout(t); delete room.offlineTimers[seatIdx]; }
}
function scheduleOfflineKick(room, seatIdx){
  if(!room || !room.offlineTimers) return;
  clearOfflineKick(room, seatIdx);
  // 对局进行中/局间：掉线一律保留座位等重连（不踢）。
  if(room.G && !room.seriesOver) return;
  const s=room.seats[seatIdx];
  if(!s || s.type!=='human' || !s.offline) return;
  // 仅「房主」掉线才自动踢（超过 HOST_OFFLINE_KICK_MS）；普通真人掉线由房主手动踢（掉线满 OFFLINE_KICK_WAIT_MS 出现按钮）。
  if(seatIdx!==room.hostSeat) return;
  if(!(HOST_OFFLINE_KICK_MS>0)) return;
  room.offlineTimers[seatIdx]=setTimeout(()=>{
    delete room.offlineTimers[seatIdx];
    // 房间已删/同号被替换 → 忽略
    if(rooms.get(room.code)!==room) return;
    // 场进行中 → 不再踢（转为等待重连）
    if(room.G && !room.seriesOver) return;
    const s2=room.seats[seatIdx];
    if(!s2 || s2.type!=='human' || !s2.offline) return; // 已重连/已离开则作罢
    logLine(room, `${s2.name} 房主掉线超时，已移出房间`);
    room.seats[seatIdx]={type:'ai', name:'空位', avatar:'', openid:''}; // "空位"：未加入玩家，ai 类型仅为可被 join 替换的标记
    room.humanCount=Math.max(0, room.humanCount-1);
    room.ready[seatIdx]=false;
    ensureValidHost(room);
    // 房间无人：不立即删除——30 分钟没人加入再由闲置计时解散（常驻房 LOVE/HOME 永不删）
    if(room.humanCount===0 && !isPreserve(room.code)) scheduleIdleKick(room);
    else broadcast(room);
  }, HOST_OFFLINE_KICK_MS);
}

// 服务器日志：存入房间并推给所有人
function logLine(room, msg){
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  room.log = room.log || [];
  room.log.push(line);
  if(room.log.length>120) room.log.shift();
  io.to(room.code).emit('log', line);
}

/* ---------- AI 座位托管：轮到 AI 时自动出 ---------- */
function aiPlayTurn(room){
  if(room.aiTimer) clearTimeout(room.aiTimer);
  if(!room.G) return;
  const seatIdx = room.G.turn;
  const seat = room.seats[seatIdx];
  if(seat.type!=='ai') return;         // 真人的座位等真人自己动
  room.aiTimer = setTimeout(()=>{
    if(!room.G || room.G.ended || room.G.confirming===false && room.G.turn!==seatIdx) return;
    // 确认轮：AI 表态（仅在轮到且未表态时生效；过期计时器重复触发会被引擎幂等拒绝，不再记假日志）
    if(room.G.confirming){
      let did=false, txt='【不明独】';
      if(TS.canDeclareHard(room.G) && Math.random()<0.05 && seatIdx===room.G.landlord){
        did = TS.confirmChoice(room.G, seatIdx, 'mingdu'); txt='【明独】';
      } else {
        did = TS.confirmChoice(room.G, seatIdx, 'pass');
      }
      if(did) logLine(room, `${seat.name} 选择${txt}`);
      broadcast(room);
      aiPlayTurn(room);
      return;
    }
    // 出牌阶段
    if(room.G.seats[seatIdx].out){ TS.advanceTurn(room.G); broadcast(room); aiPlayTurn(room); return; }
    const ch = TSAI.aiChoose(room.G, seatIdx);
    if(ch===null){
      if(room.G.lastPlay) TS.handlePass(room.G, seatIdx);
      else TS.advanceTurn(room.G);
      logLine(room, `${seat.name} 不出`);
    } else {
      const r = TS.doPlay(room.G, seatIdx, ch.cards);
      if(!r.ok){ logLine(room, `${seat.name} 出错: ${r.why}`); TS.advanceTurn(room.G); }
      else {
        logLine(room, `${seat.name} 出 ${describe(ch.cards)}`);
        const st=room.G.seats[seatIdx];
        if(st.kingPlayed && st.kings>=4 && room.G._kingAnnounced!==seatIdx){
          room.G._kingAnnounced=seatIdx;
          logLine(room, `⚠️ ${seat.name} 起到了 ${st.kings} 张王！`);
        }
      }
    }
    markLast(room); // 局结束标记（AI 出完最后一手/一圈结束时带上）
    broadcast(room);
    if(room.G.ended){ finishRoom(room); return; }
    aiPlayTurn(room);
  }, AI_TURN_MS);
}

function describe(cards){
  return cards.map(c=>TS.cardName(c)).join(' ');
}

/* ---------- 确认轮结束 / 开局 ---------- */
// 场末冻结房里新玩家进入「空位/AI」座：清掉该索引上一局的残局数据并打 blanked 标记，
// 让牌桌对该行按「刚进房间的空座位」渲染（只留名字/头像，不再显示上局玩家的手牌/抓分/游次等）。
// 注意不动 room.series.totals / lastSettle —— 计分板仍按原局身份累计展示。
function blankGameSeatData(G, i){
  if(!G || !G.seats || !G.seats[i]) return;
  const s=G.seats[i];
  s.blanked = true;
  s.hand=[];
  s.lastCards=null;
  s.out=false; s.outOrder=0;
  s.caught=0; s.rollcages=[];
  s.kings=0; s.kingPlayed=false;
  s.hardBombBonus=0;
  s.passed=false;
  if('choice' in s) s.choice=null;
  if('dizhi' in s) s.dizhi=false;
}
// 本房历史分数：场末（自然走完或提前收场）记一条，写 SQLite（每房只保留最近 10 场）。
// 每场玩家昵称可能不同——按该场结束时各座的名字记录。
// 提前结束且一局都没完成（roundCount=0）→ 不计入历史分数。
function pushRoomHistory(room){
  if(!room) return;
  if(!(Number.isFinite(room.series.roundCount) && room.series.roundCount > 0)) return;
  const rec = insertHistory(room); // 写入 DB（含裁剪到 10 场；rounds 逻辑见 db.js），返回新记录
  room.historyCache = [rec, ...(room.historyCache || [])].slice(0, 10); // 同步内存缓存，避免快照每次查库
}
// 房主座位卫生：确保 hostSeat 指向真人座（含离线——掉线的房主保留身份，防他人加入抢走）；
// 否则修复——
//  - 有在线真人 → 移交给座位号最小的在线真人（promotedHost + 房内提示）；
//  - 无在线真人 → hostSeat=-1（房主悬空，等真人 join/rejoin 时自动补位）。
// 仅「未开场/场末/局间」执行；对局进行中不动（避免中途抢房主）。
// 目的：AI 补位房/常驻房真人都退出后，房主不再落在不存在的 AI 座上（如「房主：A家」）。
function ensureValidHost(room){
  if(!room) return false;
  if(room.G && !room.G.ended) return false; // 对局进行中不做房主变动
  const hs=room.hostSeat;
  // 「有效」= 该座仍是真人（含离线：掉线的房主保留身份，避免他人加入时抢走房主；
  //              只有 不存在/空位/AI 才视为空缺——那是“不存在的 AI”问题点）
  const ok = hs>=0 && room.seats[hs] && room.seats[hs].type==='human'
      && !!(room.seats[hs].socketId);
  if(ok) return false;
  for(let j=0;j<4;j++){
    const s=room.seats[j];
    if(s && s.type==='human' && !s.offline && s.socketId){
      room.hostSeat=j;
      const so=io.sockets.sockets.get(s.socketId);
      if(so){ try{ so.emit('promotedHost', {hostSeat:j}); }catch(e){} }
      try{ io.to(room.code).emit('toast', `房主切换为${s.name}`); }catch(e){}
      logLine(room, `${s.name} 成为房主`);
      return true;
    }
  }
  room.hostSeat=-1; // 无在线真人：房主悬空（不挂在 AI/离线座上）
  return true;
}
// 全员就绪检查：真人需准备，AI 座位自动视为已就绪（aiFill 开时参与）
// 两种可开局状态：① 尚未开局（G 为空）② 上一局刚结束、等待开下一局（G.ended）
function checkAllReady(room){
  if(!room) return false;
  const waitingNext = !!(room.G && room.G.ended && !room.seriesOver);
  const noGame = !room.G || room.seriesOver;
  if(!waitingNext && !noGame) return false;
  const needHuman = room.aiFill ? 0 : 4;
  if(room.humanCount < needHuman){ broadcast(room); return false; }
  for(let i=0;i<4;i++){
    const s=room.seats[i];
    const effective = (s.type==='human') || (room.aiFill && s.type==='ai');
    if(effective){
      const ready = (s.type==='ai') || !!room.ready[i];
      if(!ready){ broadcast(room); return false; }
    }
  }
  logLine(room, waitingNext ? '✅ 全员就绪，开下一局！' : '✅ 全员准备，开始对局！');
  if(waitingNext) startNext(room); else startRound(room);
  return true;
}

function startRound(room){
  clearAllOfflineKicks(room); // 开局后掉线一律保留座位，不再踢出
  clearEndVote(room);
  clearIdleKick(room);
  room.seriesOver=false;      // 新的一场开始：解除“本场已结束”的冻结状态
  room.earlyEnded=false;      // 解除上一场「提前结束」标记（新的一场按正常场末文案）
  room.series.active=false; room.series.roundCount=0; room.series.totals=[0,0,0,0]; room.series.lastRound=null; // 新的一场：累计/轮数归零
  // 开局即清 ready：消除 setSettings(wantStart) 遗留在房主座位上的就绪标记。
  // 否则首局全程 snap.ready[房主]=true，局末 ended 帧会把"上一局的就绪残留"
  // 误判为"已点准备"→ 没点任何按钮就提前清掉牌桌（局末/场末直接清空）。
  //（startNext 一直这么清；startRound 之前漏了，两败由此统一。）
  room.ready=[false,false,false,false];
  room.G = TS.newGame(Math.floor(Math.random()*1e9), makeCfg(room));
  room.G.rollcages = room.G.seats.map(()=>[]);
  room.roundSeq++; room.G.seq=room.roundSeq;
  // 服务器持局：开局先广播叫牌信息
  logLine(room, `—— 第 ${room.G.roundNo} 局 ——`);
  logLine(room, `庄家 ${room.seats[room.G.landlord].name}，叫牌 ${TS.cardName(room.G.called)}`);
  broadcast(room);
  aiPlayTurn(room);
}

// 开下一局：按上一局一游当庄
function startNext(room){
  clearAllOfflineKicks(room); // 开局后掉线一律保留座位，不再踢出
  clearEndVote(room);
  clearIdleKick(room);
  const nextLandlord = (room.G && room.G.firstOut!=null) ? room.G.firstOut : null;
  room.G = TS.newGame(Math.floor(Math.random()*1e9), makeCfg(room));
  if(nextLandlord!=null) TS.pickLandlord(room.G, nextLandlord);
  room.G.roundNo = room.series.roundCount + 1;
  room.roundSeq++; room.G.seq=room.roundSeq;
  room.ready = [false,false,false,false]; // 各玩家为下一局重新就绪
  logLine(room, `—— 第 ${room.G.roundNo} 局 ——`);
  logLine(room, `庄家 ${room.seats[room.G.landlord].name}，叫牌 ${TS.cardName(room.G.called)}`);
  broadcast(room);
  aiPlayTurn(room);
}

function finishRoom(room){
  if(!room.G || room.G._settled) return; // 幂等：同一局只结算一次（防重复 act/过期 AI 计时器二次累计）
  room.G._settled = true;
  clearEndVote(room); // 局结束/本场自然结束：若有进行中的提前收场表决一并废弃
  const s = TS.settleRound(room.G);
  room.lastSettle = s; // 服务端权威结算结果：随 ended 快照下发，客户端不再本地重算
  markLast(room); // 确保最后一局的标记已带上
  logLine(room, `—— 第 ${room.G.roundNo} 局结算 ——`);
  for(let i=0;i<4;i++){
    logLine(room, `  ${room.seats[i].name}：${s.perFen[i]>0?'+':''}${s.perFen[i]}分` +
      (s.kingBonus && s.kingBonus[i] ? `（含王奖金 ${s.kingBonus[i]}笼×3）` : '') +
      (s.bombBonus && s.bombBonus[i] ? `（含硬炸奖 ${s.bombBonus[i]}笼×3）` : ''));
  }
  // 轮结算：累计
  room.series.active = true;
  room.series.roundCount++;
  for(let i=0;i<4;i++) room.series.totals[i]+=s.perFen[i];
  room.series.lastRound = s;
  // 达到设置局数 → 输出本场结算并重置（下场比赛需重新准备）
  if(room.series.roundCount >= room.settings.rounds){
    logLine(room, `══════ 本场 ${room.settings.rounds} 局全部结束 ══════`);
    pushRoomHistory(room); // 自然场末：记录历史分数
    logLine(room, `  累计：${room.seats.map((se,i)=>`${se.name} ${room.series.totals[i]>0?'+':''}${room.series.totals[i]}分`).join('｜')}`);
    room.series.active=false; room.series.lastRound=null;
    // 累计/轮数保留：冻结屏与计分板继续显示最终累计；新的一场开始时由 startRound 归零
    room.ready=[false,false,false,false]; // 准备重置，下场比赛重新准备
    // 本场结束不清 G：保留最后一局的牌桌，等玩家点【准备】开下一场时再换新局
    room.seriesOver=true;
    // 仅场末起闲置解散计时；局间（等【下一局】）不超时
    scheduleIdleKick(room);
  } else {
    // 非最后一局：等所有玩家点【下一局】就绪后自动开下一局
    room.ready=[false,false,false,false];
    logLine(room, `请各玩家点击【下一局】就绪，全员就绪自动开下一局`);
  }
  broadcast(room);
  // 不自动开下一局，等所有玩家就绪
}

/* ---------- 动作限流：每 socket 每类动作滑窗计数，防脚本刷请求 ----------
 * 已知局限：按 socket（连接）计数而非按 IP——重连/多开可绕开预算，属姿态性防御，
 * 用于挡自动脚本的明显噪音，不视为关键资源的强保护。 */
const RATE_LIMITS = {
  create:       [60000, 20],
  join:         [10000, 10],
  rejoin:       [10000, 10],
  deleteRoom:   [60000, 20],
  act:          [1000, 100],  // 防暴雨洪但留足真实峰值空间（AI 快速联机合法可超 25/s）
  setSettings:  [10000, 20],
  endSeries:    [10000, 3],
  endSeriesVote:[10000, 10],
  takeoverVote: [10000, 10],
  toggleAI:     [5000, 4],
  kickSeat:     [10000, 20],
  toggleReady:  [3000, 4],
  nextRound:    [3000, 4],
  start:        [10000, 5],
  listRooms:    [5000, 8],
};
function permit(socket, key){
  const cfg=RATE_LIMITS[key]||[60000, 120];
  const win=cfg[0], max=cfg[1], t=Date.now();
  socket.data.rates = socket.data.rates || {};
  const arr = socket.data.rates[key] = socket.data.rates[key] || [];
  while(arr.length && arr[0] <= t - win) arr.shift();
  if(arr.length >= max){ try{ socket.emit('toast','操作太频繁，请稍后再试'); }catch(e){} return false; }
  arr.push(t);
  return true;
}

/* ---------- 座位顶替（重连接管）----------
 * 原则：客户端自动归位（auto:true，闪断/刷新＝本人正常路径）与微信本人（openid 强身份）直接归位、不设门禁；
 *      其余手动 rejoin（输入房号+昵称）可能是本人换设备、也可能是冒用——按在位状态门禁：
 *        座位有人在线        → 推弹窗给在位者：同意才接管（被顶替者清桌退回大厅）；不同意→继续游戏并进入冷静期；
 *        座位掉线不足窗口     → 视为网络波动，暂不允许接管；
 *        座位掉线超过窗口     → 允许直接接管（原有行为）。
 * 对方不同意后 TAKEOVER_REJECT_MS 内，该座位的任何手动重连一律拦截（按座位全局，防多账号轮番轰炸）。 */
const REJOIN_TAKEOVER_MS  = Number(process.env.REJOIN_TAKEOVER_MS  || 30*1000); // 「网络波动」窗口：掉线超过此时长才允许被手动顶替
const TAKEOVER_ASK_MS     = Number(process.env.TAKEOVER_ASK_MS     || 30*1000); // 顶替弹窗等待时长（超时作废）
const TAKEOVER_REJECT_MS  = 10*1000;    // 对方不同意后的冷静期
const TAKEOVER_APPROVE_MS = Number(process.env.TAKEOVER_APPROVE_MS || 15*1000); // 同意后等待请求方完成归位的最长时长

// 座位是否「有人在线在桌」：座位指向的 socket 在线、且在房间内
function seatOnlineInRoom(room, seatIdx){
  const s=room.seats[seatIdx];
  if(!s || !s.socketId) return false;
  const os=io.sockets.sockets.get(s.socketId);
  return !!(os && os.connected && os.data && os.data.room===room);
}
// 作废座位上的顶替弹窗（pending ask）；why 非空时通知请求方作废原因
function cancelTakeoverAsk(room, seatIdx, why){
  const s=room.seats && room.seats[seatIdx];
  if(!s || !s.takeAsk) return;
  if(s.takeTimer){ clearTimeout(s.takeTimer); s.takeTimer=null; }
  const ask=s.takeAsk;
  s.takeAsk=null;
  if(why){
    const os=io.sockets.sockets.get(ask.sid);
    if(os && os.connected){ try{ os.emit('takeoverResult', {ok:false, reason:why}); }catch(e){} }
  }
}
function clearAllTakeoverAsks(room){
  if(!room || !room.seats) return;
  for(let i=0;i<4;i++) cancelTakeoverAsk(room, i, null);
}
// 接管座位：把座位挂到新连接，并清掉旧连接的房间绑定（被顶替者收 displaced，清桌退回大厅）
function takeOverSeat(room, seatIdx, ident, newSocket){
  const seat=room.seats[seatIdx];
  const oldId=seat.socketId;
  seat.socketId=newSocket.id;
  seat.offline=false;
  seat.offlineAt=0;
  seat.name=ident.name;
  seat.avatar=ident.avatar;
  if(ident.openid) seat.openid=ident.openid;
  clearOfflineKick(room, seatIdx);
  cancelTakeoverAsk(room, seatIdx, null);
  seat.takeRejectUntil=0;
  seat.takeApproved=null;
  if(seat.takeApprTimer){ clearTimeout(seat.takeApprTimer); seat.takeApprTimer=null; }
  if(oldId && oldId!==newSocket.id){
    const os=io.sockets.sockets.get(oldId);
    if(os && os!==newSocket){
      const wasInRoom=!!(os.data && os.data.room===room);
      try{ os.leave(room.code); }catch(e){}
      if(os.data){ os.data.room=null; os.data.seat=-1; }
      if(os.connected && wasInRoom){ try{ os.emit('displaced', {name:seat.name}); }catch(e){} } // 被顶替：清桌回大厅
    }
  }
  ensureValidHost(room); // 每次接管后校验房主座卫生（被顶的恰是房主时自动移交/悬空；对局进行中由函数内部跳过）
}

/* ---------- Socket.IO ---------- */
io.on('connection', (socket)=>{
  let room=null, mySeat=-1;
  socket.data = Object.assign({}, socket.data, { room:null, seat:-1 }); // 统一成员绑定：绑定/改名/清退都会同步此处
  // 同一浏览器携带签名 Cookie，服务端据此确认微信身份（不信任客户端传来的昵称/头像）
  const wxSession = sessionFromSocket(socket);

  // 统一兜底：事件处理器抛异常不允许炸进程（记日志并提示玩家），配 data 加固防止任何入口崩溃
  const on=(ev,fn)=>{ socket.on(ev,(...a)=>{ try{ fn(...a); } catch(e){ console.error(`[socket] ${ev} 异常：`, e&&e.stack?e.stack:e); try{ socket.emit('toast','操作失败，请重试'); }catch(_){} } }); };

  // 房间列表（大厅显示）
  on('listRooms', ()=>{ if(!permit(socket,'listRooms')) return;
    // 兜底：常驻房（LOVE/HOME）若缺失（异常删除/旧版本残留）则立即重建
    for(const code of PRESERVE_ROOMS) if(!rooms.has(code)) createRoom(code);
    const list=[];
    rooms.forEach(r=>{
      const hs=r.hostSeat!=null?r.hostSeat:0; // 房主座位（hostSeat 与座位归属解耦）
      list.push({
        code:r.code,
        humans:r.humanCount,
        aiFill:r.aiFill,
        started: !!(r.G && !r.seriesOver), // 对局中（含确认轮）：可加入/状态判断不再依赖 G.started（首手才算开局太晚）
        hasGame: !!r.G,   // 房间已创建对局（含确认轮），供重连列表判断
        rounds:r.settings.rounds,
        host: (r.seats[hs] && r.seats[hs].type==='human') ? r.seats[hs].name : null,
      });
    });
    socket.emit('rooms', list);
  });

  on('create', (data)=>{ if(!permit(socket,'create')) return;
    // 闭包残留自愈：被顶替等只清了 socket.data，闭包 room 还指着旧房 → 先同步，防误报「你已在房间中」
    if(room && !socket.data.room){ room=null; mySeat=-1; }
    if(room){ socket.emit('toast','你已在房间中'); return; }
    data = data||{};
    // 自定义房间号（可选，4 位大写字母/数字）；不填则随机
    const custom = (data.code != null && String(data.code).trim()) ? roomCodeOf(data.code) : '';
    if(custom===null){ socket.emit('toast','房间号需为 4 位字母或数字'); return; }
    if(custom && rooms.has(custom)){ socket.emit('toast','房间号已被占用'); return; }
    const r=createRoom(custom);
    const seatIdx=0;
    const ident=identityOf(Object.assign({}, data, {name:(data&&data.name)||'玩家1'}), wxSession);
    const name=ident.name;
    r.seats[seatIdx]={type:'human', socketId:socket.id, name, avatar:ident.avatar, openid:ident.openid, offline:false};
    r.humanCount++;
    // 房主可带初始设置（逐键白名单：防非法值进引擎 / Object.assign 的 __proto__ 污染）
    if(data.settings) applySettings(r, data.settings);
    room=r; mySeat=seatIdx;
    socket.data.room=r; socket.data.seat=seatIdx;
    socket.join(r.code);
    // 创建后房主直接进牌桌（房间仍在列表，其他玩家可加入）
    socket.emit('joined', {code:r.code, seat:seatIdx, name, avatar:ident.avatar});
    broadcast(r);
    scheduleIdleKick(r); // 未开场的等待房：30 分钟闲置解散（开局时由 startRound 清除）
    socket.emit('toast', `已创建房间 ${r.code}，等待其他玩家加入`);
  });

  // 房主调整牌局设置
  on('setSettings', (data)=>{ if(!permit(socket,'setSettings')) return;
    if(!room || mySeat!==room.hostSeat){ socket.emit('toast','只有房主能设置'); return; }
    if(configLocked(room)){ socket.emit('toast','对局进行中，设置已锁定'); return; }
    data = data||{};
    // 快照旧设置，检测变化（客户端每个控件 onchange 都发全量设置，需对比才知道哪些真变了）
    const old = {
      rounds: room.settings.rounds, kings: room.settings.kings, jokerValue: room.settings.jokerValue,
      halfFan: room.settings.halfFan, fanCap: room.settings.fanCap, tailBonus: room.settings.tailBonus,
      showRemain: room.settings.showRemain, showCorner: room.settings.showCorner, showLog: room.settings.showLog,
      aiFill: room.aiFill, aiAuto: room.settings.aiAuto,
    };
    // 逐键白名单（与 create 共用 applySettings）；wantStart 在下方单独处理
    applySettings(room, data);
    const changes = settingChanges(old, room);
    if(changes.length > 0){
      // 设置确有变化：所有已准备玩家退回未准备（避免按旧设置开局），并广播变化给全房
      let hadReady = false;
      for(let i=0;i<4;i++){ if(room.ready[i]){ room.ready[i]=false; hadReady=true; } }
      io.to(room.code).emit('toast', '牌局设置：' + changes.join('，') + (hadReady ? '（已准备玩家退回未准备）' : ''));
    }
    // 点【开始对局】：房主自己也准备，已就绪的真人 + AI 补位即可立即开局
    const wantStart = (data.start===true);
    if(wantStart) room.ready[room.hostSeat]=true;  // 房主自己标记准备（hostSeat 与座位 0 解耦）
    broadcast(room);
    if(wantStart){
      const started=checkAllReady(room);
      socket.emit('toast', started? '开始对局！' : '已准备，等待其他玩家就绪后开局');
    }
  });

  on('join', (data)=>{ if(!permit(socket,'join')) return;
    // 闭包残留自愈（同 create）：被顶替等后闭包 room 残留 → data 为准
    if(room && !socket.data.room){ room=null; mySeat=-1; }
    if(room){ socket.emit('toast','你已在房间中'); return; }
    const code = roomCodeOf(data && data.code);
    if(!code){ socket.emit('toast','房间号需为 4 位字母或数字'); return; }
    if(!wxSession && !String((data&&data.name)||'').trim()){ socket.emit('toast','请输入昵称'); return; }
    const ident=identityOf(data, wxSession);
    const name=ident.name;
    const r=rooms.get(code);
    if(!r){ socket.emit('toast','房间不存在'); return; }
    if(r.G && !r.seriesOver){ socket.emit('toast','对局已开始，无法中途加入'); return; }
    // 身份检查：微信按 openid 判重（允许不同 openid 的昵称重名）；手动昵称仍要求唯一
    const sameHuman = r.seats.some(s=>{
      if(s.type!=='human') return false;
      if(ident.openid) return s.openid===ident.openid;
      return s.name===name;
    });
    if(sameHuman){ socket.emit('toast','你已在该房间，可直接重连'); return; }
    // 找空座位：优先顶替 offline 真人座（仅场末/未开局可达——对局进行中已被上面的守卫拦截；决策 Q3）
    let seatIdx=r.seats.findIndex(s=>s.type==='human' && s.offline);
    const takeOver = seatIdx>=0;
    if(seatIdx<0) seatIdx=r.seats.findIndex(s=>s.type==='ai');
    if(seatIdx<0){ socket.emit('toast','房间已满'); return; }
    clearOfflineKick(r, seatIdx); // 入座/顶替：取消该座的离线踢出计时器
    const wasAi = r.seats[seatIdx].type!=='human'; // 顶替离线真人座(type=human)不算、不扰其残局；空位/AI 座被新玩家入座才清
    r.seats[seatIdx]={type:'human', socketId:socket.id, name, avatar:ident.avatar, openid:ident.openid, offline:false};
    if(!takeOver) r.humanCount++; // 顶替：座位上真人仍在，人数不变
    // 场末冻结房新玩家进入空位/AI 座：清该索引的上一局残局数据（牌桌按「刚进房间的空座」渲染）
    if(wasAi && r.G && r.G.ended) blankGameSeatData(r.G, seatIdx);
    room=r; mySeat=seatIdx;
    socket.data.room=r; socket.data.seat=seatIdx;
    socket.join(r.code);
    socket.emit('joined', {code:r.code, seat:seatIdx, name, avatar:ident.avatar});
    ensureValidHost(room); // 房主悬空/落在 AI 座时：真人入座立即补位成房主
    broadcast(r);
    scheduleIdleKick(r); // 有人加入＝房间有活动：重置闲置解散计时
    socket.emit('toast', `已加入房间 ${r.code}，你是第 ${r.humanCount} 位玩家`);
  });

  // 重连：房间号 + 玩家姓名 归位
  on('rejoin', (data)=>{ if(!permit(socket,'rejoin')) return;
    data=data||{};
    const code = roomCodeOf(data && data.code);
    const name=(data.name||'').trim();
    if(!wxSession && !name){ socket.emit('toast','请输入昵称'); return; }
    if(!code){ socket.emit('toast','房间号需为 4 位字母或数字'); return; }
    // 闭包残留自愈：被顶替等只清了 socket.data，闭包 room 还指着旧房 → 先同步，防误入短路/误报
    if(room && !socket.data.room){ room=null; mySeat=-1; }
    // 若本 socket 已绑定房间：直接确认进桌（创建后点自己的房间进入）。
    // 归属以 socket.data.room 与 seat.socketId 为准——被顶替/换座后闭包 room 仍在也不走这里，落回正常门禁
    if(room){
      if(room.code===code){
        if(mySeat>=0 && socket.data.room===room
           && room.seats[mySeat] && room.seats[mySeat].socketId===socket.id){
          const me=room.seats[mySeat];
          socket.emit('joined', {code:room.code, seat:mySeat, name:me.name, avatar:me.avatar||''});
          broadcast(room);
          return;
        }
        // 同房但座位已不是本连接（被顶替/换座）：不短路，继续走正常 rejoin 门禁
      } else {
        socket.emit('toast','你已在其他房间');
        return;
      }
    }
    const r=rooms.get(code);
    if(!r){ socket.emit('toast','房间不存在'); return; }
    const ident=identityOf(data, wxSession);
    // 微信身份按 openid 归位；未授权则按手动昵称归位（不匹配已有微信座位，避免冒用）
    let seatIdx=-1;
    if(ident.openid){
      seatIdx=r.seats.findIndex(s=>s.type==='human' && s.openid===ident.openid);
      if(seatIdx<0) seatIdx=r.seats.findIndex(s=>s.type==='human' && !s.openid && s.name===ident.name);
    } else {
      seatIdx=r.seats.findIndex(s=>s.type==='human' && !s.openid && s.name===ident.name);
    }
    if(seatIdx<0){
      // 被踢的明确提示：rejoin 时身份命中近期被踢名单 → 说明座位已被房主移出（而非不存在/被占）
      const kicked = (r.recentKicks||[]).find(k =>
        (ident.openid && k.openid===ident.openid) || (!ident.openid && k.name===ident.name));
      if(kicked){ socket.emit('toast', '你已被房主移出房间'); return; }
      const wxSeat=r.seats.some(s=>s.type==='human' && s.openid && s.name===ident.name);
      socket.emit('toast', wxSeat ? '该座位已绑定微信，请先完成微信授权再重连' : '未找到与你身份匹配的座位');
      return;
    }
    const seat=r.seats[seatIdx];
    // —— 本人直接归位的两条路径，不设门禁 ——
    const isOwnerOpenid = !!(ident.openid && seat.openid===ident.openid);
    if(isOwnerOpenid || data.auto===true){
      // 微信本人（openid 强身份）/ 客户端自动归位（闪断、刷新＝本人正常路径，不被顶替门禁拦截）
      takeOverSeat(r, seatIdx, ident, socket);
      room=r; mySeat=seatIdx;
      socket.data.room=r; socket.data.seat=seatIdx;
      socket.join(r.code);
      socket.emit('joined', {code:r.code, seat:seatIdx, name:seat.name, avatar:seat.avatar||''});
      broadcast(r);
      scheduleIdleKick(r);
      socket.emit('toast', `重连成功，你坐回 ${seat.name}`);
      return;
    }
    // —— 手动重连（输入房号+昵称）：可能是本人换设备、也可能是冒用，按在位状态门禁 ——
    // 对方已同意顶替 → 完成归位（身份在弹窗时锁定；须由请求方同一连接再次 rejoin，保证座位绑定落在自己连接上）
    if(seat.takeApproved && seat.takeApproved.sid===socket.id && seat.takeApproved.until>Date.now()){
      const ap=seat.takeApproved;
      takeOverSeat(r, seatIdx, ap, socket);
      room=r; mySeat=seatIdx;
      socket.data.room=r; socket.data.seat=seatIdx;
      socket.join(r.code);
      socket.emit('joined', {code:r.code, seat:seatIdx, name:seat.name, avatar:seat.avatar||''});
      broadcast(r);
      scheduleIdleKick(r);
      socket.emit('toast', `顶替成功，你坐回 ${seat.name}`);
      return;
    }
    if(seat.takeRejectUntil > Date.now()){ // 对方刚才不同意：座位全局冷静期（防轮番轰炸）
      const sec=Math.ceil((seat.takeRejectUntil-Date.now())/1000);
      socket.emit('toast', `对方刚才不同意顶替，请 ${sec} 秒后再试`);
      return;
    }
    if(seat.takeAsk){ socket.emit('toast','该座位已有顶替请求待对方回应'); return; }
    if(seatOnlineInRoom(r, seatIdx)){
      // 座位有人在线：推弹窗给在位者，同意才接管
      seat.takeAsk={sid:socket.id, name:ident.name, avatar:ident.avatar, openid:ident.openid||''};
      seat.takeTimer=setTimeout(()=>{
        if(r.seats[seatIdx] && r.seats[seatIdx].takeAsk && r.seats[seatIdx].takeAsk.sid===socket.id){
          cancelTakeoverAsk(r, seatIdx, '对方未回应，顶替请求已作废');
        }
      }, TAKEOVER_ASK_MS);
      const os=io.sockets.sockets.get(seat.socketId);
      if(os && os.connected){ try{ os.emit('takeoverAsk', {name:ident.name, expire:TAKEOVER_ASK_MS}); }catch(e){} }
      socket.emit('toast', `已向「${seat.name}」请求顶替座位，等待对方回应`);
      scheduleIdleKick(r);
      return;
    }
    // 掉线：不足「网络波动」窗口 → 暂不可接管（对方可能还在重连）
    const offlineAge = seat.offlineAt ? Date.now()-seat.offlineAt : Infinity;
    if(REJOIN_TAKEOVER_MS>0 && offlineAge < REJOIN_TAKEOVER_MS){
      const waitSec=Math.max(1, Math.ceil((REJOIN_TAKEOVER_MS-offlineAge)/1000));
      socket.emit('toast', `「${seat.name}」刚掉线，可能网络波动，约 ${waitSec} 秒后可重连`);
      return;
    }
    // 掉线超过窗口 → 直接接管（原行为）
    takeOverSeat(r, seatIdx, ident, socket);
    room=r; mySeat=seatIdx;
    socket.data.room=r; socket.data.seat=seatIdx;
    socket.join(r.code);
    socket.emit('joined', {code:r.code, seat:seatIdx, name:seat.name, avatar:seat.avatar||''});
    broadcast(r);
    scheduleIdleKick(r);
    socket.emit('toast', `重连成功，你坐回 ${seat.name}`);
  });

  // 顶替弹窗答复：对方「同意」→ 锁定请求方身份，等待请求方再次 rejoin 完成接管；
  //               「不同意」→ 座位全局 10s 冷静期，请求方收到被拒提示
  on('takeoverVote', (data)=>{ if(!permit(socket,'takeoverVote')) return;
    if(!room || mySeat<0) return;
    const idx=mySeat, r=room;
    const s=r.seats[idx];
    const ask=s && s.takeAsk;
    if(!ask) return;
    if(s.takeTimer){ clearTimeout(s.takeTimer); s.takeTimer=null; }
    s.takeAsk=null;
    if(data && data.ok){
      // 同意：请求方仍在 → 锁定身份并告知其重新归位
      const rq=io.sockets.sockets.get(ask.sid);
      if(!rq || !rq.connected){
        socket.emit('toast','对方已离线，顶替取消');
        return;
      }
      s.takeApproved={sid:ask.sid, name:ask.name, avatar:ask.avatar||'', openid:ask.openid||'', until:Date.now()+TAKEOVER_APPROVE_MS};
      socket.emit('toast','已同意顶替，正在切换…');
      try{ rq.emit('takeoverResult', {ok:true, code:r.code, seat:idx, name:r.seats[idx].name}); }catch(e){}
      if(s.takeApprTimer){ clearTimeout(s.takeApprTimer); s.takeApprTimer=null; }
      const apprSid=ask.sid;
      s.takeApprTimer=setTimeout(()=>{
        const ss=r.seats && r.seats[idx];
        if(ss && ss.takeApproved && ss.takeApproved.sid===apprSid){
          ss.takeApproved=null;
          const o2=io.sockets.sockets.get(ss.socketId);
          if(o2 && o2.connected){ try{ o2.emit('toast','对方未完成接管，游戏继续'); }catch(e){} }
        }
      }, TAKEOVER_APPROVE_MS);
      logLine(r, `${r.seats[idx].name} 同意他人顶替`);
    } else {
      // 不同意：继续游戏；10s 冷静期内任何手动重连都被拦
      s.takeRejectUntil=Date.now()+TAKEOVER_REJECT_MS;
      const rq=io.sockets.sockets.get(ask.sid);
      if(rq && rq.connected){ try{ rq.emit('takeoverResult', {ok:false, reason:'对方不同意顶替'}); }catch(e){} }
      socket.emit('toast','你不同意顶替，游戏继续');
      logLine(r, `${r.seats[idx].name} 拒绝顶替请求`);
    }
  });

  // 房主切换 AI 补位
  on('toggleAI', ()=>{ if(!permit(socket,'toggleAI')) return;
    if(!room) return;
    if(mySeat!==room.hostSeat){ socket.emit('toast','只有房主能设置'); return; }
    if(configLocked(room)){ socket.emit('toast','对局进行中，设置已锁定'); return; }
    room.aiFill = !room.aiFill;
    socket.emit('toast', `AI 补位已${room.aiFill?'开启':'关闭'}`);
    broadcast(room);
  });

  // 玩家准备/取消准备（对局配置由房主在弹窗调整；全员准备后自动开局）
  on('toggleReady', ()=>{ if(!permit(socket,'toggleReady')) return;
    // 未开局 / 本场已结束 / 本局已结束（局末等下一局）都可切换准备；对局进行中不允许
    if(!room || (room.G && !room.G.ended && !room.seriesOver)) return;
    if(mySeat<0 || room.seats[mySeat].type!=='human') return;
    if(room.seats[mySeat].socketId !== socket.id) return; // 旧标签的请求：座位已被新连接接管
    room.ready[mySeat]=!room.ready[mySeat];
    socket.emit('toast', room.ready[mySeat]?'已准备':'已取消准备');
    scheduleIdleKick(room); // 未开局/场末点准备＝房间有活动：重置闲置解散计时
    checkAllReady(room);
  });

  // 开局（房主点击"对局配置"后由设置弹窗确认，不再直接 start；保留 start 兼容但同样收权：
// 房主专属 + 限流 + 走全员就绪门槛，消除旧客户端可越权开局/刷局的问题）
  on('start', ()=>{ if(!permit(socket,'start')) return;
    if(!room) return;
    if(room.G && !room.seriesOver) return;
    if(mySeat!==room.hostSeat){ socket.emit('toast','只有房主能开始'); return; }
    if(!room.aiFill && room.humanCount<4){
      socket.emit('toast', `AI补位未开，还差 ${4-room.humanCount} 位真人才能开始；或先开启AI补位`);
      return;
    }
    const started=checkAllReady(room); // 与 setSettings wantStart 同口径：全员就绪才开
    socket.emit('toast', started? '开始对局！' : '已准备，等待其他玩家就绪后开局');
  });

  on('nextRound', ()=>{ if(!permit(socket,'nextRound')) return;
    if(!room || !room.G || !room.G.ended) return; // 上一局尚未结束时忽略
    if(mySeat<0 || room.seats[mySeat].type!=='human') return;
    if(room.seats[mySeat].socketId !== socket.id) return; // 旧标签的请求：座位已被新连接接管
    room.ready[mySeat]=true;
    socket.emit('toast','已就绪，等待其他玩家');
    checkAllReady(room);
  });

  // 玩家动作
  on('act', (data)=>{ if(!permit(socket,'act')) return;
    if(!room || !room.G) return;
    data = data||{};
    const seatIdx=Number(data.seat);
    if(!Number.isInteger(seatIdx) || seatIdx!==mySeat){ socket.emit('toast','不是你的座位'); return; }
    // 旧标签/旧连接发的请求：座位当前 socketId 不再属于本 socket → 忽略（防迟到 act 误操作）
    if(room.seats[seatIdx].socketId !== socket.id) return;
    if(room.G.ended) return; // 已结束：重复/迟到的 act 一律忽略（防二次结算/二次广播）
    if(room.G.confirming){
      if(data.type==='confirm'){
        if(seatIdx!==room.G.turn){ socket.emit('toast','还没轮到你'); return; }
        if(room.G.seats[seatIdx].choice){ socket.emit('toast','你已表态，不能重复'); return; }
        const choice=data.choice==='mingdu'?'mingdu':'pass';
        if(!TS.confirmChoice(room.G, seatIdx, choice)){ socket.emit('toast','当前不能表态'); return; }
        logLine(room, `${room.seats[seatIdx].name} 选择【${choice==='mingdu'?'明独':'不明独'}】`);
      } else if(data.type==='restart'){
        // 毁牌：仅当前轮次、未表态且无炸时才能发起（整局重发）
        if(seatIdx!==room.G.turn){ socket.emit('toast','还没轮到你'); return; }
        if(room.G.seats[seatIdx].choice){ socket.emit('toast','已表态，不能毁牌'); return; }
        if(TS.handHasBomb(room.G.seats[seatIdx].hand)){ socket.emit('toast','你有炸，不能毁牌'); return; }
        logLine(room, `${room.seats[seatIdx].name} 选择【毁牌】`);
        // 走引擎重发：换随机种子、保留当前 roundNo、沿用房间设置（决策 C）
        room.G = TS.declareRestart(room.G, makeCfg(room));
        room.roundSeq++; room.G.seq = room.roundSeq; // 局序号递增：前端据此判别换了新牌
        clearEndVote(room); // 重发新局：进行中的提前收场表决作废
        logLine(room, `—— 重发 · 第 ${room.G.roundNo} 局 ——`);
        logLine(room, `庄家 ${room.seats[room.G.landlord].name}，叫牌 ${TS.cardName(room.G.called)}`);
        broadcast(room);
        aiPlayTurn(room);
        return;
      }
      broadcast(room);
      aiPlayTurn(room);
      return;
    }
    // 出牌阶段
    if(seatIdx!==room.G.turn){ socket.emit('toast','还没轮到你'); return; }
    if(data.type==='play'){
      if(!Array.isArray(data.cards)){ socket.emit('toast','出牌参数非法'); return; }
      if(data.cards.length>128){ socket.emit('toast','出牌参数非法'); return; }
      const r=TS.doPlay(room.G, seatIdx, data.cards);
      if(!r.ok){ socket.emit('toast', r.why); return; }
      logLine(room, `${room.seats[seatIdx].name} 出 ${describe(data.cards)}`);
      // 打出第一张王且开局 ≥4 王 → 通知大家
      const st=room.G.seats[seatIdx];
      if(st.kingPlayed && st.kings>=4 && room.G._kingAnnounced!==seatIdx){
        room.G._kingAnnounced=seatIdx;
        logLine(room, `⚠️ ${room.seats[seatIdx].name} 起到了 ${st.kings} 张王！`);
      }
    } else if(data.type==='pass'){
      if(!room.G.lastPlay){ socket.emit('toast','领出必须出牌'); return; }
      TS.handlePass(room.G, seatIdx);
      logLine(room, `${room.seats[seatIdx].name} 不出`);
    }
    markLast(room); // 局结束标记（有则带上，重复广播幂等）
    broadcast(room);
    if(room.G.ended){ finishRoom(room); return; }
    aiPlayTurn(room);
  });

  // 提前结束本场（全真人房共识）：发起
  on('endSeries', ()=>{ if(!permit(socket,'endSeries')) return;
    if(!room) return;
    if(!seriesInProgress(room)){ socket.emit('toast','当前没有进行中的本场'); return; }
    if(room.endVote){ socket.emit('toast','已有人发起提前结束，请先表决'); return; }
    if(mySeat<0 || room.seats[mySeat].type!=='human') return;
    if(room.seats[mySeat].socketId !== socket.id) return; // 旧标签的请求：座位已被新连接接管
    // 满员真人房维持决策 A：4 位真人且全员在线才可发起；
    // 含 AI 座/真人不足 4 的房：门禁放宽为「在线真人全票」——离线真人座与 AI 座不占票、不阻塞
    if(room.humanCount===4){
      for(let i=0;i<4;i++){
        const st=room.seats[i];
        if(st.type!=='human' || st.offline){ socket.emit('toast','需要 4 位在线真人才能提前结束本场'); return; }
      }
    }
    // 票数门槛 = 发起时在线真人人数（含发起者），表决中按此收敛，而不是写死 4 票
    const need = room.seats.filter(s=>s.type==='human' && !s.offline).length;
    room.endVote={ requester:mySeat, need, agree:new Set([mySeat]), timer:null };
    room.endVote.timer=setTimeout(()=>{
      if(room && room.endVote) cancelEndVote(room, '提前结束表决超时（30 秒内未全票同意），请求作废');
    }, END_VOTE_MS);
    logLine(room, `${room.seats[mySeat].name} 发起【提前结束本场】，请各在线真人在 30 秒内表决`);
    io.to(room.code).emit('endSeriesAsk', {requester:mySeat, name:room.seats[mySeat].name});
    broadcast(room);
    // 门槛=1（该房仅一名在线真人）时发起即达成 → 直接收场（finalize 会带出真正的场末帧）
    if(room.endVote && room.endVote.agree.size >= room.endVote.need) finalizeEndSeries(room);
  });

  // 提前结束本场：其他三人表决
  on('endSeriesVote', (data)=>{ if(!permit(socket,'endSeriesVote')) return;
    if(!room || !room.endVote || mySeat<0) return;
    if(mySeat===room.endVote.requester){ socket.emit('toast','你是发起方，等待其他人表决'); return; }
    const st=room.seats[mySeat];
    if(room.seats[mySeat].socketId !== socket.id) return; // 旧标签的请求：座位已被新连接接管
    if(st.type!=='human' || st.offline) return;
    if(room.endVote.agree.has(mySeat)){ socket.emit('toast','你已表决'); return; }
    if(!(data && data.vote)){
      io.to(room.code).emit('toast', `${st.name} 拒绝结束本场，请求作废`);
      cancelEndVote(room, `${st.name} 不同意，提前结束请求作废`);
      return;
    }
    room.endVote.agree.add(mySeat);
    io.to(room.code).emit('toast', `${st.name} 同意结束本场`);
    logLine(room, `${st.name} 同意提前结束`);
    if(room.endVote.agree.size>=room.endVote.need) finalizeEndSeries(room);
    else broadcast(room);
  });

  // 房主手动踢出「未开场/场末」掉线满 OFFLINE_KICK_WAIT_MS 的真人（非房主掉线不自动踢）
  on('kickSeat', (data)=>{ if(!permit(socket,'kickSeat')) return;
    if(!room || mySeat<0) return;
    if(mySeat!==room.hostSeat){ socket.emit('toast','只有房主能踢人'); return; }
    if(room.G && !room.G.ended){ socket.emit('toast','对局进行中，不能踢人'); return; }
    const idx=Number(data && data.seat);
    if(!Number.isInteger(idx) || idx<0 || idx>3) return;
    const s=room.seats[idx];
    if(!s || s.type!=='human' || !s.offline){ socket.emit('toast','该玩家不在掉线状态'); return; }
    const age = s.offlineAt ? (Date.now()-s.offlineAt) : 0;
    if(age < OFFLINE_KICK_WAIT_MS){ socket.emit('toast','该玩家掉线未满 30 秒，还不能踢'); return; }
    clearOfflineKick(room, idx);
    logLine(room, `房主移出掉线的 ${s.name}`);
    room.recentKicks = (room.recentKicks || []).filter(k => Date.now()-k.at < 300000); // 只留 5 分钟内的
    room.recentKicks.push({ name: s.name, openid: s.openid || '', at: Date.now() });
    room.seats[idx]={type:'ai', name:'空位', avatar:'', openid:''};
    room.humanCount=Math.max(0, room.humanCount-1);
    if(room.humanCount===0) resetRoomSettings(room); // 房间无人：对局配置恢复默认
    room.ready[idx]=false;
    ensureValidHost(room);
    // 房间无人：不立即删除——30 分钟没人加入再由闲置计时解散（常驻房 LOVE/HOME 永不删）
    if(room.humanCount===0 && !isPreserve(room.code)) scheduleIdleKick(room);
    else broadcast(room);
  });

  // 主动退出房间（对局中视作掉线保留座位；未开局才真正退出）
  on('leave', ()=>{
    if(!room || mySeat<0){ return; }
    const seatIdx=mySeat;
    const r=room;
    // 座位归属以 socketId 为准：被顶替/换座后的闭包残留不应再对该房动作（否则会误把现任标记离线/移走）
    if(!(r.seats[seatIdx] && r.seats[seatIdx].socketId===socket.id)){
      room=null; mySeat=-1;
      socket.data.room=null; socket.data.seat=-1;
      return;
    }
    clearEndVote(r); // 有人退出：进行中的共识表决作废
    // 对局进行中（本局未结束，含确认轮）：点退出视作掉线（保留座位，等重连）
    if(r.G && !r.G.ended){
      logLine(r, `${r.seats[seatIdx].name} 退出（对局中，视作掉线等待重连）`);
      r.seats[seatIdx].offline=true;
      r.seats[seatIdx].offlineAt=Date.now();
      cancelTakeoverAsk(r, seatIdx, '对方已离开，顶替请求作废');
      socket.leave(r.code);
      room=null; mySeat=-1;
      socket.data.room=null; socket.data.seat=-1;
      broadcast(r);
      return;
    }
    // 局末（非末局，等大家点【下一局】）：不允许直接退出，只能【结束场次】提前收场；
    // 要中途离开先进【结束场次】收场（AI 房同样适用：在线真人共识即生效）
    if(r.G && r.G.ended && !r.seriesOver){
      socket.emit('toast','本局尚未结束，请点【提前结束】');
      return;
    }
    const leftName = r.seats[seatIdx].name;
    logLine(r, `${leftName} 退出房间`);
    cancelTakeoverAsk(r, seatIdx, '对方已离开房间，顶替请求作废');
    // 退出后座位显示「空位」（不是 AI 接管）：ai 类型只是"可被新玩家加入"的标记
    r.seats[seatIdx]={type:'ai', name:'空位', avatar:'', openid:''};
    r.humanCount=Math.max(0,r.humanCount-1);
    if(r.humanCount===0) resetRoomSettings(r); // 房间无人：对局配置恢复默认
    // 最后一位在线玩家退出：清空残局 G（牌局信息）。
    // 普通房随后解散无影响；常驻房（LOVE/HOME）不删，残局一并清除，
    // 避免"场末退出后再进房仍显示上一场的牌局信息"。
    if(r.humanCount===0 && r.G) r.G=null;
    r.ready[seatIdx]=false;
    socket.leave(r.code);
    room=null; mySeat=-1;
    socket.data.room=null; socket.data.seat=-1;
    // 房主卫生：在线真人在 → 移交最少号在线真人（原逻辑）；否则悬空(-1)，不能落在 AI/离线座
    ensureValidHost(r);
    // 房间无人：不立即删除——30 分钟没人加入再由闲置计时解散（常驻房 LOVE/HOME 永不删）
    if(r.humanCount===0 && !isPreserve(r.code)){ scheduleIdleKick(r); }
    else broadcast(r);
  });

  // 删除房间（房主可删自己的房间）
  // 删除房间：未开局房间任意可删；已开局仅房主可删
  on('deleteRoom', (data)=>{ if(!permit(socket,'deleteRoom')) return;
    const code = roomCodeOf(data && data.code);
    if(!code){ socket.emit('toast','房间号需为 4 位字母或数字'); return; }
    if(isPreserve(code)){ socket.emit('toast', `${code} 是常驻房间，不能删除`); return; }
    const r=rooms.get(code);
    if(!r){ socket.emit('toast','房间不存在'); return; }
    // 决策 B：无论是否开局（含确认轮、未开局），仅房主可删；
    // 归属以 socketId 为准（被顶替/换座后的闭包残留即使 mySeat===hostSeat 也不放行）
    if(!room || room!==r || !(mySeat===room.hostSeat
       && room.seats[mySeat] && room.seats[mySeat].socketId===socket.id)){
      socket.emit('toast','仅房主可删除');
      return;
    }
    // 清房：结束表决/闲置与离线计时器/aiTimer，并清理其他成员绑定（防闭包盯住已删房间、旧 aiTimer 串房）
    clearEndVote(r); clearIdleKick(r); clearAllOfflineKicks(r); clearAllTakeoverAsks(r);
    if(r.aiTimer){ clearTimeout(r.aiTimer); r.aiTimer=null; }
    io.to(r.code).emit('roomClosed');
    rooms.delete(code);
    const memberIds=io.sockets.adapter.rooms.get(r.code)||[];
    for(const id of memberIds){
      const so=io.sockets.sockets.get(id);
      if(so){ so.data.room=null; so.data.seat=-1; }
    }
    for(const id of memberIds){
      const so=io.sockets.sockets.get(id);
      if(so){ try{ so.disconnect(true); }catch(e){} }
    }
    socket.data.room=null; socket.data.seat=-1;
  });

  // 断线
  on('disconnect', ()=>{
    if(!room || mySeat<0) return;
    clearEndVote(room); // 有人在表决中掉线：共识作废
    const seat = room.seats[mySeat];
    // 旧连接的迟到 disconnect（心跳检测有 ~10s 级延迟）：期间玩家已 rejoin、
    // 座位 socketId 已被新连接接管 → 忽略，不再把已重连的座位误标回 offline
    if(!seat || seat.socketId !== socket.id) return;
    seat.offline=true;
    seat.offlineAt=Date.now();
    cancelTakeoverAsk(room, mySeat, '对方已掉线，顶替请求作废');
    logLine(room, `${seat.name} 掉线，等待重连`);
    broadcast(room);
    // 未开局：超时（默认3分钟）后踢出座位；已开局则由掉线保留逻辑处理
    scheduleOfflineKick(room, mySeat);
  });
});

// 常驻房：固定存在，即使无人也不删除（启动时创建；listRooms 时也会兜底重建）
for(const code of PRESERVE_ROOMS) createRoom(code);

server.listen(PORT, ()=>{
  console.log(`通山打拱服务器已启动：http://0.0.0.0:${PORT}`);
  console.log(`本地访问：http://localhost:${PORT}`);
});
