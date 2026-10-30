/* =========================================================
 * 通山打拱 · 场末冻结房「空位座/新玩家入座」残局数据检查（F2 回归）
 *   ✓ 两场间全员共识提前收场 → 场末冻结（seriesOver+earlyEnded+G保留）
 *   ✓ 甲乙各自「刷新」（新连接 rejoin auto）→ 座位仍真人原名
 *   ✓ 乙场末真退 → 座位「空位」(ai)，该索引 G 残局数据仍保留（「其他都不隐藏」）
 *   ✓ 丙 join 空位座 → room 座变真人丙，且 G 该索引已被 blankGameSeatData 清残：
 *          blanked=true、hand=[]、caught=0、out=false（牌桌按刚进房空座渲染）
 *   ✓ 对照：未被入座的 甲座 G 数据不受影响（不误清他人档案）
 * 运行：node tests/frozenseat-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const PORT = 18115, ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms){ const t0=Date.now(); while(Date.now()-t0<(ms||8000)){ if(fn()) return true; await wait(80); } return false; }
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
    env: Object.assign({}, process.env, { PORT: String(PORT), AI_TURN_MS: '60', ROOM_IDLE_KICK_MS: '0', OFFLINE_KICK_MS: '0', DB_PATH: ':memory:' }),
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out=''; srv.stdout.on('data', d=>out+=d.toString()); srv.stderr.on('data', d=>out+=d.toString());
  while(!/服务器已启动/.test(out)) await wait(100);

  const clients = [];
  const reg = x => { clients.push(x); return x; };
  const empty = sock => ({ cl: sock, seat:-1, snap:null, joined:null });

  try{
    // ── 甲(0)、乙(1) + AI 补位，打到局末 ──
    const cA = reg(empty(await connect(PORT)));
    const cB = reg(empty(await connect(PORT)));
    cA.cl.on('state', s => cA.snap = s);
    cB.cl.on('state', s => cB.snap = s);
    cA.cl.on('joined', d => cA.joined = d);
    cB.cl.on('joined', d => cB.joined = d);
    cA.cl.emit('create', { name:'甲', settings:{ aiFill:true, rounds:2 } });
    while(!cA.joined) await wait(50);
    cB.cl.emit('join', { code:cA.joined.code, name:'乙' });
    while(!cB.joined) await wait(50);
    cA.seat = cA.joined.seat; cB.seat = cB.joined.seat;
    const code = cA.joined.code;
    for(const cl of [cA, cB]){
      cl.cl.on('state', s => {
        const G=s.G, me=cl.seat;
        if(!G || G.ended) return;
        if(G.seats[me].out || G.turn!==me) return;
        if(G.confirming){ cl.cl.emit('act',{seat:me,type:'confirm',choice:'pass'}); return; }
        if(G.lastPlay){ cl.cl.emit('act',{seat:me,type:'pass'}); }
        else { const h=G.seats[me].hand; if(h&&h.length) cl.cl.emit('act',{seat:me,type:'play',cards:[h[h.length-1]]}); }
      });
    }
    cB.cl.emit('toggleReady', {}); await wait(150);
    cA.cl.emit('setSettings', { start:true });
    const rEnd = await until(()=>{ const s=cA.snap; return s && s.G && s.G.ended && !s.seriesOver && s.series && s.series.roundCount>=1; }, 30000);
    T('第1局打到局末', rEnd);

    // ── 全员共识提前收场（局间）──
    cA.cl.emit('endSeries');
    await until(()=>!!(cA.snap && cA.snap.endVote), 6000);
    cB.cl.emit('endSeriesVote', { vote:true });
    const frozen = await until(()=>{ const s=cA.snap; return s && s.seriesOver && !!s.G && s.earlyEnded===true; }, 8000);
    T('局间提前收场冻结（seriesOver+earlyEnded+G保留）', frozen);

    // ── 甲乙各自「刷新」──
    const ra = reg(empty(await connect(PORT)));
    const rb = reg(empty(await connect(PORT)));
    ra.cl.on('state', s => ra.snap = s);
    ra.cl.on('joined', d => ra.joined = d);
    ra.cl.emit('rejoin', { code:code, name:'甲', auto:true });
    const raJ = await until(()=>ra.joined, 8000);
    rb.cl.on('state', s => rb.snap = s);
    rb.cl.on('joined', d => rb.joined = d);
    rb.cl.emit('rejoin', { code:code, name:'乙', auto:true });
    const rbJ = await until(()=>rb.joined, 8000);
    const ok2 = await until(()=> ra.snap && ra.snap.seriesOver && ra.snap.seats[0] && ra.snap.seats[1], 8000);
    T('甲/乙「刷新」重连归位', !!raJ && !!rbJ);
    T('刷新后（冻结帧）剩余真人保持原名/真人',
      ok2 && ra.snap.seats.map(s=>s.type).join('') === 'humanhumanaiai' &&
      ra.snap.seats[0].name==='甲' && ra.snap.seats[1].name==='乙',
      ra.snap.seats && ra.snap.seats.map(s=>({n:s.name,t:s.type})));

    // ── 乙真退 → 空位；该索引 G 残局仍保留（「其他都不隐藏」）──
    rb.cl.emit('leave');
    const kw = await until(()=> ra.snap && ra.snap.seats[1] && ra.snap.seats[1].type==='ai' && ra.snap.seats[1].name==='空位', 6000);
    T('乙场末真退 → 座位「空位」(ai)', !!kw, ra.snap.seats && ra.snap.seats.map(s=>({n:s.name,t:s.type})));
    const g1 = ra.snap.G && ra.snap.G.seats[1];
    const res1 = g1 && (((g1.hand&&g1.hand.length)||0) + (g1.out?1:0) + ((g1.caught||0)>0?1:0));
    T('真退后该索引 G 残局仍保留（未清/其他不隐藏）', res1>0,
      {hand:g1&&g1.hand&&g1.hand.length, out:g1&&g1.out, caught:g1&&g1.caught});

    // ── 丙 join 空位座 → 该索引 G 被清残（blanked 空座）──
    const cC = reg(empty(await connect(PORT)));
    cC.cl.on('joined', d => cC.joined = d);
    cC.cl.on('state', s => cC.snap = s);
    cC.cl.emit('join', { code:code, name:'丙' });
    const gotC = await until(()=>cC.joined, 8000);
    const jC = cC.joined;
    T('丙入座到空位座(1)', !!gotC && !!jC && jC.seat===1, jC);
    await until(()=>cC.snap && cC.snap.seriesOver, 6000);
    const roomSeatC = cC.snap.seats[1];
    T('丙座(room.seats)已是真人「丙」', !!(roomSeatC && roomSeatC.type==='human' && roomSeatC.name==='丙'), roomSeatC);
    const gC = cC.snap.G && cC.snap.G.seats[1];
    T('丙入座后该索引 G 已清残（blanked=true、hand/抓分/出局归零） → 桌面按空座渲染',
      !!(gC && gC.blanked===true && (!(gC.hand&&gC.hand.length)) && gC.caught===0 && gC.out===false),
      {blanked:gC&&gC.blanked, hand:gC&&gC.hand&&gC.hand.length, caught:gC&&gC.caught, out:gC&&gC.out});
    // 对照：甲座(0) G 数据不受影响
    const g0 = cC.snap.G && cC.snap.G.seats[0];
    T('对照：未被入座的甲座 G 数据不受影响（无 blanked、残局仍在）',
      !!(g0 && !g0.blanked && (((g0.hand&&g0.hand.length)||0) + (g0.out?1:0) + ((g0.caught||0)>0?1:0)) > 0),
      {blanked:g0&&g0.blanked, hand:g0&&g0.hand&&g0.hand.length, out:g0&&g0.out, caught:g0&&g0.caught});

    // ── 大厅列表真人计数 ──
    const lo = reg(empty(await connect(PORT)));
    const rooms = await new Promise(res => { lo.cl.once('rooms', r => res(r||[])); lo.cl.emit('listRooms'); });
    const row = rooms.find(x=>x.code===code);
    T('房间列表 humans=2（甲+丙）', !!row && row.humans===2, row);

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