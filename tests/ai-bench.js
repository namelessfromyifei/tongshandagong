/* =========================================================
 * AI 自对弈基准：git HEAD 版 AI（基线） vs 工作区新版 AI
 * 排除座位偏置：跑两轮——
 *   轮1：座位 0/2 → 基线，1/3 → 新版
 *   轮2（换边）：座位 0/2 → 新版，1/3 → 基线
 * 两轮指标取平均；座位（种子序）带来的结构性偏差会抵消，剩下的才是策略差。
 * 2V2 队伍由发牌随机，任何队伍恒为“1 旧+1 新”→ 每局两队都带一名旧一名新。
 *   平均得分/席 = 得分效率（越高越好）
 *   一游率 = 跑掉效率；二游率 = 次优跑位
 * 用法：node tests/ai-bench.js [N=1000]
 * ========================================================= */
"use strict";
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');

const N = Number(process.argv[2] || 1000);
const BASE_SRC = execFileSync('git', ['show', 'HEAD:js/ai.js'], { cwd: ROOT, encoding: 'utf8' });
const TMP = path.join(ROOT, 'js', '_ai_baseline.js');
fs.writeFileSync(TMP, BASE_SRC);

let BASE, NEW, TS;
try {
  BASE = require('../js/_ai_baseline.js'); // 相对 require('./engine.js') 在 js/ 下可解析
  NEW = require('../js/ai.js');
  TS = require('../js/engine.js');
} catch(e) { console.error(e); process.exit(1); }

function playAll(seed, seatIsBase){
  const G = TS.newGame(seed);
  let guard = 0, n = 0;
  while(!G.ended && guard++ < 2000){
    if(G.confirming){
      if(n===0 && G.mode==='2v2' && G.turn===G.landlord && G.rnd() < 0.12){
        if(TS.declareHard(G, G.turn)) continue;
      }
      TS.confirmAdvance(G, G.turn);
      continue;
    }
    const seat = G.turn;
    if(G.seats[seat].out){ TS.advanceTurn(G); continue; }
    const ai = seatIsBase(seat) ? BASE : NEW;
    const ch = ai.aiChoose(G, seat);
    if(ch === null){ TS.handlePass(G, seat); }
    else { TS.doPlay(G, seat, ch.cards); }
    n++;
  }
  if(!G.ended) return null;
  return { G, s: TS.settleRound(G) };
}

// 跑一轮：baseSeats = 基线版坐哪两个座位
function runPass(baseSeats){
  const seatIsBase = s => baseSeats.includes(s);
  const acc = { baseScore:0, newScore:0, baseFo:0, newFo:0, baseSo:0, newSo:0, done:0, guardFail:0 };
  for(let seed = 0; seed < N; seed++){
    const r = playAll(seed, seatIsBase);
    if(!r){ acc.guardFail++; continue; }
    const { G, s } = r;
    for(let i=0;i<4;i++){
      const modIsBase = seatIsBase(i) ? 'base' : 'new';
      acc[modIsBase + 'Score'] += s.perFen[i];
      if(G.firstOut === i) acc[modIsBase + 'Fo']++;
      if(G.seats[i].outOrder === 2) acc[modIsBase + 'So']++;
    }
    acc.done++;
  }
  return acc;
}

const p1 = runPass([0,2]);   // 轮1：基线在 0/2
const p2 = runPass([1,3]);   // 轮2（换边）：基线在 1/3，即新版在 0/2
const tot = {};
for(const k of ['baseScore','newScore','baseFo','newFo','baseSo','newSo','done','guardFail']){
  tot[k] = (p1[k]||0) + (p2[k]||0);
}

const passes = 2, seats = 2;
const perSeat = v => v / (tot.done * seats * passes);
const pct = x => (x*100).toFixed(1)+'%';
console.log(`=== AI 自对弈基准（两轮换边各 ${tot.done/2} 局，总 ${tot.done} 局，超时 ${tot.guardFail}）===\n`);
console.log('指标            基线(git HEAD)    新版(工作区)    新版Δ');
const row=(label, av, bv, better)=>{
  const d = bv - av;
  const sign = d>0?' +':' ';
  console.log(label.padEnd(13,'　') + String(av.toFixed(3)).padStart(12) + String(bv.toFixed(3)).padStart(14) + sign + d.toFixed(3) + (better?' ✓':''));
};
row('平均得分/席', perSeat(tot.baseScore), perSeat(tot.newScore), tot.newScore>tot.baseScore);
console.log('');
row('一游率', tot.baseFo/tot.done, tot.newFo/tot.done, tot.newFo>tot.baseFo);
row('二游率', tot.baseSo/tot.done, tot.newSo/tot.done, tot.newSo>tot.baseSo);

try{ fs.unlinkSync(TMP); }catch(e){}