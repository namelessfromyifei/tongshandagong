/* =========================================================
 * 通山打拱 · 规则引擎（纯逻辑，浏览器 / Node 通用）
 * 依据：claude/规格.md（2026-10-19 全量拍板）
 * 关键口径：
 *   - 滚笼等番比大小：逐级比点数，点数高者胜
 *   - 单点番炸（7/8 张同牌）等番：比点数（2 最大）
 *   - 结算：队内同输同赢、全额不除二；Δ=W−L 不封底
 *   - 王：任意组合内可癞子并指定花色，仅单出算 3
 *   - 无番炸（4/5/6 张同牌）：不能领出，只能压牌
 *   - 叫牌：庄家两张同牌在手则跳过重叫
 * ========================================================= */
(function (global) {
  "use strict";

  const RANKS = ["3","4","5","6","7","8","9","10","J","Q","K","A","2"];
  const SUIT_CH = ["♠","♥","♣","♦"];
  const SUIT_NAME = ["黑桃","红桃","梅花","方块"];
  const RANK_OF = { "3":0,"4":1,"5":2,"6":3,"7":4,"8":5,"9":6,"10":7,"J":8,"Q":9,"K":10,"A":11,"2":12 };

  function mulberry32(seed){ return function(){ seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

  // 建牌：2 副（含 4 王）+ 额外王 = 王总数 kings（默认 8）
  function buildDeck(kings){
    kings = kings||8;
    const deck=[]; let id=0;
    for(let d=0;d<2;d++){
      for(let r=0;r<RANKS.length;r++) for(let s=0;s<4;s++) deck.push({id:id++,r:r,s:s,j:false});
      deck.push({id:id++,r:-1,s:-1,j:true});
      deck.push({id:id++,r:-1,s:-1,j:true});
    }
    const extra = Math.max(0, kings-4);
    for(let i=0;i<extra;i++) deck.push({id:id++,r:-1,s:-1,j:true});
    return deck;
  }
  function shuffle(arr,rnd){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); const t=arr[i]; arr[i]=arr[j]; arr[j]=t; } return arr; }
  function deal(rnd, kings){
    const deck=shuffle(buildDeck(kings),rnd);
    const hands=[[],[],[],[]];
    for(let i=0;i<deck.length;i++) hands[i%4].push(deck[i]);
    return hands;
  }
  function cardName(c){ return c.j ? "王" : SUIT_CH[c.s]+RANKS[c.r]; }
  function pointOf(c){ if(c.j) return 0; return c.r===2?5:(c.r===7?10:(c.r===10?10:0)); }

  /* ---------- 牌型识别 ---------- */
  function analyzePlay(cards, cfg){
    if(!Array.isArray(cards)) return null;
    for(const c of cards){ if(!c || typeof c!=='object') return null; } // 防 null/原始值混入
    const n=cards.length;
    if(n===0) return null;
    cfg = cfg||{};
    // 笼数封顶：大于 cap 的炸弹番数按 cap 计算（cap=0 表示不封顶）
    const cap=Number(cfg.fanCap)||0;
    const capFan=f=>(cap>0 && f>cap)?cap:f;
    let W=0; const cnt=new Array(RANKS.length).fill(0);
    for(const c of cards){ if(c.j) W++; else cnt[c.r]++; }

    // 纯王
    if(W===n){
      // 王单出：cfg.jokerValue=3(默认)→val0；=2→val12(当2)
      const soloVal = cfg.jokerValue===2 ? 12 : 0;
      if(n===1) return {type:'single',val:soloVal};
      if(n===2) return {type:'pair',val:soloVal};
      if(n===3) return {type:'triple',val:soloVal};
      // 王炸不设 8 张上限：房间可设 10/12 王
      if(n>=4) return {type:'kingBomb',size:n,fan:capFan(2*n-4)};
      return null;
    }

    // 五十K：5+10+K，王可代任一张并指定花色（默认凑同花），不分软硬
    if(n===3){
      const real=cards.filter(c=>!c.j);
      const ranks=real.map(c=>c.r);
      if(ranks.every(r=>r===2||r===7||r===10)){
        const used=new Set(ranks);
        const missing=3-used.size;
        if(missing===W){
          const same=real.every((c,i,a)=>a[0].s===c.s);
          return {type:'fiftyK',tonghua:same,suit:same?real[0].s:-1};
        }
      }
    }

    // 五十K大炸：5/10/K 三类各 t 张（t≥4，三类同步加），王可代任一类
    // 软=2 笼、硬=4 笼；每升一级（t+1）番数翻倍
    if(n>=12 && n%3===0){
      const t=n/3, r5=2, r10=7, rK=10;
      if(cnt[r5]>t||cnt[r10]>t||cnt[rK]>t){
        // 某类真牌超过 t：不构成（无法同步）
      } else {
        const deficit=(t-cnt[r5])+(t-cnt[r10])+(t-cnt[rK]);
        // 除三类外不得有真牌；缺口必须正好由王补齐
        const other=cnt.reduce((a,v,ri)=>(ri===r5||ri===r10||ri===rK)?a:a+v,0);
        if(other===0 && W===deficit){
          const soft=W>0;
          const fan=capFan((soft?2:4)*Math.pow(2,t-4));
          return {type:'fiftyCage',t:t,size:n,soft:soft,fan:fan,top:rK};
        }
      }
    }

    // 同点数（含癞子）：单/对/三条/同牌炸
    let nr=0, r0=-1;
    for(let i=0;i<RANKS.length;i++) if(cnt[i]>0){ nr++; r0=i; }
    if(nr===1 && cnt[r0]+W===n){
      if(n===1) return {type:'single',val:r0};
      if(n===2) return {type:'pair',val:r0};
      if(n===3) return {type:'triple',val:r0};
      // 同点数炸不设 8 张上限：8 张真牌 + 癞子可凑成 9 张以上（9 张起必为软炸）
      // 番数：4-6 张无番；7 张起每多一张翻倍（7→1/2、8→2/4、9→4/8…，软/硬）
      if(n>=4) return {type:'bomb',size:n,rank:r0,soft:W>0,fan:capFan(n<=6?0:Math.pow(2,n-7)*(W>0?1:2))};
      return null;
    }

    // 链：连对/飞机（不含 2）；滚笼为环形（可跨 A−2，2 与 3 也相邻）
    // 优先判滚笼（炸），再判连对/飞机——含王的牌常可同时凑两种，按更大的炸计
    for(let s=4;s<=8;s++){
      if(n%s!==0) continue;
      const k=n/s; if(k<2) continue;
      for(let st=0; st<RANKS.length; st++){
        if(checkChainRing(cnt,W,st,k,s)){
          const soft=W>0;
          return {type:'rollcage',s:s,k:k,start:st,len:k,top:(st+k-1)%RANKS.length,soft:soft,fan:capFan(soft?Math.pow(2,(s-4)+(k-2)):2*Math.pow(2,(s-4)+(k-2)))};
        }
      }
    }
    for(let s=2;s<=3;s++){
      if(n%s!==0) continue;
      const k=n/s; if(k<2) continue;
      for(let st=0; st+k-1<=11; st++){
        if(checkChain(cnt,W,st,k,s)) return s===2?{type:'seqPair',start:st,len:k,top:st+k-1}:{type:'airplane',start:st,len:k,top:st+k-1};
      }
    }
    return null;
  }

  // 线性链（连对/飞机，不含 2）
  function checkChain(cnt,W,start,k,s){
    let deficit=0;
    for(let i=0;i<k;i++){
      const r=start+i;
      if(cnt[r]>s) return false;
      deficit += s-cnt[r];
    }
    for(let r=0;r<RANKS.length;r++){
      if(r<start||r>=start+k){ if(cnt[r]>0) return false; }
    }
    return deficit===W;
  }
  // 环形链（滚笼）：点数可环绕，2(12) 与 3(0) 相邻
  function checkChainRing(cnt,W,start,k,s){
    let deficit=0;
    const inChain=new Array(RANKS.length).fill(false);
    for(let i=0;i<k;i++){
      const r=(start+i)%RANKS.length;
      inChain[r]=true;
      if(cnt[r]>s) return false;
      deficit += s-cnt[r];
    }
    for(let r=0;r<RANKS.length;r++){
      if(!inChain[r] && cnt[r]>0) return false;
    }
    return deficit===W;
  }

  /* ---------- 炸弹分级 / 比较 ---------- */
  function bombTier(p){
    if(p.type==='fiftyK') return 0;
    if(p.type==='bomb'&&p.size<=6) return 1;
    if(p.type==='bomb'||p.type==='rollcage'||p.type==='kingBomb'||p.type==='fiftyCage') return 2;
    return -1;
  }
  function isBomb(p){ return bombTier(p)>=0; }
  function groupsOf(p){
    if(p.type==='rollcage'){ const a=[]; for(let i=0;i<p.k;i++) a.push((p.start+i)%RANKS.length); return a; }
    if(p.type==='bomb') return [p.rank];
    if(p.type==='fiftyCage') return [p.top]; // 五十K大炸：按张数/番比，参与同番比较用点数兜底
    return [];
  }

  function canBeat(prev,next){
    const pb=bombTier(prev), nb=bombTier(next);
    if(pb>=0&&nb<0) return false;
    if(pb<0&&nb>=0) return true;
    if(pb<0){
      if(prev.type!==next.type) return false;
      if(prev.type==='single'||prev.type==='pair'||prev.type==='triple') return next.val>prev.val;
      if(prev.type==='seqPair'||prev.type==='airplane') return next.len===prev.len && next.top>prev.top;
      return false;
    }
    if(pb!==nb) return nb>pb;
    if(pb===0){
      if(next.tonghua!==prev.tonghua) return next.tonghua;
      if(next.tonghua&&prev.tonghua) return next.suit<prev.suit;
      return false;
    }
    if(pb===1){ if(next.size!==prev.size) return next.size>prev.size; return next.rank>prev.rank; }
    // tier2：先比番；同番王炸最大
    if(next.fan!==prev.fan) return next.fan>prev.fan;
    if(next.type==='kingBomb' && prev.type==='kingBomb') return next.size>prev.size; // 王炸同番：张数多者胜，同张数（先出为大）不可压
    if(next.type==='kingBomb'||prev.type==='kingBomb') return next.type==='kingBomb';
    // 五十K大炸同番间：张数多者（t 大）胜；同 t 先出为大
    if(next.type==='fiftyCage' && prev.type==='fiftyCage'){
      return next.t!==prev.t ? next.t>prev.t : false;
    }
    const ga=groupsOf(next), gb=groupsOf(prev);
    const m=Math.min(ga.length,gb.length);
    for(let i=0;i<m;i++){ if(ga[i]!==gb[i]) return ga[i]>gb[i]; }
    if(ga.length!==gb.length) return ga.length>gb.length;
    return false;
  }

  // 领出不限牌型：所有炸（含无番炸）都能领出（按需求放开；屋规原为无番炸不可领出）
  function legalLead(G,p){ return true; }

  /* ---------- 对局 ---------- */
  function newGame(seed, cfg){
    cfg = cfg||{};
    const rnd=mulberry32(seed>>>0);
    const hands=deal(rnd, cfg.kings||8);
    const seats=[];
    for(let i=0;i<4;i++) seats.push({
      name:['A家','B家','C家','D家'][i],
      hand:hands[i], caught:0, out:false, outOrder:0,
      isLandlord:false, isPartner:false, rollcages:[], lastCards:[], passed:false, choice:null,
      kings:0, kingPlayed:false,
    });
    // 开局统计各家王数（4+ 王奖金）与硬炸奖金（起到 7/8 张纯牌同点）
    for(const s of seats){
      s.kings = s.hand.filter(c=>c.j).length;
      s.hardBombBonus = hardBombBonusOf(s.hand);
    }
    const G={ seats, rnd, seed, cfg, mode:'2v2', hardSeat:-1,
      landlord:-1, partner:-1, called:null, revealed:false,
      turn:-1, leader:-1, lastPlay:null, lastCards:[], lastSeat:-1,
      passes:0, passSeq:0, trickPoints:0, roundNo:1,
      firstOut:-1, ended:false, started:false, log:[], playNo:0,
      confirming:true, mingduSeat:-1, confirms:[],
    };
    pickLandlord(G,null);
    return G;
  }

  function pickLandlord(G, forcedSeat){
    const seats=G.seats;
    G.landlord = forcedSeat==null ? Math.floor(G.rnd()*4) : forcedSeat;
    const L=seats[G.landlord]; L.isLandlord=true;
    let called=null, partner=-1;
    for(const c of L.hand){
      if(c.j) continue;
      for(let i=0;i<4;i++){
        if(i===G.landlord) continue;
        if(seats[i].hand.some(x=>!x.j&&x.r===c.r&&x.s===c.s)){ called=c; partner=i; break; }
      }
      if(called) break;
    }
    if(!called){ called=L.hand.filter(c=>!c.j)[0]; partner=(G.landlord+1)%4; }
    G.called={r:called.r,s:called.s};
    G.partner=partner;
    seats[partner].isPartner=true;
    G.revealed=false;
    G.mode='2v2'; G.hardSeat=-1;
    G.leader=G.landlord; G.turn=G.landlord; G.lastPlay=null; G.lastCards=[]; G.lastSeat=-1; G.passes=0; G.trickPoints=0;
    G.ended=false; G.firstOut=-1; G.started=false;
    G.confirming=true; G.mingduSeat=-1; G.confirms=[];
    G.turn=G.landlord; // 确认轮从庄家开始，各家依次表态
    for(const s of seats){ s.out=false; s.outOrder=0; s.caught=0; s.rollcages=[]; s.lastCards=[]; s.passed=false; s.choice=null; }
    return G;
  }

  // 手牌是否有任何炸（用于是否给"和牌"按钮）：含 4+同点、50K、王炸、滚笼
// 王作为癞子能补成炸的也算"有炸"（加癞子还是无炸才算无炸）
// 硬炸奖金（起到时的手牌）：同点数纯牌 7 张 → 其他三家各 1 笼；8 张 → 各 2 笼。
// 纯王不算（不统计王）；多门同时满足则累加。
function hardBombBonusOf(hand){
  const cnt=new Array(RANKS.length).fill(0);
  for(const c of hand) if(!c.j) cnt[c.r]++;
  let bonus=0;
  for(const n of cnt){ if(n>=8) bonus+=2; else if(n===7) bonus+=1; }
  return bonus;
}

function handHasBomb(hand){
  const cnt=new Array(RANKS.length).fill(0); let wilds=0;
  for(const c of hand){ if(c.j) wilds++; else cnt[c.r]++; }
  if(wilds>=4) return true;                    // 王炸
  // 同点炸：真牌 + 癞子凑满 ≥4
  for(const n of cnt) if(n>=4 || n+wilds>=4) return true;
  // 五十K：5/10/K 可用癞子补足（至少有两种点数 + 癞子凑第三种）
  const present=(cnt[2]>0?1:0)+(cnt[7]>0?1:0)+(cnt[10]>0?1:0);
  if(present>=1 && present+wilds>=3) return true;
  // 滚笼：连续两组，每组 真牌+癞子 ≥4
  for(let i=0;i+1<RANKS.length;i++) if((cnt[i]>=4||cnt[i]+wilds>=4)&&(cnt[i+1]>=4||cnt[i+1]+wilds>=4)) return true;
  return false;
}
  // 和牌/毁牌：本局作废重发（返回新的G）。
  // 必须换发牌：不能用旧 G.seed（否则重发的牌与原局一模一样）；
  // roundNo 保留（重发仍是同一局），cfg 沿用房间设置（决策 C）。
  function declareRestart(G, cfg, seed){
    if(!G.confirming) return G;
    const fresh = newGame(seed==null ? ((Math.random()*1e9)|0) : seed, cfg);
    fresh.roundNo=G.roundNo;
    fresh.log=G.log;
    return fresh;
  }

  // 确认轮：每家表态。choice: 'mingdu'|'pass'；选择在桌上展示（UI 用 s.choice）
  // 若有人选明独 → 确认轮立即结束，明独者 1 打 3 先出牌，另三家自动成队
  function confirmChoice(G, seatIdx, choice){
    if(!G.confirming) return false;
    if(seatIdx!==G.turn) return false;                    // 未轮到该家表态
    if(G.seats[seatIdx] && G.seats[seatIdx].choice) return false; // 已表态过 → 幂等拒绝（防重复/乱序）
    G.confirms.push(seatIdx);
    G.seats[seatIdx].choice = choice;
    if(choice==='mingdu' && G.mingduSeat===-1) G.mingduSeat=seatIdx;
    const endNow = (G.mingduSeat!==-1) || (G.confirms.length>=4);
    if(endNow){
      G.confirming=false; G.started=false;
      if(G.mingduSeat!==-1){
        // 明独者先出牌，1打3，另三家为一队
        G.mode='hard'; G.hardSeat=G.mingduSeat;
        G.leader=G.mingduSeat; G.turn=G.mingduSeat;
      } else {
        G.mode='2v2'; G.hardSeat=-1;
        G.leader=G.landlord; G.turn=G.landlord;
      }
      G.lastPlay=null; G.lastSeat=-1; G.passes=0;
      return true; // 确认轮结束
    }
    G.turn=nextActive(G,seatIdx);
    return true; // 表态已被接受（确认轮是否结束请看 G.confirming）
  }
  // 兼容：不语（普通参加）
  function confirmAdvance(G, seatIdx){ return confirmChoice(G, seatIdx, 'pass'); }

  function canDeclareHard(G){ return !G.ended && G.confirming && G.mode==='2v2'; }
  // 旧接口保留：直接宣布硬牌（明独）
  function declareHard(G, seatIdx){
    if(!canDeclareHard(G) && !G.confirming) return false;
    if(G.confirming){ confirmChoice(G, seatIdx, 'mingdu'); return G.confirming===false; }
    return false;
  }

  function teamOf(G,seatIdx){
    // 明独：明独者一人成队；其余三家为另一队（别再让三个对手把明独者当队友）
    if(G.mode==='hard') return seatIdx===G.hardSeat ? [G.hardSeat] : [0,1,2,3].filter(i=>i!==G.hardSeat);
    if(seatIdx===G.landlord||seatIdx===G.partner) return [G.landlord,G.partner];
    return [0,1,2,3].filter(i=>i!==G.landlord&&i!==G.partner);
  }
  function activeSeats(G){ const r=[]; for(let i=0;i<4;i++) if(!G.seats[i].out) r.push(i); return r; }

  // 按 id 规范化出牌：只认手牌里的真实对象。
  // 伪造字段({id:…,r:…}改值)、重复 id、缺 id、不在手牌、混入 null → 一律拒绝，
  // 杜绝用客户端传来的牌对象做牌型分析/扣牌（同 id 反复复制可凑炸、改 r 可改点数）。
  function canonicalizeIds(hand, cards){
    const byId=new Map(); for(const c of hand) byId.set(c.id,c);
    const seen=new Set(), out=[];
    for(const c of cards){
      const id=(c && Number(c.id));
      if(!Number.isFinite(id)) return null;
      if(seen.has(id)) return null;     // 同一张牌出现两次 → 拒绝
      const real=byId.get(id);
      if(!real) return null;            // 不在手牌 → 拒绝
      seen.add(id); out.push(real);
    }
    return out;
  }

  function doPlay(G, seatIdx, cards){
    if(G.ended) return {ok:false,why:'游戏已结束'};
    if(G.confirming) return {ok:false,why:'确认轮中，先表态'};
    if(seatIdx!==G.turn) return {ok:false,why:'还没轮到你'};
    if(!Array.isArray(cards)) return {ok:false,why:'出牌参数非法'};
    const S=G.seats[seatIdx];
    const canon=canonicalizeIds(S.hand, cards);
    if(!canon) return {ok:false,why:'你没有这些牌'};
    cards=canon;                        // 后续分析/扣牌一律用手牌里的真实对象
    const p=analyzePlay(cards, G.cfg);
    if(!p) return {ok:false,why:'不能这样出牌'};
    const isLead = !G.lastPlay; // 新一轮第一手（刚获得出牌权）
    if(G.lastPlay && !canBeat(G.lastPlay,p)) return {ok:false,why:'压不过'};
    if(isLead && !legalLead(G,p)) return {ok:false,why:'无笼炸不能领出'};
    // 获得新出牌权并打出第一手时，才清掉桌面上家出的旧牌（新一轮未出新牌前保留显示）
    if(isLead){ for(const s of G.seats){ s.lastCards=[]; s.passed=false; s.choice=null; } }
    const ids=new Set(cards.map(c=>c.id));
    S.hand=S.hand.filter(c=>!ids.has(c.id));
    S.lastCards=cards.slice();
    S.passed=false; // 本手出了牌，清掉自己残留的"不要"标记
    if(!S.kingPlayed && cards.some(c=>c.j)) S.kingPlayed=true; // 打出第一张王：触发 4+王 通知
    G.lastPlay=p; G.lastCards=cards; G.lastSeat=seatIdx; G.passes=0;
    G.playNo=(G.playNo||0)+1; // 出牌序号：供客户端语音播报去重
    if(!G.started) G.started=true; // 第一手打出：牌局真正开始
    for(const c of cards) G.trickPoints+=pointOf(c); // 本轮分数累计，圈末由最大者收走
    // 所有有番数的炸都计入 rollcages 统计（滚笼/王炸/7-8张番炸），结算归属同规则
    if(p.type==='rollcage' || p.type==='kingBomb' || (p.type==='bomb' && p.fan>0) || p.type==='fiftyCage') S.rollcages.push({fan:p.fan});
    if(!G.revealed && seatIdx===G.partner && cards.some(c=>!c.j&&c.r===G.called.r&&c.s===G.called.s)) G.revealed=true;
    if(S.hand.length===0 && !S.out){
      S.out=true;
      S.outOrder=4-activeSeats(G).length; // 先置 out 再数：第1人→4-3=1
      if(G.firstOut===-1) G.firstOut=seatIdx;
    }
    if(modeEnded(G)){
      G.ended=true;
      // 终局恰好发生在本手：最后一圈的分数此刻仍挂在 G.trickPoints，
      // 直接结给最后出牌者（当前推顶的人）——否则这手抓分永不入账，总抓分凑不满 200。
      if(G.trickPoints>0){ G.seats[G.lastSeat].caught += G.trickPoints; G.trickPoints=0; }
      return {ok:true,end:true};
    }
    advanceTurn(G);
    return {ok:true};
  }

  function modeEnded(G){
    if(G.mode==='hard'){
      if(G.seats[G.hardSeat].out) return true;
      // 任意一家（非明独者）先跑完 → 1打3结束
      if([0,1,2,3].some(i=>i!==G.hardSeat && G.seats[i].out)) return true;
      return false;
    }
    const t0=[G.landlord,G.partner];
    const t1=[0,1,2,3].filter(i=>i!==G.landlord&&i!==G.partner);
    return t0.every(i=>G.seats[i].out)||t1.every(i=>G.seats[i].out);
  }

  function nextActive(G,from){
    for(let step=1;step<=4;step++){
      const i=(from+step)%4;
      if(!G.seats[i].out) return i;
    }
    return from;
  }
  function advanceTurn(G){
    if(G.ended) return G;
    G.turn=nextActive(G,G.turn);
    if(modeEnded(G)) G.ended=true;
    return G;
  }

  function handlePass(G, seatIdx){
    if(G.ended) return false;
    G.seats[seatIdx].passed=true; // 该家本轮不要
    G.passes++;
    G.passSeq=(G.passSeq||0)+1; // 播报计数：每次"不要"递增（前端据此每次点击都播报）
    const act=activeSeats(G);
    // 一圈结束阈值：最后出牌者若已跑完（不在 act 中），则 act 里所有剩余玩家都要 pass；
    //   否则（最后出牌者仍在场）其余 act.length-1 人 pass 即结束。
    const needPass = (G.seats[G.lastSeat] && G.seats[G.lastSeat].out) ? act.length : act.length-1;
    if(G.passes>=needPass){
      const win=G.lastSeat;
      const S=G.seats[win];
      S.caught+=G.trickPoints; G.trickPoints=0;
      if(S.out){
        // 接风/顺风：最后出牌者已跑完、其余所有剩余玩家都不要时
        //   明鸡已公开 → 给队友带风（轮到队友出）；未公开 → 下家顺风
        const mate = (G.mode==='2v2') ? teamOf(G,win).find(i=>i!==win) : -1;
        if(G.mode==='2v2' && G.revealed && mate!==-1 && !G.seats[mate].out){
          G.turn=mate;
        } else {
          G.turn=nextActive(G,win);
        }
      } else {
        G.turn=win;
      }
      G.lastPlay=null; G.lastCards=[]; G.lastSeat=-1; G.passes=0;
      if(modeEnded(G)) G.ended=true;
      return false; // 新一圈（桌面旧牌保留显示，待新权人出第一手再清）
    }
    G.turn=nextActive(G,seatIdx);
    return true;
  }

  /* ---------- 结算 ----------
   * 2V2：赢队=先跑完两人；输队没跑人数∈{1,2}
   *   每人基础=半番×输方没跑人数（输方0分翻倍）
   *   滚笼 Δ=W−L（归赢队W−归输队L；打了跑完→归本队，没跑→归对方）
   *   每人=赢方 +(基础+Δ)，输方 −(基础+Δ)——队内同值，全额不除二，Δ不封底
   * 硬牌：基础每人 2 番（胜→三家各输2番；败→硬牌者向三家各输2番）
   *   滚笼按同上归属；为保持零和，硬牌者的账为三人的 3 倍
   *   即：硬牌者 ±(6+3Δ)，三家各 ∓(2+Δ)
   */
  /* 抓分归属（只影响“输方抓到 0 分翻倍”的判断，以及计分板上的展示）：
   *  - 拿到一游的那一队保留全队抓分（一游把队友抓的分也算到本队头上）
   *  - 没有一游的那一队：如果队里只剩一个人没跑完（尾游），尾游抓到的分归对面（一游）那一队。
   *    注意：尾游手里还没出的牌的分不算（那些牌没被打出来，不产生抓分）
   *  - 两队都有人没跑完（赢家一二游）时不存在“尾游”，按原值
   */
  function attributedCaught(G){
    const eff=G.seats.map(s=>s.caught);
    if(G.mode==='hard') return eff;
    const firstOut=[0,1,2,3].find(i=>G.seats[i].out && G.seats[i].outOrder===1);
    if(firstOut==null) return eff;
    const foTeam=teamOf(G, firstOut);
    const left=[0,1,2,3].filter(i=>foTeam.indexOf(i)<0 && !G.seats[i].out); // 另一队还没跑完的人
    if(left.length!==1) return eff;
    const tail=left[0];
    const give=eff[tail]; // 只转抓到的分，不含手里剩余牌的分
    eff[tail]=0;
    eff[firstOut]+=give; // 归到一游头上（队伍内部怎么分不影响 0 分判断与总分）
    return eff;
  }

  function settleRound(G){
    const halfFan=Math.max(1,Math.min(50,Number(G.cfg&&G.cfg.halfFan)||1)); // 半番=几分
    const out=i=>G.seats[i].out;
    let winnerSeats, loserSeats;
    if(G.mode==='hard'){
      const h=G.hardSeat;
      if(out(h)){ winnerSeats=[h]; loserSeats=[0,1,2,3].filter(i=>i!==h); }
      else { winnerSeats=[0,1,2,3].filter(i=>i!==h); loserSeats=[h]; }
    } else {
      const t0=[G.landlord,G.partner];
      const t1=[0,1,2,3].filter(i=>i!==G.landlord&&i!==G.partner);
      if(t0.every(out)){ winnerSeats=t0; loserSeats=t1; } else { winnerSeats=t1; loserSeats=t0; }
    }
    const winSet=new Set(winnerSeats);
    const effCaught=attributedCaught(G); // 归属后的抓分（尾游的分归对面队）

    // 滚笼归属：归赢队 W / 归输队 L
    let W=0, L=0;
    for(let i=0;i<4;i++){
      const s=G.seats[i];
      for(const r of s.rollcages){
        // 跑了→归自己队（硬牌者独队）；没跑→归对方队
        const own = s.out;
        const toWin = G.mode==='hard'
          ? (own ? (i===G.hardSeat) : (i!==G.hardSeat))
          : (own ? winSet.has(i) : !winSet.has(i));
        if(toWin) W+=r.fan; else L+=r.fan;
      }
    }
    const delta=W-L;

    let basePer; let perSeat={}; let perFen={};
    if(G.mode==='hard'){
      basePer=2;
      for(let i=0;i<4;i++){
        perSeat[i]= (i===G.hardSeat)
          ? (winSet.has(i)? +(6+3*delta) : -(6+3*delta))
          : (winSet.has(i)? +(2+delta) : -(2+delta));
      }
    } else {
      const nonOut=loserSeats.filter(i=>!out(i)).length; // 1或2
      basePer=0.5*nonOut;
      const loserCaught=loserSeats.reduce((a,i)=>a+effCaught[i],0);
      if(loserCaught===0) basePer*=2;
      for(let i=0;i<4;i++) perSeat[i]= winSet.has(i) ? (basePer+delta) : -(basePer+delta);
    }
    for(let i=0;i<4;i++) perFen[i]=Math.round(perSeat[i]*2*halfFan);
    const perSeatNoBonus=Object.assign({}, perSeat); // 加奖金前的每座值（用于计分板拆"奖金"列）

    // 王奖金：抓 ≥4 王 → 从其他三人各收 (王数-3) 番。
    // 决策 D：四游不可达（一队跑完即终局），「尾游也可拿」的旧含义作废——
    // 改为：跑完且非四游始终有奖；本局结束仍未跑完者，须开「未跑也可拿王奖金」设置才拿。
    const kingBonus={};
    const tailOk = !!(G.cfg && G.cfg.tailBonus);
    for(let i=0;i<4;i++){
      const s=G.seats[i];
      const eligible = s.kings>=4 && ((s.out && s.outOrder!==4) || (!s.out && tailOk));
      if(eligible){
        const bonus=s.kings-3;
        kingBonus[i]=bonus;
        for(let j=0;j<4;j++){
          if(j===i) continue;
          perSeat[i]+=bonus; perSeat[j]-=bonus;
        }
      }
    }
    // 硬炸奖金：起到 7 张纯牌同点 → 其他三家各 1 笼；8 张 → 各 2 笼。
    // 条件同王奖金：本局跑完且不是最后一个跑的（四游不拿）。
    const bombBonus={};
    for(let i=0;i<4;i++){
      const s=G.seats[i];
      if((s.hardBombBonus||0)>0 && s.out && s.outOrder!==4){
        const bonus=s.hardBombBonus;
        bombBonus[i]=bonus;
        for(let j=0;j<4;j++){
          if(j===i) continue;
          perSeat[i]+=bonus; perSeat[j]-=bonus;
        }
      }
    }
    for(let i=0;i<4;i++) perFen[i]=Math.round(perSeat[i]*2*halfFan);

    return {
      mode:G.mode, hardSeat:G.hardSeat, basePer, delta, W, L,
      winnerSeats, loserSeats, perSeat, perSeatNoBonus, perFen, kingBonus, bombBonus,
      caught:G.seats.map(s=>s.caught), effCaught,
    };
  }

  const TS={
    RANKS, SUIT_CH, SUIT_NAME, RANK_OF,
    mulberry32, buildDeck, shuffle, deal, cardName, pointOf,
    analyzePlay, checkChain, bombTier, isBomb, groupsOf, canBeat, legalLead,
    newGame, pickLandlord, canDeclareHard, declareHard, teamOf, activeSeats, handHasBomb, hardBombBonusOf, declareRestart, confirmAdvance, confirmChoice,
    doPlay, modeEnded, nextActive, advanceTurn, handlePass, settleRound,
  };
  if(typeof module!=='undefined'&&module.exports) module.exports=TS;
  if(global&&!global.TS) global.TS=TS;
})(typeof window!=='undefined'?window:globalThis);