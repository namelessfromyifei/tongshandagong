/* =========================================================
 * 通山打拱 · 开局前有人掉线检查
 *  ① 全员已准备后有人掉线 → 该座 ready 清空、房主点开始不会开局
 *  ② 掉线者重连并重新准备、房主也准备后 → 正常开局
 * 运行：node tests/ready-offline-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18176;
const ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function T(name, cond, extra){
  if(cond){ pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra!==undefined ? ' => ' + JSON.stringify(extra) : '')); }
}
function connect(){
  return new Promise((res, rej) => {
    const c = io('http://127.0.0.1:' + PORT, { reconnection: false, transports: ['websocket'], timeout: 10000 });
    c.on('connect', () => res(c));
    c.on('connect_error', e => rej(e));
  });
}
function reg(c){
  const o = { c, seat:-1, snap:null, toasts:[], joined:null };
  c.on('state', s => { o.snap = s; });
  c.on('toast', m => { o.toasts.push(String(m && typeof m === 'object' ? m.text : m)); });
  c.on('joined', d => { o.seat = d.seat; o.joined = d; });
  return o;
}
async function until(fn, ms){
  const t0 = Date.now();
  while(Date.now() - t0 < (ms || 6000)){
    if(fn()) return true;
    await wait(60);
  }
  return false;
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ROOM_IDLE_KICK_MS: '0',
      OFFLINE_KICK_WAIT_MS: '60000',
      HOST_OFFLINE_HANDOVER_MS: '100000',
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
    const A = reg(await connect());
    const B = reg(await connect());
    const C = reg(await connect());
    const D = reg(await connect());
    A.c.emit('create', { name:'甲' });
    while(!A.joined) await wait(50);
    const code = A.joined.code;
    for(const [cl, nm] of [[B,'乙'],[C,'丙'],[D,'丁']]){
      cl.c.emit('join', { code, name:nm });
      while(!cl.joined) await wait(50);
    }
    // 乙丙丁准备，房主甲未准备
    for(const cl of [B,C,D]) cl.c.emit('toggleReady', {});
    await wait(400);
    T('三人已准备、房主未准备 → 未开局', !(A.snap && A.snap.G));

    // 丁掉线（ready 应被清空）
    const dSeat = D.seat;
    D.c.close();
    const off = await until(() => A.snap && A.snap.seats[dSeat] && A.snap.seats[dSeat].offline === true);
    T('丁掉线标记 offline', off);
    T('丁掉线后 ready 清空', !!(A.snap && A.snap.ready && A.snap.ready[dSeat] === false), A.snap && A.snap.ready);

    // 房主点开始（setSettings start）→ 不应开局
    A.toasts.length = 0;
    A.c.emit('setSettings', { start:true });
    await wait(800);
    T('有人掉线时点开始不会开局', !(A.snap && A.snap.G), A.snap && { G: !!A.snap.G });
    T('提示有玩家掉线', A.toasts.some(t => /已掉线/.test(t)), A.toasts);

    // 丁重连（auto 归位）→ 重新准备；房主准备 → 应当开局
    const D2 = reg(await connect());
    D2.c.emit('rejoin', { code, name:'丁', auto:true });
    while(!D2.joined) await wait(50);
    T('丁重连归位', D2.seat === dSeat);
    D2.c.emit('toggleReady', {});
    A.c.emit('toggleReady', {});
    const started = await until(() => A.snap && A.snap.G && !A.snap.seriesOver, 6000);
    T('掉线者重连并重新准备后正常开局', started);

    A.c.close(); B.c.close(); C.c.close(); D2.c.close();
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
