/* =========================================================
 * 通山打拱 · 提前结束本场（共识收场）端到端检查（决策 A）
 * 4 真人房：先发起被一人拒绝 → 请求作废、牌局不受影响；
 * 再发起三人全同意 → 场结束：局中弃局、seriesOver、G 清空。
 * 运行：node tests/endseries-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18100;
const ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function T(name, cond, extra){
  if(cond){ pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra!==undefined ? ' => ' + JSON.stringify(extra) : '')); }
}
function connect(port){
  return new Promise((res, rej) => {
    const c = io('http://127.0.0.1:' + port, { reconnection: false, transports: ['websocket'], timeout: 10000 });
    c.on('connect', () => res(c));
    c.on('connect_error', e => rej(e));
  });
}
async function until(fn, ms){
  const t0 = Date.now();
  while(Date.now() - t0 < (ms || 6000)){
    if(fn()) return true;
    await wait(80);
  }
  return false;
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), ROOM_IDLE_KICK_MS: '0', OFFLINE_KICK_MS: '0', DB_PATH: ':memory:' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += d.toString(); });
  srv.stderr.on('data', d => { out += d.toString(); });
  const startAt = Date.now();
  while(!/服务器已启动/.test(out) && Date.now() - startAt < 8000) await wait(120);

  const clients = [];
  try{
    for(let i=0;i<4;i++){
      const c = await connect(PORT);
      clients.push({ c, seat:-1, lastSnap:null, sawVote:false, logs:[], askCount:0 });
      c.on('state', snap => {
        clients[i].lastSnap = snap;
        if(snap.endVote) clients[i].sawVote = true;
      });
      c.on('log', line => { clients[i].logs.push(String(line)); });
      c.on('endSeriesAsk', () => { clients[i].askCount++; });
    }

    // 建房 + 加入（4 真人）
    let roomCode='';
    await new Promise((res, rej) => {
      clients[0].c.on('joined', d => { clients[0].seat=d.seat; roomCode=d.code; res(); });
      clients[0].c.emit('create', { name:'甲' });
      setTimeout(() => rej(new Error('create 超时')), 8000);
    });
    for(let i=1;i<4;i++){
      await new Promise((res, rej) => {
        clients[i].c.on('joined', d => { clients[i].seat=d.seat; res(); });
        clients[i].c.emit('join', { code:roomCode, name:['乙','丙','丁'][i-1] });
        setTimeout(() => rej(new Error('join 超时')), 8000);
      });
    }
    T('四人全部入座', clients.every(cl => cl.seat >= 0) && new Set(clients.map(c=>c.seat)).size===4);

    // 开局（3 局场）
    for(let i=1;i<4;i++) clients[i].c.emit('toggleReady', {});
    await wait(300);
    clients[0].c.emit('setSettings', { rounds:3, start:true });
    const started = await until(() => clients.some(cl => cl.lastSnap && cl.lastSnap.G && !cl.lastSnap.seriesOver));
    T('已开局（场进行中）', started);

    // —— 路径一：发起后有人拒绝 → 作废 ——
    clients.forEach(cl => { cl.askCount=0; });
    clients[0].c.emit('endSeries');
    const voteVisible = await until(() => clients.some(cl => cl.lastSnap && cl.lastSnap.endVote));
    T('发起后 endVote 进入快照', voteVisible);
    T('其余三人都收到 endSeriesAsk', clients.slice(1).every(cl => cl.askCount >= 1));
    const askBefore = clients[1].askCount;
    // 一人拒绝
    clients[1].c.emit('endSeriesVote', { vote:false });
    const cancelled = await until(() => clients.some(cl => cl.sawVote && cl.lastSnap && cl.lastSnap.endVote === null));
    T('拒绝后请求作废（endVote 清空）', cancelled);
    const logReject = clients.some(cl => cl.logs.some(l => /不同意/.test(l)));
    T('日志记录被拒绝', logReject);

    // —— 路径二：三人全同意 → 场结束 ——
    clients.forEach(cl => { cl.askCount=0; });
    clients[0].c.emit('endSeries');
    const voteVisible2 = await until(() => clients.some(cl => cl.lastSnap && cl.lastSnap.endVote));
    T('再次发起成功', voteVisible2);
    for(let i=1;i<4;i++) clients[i].c.emit('endSeriesVote', { vote:true });
    const ended = await until(() => clients.some(cl => {
      const s=cl.lastSnap; return s && s.seriesOver && s.G === null;
    }), 10000);
    T('三人全同意 → 场提前结束（seriesOver=true, G 清空）', ended);
    const logEnd = clients.some(cl => cl.logs.some(l => /本场提前结束/.test(l)));
    T('日志记录提前收场', logEnd);
    // 局中发起：本局废弃，本场累计应为 0
    const finalClient = clients.find(cl => cl.lastSnap && cl.lastSnap.seriesOver);
    const finalSnap = finalClient ? finalClient.lastSnap : null;
    if(finalSnap && !(finalSnap.series && finalSnap.series.totals)){
      console.log('  [诊断] finalSnap keys=', Object.keys(finalSnap), ' series=', JSON.stringify(finalSnap.series));
    }
    T('本场累计为 0（本局废弃不计）', !!(finalSnap && finalSnap.series && finalSnap.series.totals) && finalSnap.series.totals.every(t => t === 0));

  }catch(e){
    console.log('运行异常：', e && e.stack ? e.stack : e);
    fail++;
  }finally{
    clients.forEach(cl => { try{ cl.c.close(); }catch(e){} });
    srv.kill();
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();