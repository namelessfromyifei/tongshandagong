/* =========================================================
 * 通山打拱 · 收场/退出口径 / 离线顶替 / start 收权 端到端检查
 * ✓ AI 房（真人<4）局末也不许退出；【结束对局】可用——在线真人全票即收场（离线/AI 不占票）
 * ✓ 满员真人房有真人掉线 → 提前结束被拒；重连后可恢复共识收场
 * ✓ 退出仅场末/未开局可用（场末 AI 房先收场再退）
 * ✓ 未开局新玩家 join 只进「空位/AI」座——不掉线真人座（离线座保留给本人重连）
 * ✓ 非房主 start 被拒；房主 start 走全员就绪门槛
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
  // 短 AI 间隔加快打完；关闲置/离线踢出（保持 offline 座不移走，供顶替/掉线场景使用）
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), AI_TURN_MS: '60', ROOM_IDLE_KICK_MS: '0', OFFLINE_KICK_MS: '0',
      REJOIN_TAKEOVER_MS: '0', // 关手动重连的「网络波动窗口」：场景二的本人重连（r3 输入房号+昵称）须即时归位
      DB_PATH: ':memory:',
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

    // ---------- 场景一：AI 房（3 真人 + 1 AI）局末不可退；在线真人共识收场；场末才可退 ----------
    let roomA = '';
    await new Promise((res, rej) => {
      clients[0].c.on('joined', d => { clients[0].seat = d.seat; roomA = d.code; res(); });
      clients[0].c.emit('create', { name: '甲' });
      setTimeout(() => rej(new Error('create 超时')), 8000);
    });
    await joinRoom(1, roomA, '乙');
    await joinRoom(2, roomA, '丙');
    // 改设置会让已准备玩家退回未准备：先改设置，再准备，最后 start
    clients[0].c.emit('setSettings', { aiFill: true, rounds: 3 });
    await until(() => clients[0].lastSnap && clients[0].lastSnap.settings && clients[0].lastSnap.settings.rounds === 3, 5000);
    clients[1].c.emit('toggleReady', {});
    clients[2].c.emit('toggleReady', {});
    // 等到就绪已生效再发 start（固定延时在负载高时会提前判定、且 start 不会重试）
    await until(() => {
      const s = clients[0].lastSnap; if(!s || !s.ready) return false;
      return s.ready[clients[1].seat] === true && s.ready[clients[2].seat] === true;
    }, 5000);
    // start 被拒后服务端不会重试；CI 负载高/瞬时掉线时重发几次，避免偶发失败
    let r1Started = false;
    const r1Deadline = Date.now() + 15000;
    while(!r1Started && Date.now() < r1Deadline){
      clients[0].c.emit('setSettings', { start: true });
      r1Started = await until(() => clients.some(x => x.lastSnap && x.lastSnap.G && !x.lastSnap.G.ended && !x.lastSnap.seriesOver), 1000);
    }
    T('AI 房开局成功（3 真人 + AI 补位）', r1Started, clients[0].toasts.slice(-3));

    const reachedGap = await until(() => clients.some(x => {
      const s = x.lastSnap; return s && s.G && s.G.ended && !s.seriesOver && s.series && s.series.roundCount >= 1;
    }), 60000);
    T('AI 房打到局末（round 1/3 结束）', reachedGap);

    // 局末：AI 房同样不许退出（统一口径：退出门只在场末）
    clients[2].toasts.length = 0;
    const c2seat = clients[2].seat;
    clients[2].c.emit('leave');
    const leaveBlocked = await until(() => clients[2].toasts.some(t => /请点【提前结束】/.test(t)), 5000);
    await wait(300);
    const stillSeated = clients.some(x => x.lastSnap && x.lastSnap.seats[c2seat].type === 'human'
      && x.lastSnap.seats[c2seat].humanCount === 3);
    T('AI 房局末退出被拦（toast + 座位未动）', leaveBlocked && stillSeated);

    // 有一名真人掉线 → 不影响 AI 房收场（在线真人全票即生效）
    const c1seat = clients[1].seat;
    clients[1].c.close();
    const c1off = await until(() => clients[0].lastSnap && clients[0].lastSnap.seats[c1seat].offline === true, 8000);
    T('AI 房 c1 断线后座位 offline=true', c1off);

    clients[0].toasts.length = 0;
    clients[0].c.emit('endSeries');
    const voteSeen = await until(() => clients.some(x => x.lastSnap && x.lastSnap.endVote), 5000);
    await wait(250);
    T('AI 房可发起提前结束（不要求 4 真人；无人报「需要 4 位在线真人」）',
      voteSeen && !clients[0].toasts.some(t => /需要 4 位在线真人/.test(t)));
    clients[2].c.emit('endSeriesVote', { vote: true });
    // 局间提前收场：保留已结束的牌局（按场末处理，等准备/退出才清）
    const s1Ended = await until(() => clients.some(x => x.lastSnap && x.lastSnap.seriesOver && !!x.lastSnap.G), 10000);
    T('AI 房在线真人全票 → 场结束（离线 c1 不阻塞）', s1Ended);

    // 场末（收场后）：退出放行；c0 退出后在线人类减到 2（c2 + 离线 c1）
    clients[0].c.emit('leave');
    const s1Left = await until(() => clients[2].lastSnap
      && clients[2].lastSnap.seats[c2seat].humanCount === 2, 8000); // humanCount 嵌在 seat 内
    T('场末 AI 房可退出（先收场再退出）', s1Left);
    clients[2].c.emit('leave'); // 场末 c2 可走，为场景二腾出 socket
    await wait(400);

    // ---------- 场景二：满员真人房 —— start 收权 + 局末退出被拦 + 有掉线不可发起 & 重连恢复 ----------
    // 场景一的 c1 已断线关闭：重建其 socket（c1n）续用 '乙'
    const c1n = await connect(PORT);
    clients[1] = { c: c1n, id:'c1n', seat:-1, room:'', snaps:[], toasts:[] };
    c1n.on('state', snap => { clients[1].lastSnap = snap; clients[1].snaps.push(snap); });
    c1n.on('toast', m => { clients[1].toasts.push(String(m)); });
    wire(1);
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

    // 先改设置（改设置会让已准备玩家退回未准备），再准备，最后 start
    clients[0].c.emit('setSettings', { rounds: 3 });
    await until(() => clients[0].lastSnap && clients[0].lastSnap.settings && clients[0].lastSnap.settings.rounds === 3, 5000);
    for(let i=1;i<4;i++) clients[i].c.emit('toggleReady', {});
    // 等到 3 位玩家就绪已生效再发 start（固定延时在负载高时会提前判定、且 start 不会重试）
    await until(() => {
      const s = clients[0].lastSnap; if(!s || !s.ready) return false;
      return [1,2,3].every(i => s.ready[clients[i].seat] === true);
    }, 5000);
    // 同上：start 只尝试一次，被拒（瞬时掉线/就绪未同步）时会一直不开；重试至多 15 秒
    let r2Started = false;
    const r2Deadline = Date.now() + 15000;
    while(!r2Started && Date.now() < r2Deadline){
      clients[0].c.emit('setSettings', { start: true });
      r2Started = await until(() => clients.some(x => x.lastSnap && x.lastSnap.G && !x.lastSnap.G.ended && !x.lastSnap.seriesOver), 1000);
    }
    T('满员房开局成功', r2Started, clients[0].toasts.slice(-3));

    const reachGap2 = await until(() => clients.some(x => {
      const s = x.lastSnap; return s && s.G && s.G.ended && !s.seriesOver && s.series && s.series.roundCount >= 1;
    }), 60000);
    T('满员房打到局末（round 1/3 结束）', reachGap2);

    // 局末：满员 4 真人 → 退出被拦（与 AI 房同口径）
    clients[2].toasts.length = 0;
    clients[2].c.emit('leave');
    const blocked2 = await until(() => clients[2].toasts.some(t => /请点【提前结束】/.test(t)), 5000);
    await wait(300);
    const stillFull = clients[2].lastSnap
      && clients[2].lastSnap.seats[clients[2].seat].type === 'human'
      && clients[2].lastSnap.seats[clients[2].seat].humanCount === 4;
    T('满员真人房局末退出被拦（toast + 座位未动）', blocked2 && stillFull);

    // 满员房有真人掉线 → 其余 3 位在线真人可发起（票数门槛 = 在线真人数，离线座不占票）
    const c3seat = clients[3].seat;
    clients[3].c.close();
    const c3off = await until(() => clients[0].lastSnap && clients[0].lastSnap.seats[c3seat].offline === true, 8000);
    T('满员房 c3 断线后座位 offline=true', c3off);
    clients[0].toasts.length = 0;
    clients[0].c.emit('endSeries');
    const voteSeen1 = await until(() => clients.some(x => x.lastSnap && x.lastSnap.endVote), 5000);
    T('满员房 1 人掉线 → 其余 3 人可发起提前结束', voteSeen1);

    // 有人重连 → 进行中的表决作废；重连恢复后可重新发起并全票收场
    const r3 = await connect(PORT);
    const r3joined = await new Promise(res => {
      r3.on('joined', d => res(d));
      r3.emit('rejoin', { code: roomB, name: '丁' });
      setTimeout(() => res(null), 8000);
    });
    T('掉线真人重连归位', !!r3joined && r3joined.seat === c3seat);
    const c3back = await until(() => clients[0].lastSnap && clients[0].lastSnap.seats[c3seat].offline === false, 8000);
    T('重连后座位 offline 清除', c3back);

    clients[0].c.emit('endSeries');
    const voteSeen2 = await until(() => clients.some(x => x.lastSnap && x.lastSnap.endVote), 5000);
    T('重连后满员房可再发起提前结束', voteSeen2);
    // 表决：c1、c2 用自己的 socket，c3 用重连后的 r3
    clients[1].c.emit('endSeriesVote', { vote: true });
    clients[2].c.emit('endSeriesVote', { vote: true });
    await wait(200);
    r3.emit('endSeriesVote', { vote: true });
    const s2Ended = await until(() => clients.some(x => x.lastSnap && x.lastSnap.seriesOver && !!x.lastSnap.G), 10000);
    T('四人全票 → 场结束（决策 A 原路径仍通）', s2Ended);

    // 场末全员退出 → 空房保留 30 分钟（新规则：不立即删除；本测试 spawn 关闲置解散，故断言「仍在大厅列表」）
    for(let i=0;i<4;i++) clients[i].c.emit('leave');
    if(r3 && r3.connected) r3.emit('leave');
    await wait(600);
    const lrB = await new Promise(res => { clients[0].c.once('rooms', r => res(r||[])); clients[0].c.emit('listRooms'); });
    T('场末全员退出后空房保留（30 分钟宽容，不立即删除）', !!lrB.some(r => r.code === roomB));
    r3.close();

    // ---------- 场景三：未开局新玩家 join 只进「空位/AI」座，不顶替离线真人座 ----------
    let roomC = '';
    await new Promise((res, rej) => {
      clients[0].c.on('joined', d => { clients[0].seat = d.seat; roomC = d.code; res(); });
      clients[0].c.emit('create', { name: '甲' });
      setTimeout(() => rej(new Error('create C 超时')), 8000);
    });
    await joinRoom(1, roomC, '乙');
    await joinRoom(2, roomC, '丙');
    const offlineSeat = clients[2].seat;
    clients[2].c.close();
    const markedOffline = await until(() => clients[0].lastSnap && clients[0].lastSnap.code === roomC
      && clients[0].lastSnap.seats[offlineSeat].offline === true, 8000);
    T('c2 断线后座位 offline=true', markedOffline);

    const nc = await connect(PORT);
    const ncJoined = await new Promise(res => {
      nc.on('joined', d => res(d));
      nc.emit('join', { code: roomC, name: '空位来客' });
      setTimeout(() => res(null), 8000);
    });
    T('新玩家进入空位/AI 座（而不是顶替 offline 座）', !!ncJoined && ncJoined.seat >= 0 && ncJoined.seat !== offlineSeat,
      ncJoined && { seat: ncJoined.seat, offlineSeat });
    const njSeat = ncJoined && ncJoined.seat;
    const takeOk = await until(() => clients[0].lastSnap
      && njSeat >= 0 && clients[0].lastSnap.seats[njSeat] && clients[0].lastSnap.seats[njSeat].name === '空位来客'
      && clients[0].lastSnap.seats[njSeat].offline === false
      && clients[0].lastSnap.seats[njSeat].humanCount === 4, 8000); // humanCount 嵌在 seat 内
    T('空位入座后：座位改名、offline 清除、人数+1(4)', takeOk);
    const offlineKeep = await until(() => clients[0].lastSnap
      && clients[0].lastSnap.seats[offlineSeat]
      && clients[0].lastSnap.seats[offlineSeat].name === '丙'
      && clients[0].lastSnap.seats[offlineSeat].type === 'human'
      && clients[0].lastSnap.seats[offlineSeat].offline === true, 8000);
    T('离线真人座保留：仍名「丙」、offline 未清', offlineKeep);
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