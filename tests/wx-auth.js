/* =========================================================
 * 通山打拱 · 微信网页授权（WX_MOCK）集成测试
 * 覆盖：未授权访问、OAuth 回调、签名 Cookie 校验、
 *       Socket 建桌时以服务端会话身份覆盖客户端昵称。
 * 运行：node tests/wx-auth.js
 * ========================================================= */
"use strict";
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { io } = require('socket.io-client');

let pass = 0, fail = 0;
const T = (name, cond, extra) => {
  if(cond){ pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' => ' + JSON.stringify(extra) : '')); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));

function freePort(){
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
function cookieValue(setCookie, name){
  const m = String(setCookie || '').match(new RegExp('(?:^|,\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
async function waitServer(url){
  for(let i = 0; i < 50; i++){
    try{ const r = await fetch(url + '/api/wx/config'); if(r.ok) return; }catch(e){}
    await wait(100);
  }
  throw new Error('server not ready');
}
function createRoom(url, cookie, name){
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['polling'], extraHeaders: cookie ? { Cookie: cookie } : {} });
    let seat = -1;
    const timer = setTimeout(() => { s.close(); reject(new Error('create timeout')); }, 5000);
    s.on('connect', () => s.emit('create', { name }));
    s.on('joined', d => { seat = d.seat; });
    s.on('state', st => {
      if(seat < 0) return;
      clearTimeout(timer);
      s.close();
      resolve({ joinedName: st.seats[seat] && st.seats[seat].name, seat: st.seats[seat] });
    });
    s.on('connect_error', e => { clearTimeout(timer); s.close(); reject(e); });
  });
}

(async () => {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      NODE_ENV: 'test',
      WX_MOCK: '1',
      SESSION_SECRET: 'test-session-secret',
      DB_PATH: ':memory:',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  try{
    await waitServer(base);

    /* ---------- 配置与未登录 ---------- */
    const cfg = await (await fetch(base + '/api/wx/config')).json();
    T('WX_MOCK 下 /api/wx/config enabled', cfg.enabled === true, cfg);
    T('WX_MOCK 标记', cfg.mock === true, cfg);

    const anonymous = await (await fetch(base + '/api/me')).json();
    T('未登录 /api/me 返回 ok=false', anonymous.ok === false, anonymous);

    const forged = await (await fetch(base + '/api/me', { headers: { Cookie: 'ts_wx=forged.sig' } })).json();
    T('伪造 Cookie 被拒绝', forged.ok === false, forged);

    /* ---------- 授权回调 ---------- */
    const startRes = await fetch(base + '/api/wx/start?next=%2F', { redirect: 'manual' });
    const startLocation = startRes.headers.get('location') || '';
    const stateCookie = cookieValue(startRes.headers.get('set-cookie'), 'ts_wx_state');
    T('start 302 到 callback', startRes.status === 302 && startLocation.includes('/api/wx/callback'), { code: startRes.status, startLocation });
    T('start 下发 state Cookie', !!stateCookie, startRes.headers.get('set-cookie'));

    const cbRes = await fetch(base + startLocation, { redirect: 'manual', headers: { Cookie: 'ts_wx_state=' + stateCookie } });
    const sessionCookie = cookieValue(cbRes.headers.get('set-cookie'), 'ts_wx');
    T('callback 302 回 next', cbRes.status === 302 && (cbRes.headers.get('location') || '') === '/', { code: cbRes.status, loc: cbRes.headers.get('location') });
    T('callback 下发签名会话 Cookie', !!sessionCookie, cbRes.headers.get('set-cookie'));

    const me = await (await fetch(base + '/api/me', { headers: { Cookie: 'ts_wx=' + sessionCookie } })).json();
    T('登录后 /api/me 返回昵称', me.ok === true && me.profile && me.profile.nickname === '微信测试用户', me);
    T('登录后 /api/me 返回头像', !!(me.profile && me.profile.avatar), me);

    /* ---------- state 不匹配 ---------- */
    const badCb = await fetch(base + '/api/wx/callback?code=mock&state=wrong', { redirect: 'manual', headers: { Cookie: 'ts_wx_state=' + stateCookie } });
    T('state 不匹配被拒绝', (badCb.headers.get('location') || '').includes('wxerr=state'), badCb.headers.get('location'));

    /* ---------- Socket 身份 ---------- */
    const wxRoom = await createRoom(base, 'ts_wx=' + sessionCookie, '我是伪造昵称');
    T('Socket 建桌使用微信昵称（忽略客户端昵称）', wxRoom.seat && wxRoom.seat.name === '微信测试用户', wxRoom.seat);
    T('Socket 建桌带上微信头像', wxRoom.seat && wxRoom.seat.avatar === '/api/wx/mock-avatar.svg', wxRoom.seat);

    const manualRoom = await createRoom(base, '', '手动玩家');
    T('未授权时仍可使用手动昵称', manualRoom.seat && manualRoom.seat.name === '手动玩家', manualRoom.seat);
    T('手动昵称无头像', manualRoom.seat && manualRoom.seat.avatar === '', manualRoom.seat);

    /* ---------- 房间快照不泄露 openid ---------- */
    T('快照座位不含 openid', manualRoom.seat && !('openid' in manualRoom.seat), manualRoom.seat);
    T('微信座位快照不含 openid', wxRoom.seat && !('openid' in wxRoom.seat), wxRoom.seat);
  }catch(e){
    fail++;
    console.log('FAIL 测试执行异常 => ' + (e && e.message ? e.message : e));
    console.log(serverLog);
  }finally{
    child.kill();
    await wait(200);
    console.log(`\n结果：${pass} 通过, ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
})();
