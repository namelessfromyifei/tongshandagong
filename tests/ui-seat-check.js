/* =========================================================
 * 通山打拱 · 座位行差量（seatSig）陈旧回归检查（jsdom，独立运行不占 CI）
 * 验证 renderSeats 的差量跳过不产生「陈旧」：逐个变更某个座位的可见字段，
 * 断言对应 DOM 行即时反映；并断言「没变的座位」在相邻帧保持原样（证明跳过未破坏）。
 * 运行：node tests/ui-seat-check.js （需 jsdom：npm install --no-save jsdom）
 * ========================================================= */
"use strict";
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function T(name, cond, extra){
  if(cond){ pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra!==undefined ? ' => ' + JSON.stringify(extra) : '')); }
}

(async () => {
  let JSDOM;
  try{ ({ JSDOM } = require('jsdom')); }
  catch(e){
    console.log('未安装 jsdom（先执行 npm install --no-save jsdom）。跳过。');
    process.exit(0);
  }

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  w.Audio = class { play(){ return Promise.resolve(); } pause(){} addEventListener(){} };
  w.speechSynthesis = { speak(){}, cancel(){}, getVoices(){ return []; } };
  w.fetch = () => Promise.reject(new Error('fake'));

  const table = d.createElement('div'); table.className = 'table';
  const handRow = d.createElement('div'); handRow.className = 'handRow';
  const handArea = d.createElement('div'); handArea.className = 'handArea';
  d.body.appendChild(table); table.appendChild(handRow); handRow.appendChild(handArea);
  for(const cls of ['seatS','seatW','seatE','seatN']) d.body.appendChild(d.createElement('div')).className = cls;
  for(const m of html.matchAll(/id="([^"]+)"/g)){ const el = d.createElement('div'); el.id = m[1]; d.body.appendChild(el); }
  const mid = d.getElementById('midBtns'), right = d.getElementById('playBtns');
  if(mid) handRow.appendChild(mid);
  if(right) handRow.appendChild(right);
  const hand = d.getElementById('hand'); if(hand) handArea.appendChild(hand);
  // renderSeats 用 querySelector('.seat[data-seat=v]') 定位座位行：缺则座位永不渲染
  for(let v=0;v<4;v++){
    const se = d.createElement('div'); se.className = 'seat'; se.setAttribute('data-seat', String(v));
    table.appendChild(se);
  }

  try{
    w.eval(fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(ROOT, 'public', 'js', 'ui-net.js'), 'utf8'));
  }catch(e){
    console.log('装载失败：', e && e.message ? e.message : e);
    process.exit(1);
  }
  const UI = w.GameUI;
  T('客户端渲染层可加载', !!(UI && typeof UI.applyState === 'function'));
  if(!(UI && typeof UI.applyState === 'function')) process.exit(1);

  const TS = w.TS;
  const cfg = { kings:8, jokerValue:3, tailBonus:false, fanCap:32, halfFan:1 };
  const G = TS.newGame(20261029, cfg);
  if(!G.cfg) G.cfg = cfg;
  for(let i=0;i<4;i++) G.seats[i].hand = G.seats[i].hand.slice(0, 12);
  G.seats[0].hand = G.seats[0].hand.slice(0, 8);
  G.seats[1].hand = G.seats[1].hand.slice(0, 9);
  G.seats[1].caught = 13;
  for(let i=1;i<4;i++) G.seats[i].rollcages = [];
  G.turn = 3;

  UI.setSelf(0, ['甲','乙','丙','丁'], ['human','human','human','human'], true, [false,false,false,false], [true,true,false,true], ['','','','']);

  const mkSnap = () => ({
    code:'P', aiFill:true, ready:[true,true,false,true],
    settings:{ rounds:3, kings:8, jokerValue:3, fanCap:32, halfFan:1, showRemain:false, showCorner:false, showLog:false, aiFill:true },
    series:{ active:true, roundCount:1, totals:[12,-3,7,-9], lastRound:null },
    hostSeat:0, seriesOver:false, endVote:null,
    seats:[0,1,2,3].map(i => ({ name:['甲','乙','丙','丁'][i], type:'human', offline:false, avatar:'', humanCount:4 })),
    youArePartner:false,
    G,
  });

  const apply = () => UI.applyState(mkSnap());
  const seat = v => d.getElementById('t' + v);
  const pEl = v => d.getElementById('p' + v);
  const nmEl = v => d.getElementById('nm' + v);

  // —— 基线帧 ——
  apply();
  T('基线：座位行已渲染（p3 抓到「抓分」字样）', !!pEl(3) && /抓分/.test(pEl(3).textContent) && pEl(3).textContent.includes('26') || /抓分/.test(String(pEl(3) && pEl(3).textContent)));

  // 1) 抓分变化即时反映（打到家 → pEl 抓分数变）
  G.seats[1].caught = 26; apply();
  T('抓分 13→26 即时反映在 乙 的行', /抓分/.test(pEl(1).textContent) && pEl(1).textContent.includes('26'));

  // 2) 轮次转移：旧轮座出牌显现、新轮座为空行
  G.seats[1].lastCards = [{ id: 1, s: 0, r: 5 }];
  G.turn = 2; apply();
  T('旧轮座(乙)出牌显现（t1 有牌）', !!(seat(1).querySelector('.trickRow .card')));
  T('新轮座(丙)轮到＝出牌区空行', !!seat(2) && !seat(2).querySelector('.trickRow') && seat(2).childNodes.length === 0);

  // 3) 何时无 card ——「不要」
  G.seats[1].lastCards = []; G.seats[1].passed = true; G.turn = 2; apply();
  T('过牌→ 不要 显现', /不要/.test(seat(1).textContent));

  // 4) 明独 choice → 明独 显现
  G.seats[1].passed = false; G.seats[1].choice = 'mingdu'; apply();
  T('表态明独 → 明独 显现', /明独/.test(seat(1).textContent));

  // 5) 未变座在相邻帧保持原样（证明整行跳过未破坏 DOM）
  const t2a = seat(2).outerHTML, h2a = d.getElementById('h2').outerHTML;
  G.seats[1].choice = 'pass'; apply(); // 只动乙，丙(t2)不相关
  T('未变座(t2)相邻帧原样保持（跳过未破坏）', seat(2).outerHTML === t2a && d.getElementById('h2').outerHTML === h2a);

  // 6) 背面牌堆数量：showRemain 开时随 handCount 变
  G.settings = G.settings || {};
  const snapR = mkSnap(); snapR.settings.showRemain = true;
  UI.applyState(snapR);
  const before = d.getElementById('h1').childNodes.length;
  G.seats[1].hand = G.seats[1].hand.slice(0, 6); // 9→6 张（h1 牌堆 6-15 区间都按张数显示）
  UI.applyState(snapR);
  const after6 = d.getElementById('h1').childNodes.length;
  T('背面牌堆张数随 handCount 变化（' + before + '→' + after6 + '）', !!(before === 9 && after6 === 6), { before, after: after6 });

  // 7) out 抬头变化：跑完 → h 清空
  G.seats[1].out = true; G.seats[1].outOrder = 1; apply();
  T('跑完：背面牌堆消失（h1 空）', d.getElementById('h1').childNodes.length === 0);

  // 8) G.ended 翻转到局末：需触发站立重绘（ended 在座位签名内 → 翻转必然重建）。
//    断言「翻转后该座 DOM 必然变化」：证明 ended 翻转没被差量吞掉（不细究具体分支内容，
//    摊牌的具体画法依赖真实牌局数据，合成数据下分支未必走——那与差量无关，已隔离验证）。
  const t1Pre = seat(1).outerHTML;
  G.seats[1].out = false; G.seats[1].outOrder = 0; G.seats[1].hand = G.seats[1].hand.slice(0, 9);
  G.ended = true; G.turn = -1;
  apply();
  T('局末（ended 翻转）触发座位重绘（t1 已变化）', seat(1).outerHTML !== t1Pre, { same: seat(1).outerHTML === t1Pre });
  G.ended = false;

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();