/* =========================================================
 * 通山打拱 · 场进行中掉线兜底检查
 *  ① 1 人掉线：其余 3 位在线真人全票同意 → 场提前结束
 *  ② 2 人掉线：其余 2 位在线真人全票同意 → 场提前结束
 *  ③ 3 人掉线：剩 1 人不能立即收场；离线满 OFFLINE_END_MS 后才允许独自收场
 *  ④ 4 人全掉线：超过 OFFLINE_END_MS → 自动提前结束（0 局不记历史）
 * 运行：node tests/offline-end-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18120;
const ROOT = path.resolve(__dirname, '..');
const OFFLINE_END_MS = 1500; // 测试用：把 10 分钟缩短到 1.5 秒
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
    await wait(60);
  }
  return false;
}

// 建一间 4 真人房并开局（对局停在确认轮，不会再自然结束）
async function makeRoom(names){
  const cls = names.map(n => ({ name:n, seat:-1, lastSnap:null, toasts:[], logs:[], c:null }));
  for(let i=0;i<cls.length;i++){
    const c = await connect(PORT);
    cls[i].c = c;
    c.on('state', s => { cls[i].lastSnap = s; });
    c.on('toast', m => { cls[i].toasts.push(String(m)); });
    c.on('log', l => { cls[i].logs.push(String(l)); });
    c.on('joined', d => { cls[i].seat = d.seat; });
  }
  let code = '';
  await new Promise((res, rej) => {
    cls[0].c.once('joined', d => { code = d.code; res(); });
    cls[0].c.emit('create', { name:names[0] });
    setTimeout(() => rej(new Error('create 超时')), 8000);
  });
  for(let i=1;i<cls.length;i++){
    await new Promise((res, rej) => {
      cls[i].c.once('joined', () => res());
      cls[i].c.emit('join', { code, name:names[i] });
      setTimeout(() => rej(new Error('join 超时')), 8000);
    });
  }
  for(const cl of cls) cl.c.emit('toggleReady', {});
  const started = await until(() => cls.some(cl => cl.lastSnap && cl.lastSnap.G && !cl.lastSnap.seriesOver));
  if(!started) throw new Error('开局失败');
  return { code, cls };
}
const closeAll = cls => cls.forEach(cl => { try{ cl.c.close(); }catch(e){} });

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ROOM_IDLE_KICK_MS: '0',
      REJOIN_TAKEOVER_MS: '0',
      OFFLINE_END_MS: String(OFFLINE_END_MS),
      DB_PATH: ':memory:',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += d.toString(); });
  srv.stderr.on('data', d => { out += d.toString(); });
  const startAt = Date.now();
  while(!/服务器已启动/.test(out) && Date.now() - startAt < 8000) await wait(120);

  try{
    // —— ① 1 人掉线 → 其余 3 人全票 ——
    {
      const { code, cls } = await makeRoom(['甲','乙','丙','丁']);
      cls[3].c.close();
      const off = await until(() => cls[0].lastSnap && cls[0].lastSnap.seats[3].offline);
      T('① 丁掉线标记 offline', off);
      cls[0].c.emit('endSeries');
      const voted = await until(() => cls[0].lastSnap && cls[0].lastSnap.endVote);
      T('① 1 人掉线时可发起表决', voted);
      T('① 门槛=3（在线真人）', cls[0].lastSnap && cls[0].lastSnap.endVote && cls[0].lastSnap.endVote.need === 3,
        cls[0].lastSnap && cls[0].lastSnap.endVote);
      cls[1].c.emit('endSeriesVote', { vote:true });
      const stillVoting = await until(() => cls[0].lastSnap && cls[0].lastSnap.endVote, 600);
      T('① 2 票时仍在等第 3 票', stillVoting);
      cls[2].c.emit('endSeriesVote', { vote:true });
      const ended = await until(() => cls.some(cl => cl.lastSnap && cl.lastSnap.seriesOver));
      T('① 3 票全同意 → 场提前结束', ended);
      T('① 日志记录提前收场', cls.some(cl => cl.logs.some(l => /本场提前结束/.test(l))));
      closeAll(cls);
    }

    // —— ② 2 人掉线 → 其余 2 人全票 ——
    {
      const { cls } = await makeRoom(['甲','乙','丙','丁']);
      cls[2].c.close(); cls[3].c.close();
      const off = await until(() => cls[0].lastSnap && cls[0].lastSnap.seats[2].offline && cls[0].lastSnap.seats[3].offline);
      T('② 丙、丁掉线标记 offline', off);
      cls[0].c.emit('endSeries');
      await until(() => cls[0].lastSnap && cls[0].lastSnap.endVote);
      T('② 门槛=2（在线真人）', cls[0].lastSnap && cls[0].lastSnap.endVote && cls[0].lastSnap.endVote.need === 2,
        cls[0].lastSnap && cls[0].lastSnap.endVote);
      cls[1].c.emit('endSeriesVote', { vote:true });
      const ended = await until(() => cls.some(cl => cl.lastSnap && cl.lastSnap.seriesOver));
      T('② 2 票全同意 → 场提前结束', ended);
      closeAll(cls);
    }

    // —— ③ 3 人掉线 → 剩 1 人不能立即收场，离线超时后放行 ——
    {
      const { cls } = await makeRoom(['甲','乙','丙','丁']);
      cls[1].c.close(); cls[2].c.close(); cls[3].c.close();
      await until(() => cls[0].lastSnap && cls[0].lastSnap.seats[1].offline
        && cls[0].lastSnap.seats[2].offline && cls[0].lastSnap.seats[3].offline);
      cls[0].toasts.length = 0;
      cls[0].c.emit('endSeries');
      const blocked = await until(() => cls[0].toasts.some(m => /至少 2 位在线真人/.test(m)), 2000);
      T('③ 剩 1 人立即收场被拒', blocked, cls[0].toasts);
      T('③ 未生成表决', !(cls[0].lastSnap && cls[0].lastSnap.endVote));
      await wait(OFFLINE_END_MS + 300); // 等离线座位超过 OFFLINE_END_MS
      cls[0].c.emit('endSeries');
      const ended = await until(() => cls[0].lastSnap && cls[0].lastSnap.seriesOver, 4000);
      T('③ 离线满 OFFLINE_END_MS 后剩 1 人可收场', ended);
      closeAll(cls);
    }

    // —— ④ 4 人全掉线 → 自动提前结束（0 局不记历史） ——
    {
      const { code, cls } = await makeRoom(['甲','乙','丙','丁']);
      closeAll(cls);
      await wait(OFFLINE_END_MS + 900);
      const c = await connect(PORT);
      let snap = null;
      c.on('state', s => { snap = s; });
      await new Promise(res => {
        c.once('joined', res);
        c.emit('rejoin', { code, name:'甲', auto:true });
        setTimeout(res, 5000);
      });
      const got = await until(() => snap && snap.seriesOver, 5000);
      T('④ 全房离线超时 → 自动提前结束', got, snap && { seriesOver: snap.seriesOver, G: !!snap.G });
      T('④ 局中收场：G 清空', got && snap.G === null);
      T('④ 本场累计保留（0 局仍为 0）', got && snap.series && snap.series.totals.every(t => t === 0),
        got && snap.series);
      T('④ 0 局不记历史', got && Array.isArray(snap.history) && snap.history.length === 0,
        got && snap.history);
      try{ c.close(); }catch(e){}
    }
  }catch(e){
    console.log('运行异常：', e && e.stack ? e.stack : e);
    if(out) console.log('--- server output ---\n' + out.slice(-2000));
    fail++;
  }finally{
    try{ srv.kill(); }catch(e){}
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
