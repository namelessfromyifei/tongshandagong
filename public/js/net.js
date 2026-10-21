/* =========================================================
 * 通山打拱 · 网络层（Socket.IO 客户端）
 * 负责：连接、创建/加入房间、重连、动作发送、接收状态→GameUI
 * ========================================================= */
(function(){
"use strict";
const UI = window.GameUI;
let socket=null;
let mySeat=-1, myName='';
let roomCode='';
let inGame=false; // 是否已在对局中（用于退出时判断保留重连）

const $=id=>document.getElementById(id);

/* ---------- 房间界面 ---------- */
function enterLobby(){
  const lobby=$('lobby'), table=$('tableWrap');
  if(lobby) lobby.style.display='block';
  if(table) table.style.display='none';
  if($('btnRoomToggle')) $('btnRoomToggle').textContent='返回大厅';
  // 离开牌桌：解除横屏（大厅可竖屏）
  if(window.LANDSCAPE) window.LANDSCAPE.exit();
}
function enterTable(){
  const lobby=$('lobby'), table=$('tableWrap');
  if(lobby) lobby.style.display='none';
  if(table) table.style.display='block';
  // 进入房间：强制横屏
  if(window.LANDSCAPE) window.LANDSCAPE.enter();
}

function toast(msg){
  const el=$('status');
  if(el) el.textContent=msg;
  setTimeout(()=>{ if(el) el.textContent=''; }, 4000);
}

/* ---------- 连接 ---------- */
function connect(){
  if(socket && socket.connected) return;
  socket = io();
  socket.on('connect', ()=>{
    toast('已连接服务器');
    if(socket) socket.emit('listRooms');
  });

  socket.on('rooms', (list)=>{ renderRoomList(list); });

  // 创建房间成功 → 直接进桌（joined 处理）
  socket.on('joined', (d)=>{
    mySeat=d.seat; myName=d.name; roomCode=d.code;
    // 记住房间+姓名，刷新后自动重连
    try{ localStorage.setItem('tsRoom', JSON.stringify({code:d.code, name:d.name})); }catch(e){}
    $('roomCode').textContent = '房间号：'+d.code;
    $('mySeatInfo').textContent = `你是 ${d.name}（${d.seat===0?'房主':'第 '+d.seat+' 位玩家'}）`;
    enterTable();
  });

  socket.on('state', (snap)=>{
    inGame = !!(snap.G);  // 有 G（对局已创建）视为对局中
    applySettings(snap.settings);
    // AI 补位复选框：用 snap.aiFill（顶层字段）同步，避免 settings 覆盖
    if(snap.aiFill!=null && $('setAIFill')) $('setAIFill').checked=!!snap.aiFill;
    // 准备状态同步
    const readyArr = snap.ready || [];
    UI.setSelf(mySeat, snap.seats.map(s=>s.name), snap.seats.map(s=>s.type), snap.aiFill, snap.seats.map(s=>!!s.offline), readyArr);
    // 房主才显示"对局配置"
    if($('btnStart')) $('btnStart').style.display = (mySeat===0 && !(snap.G && snap.G.started)) ? 'inline-block' : 'none';
    // 准备按钮：未开局才显示（已开局隐藏），准备/取消准备切换
    if($('btnReady')){
      const isReady = !!readyArr[mySeat];
      $('btnReady').style.display = (snap.G && snap.G.started) ? 'none' : 'inline-block';
      $('btnReady').textContent = isReady ? '取消准备' : '准备';
      $('btnReady').classList.toggle('gold', isReady);
    }
    UI.setSeries && UI.setSeries(snap.series);
    // 服务器日志同步到前端日志（snap.G 里没有 log，服务器用 emit 单独推）
    UI.applyState(snap);
  });

  socket.on('log', (line)=>{ UI.addLog(line); });

  // 被提升为房主（原房主退出）
  socket.on('promotedHost', ()=>{
    mySeat=0;
    if($('mySeatInfo')) $('mySeatInfo').textContent=`你是 ${myName}（房主）`;
    toast('你已成为房主');
  });

  socket.on('roomClosed', ()=>{ roomClosed(); });

  socket.on('toast', (m)=>{ toast(m); });

  socket.on('disconnect', ()=>{ toast('与服务器断开，尝试重连…'); });
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
  if(socket) socket.emit('leave', {});
  // 对局中退出：保留 localStorage（可用同昵称重连）；未开局才清除
  if(inGame){
    toast('对局中退出视作掉线，可用昵称重连');
  } else {
    try{ localStorage.removeItem('tsRoom'); }catch(e){}
  }
  enterLobby();
}
// 房间解散（房主退出）
function roomClosed(){
  try{ localStorage.removeItem('tsRoom'); }catch(e){}
  toast('房间已解散，回到大厅');
  enterLobby();
}

/* ---------- 房间事件绑定 ---------- */
function requireName(){
  const n=$('nameInput').value.trim();
  if(!n){ toast('请先设置昵称'); return null; }
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
    item.innerHTML = `<span class="roomCodeLbl">${r.code}</span> · ${status}`;
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
    // 删除按钮：未开局房间任意玩家可删（LOVE 常驻房除外）
    if(!r.started && r.code!=='LOVE'){
      const del=document.createElement('button');
      del.className='btn small roomDel';
      del.textContent='删除';
      del.onclick=(e)=>{
        e.stopPropagation();
        connect();
        socket.emit('deleteRoom', {code:r.code});
      };
      item.appendChild(del);
    }
    box.appendChild(item);
  });
}
function bindLobby(){
  $('btnSetName').onclick=()=>{
    const n=$('nameInput').value.trim();
    if(!n){ toast('请输入昵称'); return; }
    myName=n; toast(`昵称已设为「${n}」`);
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
    const m=$('createModal'); if(m) m.hidden=true;
    connect();
    socket.emit('create', {name:n, code: code||undefined, settings: collectSettings()});
  };
  $('btnCreateBack').onclick=()=>{ const m=$('createModal'); if(m) m.hidden=true; };
  $('btnJoin').onclick=()=>{
    const n=requireName(); if(!n) return;
    myName=n;
    const m=$('joinModal'); if(m) m.hidden=false;
  };
  $('btnJoinGo').onclick=()=>{
    const code=($('joinInput').value||'').trim().toUpperCase();
    if(!code){ toast('请输入房间号'); return; }
    connect();
    socket.emit('join', {code, name:myName});
  };
  $('btnJoinBack').onclick=()=>{ const m=$('joinModal'); if(m) m.hidden=true; };
  $('btnRejoin').onclick=()=>{
    const m=$('rejoinModal'); if(m){ m.hidden=false; }
    const hint=$('rejoinNameHint'); if(hint) hint.textContent='将使用昵称：'+(myName||'（未设置）');
  };
  $('btnRejoinGo').onclick=()=>{
    const n=requireName(); if(!n) return;
    myName=n;
    const code=($('rejoinCode').value||'').trim().toUpperCase();
    if(!code){ toast('请输入房间号'); return; }
    connect();
    socket.emit('rejoin', {code, name:myName});
  };
  $('btnRejoinBack').onclick=()=>{ const m=$('rejoinModal'); if(m) m.hidden=true; };
  $('btnStart').onclick=()=>{
    // 房主点"对局配置" → 打开设置弹窗（非房主隐藏）
    if(mySeat!==0){ toast('只有房主能配置'); return; }
    const m=$('setModal'); if(m) m.hidden=false;
  };
  $('btnReady').onclick=()=>{
    if(mySeat<0){ toast('请先进入房间'); return; }
    connect();
    socket.emit('toggleReady', {});
  };
  $('btnSetGo').onclick=()=>{
    if(socket) socket.emit('setSettings', collectSettings());
    const m=$('setModal'); if(m) m.hidden=true;
    toast('配置已保存，等待全员准备');
  };
  $('btnSetBack').onclick=()=>{ const m=$('setModal'); if(m) m.hidden=true; };
  $('btnLeave').onclick=()=>{ leaveRoom(); };
  // 设置变更 → 发服务器（开局前生效）
  ['setRounds','setKings','setJoker','setTailBonus','setShowRemain','setAIFill'].forEach(id=>{
    const el=$(id);
    if(el) el.onchange=()=>{ if(socket) socket.emit('setSettings', collectSettings()); };
  });
  // 大厅显示
  const lobby=$('lobby');
  if(lobby) lobby.style.display='block';
  const table=$('tableWrap');
  if(table) table.style.display='none';
  // 页面加载即连接服务器（房间列表实时加载，无需先操作）
  connect();
  // 刷新后自动重连（localStorage 有记录）
  try{
    const saved=JSON.parse(localStorage.getItem('tsRoom')||'null');
    if(saved && saved.code && saved.name){
      myName=saved.name;
      socket.emit('rejoin', {code:saved.code, name:saved.name});
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
    tailBonus: !!$('setTailBonus')?.checked,
    showRemain: !!$('setShowRemain')?.checked,
  };
  if($('setAIFill')) s.aiFill=!!$('setAIFill').checked;
  return s;
}
function applySettings(s){
  if(!s) return;
  if($('setRounds')) $('setRounds').value=s.rounds||1;
  if($('setKings')) $('setKings').value=s.kings||8;
  if($('setJoker')) $('setJoker').value=s.jokerValue||3;
  if($('setTailBonus')) $('setTailBonus').checked=!!s.tailBonus;
  if($('setShowRemain')) $('setShowRemain').checked=s.showRemain!==false;
  if($('setAIFill')) $('setAIFill').checked=!!s.aiFill;
}

window.NET = { connect, act, nextRound, start, toggleAI, get roomCode(){return roomCode;} };
window.addEventListener('DOMContentLoaded', bindLobby);
})();
