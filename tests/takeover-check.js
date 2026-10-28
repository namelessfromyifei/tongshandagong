/* =========================================================
 * 座位顶替（重连接管）端到端检查
 * 规则（无需开局，规则与对局状态无关——未开局/局中/局末一致）：
 *   ✓ 本人路径不设门禁：微信本人(openid) / 客户端自动归位(auto:true) → 直接归位，不弹窗
 *   ✓ 手动重连·座位有人在线 → 推 takeoverAsk 给在位者：
 *       不同意 → 在位者继续游戏，请求方收 被拒 + 座位全局 10s 冷静期（二次重连被拦）
 *       同意   → 请求方再次 rejoin 完成接管，在位者收 displaced（清桌回大厅、退出房间广播）
 *       超时   → 请求作废（takeoverResult ok:false）
 *   ✓ 手动重连·座位掉线 < REJOIN_TAKEOVER_MS → 视为网络波动，拦截并提示等待；
 *       掉线 ≥ 窗口 → 直接接管
 *   ✓ 同意后请求方未完成归位 → 在位者收「对方未完成接管」提示后继续游戏
 *   ✓ 被顶者再次 rejoin 不再短路直进（残留闭包防护：走门禁弹窗而非秒进）
 *   ✓ 被顶者可正常建新房 / 加入他房（闭包残留自愈）
 * 运行：node tests/takeover-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18107;
const ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms){
  const t0 = Date.now();
  while(Date.now() - t0 < (ms || 8000)){
    if(fn()) return true;
    await wait(80);
  }
  return false;
}

let pass = 0, fail = 0;
function T(name, cond, extra){
  if(cond){ pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra!==undefined ? ' => ' + JSON.stringify(extra) : '')); }
}

function connect(port){
  return new Promise((res, rej) => {
    const c = io('http://127.0.0.1:' + port, { reconnection: false, transports: ['websocket'], timeout: 10000 });
    c.on('connect', () => res(c));
    c.on('connect_error', e => rej(e));
  });
}
// 带事件记录的客户端封装
function mk(port){
  return connect(port).then(c => {
    const cl = {
      c, lastSnap: null, joined: null, toasts: [],
      asks: 0, lastAsk: null, results: [], displaced: 0, _snapAt: null,
    };
    c.on('state', s => { cl.lastSnap = s; });
    c.on('joined', d => { cl.joined = d; });
    c.on('toast', m => { cl.toasts.push(String(m)); });
    c.on('takeoverAsk', d => { cl.asks++; cl.lastAsk = d || {}; });
    c.on('takeoverResult', d => { cl.results.push(d); });
    c.on('displaced', () => { cl.displaced++; cl._snapAt = cl.lastSnap; });
    return cl;
  });
}
// 等下一次 joined（无 joined 则在 ms 后返回 null）
function nextJoined(cl, ms){
  return new Promise(res => {
    const t = setTimeout(() => { cl.c.off('joined', h); res(null); }, ms || 6000);
    const h = d => { clearTimeout(t); cl.c.off('joined', h); res(d); };
    cl.c.on('joined', h);
  });
}
// 创建房间（甲），返回 {code, seat}
async function createRoomAs(A, name){
  let d = null;
  A.c.on('joined', dj => { d = dj; });
  A.c.emit('create', { name });
  await until(() => d, 8000);
  return d;
}

(async () => {
  // 短窗口/短超时加速跑：窗口2s、弹窗1.5s、同意后归位宽限3s、闲置/离线踢出 0
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), AI_TURN_MS: '60',
      ROOM_IDLE_KICK_MS: '0', OFFLINE_KICK_MS: '0',
      REJOIN_TAKEOVER_MS: '2000', TAKEOVER_ASK_MS: '1500', TAKEOVER_APPROVE_MS: '3000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += d.toString(); });
  srv.stderr.on('data', d => { out += d.toString(); });
  const startAt = Date.now();
  while(!/服务器已启动/.test(out) && Date.now() - startAt < 8000) await wait(120);

  const clients = [];
  const closeAll = () => clients.forEach(x => { try{ x.c.close(); }catch(e){} });

  try{
    // ---------- 场景一：在线·本人 auto 归位 → 直接接管、无弹窗，旧连接被干净移出 ----------
    {
      const A = await mk(PORT); clients.push(A);
      const roomA = await createRoomAs(A, '甲');
      const C = await mk(PORT); clients.push(C);
      C.c.emit('rejoin', { code: roomA.code, name: '甲', auto: true });
      const jd = await nextJoined(C, 4000);
      T('S1 auto归位直接成功（同座位）', !!(jd && jd.seat === roomA.seat), jd);
      await until(() => A.displaced >= 1, 3000);
      T('S1 旧连接收 displaced、且未弹窗', A.displaced === 1 && A.asks === 0, {displaced:A.displaced, asks:A.asks});
      A._snapAt = A.lastSnap;                       // 旧连接已移出房间：广播不再到达
      await new Promise(res => { C.c.on('joined', () => res()); C.c.emit('toggleReady', {}); setTimeout(res, 500); });
      wait; await wait(350);
      T('S1 旧连接不再收到房间广播', A.lastSnap === A._snapAt);
    }

    // ---------- 场景二：在线·手动 → 拒绝：被拒 + 座位全局 10s 冷静期 ----------
    {
      const A = await mk(PORT); clients.push(A);
      const roomB = await createRoomAs(A, '甲');
      const C = await mk(PORT); clients.push(C);
      C.c.emit('rejoin', { code: roomB.code, name: '甲' }); // 手动，无 auto → 不当即接管
      const askSeen = await until(() => A.asks >= 1, 3000);
      T('S2 手动重连·在线 → 不当即接管，在位者收 takeoverAsk', askSeen && C.joined === null, {asks:A.asks});
      A.c.emit('takeoverVote', { ok: false });
      const rejSeen = await until(() => C.results.some(r => r && r.ok === false && r.reason === '对方不同意顶替'), 3000);
      T('S2 请求方收被拒（对方不同意顶替）', rejSeen, C.results);
      C.toasts.length = 0;
      C.c.emit('rejoin', { code: roomB.code, name: '甲' }); // 冷静期内二次手动重连
      const coolSeen = await until(() => C.toasts.some(t => /不同意顶替|秒后再试/.test(t)), 3000);
      T('S2 10s 冷静期内二次手动重连被拦', coolSeen, C.toasts);
      T('S2 在位者未被动（仍在桌、无 displaced）', A.displaced === 0 && C.joined === null);
    }

    // ---------- 场景三：在线·手动 → 同意：请求方归位、在位者收 displaced 且退出广播 ----------
    {
      const A = await mk(PORT); clients.push(A);
      const roomC = await createRoomAs(A, '甲');
      const C = await mk(PORT); clients.push(C);
      C.c.emit('rejoin', { code: roomC.code, name: '甲' });
      const askSeen = await until(() => A.asks >= 1, 3000);
      T('S3 在位者收 takeoverAsk', askSeen);
      A.c.emit('takeoverVote', { ok: true });
      const okSeen = await until(() => C.results.some(r => r && r.ok === true), 3000);
      T('S3 请求方收「同意」并带归位信息', okSeen && C.results[C.results.length-1].code === roomC.code, C.results);
      C.c.emit('rejoin', { code: roomC.code, name: '甲' });  // 用同一连接再 rejoin 完成接管
      const jd = await nextJoined(C, 4000);
      T('S3 请求方 rejoin 完成接管（同座位）', !!(jd && jd.seat === roomC.seat), jd);
      const dispSeen = await until(() => A.displaced >= 1, 3000);
      T('S3 在位者收 displaced（清桌回大厅）', dispSeen);
      A._snapAt = A.lastSnap;                       // 被顶替连接已移出房间
      C.c.emit('toggleReady', {});
      await wait(350);
      T('S3 被顶替连接不再收到房间广播', A.lastSnap === A._snapAt);
    }

    // ---------- 场景四：在线·手动 → 超时(此处1.5s) 未回应作废 ----------
    {
      const A = await mk(PORT); clients.push(A);
      const roomD = await createRoomAs(A, '甲');
      const C = await mk(PORT); clients.push(C);
      C.c.emit('rejoin', { code: roomD.code, name: '甲' });
      await until(() => A.asks >= 1, 3000);
      const expireSeen = await until(() => C.results.some(r => r && r.ok === false), 4000);
      T('S4 未回应 → 顶替请求作废（ok:false）', expireSeen, C.results);
      T('S4 在位者仍在桌', A.displaced === 0);
    }

    // ---------- 场景五：掉线 < 窗口被拦 → 过窗口直接接管 ----------
    {
      const A = await mk(PORT); clients.push(A);
      const B = await mk(PORT); clients.push(B);
      const roomE = await createRoomAs(A, '甲');
      const bj = await new Promise(res => { B.c.on('joined', d => res(d)); B.c.emit('join', { code: roomE.code, name: '乙' }); setTimeout(() => res(null), 8000); });
      await until(() => !!(B.lastSnap && B.lastSnap.code === roomE.code), 3000);

      A.c.close(); // 真掉线（非保留退出）
      const offSeen = await until(() => B.lastSnap && B.lastSnap.seats[roomE.seat] && B.lastSnap.seats[roomE.seat].offline === true, 4000);
      T('S5 座位已标 offline', offSeen);

      const C = await mk(PORT); clients.push(C);
      C.toasts.length = 0;
      C.c.emit('rejoin', { code: roomE.code, name: '甲' }); // 掉线刚发生：窗口(2s)内
      const waveSeen = await until(() => C.toasts.some(t => /网络波动|秒后可重连/.test(t)), 3000);
      T('S5 掉线<窗口 → 不接管并提示「网络波动，约N秒后再试」', waveSeen, C.toasts);
      await wait(100);
      T('S5 窗口内未发生接管（无 joined）', C.joined === null);

      await wait(2200);                             // 越过窗口（REJOIN_TAKEOVER_MS=2000）
      C.c.emit('rejoin', { code: roomE.code, name: '甲' });
      const jd = await nextJoined(C, 4000);
      T('S5 掉线≥窗口 → 直接接管（同座位）', !!(jd && jd.seat === roomE.seat), jd);
      const bOk = await until(() => B.lastSnap && B.lastSnap.seats[roomE.seat] && B.lastSnap.seats[roomE.seat].offline === false, 3000);
      T('S5 B（另一真人）视角：座位已由新连接接管、offline 清除', bOk);
    }

    // ---------- 场景六：同意后请求方未完成归位 → 在位者继续游戏 ----------
    {
      const A = await mk(PORT); clients.push(A);
      const roomF = await createRoomAs(A, '甲');
      const C = await mk(PORT); clients.push(C);
      C.c.emit('rejoin', { code: roomF.code, name: '甲' });
      await until(() => A.asks >= 1, 3000);
      A.toasts.length = 0;
      A.c.emit('takeoverVote', { ok: true });
      await until(() => C.results.some(r => r && r.ok === true), 3000);
      // 请求方不再回来 → TAKEOVER_APPROVE_MS(3s) 后作废并通知在位者
      const giveUp = await until(() => A.toasts.some(t => /未完成接管/.test(t)), 7000);
      T('S6 请求方未完成接管 → 在位者收提示并继续', giveUp, A.toasts);
      T('S6 在位者未被顶（仍在桌）', A.displaced === 0);
    }

    // ---------- 场景七：被顶者再次 rejoin 不再短路直进（残留闭包防护） ----------
    // 复现用户报告：同意顶替→被顶回大厅→点自己房间行（rejoin）秒进 + tsRoom 重写→刷新又进。
    // 根因是 server 端被顶连接的闭包 room/mySeat 残留，rejoin 开头「已绑定→直接进桌」短路放行。
    {
      const A = await mk(PORT); clients.push(A);
      const r5 = await createRoomAs(A, '甲');
      const R = await mk(PORT); clients.push(R);
      // 预置一次正常顶替：R 手动重连 → A 同意 → R 接管、A 被顶
      R.c.emit('rejoin', { code: r5.code, name: '甲' });
      await until(() => A.asks >= 1, 3000);
      A.c.emit('takeoverVote', { ok: true });
      await until(() => R.results.some(x => x && x.ok === true), 3000);
      R.c.emit('rejoin', { code: r5.code, name: '甲' });
      const jdR = await nextJoined(R, 4000);
      T('S7 预置：R 完成接管（甲座）', !!(jdR && jdR.seat === r5.seat), jdR);
      const dispA = await until(() => A.displaced >= 1, 3000);
      T('S7 预置：A 被顶（收到 displaced）', dispA);
      const A0join = A.joined; // create 建房时的 joined 引用：之后不应被新的 rejoin/接管改动

      // ★ 被顶者 A 用其旧连接再次 rejoin 同房同座 —— 修复前会走残留闭包短路秒进
      A.c.emit('rejoin', { code: r5.code, name: '甲' });
      const jdA = await nextJoined(A, 600);
      T('S7 被顶者再 rejoin 不再短路直进', jdA === null, jdA);
      const rAsk = await until(() => R.asks >= 1, 2500); // 现任 R 在线 → 门禁弹窗落给 R
      T('S7 现任(R)收到 takeoverAsk（走门禁而非短路）', rAsk, {asks:R.asks});
      R.c.emit('takeoverVote', { ok: false });
      const rejA = await until(() => A.results.some(x => x && x.ok === false), 2000);
      T('S7 现任拒绝 → 被顶者收被拒、仍未归位', rejA && A.joined === A0join, A.results);
      T('S7 现任未被顶（R.displaced=0，仍持座）', R.displaced === 0);
    }

    // ---------- 场景八：被顶者可正常建新房 / 加入他房（闭包残留自愈） ----------
    {
      // 8a：被顶者「建新房」——修复前残留闭包会报「你已在房间中」
      const A = await mk(PORT); clients.push(A);
      const r6 = await createRoomAs(A, '甲');
      const Ra = await mk(PORT); clients.push(Ra);
      Ra.c.emit('rejoin', { code: r6.code, name: '甲' });
      await until(() => A.asks >= 1, 3000);
      A.c.emit('takeoverVote', { ok: true });
      await until(() => Ra.results.some(x => x && x.ok === true), 3000);
      Ra.c.emit('rejoin', { code: r6.code, name: '甲' });
      await nextJoined(Ra, 4000);
      const d8a_disp = await until(() => A.displaced >= 1, 3000);
      T('S8a 预置：A 已被顶替', d8a_disp);

      let d8a = null;
      A.c.on('joined', dj => { d8a = dj; });
      A.c.emit('create', { name: '戊', settings: {} });
      await until(() => d8a, 8000);
      T('S8a 被顶者可正常建房（闭包自愈，非「你已在房间中」）', !!(d8a && d8a.code && d8a.code !== r6.code), d8a);

      // 8b：另一被顶者「加入他房」——修复前同样被残留闭包挡
      const B = await mk(PORT); clients.push(B);
      const r7 = await createRoomAs(B, '乙');
      const Rb = await mk(PORT); clients.push(Rb);
      Rb.c.emit('rejoin', { code: r7.code, name: '乙' });
      await until(() => B.asks >= 1, 3000);
      B.c.emit('takeoverVote', { ok: true });
      await until(() => Rb.results.some(x => x && x.ok === true), 3000);
      Rb.c.emit('rejoin', { code: r7.code, name: '乙' });
      await nextJoined(Rb, 4000);
      const d8b_disp = await until(() => B.displaced >= 1, 3000);
      T('S8b 预置：B 已被顶替', d8b_disp);

      let d8b = null;
      B.c.on('joined', dj => { d8b = dj; });
      B.c.emit('join', { code: r6.code, name: '辛' }); // 加入已被 Ra 占 0 号座的 r6（未开局有空座）
      await until(() => d8b, 8000);
      T('S8b 被顶者可正常加入他房（闭包自愈）', !!(d8b && d8b.code === r6.code && d8b.seat >= 0), d8b);
    }

  }catch(e){
    console.log('运行异常：', e && e.stack ? e.stack : e);
    fail++;
  }finally{
    closeAll();
    srv.kill();
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();