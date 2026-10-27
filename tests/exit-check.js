/* =========================================================
 * 通山打拱 · 退出口径 / 离线顶替 / start 收权 端到端检查
 * ✓ AI 补位房（真人不足 4）局末放行走人；满员真人房局末退出被拦
 * ✓ 未开局 offline 真人座可被新玩家 join 顶替（座位沿用、人数不变、清 offline）
 * ✓ 非房主 start 被拒；房主 start 走全员就绪门槛仍可用
 * 运行：node tests/exit-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18105;
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

(async () => {
  // 短 AI 间隔加快打完；关闲置/离线踢出（保持 offline 座不被移出，供顶替测试）
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), AI_TURN_MS: '60', ROOM_IDLE_KICK_MS: '0', OFFLINE_KICK_MS: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += d.toString(); });
  srv.stderr.on('data', d => { out += d.toString(); });
  const startAt = Date.now();
  while(!/服务器已启动/.test(out) && Date.now() - startAt < 8000) await wait(120);

  const clients = [];
  try{
    for(let i=0;i<4;i++){
      const c = await connect(PORT);
      clients.push({ c, id:'c'+i, seat:-1, room:'', snaps:[], toasts:[] });
      c.on('state', snap => { clients[i].lastSnap = snap; clients[i].snaps.push(snap); });
      c.on('toast', m => { clients[i].toasts.push(String(m)); });
    }
    const cl = (i) => clients[i];

    // 自动应答：轮到自己就表态/过牌/跟最小牌，把对局推到底（同 mask-check 驱动）
    const wire = (i) => {
      clients[i].c.on('state', snap => {
        const me = clients[i].seat;
        const G = snap.G;
        if(!G || G.ended) return;
        if(G.confirming){
          if(G.turn === me && !(G.seats[me] && G.seats[me].choice)){
            clients[i].c.emit('act', { seat: me, type: 'confirm', choice: 'pass' });
          }
        } else if(G.turn === me && !G.seats[me].out){
          if(G.lastPlay) clients[i].c.emit('act', { seat: me, type: 'pass' });
          else {
            const h = G.seats[me].hand;
            if(h && h.length) clients[i].c.emit('act', { seat: me, type: 'play', cards: [h[h.length - 1]] });
          }
        }
      });
    };
    clients.forEach((_, i) => wire(i));

    const joinRoom = (i, code, name) => new Promise((res, rej) => {
      clients[i].c.on('joined', d => { clients[i].seat = d.seat; res(d); });
      clients[i].c.emit('join', { code, name });
      setTimeout(() => rej(new Error('join ' + name + ' 超时')), 8000);
    });

    // ---------- 场景一：AI 补位房（3 真人）局末放行走人 ----------
    let roomA = '';
    await new Promise((res, rej) => {
      clients[0].c.on('joined', d => { clients[0].seat = d.seat; roomA = d.code; res(); });
      clients[0].c.emit('create', { name: '甲' });
      setTimeout(() => rej(new Error('create 超时')), 8000);
    });
    await joinRoom(1, roomA, '乙');
    await joinRoom(2, roomA, '丙');
    // AI 补位 + 3 局场：c1/c2 就绪后房主开局（走 setSettings 路径）
    clients[1].c.emit('toggleReady', {});
    clients[2].c.emit('toggleReady', {});
    await wait(350);
    clients[0].c.emit('setSettings', { aiFill: true, rounds: 3, start: true });
    const r1Started = await until(() => clients.some(x => x.lastSnap && x.lastSnap.G && !x.lastSnap.G.ended && !x.lastSnap.seriesOver), 15000);
    T('AI 房开局成功（3 真人 + AI 补位）', r1Started);

    // 打第 1 局到「局末」（G.ended 且 seriesOver=false，round 1/3）
    const reachedGap = await until(() => clients.some(x => {
      const s = x.lastSnap; return s && s.G && s.G.ended && !s.seriesOver && s.series && s.series.roundCount >= 1;
    }), 60000);
    T('AI 房打到局末（round 1/3 结束）', reachedGap);

    // 局末：真人不足 4（3 人，1 AI 席）→ 允许退出
    clients[2].toasts.length = 0;
    const c2seat = clients[2].seat;
    clients[2].c.emit('leave');
    const leftOk = await until(() => clients.some(x => x.lastSnap
      && x.lastSnap.seats[c2seat].type === 'ai'
      && x.lastSnap.seats[c2seat].humanCount === 2), 8000); // humanCount 嵌在 seat 内
    T('AI 房局末退出放行（c2 离席，humanCount 3→2）', leftOk);
    T('AI 房局末退出未被拦（无【结束场次】toast）', !clients[2].toasts.some(t => /结束场次/.test(t)));

    // 收尾场景一：其余两人在不足 4 真人局末也能走 → 房间清空（大厅列表不再有 roomA）
    clients[0].c.emit('leave');
    clients[1].c.emit('leave');
    await wait(600);
    const lrA = await new Promise(res => { clients[0].c.once('rooms', r => res(r||[])); clients[0].c.emit('listRooms'); });
    T('AI 房全员退出后房间被清（不再出现在大厅列表）', !lrA.some(r => r.code === roomA));

    // ---------- 场景二：满员真人房 —— start 收权 + 局末退出拦截 ----------
    let roomB = '';
    await new Promise((res, rej) => {
      clients[0].c.on('joined', d => { clients[0].seat = d.seat; roomB = d.code; res(); });
      clients[0].c.emit('create', { name: '甲' });
      setTimeout(() => rej(new Error('create B 超时')), 8000);
    });
    await joinRoom(1, roomB, '乙');
    await joinRoom(2, roomB, '丙');
    await joinRoom(3, roomB, '丁');
    const fourSeated = await until(() => clients.every(x => x.lastSnap && x.lastSnap.code === roomB)
      && clients.slice(0,4).every(x => x.lastSnap.seats[0].humanCount === 4));
    T('场景二：4 真人入房', fourSeated);

    // A6：非房主 start 被拒
    clients[1].toasts.length = 0;
    clients[1].c.emit('start');
    await wait(350);
    T('非房主 start 被拒（只有房主）', clients[1].toasts.some(t => /只有房主/.test(t)));
    // A6 正向：房主 start 仍可用，但走全员就绪门槛（未就绪 → 不偷跑）
    clients[0].toasts.length = 0;
    clients[0].c.emit('start');
    await wait(350);
    T('房主 start 受就绪门槛约束（未全员就绪不开局）', clients[0].toasts.some(t => /等待其他玩家就绪/.test(t)));

    // 正常开局：其余三人就绪后房主 setSettings 开 3 局场
    for(let i=1;i<4;i++) clients[i].c.emit('toggleReady', {});
    await wait(350);
    clients[0].c.emit('setSettings', { rounds: 3, start: true });
    const r2Started = await until(() => clients.some(x => x.lastSnap && x.lastSnap.G && !x.lastSnap.G.ended && !x.lastSnap.seriesOver), 15000);
    T('满员房开局成功', r2Started);

    const reachGap2 = await until(() => clients.some(x => {
      const s = x.lastSnap; return s && s.G && s.G.ended && !s.seriesOver && s.series && s.series.roundCount >= 1;
    }), 60000);
    T('满员房打到局末（round 1/3 结束）', reachGap2);

    // 局末：满员 4 真人 → 退出被拦
    clients[2].toasts.length = 0;
    clients[2].c.emit('leave');
    const blocked = await until(() => clients[2].toasts.some(t => /请点【结束场次】/.test(t)), 5000);
    await wait(300);
    const stillFull = clients.every(x => x.lastSnap && x.lastSnap.code === roomB)
      && clients[2].lastSnap.seats[clients[2].seat].type === 'human'
      && clients[2].lastSnap.seats[clients[2].seat].humanCount === 4;
    T('满员真人房局末退出被拦（toast + 座位未动）', blocked && stillFull);

    // 清场：4 人在线 → 提前收场共识（决策 A 路径），随后全员退房
    clients[0].c.emit('endSeries');
    await wait(300);
    for(let i=1;i<4;i++) clients[i].c.emit('endSeriesVote', { vote: true });
    const over = await until(() => clients.some(x => x.lastSnap && x.lastSnap.seriesOver && !x.lastSnap.G), 10000);
    T('极端收尾：共识收场后场结束', over);
    for(let i=0;i<4;i++) clients[i].c.emit('leave');
    await wait(500);

    // ---------- 场景三：未开局 offline 真人座被新玩家顶替 ----------
    let roomC = '';
    await new Promise((res, rej) => {
      clients[0].c.on('joined', d => { clients[0].seat = d.seat; roomC = d.code; res(); });
      clients[0].c.emit('create', { name: '甲' });
      setTimeout(() => rej(new Error('create C 超时')), 8000);
    });
    await joinRoom(1, roomC, '乙');
    await joinRoom(2, roomC, '丙');
    // 把 c2 强制断线 → 未开局 offline（OFFLINE_KICK_MS=0 不会被移出）
    const offlineSeat = clients[2].seat;
    clients[2].c.close();
    const markedOffline = await until(() => clients[0].lastSnap && clients[0].lastSnap.code === roomC
      && clients[0].lastSnap.seats[offlineSeat].offline === true, 8000);
    T('c2 断线后座位 offline=true', markedOffline);

    // 新玩家 join → 顶替该离线座：沿用座位、humanCount 不变、offline 清、名字换新
    const nc = await connect(PORT);
    const ncJoined = await new Promise(res => {
      nc.on('joined', d => res(d));
      nc.emit('join', { code: roomC, name: '顶替' });
      setTimeout(() => res(null), 8000);
    });
    T('新玩家顶替到 offline 座（同座位号）', !!ncJoined && ncJoined.seat === offlineSeat);
    const takeOk = await until(() => clients[0].lastSnap
      && clients[0].lastSnap.seats[offlineSeat].name === '顶替'
      && clients[0].lastSnap.seats[offlineSeat].offline === false
      && clients[0].lastSnap.seats[offlineSeat].humanCount === 3, 8000); // humanCount 嵌在 seat 内
    T('顶替后：座位改名、offline 清除、humanCount 不变(3)', takeOk);
    nc.close();

  }catch(e){
    console.log('运行异常：', e && e.stack ? e.stack : e);
    fail++;
  }finally{
    clients.forEach(x => { try{ x.c.close(); }catch(e){} });
    srv.kill();
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();