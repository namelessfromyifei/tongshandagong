/* 联调脚本：1 真人 + 3 AI 自动打完整局（真人用本地引擎选合法牌） */
const { io } = require('socket.io-client');
const TS = require('../js/engine.js');
const TSAI = require('../js/ai.js');
const c1 = io('http://127.0.0.1:8080', { reconnection: false });
let steps = 0, mySeat = -1;

c1.on('connect', () => { c1.emit('create', { name: '测试玩家1' }); });
c1.on('joined', (d) => {
  mySeat = d.seat;
  console.log('玩家1加入, 座位', d.seat, '房间', d.code);
  c1.emit('start', {});
  console.log('触发开局');
});
c1.on('toast', (m) => console.log('[toast]', m));
c1.on('state', (snap) => {
  if (!snap.G) return;
  steps++;
  if (steps <= 5) console.log('state#'+steps, 'confirming:', snap.G.confirming, 'mode:', snap.G.mode, 'turn:', snap.G.turn);
  if (snap.G.ended) { console.log('== 本局结束 == state次数:', steps); cleanup(); return; }
  if (!snap.G.confirming && snap.G.turn === mySeat) {
    const G = snap.G, seat = mySeat, hand = G.seats[seat].hand;
    if (!hand.length) return;
    // 用本地 AI 算一个合法动作（跟牌或过）
    const ch = TSAI.aiChoose(G, seat);
    if (ch === null) {
      if (G.lastPlay) c1.emit('act', { type: 'pass', seat });
      else console.log('[warn] 领出无牌可出？');
    } else {
      c1.emit('act', { type: 'play', seat, cards: ch.cards });
    }
  }
});
// 确认轮：轮到我点不明独
c1.on('state', (snap) => {
  if (snap.G && snap.G.confirming && snap.G.turn === mySeat) {
    c1.emit('act', { type: 'confirm', seat: mySeat, choice: 'pass' });
  }
});
function cleanup(){ c1.close(); process.exit(0); }
setTimeout(() => { console.log('超时, state次数:', steps); cleanup(); }, 60000);
