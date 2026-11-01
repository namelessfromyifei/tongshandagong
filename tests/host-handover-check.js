/* =========================================================
 * 通山打拱 · 房主掉线移交 / 掉线提示 / 房主踢人 端到端检查
 *  ① 有人掉线 → 全员收到 toast
 *  ② 房主掉线 → toast 提示「N 分钟内未重连将自动移交房主」
 *  ③ 房主掉线满 HOST_OFFLINE_HANDOVER_MS → 房主移交给在线真人（座位保留、人数不变）
 *  ④ 掉线满 OFFLINE_KICK_WAIT_MS → 新房主可踢出，并 toast 全房
 * 运行：node tests/host-handover-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18140;
const ROOT = path.resolve(__dirname, '..');
const OFFLINE_KICK_WAIT_MS = 400;
const HOST_HANDOVER_MS = 800;
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
  const o = { c, seat:-1, snap:null, toasts:[], joined:null, promoted:0 };
  c.on('state', s => { o.snap = s; });
  c.on('toast', m => { o.toasts.push(String(m && typeof m === 'object' ? m.text : m)); });
  c.on('joined', d => { o.seat = d.seat; o.joined = d; });
  c.on('promotedHost', () => { o.promoted++; });
  return o;
}
async function until(fn, ms){
  const t0 = Date.now();
  while(Date.now() - t0 < (ms || 5000)){
    if(fn()) return true;
    await wait(50);
  }
  return false;
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ROOM_IDLE_KICK_MS: '0',
      OFFLINE_KICK_WAIT_MS: String(OFFLINE_KICK_WAIT_MS),
      HOST_OFFLINE_HANDOVER_MS: String(HOST_HANDOVER_MS),
      REJOIN_TAKEOVER_MS: '0',
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
    // ── ①/②/③/④ 房主掉线：提示 → 移交 → 踢人 ──
    {
      const A = reg(await connect());
      const B = reg(await connect());
      A.c.emit('create', { name:'甲' });
      while(!A.joined) await wait(50);
      B.c.emit('join', { code:A.joined.code, name:'乙' });
      while(!B.joined) await wait(50);
      const code = A.joined.code;

      A.c.close(); // 房主掉线
      const off = await until(() => B.snap && B.snap.seats[A.seat] && B.snap.seats[A.seat].offline);
      T('① 房主掉线后座位标记 offline', off);

      const toastOff = await until(() => B.toasts.some(m => /房主 .*掉线/.test(m)), 3000);
      T('② 房主掉线 → 全员收到 toast', toastOff, B.toasts);
      T('② 提示包含「自动移交房主」', B.toasts.some(m => /自动移交房主/.test(m)));

      // 3️⃣ 满 HOST_OFFLINE_HANDOVER_MS → 移交给在线真人
      const handed = await until(() => B.snap && B.snap.hostSeat === B.seat, 4000);
      T('③ 房主掉线超时 → 房主移交给在线真人', handed, B.snap && B.snap.hostSeat);
      T('③ 新房东收到 promotedHost', B.promoted >= 1, B.promoted);
      T('③ 移交 toast 通知全房', B.toasts.some(m => /房主已移交给/.test(m)), B.toasts);
      T('③ 原房主座位保留（human + offline）',
        !!(B.snap && B.snap.seats[A.seat] && B.snap.seats[A.seat].type === 'human' && B.snap.seats[A.seat].offline),
        B.snap && B.snap.seats[A.seat]);
      T('③ 人数不变（humanCount=2）', !!(B.snap && B.snap.seats[0] && B.snap.seats[0].humanCount === 2),
        B.snap && B.snap.seats[0] && B.snap.seats[0].humanCount);

      // 4️⃣ 新房主踢出掉线玩家
      await wait(OFFLINE_KICK_WAIT_MS + 300);
      B.toasts.length = 0;
      B.c.emit('kickSeat', { seat: A.seat });
      const kicked = await until(() => B.snap && B.snap.seats[A.seat] &&
        B.snap.seats[A.seat].type === 'ai' && B.snap.seats[A.seat].name === '空位', 4000);
      T('④ 掉线满阈值 → 新房主可踢出', kicked, B.snap && B.snap.seats[A.seat]);
      T('④ 踢人 toast 提示全房', B.toasts.some(m => /房主移出掉线玩家/.test(m)), B.toasts);
      T('④ 踢出后人数-1', !!(B.snap && B.snap.seats[0] && B.snap.seats[0].humanCount === 1));
      try{ B.c.close(); }catch(e){}
    }

    // ── ⑤ 普通玩家掉线 → 全员 toast，房主不移交 ──
    {
      const A = reg(await connect());
      const B = reg(await connect());
      const C = reg(await connect());
      A.c.emit('create', { name:'东' });
      while(!A.joined) await wait(50);
      B.c.emit('join', { code:A.joined.code, name:'南' });
      while(!B.joined) await wait(50);
      C.c.emit('join', { code:A.joined.code, name:'西' });
      while(!C.joined) await wait(50);

      C.c.close();
      const off = await until(() => B.snap && B.snap.seats[C.seat] && B.snap.seats[C.seat].offline);
      T('⑤ 普通玩家掉线后座位标记 offline', off);
      const toast = await until(() => B.toasts.some(m => /西 掉线，等待重连/.test(m)), 3000);
      T('⑤ 掉线 toast 提示所有在线玩家', toast, B.toasts);
      await wait(HOST_HANDOVER_MS + 300);
      T('⑤ 普通玩家掉线不触发房主移交', !!(B.snap && B.snap.hostSeat === A.seat), B.snap && B.snap.hostSeat);
      try{ A.c.close(); B.c.close(); }catch(e){}
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
