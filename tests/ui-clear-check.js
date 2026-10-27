/* =========================================================
 * 通山打拱 · 客户端渲染层「清理牌局」回归检查（jsdom，无浏览器）
 * 复现：把 G 清成 null（提前收场/清残局）的帧会走 applyState 的 if(!G) 分支，
 * 该分支早退时不清 #hand → 残留上一局手牌。
 * 修复：if(!G) 分支内清空 #hand / 各家出牌区 / 本轮分数，并复位 boardCleared。
 * 运行：node tests/ui-clear-check.js   （环境需 jsdom：npm install --no-save jsdom）
 * 不挂进 npm test（jsdom 非仓库依赖）；本地验证用。
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
    console.log('未安装 jsdom，无法运行（先执行：npm install --no-save jsdom）。');
    console.log('这是独立验证脚本，不影响 npm test/CI。');
    process.exit(0);
  }

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;

  // 建表结构（querySelector 用），并把 #hand 放进 .handArea
  const table = d.createElement('div'); table.className = 'table';
  const handRow = d.createElement('div'); handRow.className = 'handRow';
  const handArea = d.createElement('div'); handArea.className = 'handArea';
  d.body.appendChild(table); table.appendChild(handRow); handRow.appendChild(handArea);
  d.body.appendChild(d.createElement('div')).className = 'seatS';
  d.body.appendChild(d.createElement('div')).className = 'seatW';
  d.body.appendChild(d.createElement('div')).className = 'seatE';
  d.body.appendChild(d.createElement('div')).className = 'seatN';
  // 直接取真实 index.html 里的全部 id 建元素：任何 $()/getElementById 都有落点
  for(const m of html.matchAll(/id="([^"]+)"/g)){
    const el = d.createElement('div');
    el.id = m[1];
    d.body.appendChild(el);
  }
  // #midBtns/#playBtns 挂到手牌行（layoutActionButtons 会挪动按钮）+
  const mid = d.getElementById('midBtns'), right = d.getElementById('playBtns');
  if(mid) handRow.appendChild(mid);
  if(right) handRow.appendChild(right);
  // #hand 进 .handArea
  const hand = d.getElementById('hand');
  if(hand){ handArea.appendChild(hand); }

  // 装载真实引擎 + 客户端渲染层
  try{
    w.eval(fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(ROOT, 'public', 'js', 'ui-net.js'), 'utf8'));
  }catch(e){
    console.log('装载失败：', e && e.message ? e.message : e);
    console.log('\n结果: 0 通过, 1 失败（无法加载真实客户端代码）');
    process.exit(1);
  }

  const UI = w.GameUI;
  T('客户端渲染层可加载（window.GameUI.applyState）', !!(UI && typeof UI.applyState === 'function'));
  if(!(UI && typeof UI.applyState === 'function')){
    process.exit(1);
  }

  const baseSnap = {
    code: 'TEST', aiFill: true, ready: [false,false,false,false],
    settings: { rounds:3, kings:8, jokerValue:3, fanCap:32, halfFan:1 },
    series: { active:false, roundCount:0, totals:[0,0,0,0] },
    hostSeat: 0, seriesOver: false, endVote: null,
    seats: [0,1,2,3].map(i => ({ name:['甲','乙','丙','丁'][i], type:'human', offline:false, avatar:'', humanCount:4 })),
    G: null,
  };
  const snap2 = Object.assign({}, baseSnap);

  // 第 1 帧：进入房间（切房清理，建立 curRoomCode=TEST）
  UI.applyState(snap2);
  T('进入房间首帧手牌区为空', hand.childNodes.length === 0);

  // 复现「清理牌局残留」：上一局手牌还挂在 #hand → 再来一帧 G=null（同房间，走 if(!G) 分支）
  for(let i=0;i<3;i++){
    const c = d.createElement('div'); c.className = 'hcard'; c.innerHTML = '<b>3♥</b>';
    hand.appendChild(c);
  }
  const tt = d.getElementById('trickScore');
  if(tt) tt.textContent = '本轮分数 12 分';
  UI.applyState(snap2); // snap 相同：不触发切房清理，直接进 if(!G) 分支

  // —— 修复判定 ——
  T('G 清空帧清空 #hand（修复：残留手牌被清掉）', hand.childNodes.length === 0, { left: hand.childNodes.length });
  T('G 清空帧清空 #trickScore（本轮分数不残留）', !tt || tt.textContent === '');
  // 幂等：再来一帧 G 空，牌面保持清空不回流
  const ttj = d.getElementById('trickScore');
  if(ttj) ttj.textContent = '本轮分数 12 分'; // 若重构忘清，会重新出现残留
  UI.applyState(snap2);
  T('连续 G 空帧幂等：手牌/本轮分数保持清空', hand.childNodes.length === 0 && (!ttj || ttj.textContent === ''));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();