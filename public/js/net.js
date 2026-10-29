/* =========================================================
 * 通山打拱 · 网络层（Socket.IO 客户端）
 * 负责：连接、创建/加入房间、重连、动作发送、接收状态→GameUI
 * ========================================================= */
(function(){
"use strict";
const UI = window.GameUI;
let socket=null;
let socketReset=false; // socket 需重建的标记：被服务端强制断开（删房/被踢）时置位，下次 connect() 重建单例
let mySeat=-1, myName='';
let roomCode='';
let inGame=false; // 是否已在对局中（用于退出时判断保留重连）
let roomCache=[]; // 最近一次服务器房间列表（加入/重连弹窗复用）
let history=[];   // 本房历史分数（最近 10 场，服务端下发）
let me=null;      // 微信授权身份 {nickname, avatar}
let wxConfig={enabled:false, mock:false, wechat:false};
let authReady=false;
let endAskRequester=-1; // 当前提前收场表决的发起方座位（-1=无）
let curG=null, curSeriesOver=false, curHostSeat=-1; // 最近一次快照的状态（对局配置锁定/房主判断用）

const $=id=>document.getElementById(id);

// ③ 风暴合帧：同一动画帧里连来的多帧快照只渲染「最新一帧」（rAF 节拍，最多延迟一个 vsync ≤16ms）。
// 论证：
//  - 桌内无逐帧动画依赖——唯一 CSS 过渡是 .hcard/.avatar 的 transform/背景过渡，且「选牌上浮」
//    是本地 classList 操作，不依赖状态帧；出牌落位无逐帧动画，跳过中间帧安全。
//  - 语音播词仅在「同一动画帧内多事件」时会合并漏播一句（真人手速下概率≈0），可接受。
//  - 后台标签页 rAF 暂停：只保留最新快照、内存有界，回前台自动追平。
// 影响面受控：只包裹 socket 'state' 的渲染尾；e2e（直走 socket 监听）与 jsdom 测试
// （直调 GameUI.applyState）都不经过 net.js，不受影响。
let _rafTick = 0, _latestState = null;
const _raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
  ? window.requestAnimationFrame.bind(window)
  : cb => setTimeout(cb, 16);
function stageRender(snap){
  _latestState = snap;
  if(_rafTick) return; // 已有 flush 在途：仅把「最新帧」交给它
  _rafTick = _raf(() => {
    _rafTick = 0;
    const s = _latestState; _latestState = null;
    if(s){ try{ UI.applyState(s); }catch(e){ try{ console.error('applyState 错误：', e); }catch(_){} } }
  });
}

/* ---------- 运行环境 ----------
 * App（Capacitor）里页面从本地资源包加载，origin 是 https://localhost，
 * 与服务器域名不同源，因此 API / Socket 必须使用绝对地址。
 * 浏览器里仍走同源相对路径，行为不变。 */
const IS_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const DEFAULT_SERVER_ORIGIN = 'https://www.zhangyuning.xyz';
// 可用 tools/build-apk.js --server <地址> 覆盖（写入 js/env.js），用于域名备案前的 IP 内测
const SERVER_ORIGIN = IS_APP ? (window.TS_SERVER_ORIGIN || DEFAULT_SERVER_ORIGIN) : '';
const apiUrl = p => SERVER_ORIGIN + p;

/* ---------- 房间界面 ---------- */
function enterLobby(){
  const app=document.getElementById('app');
  if(app){ app.classList.remove('inTable'); app.classList.add('inLobby'); }
  if($('btnRoomToggle')) $('btnRoomToggle').textContent='返回大厅';
  // 离开牌桌：解除横屏（大厅可竖屏）
  if(window.LANDSCAPE) window.LANDSCAPE.exit();
}
function enterTable(){
  const app=document.getElementById('app');
  if(app){ app.classList.remove('inLobby'); app.classList.add('inTable'); }
  // 进入房间：强制横屏
  if(window.LANDSCAPE) window.LANDSCAPE.enter();
  // 进房自动尝试全屏（需要用户手势；失败时进桌后首次触摸会再试一次）
  if(window.enterGameFullscreen) window.enterGameFullscreen();
}

function toast(msg){
  const app=document.getElementById('app');
  const inTable = !!(app && app.classList.contains('inTable'));
  if(inTable){ showTableToast(String(msg)); return; } // 牌桌内：浮动 toast
  const el=$('status');
  if(el) el.textContent=msg;
  setTimeout(()=>{ if(el) el.textContent=''; }, 4000);
}
// 牌桌内浮动提示（供 net.js toast 与 ui-net flashMsg 共用）——#status 只能在大厅看见
// 对局配置弹窗只读开关：一场未结束时除「保存」外全部禁用（对局中设置不可改）
function syncSetLock(){
  const m=$('setModal'); if(!m) return;
  const locked = !!(curG && !curSeriesOver);
  const nodes=m.querySelectorAll('select,input,button');
  for(const n of nodes){ if(n.id==='btnSetBack') continue; n.disabled=locked; }
  const h=$('setLockHint'); if(h) h.style.display=locked?'':'none';
}
// 牌桌内浮动提示（供 net.js toast 与 ui-net flashMsg 共用）——#status 只能在大厅看见。
// 位置由 CSS 锚定在出牌排左侧（随旋转/窄屏自适应），这里只负责显隐。
function showTableToast(msg){
  const t=document.getElementById('tableToast');
  if(!t) return;
  t.textContent=String(msg);
  t.classList.add('show');
  if(t._tt){ clearTimeout(t._tt); t._tt=null; }
  t._tt=setTimeout(()=>{ t.classList.remove('show'); }, 3200);
}
window.showTableToast = showTableToast;
// HTML 转义：任何来自服务器/用户的名字、房间号在拼 innerHTML 前必须过这里（服务端已加 4 位白名单，双保险）
function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ---------- 连接 ---------- */
function connect(){
  if(socket && !socketReset){
    // socket 单例：会话全程只建一个 socket。已存在即复用；瞬断交给 socket.io
    // 自动重连（未连上时的 emit 会被缓冲，重连成功后补发），不再重复 new io()。
    return;
  }
  if(socket){
    try{ socket.removeAllListeners(); socket.disconnect(); }catch(e){}
    socket=null;
  }
  socketReset=false;
  socket = SERVER_ORIGIN ? io(SERVER_ORIGIN) : io();
  socket.on('connect', ()=>{
    toast('已连接服务器');
    if(socket){
      // 断线重连：自动用当前身份归位（微信会话在 Cookie 中，服务端按 openid 匹配）
      if(roomCode && myName) socket.emit('rejoin', {code:roomCode, name:myName, auto:true});
      socket.emit('listRooms');
    }
  });

  socket.on('rooms', (list)=>{ roomCache=list||[]; renderRoomList(roomCache); renderJoinPick(); renderRejoinPick(); });

  // 创建房间成功 → 直接进桌（joined 处理）
  socket.on('joined', (d)=>{
    mySeat=d.seat; myName=d.name; roomCode=d.code;
    if(d.avatar && me) me.avatar=d.avatar;
    // 加入/重连成功：关闭加入、重连弹窗
    const jm=$('joinModal'); if(jm) jm.hidden=true;
    const rm=$('rejoinModal'); if(rm) rm.hidden=true;
    // 记住房间+姓名，刷新后自动重连
    try{ localStorage.setItem('tsRoom', JSON.stringify({code:d.code, name:d.name})); }catch(e){}
    $('roomCode').textContent = '房间号：'+d.code;
    $('mySeatInfo').textContent = d.name; // 房主标识随后按 hostSeat 精确更新
    enterTable();
  });

  socket.on('state', (snap)=>{
    inGame = !!(snap.G && !snap.G.ended);  // 仅"本局进行中"视为对局中：局末/场末退出即真退（不再视作掉线）
    curG = snap.G || null; curSeriesOver = !!snap.seriesOver; curHostSeat = (snap.hostSeat!=null ? snap.hostSeat : -1);
    history = (snap.history) || [];
    syncSetLock(); // 一场未结束 → 对局配置弹窗只读（除“返回”外全部禁用）
    // 提前收场表决已结束/作废 → 收起弹窗
    if(endAskRequester!==-1 && !snap.endVote){
      const m=$('endAskModal'); if(m) m.hidden=true; endAskRequester=-1;
    }
    applySettings(snap.settings);
    // AI 补位复选框：用 snap.aiFill（顶层字段）同步，避免 settings 覆盖
    if(snap.aiFill!=null && $('setAIFill')) $('setAIFill').checked=!!snap.aiFill;
    // 准备状态同步
    const readyArr = snap.ready || [];
    UI.setSelf(mySeat, snap.seats.map(s=>s.name), snap.seats.map(s=>s.type), snap.aiFill, snap.seats.map(s=>!!s.offline), readyArr, snap.seats.map(s=>s.avatar||''));
    // 房主才显示"对局配置"：对局进行中（已发牌且未结束）隐藏，未开局或本局已结束可配置（hostSeat 与座位解耦）
    if(snap.hostSeat!=null){
      // 左上角固定显示「房主：xx」：xx 取实际房主（snap.hostSeat 对应座位名），
      // 自己是不是房主不影响文案（自己名字仍显示在己方座位行）
      if($('mySeatInfo')){
        const who = (snap.hostSeat!=null && snap.seats[snap.hostSeat]) ? snap.seats[snap.hostSeat].name : '';
        $('mySeatInfo').textContent = who ? `房主：${who}` : myName;
      }
      const canConfig = mySeat===snap.hostSeat && (!snap.G || snap.seriesOver); // 仅未开局或本场结束后可配置/开局
      if($('btnStart')) $('btnStart').style.display = canConfig ? 'inline-block' : 'none';
    }
    // 准备按钮：对局进行中（含确认轮、出牌轮）隐藏；未开始或一局结束才显示
    if($('btnReady')){
      const isReady = !!readyArr[mySeat];
      // 只要还有当前局（含已结束、等待”下一局”），就不显示”准备”；
      // 本场结束时服务端保留 G（牌桌冻结），此时才显示【准备】开下一场
      $('btnReady').style.display = (snap.G && !snap.seriesOver) ? 'none' : 'inline-block';
      $('btnReady').textContent = isReady ? '取消准备' : '准备';
      $('btnReady').classList.toggle('gold', isReady);
    }
    UI.setSeries && UI.setSeries(snap.series);
    // 服务器日志同步到前端日志（snap.G 里没有 log，服务器用 emit 单独推）
    stageRender(snap); // ③：同帧连来的多帧只渲染最新一帧（rAF 合帧）
  });

  socket.on('log', (line)=>{ UI.addLog(line); });

  // 被提升为房主（原房主退出）：hostSeat 与座位解耦，座位不变，仅提示
  socket.on('promotedHost', ()=>{
    toast('你已成为房主');
    if($('mySeatInfo')) $('mySeatInfo').textContent=`房主：${myName}`;
  });

  socket.on('roomClosed', ()=>{ roomClosed(); });

  // 顶替座位请求：有人想接管你的座位（仅在你在线时出现）。同意→请求方重新归位完成接管（你被顶替回大厅）；
  // 不同意→继续游戏。超时未答复按作废。
  socket.on('takeoverAsk', (d)=>{
    const who=(d && d.name) || '有玩家';
    const tm=$('takeoverAskModal'); if(!tm) return;
    const t=$('takeoverAskText');
    if(t) t.textContent = `${who} 想顶替你的座位，是否同意？\n【同意】你会清空牌桌并退回大厅；【不同意】继续本局游戏。`;
    if(tm._tt){ clearTimeout(tm._tt); tm._tt=null; }
    tm._tt=setTimeout(()=>{ tm.hidden=true; }, (d && d.expire) || 30000);
    tm.hidden=false;
  });
  // 顶替请求结果（给请求方）：同意→需再用同一连接 rejoin 一次完成归位；不同意/作废→提示
  socket.on('takeoverResult', (d)=>{
    if(d && d.ok){
      socket.emit('rejoin', {code:d.code || roomCode, name:d.name || myName, agree:true});
      return;
    }
    toast((d && d.reason) || '顶替请求被拒绝');
  });
  // 座位被他人顶替（你已同意、或对方掉线超时被接管）：清空牌桌并退回大厅
  socket.on('displaced', ()=>{
    roomCode=''; mySeat=-1; inGame=false;
    const jm=$('joinModal'); if(jm) jm.hidden=true;
    const rm=$('rejoinModal'); if(rm) rm.hidden=true;
    const em=$('endAskModal'); if(em) em.hidden=true;
    const tm=$('takeoverAskModal'); if(tm){ tm.hidden=true; if(tm._tt){ clearTimeout(tm._tt); tm._tt=null; } }
    const md=$('modal'); if(md) md.hidden=true;
    try{ localStorage.removeItem('tsRoom'); }catch(e){}
    if(UI && UI.resetTable) UI.resetTable(); // 清掉牌桌 DOM/对局状态，防残留
    enterLobby();
    toast('你的座位已被其他玩家接管，已退回大厅');
  });

  socket.on('toast', (m)=>{ toast(m); });

  // 提前结束本场：发起方显示「等待表决」，其他三家显示同意/拒绝
  socket.on('endSeriesAsk', (d)=>{
    endAskRequester = (d && Number.isInteger(d.requester)) ? d.requester : -1;
    const m=$('endAskModal'); if(!m) return;
    const txt=$('endAskText');
    const a=$('btnEndAgree'), r=$('btnEndReject'), c=$('btnEndClose');
    const mine = endAskRequester===mySeat;
    if(a) a.style.display = mine ? 'none' : '';
    if(r) r.style.display = mine ? 'none' : '';
    if(c) c.style.display = mine ? '' : 'none';
    if(mine){
      if(txt) txt.textContent='你已发起【提前结束本场】，等待其他三家在 30 秒内同意…';
    } else {
      const who=(d && d.name) || '有玩家';
      if(txt) txt.textContent=`${who} 发起【提前结束本场】。需要其他三家在 30 秒内全部同意才生效；若本局进行中会直接废弃。`;
    }
    m.hidden=false;
  });

  socket.on('disconnect', (reason)=>{
    toast('与服务器断开，尝试重连…');
    // 服务端强制断开（删房/被踢/闲置解散）：下次 connect() 要重建 socket（否则旧 socket 不会自动重连）
    if(reason==='io server disconnect') socketReset=true;
  });
}

/* ---------- 动作 ---------- */
function act(data){
  if(socket) socket.emit('act', Object.assign({seat:mySeat}, data));
}
function nextRound(){
  if(socket) socket.emit('nextRound', {});
}
function start(){
  if(socket) socket.emit('start', {});
}
function toggleAI(){
  if(socket) socket.emit('toggleAI', {});
}
// 退出房间回大厅
function leaveRoom(){
  // 局末（非末局）：不可退出房间，只能【结束场次】提前收场（含手机返回键触发的退出，一律拦下）
  if(curG && curG.ended && !curSeriesOver){
    toast('本局尚未结束，请点【结束场次】提前收场');
    return;
  }
  roomCode=''; // 退出标记：杜绝”点了退出后网络闪断又被自动 rejoin 回桌”
  if(socket) socket.emit('leave', {});
  // 对局中退出：保留 localStorage（可用同昵称重连）；未开局才清除
  if(inGame){
    toast('对局中退出视作掉线，可用昵称重连');
  } else {
    try{ localStorage.removeItem('tsRoom'); }catch(e){}
  }
  enterLobby();
}
// 房间解散（房主退出/被删）
function roomClosed(){
  roomCode='';
  socketReset=true; // 房间已不存在：强制断开后 socket 需要重建
  try{ localStorage.removeItem('tsRoom'); }catch(e){}
  toast('房间已解散，回到大厅');
  enterLobby();
}

/* ---------- 微信授权 ---------- */
// 授权回跳地址：去掉 wxerr/wxmanual，避免成功后仍反复提示错误
function authNext(){
  try{
    const u=new URL(location.href);
    u.searchParams.delete('wxerr');
    u.searchParams.delete('wxmanual');
    return u.pathname + (u.search || '');
  }catch(e){
    return location.pathname + location.search;
  }
}
function applyWxProfile(profile){
  me = (profile && profile.nickname) ? {nickname:profile.nickname, avatar:profile.avatar||''} : null;
  const row=$('nameRow'), box=$('wxProfile');
  if(me){
    myName=me.nickname;
    const ni=$('nameInput'); if(ni) ni.value=me.nickname;
    if(row) row.hidden=true;
    if(box) box.hidden=false;
    const nm=$('wxName'); if(nm) nm.textContent=me.nickname;
    const av=$('wxAvatar');
    if(av){
      if(me.avatar){ av.src=me.avatar; av.style.display=''; }
      else { av.removeAttribute('src'); av.style.display='none'; }
      av.onerror=()=>{ av.style.display='none'; };
    }
    const tip=$('lobbyTip'); if(tip) tip.textContent='已使用微信头像和昵称，选择创建或加入房间';
    try{ sessionStorage.removeItem('tsWxTried'); sessionStorage.removeItem('tsWxManual'); }catch(e){}
    try{
      const u=new URL(location.href);
      if(u.searchParams.has('wxerr') || u.searchParams.has('wxmanual')){
        history.replaceState(null, '', authNext());
      }
    }catch(e){}
  } else {
    if(row) row.hidden=false;
    if(box) box.hidden=true;
    const tip=$('lobbyTip');
    if(tip) tip.textContent = (wxConfig.enabled && wxConfig.wechat)
      ? '授权微信后可直接使用头像和昵称；也可以手动输入昵称'
      : '先设置昵称，然后创建房间或加入已有房间';
  }
  const wb=$('btnWxLogin');
  if(wb){
    // App 内不提供微信网页授权（WebView 里跳转会离开本地资源包），一律用手动昵称
    wb.hidden = IS_APP || !(wxConfig.enabled && !me && (wxConfig.wechat || wxConfig.mock));
    wb.onclick=()=>{
      try{ sessionStorage.removeItem('tsWxTried'); sessionStorage.removeItem('tsWxManual'); }catch(e){}
      location.href='/api/wx/start?next='+encodeURIComponent(authNext());
    };
  }
}
async function initAuth(){
  try{
    const r=await fetch(apiUrl('/api/wx/config'),{cache:'no-store'});
    if(r.ok) wxConfig=await r.json();
  }catch(e){}
  const q=new URLSearchParams(location.search);
  const err=q.get('wxerr');
  if(err){
    const msgs={unconfigured:'微信授权未配置，请手动输入昵称', state:'授权已过期，请重试', oauth:'微信授权失败，请重试'};
    setTimeout(()=>toast(msgs[err]||'微信授权失败'), 60);
  }
  if(q.get('wxmanual')==='1'){ try{ sessionStorage.setItem('tsWxManual','1'); }catch(e){} }
  try{
    const r=await fetch(apiUrl('/api/me'),{cache:'no-store'});
    const d=await r.json();
    if(d && d.ok) applyWxProfile(d.profile);
  }catch(e){}
  // 微信内且已配置：自动发起一次授权；拒绝/失败后用按钮重试，不再自动跳转
  let blocked=false;
  try{ blocked=sessionStorage.getItem('tsWxManual')==='1' || sessionStorage.getItem('tsWxTried')==='1'; }catch(e){}
  if(!me && wxConfig.enabled && wxConfig.ready && wxConfig.wechat && !blocked && !IS_APP){
    try{ sessionStorage.setItem('tsWxTried','1'); }catch(e){}
    authReady=true;
    location.replace('/api/wx/start?next='+encodeURIComponent(authNext()));
    return;
  }
  if(!me) applyWxProfile(null);
  authReady=true;
}
/* ---------- 房间事件绑定 ---------- */
function requireName(){
  if(me && me.nickname) return me.nickname;
  const n=$('nameInput').value.trim();
  if(!n){
    toast(!authReady ? '正在获取微信信息…' : ((wxConfig.enabled && wxConfig.wechat) ? '请先授权微信或输入昵称' : '请先设置昵称'));
    return null;
  }
  return n;
}
// 渲染大厅房间列表
function renderRoomList(list){
  const box=$('roomList'); if(!box) return;
  if(!list || !list.length){ box.textContent='（暂无房间）'; return; }
  box.innerHTML='';
  list.forEach(r=>{
    const canJoin = !r.started && r.humans<4;
    const isMineHost = r.host && r.host===myName;
    const item=document.createElement('div');
    item.className='roomItem'+(canJoin||isMineHost?'':' roomFull');
    const status = r.started?'对局中':`${r.humans}/4人`;
    item.innerHTML = `<span class="roomCodeLbl">${esc(r.code)}</span> · ${status}`;
    // 进入：未开局缺人 → join；自己的房间 → rejoin 归位
    if(canJoin || isMineHost){
      item.title='点击进入';
      item.onclick=()=>{
        const n=requireName(); if(!n) return;
        myName=n; connect();
        if(isMineHost){
          // 自己创建的房间：服务器 room 已绑定本 socket，直接 rejoin（已处理 room 已设场景）
          socket.emit('rejoin', {code:r.code, name:n});
        } else socket.emit('join', {code:r.code, name:n});
      };
    } else {
      item.title = r.started?'对局已开始':'房间已满';
    }
    box.appendChild(item);
  });
}
// 加入房间弹窗列表：非对局中、有空的房间
function renderJoinPick(){
  const box=$('joinRoomList'); if(!box) return;
  const list=roomCache.filter(r=>!r.started && r.humans<4);
  if(!list.length){ box.innerHTML='<div class="roomPick none">暂无可加入的房间</div>'; return; }
  box.innerHTML='';
  list.forEach(r=>{
    const d=document.createElement('div');
    d.className='roomPick';
    d.innerHTML=`<b>${esc(r.code)}</b> <span class="rpStatus">${r.humans}/4人</span>`;
    d.onclick=()=>{
      const n=requireName(); if(!n) return;
      myName=n; connect();
      socket.emit('join', {code:r.code, name:n});
    };
    box.appendChild(d);
  });
}
// 重连弹窗列表：已创建对局的房间（含确认轮，用 hasGame 而非 started）
function renderRejoinPick(){
  const box=$('rejoinRoomList'); if(!box) return;
  const list=roomCache.filter(r=>r.hasGame);
  if(!list.length){ box.innerHTML='<div class="roomPick none">暂无可重连的对局</div>'; return; }
  box.innerHTML='';
  list.forEach(r=>{
    const d=document.createElement('div');
    d.className='roomPick';
    d.innerHTML=`<b>${esc(r.code)}</b> <span class="rpStatus">对局中</span>`;
    d.onclick=()=>{
      const n=requireName(); if(!n) return;
      myName=n; connect();
      socket.emit('rejoin', {code:r.code, name:n});
    };
    box.appendChild(d);
  });
}
function bindLobby(){
  initAuth();
  $('btnSetName').onclick=()=>{
    const n=$('nameInput').value.trim();
    if(!n){ toast('请输入昵称'); return; }
    myName=n;
    // 昵称持久化：刷新页面后自动填回
    try{ localStorage.setItem('tsName', n); }catch(e){}
    toast(`昵称已设为「${n}」`);
  };
  $('btnCreate').onclick=()=>{
    const n=requireName(); if(!n) return;
    myName=n;
    const m=$('createModal'); if(m) m.hidden=false;
  };
  $('btnCreateGo').onclick=()=>{
    const n=requireName(); if(!n) return;
    myName=n;
    const code=($('createCode').value||'').trim().toUpperCase();
    if(code && !/^[A-Z0-9]{4}$/.test(code)){ toast('房间号需为 4 位字母或数字'); return; }
    const m=$('createModal'); if(m) m.hidden=true;
    connect();
    socket.emit('create', {name:n, code: code||undefined, settings: collectSettings()});
  };
  $('btnCreateBack').onclick=()=>{ const m=$('createModal'); if(m) m.hidden=true; };
  $('btnJoin').onclick=()=>{
    const n=requireName(); if(!n) return;
    myName=n;
    const m=$('joinModal'); if(m) m.hidden=false;
    // 打开时拉最新房间列表并渲染"可加入"房间
    connect();
    if(socket) socket.emit('listRooms');
    renderJoinPick();
  };
  $('btnJoinGo').onclick=()=>{
    const code=($('joinInput').value||'').trim().toUpperCase();
    if(!code){ toast('请输入房间号'); return; }
    if(!/^[A-Z0-9]{4}$/.test(code)){ toast('房间号需为 4 位字母或数字'); return; }
    connect();
    socket.emit('join', {code, name:myName});
  };
  $('btnJoinBack').onclick=()=>{ const m=$('joinModal'); if(m) m.hidden=true; };
  $('btnRejoin').onclick=()=>{
    const n=requireName(); if(!n) return;
    myName=n;
    const m=$('rejoinModal'); if(m){ m.hidden=false; }
    const hint=$('rejoinNameHint'); if(hint) hint.textContent='将使用昵称：'+(myName||'（未设置）');
    // 打开时拉最新房间列表并渲染"对局中"房间
    connect();
    if(socket) socket.emit('listRooms');
    renderRejoinPick();
  };
  $('btnRejoinGo').onclick=()=>{
    const n=requireName(); if(!n) return;
    myName=n;
    const code=($('rejoinCode').value||'').trim().toUpperCase();
    if(!code){ toast('请输入房间号'); return; }
    if(!/^[A-Z0-9]{4}$/.test(code)){ toast('房间号需为 4 位字母或数字'); return; }
    connect();
    socket.emit('rejoin', {code, name:myName});
  };
  $('btnRejoinBack').onclick=()=>{ const m=$('rejoinModal'); if(m) m.hidden=true; };
  $('btnStart').onclick=()=>{
    // 房主点"对局配置" → 打开设置弹窗（hostSeat 与座位解耦后按快照判断）
    if(curHostSeat!==mySeat){ toast('只有房主能配置'); return; }
    syncSetLock(); // 一场未结束时弹窗只读
    const m=$('setModal'); if(m) m.hidden=false;
  };
  $('btnReady').onclick=()=>{
    if(mySeat<0){ toast('请先进入房间'); return; }
    connect();
    socket.emit('toggleReady', {});
  };
  $('btnSetBack').onclick=()=>{ if(socket) socket.emit('setSettings', collectSettings()); const m=$('setModal'); if(m) m.hidden=true; };
  $('btnLeave').onclick=()=>{ leaveRoom(); };
  // 历史分数：展示本房间最近 10 场（服务端记录）
  const renderHistory=()=>{
    const tb=$('historyTable'); if(!tb) return;
    if(!history || !history.length){ tb.innerHTML='<tr><td>暂无历史分数记录</td></tr>'; return; }
    let html='<tr><th>时间</th><th>局数</th><th>玩家1</th><th>玩家2</th><th>玩家3</th><th>玩家4</th></tr>';
    for(const e of history){
      const tm=new Date(e.t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      // 每位玩家一列（昵称在上、分数在下）：昵称/分数长度变化不影响行对齐
      const cells=[0,1,2,3].map(i=>{
        const n=(e.players&&e.players[i])||'—';
        const sc=(e.scores&&e.scores[i])!=null?e.scores[i]:0;
        return `<td><div class="hName">${esc(n)}</div><div><span class="hScore">${sc>0?'+':''}${sc}</span>分</div></td>`;
      }).join('');
      html+=`<tr><td>${tm}</td><td>${e.rounds||1}</td>${cells}</tr>`;
    }
    tb.innerHTML=html;
  };
  const bh=$('btnHistory'); if(bh) bh.onclick=()=>{ renderHistory(); const m=$('historyModal'); if(m) m.hidden=false; };
  const bc=$('btnHistoryClose'); if(bc) bc.onclick=()=>{ const m=$('historyModal'); if(m) m.hidden=true; };
  // 提前结束本场（全真人房共识）
  const es=$('btnEndSeries'); if(es) es.onclick=()=>{ if(socket) socket.emit('endSeries'); };
  const ea=$('btnEndAgree'); if(ea) ea.onclick=()=>{ const m=$('endAskModal'); if(m) m.hidden=true; if(socket) socket.emit('endSeriesVote',{vote:true}); };
  const er=$('btnEndReject'); if(er) er.onclick=()=>{ const m=$('endAskModal'); if(m) m.hidden=true; if(socket) socket.emit('endSeriesVote',{vote:false}); };
  const ec=$('btnEndClose'); if(ec) ec.onclick=()=>{ const m=$('endAskModal'); if(m) m.hidden=true; };
  // 顶替座位弹窗（在位者答复）
  const hideTake = () => { const tm=$('takeoverAskModal'); if(tm){ tm.hidden=true; if(tm._tt){ clearTimeout(tm._tt); tm._tt=null; } } };
  const ta=$('btnTakeAgree'); if(ta) ta.onclick=()=>{ hideTake(); if(socket) socket.emit('takeoverVote',{ok:true}); };
  const tr=$('btnTakeReject'); if(tr) tr.onclick=()=>{ hideTake(); if(socket) socket.emit('takeoverVote',{ok:false}); };
  // 刷新按钮（牌桌内）：等同浏览器刷新页面（重新加载游戏）
  const rf=$('btnRefresh'); if(rf) rf.onclick=()=>{ location.reload(); };
  // 刷新列表按钮（大厅右上角）：重新拉取房间列表（非整页刷新）
  const rl=$('btnRefreshList'); if(rl) rl.onclick=()=>{ if(socket) socket.emit('listRooms'); };
  // 设置变更 → 发服务器（开局前生效）
  ['setRounds','setKings','setJoker','setHalfFan','setFanCap','setTailBonus','setShowRemain','setShowCorner','setShowLog','setAIFill','setAIAuto'].forEach(id=>{
    const el=$(id);
    if(el) el.onchange=()=>{ if(socket) socket.emit('setSettings', collectSettings()); };
  });
  // 大厅显示（显隐由 #app 状态类控制，避免内联 display 覆盖牌桌 flex 布局）
  const appEl=document.getElementById('app');
  if(appEl) appEl.classList.add('inLobby');
  // 页面加载即连接服务器（房间列表实时加载，无需先操作）
  connect();
  // 设置过的昵称自动填回输入框（缓存还在则生效），并作为默认昵称
  try{
    const savedName=localStorage.getItem('tsName')||'';
    if(savedName){
      myName=savedName;
      const ni=$('nameInput'); if(ni) ni.value=savedName;
    }
  }catch(e){}
  // 刷新后自动重连（localStorage 有记录）
  try{
    const saved=JSON.parse(localStorage.getItem('tsRoom')||'null');
    if(saved && saved.code && saved.name){
      myName=saved.name;
      const ni=$('nameInput'); if(ni) ni.value=saved.name;
      socket.emit('rejoin', {code:saved.code, name:saved.name, auto:true});
    }
  }catch(e){}
  // 大厅每 3 秒刷新房间列表
  setInterval(()=>{ if(socket && socket.connected) socket.emit('listRooms'); }, 3000);
}

// 收集设置表单值
function collectSettings(){
  const s={
    rounds: Number($('setRounds')?.value||1),
    kings: Number($('setKings')?.value||8),
    jokerValue: Number($('setJoker')?.value||3),
    halfFan: Math.min(50, Math.max(1, Number($('setHalfFan')?.value||1))),
    fanCap: Number($('setFanCap')?.value ?? 32),
    tailBonus: !!$('setTailBonus')?.checked,
    showRemain: !!$('setShowRemain')?.checked,
    showCorner: !!$('setShowCorner')?.checked,
    showLog: !!$('setShowLog')?.checked,
  };
  if($('setAIFill')) s.aiFill=!!$('setAIFill').checked;
  if($('setAIAuto')) s.aiAuto=!!$('setAIAuto').checked;
  return s;
}
function applySettings(s){
  if(!s) return;
  if($('setRounds')) $('setRounds').value=s.rounds||1;
  if($('setKings')) $('setKings').value=s.kings||8;
  if($('setJoker')) $('setJoker').value=s.jokerValue||3;
  if($('setHalfFan')) $('setHalfFan').value=String(Math.min(50,Math.max(1,Number(s.halfFan||1))));
  if($('setFanCap')) $('setFanCap').value=String(s.fanCap ?? 32);
  if($('setTailBonus')) $('setTailBonus').checked=!!s.tailBonus;
  if($('setShowRemain')) $('setShowRemain').checked=!!s.showRemain;
  if($('setShowCorner')) $('setShowCorner').checked = s.showCorner === true;
  if($('setShowLog')) $('setShowLog').checked = s.showLog === true;
  if($('setAIFill')) $('setAIFill').checked=!!s.aiFill;
  if($('setAIAuto')) $('setAIAuto').checked=!!s.aiAuto; // 漏同步：换房主/重进后勾选应跟服务器一致
}

window.NET = { connect, act, nextRound, start, toggleAI, toggleReady(){ if(socket) socket.emit('toggleReady', {}); }, kickSeat(seat){ if(socket) socket.emit('kickSeat',{seat}); }, get roomCode(){return roomCode;} };
window.addEventListener('DOMContentLoaded', bindLobby);
})();
