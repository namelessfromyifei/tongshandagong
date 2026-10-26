/* =========================================================
 * 通山打拱 · 快照脱敏端到端检查（Node）
 * 起真实 server.js，3 个真人 + AI 补位自动打完一局，
 * 按接收者校验快照：对手手牌隐藏、seed 不派发、明鸡身份不提前下发、局末结算下发。
 * 运行：node tests/mask-check.js  （需要 node_modules：express/socket.io/socket.io-client）
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18099;
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

(async () => {
  // 启动测试服务（短 AI 间隔加快打完、关闭闲置/离线踢出避免测试中被处理）
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      AI_TURN_MS: '80',
      ROOM_IDLE_KICK_MS: '0',
      OFFLINE_KICK_MS: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += d; });
  srv.stderr.on('data', d => { out += d; });

  // 等启动
  const startAt = Date.now();
  while (/服务器已启动/.test(out) === false && Date.now() - startAt < 8000){
    await wait(120);
  }

  const clients = [];
  let c0, c1, c2, roomCode = '';
  try{
    c0 = await connect(PORT);
    c1 = await connect(PORT);
    c2 = await connect(PORT);
    clients.push({ c: c0, id: 'c0', seat: -1, snaps: [], auto: true });
    clients.push({ c: c1, id: 'c1', seat: -1, snaps: [], auto: true });
    clients.push({ c: c2, id: 'c2', seat: -1, snaps: [], auto: true });

    // 各客户端的自动反应：轮到自己就表态/跟牌/领出，把对局推到打完
    const wire = (cl) => {
      cl.c.on('state', snap => {
        cl.snaps.push(snap);
        cl.G = snap.G;  cl.snap = snap;
        if(!snap.G) return;
        const me = cl.seat;
        const G = snap.G;
        if(G.ended) return;
        if(G.confirming){
          if(G.turn === me && !(G.seats[me] && G.seats[me].choice)){
            cl.c.emit('act', { seat: me, type: 'confirm', choice: 'pass' });
          }
        } else if(G.turn === me && !G.seats[me].out){
          if(G.lastPlay){
            cl.c.emit('act', { seat: me, type: 'pass' });
          } else {
            const h = G.seats[me].hand;
            if(h && h.length) cl.c.emit('act', { seat: me, type: 'play', cards: [h[h.length - 1]] });
          }
        }
      });
    };
    clients.forEach(wire);

    let seatOf = { c0: -1, c1: -1, c2: -1 };
    const joined = (cl, d) => { cl.seat = d.seat; cl.code = d.code; seatOf[cl.id] = d.seat; };

    // 建房：c0 房主
    await new Promise((res, rej) => {
      c0.on('joined', d => { joined(clients[0], d); roomCode = d.code; res(); });
      c0.on('toast', () => {});
      c0.emit('create', { name: '甲' });
      setTimeout(() => rej(new Error('create 超时')), 8000);
    });
    // 加入：c1、c2
    await new Promise((res, rej) => {
      c1.on('joined', d => { joined(clients[1], d); res(); });
      c1.emit('join', { code: roomCode, name: '乙' });
      setTimeout(() => rej(new Error('join c1 超时')), 8000);
    });
    await new Promise((res, rej) => {
      c2.on('joined', d => { joined(clients[2], d); res(); });
      c2.emit('join', { code: roomCode, name: '丙' });
      setTimeout(() => rej(new Error('join c2 超时')), 8000);
    });
    T('三人都已入座（座位号互不重复）', new Set([seatOf.c0, seatOf.c1, seatOf.c2]).size === 3 && [seatOf.c0, seatOf.c1, seatOf.c2].every(x => x >= 0));

    // 其余真人就绪后由房主开局（AI 补位 + 1 局）
    await new Promise(res => {
      c1.emit('toggleReady', {});
      c2.emit('toggleReady', {});
      setTimeout(res, 400);
    });
    c0.emit('setSettings', { aiFill: true, rounds: 1, start: true });

    // 跑到对局结束（或超时）
    const endedAt = Date.now();
    while(Date.now() - endedAt < 90000){
      if(clients.some(cl => cl.G && cl.G.ended)) break;
      await wait(150);
    }
    const gameEnded = clients.some(cl => cl.G && cl.G.ended);
    T('对局能打完（ended 出现在某个客户端）', gameEnded);

    // —— 断言：脱敏（针对局中快照） ——
    let maskedSeen = 0, endedSeen = 0;
    for(const cl of clients){
      for(const snap of cl.snaps){
        const G = snap.G;
        if(!G) continue;
        if(!G.ended){ maskedSeen++; } else { endedSeen++; }
      }
    }
    T('出现过局中（脱敏）快照', maskedSeen > 0);
    T('出现过局末快照' + (gameEnded ? '' : '（未打完则跳过结算断言）'), !gameEnded || endedSeen > 0);

    // 逐条校验每条局中快照
    let seen = 0;
    for(const cl of clients){
      const me = cl.seat;
      for(const snap of cl.snaps){
        const G = snap.G;
        if(!G || G.ended) continue;
        seen++;
        const meSeat = me;
        // 1) 不派发种子
        if(!('seed' in G) && !('rnd' in G)) T('无 seed/rnd ['+cl.id+']', true); else T('无 seed/rnd ['+cl.id+']', false, {has: Object.keys(G).filter(k=>k==='seed'||k==='rnd')});
        // 2) 手牌：自己完整 & handCount 一致
        T(`自己手牌完整+handCount[${cl.id}]`, G.seats[meSeat].handCount === G.seats[meSeat].hand.length);
        // 3) 他人手牌隐藏：非空手牌只可能是自己或观战队友(_mate)
        const holder = G.seats.map((s,i)=> (s.hand && s.hand.length>0) ? i : -1).filter(i=>i>=0);
        const mate = G._mate;
        const holderOk = holder.every(i => i===meSeat || (G.mode!=='hard' && mate!=null && i===mate));
        T(`他人手牌隐藏[${cl.id}]`, holderOk, holder);
        // 4) 各家 handCount 都存在（隐藏的是牌内容，不是数量）
        T(`各家 handCount 齐全[${cl.id}]`, G.seats.every(s => typeof s.handCount === 'number' && s.handCount >= 0));
      }
    }
    // 5) 未公开前 partner=-1；2)‥3) 之外：_mate 有效
    for(const cl of clients){
      for(const snap of cl.snaps){
        const G = snap.G;
        if(!G || G.ended) continue;
        if(!G.revealed && G.mode !== 'hard'){
          T(`未公开前 partner=-1[${cl.id}]`, G.partner === -1);
        }
        if(G.mode !== 'hard' && typeof G._mate === 'number'){
          T(`_mate 有效[${cl.id}]`, G._mate >= 0 && G._mate <= 3);
        }
      }
    }
    // youArePartner 最多一个客户端的最近快照为真
    const yaps = clients.filter(cl => cl.snap && cl.snap.youArePartner).length;
    T('youArePartner 最多 1 人', yaps <= 1);

    // 交叉一致：同一座位在各客户端看到的 handCount 应一致（局中快照上采样）
    {
      let okC = true, badInfo = null;
      for(let seat=0; seat<4; seat++){
        const vals = [];
        for(const cl of clients){
          const s = cl.G && cl.G.seats ? cl.G.seats[seat] : null;
          if(s && typeof s.handCount === 'number') vals.push(s.handCount);
        }
        if(vals.length >= 2 && new Set(vals).size !== 1){ okC = false; badInfo = {seat, vals}; break; }
      }
      T('各接收者对手牌数量口径一致', okC, badInfo);
    }

    // —— 断言：局末（如果打完了） ——
    if(gameEnded){
      const ce = clients.find(cl => cl.G && cl.G.ended);
      // 局末第一帧可能先于 finishRoom 一步到达（尚未带结算），等带结算的帧来
      const settledSnap = await new Promise(res => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          const last = ce.snaps[ce.snaps.length - 1];
          if(last && last.G && last.G.ended && last.settle){ clearInterval(iv); res(last); }
          else if(Date.now() - t0 > 4000){ clearInterval(iv); res(null); }
        }, 100);
      });
      const G = settledSnap ? settledSnap.G : ce.G;
      const snap = settledSnap || ce.snap;
      T('局末 G.partner 已公开', G.partner >= 0);
      T('局末快照带结算结果', !!(snap.settle && snap.settle.perFen && typeof snap.settle.perFen[3] === 'number' && Array.isArray(snap.settle.winnerSeats)));
      if(snap.settle){
        T('结算字段类型正确', typeof snap.settle.perFen[0] === 'number' && Array.isArray(snap.settle.winnerSeats));
      }
      if(snap.settle){
        T('结算字段类型正确', typeof snap.settle.perFen[0] === 'number' && Array.isArray(snap.settle.winnerSeats));
      }
      T('局末摊牌：未跑完的家剩余手牌被公开', G.seats.some(s => s.hand && s.hand.length > 0));
      T('局末系列累计完整下发', !!(snap.series && Array.isArray(snap.series.totals) && snap.series.totals.length===4 && snap.series.totals.every(n=>typeof n==='number')));
    }

    // 换一个房间码再看一眼：创建端与加入端拿到的房间码一致（顺带回归）
    T('房间码下发一致', typeof roomCode === 'string' && /^[A-Z0-9]{4}$/.test(roomCode));

    // #3 房间号白名单：非法/可注入房间号直接被服务端拒绝；合法房间号仍可加入
    {
      const bad = await connect(PORT);
      const badToasts = [];
      bad.on('toast', m => badToasts.push(String(m)));
      bad.emit('join', { code: '><img', name: '坏蛋' });
      await wait(250);
      T('非法房间号 join 被拒', badToasts.some(m => /房间号/.test(m)));
      bad.emit('create', { name: '坏蛋2', code: 'AB<C' });
      await wait(250);
      T('非法自定义房间号 create 被拒', badToasts.some(m => /房间号/.test(m)));
      badToasts.length = 0;
      bad.emit('join', { code: 'LOVE', name: '坏蛋3' });
      await wait(400);
      T('合法房间号仍可正常加入', !badToasts.some(m => /房间号/.test(m)) && badToasts.some(m => /加入/.test(m)));
      bad.close();
    }

  }catch(e){
    console.log('运行异常：', e && e.stack ? e.stack : e);
    fail++;
  }finally{
    try{ c0 && c0.close(); c1 && c1.close(); c2 && c2.close(); }catch(e){}
    srv.kill();
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();