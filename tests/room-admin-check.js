/* =========================================================
 * 通山打拱 · 房管回归（踢出 / 历史分数 / 空房宽容）
 *   A 踢出：未开场房主踢掉线满 30s(此处600ms) 的真人 → 座位变空位；
 *           掉线未满时被拒；非房主被拒
 *   B 历史分数：一场自然打满(rounds=1)后 snapshot.history 记一条（玩家名/分数/局数）
 *   C 空房宽容：最后真人退出后房间仍在列表（不立即删），ROOM_IDLE_KICK_MS 后才消失
 * 运行：node tests/room-admin-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const PORT = 18117 + (process.pid % 1000); // 动态偏移端口，避免与孤儿进程撞端口（自毁性防御）
const ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
console.log('room-admin RUN-START pid=' + process.pid + ' port=' + PORT);
async function until(fn, ms){ const t0=Date.now(); while(Date.now()-t0<(ms||8000)){ if(await fn()) return true; await wait(80); } return false; }
let pass=0, fail=0;
function T(name, cond, extra){ if(cond){ pass++; console.log('PASS '+name); } else { fail++; console.log('FAIL '+name+(extra!==undefined?' => '+JSON.stringify(extra):'')); } }
function connect(port){
  return new Promise((res, rej) => {
    const c = io('http://127.0.0.1:' + port, { reconnection: false, transports: ['websocket'], timeout: 10000 });
    c.on('connect', () => res(c));
    c.on('connect_error', e => rej(e));
  });
}
(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), AI_TURN_MS: '60', ROOM_IDLE_KICK_MS: '1500',
      OFFLINE_KICK_WAIT_MS: '600', HOST_OFFLINE_KICK_MS: '100000', // 关闭房主自踢干扰
      REJOIN_TAKEOVER_MS: '0', TAKEOVER_ASK_MS: '2000', TAKEOVER_APPROVE_MS: '3000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out=''; srv.stdout.on('data', d=>out+=d.toString()); srv.stderr.on('data', d=>out+=d.toString());
  const bootAt = Date.now();
  while(!/服务器已启动/.test(out) && Date.now()-bootAt < 10000) await wait(100);
  if(!/服务器已启动/.test(out)){ console.log('FAIL 服务器未启动：\n' + out.slice(-1500)); process.exit(1); }
  const clients = [];
  const reg = x => { clients.push(x); return x; };
  const empty = sock => ({ cl: sock, seat:-1, snap:null, joined:null, toasts:[] });

  try{
    // ── A：踢出（未开场，房主=甲，乙掉线）──
    {
      const H = reg(empty(await connect(PORT)));
      const B = reg(empty(await connect(PORT)));
      H.cl.on('state', s => H.snap = s); H.cl.on('joined', d => H.joined = d); H.cl.on('toast', m => H.toasts.push(String(m)));
      B.cl.on('state', s => B.snap = s); B.cl.on('joined', d => B.joined = d);
      H.cl.emit('create', { name:'甲', settings:{} });
      while(!H.joined) await wait(50);
      B.cl.emit('join', { code:H.joined.code, name:'乙' });
      while(!B.joined) await wait(50);
      H.seat = H.joined.seat; B.seat = B.joined.seat;
      const code = H.joined.code;

      // 掉线后立刻踢：应被拒（未满 30s/600ms）
      B.cl.close();
      await until(()=> H.snap && H.snap.seats[B.seat] && H.snap.seats[B.seat].offline===true, 4000);
      H.toasts.length = 0;
      H.cl.emit('kickSeat', { seat: B.seat });
      await wait(250);
      T('A1 掉线未满阈值 → 踢出被拒', H.toasts.some(t => /未满/.test(t)), H.toasts);
      T('A1 座位仍未空位', !!(H.snap.seats[B.seat] && H.snap.seats[B.seat].type==='human'));

      // 满阈值后再踢 → 成功
      await wait(900);
      H.cl.emit('kickSeat', { seat: B.seat });
      const kicked = await until(()=> H.snap && H.snap.seats[B.seat] && H.snap.seats[B.seat].type==='ai' && H.snap.seats[B.seat].name==='空位', 4000);
      T('A2 满阈值 → 房主踢出成功（座位变空位）', kicked, H.snap && H.snap.seats.map(s=>({n:s.name,t:s.type})));

      // 非房主踢人：由「乙」的替身？乙已被踢，用另一新连接丙来当非房主测试
      const C = reg(empty(await connect(PORT)));
      C.cl.on('joined', d => C.joined = d); C.cl.on('state', s => C.snap = s); C.cl.on('toast', m => C.toasts.push(String(m)));
      C.cl.emit('join', { code:code, name:'丙' });
      while(!C.joined) await wait(50);
      C.toasts.length = 0;
      // 让甲离线＞阈值，丙(非房主)尝试踢甲 → 只有房主能踢
      H.cl.close();
      const offC = await until(()=> C.snap && C.snap.seats[H.seat] && C.snap.seats[H.seat].offline===true, 4000);
      T('A3 前置：甲已离线（丙视角）', offC, C.snap && C.snap.seats[H.seat]);
      await wait(900);
      C.cl.emit('kickSeat', { seat: H.seat });
      const rej = await until(()=> C.toasts.length>0, 2500);
      T('A3 非房主踢人 → 被拒（只有房主）', rej && C.toasts.some(t => /只有房主/.test(t)), C.toasts);
    }

    // ── B：历史分数（一场自然打满 rounds=1）──
    {
      const H = reg(empty(await connect(PORT)));
      const B = reg(empty(await connect(PORT)));
      H.cl.on('state', s => H.snap = s); H.cl.on('joined', d => H.joined = d);
      B.cl.on('state', s => B.snap = s); B.cl.on('joined', d => B.joined = d);
      H.cl.emit('create', { name:'甲', settings:{ aiFill:true, rounds:1 } });
      while(!H.joined) await wait(50);
      B.cl.emit('join', { code:H.joined.code, name:'乙' });
      while(!B.joined) await wait(50);
      H.seat = H.joined.seat; B.seat = B.joined.seat;
      const code = H.joined.code;
      for(const cl of [H, B]){
        cl.cl.on('state', s => {
          const G=s.G, me=cl.seat;
          if(!G || G.ended) return;
          if(G.seats[me].out || G.turn!==me) return;
          if(G.confirming){ cl.cl.emit('act',{seat:me,type:'confirm',choice:'pass'}); return; }
          if(G.lastPlay){ cl.cl.emit('act',{seat:me,type:'pass'}); }
          else { const h=G.seats[me].hand; if(h&&h.length) cl.cl.emit('act',{seat:me,type:'play',cards:[h[h.length-1]]}); }
        });
      }
      B.cl.emit('toggleReady', {}); await wait(120);
      H.cl.emit('setSettings', { start:true });
      const ended = await until(()=>{ const s=H.snap; return s && s.G && s.G.ended && s.seriesOver===true && s.history && s.history.length>=1; }, 30000);
      T('B1 一场打完 → 场末且 history 已记录', ended, H.snap && {seriesOver:H.snap.seriesOver, hist:H.snap.history});
      const e0 = H.snap && H.snap.history && H.snap.history[0];
      T('B2 记录含玩家名/局数/分数', !!(e0 && e0.players && e0.players.length===4 && Array.isArray(e0.scores) && e0.rounds===1),
        {players:e0&&e0.players, scores:e0&&e0.scores, rounds:e0&&e0.rounds});
      T('B3 玩家名按该场实况（甲/乙 + AI 名）', !!(e0 && e0.players[0]==='甲' && e0.players[1]==='乙'),
        e0 && e0.players);
    }

    // ── C：空房宽容（最后真人退出后不立即删除；闲置后才消失）──
    {
      const H = reg(empty(await connect(PORT)));
      H.cl.on('joined', d => H.joined = d);
      H.cl.on('state', s => H.snap = s);
      H.cl.emit('create', { name:'甲', settings:{} });
      while(!H.joined) await wait(50);
      const code = H.joined.code;
      H.cl.emit('leave'); // 唯一真人真退 → 空房
      await wait(200);
      const rooms1 = await new Promise(res => { H.cl.once('rooms', r => res(r||[])); H.cl.emit('listRooms'); });
      T('C1 空房不立即删除（仍在大厅列表可加入）', !!(rooms1 && rooms1.some(r=>r.code===code)), rooms1 && rooms1.map(r=>r.code));
      // 闲置后删除（单次 listRooms 带 1.5s 超时，避免 once 永不触发造成挂死）
      const gone = await until(async ()=>{
        const got = await new Promise(res=>{
          const t=setTimeout(()=>res(null), 1500);
          H.cl.once('rooms', r=>{ clearTimeout(t); res(r||[]); });
          H.cl.emit('listRooms');
        });
        return got!==null && !(got.some(r=>r.code===code));
      }, 8000);
      T('C2 闲置超时后空房被删除', gone);
    }

  }catch(e){
    console.log('运行异常：', e && e.stack ? e.stack : e);
    fail++;
  }finally{
    clients.forEach(x=>{ try{ x.cl.close(); }catch(e){} });
    srv.kill();
  }
  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();