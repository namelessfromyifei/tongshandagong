/* =========================================================
 * 通山打拱 · 多人联网服务器
 * 架构：服务器权威。每房间持一个 G（engine.js），
 *       真人动作经 WebSocket 校验执行，AI 座位自动托管，
 *       每次状态变更广播全量快照给房间内所有连接。
 * 运行：node server.js  （默认端口 8080，环境变量 PORT 可改）
 * ========================================================= */
"use strict";
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const TS = require('./js/engine.js');
const TSAI = require('./js/ai.js');

const PORT = process.env.PORT || 8080;
// 牌局结束后房间闲置超时自动解散（毫秒）；设为 0 可关闭。默认 5 分钟。
const IDLE_KICK_MS = Number(process.env.ROOM_IDLE_KICK_MS || 5*60*1000);
const app = express();
const server = http.createServer(app);
// 缩短心跳，断线更快被发现（默认 ping 约 25s）
const io = new Server(server, { pingInterval: 5000, pingTimeout: 5000, cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- 房间管理 ---------- */
const rooms = new Map(); // code -> room

function makeCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';
  do{ c=''; for(let i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)]; }
  while(rooms.has(c));
  return c;
}

function createRoom(code){
  code = code || makeCode();
  const room = {
    code,
    seats: [ // 4 个座位：{type:'ai'|'human', socketId, name, offline}
      {type:'ai', name:'A家'}, {type:'ai', name:'B家'},
      {type:'ai', name:'C家'}, {type:'ai', name:'D家'},
    ],
    aiFill: false,      // AI 补位开关（默认关，房主手动开）
    humanCount: 0,
    ready: [false,false,false,false], // 每座位是否准备（AI 座位视为自动准备）
    G: null,            // 当前局（null = 等待开局）
    aiTimer: null,
    idleTimer: null,    // 牌局结束后的闲置自动解散计时器
    settings: {         // 牌局设置（房主可调）
      rounds: 1,        // 一轮打多少局
      showRemain: false, // 是否显示剩余张数（默认关，关闭时显示固定"10张"）
      showCorner: false, // 是否显示牌桌信息框（叫牌/明鸡/庄家），默认不显示
      showLog: false,    // 是否显示出牌记录框（右上角日志），默认不显示
      kings: 8,         // 王总数 8/10/12
      jokerValue: 3,    // 王单出算 3 或 2
      tailBonus: false, // 4+王 尾游能否拿奖金
    },
    series: {           // 一轮（多局）累计
      active: false, roundCount: 0, totals: [0,0,0,0],
    },
    roundSeq: 0,        // 房间内累计对局数（跨场唯一，供前端判断换局）
  };
  rooms.set(code, room);
  return room;
}

/* ---------- 广播 ---------- */
// 配置锁定：只要当前这一局已开始且尚未结束（含发牌/确认/出牌），所有设置不可改；
// 未开局（G 为空）或本局已结束（G.ended）时可改。
function configLocked(room){
  return !!(room.G && !room.G.ended);
}
// 把 settings 映射为引擎 cfg
function makeCfg(room){
  return {
    kings: room.settings.kings,
    jokerValue: room.settings.jokerValue,
    tailBonus: room.settings.tailBonus,
  };
}
// 标记"刚结束的这局是否为一场的最后一局"，随快照带给客户端（避免客户端猜错）
function markLast(room){
  if(room.G && room.G.ended && room.G.lastSeries===undefined){
    room.G.lastSeries = (room.series.roundCount + 1) >= room.settings.rounds;
  }
}
function snapshot(room){
  return {
    code: room.code,
    aiFill: room.aiFill,
    ready: room.ready,
    settings: Object.assign({aiFill: room.aiFill}, room.settings),
    series: room.series,
    seats: room.seats.map(s=>({name:s.name, type:s.type, offline:!!s.offline, humanCount:room.humanCount})),
    G: room.G,
  };
}
function broadcast(room){
  io.to(room.code).emit('state', snapshot(room));
}
/* ---------- 牌局结束后房间闲置超时自动解散 ---------- */
function clearIdleKick(room){
  if(room && room.idleTimer){ clearTimeout(room.idleTimer); room.idleTimer=null; }
}
function scheduleIdleKick(room){
  if(!(IDLE_KICK_MS>0)) return;
  clearIdleKick(room);
  room.idleTimer=setTimeout(()=>{ kickIdleRoom(room); }, IDLE_KICK_MS);
}
function kickIdleRoom(room){
  room.idleTimer=null;
  // 房间已被删除，或同号房间已被新房间替换 → 忽略
  if(rooms.get(room.code)!==room) return;
  // 只有牌局已结束（本局已结束或本场已无当前局）才解散
  if(room.G && !room.G.ended) return;
  const socks=[];
  for(const s of room.seats){
    if(s.socketId){ const so=io.sockets.sockets.get(s.socketId); if(so) socks.push(so); }
  }
  for(const so of socks){ try{ so.emit('roomClosed'); }catch(e){} }
  rooms.delete(room.code);
  // 断开连接，避免服务端闭包仍指向已删除的房间（客户端会自动重连回大厅）
  for(const so of socks){ try{ so.disconnect(true); }catch(e){} }
}

