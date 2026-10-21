/* =========================================================
 * 通山打拱 · 界面逻辑（南家=玩家，其余三家 AI）
 * ========================================================= */
(function(){
"use strict";
const TS=window.TS, TSAI=window.TSAI;

let G=null;
let selected=new Set();      // 手牌真实下标
let hintCursor=0, hintList=[];
let total=[0,0,0,0];         // 累计分
let sortMode=0;              // 0=点数降序(王最左), 1=炸前置
const $=id=>document.getElementById(id);

// 判断某张牌是否属于已成型炸（用于"炸前置"排序）：
//   同点数真牌≥4 → 同牌炸；王不作癞子凑炸，单独一组跟在炸后
function isBombCandidate(c, cnt){ if(c.j) return false; return cnt[c.r]>=4; }
// 手牌排序 key（点数降序：2 在最左；王在最左）
function handKey(c){ return c.j ? -1 : (TS.RANKS.length-1 - c.r); }
// 五十K 点数位（5=2, 10=7, K=10）
const R5=2, R10=7, RK=10;
// 手牌排序：炸前置时只把"恰好能组成五十K 的那几张"(5/10/K各取min张)前置，
// 多余的 5/10/K 仍按普通牌处理
function buildKindMap(hand){
  const cnt=new Array(TS.RANKS.length).fill(0);
  for(const c of hand){ if(!c.j) cnt[c.r]++; }
  const groups = Math.min(cnt[R5], cnt[R10], cnt[RK]); // 最多能组的五十K 数量
  const used={[R5]:0,[R10]:0,[RK]:0};
  const kind=new Map();
  for(const c of hand){
    if(c.j){ kind.set(c.id, 2); continue; }        // 王
    if((c.r===R5||c.r===R10||c.r===RK) && used[c.r]<groups){
      used[c.r]++; kind.set(c.id, 0); continue;     // 前 groups 张 5/10/K → 五十K
    }
    if(cnt[c.r]>=4){ kind.set(c.id, 1); continue; } // 同牌炸
    kind.set(c.id, 3);                              // 普通
  }
  return {cnt, kind};
}
// 同点数炸的强度：张数多者大；同张数比点数（2 最大）
function bombSize(c, cnt){ return cnt[c.r]; }
function sortHandCards(){
  const s=G.seats[0];
  const {cnt, kind}=buildKindMap(s.hand);
  const idx=s.hand.map((c,i)=>i);
  if(sortMode===0){
    // 点数降序：2..3，王恒最左
    idx.sort((a,b)=>{
      const ka=handKey(s.hand[a]), kb=handKey(s.hand[b]);
      return ka-kb || (s.hand[a].id<s.hand[b].id?-1:1);
    });
    return idx;
  }
  // 炸前置：五十K(0) → 同牌炸(1) → 王(2) → 普通(3)
  idx.sort((a,b)=>{
    const ca=s.hand[a], cb=s.hand[b];
    const ka=kind.get(ca.id), kb=kind.get(cb.id);
    if(ka!==kb) return ka-kb;
    if(ka===2) return ca.id<cb.id?-1:1;      // 王之间保持稳定
    if(ka===0||ka===1){
      if(ka===0) return handKey(ca)-handKey(cb);  // 五十K 组内按点数
      const sa=bombSize(ca,cnt), sb=bombSize(cb,cnt);
      if(sa!==sb) return sb-sa;              // 同牌炸：张数多的在前
      return handKey(ca)-handKey(cb);        // 同张数比点数（大点在前）
    }
    const ra=handKey(ca), rb=handKey(cb);
    return ra-rb || (ca.id<cb.id?-1:1);
  });
  return idx;
}

/* ---------- 开局 / 续局 ---------- */
function newRound(opts){
  opts=opts||{};
  const seed=(Math.random()*1e9)|0;
  G=TS.newGame(seed);
  if(opts.landlord!=null && opts.roundNo){ G.roundNo=opts.roundNo; TS.pickLandlord(G,opts.landlord); }
  selected=new Set(); hintCursor=0; hintList=[];
  logClear();
  log(`—— 第 ${G.roundNo} 局（种子 ${G.seed}）——`);
  const L=G.seats[G.landlord];
  log(`庄家 ${L.name}，叫牌 ${TS.cardName(G.called)}，对家 ${G.seats[G.partner].name}（明鸡）`);
  render();
  step();
}
function continueNext(){
  const nextLandlord=G.firstOut;   // 由一游叫下一局
  const nextRound=G.roundNo+1;
  newRound({landlord:nextLandlord, roundNo:nextRound});
}

/* ---------- 回合推进 ---------- */
let aiTimer=null;
function step(){
  if(G.ended){ finish(); return; }
  setBtn(false);
  if(G.confirming){
    render();
    if(G.turn===0){ enableConfirm(); return; }
    aiConfirm();  // AI 自动表态
    return;
  }
  render();
  if(G.turn===0){ enablePlayer(); }
  else { scheduleAI(); }
}

/* 确认轮：AI 自动表态（小概率明独 / 无炸小概率毁牌 / 否则不明独） */
function aiConfirm(){
  clearTimeout(aiTimer);
  aiTimer=setTimeout(()=>{
    if(G.ended||!G.confirming) return;
    const seat=G.turn;
    const hasBomb=TS.handHasBomb(G.seats[seat].hand);
    if(G.rnd()<0.08 && !hasBomb){
      const fresh=TS.declareRestart(G);
      if(fresh && fresh!==G){
        log(`${G.seats[seat].name} 选择【毁牌】（无炸，本局重发）`);
        G=fresh;
        selected.clear(); render(); step();
        return;
      }
    }
    if(G.rnd()<0.05 && seat===G.landlord){
      TS.confirmChoice(G,seat,'mingdu');
      log(`${G.seats[seat].name} 选择【明独】，将先出牌 1打3`);
    } else {
      TS.confirmChoice(G,seat,'pass');
      log(`${G.seats[seat].name} 选择【不明独】`);
    }
    step();
  }, 550);
}
/* 确认轮：玩家表态按钮（无炸→毁牌 / 明独 / 不明独） */
function enableConfirm(){
  const seat=G.turn;
  const hasBomb=TS.handHasBomb(G.seats[seat].hand);
  $('btnHe').style.display = hasBomb ? 'none' : 'inline-block';  // 只有无炸才给毁牌
  $('btnHard').style.display = 'inline-block';  // 明独
  $('btnPass').disabled=false; $('btnPass').textContent='不明独';
  $('btnHint').style.display='none';
  $('btnPlay').disabled=true;
}
function playerConfirmMingdu(){ // 明独（硬牌，先出）
  if(!G.confirming||G.turn!==0) return;
  TS.confirmChoice(G,0,'mingdu');
  log('你选择【明独】，你将先出牌、1打3');
  step();
}
function playerConfirmPass(){ // 不明独（正常参加）
  if(!G.confirming||G.turn!==0) return;
  TS.confirmChoice(G,0,'pass');
  log('你选择【不明独】');
  step();
}
// 无炸毁牌：本局作废重发
function playerHe(){
  if(!G.confirming||G.turn!==0) return;
  const fresh=TS.declareRestart(G);
  if(fresh && fresh!==G){
    log('你选择【毁牌】（手牌无炸，本局重发）');
    G=fresh;
    selected.clear();
    render(); step();
  }
}

function scheduleAI(){
  clearTimeout(aiTimer);
  aiTimer=setTimeout(()=>{
    if(G.ended) return;
    const seat=G.turn;
    if(G.seats[seat].out){ TS.advanceTurn(G); step(); return; }
    const ch=TSAI.aiChoose(G,seat);
    if(ch===null){ TS.handlePass(G,seat); log(`${G.seats[seat].name} 不出`); step(); return; }
    const r=TS.doPlay(G,seat,ch.cards);
    afterPlay(seat,r,ch.cards);
  }, 650);
}

/* ---------- 玩家操作 ---------- */
function enablePlayer(){
  const mine=G.turn===0 && !G.ended;
  $('btnPlay').disabled = !mine;
  $('btnPass').disabled = !mine || !G.lastPlay;    // 首出必须出牌
  $('btnPass').textContent = '不要';
  $('btnHard').style.display = 'none';
  $('btnHe').style.display='none';
  $('btnHint').style.display='inline-block';
}
function setBtn(on){
  $('btnPlay').disabled=!on; $('btnPass').disabled=!on;
  $('btnHard').style.display='none';
  $('btnHe').style.display='none';
  $('btnHint').style.display='none';
}
function playerPlay(){
  if(G.ended||G.turn!==0) return;
  const cards=[...G.seats[0].hand].filter((c,i)=>selected.has(i));
  if(cards.length===0){ flashMsg('请先选牌'); return; }
  const r=TS.doPlay(G,0,cards);
  afterPlay(0,r,cards);
}
function playerPass(){
  // 确认轮时此按钮为「确定」
  if(G.confirming){ playerConfirmPass(); return; }
  if(!G.lastPlay||G.turn!==0) return;
  TS.handlePass(G,0);
  log('你 不出');
  selected.clear(); render();
  step();
}
function playerHint(){
  if(G.ended||G.seats[0].out||G.turn!==0) return;
  hintList=TSAI.genCandidates(G.seats[0].hand, G.lastPlay||null);
  if(hintList.length===0){ flashMsg('没有能压的牌'); return; }
  hintCursor=(hintCursor+1)%hintList.length;
  const cand=hintList[hintCursor];
  const ids=new Set(cand.cards.map(c=>c.id));
  selected.clear();
  G.seats[0].hand.forEach((c,i)=>{ if(ids.has(c.id)) selected.add(i); });
  render();
  flashMsg(describeShort(cand.play));
}
function playerHard(){
  playerConfirmMingdu();
}
// 和牌：本局作废重发
function playerHe(){
  if(!G.confirming||G.turn!==0) return;
  const fresh=TS.declareRestart(G);
  if(fresh && fresh!==G){
    log('你选择和牌（本局重发）');
    G=fresh;
    selected.clear();
    render(); step();
  }
}
function toggleSort(){
  sortMode=1-sortMode;
  render();
  const label=$('btnSort');
  flashMsg(sortMode===0?'按点数降序（2 最左，王最左）':'炸前置（炸→王→普通，大点在前）');
}

/* ---------- 出牌后处理 ---------- */
function afterPlay(seat,r,cards){
  if(!r.ok){ flashMsg(r.why); render(); return; }
  // 只有玩家自己出牌后清空预选；其他人出牌保留玩家的预选（不因重绘缩回）
  if(seat===0) selected.clear();
  if(seat===0) log(`你出 ${playDesc(cards)}`);
  else log(`${G.seats[seat].name} 出 ${playDesc(cards)}`);
  if(r.end){ finish(); return; }
  step();
}

function playDesc(cards){
  const p=TS.analyzePlay(cards);
  if(!p) return '';
  const names=cards.map(c=>TS.cardName(c)).join(' ');
  let fn;
  if(p.type==='rollcage') fn=`滚笼 ${p.s}×${p.k}（${p.soft?'软':'硬'} ${p.fan}番）`;
  else if(p.type==='bomb') fn=(p.fan>0?`${p.size}张同牌炸 ${p.fan}番`:`${p.size}张无番炸`);
  else if(p.type==='fiftyK') fn=(p.tonghua?`五十K(${TS.SUIT_CH[p.suit]}):`:'杂五十K');
  else if(p.type==='kingBomb') fn=`王炸 ${p.fan}番`;
  else fn=p.type;
  return `【${fn}】${names}`;
}
function describeShort(p){
  if(p.type==='rollcage') return `滚笼 ${p.s}×${p.k}（${p.soft?'软':'硬'} ${p.fan} 番）`;
  if(p.type==='bomb') return `${p.size} 张炸（${p.fan} 番）`;
  if(p.type==='fiftyK') return p.tonghua?'五十K（同花）':'杂五十K';
  if(p.type==='kingBomb') return `王炸（${p.fan} 番）`;
  return p.type;
}

/* ---------- 渲染 ---------- */
function render(){
  if(!G) return;
  renderSeats(); renderHand(); renderCenter(); renderTop();
}
function renderTop(){
  $('lblMode').textContent = G.mode==='hard'?(`硬牌 · ${G.seats[G.hardSeat].name}`):'2V2';
  $('lblRound').textContent=`第 ${G.roundNo} 局`;
}
function seatTag(i){
  if(G.mode==='hard') return i===G.hardSeat?'硬':'客';
  if(i===G.landlord) return '主';
  if(i===G.partner) return (G.revealed?'对':'客');
  return '客';
}
function renderSeats(){
  for(let i=0;i<4;i++){
    const s=G.seats[i];
    const el=document.querySelector(`.seat[data-seat="${i}"]`); if(!el) continue;
    el.classList.toggle('active', G.turn===i && !G.ended);
    $('nm'+i).textContent = i===0?'南家（你）':s.name;
    // 名字右侧标记：地主始终显示叫的牌；明鸡出后，对家显示明鸡标记、另两家相同标记（同队）
    const calledMiniHtml = (G.called && !s.out)
      ? '<span class="calledMini">' + cardHTML({j:false,r:G.called.r,s:G.called.s},'mini') + '</span>' : '';
    if(G.mode==='hard'){
      // 硬牌：明独者一家，另外三家同队
      $('tag'+i).innerHTML = seatTag(i) + (i===G.hardSeat?'':'<span style="color:#a8c8b8">同队</span>');
    } else if(i===G.landlord){
      // 地主名字右侧：叫的牌
      $('tag'+i).innerHTML = seatTag(i) + calledMiniHtml;
    } else if(G.revealed && i===G.partner){
      // 明鸡已出：出明鸡牌的人（对家）名字右侧标记
      $('tag'+i).innerHTML = seatTag(i) + calledMiniHtml + '<span style="color:#ffe9b0">明</span>';
    } else if(G.revealed){
      // 明鸡已出：另外两家显示相同标记（同队）
      $('tag'+i).innerHTML = seatTag(i) + '<span style="color:#a8c8b8">同队</span>';
    } else {
      $('tag'+i).textContent = seatTag(i);
    }
    const pEl=$('p'+i); if(!pEl) continue;
    const rollN=s.rollcages.length;
    const rollFan=s.rollcages.reduce((a,r)=>a+r.fan,0);
    pEl.textContent =
      (i!==0?('手牌 '+s.hand.length+' 张 · '):'')+
      '抓分 '+s.caught+
      (rollN>0?(` · 番炸 ${rollN}次/共${rollFan}番`):'')+
      (s.out?(' · '+['一','二','三','四'][s.outOrder-1]+'游'):'')+
      (G.mode==='hard'&&i===G.hardSeat?' · 硬牌':'');
    // AI 手牌背面（南家手牌由 renderHand 在牌桌南侧渲染）
    if(i!==0){
      const h=$('h'+i); h.innerHTML='';
      const n=Math.min(s.hand.length,15);
      for(let k=0;k<n;k++){ const d=document.createElement('div'); d.className='backCard'; h.appendChild(d); }
      if(s.hand.length>15){ const sp=document.createElement('span'); sp.textContent='+'+(s.hand.length-15); h.appendChild(sp); }
    }
    // 出牌区：显示该家上一手或"不要"记号，牌像手牌一样叠放，每排最多 7 张
    const tr=$('t'+i); tr.innerHTML='';
    if(i===G.turn && !G.ended){
      // 即将出牌的这家：不显示它之前出的牌或进行的选择，留淡"待出"
      const d=document.createElement('div');
      d.textContent='…';
      d.style.cssText='color:#9db8aa;font-size:13px;padding:10px 0;';
      tr.appendChild(d);
    } else if(s.choice){
      // 确认轮选择：桌面上只显示文字（不带牌形方框）
      const d=document.createElement('div');
      d.textContent = s.choice==='mingdu' ? '明独' : '不明独';
      d.style.cssText = s.choice==='mingdu'
        ? 'color:#ff9d8a;font-size:15px;font-weight:bold;padding:8px 0;'
        : 'color:#d9e8e0;font-size:14px;padding:8px 0;';
      tr.appendChild(d);
    } else if(s.out){
      // 已出局：无牌显示
    } else if(s.passed){
      // 过牌：桌面上只显示"不要"文字（与选择文字一样，无背景盒）
      const d=document.createElement('div');
      d.textContent='不要';
      d.style.cssText='color:#ffb39a;font-size:17px;font-weight:bold;padding:8px 0;';
      tr.appendChild(d);
    } else if(s.lastCards&&s.lastCards.length){
      const ROW=7;
      const rows=Math.ceil(s.lastCards.length/ROW);
      // 判断这手是否为有番数的炸（滚笼/王炸/7-8张番炸），右下角标番数
      const pPlay = TS.analyzePlay(s.lastCards);
      const showFan = pPlay && (
        pPlay.type==='rollcage' || pPlay.type==='kingBomb' ||
        (pPlay.type==='bomb' && pPlay.fan>0)
      );
      for(let ri=0;ri<rows;ri++){
        const row=document.createElement('div');
        row.className='trickRow';
        s.lastCards.slice(ri*ROW,(ri+1)*ROW).forEach(c=>{ row.insertAdjacentHTML('beforeend', cardHTML(c,'mini')); });
        tr.appendChild(row);
      }
      // 有番数的炸：在最后一张牌的右下角显示番数
      if(showFan && s.lastCards.length){
        const lastCard=tr.querySelector('.trickRow:last-child .card:last-child');
        if(lastCard){
          const badge=document.createElement('span');
          badge.textContent = `${pPlay.fan}番`;
          badge.className='fanBadge';
          lastCard.appendChild(badge);
        }
      }
    }
  }
  const msg=$('msg');
  if(!G.ended){
    msg.textContent = G.turn===0 ? '轮到你了'
      : `轮到 ${G.seats[G.turn].name}（${['南','东','北','西'][G.turn]}家）`;
    if(G.mode!=='hard'){
      msg.textContent += G.revealed
        ? ` · 对家已明：${G.seats[G.partner].name}`
        : ` · 对家未明（叫牌 ${TS.cardName(G.called)}）`;
    } else {
      msg.textContent += ` · ${G.seats[G.hardSeat].name} 硬牌 1打3`;
    }
  } else {
    msg.textContent='本局结束';
  }
  renderCorner();
}
function renderCorner(){
  // 牌桌左上角：叫牌（迷你牌显示）+ 明鸡状态
  const c=$('corner'); if(!c) return;
  c.innerHTML='';
  const mkChip=(label,val)=>`<div class="cornerRow"><span style="color:#a8c8b8">${label}</span><b>${val||'—'}</b></div>`;
  c.innerHTML += mkChip('叫牌', G.mode==='hard'?'硬牌':(G.called?TS.cardName(G.called):'—'));
  // 叫牌那张牌用迷你牌同手牌样式显示
  if(G.mode!=='hard' && G.called){
    const fake={j:false,r:G.called.r,s:G.called.s};
    c.innerHTML+=`<div class="cornerRow">${cardHTML(fake,'mini')}<span>${G.seats[G.landlord].name} 叫</span></div>`;
  }
  c.innerHTML += mkChip('明鸡', G.mode==='hard'?'—':(G.revealed?`已出 · ${G.seats[G.partner].name}`:'未出'));
  c.innerHTML += mkChip('庄家', G.mode==='hard'?G.seats[G.hardSeat].name:G.seats[G.landlord].name);
}
function cardHTML(c,cls){
  if(c.j) return `<div class="card jk ${cls||''}"><span class="tl">王</span><span class="br">王</span><span class="ctr">王</span></div>`;
  const red=(c.s===1||c.s===3)?' red':'';
  const rn=TS.RANKS[c.r], ch=TS.SUIT_CH[c.s];
  return `<div class="card${red} ${cls||''}">`+
    `<span class="tl">${rn}<br>${ch}</span><span class="br">${rn}<br>${ch}</span><span class="ctr">${ch}</span></div>`;
}
// 渲染一手牌（扇形叠放，只读——观战队友牌用）
function renderCardFan(handEl, cards){
  const order=[...cards].sort((a,b)=>handKey(a)-handKey(b));
  order.forEach(c=>{
    const el=document.createElement('div');
    let cls='hcard';
    if(G.mode!=='hard' && G.called && !c.j && c.r===G.called.r && c.s===G.called.s) cls+=' calledMark';
    el.className=cls;
    el.innerHTML=cardHTML(c);
    handEl.appendChild(el);
  });
}
function renderHand(){
  const s=G.seats[0];
  const handEl=$('hand'); handEl.innerHTML='';
  if(s.out){
    // 本家已出完：显示队友（对家）手牌，与自家同样的叠放样式，只读
    let show=null;
    if(G.mode!=='hard'){
      show = G.landlord===0 ? G.partner : (G.partner===0 ? G.landlord : null);
    }
    if(show!=null && !G.seats[show].out){
      const hs=G.seats[show];
      const cap=document.createElement('div');
      cap.textContent=`观战 · 队友 ${hs.name} 的手牌（只读）`;
      cap.style.cssText='color:#a8c8b8;font-size:12px;margin-bottom:6px;text-align:center;';
      handEl.appendChild(cap);
      renderCardFan(handEl, hs.hand);
    } else {
      const d=document.createElement('div'); d.textContent='已出局'; d.style.cssText='padding:24px;color:#a8c8b8;font-size:14px;'; handEl.appendChild(d);
    }
    return;
  }
  const order=sortHandCards();
  order.forEach(idx=>{
    const c=s.hand[idx];
    const el=document.createElement('div');
    let cls='hcard'+(selected.has(idx)?' sel':'');
    // 本家手里的明鸡牌标记（叫牌）
    if(G.mode!=='hard' && G.called && !c.j && c.r===G.called.r && c.s===G.called.s) cls+=' calledMark';
    el.className=cls;
    el.innerHTML=cardHTML(c);
    el.onclick=()=>{ if(G.ended) return; if(selected.has(idx)) selected.delete(idx); else selected.add(idx); el.classList.toggle('sel',selected.has(idx)); };
    handEl.appendChild(el);
  });
  const btn=$('btnSort');
  if(btn) btn.textContent = sortMode===0?'排序：点数':'排序：炸前置';
}
function renderCenter(){
  $('trickScore').textContent=`本轮分数 ${G.trickPoints} 分` + (G.lastSeat>=0?` · ${G.seats[G.lastSeat].name} 压着`:'');
}

/* ---------- 结算 ---------- */
function finish(){
  const s=TS.settleRound(G);
  for(let i=0;i<4;i++) total[i]+=s.perFen[i];
  log(`—— 结算：${G.mode==='hard'?'硬牌·基础每人 2 番':'2V2·基础每人 '+s.basePer+' 番'}，滚笼 Δ=${s.delta}（W=${s.W},L=${s.L}）——`);
  log(`  ${s.winnerSeats.map(i=>G.seats[i].name).join('、')} 胜｜${s.loserSeats.map(i=>G.seats[i].name).join('、')} 负`);

  const tb=$('mTable');
  $('mTitle').textContent = `本局结束 · ${G.mode==='hard'
    ? `硬牌者 ${G.seats[G.hardSeat].name} ${s.winnerSeats.includes(G.hardSeat)?'胜':'败'}`
    : `赢${s.winnerSeats.map(i=>G.seats[i].name).join('、')}`}`;
  tb.innerHTML=`<tr><th>座位</th><th>身份</th><th>名次</th><th>本局(番)</th><th>本局(分)</th><th>累计(分)</th></tr>`;
  for(let i=0;i<4;i++){
    const sv=s.perSeat[i], fv=s.perFen[i];
    const o=G.seats[i].outOrder;
    const rank = o>=1 ? ['一','二','三','四'][o-1]+'游' : (s.winnerSeats.includes(i)?'胜':'负');
    tb.innerHTML+=`<tr><td>${['南','东','北','西'][i]}家 ${G.seats[i].name}</td>`+
      `<td>${seatTag(i)}</td><td>${rank}</td><td>${sv>0?'+':''}${sv}</td><td>${fv>0?'+':''}${fv}</td><td>${total[i]}</td></tr>`;
  }
  tb.innerHTML+=`<tr><td colspan="6" class="note">半番=1分（1番=2分）· 滚笼归属：跑完归本队、未跑归对方 · Δ不封底</td></tr>`;
  $('modal').hidden=false;
  setBtn(false);
  render();
}
$('btnClose').onclick=()=>{ $('modal').hidden=true; continueNext(); };
$('btnNew').onclick=()=>{ total=[0,0,0,0]; newRound(); };

$('btnPlay').onclick=playerPlay;
$('btnPass').onclick=playerPass;
$('btnHint').onclick=playerHint;
$('btnSort').onclick=toggleSort;
$('btnHard').onclick=playerHard;
$('btnHe').onclick=playerHe;

/* ---------- 工具 ---------- */
function log(msg){ const el=$('log'); const d=document.createElement('div'); d.textContent=msg; el.appendChild(d); el.scrollTop=el.scrollHeight; }
function logClear(){ $('log').innerHTML=''; }
function flashMsg(m){ $('msg').textContent=m; }

newRound();
})();