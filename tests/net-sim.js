/* 联调脚本：1 真人 + 3 AI 自动打完整局（真人角度 AI 补位开局、真人用本地引擎选合法牌）
 * 运行：node tests/net-sim.js   （需先 npm install 并 node server.js，或本脚本连远程 8080）
 * 说明：单人房用「AI 补位」开局（start 不足 4 真人时会被拒绝，需 aiFill）。
 */
const { io } = require('socket.io-client');
const TS = require('../js/engine.js');
const TSAI = require('../js/ai.js');
const PORT = process.env.PORT || 8080;
const c1 = io('http://127.0.0.1:' + PORT, { reconnection: false });
let steps = 0, mySeat = -1;

c1.on('connect', () => { c1.emit('create', { name: '测试玩家1' }); });
c1.on('joined', (d) => {
  mySeat = d.seat;
  console.log('玩家1加入, 座位', d.seat, '房间', d.code);
  // AI 补位 + 1 局：确保真人只有 1 位也能开局
  c1.emit('setSettings', { aiFill: true, rounds: 1, start: true });
  console.log('触发开局（AI 补位）');
});
c1.on('toast', (m) => console.log('[toast]', m));
c1.on('state', (snap) => {
  const G = snap && snap.G;
  if (!G) return;
  steps++;
  if (steps <= 5) console.log('state#'+steps, 'confirming:', G.confirming, 'mode:', G.mode, 'turn:', G.turn);
  if (G.ended) { console.log('== 本局结束 == state次数:', steps); cleanup(); return; }
  // 确认轮：轮到我点「不明独」
  if (G.confirming) {
    if (G.turn === mySeat) c1.emit('act', { type: 'confirm', seat: mySeat, choice: 'pass' });
    return;
  }
  // 出牌轮：轮到我时用本地引擎选一个合法动作
  if (G.turn !== mySeat) return;
  const seat = G.seats[mySeat];
  if (!seat || !seat.hand || !seat.hand.length) return;
  const ch = TSAI.aiChoose(G, mySeat);
  if (ch === null) {
    if (G.lastPlay) c1.emit('act', { type: 'pass', seat: mySeat });
    else console.log('[warn] 领出无牌可出？');
  } else {
    c1.emit('act', { type: 'play', seat: mySeat, cards: ch.cards });
  }
});
function cleanup(){ c1.close(); process.exit(0); }
setTimeout(() => { console.log('超时, state次数:', steps); cleanup(); }, 60000);