// 服务器日志：存入房间并推给所有人
function logLine(room, msg){
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  room.log = room.log || [];
  room.log.push(line);
  if(room.log.length>120) room.log.shift();
  io.to(room.code).emit('log', line);
}

/* ---------- AI 座位托管：轮到 AI 时自动出 ---------- */
function aiPlayTurn(room){
  if(room.aiTimer) clearTimeout(room.aiTimer);
  if(!room.G) return;
  const seatIdx = room.G.turn;
  const seat = room.seats[seatIdx];
  if(seat.type!=='ai') return;         // 真人的座位等真人自己动
  room.aiTimer = setTimeout(()=>{
    if(!room.G || room.G.ended || room.G.confirming===false && room.G.turn!==seatIdx) return;
    // 确认轮：AI 表态
    if(room.G.confirming){
      if(TS.canDeclareHard(room.G) && Math.random()<0.05 && seatIdx===room.G.landlord){
        TS.confirmChoice(room.G, seatIdx, 'mingdu');
        logLine(room, `${seat.name} 选择【明独】`);
      } else if(Math.random()<0.02 && !TS.handHasBomb(room.G.seats[seatIdx].hand)){
        // AI 极少毁牌（重发整局）：简化——此处不自动毁牌，避免洗牌混乱
        TS.confirmChoice(room.G, seatIdx, 'pass');
        logLine(room, `${seat.name} 选择【不明独】`);
      } else {
        TS.confirmChoice(room.G, seatIdx, 'pass');
        logLine(room, `${seat.name} 选择【不明独】`);
      }
      broadcast(room);
      aiPlayTurn(room);
      return;
    }
    // 出牌阶段
    if(room.G.seats[seatIdx].out){ TS.advanceTurn(room.G); broadcast(room); aiPlayTurn(room); return; }
    const ch = TSAI.aiChoose(room.G, seatIdx);
    if(ch===null){
      if(room.G.lastPlay) TS.handlePass(room.G, seatIdx);
      else TS.advanceTurn(room.G);
      logLine(room, `${seat.name} 不出`);
    } else {
      const r = TS.doPlay(room.G, seatIdx, ch.cards);
      if(!r.ok){ logLine(room, `${seat.name} 出错: ${r.why}`); TS.advanceTurn(room.G); }
      else {
        logLine(room, `${seat.name} 出 ${describe(ch.cards)}`);
        const st=room.G.seats[seatIdx];
        if(st.kingPlayed && st.kings>=4 && room.G._kingAnnounced!==seatIdx){
          room.G._kingAnnounced=seatIdx;
          logLine(room, `⚠️ ${seat.name} 起到了 ${st.kings} 张王！`);
        }
      }
    }
    markLast(room); // 局结束标记（AI 出完最后一手/一圈结束时带上）
    broadcast(room);
    if(room.G.ended){ finishRoom(room); return; }
    aiPlayTurn(room);
  }, 650);
}

function describe(cards){
  return cards.map(c=>TS.cardName(c)).join(' ');
}

