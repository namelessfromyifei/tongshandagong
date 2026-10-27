/* =========================================================
 * 通山打拱 · AI 与候选生成（基于 engine）
 *   genCandidates(hand, mustBeat, cfg) —— 手牌所有合法出法
 *   aiChoose(G, seat) —— AI 决策（出牌 / 过）
 *   runSim —— 自动跑完整局，供测试用
 * ========================================================= */
(function (global) {
  "use strict";
  const TS = (global && global.TS) || (typeof window!=='undefined' && window.TS) || require('./engine.js');

  /* ---------- 候选生成 ---------- */
  function genCandidates(hand, mustBeat, cfg){
    const cnt=new Array(TS.RANKS.length).fill(0);
    const byRank=[]; for(let i=0;i<TS.RANKS.length;i++) byRank.push([]);
    let wilds=0;
    const jokers=[];
    for(const c of hand){ if(c.j){ wilds++; jokers.push(c); } else { cnt[c.r]++; byRank[c.r].push(c); } }
    const out=[];
    const tryAdd=(cs)=>{ const p=TS.analyzePlay(cs, cfg); if(!p) return; if(mustBeat&&!TS.canBeat(mustBeat,p)) return; out.push({cards:cs.slice(),play:p}); };
    const dedupe=()=>{
      const seen=new Set(), res=[];
      for(const it of out){
        const key=it.cards.map(c=>c.id).sort((a,b)=>a-b).join(',');
        if(!seen.has(key)){ seen.add(key); res.push(it); }
      }
      return res;
    };
    const canUseJokers=(need)=>{ // 本手能否用王补齐；王在任意组合都可癞子
      return wilds>=need;
    };
    // 单张
    for(let r=0;r<TS.RANKS.length;r++) if(cnt[r]>0) tryAdd([byRank[r][0]]);
    if(wilds>0) tryAdd([jokers[0]]);
    // 对子（含王补） / 三条（含王补）
    for(let r=0;r<TS.RANKS.length;r++){
      for(let sz=2;sz<=3;sz++){
        const have=cnt[r];
        if(have+wilds>=sz && have>0){
          const cs=byRank[r].slice(0,sz);
          let need=sz-have; if(need<0) need=0;
          for(let i=0;i<need;i++) cs.push(jokers[i]);
          if(cs.length===sz) tryAdd(cs);
        }
      }
    }
    // 纯王 对/三条
    if(wilds>=2) tryAdd([jokers[0],jokers[1]]);
    if(wilds>=3) tryAdd([jokers[0],jokers[1],jokers[2]]);
    // 五十K（含 1-3 张王补齐；7/8 王补单）
    const has=r=>cnt[r]>0, pick=r=>byRank[r][0];
    const r5=2, r10=7, rK=10;
    const mk50=(arr)=>{ if(arr.length!==3)return; tryAdd(arr); };
    if(has(r5)&&has(r10)&&has(rK)) mk50([pick(r5),pick(r10),pick(rK)]);
    if(has(r5)&&has(r10)&&wilds>=1) mk50([pick(r5),pick(r10),jokers[0]]);
    if(has(r5)&&has(rK)&&wilds>=1) mk50([pick(r5),jokers[0],pick(rK)]);
    if(has(r10)&&has(rK)&&wilds>=1) mk50([jokers[0],pick(r10),pick(rK)]);
    if(has(r5)&&wilds>=2) mk50([pick(r5),jokers[0],jokers[1]]);
    if(has(r10)&&wilds>=2) mk50([jokers[0],pick(r10),jokers[1]]);
    if(has(rK)&&wilds>=2) mk50([jokers[0],jokers[1],pick(rK)]);
    // 五十K大炸：5/10/K 三类各 t 张（t≥4），每类缺的用王补（三类同步）
    for(let t=4; t*3<=hand.length; t++){
      const need5=t-(cnt[r5]||0), need10=t-(cnt[r10]||0), needK=t-(cnt[rK]||0);
      if(need5<0||need10<0||needK<0) continue; // 某一类真牌已超 t，无法同步
      if(need5+need10+needK>wilds) continue;    // 王不够补缺
      const cs=byRank[r5].slice(0,Math.min(t,cnt[r5]||0))
        .concat(byRank[r10].slice(0,Math.min(t,cnt[r10]||0)))
        .concat(byRank[rK].slice(0,Math.min(t,cnt[rK]||0)));
      let taken=0;
      const needA=[need5,need10,needK];
      for(const nw of needA){ for(let i=0;i<nw;i++) cs.push(jokers[taken++]); }
      tryAdd(cs);
    }
    // 同牌炸 4 张起（含王补，可超过 8 张）—— 无番(4-6)按现行规则也可领出（屋规原为不可领出，已放开）
    for(let r=0;r<TS.RANKS.length;r++){
      for(let sz=4;sz<=cnt[r]+wilds;sz++){
        const have=cnt[r];
        if(have>0 && have+wilds>=sz){
          const cs=byRank[r].slice(0,Math.min(have,sz));
          let need=sz-have; if(need<0) need=0;
          for(let i=0;i<need;i++) cs.push(jokers[i]);
          if(cs.length===sz){
            const p=TS.analyzePlay(cs, cfg);
            if(p) tryAdd(cs); // 无番炸按现行规则也可领出
          }
        }
      }
    }
    // 滚笼（s 张/组 × k 组，可含王补；点数环形，2 与 3 相邻）
    for(let s=4;s<=8;s++) for(let k=2;k<=6;k++){
      if(s*k>hand.length) continue;
      for(let st=0; st<TS.RANKS.length; st++){
        let need=0, ok=true, cs=[];
        for(let i=0;i<k;i++){
          const r=(st+i)%TS.RANKS.length;
          if(cnt[r]>s){ ok=false; break; }
          need += s-cnt[r];
          cs = cs.concat(byRank[r].slice(0,Math.min(cnt[r],s)));
        }
        if(!ok) continue;
        if(wilds>=need){
          let cs2=cs.slice();
          for(let i=0;i<need;i++) cs2.push(jokers[i]);
          if(cs2.length===s*k) tryAdd(cs2);
        }
      }
    }
    // 连对（不含 2）：k 组双张，k=2..6
    for(let k=2;k<=6;k++){
      for(let st=0; st+k-1<=11; st++){
        let need=0, ok=true, cs=[];
        for(let i=0;i<k;i++){
          const r=st+i;
          if(cnt[r]>2){ ok=false; break; }
          need += 2-cnt[r];
          cs = cs.concat(byRank[r].slice(0,Math.min(cnt[r],2)));
        }
        if(!ok) continue;
        if(wilds>=need && cnt[st]+cnt[st+k-1]>0){
          const cs2=cs.slice(); for(let i=0;i<need;i++) cs2.push(jokers[i]);
          if(cs2.length===2*k) tryAdd(cs2);
        }
      }
    }
    // 飞机（不含 2）：k 组三条
    for(let k=2;k<=6;k++){
      for(let st=0; st+k-1<=11; st++){
        let need=0, ok=true, cs=[];
        for(let i=0;i<k;i++){
          const r=st+i;
          if(cnt[r]>3){ ok=false; break; }
          need += 3-cnt[r];
          cs = cs.concat(byRank[r].slice(0,Math.min(cnt[r],3)));
        }
        if(!ok) continue;
        if(wilds>=need){
          const cs2=cs.slice(); for(let i=0;i<need;i++) cs2.push(jokers[i]);
          if(cs2.length===3*k) tryAdd(cs2);
        }
      }
    }
    // 王炸
    if(wilds>=4){ const cs=jokers.slice(0,wilds); tryAdd(cs); }
    return dedupe();
  }

  /* ---------- 强度（用于 AI 及提示排序） ---------- */
  function playStrength(p){
    if(p.type==='single') return 100+p.val;
    if(p.type==='pair') return 200+p.val;
    if(p.type==='triple') return 300+p.val;
    if(p.type==='seqPair') return 400+p.top;
    if(p.type==='airplane') return 500+p.top;
    if(p.type==='fiftyK') return 10000;
    if(p.type==='bomb') return p.size<=6 ? 20000+p.size*10 : 30000+p.fan*100;
    if(p.type==='fiftyCage') return 30000+p.fan*100;
    if(p.type==='rollcage') return 30000+p.fan*100;
    if(p.type==='kingBomb') return 40000+p.fan*100;
    return 0;
  }

  /* ---------- AI 决策 ----------
   * 更聪明的打法：
   *   1) 王（癞子）不乱出 —— 优先留作 王炸/五十K/滚笼，凑对/凑三条/软炸
   *      只在王充裕（>4 张）或快跑完时才动用
   *   2) 快速跑掉 —— 整手能出完直接出；手少时优先一次性大甩
   *   3) 辅助队友 —— 队友出的牌不跟、不上炸，让它控场/带风；队友将跑完时送低牌
   *   4) 不炸队友 —— 队友最后出的牌一律不压；对手要跑完才舍得用炸拦 */
  function handJokers(hand){ let n=0; for(const c of hand) if(c.j) n++; return n; }
  const wildsOf=it=>{ let n=0; for(const c of it.cards) if(c.j) n++; return n; };
  // 王用在当口的牌算不算浪费：五十K/王炸/滚笼 是正当用途；凑对/凑三条/软炸 算浪费
  function wildWaste(play, wildsUsed, jokers){
    if(wildsUsed===0) return false;
    if(play.type==='kingBomb'||play.type==='fiftyK'||play.type==='rollcage') return false;
    return jokers - 4 < wildsUsed; // 王不充裕（不足"王炸+富余"）时动用就算浪费
  }
  // 普通跟牌挑选：王耗少的优先，其次出最小能压的
  function pickBest(list, wildsFirst){
    if(!list.length) return null;
    list.sort((a,b)=>{
      const wa=wildsOf(a), wb=wildsOf(b);
      if(wa!==wb) return wa-wb;
      return playStrength(a.play)-playStrength(b.play);
    });
    return list[0];
  }

  // 领出：主动出击或甩牌
  function chooseLead(G, seat, cands){
    const S=G.seats[seat], hand=S.hand;
    const jokers=handJokers(hand);
    const team=TS.teamOf(G,seat);
    const partner=team.length>1?team.find(i=>i!==seat):-1;
    const pOut = partner>=0 ? G.seats[partner].out : true;

    // 0) 整手一次出完（跑牌最终步）
    const whole=TS.analyzePlay(hand, G.cfg);
    if(whole) return {cards:hand, play:whole};

    // 1) 手牌少：优先一次大甩、接近跑完（省王优先）；不给对手拖的机会
    if(hand.length<=8){
      let best=null, bestKey=null;
      for(const it of cands){
        const rest=hand.length-it.cards.length;
        const wu=wildsOf(it);
        if(rest>2 && !(rest<=4 && wu===0)) continue; // 只考虑剩≤2或 0 王的大甩
        const key=rest*1000+wu;
        if(bestKey===null||key<bestKey){ bestKey=key; best=it; }
      }
      if(best) return {cards:best.cards, play:best.play};
    }

    // 2) 队友（即将跑完）送权：队友手越少，越该出小而稳的牌让队友接
    //    这里简化：队友快跑完时优先出非王的最小普通牌（甩低牌也顺手）
    if(!pOut && partner>=0 && G.seats[partner].hand.length<=3 && hand.length>4){
      const low=cands.filter(it=>!TS.isBomb(it.play)&&!wildWaste(it.play,wildsOf(it),jokers));
      const picked=pickBest(low);
      if(picked) return {cards:picked.cards, play:picked.play};
    }

    // 3) 组合优先（甩得最多）：连对/飞机/五十K/滚笼（王炸一般留作跟牌杀器）
    //    费王的组合只有当甩得多/是滚笼才上，否则留王（王不乱出）
    const combo=cands.filter(it=>{
      const p=it.play, wu=wildsOf(it);
      if(p.type!=='seqPair'&&p.type!=='airplane'&&p.type!=='fiftyK'&&p.type!=='rollcage') return false;
      if(wu===0) return true;
      if(p.type==='airplane'&&wu<=2) return true;
      if(p.type==='rollcage') return true;
      return false;
    });
    if(combo.length){
      combo.sort((a,b)=>{
        const wa=wildsOf(a), wb=wildsOf(b);
        if(wa!==wb) return wa-wb;
        const la=a.cards.length, lb=b.cards.length;
        if(la!==lb) return lb-la;              // 先甩多张的
        return playStrength(a.play)-playStrength(b.play);
      });
      return {cards:combo[0].cards, play:combo[0].play};
    }

    // 4) 普通单/对/三条：最小的真实小牌（不用王）
    const norm=cands.filter(it=>!TS.isBomb(it.play)&&!wildWaste(it.play,wildsOf(it),jokers));
    const n0=pickBest(norm);
    if(n0) return {cards:n0.cards, play:n0.play};

    // 5) 只剩炸：小炸先动（无番/五十K），王炸/滚笼留着
    const bombs=cands.filter(it=>TS.isBomb(it.play)&&!wildWaste(it.play,wildsOf(it),jokers));
    if(bombs.length){
      bombs.sort((a,b)=>playStrength(a.play)-playStrength(b.play));
      return {cards:bombs[0].cards, play:bombs[0].play};
    }

    // 6) 兜底：最小强度的出法（罕见）
    const it=cands.slice().sort((a,b)=>playStrength(a.play)-playStrength(b.play))[0];
    return {cards:it.cards, play:it.play};
  }

  // 跟牌：能压则压，但绝不炸队友、不浪费王
  function chooseFollow(G, seat, mustBeat, cands){
    const S=G.seats[seat], hand=S.hand;
    const jokers=handJokers(hand);
    const team=TS.teamOf(G,seat);
    const lastIsTeammate = G.lastSeat>=0 && team.includes(G.lastSeat);
    const beats=cands.filter(it=>TS.canBeat(mustBeat,it.play));

    // A) 队友刚出的牌：不跟、不上炸，让队友控场（带风/顺风由引擎处理）；
    //    除非我能一手跑完（跑牌优先于让权）
    if(lastIsTeammate){
      const run=beats.filter(it=>it.cards.length===hand.length);
      const r0=pickBest(run);
      if(r0) return {cards:r0.cards, play:r0.play};
      return null;
    }
    if(beats.length===0) return null;

    // B) 自己能一手跑完：直接出（少耗王优先）
    const goOut=beats.filter(it=>it.cards.length===hand.length);
    const g0=pickBest(goOut);
    if(g0) return {cards:g0.cards, play:g0.play};

    // C) 自己也快跑完（剩≤2）：大甩清仓
    if(hand.length<=6){
      const near=beats.filter(it=>hand.length-it.cards.length<=2);
      const n0=pickBest(near);
      if(n0) return {cards:n0.cards, play:n0.play};
    }

    // D) 对手马上要跑完（手≤2）：用炸拦（优先小炸、不浪费王）
    const oppHand = G.lastSeat>=0 ? G.seats[G.lastSeat].hand.length : 999;
    if(oppHand<=2){
      const stop=beats.filter(it=>TS.isBomb(it.play)&&!wildWaste(it.play,wildsOf(it),jokers));
      const s0=pickBest(stop);
      if(s0) return {cards:s0.cards, play:s0.play};
    }

    // E) 普通跟：最小能压的普通牌，优先不用王
    const norm=beats.filter(it=>!TS.isBomb(it.play)&&!wildWaste(it.play,wildsOf(it),jokers));
    const n0=pickBest(norm);
    if(n0) return {cards:n0.cards, play:n0.play};

    // F) 对方上炸：必须回炸，用最小能压的炸（优先真实炸）
    if(TS.isBomb(mustBeat)){
      const bombs=beats.filter(it=>TS.isBomb(it.play));
      const b0=pickBest(bombs);
      if(b0) return {cards:b0.cards, play:b0.play};
      return null;
    }

    // G) 对方普通大牌，只能靠炸/费王去压：手牌少快跑时才舍得用
    if(hand.length<=6){
      const press=beats.filter(it=>TS.isBomb(it.play)&&!wildWaste(it.play,wildsOf(it),jokers));
      const p0=pickBest(press);
      if(p0) return {cards:p0.cards, play:p0.play};
    }
    return null;
  }

  function aiChoose(G, seat, opts){
    opts=opts||{};
    const S=G.seats[seat];
    const mustBeat=G.lastPlay;
    if(S.out||G.ended) return null;
    const cands=genCandidates(S.hand, mustBeat||null, G.cfg);
    if(cands.length===0) return null; // 无牌可出（过）
    if(!mustBeat) return chooseLead(G,seat,cands);
    return chooseFollow(G,seat,mustBeat,cands);
  }

  /* ---------- 模拟一局 ---------- */
  function runSim(seed, rounds){
    const G=TS.newGame(seed);
    let guard=0, n=0;
    const results=[];
    while(!G.ended && guard++<2000){
      // 确认轮：庄家小概率硬牌，其余一律「不明独」——不处理则 turn 会停在庄家转不动、模拟空转
      if(G.confirming){
        if(n===0 && G.mode==='2v2' && G.turn===G.landlord && G.rnd()<(rounds>0?0.12:0)){
          if(TS.declareHard(G, G.turn)) continue; // 硬牌成立（确认轮已结束）
        }
        TS.confirmAdvance(G, G.turn);
        continue;
      }
      const seat=G.turn;
      if(G.seats[seat].out){ TS.advanceTurn(G); continue; }
      const ch=aiChoose(G,seat);
      if(ch===null){ TS.handlePass(G,seat); }
      else { const r=TS.doPlay(G,seat,ch.cards); if(r&&r.ok){} }
      n++;
    }
    if(G.ended){ const s=TS.settleRound(G); results.push({G,s}); }
    return results;
  }

  const TSAI={ genCandidates, playStrength, aiChoose, runSim };
  if(typeof module!=='undefined'&&module.exports) module.exports=TSAI;
  if(global) global.TSAI=TSAI;
})(typeof window!=='undefined'?window:globalThis);