/* =========================================================
 * 通山打拱 · AI 补位开局集成测试（Node）
 * 场景：房主勾选 AI 补位、点【开始对局】→ 用 AI 补位立即开局；
 *       其他玩家无法再进入；游戏（含 AI 座位）正常进行。
 * 依赖：服务端已在本机 8080 运行。
 * 运行：node tests/aifill.js
 * ========================================================= */
"use strict";
const { io } = require('socket.io-client');
const TS = require('../js/engine.js');
const TSAI = require('../js/ai.js');
const ROOM = 'AF' + String(Math.floor(Math.random()*100)).padStart(2,'0');
let pass=0, fail=0;
const T=(n,c,d)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(d!==undefined?' => '+JSON.stringify(d):''));} };
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function mk(name){
  const s=io('http://localhost:8080',{reconnection:false});
  let snap=null, toasts=[], actedSeq=0, decidedSeq=0, endedSeq=0;
  s.on('state',st=>{snap=st;});
  s.on('joined',d=>{s.seat=d.seat;});
  s.on('toast',m=>toasts.push(m));
  s.emitEv=(ev,d)=>s.emit(ev,d||{});
  function poll(){
    const G=snap&&snap.G; if(!G) return;
    const seq=G.seq||G.roundNo||0; if(seq<actedSeq) return; actedSeq=seq;
    const my=s.seat; if(my<0) return;
    if(!G.ended&&G.confirming&&G.turn===my){ if(decidedSeq!==seq){decidedSeq=seq; s.emitEv('act',{type:'confirm',seat:my,choice:'pass'});} return; }
    if(!G.ended&&!G.confirming&&G.turn===my&&!G.seats[my].out){
      const ch=TSAI.aiChoose(G,my);
      if(ch&&ch.cards&&ch.cards.length) s.emitEv('act',{type:'play',seat:my,cards:ch.cards});
      else if(G.lastPlay&&G.lastPlay.type) s.emitEv('act',{type:'pass',seat:my});
      return;
    }
    if(G.ended&&endedSeq!==seq){ endedSeq=seq; if(!G.lastSeries){ s.emitEv('nextRound',{}); } else { s.emitEv('toggleReady',{}); } }
  }
  const connectReady=new Promise(res=>s.on('connect',res));
  return {s,name,get snap(){return snap;},get toasts(){return toasts;},get seat(){return s.seat;},connectReady,emit:s.emitEv,poll};
}
function drive(clist){ for(const c of clist) c.poll(); }
(async()=>{
  const p1=mk('P1'), p2=mk('P2'), p3=mk('P3');
  await Promise.all([p1.connectReady,p2.connectReady,p3.connectReady]);
  p1.emit('create',{name:'P1',code:ROOM,settings:{rounds:2}});
  await wait(300);
  p2.emit('join',{name:'P2',code:ROOM});
  await wait(300);

  // 第3人此时还允许加入（没开局）
  p3.emit('join',{name:'P3',code:ROOM});
  await wait(400);

  T('未开局时 4 人以下可加入(第3人加入成功)', p3.seat===2, {seat:p3.seat});

  // 房主：勾选 AI 补位
  p1.emit('setSettings',{aiFill:true});
  await wait(300);
  T('AI 补位开关已生效', p1.snap && p1.snap.aiFill===true, {aiFill:p1.snap&&p1.snap.aiFill});

  // 玩家2、玩家3 都准备（"其他用户已经准备"）
  p2.emit('toggleReady',{});
  p3.emit('toggleReady',{});
  await wait(300);

  // 房主点【开始对局】= 自动就绪 + 立即开局（AI 补 1 个空位）
  p1.emit('setSettings',{start:true});
  await wait(800);
  const st=p1.snap;
  T('点开始对局 → AI 补位直接开局', !!st && !!st.G && !st.G.ended, {hasG:!!(st&&st.G)});
  T('开局后 AI 座位类型为 ai', st && st.G && st.seats.filter((x,i)=>x.type==='ai').length>=1, {types:st&&st.seats.map(s=>s.type)});

  // 开局后其他人无法进入
  const p4=mk('P4'); await p4.connectReady;
  p4.emit('join',{name:'P4',code:ROOM});
  await wait(400);
  T('开局后其他玩家无法进入', (p4.seat===undefined||p4.seat<0) && /对局已开始/.test(p4.toasts.slice().reverse().join(',')), {seat:p4.seat,toast:p4.toasts});

  // 游戏正常进行：真人自动确认/出牌 + AI 自动托管，等过确认轮并出牌
  const dl=Date.now()+90000;
  let progressed=false;
  while(Date.now()<dl){
    drive([p1,p2,p3]);
    const s=p1.snap;
    if(s && s.G && !s.G.confirming && s.G.lastSeat>=0){ progressed=true; break; }
    await wait(200);
  }
  T('AI 补位的对局正常进行（已过确认轮并出牌）', progressed, {confirming:p1.snap&&p1.snap.G&&p1.snap.G.confirming, lastSeat:p1.snap&&p1.snap.G&&p1.snap.G.lastSeat});

  // 接下来 AI 把整局打完：等 G.ended 或超时
  const dl2=Date.now()+150000;
  let ended=false;
  while(Date.now()<dl2){
    drive([p1,p2,p3]);
    const s=p1.snap;
    if(s && s.G && s.G.ended){ ended=true; break; }
    await wait(250);
  }
  T('AI 补位对局最终打完本局', ended, {ended:!!(p1.snap&&p1.snap.G&&p1.snap.G.ended)});

  [p1,p2,p3,p4].forEach(c=>{try{c.s.close();}catch(_){}});
  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail?1:0);
})();