/* ---------- 确认轮结束 / 开局 ---------- */
// 全员就绪检查：真人需准备，AI 座位自动视为已就绪（aiFill 开时参与）
// 两种可开局状态：① 尚未开局（G 为空）② 上一局刚结束、等待开下一局（G.ended）
function checkAllReady(room){
  if(!room) return false;
  const waitingNext = !!(room.G && room.G.ended);
  const noGame = !room.G;
  if(!waitingNext && !noGame) return false;
  const needHuman = room.aiFill ? 0 : 4;
  if(room.humanCount < needHuman){ broadcast(room); return false; }
  for(let i=0;i<4;i++){
    const s=room.seats[i];
    const effective = (s.type==='human') || (room.aiFill && s.type==='ai');
    if(effective){
      const ready = (s.type==='ai') || !!room.ready[i];
      if(!ready){ broadcast(room); return false; }
    }
  }
  logLine(room, waitingNext ? '✅ 全员就绪，开下一局！' : '✅ 全员准备，开始对局！');
  if(waitingNext) startNext(room); else startRound(room);
  return true;
}

function startRound(room){
  clearIdleKick(room);
  room.G = TS.newGame(Math.floor(Math.random()*1e9), makeCfg(room));
  room.G.rollcages = room.G.seats.map(()=>[]);
  room.roundSeq++; room.G.seq=room.roundSeq;
  // 服务器持局：开局先广播叫牌信息
  logLine(room, `—— 第 ${room.G.roundNo} 局 ——`);
  logLine(room, `庄家 ${room.seats[room.G.landlord].name}，叫牌 ${TS.cardName(room.G.called)}`);
  broadcast(room);
  aiPlayTurn(room);
}

// 开下一局：按上一局一游当庄
function startNext(room){
  clearIdleKick(room);
  const nextLandlord = (room.G && room.G.firstOut!=null) ? room.G.firstOut : null;
  room.G = TS.newGame(Math.floor(Math.random()*1e9), makeCfg(room));
  if(nextLandlord!=null) TS.pickLandlord(room.G, nextLandlord);
  room.G.roundNo = room.series.roundCount + 1;
  room.roundSeq++; room.G.seq=room.roundSeq;
  room.ready = [false,false,false,false]; // 各玩家为下一局重新就绪
  logLine(room, `—— 第 ${room.G.roundNo} 局 ——`);
  logLine(room, `庄家 ${room.seats[room.G.landlord].name}，叫牌 ${TS.cardName(room.G.called)}`);
  broadcast(room);
  aiPlayTurn(room);
}

function finishRoom(room){
  const s = TS.settleRound(room.G);
  markLast(room); // 确保最后一局的标记已带上
  logLine(room, `—— 第 ${room.G.roundNo} 局结算 ——`);
  for(let i=0;i<4;i++){
    logLine(room, `  ${room.seats[i].name}：${s.perFen[i]>0?'+':''}${s.perFen[i]}分` +
      (s.kingBonus && s.kingBonus[i] ? `（含王奖金 ${s.kingBonus[i]}笼×3）` : '') +
      (s.bombBonus && s.bombBonus[i] ? `（含硬炸奖 ${s.bombBonus[i]}笼×3）` : ''));
  }
  // 轮结算：累计
  room.series.active = true;
  room.series.roundCount++;
  for(let i=0;i<4;i++) room.series.totals[i]+=s.perFen[i];
  room.series.lastRound = s;
  // 达到设置局数 → 输出本场结算并重置（下场比赛需重新准备）
  if(room.series.roundCount >= room.settings.rounds){
    logLine(room, `══════ 本场 ${room.settings.rounds} 局全部结束 ══════`);
    logLine(room, `  累计：${room.seats.map((se,i)=>`${se.name} ${room.series.totals[i]>0?'+':''}${room.series.totals[i]}分`).join('｜')}`);
    room.series.active=false; room.series.roundCount=0; room.series.totals=[0,0,0,0]; room.series.lastRound=null;
    room.ready=[false,false,false,false]; // 准备重置，下场比赛重新准备
    room.G=null;
  } else {
    // 非最后一局：等所有玩家点【下一局】就绪后自动开下一局
    room.ready=[false,false,false,false];
    logLine(room, `请各玩家点击【下一局】就绪，全员就绪自动开下一局`);
  }
  broadcast(room);
  // 牌局结束后开始闲置计时：超时仍未退出则自动解散房间
  scheduleIdleKick(room);
  // 不自动开下一局，等所有玩家就绪
}

