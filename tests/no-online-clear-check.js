/* =========================================================
 * 通山打拱 · 房间长期无在线真人 → 清退所有玩家 端到端检查
 *  ① 有人在线 → 不触发清退
 *  ② 无人在线超过 ROOM_NO_ONLINE_CLEAR_MS → 普通房解散（所有玩家被清退）
 *  ③ 常驻房（HOME）：房间保留，清空全部真人座，下一位进房者从空房开始并成为房主
 * 运行：node tests/no-online-clear-check.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 18160;
const ROOT = path.resolve(__dirname, '..');
const CLEAR_MS = 900;
const HANDOVER_MS = 400;
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
  const o = { c, seat:-1, snap:null, joined:null };
  c.on('state', s => { o.snap = s; });
  c.on('joined', d => { o.seat = d.seat; o.joined = d; });
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
      ROOM_NO_ONLINE_CLEAR_MS: String(CLEAR_MS),
      HOST_OFFLINE_HANDOVER_MS: String(HANDOVER_MS),
      OFFLINE_KICK_WAIT_MS: '300',
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
    // 大厅旁观 socket：只拉房间列表，不加入任何房间
    const obs = reg(await connect());
    function probe(){
      return new Promise(res => {
        const h = list => { obs.c.removeListener('rooms', h); res(list || []); };
        obs.c.on('rooms', h);
        obs.c.emit('listRooms');
        setTimeout(() => { obs.c.removeListener('rooms', h); res(null); }, 3000);
      });
    }

    // ── ① 有人在线 → 不触发清退 ──
    {
      const A = reg(await connect());
      const B = reg(await connect());
      A.c.emit('create', { name:'甲' });
      while(!A.joined) await wait(50);
      B.c.emit('join', { code:A.joined.code, name:'乙' });
      while(!B.joined) await wait(50);
      const code = A.joined.code;
      B.c.close(); // 乙掉线，但甲仍在线
      await wait(CLEAR_MS + 500);
      const list = await probe();
      const ent = list && list.find(x => x.code === code);
      T('① 有人在线 → 房间不清退', !!(ent && ent.humans === 2), ent && { humans: ent && ent.humans, offline: ent && ent.offline });
      try{ A.c.close(); }catch(e){}
    }

    // ── ② 无人在线超时 → 普通房解散 ──
    {
      const A = reg(await connect());
      A.c.emit('create', { name:'甲' });
      while(!A.joined) await wait(50);
      const code = A.joined.code;
      A.c.close();
      await wait(CLEAR_MS + 700);
      const list = await probe();
      T('② 无人在线超时 → 普通房被解散（房间消失）',
        !!list && !list.some(x => x.code === code), (list||[]).map(x => x.code));
    }

    // ── ③ 常驻房：房间保留、真人座清空；下一位进房者从空房开始并成为房主 ──
    {
      const X = reg(await connect());
      X.c.emit('join', { code:'HOME', name:'甲' });
      while(!X.joined) await wait(50);
      T('③ 甲进常驻房 HOME 入座 0', X.seat === 0, X.seat);
      X.c.close();
      await wait(CLEAR_MS + 700);
      const list = await probe();
      const home = list && list.find(x => x.code === 'HOME');
      T('③ 常驻房 HOME 不被解散', !!(home && home.humans === 0), home);
      const E = reg(await connect());
      E.c.emit('join', { code:'HOME', name:'乙' });
      while(!E.joined) await wait(50);
      const becomeHost = await until(() => E.snap && E.snap.hostSeat === E.seat, 4000);
      T('③ 旧真人已被清退：乙从空房入座 0', E.seat === 0 && !!(E.snap && E.snap.seats[0] && E.snap.seats[0].name === '乙'),
        { seat: E.seat, name: E.snap && E.snap.seats[0] && E.snap.seats[0].name });
      T('③ 首位进房者成为常驻房房主', becomeHost);
      try{ obs.c.close(); E.c.close(); }catch(e){}
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