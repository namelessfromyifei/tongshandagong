/* =========================================================
 * 通山打拱 · 多人联机流程集成测试（Node）
 * 场景：4 个"真人"客户端 创建房间 → 全员准备自动开局 →
 *   AI 托管打完本局 → 非最后一局点【下一局】自动就绪，全员就绪自动下一局；
 *   最后一局不自动准备，改手动【准备】开新一场。
 * 依赖：服务端已在本机 8080 运行。
 * 运行：node tests/multiplayer.js
 * ========================================================= */
"use strict";
const { io } = require('socket.io-client');
const TS = require('../js/engine.js');
const TSAI = require('../js/ai.js');

const URL = process.env.URL || 'http://localhost:8080';
const ROOM = 'QA' + String(Math.floor(Math.random()*100)).padStart(2,'0');
const NAMES = ['P1','P2','P3','P4'];
const ROUNDS = 3;

let pass=0, fail=0;
const T=(n,c,d)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(d!==undefined?' => '+JSON.stringify(d):''));} };
const wait=ms=>new Promise(r=>setTimeout(r,ms));

/* ---------- 客户端 ---------- */
function makeClient(name){
  const s = io(URL, { reconnection:false });
  let mySeat=-1, snap=null, actedSeq=0, decidedSeq=0, endedSeq=0;
  let seenRound=false, nullReadied=false;
  s.on('joined', d=>{ mySeat=d.seat; });
  s.on('state', st=>{ snap=st; });
  s.on('toast', ()=>{});
  const emit=(ev,data)=>s.emit(ev,data||{});
  function poll(){
    const st=snap; if(!st) return;
    const G=st.G;
    if(!G){
      // 一场结束（G 已清空）：手动【准备】开新场；开局前的 G 空则不触发
      if(seenRound && !nullReadied){ nullReadied=true; emit('toggleReady',{}); }
      return;
    }
    seenRound=true;
    const seq=G.seq||G.roundNo||0;
    if(seq<actedSeq) return;
    actedSeq=seq;
    if(mySeat<0) return;
    if(!G.ended && G.confirming && G.turn===mySeat){
      if(decidedSeq!==seq){ decidedSeq=seq; emit('act',{type:'confirm',seat:mySeat,choice:'pass'}); }
      return;
    }
    if(!G.ended && !G.confirming && G.turn===mySeat && !G.seats[mySeat].out){
      const ch=TSAI.aiChoose(G, mySeat);
      if(ch && ch.cards && ch.cards.length) emit('act',{type:'play',seat:mySeat,cards:ch.cards});
      else if(G.lastPlay && G.lastPlay.type) emit('act',{type:'pass',seat:mySeat});
      return;
    }
    if(G.ended && endedSeq!==seq){
      // 等"已结算"快照（ready 已重置为全 false）再动作，与真实玩家节奏一致
      if(st.ready && st.ready.some(Boolean)) return;
      endedSeq=seq;
      // 服务器已标好是否本场最后一局
      if(!G.lastSeries) emit('nextRound',{}); // 非最后一局：点【下一局】= 自动就绪
      // 最后一局：不自动准备，稍后手动【准备】
    }
  }
  const readyOnce=()=>emit('toggleReady',{});
  const connectReady=new Promise(res=>s.on('connect',res));
  return { s, get mySeat(){return mySeat;}, get snap(){return snap;}, emit, poll, readyOnce, connectReady, seenRound:()=>seenRound };
}

/* ---------- 主流程 ---------- */
(async ()=>{
  let p1, clients=[];
  try{
    p1=makeClient('P1'); await p1.connectReady;
    p1.emit('create',{name:'P1', code:ROOM, settings:{rounds:ROUNDS}});
    await wait(400);
    for(let i=1;i<4;i++){
      const c=makeClient(NAMES[i]); await c.connectReady;
      c.emit('join',{name:NAMES[i], code:ROOM});
      clients.push(c);
    }
    clients.unshift(p1);
    await wait(500);

    // 观察器：确定性捕获"一场最后一局结束、G 清空那一刻"的 ready 状态 + 统计局末
    let captReady=null, captDone=false, seenEnd3=false;
    const endedIds=new Set();
    p1.s.on('state', st=>{
      if(st.G && st.G.ended){ endedIds.add(st.G.seq||st.G.roundNo||0); if((st.G.seq||0)>=ROUNDS) seenEnd3=true; }
      if(seenEnd3 && !st.G && st.series && !st.series.active && st.ready && !captDone){
        captDone=true; captReady=st.ready.slice();
      }
    });

    // 全员准备 → 第一场自动开局
    clients.forEach(c=>c.readyOnce());
    await wait(1500);
    const st0=clients[0].snap;
    T('开局：全员准备自动开局', !!st0 && !!st0.G && (st0.G.seq||0)>=1 && !!st0.G.confirming);

    // 轮询驱动整场（seq 到 4 = 手动准备开出的新场第一局）
    let p1seq=0, endSeen=0, lastEnd=0, sawClear=0;
    const dl=Date.now()+240000;
    while(Date.now()<dl){
      // 先读状态，再驱动（保证捕获到 G 清空瞬间）
      const st=p1.snap;
      if(st){
        if(st.G){
          const sq=st.G.seq||st.G.roundNo||0;
          if(sq>p1seq) p1seq=sq;
          if(st.G.ended && sq!==lastEnd){ lastEnd=sq; endSeen++; }
        } else if(st.series && !st.series.active){ sawClear=1; }
      }
      for(const c of clients) c.poll();
      if(p1seq>=ROUNDS+1) break;
      await wait(110);
    }
    T('三局打完 + 手动准备开新场第一局（seq达到4）', p1seq>=ROUNDS+1, {p1seq});
    T('观察到 3 次局末结算', endedIds.size>=ROUNDS, {endedIds:[...endedIds]});
    T('场结束后出现 G 清空态（等手动准备）', sawClear===1);
    T('最后一局结束后不自动准备：ready 全 false', captDone && captReady && captReady.every(r=>r===false), {captReady});

  }catch(e){
    T('流程无异常', false, String((e&&e.stack)||e));
  }
  clients.forEach(c=>c.s.close());
  if(p1){ try{ p1.s.close(); }catch(_){} }
  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail?1:0);
})();