/* ---------- Socket.IO ---------- */
io.on('connection', (socket)=>{
  let room=null, mySeat=-1;

  // 房间列表（大厅显示）
  socket.on('listRooms', ()=>{
    const list=[];
    rooms.forEach(r=>{
      list.push({
        code:r.code,
        humans:r.humanCount,
        aiFill:r.aiFill,
        started: !!(r.G && r.G.started),
        rounds:r.settings.rounds,
        host: r.seats[0].type==='human' ? r.seats[0].name : null,
      });
    });
    socket.emit('rooms', list);
  });

  socket.on('create', (data)=>{
    if(room){ socket.emit('toast','你已在房间中'); return; }
    data = data||{};
    // 自定义房间号（可选，4位字母数字）；不填则随机
    let custom = (data.code||'').toUpperCase();
    if(custom && rooms.has(custom)){ socket.emit('toast','房间号已被占用'); return; }
    const r=createRoom(custom);
    const seatIdx=0;
    const name=(data.name)||'玩家1';
    r.seats[seatIdx]={type:'human', socketId:socket.id, name, offline:false};
    r.humanCount++;
    // 房主可带初始设置
    if(data.settings) r.settings=Object.assign(r.settings, data.settings);
    room=r; mySeat=seatIdx;
    socket.join(r.code);
    // 创建后房主直接进牌桌（房间仍在列表，其他玩家可加入）
    socket.emit('joined', {code:r.code, seat:seatIdx, name});
    broadcast(r);
    socket.emit('toast', `已创建房间 ${r.code}，等待其他玩家加入`);
  });

  // 房主调整牌局设置
  socket.on('setSettings', (data)=>{
    if(!room || mySeat!==0){ socket.emit('toast','只有房主能设置'); return; }
    if(configLocked(room)){ socket.emit('toast','对局进行中，设置已锁定'); return; }
    const s=room.settings;
    if(data.rounds!=null){ const n=Number(data.rounds); if(n>=1&&n<=20) s.rounds=Math.floor(n); }
    if(data.showRemain!=null) s.showRemain=!!data.showRemain;
    if(data.showCorner!=null) s.showCorner=!!data.showCorner;
    if(data.showLog!=null) s.showLog=!!data.showLog;
    if(data.kings!=null) s.kings=[8,10,12].includes(Number(data.kings))?Number(data.kings):8;
    if(data.jokerValue!=null) s.jokerValue=Number(data.jokerValue)===2?2:3;
    if(data.tailBonus!=null) s.tailBonus=!!data.tailBonus;
    if(data.aiFill!=null) room.aiFill=!!data.aiFill;
    // 点【开始对局】：房主自己也准备，已就绪的真人 + AI 补位即可立即开局
    const wantStart = (data.start===true);
    if(wantStart) room.ready[0]=true;
    broadcast(room);
    if(wantStart){
      const started=checkAllReady(room);
      socket.emit('toast', started? '开始对局！' : '已准备，等待其他玩家就绪后开局');
    } else {
      socket.emit('toast','牌局设置已更新');
    }
  });

  socket.on('join', (data)=>{
    if(room){ socket.emit('toast','你已在房间中'); return; }
    const code=(data&&data.code||'').toUpperCase();
    const name=(data&&data.name||'').trim();
    if(!name){ socket.emit('toast','请输入昵称'); return; }
    const r=rooms.get(code);
    if(!r){ socket.emit('toast','房间不存在'); return; }
    if(r.G){ socket.emit('toast','对局已开始，无法中途加入'); return; }
    // 同名检查：真人座位里已有同名则拒绝
    if(r.seats.some(s=>s.type==='human' && s.name===name)){ socket.emit('toast','该昵称已被占用，请换一个'); return; }
    // 找空座位（真人空位或 AI 位）
    let seatIdx=r.seats.findIndex(s=>s.type==='ai');
    if(seatIdx<0){ socket.emit('toast','房间已满'); return; }
    r.seats[seatIdx]={type:'human', socketId:socket.id, name:name, offline:false};
    r.humanCount++;
    room=r; mySeat=seatIdx;
    socket.join(r.code);
    socket.emit('joined', {code:r.code, seat:seatIdx, name});
    broadcast(r);
    socket.emit('toast', `已加入房间 ${r.code}，你是第 ${r.humanCount} 位玩家`);
  });

  // 重连：房间号 + 玩家姓名 归位
  socket.on('rejoin', (data)=>{
    data=data||{};
    const code=(data.code||'').toUpperCase();
    const name=(data.name||'').trim();
    if(!name){ socket.emit('toast','请输入昵称'); return; }
    // 若本 socket 已绑定房间：直接确认进桌（创建后点自己的房间进入）
    if(room){
      if(room.code===code){
        socket.emit('joined', {code:room.code, seat:mySeat, name:room.seats[mySeat].name});
        broadcast(room);
        return;
      }
      socket.emit('toast','你已在其他房间');
      return;
    }
    const r=rooms.get(code);
    if(!r){ socket.emit('toast','房间不存在'); return; }
    // 按姓名匹配真人座位
    const seatIdx = r.seats.findIndex(s=>s.type==='human' && s.name===name);
    if(seatIdx<0){ socket.emit('toast','该昵称不在房间内'); return; }
    r.seats[seatIdx].socketId=socket.id;
    r.seats[seatIdx].offline=false;
    r.seats[seatIdx].name=name;
    room=r; mySeat=seatIdx;
    socket.join(r.code);
    socket.emit('joined', {code:r.code, seat:seatIdx, name:r.seats[seatIdx].name});
    broadcast(r);
    socket.emit('toast', `重连成功，你坐回 ${r.seats[seatIdx].name}`);
  });

  // 房主（seat 0）切换 AI 补位
  socket.on('toggleAI', ()=>{
    if(!room) return;
    if(configLocked(room)){ socket.emit('toast','对局进行中，设置已锁定'); return; }
    room.aiFill = !room.aiFill;
    socket.emit('toast', `AI 补位已${room.aiFill?'开启':'关闭'}`);
    broadcast(room);
  });

  // 玩家准备/取消准备（对局配置由房主在弹窗调整；全员准备后自动开局）
  socket.on('toggleReady', ()=>{
    if(!room || room.G) return;
    if(mySeat<0 || room.seats[mySeat].type!=='human') return;
    room.ready[mySeat]=!room.ready[mySeat];
    socket.emit('toast', room.ready[mySeat]?'已准备':'已取消准备');
    checkAllReady(room);
  });

  // 开局（房主点击"对局配置"后由设置弹窗确认，不再直接 start；保留 start 兼容）
  socket.on('start', ()=>{
    if(!room) return;
    if(room.G) return;
    if(!room.aiFill && room.humanCount<4){
      socket.emit('toast', `AI补位未开，还差 ${4-room.humanCount} 位真人才能开始；或先开启AI补位`);
      return;
    }
    startRound(room);
  });

  socket.on('nextRound', ()=>{
    if(!room || !room.G || !room.G.ended) return; // 上一局尚未结束时忽略
    if(mySeat<0 || room.seats[mySeat].type!=='human') return;
    room.ready[mySeat]=true;
    socket.emit('toast','已就绪，等待其他玩家');
    checkAllReady(room);
  });

  // 玩家动作
  socket.on('act', (data)=>{
    if(!room || !room.G) return;
    const seatIdx=Number(data.seat);
    if(seatIdx!==mySeat){ socket.emit('toast','不是你的座位'); return; }
    if(room.G.confirming){
      if(data.type==='confirm'){
        const choice=data.choice==='mingdu'?'mingdu':'pass';
        TS.confirmChoice(room.G, seatIdx, choice);
        logLine(room, `${room.seats[seatIdx].name} 选择【${choice==='mingdu'?'明独':'不明独'}】`);
      } else if(data.type==='restart'){
        // 毁牌：无炸时才允许，整局重发
        if(TS.handHasBomb(room.G.seats[seatIdx].hand)){ socket.emit('toast','你有炸，不能毁牌'); return; }
        logLine(room, `${room.seats[seatIdx].name} 选择【毁牌】`);
        room.G=TS.newGame(Math.floor(Math.random()*1e9), makeCfg(room));
        logLine(room, `—— 重发 · 第 ${room.G.roundNo} 局 ——`);
        logLine(room, `庄家 ${room.seats[room.G.landlord].name}，叫牌 ${TS.cardName(room.G.called)}`);
        broadcast(room);
        aiPlayTurn(room);
        return;
      }
      broadcast(room);
      aiPlayTurn(room);
      return;
    }
    // 出牌阶段
    if(seatIdx!==room.G.turn){ socket.emit('toast','还没轮到你'); return; }
    if(data.type==='play'){
      const r=TS.doPlay(room.G, seatIdx, data.cards||[]);
      if(!r.ok){ socket.emit('toast', r.why); return; }
      logLine(room, `${room.seats[seatIdx].name} 出 ${describe(data.cards)}`);
      // 打出第一张王且开局 ≥4 王 → 通知大家
      const st=room.G.seats[seatIdx];
      if(st.kingPlayed && st.kings>=4 && room.G._kingAnnounced!==seatIdx){
        room.G._kingAnnounced=seatIdx;
        logLine(room, `⚠️ ${room.seats[seatIdx].name} 起到了 ${st.kings} 张王！`);
      }
    } else if(data.type==='pass'){
      if(!room.G.lastPlay){ socket.emit('toast','领出必须出牌'); return; }
      TS.handlePass(room.G, seatIdx);
      logLine(room, `${room.seats[seatIdx].name} 不出`);
    }
    markLast(room); // 局结束标记（有则带上，重复广播幂等）
    broadcast(room);
    if(room.G.ended){ finishRoom(room); return; }
    aiPlayTurn(room);
  });

  // 主动退出房间（对局中视作掉线保留座位；未开局才真正退出）
  socket.on('leave', ()=>{
    if(!room || mySeat<0){ return; }
    const seatIdx=mySeat;
    const r=room;
    // 对局已创建（含确认轮）：点退出视作掉线（保留座位，等重连）
    if(r.G){
      logLine(r, `${r.seats[seatIdx].name} 退出（对局中，视作掉线等待重连）`);
      r.seats[seatIdx].offline=true;
      socket.leave(r.code);
      room=null; mySeat=-1;
      broadcast(r);
      return;
    }
    logLine(r, `${r.seats[seatIdx].name} 退出房间`);
    const wasHost = (seatIdx===0);
    r.seats[seatIdx]={type:'ai', name:['A家','B家','C家','D家'][seatIdx]};
    r.humanCount=Math.max(0,r.humanCount-1);
    r.ready[seatIdx]=false;
    socket.leave(r.code);
    room=null; mySeat=-1;
    // 房主退出：把房主（座位0）移交给剩余真人中座位号最小者
    if(wasHost && r.humanCount>0){
      for(let j=1;j<4;j++){
        if(r.seats[j].type==='human'){
          const moved=r.seats[j];
          r.seats[0]=moved;
          r.seats[j]={type:'ai', name:['A家','B家','C家','D家'][j]};
          r.ready[0]=r.ready[j]; r.ready[j]=false;
          // 通知新房主：其座位变 0
          const s=io.sockets.sockets.get(moved.socketId);
          if(s){ s.emit('promotedHost'); }
          logLine(r, `${moved.name} 成为房主`);
          break;
        }
      }
    }
    // 房间无人时自动删除（LOVE 常驻房除外）
    if(r.humanCount===0 && r.code!=='LOVE'){ clearIdleKick(r); rooms.delete(r.code); }
    else broadcast(r);
  });

  // 删除房间（房主可删自己的房间）
  // 删除房间：未开局房间任意可删；已开局仅房主可删
  socket.on('deleteRoom', (data)=>{
    const code=(data&&data.code||'').toUpperCase();
    if(code==='LOVE'){ socket.emit('toast','LOVE 是常驻房间，不能删除'); return; }
    const r=rooms.get(code);
    if(!r){ socket.emit('toast','房间不存在'); return; }
    if(r.G && r.G.started){
      // 已开局：仅房主（seat0 的真人）可删
      if(!room || mySeat!==0 || room!==r){ socket.emit('toast','对局已开始，仅房主可删除'); return; }
    }
    io.to(r.code).emit('roomClosed');
    clearIdleKick(r);
    rooms.delete(code);
    socket.leave(code);
    if(room===r){ room=null; mySeat=-1; }
  });

  // 断线
  socket.on('disconnect', ()=>{
    if(!room || mySeat<0) return;
    room.seats[mySeat].offline=true;
    logLine(room, `${room.seats[mySeat].name} 掉线，等待重连`);
    broadcast(room);
  });
});

// 常驻房 LOVE：作为常用房间，固定存在，即使无人也不删除
createRoom('LOVE');

server.listen(PORT, ()=>{
  console.log(`通山打拱服务器已启动：http://0.0.0.0:${PORT}`);
  console.log(`本地访问：http://localhost:${PORT}`);
});
