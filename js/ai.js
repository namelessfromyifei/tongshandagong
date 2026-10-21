/* =========================================================
 * 通山打拱 · AI 与候选生成（基于 engine）
 *   genCandidates(hand, mustBeat) —— 手牌所有合法出法
 *   aiChoose(G, seat) —— AI 决策（出牌 / 过）
 *   runSim —— 自动跑完整局，供测试用
 * ========================================================= */
(function (global) {
  "use strict";
  const TS = (global && global.TS) || (typeof window!=='undefined' && window.TS) || require('./engine.js');

  /* ---------- 候选生成 ---------- */
  function genCandidates(hand, mustBeat){
    const cnt=new Array(TS.RANKS.length).fill(0);
    const byRank=[]; for(let i=0;i<TS.RANKS.length;i++) byRank.push([]);
    let wilds=0;
    const jokers=[];
    for(const c of hand){ if(c.j){ wilds++; jokers.push(c); } else { cnt[c.r]++; byRank[c.r].push(c); } }
    const out=[];
    const tryAdd=(cs)=>{ const p=TS.analyzePlay(cs); if(!p) return; if(mustBeat&&!TS.canBeat(mustBeat,p)) return; out.push({cards:cs.slice(),play:p}); };
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
    // 同牌炸 4-8 张（含王补）—— 无番(4-6)不能领出，但压牌可用
    for(let r=0;r<TS.RANKS.length;r++){
      for(let sz=4;sz<=8;sz++){
        const have=cnt[r];
        if(have>0 && have+wilds>=sz){
          const cs=byRank[r].slice(0,Math.min(have,sz));
          let need=sz-have; if(need<0) need=0;
          for(let i=0;i<need;i++) cs.push(jokers[i]);
          if(cs.length===sz){
            const p=TS.analyzePlay(cs);
            if(p && (mustBeat || TS.bombTier(p)!==1)) tryAdd(cs); // 领出时排除无番炸
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
    if(wilds>=4&&wilds<=8){ const cs=jokers.slice(0,wilds); tryAdd(cs); }
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
    if(p.type==='rollcage') return 30000+p.fan*100;
    if(p.type==='kingBomb') return 40000+p.fan*100;
    return 0;
  }

  /* ---------- AI 决策 ---------- */
  // 手牌价值排序用（点数越大越关键）
  function handCount(hand, r){ let n=0; for(const c of hand) if(!c.j&&c.r===r) n++; return n; }

  // 领出：主动出击或甩牌
  function chooseLead(G, seat, cands){
    const S=G.seats[seat];
    const hand=S.hand;
    // 1) 能一手清空就直接出（跑得快）
    const whole=TS.analyzePlay(hand);
    if(whole) return {cards:hand,play:whole};
    // 2) 跟牌顺序考虑队友势力：无
    // 3) 普通倾向：先出「冗余组合」（连对/飞机），把单张小牌留作跟牌弹药
    const norm=cands.filter(c=>!TS.isBomb(c.play));
    if(norm.length){
      // 分类：组合（连对/飞机）优先甩，其次单/对/三条按点数升
      const combo=norm.filter(c=>c.play.type==='seqPair'||c.play.type==='airplane');
      const pool=combo.length?combo:norm;
      pool.sort((a,b)=>playStrength(a.play)-playStrength(b.play));
      return pool[0];
    }
    // 4) 只有炸能出：小炸（无番/50K）先出，王炸滚笼留最后
    const bombs=cands.filter(c=>TS.isBomb(c.play));
    if(bombs.length){
      bombs.sort((a,b)=>playStrength(a.play)-playStrength(b.play));
      return bombs[0];
    }
    return null;
  }

  // 跟牌：选刚好能压过的最小牌，倾向不浪费大牌、不主动上炸
  function chooseFollow(G, seat, mustBeat, cands){
    const S=G.seats[seat];
    const hand=S.hand;
    const beats=cands.filter(c=>TS.canBeat(mustBeat,c.play));
    if(beats.length===0) return null;
    // 队友如果是最后出牌者（接风视角），让队友继续掌控
    if(G.mode==='2v2' && G.revealed && G.lastSeat===G.partner && seat!==G.partner){
      // 队友领先且我们跟不上好牌 → 倾向不要乱跟（除非能直接出完）
    }
    // 同样类型优先：选「最小能压的普通牌」
    const norm=beats.filter(c=>!TS.isBomb(c.play));
    if(norm.length){
      norm.sort((a,b)=>playStrength(a.play)-playStrength(b.play));
      return norm[0];
    }
    // 只能上炸：判断值不值得
    //   - 对方已上炸（mustBeat 是炸）→ 必须压，用最小能压的炸
    //   - 对方只是普通牌 → 只在「自己能一波带完或手牌很少」时上小炸
    const mustIsBomb=TS.isBomb(mustBeat);
    if(mustIsBomb){
      const bombs=beats.filter(c=>TS.isBomb(c.play));
      if(bombs.length){ bombs.sort((a,b)=>playStrength(a.play)-playStrength(b.play)); return bombs[0]; }
      return null;
    }
    // 普通牌对方，考虑用无番炸压牌（压牌工具），但别浪费
    if(hand.length<=6){
      const press=beats.filter(c=>TS.bombTier(c.play)===1);
      if(press.length){ press.sort((a,b)=>playStrength(a.play)-playStrength(b.play)); return press[0]; }
    }
    // 手牌多：忍住，别为小牌上大炸
    return null;
  }

  function aiChoose(G, seat, opts){
    opts=opts||{};
    const S=G.seats[seat];
    const mustBeat=G.lastPlay;
    if(S.out||G.ended) return null;
    const cands=genCandidates(S.hand, mustBeat||null);
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
      const seat=G.turn;
      // 开局可选硬牌：AI 庄家小概率硬牌
      if(n===0 && G.lastPlay===null && G.mode==='2v2' && G.turn===G.landlord){
        if(G.rnd()<(rounds>0?0.12:0)) TS.declareHard(G,seat);
      }
      if(G.seats[seat].out){ TS.advanceTurn(G); continue; }
      if(rounds>0 && n%(G.mode==='hard'?1:1)===0){
        // 每轮模拟都走 AI
      }
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