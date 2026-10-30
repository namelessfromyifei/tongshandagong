/* =========================================================
 * 通山打拱 · 房主机制（hostSeat）端到端检查（决策 B + 统一成员绑定）
 * ✓ hostSeat 与座位解耦：房主退出 → 席位不挪动、hostSeat 移交给最小真人座位
 * ✓ 设置/删房仅房主可操作；非房主被拒
 * ✓ 退房后旧 socket 可重新建房（修复“你已在房间中”死锁）
 * ✓ 房主删房：全员收到 roomClosed 并断开（清理闭包与计时器）
 * 运行：node tests/host-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18102;
const ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

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
async function until(fn, ms){
  const t0 = Date.now();
  while(Date.now() - t0 < (ms || 6000)){
    if(fn()) return true;
    await wait(80);
  }
  return false;
}
// 先注册监听，稍后 emit —— 返回 [约定joined的promise, 注册器]
function joiner(c){
  return new Promise(res => { c.on('joined', d => res(d)); });
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), ROOM_IDLE_KICK_MS: '0', OFFLINE_KICK_MS: '0', DB_PATH: ':memory:' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += d.toString(); });
  srv.stderr.on('data', d => { out += d.toString(); });
  const startAt = Date.now();
  while(!/服务器已启动/.test(out) && Date.now() - startAt < 8000) await wait(120);

  const cl = [];
  try{
    for(let i=0;i<3;i++){
      const c = await connect(PORT);
      cl.push({ c, seat:-1, lastSnap:null, toasts:[], promoted:0, closed:0 });
      c.on('state', snap => { cl[i].lastSnap = snap; });
      c.on('toast', m => { cl[i].toasts.push(String(m)); });
      c.on('promotedHost', () => { cl[i].promoted++; });
      c.on('roomClosed', () => { cl[i].closed++; });
    }

    // 建房 + 加入（顺序：先注册监听，再 emit）
    let roomCode='';
    const p0 = joiner(cl[0].c);
    cl[0].c.emit('create', { name:'甲' });
    const j0 = await p0;
    roomCode = j0.code; cl[0].seat = j0.seat;
    T('房主建房入座（seat 0）', j0.seat===0);

    const p1 = joiner(cl[1].c);
    cl[1].c.emit('join', { code: roomCode, name:'乙' });
    const j1 = await p1; cl[1].seat = j1.seat;
    const p2 = joiner(cl[2].c);
    cl[2].c.emit('join', { code: roomCode, name:'丙' });
    const j2 = await p2; cl[2].seat = j2.seat;
    T('三人入房', j1.seat>=0 && j2.seat>=0 && new Set([j0.seat,j1.seat,j2.seat]).size===3);

    const inRoom = await until(() => cl.every(x => x.lastSnap && x.lastSnap.code===roomCode));
    T('三方都收到同房快照（hostSeat=0）', inRoom && cl.every(x => x.lastSnap.hostSeat===0));

    // —— 非房主操作被拒 ——
    cl[1].toasts.length = 0;
    cl[1].c.emit('setSettings', { rounds:1 });
    await wait(250);
    T('非房主 setSettings 被拒', cl[1].toasts.some(t => /只有房主/.test(t)));
    cl[1].toasts.length = 0;
    cl[1].c.emit('toggleAI');
    await wait(250);
    T('非房主 toggleAI 被拒', cl[1].toasts.some(t => /只有房主/.test(t)));

    // —— 房主退出 → hostSeat 移交给最小真人座位，座位不挪 ——
    cl[0].c.emit('leave');
    const promoted = await until(() => cl[1].promoted > 0);
    T('新房主收到 promotedHost', promoted);
    const hostMoved = await until(() => cl.some(x => x.lastSnap && x.lastSnap.hostSeat===1));
    T('hostSeat 移交给座位 1', hostMoved);
    T('座位未物理挪动（乙仍在座位1，甲的空位在座位0）', !!cl[1].lastSnap && cl[1].lastSnap.seats[1].name==='乙' && cl[1].lastSnap.seats[0].type==='ai');

    // —— 新房主可设置 ——
    cl[1].toasts.length = 0;
    cl[1].c.emit('setSettings', { rounds:1 });
    await wait(350);
    T('新房主 setSettings 生效', cl[1].toasts.some(t => /已更新/.test(t)) && cl.some(x => x.lastSnap && x.lastSnap.settings.rounds===1));

    // —— 旧房主（已退房）能重新建房：修复“你已在房间中”死锁 ——
    const pn = joiner(cl[0].c);
    cl[0].c.emit('create', { name:'甲2' });
    const nj = await pn;
    T('旧房主退出后可重新建房', !!(nj && nj.code && nj.seat===0));

    // —— 删房：非房主被拒；房主可删；其他房间不受影响 ——
    cl[2].toasts.length = 0;
    cl[2].c.emit('deleteRoom', { code: roomCode });
    await wait(300);
    T('非房主 deleteRoom 被拒', cl[2].toasts.some(t => /仅房主/.test(t)));
    cl[1].c.emit('deleteRoom', { code: roomCode });
    const closed = await until(() => cl[1].closed>0 && cl[2].closed>0);
    T('房主删房：全员收到 roomClosed 并断连', closed);
    T('其他房间不受影响（甲的新房仍在）', cl[0].closed===0 && cl[0].lastSnap && cl[0].lastSnap.code===nj.code);

    // —— 场景七：AI 补位/常驻房真人都退出后，房主不落在不存在的 AI 上 ——
    // 用户反馈：AI 补位房真人都退出后「房主」落到不存在的 AI（左上角如「房主：A家」）。
    // 目标规则：房主座卫生——真人退光后 hostSeat 悬空(-1)，新真人进来立即自动补位成房主。
    // 座位编排保证判别度：甲=0、乙=1；甲乙都退后（修复前 hostSeat 停在乙位=1，已是 AI），
    // 丙再加入落在 0 号空座 → 修复前 hostSeat=1(AI)≠丙位；修复后 join 自动补位 → hostSeat=丙位(真人)。
    {
      const L = 'LOVE'; // 常驻房：真人退光也不删除
      const hosts = [];
      for(let i=0;i<2;i++){
        const c = await connect(PORT);
        hosts.push({ c, seat:-1, lastSnap:null, toasts:[], promoted:0 });
        c.on('state', s => { hosts[i].lastSnap = s; });
        c.on('toast', m => { hosts[i].toasts.push(String(m)); });
        c.on('promotedHost', () => { hosts[i].promoted++; });
      }
      const pA = joiner(hosts[0].c);
      hosts[0].c.emit('join', { code:L, name:'甲' });  // seat0
      const jA = await pA; hosts[0].seat = jA.seat;
      const pB = joiner(hosts[1].c);
      hosts[1].c.emit('join', { code:L, name:'乙' }); // seat1
      const jB = await pB; hosts[1].seat = jB.seat;
      const initH = await until(() => hosts[1].lastSnap && hosts[1].lastSnap.code===L && hosts[1].lastSnap.hostSeat!=null, 5000);
      T('H7 甲、乙进常驻房：初始房主=0(甲)', initH && hosts[1].lastSnap.hostSeat===jA.seat,
        {hostSeat: hosts[1].lastSnap && hosts[1].lastSnap.hostSeat});

      // 甲（房主）退出 → 移交乙（在线真人）
      hosts[0].c.emit('leave');
      const rep = await until(() => hosts[1].lastSnap && hosts[1].lastSnap.hostSeat===jB.seat, 5000);
      T('H7 甲退出 → hostSeat 移交乙', rep, {hostSeat: hosts[1].lastSnap && hosts[1].lastSnap.hostSeat});

      // 乙（最后真人）退出 → 常驻房保留；此时不应有「房主=AI」
      hosts[1].c.emit('leave');
      await wait(400);
      const cN = await connect(PORT);
      const obs = { c:cN, seat:-1, lastSnap:null, toasts:[], promoted:0 };
      cN.on('state', s => { obs.lastSnap = s; });
      cN.on('toast', m => { obs.toasts.push(String(m)); });
      cN.on('promotedHost', () => { obs.promoted++; });
      const pC = joiner(cN);
      cN.emit('join', { code:L, name:'丙' }); // 落在空座 0
      const jC = await pC; obs.seat = jC.seat;
      const gotS = await until(() => obs.lastSnap && obs.lastSnap.code===L, 5000);
      const sp = obs.lastSnap;
      T('H7 丙进常驻空房 → 自动补位为房主（不在 AI 座）',
        gotS && sp.hostSeat===obs.seat
          && !!(sp.seats && sp.seats[sp.hostSeat]) && sp.seats[sp.hostSeat].type==='human',
        {hostSeat: sp && sp.hostSeat, seat: obs.seat,
         hsType: sp && sp.seats && sp.seats[sp.hostSeat] && sp.seats[sp.hostSeat].type});
      T('H7 丙收到房主提示（promotedHost 或「成为房主」）',
        obs.promoted>0 || obs.toasts.some(t => /房主/.test(t)));
      cN.emit('leave');
      await wait(200);
      cN.close();
      hosts.forEach(h => { h.c.close(); });
    }

  }catch(e){
    console.log('运行异常：', e && e.stack ? e.stack : e);
    fail++;
  }finally{
    cl.forEach(x => { try{ x.c.close(); }catch(e){} });
    srv.kill();
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();