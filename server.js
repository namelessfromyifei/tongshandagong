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
const { Server } = require('socket.io');
const TS = require('./js/engine.js');
const TSAI = require('./js/ai.js');

const PORT = process.env.PORT || 8080;
// 牌局结束后房间闲置超时自动解散（毫秒）；设为 0 可关闭。默认 5 分钟。
const IDLE_KICK_MS = Number(process.env.ROOM_IDLE_KICK_MS || 5*60*1000);
// 未开局时真人掉线超过该时长（毫秒）→ 踢出座位还原为 AI；默认 3 分钟。
const OFFLINE_KICK_MS = Number(process.env.OFFLINE_KICK_MS || 3*60*1000);
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

const app = express();
app.set('trust proxy', 1); // 反向代理（Nginx）下正确识别 https
const server = http.createServer(app);
// 缩短心跳，断线更快被发现（默认 ping 约 25s）
const io = new Server(server, { pingInterval: 5000, pingTimeout: 5000, cors: { origin: '*' } });

/* ---------- CORS：Android App 从 https://localhost 读取 API ----------
 * App 的页面在本地资源包里，origin 是 https://localhost，与本站不同源。
 * App 不使用 Cookie（身份走手动昵称），所以允许 * 且不带凭据即可。
 * 浏览器端同源访问，不受影响。 */
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if(req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
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
  res.set('Cache-Control', 'no-store').json({
    enabled: WX_ENABLED,
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
    settings: {         // 牌局设置（房主可调）
      rounds: 3,        // 一轮打多少局
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
// 配置锁定：只要当前这一局已开始且尚未结束（含发牌/确认/出牌），所有设置不可改；
// 未开局（G 为空）或本局已结束（G.ended）时可改。
function configLocked(room){
  return !!(room.G && !room.G.ended);
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
    seats: room.seats.map(s=>({name:s.name, type:s.type, offline:!!s.offline, avatar:s.avatar||'', humanCount:room.humanCount})),
    seriesOver: !!room.seriesOver, // 本场已结束：G 仍保留（牌桌冻结），等玩家准备开下一场
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
function snapshotFor(room, seatIdx){
  const snap = snapshot(room);
  const G = room.G;
  snap.G = G ? maskGame(G, seatIdx) : null;
  snap.youArePartner = !!(G && seatIdx>=0 && G.partner===seatIdx);
  if(G && G.ended && room.lastSettle) snap.settle = room.lastSettle;
  return snap;
}
// 按接收者分发脱敏快照：入座者拿本人视角，游离 socket 拿公共视角（全隐藏）
function broadcast(room){
  const seats=room.seats;
  const memberIds=io.sockets.adapter.rooms.get(room.code)||[];
  for(const id of memberIds){
    const so=io.sockets.sockets.get(id);
    if(!so) continue;
    let seatIdx=-1;
    for(let i=0;i<4;i++){ if(seats[i] && seats[i].socketId===id){ seatIdx=i; break; } }
    so.emit('state', snapshotFor(room, seatIdx));
  }
}
/* ---------- 提前结束本场（全真人房共识表决） ----------
 * 规则（决策 A 修订版）：一场未结束时任何人不可被动踢；"场进行中"可经全体真人共识提前收场。
 * 发起：任何在房真人；其余三人各一票，全部同意才生效；任一人反对或 30 秒未全票 → 作废。
 * 生效：以已完成局累计收场；若请求时局中，本局直接废弃不计分；随后进入"本场结束"冻结态。
 * 仅全真人房（无 AI 座位、无人掉线）可发起。 */
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
  room.G = null;                                        // 废弃当前局：牌桌不留残局
  room.series.active=false; room.series.roundCount=0; room.series.totals=[0,0,0,0]; room.series.lastRound=null;
  room.ready=[false,false,false,false];
  room.seriesOver=true;
  clearAllOfflineKicks(room); clearIdleKick(room);
  scheduleIdleKick(room);                               // 场结束后可闲置解散
  broadcast(room);
}
/* ---------- 应变：本地房间码列表（LOVE/HOME 等常驻房不可删除、不闲置解散） ---------- */
const PRESERVE_ROOMS = new Set(['LOVE','HOME']);
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
  if(!room || !room.offlineTimers || !(OFFLINE_KICK_MS>0)) return;
  clearOfflineKick(room, seatIdx);
  // 一场（可能多局）未结束时不可踢人：对局中/局间掉线一律保留座位等重连；一场结束后才允许踢。
  if(room.G && !room.seriesOver) return;
  room.offlineTimers[seatIdx]=setTimeout(()=>{
    delete room.offlineTimers[seatIdx];
    // 房间已删/同号被替换 → 忽略
    if(rooms.get(room.code)!==room) return;
    // 场进行中 → 不再踢（转为等待重连）
    if(room.G && !room.seriesOver) return;
    const s=room.seats[seatIdx];
    if(!s || s.type!=='human' || !s.offline) return; // 已重连/已离开则作罢
    // 未开局掉线超时：直接踢出（座位恢复为空位，可被新玩家加入；不当作 AI 处理）
    logLine(room, `${s.name} 未开局掉线超时，已移出房间`);
    const wasHost = (seatIdx===room.hostSeat);
    room.seats[seatIdx]={type:'ai', name:'空位', avatar:'', openid:''}; // "空位"：未加入玩家，ai 类型仅为可被 join 替换的标记
    room.humanCount=Math.max(0, room.humanCount-1);
    room.ready[seatIdx]=false;
    // 房主掉线被踢：hostSeat 移交给剩余真人中座位号最小者（不再物理挪座位）
    if(wasHost && room.humanCount>0){
      for(let j=0;j<4;j++){
        if(room.seats[j].type==='human'){
          room.hostSeat=j;
          const s2=io.sockets.sockets.get(room.seats[j].socketId);
          if(s2){ s2.emit('promotedHost', {hostSeat:j}); }
          logLine(room, `${room.seats[j].name} 成为房主`);
          break;
        }
      }
    }
    // 房间无人时自动删除（常驻房除外）
    if(room.humanCount===0 && !isPreserve(room.code)){ clearIdleKick(room); rooms.delete(room.code); }
    else broadcast(room);
  }, OFFLINE_KICK_MS);
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
  room.series.active=false; room.series.roundCount=0; room.series.totals=[0,0,0,0]; room.series.lastRound=null; // 新的一场：累计/轮数归零
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
    logLine(room, `  累计：${room.seats.map((se,i)=>`${se.name} ${room.series.totals[i]>0?'+':''}${room.series.totals[i]}分`).join('｜')}`);
    room.series.active=false; room.series.lastRound=null;
    // 累计/轮数保留：冻结屏与计分板继续显示最终累计；新的一场开始时由 startRound 归零
    room.ready=[false,false,false,false]; // 准备重置，下场比赛重新准备
    // 本场结束不清 G：保留最后一局的牌桌，等玩家点【准备】开下一场时再换新局
    room.seriesOver=true;
  } else {
    // 非最后一局：等所有玩家点【下一局】就绪后自动开下一局
    room.ready=[false,false,false,false];
    logLine(room, `请各玩家点击【下一局】就绪，全员就绪自动开下一局`);
  }
  broadcast(room);
  // 牌局结束后开始闲置计时：超时仍未退出则自动解散房间
  scheduleIdleKick(room);
  // 不自动开下一局，等所有玩家就绪
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
  on('listRooms', ()=>{
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

  on('create', (data)=>{
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
    // 房主可带初始设置
    if(data.settings) r.settings=Object.assign(r.settings, data.settings);
    room=r; mySeat=seatIdx;
    socket.data.room=r; socket.data.seat=seatIdx;
    socket.join(r.code);
    // 创建后房主直接进牌桌（房间仍在列表，其他玩家可加入）
    socket.emit('joined', {code:r.code, seat:seatIdx, name, avatar:ident.avatar});
    broadcast(r);
    socket.emit('toast', `已创建房间 ${r.code}，等待其他玩家加入`);
  });

  // 房主调整牌局设置
  on('setSettings', (data)=>{
    if(!room || mySeat!==room.hostSeat){ socket.emit('toast','只有房主能设置'); return; }
    if(configLocked(room)){ socket.emit('toast','对局进行中，设置已锁定'); return; }
    data = data||{};
    const s=room.settings;
    if(data.rounds!=null){ const n=Number(data.rounds); if(n>=1&&n<=20) s.rounds=Math.floor(n); }
    if(data.showRemain!=null) s.showRemain=!!data.showRemain;
    if(data.showCorner!=null) s.showCorner=!!data.showCorner;
    if(data.showLog!=null) s.showLog=!!data.showLog;
    if(data.kings!=null) s.kings=[8,10,12].includes(Number(data.kings))?Number(data.kings):8;
    if(data.jokerValue!=null) s.jokerValue=Number(data.jokerValue)===2?2:3;
    if(data.tailBonus!=null) s.tailBonus=!!data.tailBonus;
    if(data.fanCap!=null){ const n=Number(data.fanCap); s.fanCap=[32,64,128,0].includes(n)?n:32; }
    if(data.halfFan!=null){ const n=Math.round(Number(data.halfFan)); s.halfFan=Math.min(50,Math.max(1,n||1)); }
    if(data.aiFill!=null) room.aiFill=!!data.aiFill;
    if(data.aiAuto!=null) s.aiAuto=!!data.aiAuto;
    // 点【开始对局】：房主自己也准备，已就绪的真人 + AI 补位即可立即开局
    const wantStart = (data.start===true);
    if(wantStart) room.ready[room.hostSeat]=true;  // 房主自己标记准备（hostSeat 与座位 0 解耦）
    broadcast(room);
    if(wantStart){
      const started=checkAllReady(room);
      socket.emit('toast', started? '开始对局！' : '已准备，等待其他玩家就绪后开局');
    } else {
      socket.emit('toast','牌局设置已更新');
    }
  });

  on('join', (data)=>{
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
    // 找空座位（真人空位或 AI 位）
    let seatIdx=r.seats.findIndex(s=>s.type==='ai');
    if(seatIdx<0){ socket.emit('toast','房间已满'); return; }
    r.seats[seatIdx]={type:'human', socketId:socket.id, name, avatar:ident.avatar, openid:ident.openid, offline:false};
    r.humanCount++;
    room=r; mySeat=seatIdx;
    socket.data.room=r; socket.data.seat=seatIdx;
    socket.join(r.code);
    socket.emit('joined', {code:r.code, seat:seatIdx, name, avatar:ident.avatar});
    broadcast(r);
    socket.emit('toast', `已加入房间 ${r.code}，你是第 ${r.humanCount} 位玩家`);
  });

  // 重连：房间号 + 玩家姓名 归位
  on('rejoin', (data)=>{
    data=data||{};
    const code = roomCodeOf(data && data.code);
    const name=(data.name||'').trim();
    if(!wxSession && !name){ socket.emit('toast','请输入昵称'); return; }
    if(!code){ socket.emit('toast','房间号需为 4 位字母或数字'); return; }
    // 若本 socket 已绑定房间：直接确认进桌（创建后点自己的房间进入）
    if(room){
      if(room.code===code){
        const me=room.seats[mySeat];
        socket.emit('joined', {code:room.code, seat:mySeat, name:me.name, avatar:me.avatar||''});
        broadcast(room);
        return;
      }
      socket.emit('toast','你已在其他房间');
      return;
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
      const wxSeat=r.seats.some(s=>s.type==='human' && s.openid && s.name===ident.name);
      socket.emit('toast', wxSeat ? '该座位已绑定微信，请先完成微信授权再重连' : '未找到与你身份匹配的座位');
      return;
    }
    const seat=r.seats[seatIdx];
    seat.socketId=socket.id;
    seat.offline=false;
    seat.name=ident.name;
    seat.avatar=ident.avatar;
    if(ident.openid) seat.openid=ident.openid;
    clearOfflineKick(r, seatIdx); // 重连成功：取消未开局掉线踢出计时器
    room=r; mySeat=seatIdx;
    socket.data.room=r; socket.data.seat=seatIdx;
    socket.join(r.code);
    socket.emit('joined', {code:r.code, seat:seatIdx, name:seat.name, avatar:seat.avatar||''});
    broadcast(r);
    socket.emit('toast', `重连成功，你坐回 ${seat.name}`);
  });

  // 房主切换 AI 补位
  on('toggleAI', ()=>{
    if(!room) return;
    if(mySeat!==room.hostSeat){ socket.emit('toast','只有房主能设置'); return; }
    if(configLocked(room)){ socket.emit('toast','对局进行中，设置已锁定'); return; }
    room.aiFill = !room.aiFill;
    socket.emit('toast', `AI 补位已${room.aiFill?'开启':'关闭'}`);
    broadcast(room);
  });

  // 玩家准备/取消准备（对局配置由房主在弹窗调整；全员准备后自动开局）
  on('toggleReady', ()=>{
    if(!room || (room.G && !room.seriesOver)) return;
    if(mySeat<0 || room.seats[mySeat].type!=='human') return;
    room.ready[mySeat]=!room.ready[mySeat];
    socket.emit('toast', room.ready[mySeat]?'已准备':'已取消准备');
    checkAllReady(room);
  });

  // 开局（房主点击"对局配置"后由设置弹窗确认，不再直接 start；保留 start 兼容）
  on('start', ()=>{
    if(!room) return;
    if(room.G && !room.seriesOver) return;
    if(!room.aiFill && room.humanCount<4){
      socket.emit('toast', `AI补位未开，还差 ${4-room.humanCount} 位真人才能开始；或先开启AI补位`);
      return;
    }
    startRound(room);
  });

  on('nextRound', ()=>{
    if(!room || !room.G || !room.G.ended) return; // 上一局尚未结束时忽略
    if(mySeat<0 || room.seats[mySeat].type!=='human') return;
    room.ready[mySeat]=true;
    socket.emit('toast','已就绪，等待其他玩家');
    checkAllReady(room);
  });

  // 玩家动作
  on('act', (data)=>{
    if(!room || !room.G) return;
    data = data||{};
    const seatIdx=Number(data.seat);
    if(!Number.isInteger(seatIdx) || seatIdx!==mySeat){ socket.emit('toast','不是你的座位'); return; }
    if(room.G.ended) return; // 已结束：重复/迟到的 act 一律忽略（防二次结算）
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
  on('endSeries', ()=>{
    if(!room) return;
    if(!seriesInProgress(room)){ socket.emit('toast','当前没有进行中的本场'); return; }
    if(room.endVote){ socket.emit('toast','已有人发起提前结束，请先表决'); return; }
    if(mySeat<0 || room.seats[mySeat].type!=='human') return;
    for(let i=0;i<4;i++){
      const st=room.seats[i];
      if(st.type!=='human' || st.offline){ socket.emit('toast','需要 4 位在线真人才能提前结束本场'); return; }
    }
    room.endVote={ requester:mySeat, agree:new Set([mySeat]), timer:null };
    room.endVote.timer=setTimeout(()=>{
      if(room && room.endVote) cancelEndVote(room, '提前结束表决超时（30 秒内未全票同意），请求作废');
    }, END_VOTE_MS);
    logLine(room, `${room.seats[mySeat].name} 发起【提前结束本场】，请其他玩家在 30 秒内表决`);
    io.to(room.code).emit('endSeriesAsk', {requester:mySeat, name:room.seats[mySeat].name});
    broadcast(room);
  });

  // 提前结束本场：其他三人表决
  on('endSeriesVote', (data)=>{
    if(!room || !room.endVote || mySeat<0) return;
    if(mySeat===room.endVote.requester){ socket.emit('toast','你是发起方，等待其他人表决'); return; }
    const st=room.seats[mySeat];
    if(st.type!=='human' || st.offline) return;
    if(room.endVote.agree.has(mySeat)){ socket.emit('toast','你已表决'); return; }
    if(!(data && data.vote)){ cancelEndVote(room, `${st.name} 不同意，提前结束请求作废`); return; }
    room.endVote.agree.add(mySeat);
    logLine(room, `${st.name} 同意提前结束`);
    if(room.endVote.agree.size>=4) finalizeEndSeries(room);
    else broadcast(room);
  });

  // 主动退出房间（对局中视作掉线保留座位；未开局才真正退出）
  on('leave', ()=>{
    if(!room || mySeat<0){ return; }
    const seatIdx=mySeat;
    const r=room;
    clearEndVote(r); // 有人退出：进行中的共识表决作废
    // 对局已创建（含确认轮）：点退出视作掉线（保留座位，等重连）
    if(r.G){
      logLine(r, `${r.seats[seatIdx].name} 退出（对局中，视作掉线等待重连）`);
      r.seats[seatIdx].offline=true;
      socket.leave(r.code);
      room=null; mySeat=-1;
      socket.data.room=null; socket.data.seat=-1;
      broadcast(r);
      return;
    }
    logLine(r, `${r.seats[seatIdx].name} 退出房间`);
    const wasHost = (seatIdx===r.hostSeat);
    r.seats[seatIdx]={type:'ai', name:['A家','B家','C家','D家'][seatIdx], avatar:'', openid:''};
    r.humanCount=Math.max(0,r.humanCount-1);
    r.ready[seatIdx]=false;
    socket.leave(r.code);
    room=null; mySeat=-1;
    socket.data.room=null; socket.data.seat=-1;
    // 房主退出：hostSeat 移交给剩余真人中座位号最小者（不再物理挪座位）
    if(wasHost && r.humanCount>0){
      for(let j=0;j<4;j++){
        if(r.seats[j].type==='human'){
          r.hostSeat=j;
          const s=io.sockets.sockets.get(r.seats[j].socketId);
          if(s){ s.emit('promotedHost', {hostSeat:j}); }
          logLine(r, `${r.seats[j].name} 成为房主`);
          break;
        }
      }
    }
    // 房间无人时自动删除（常驻房 LOVE/HOME 除外）
    if(r.humanCount===0 && !isPreserve(r.code)){ clearIdleKick(r); rooms.delete(r.code); }
    else broadcast(r);
  });

  // 删除房间（房主可删自己的房间）
  // 删除房间：未开局房间任意可删；已开局仅房主可删
  on('deleteRoom', (data)=>{
    const code = roomCodeOf(data && data.code);
    if(!code){ socket.emit('toast','房间号需为 4 位字母或数字'); return; }
    if(isPreserve(code)){ socket.emit('toast', `${code} 是常驻房间，不能删除`); return; }
    const r=rooms.get(code);
    if(!r){ socket.emit('toast','房间不存在'); return; }
    // 决策 B：无论是否开局（含确认轮、未开局），仅房主可删
    if(!room || room!==r || mySeat!==room.hostSeat){ socket.emit('toast','仅房主可删除'); return; }
    // 清房：结束表决/闲置与离线计时器/aiTimer，并清理其他成员绑定（防闭包盯住已删房间、旧 aiTimer 串房）
    clearEndVote(r); clearIdleKick(r); clearAllOfflineKicks(r);
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
    room.seats[mySeat].offline=true;
    logLine(room, `${room.seats[mySeat].name} 掉线，等待重连`);
    broadcast(room);
    // 未开局：超时（默认3分钟）后踢出座位；已开局则由掉线保留逻辑处理
    scheduleOfflineKick(room, mySeat);
  });
});

// 常驻房 LOVE：作为常用房间，固定存在，即使无人也不删除
createRoom('LOVE');
// 常驻房 HOME：第二个固定房间（供群友联机/测试用），同样不删除
createRoom('HOME');

server.listen(PORT, ()=>{
  console.log(`通山打拱服务器已启动：http://0.0.0.0:${PORT}`);
  console.log(`本地访问：http://localhost:${PORT}`);
});
