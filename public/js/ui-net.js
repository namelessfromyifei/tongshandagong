/* =========================================================
 * 通山打拱 · 网络版界面（多人联机）
 * 渲染由服务器广播的 G 快照驱动，动作发往服务器。
 * 所有玩家视角一致：自己的座位固定显示在下方（南位）。
 * 依赖：window.TS（引擎）、window.NET（net.js 网络层）
 * ========================================================= */
(function(){
"use strict";
const TS = window.TS;
const $ = id => document.getElementById(id);
// NET 在 net.js 加载后才就绪，运行时取用
const getNET = () => window.NET || { act(){}, nextRound(){} };

let G = null;              // 服务器下发的快照（权威）
let mySeat = -1;           // 我坐在第几号真实座位
let seatNames = [];        // 服务器房间座位名
let seatTypes = [];        // 服务器座位类型 human/ai
let seatOffline = [];      // 服务器座位掉线标记
let seatReady = [];        // 服务器座位准备标记
let settings = {};         // 房间设置
let series = null;         // 轮结算累计
let aiFill = true;
let selected = new Set();
let hintCursor=0, hintList=[];
let sortMode=0;
let lastRoundNo=-1; // 用于判断是否换了新局（换局才清空预选）
let lastRoundWasLast=false; // 当前结算的这局是否为一场的最后一局
let lastSettle=null, lastSettleSeq=0; // 局末结算（信息框外得分徽标用）
let cumTotals=[0,0,0,0];    // 客户端按局累计（规避服务器快照时序导致的"累计=0"）
let cumEndedSeq=0, resetPending=false;
let pendingPlay=false;      // 本次"出牌"是否已发送（成功后清空预选，失败保留）
// 拖动选牌：按下记录、移动判定、抬起后抑制随后的 click（避免拖动再切换）
let downInfo=null, clickSuppress=false;
function snapSeatOffline(i){ return !!seatOffline[i]; }

/* ---------- 排序（与单机版一致） ---------- */
const R5=2, R10=7, RK=10;
function handKey(c){ return c.j ? -1 : (TS.RANKS.length-1 - c.r); }
function buildKindMap(hand){
  const cnt=new Array(TS.RANKS.length).fill(0);
  for(const c of hand){ if(!c.j) cnt[c.r]++; }
  const groups = Math.min(cnt[R5], cnt[R10], cnt[RK]);
  const used={[R5]:0,[R10]:0,[RK]:0};
  const kind=new Map();
  for(const c of hand){
    if(c.j){ kind.set(c.id, 2); continue; }
    if((c.r===R5||c.r===R10||c.r===RK) && used[c.r]<groups){ used[c.r]++; kind.set(c.id, 0); continue; }
    if(cnt[c.r]>=4){ kind.set(c.id, 1); continue; }
    kind.set(c.id, 3);
  }
  return {cnt, kind};
}
function sortHandCards(){
  const hand = G ? G.seats[mySeat].hand : [];
  const {cnt, kind}=buildKindMap(hand);
  const idx=hand.map((c,i)=>i);
  if(sortMode===0){
    idx.sort((a,b)=>{ const ka=handKey(hand[a]), kb=handKey(hand[b]); return ka-kb || (hand[a].id<hand[b].id?-1:1); });
    return idx;
  }
  idx.sort((a,b)=>{
    const ca=hand[a], cb=hand[b];
    const ka=kind.get(ca.id), kb=kind.get(cb.id);
    if(ka!==kb) return ka-kb;
    if(ka===2) return ca.id<cb.id?-1:1;
    if(ka===0||ka===1){
      if(ka===0) return handKey(ca)-handKey(cb);
      const sa=cnt[ca.r], sb=cnt[cb.r];
      if(sa!==sb) return sb-sa;
      return handKey(ca)-handKey(cb);
    }
    const ra=handKey(ca), rb=handKey(cb);
    return ra-rb || (ca.id<cb.id?-1:1);
  });
  return idx;
}

/* ---------- 按钮控制 ---------- */
function setBtn(on){
  $('btnPlay').disabled=!on; $('btnPass').disabled=!on;
  $('btnHard').style.display='none';
  $('btnHe').style.display='none';
  $('btnHint').style.display='none';
}
function enablePlayer(){
  const mine = G && !G.ended && G.turn===mySeat;
  $('btnPlay').disabled = !mine;
  $('btnPass').disabled = !mine || !G.lastPlay;
  $('btnPass').textContent = '不要';
  $('btnHard').disabled=false;
  $('btnHard').style.display='none';
  $('btnHe').style.display='none';
  $('btnHint').style.display='inline-block';
}
function enableConfirm(){
  const seat=mySeat;
  $('btnHe').style.display = TS.handHasBomb(G.seats[seat].hand) ? 'none' : 'inline-block';
  $('btnHard').disabled=false;
  $('btnHard').style.display = 'inline-block';
  $('btnPass').disabled=false; $('btnPass').textContent='不明独';
  $('btnHint').style.display='none';
  $('btnPlay').disabled=true;
}

/* ---------- 动作（发服务器） ---------- */
function playerPlay(){
  if(!G||G.ended||G.turn!==mySeat) return;
  if(voiceBusy){ flashMsg('语音播放中，请稍候…'); return; }
  const cards=[...G.seats[mySeat].hand].filter((c,i)=>selected.has(i));
  if(cards.length===0){ flashMsg('请先选牌'); return; }
  // 先发送，待成功后（广播轮到我下家）再清空预选；失败时保留选择便于调整
  pendingPlay=true;
  getNET().act({type:'play', seat:mySeat, cards});
}
function playerPass(){
  if(!G) return;
  if(voiceBusy){ flashMsg('语音播放中，请稍候…'); return; }
  if(G.confirming){ getNET().act({type:'confirm', seat:mySeat, choice:'pass'}); return; }
  if(!G.lastPlay||G.turn!==mySeat) return;
  getNET().act({type:'pass', seat:mySeat});
}
function playerConfirmMingdu(){
  if(!G||!G.confirming) return;
  if(voiceBusy){ flashMsg('语音播放中，请稍候…'); return; }
  getNET().act({type:'confirm', seat:mySeat, choice:'mingdu'});
}
function playerHard(){ playerConfirmMingdu(); }
function playerHe(){
  if(!G||!G.confirming) return;
  getNET().act({type:'restart', seat:mySeat});
}
function playerHint(){
  if(!G||G.ended||G.seats[mySeat].out) return;
  hintList=TSAI ? [] : [];
  // 用本地引擎生成候选（仅供提示，不执行）
  if(window.TSAI) hintList=TSAI.genCandidates(G.seats[mySeat].hand, G.lastPlay||null);
  if(hintList.length===0){ flashMsg('没有能压的牌'); return; }
  hintCursor=(hintCursor+1)%hintList.length;
  const cand=hintList[hintCursor];
  const ids=new Set(cand.cards.map(c=>c.id));
  selected.clear();
  G.seats[mySeat].hand.forEach((c,i)=>{ if(ids.has(c.id)) selected.add(i); });
  render();
  flashMsg(describeShort(cand.play));
}
function toggleSort(){ sortMode=1-sortMode; render(); }

/* ---------- 牌大小调节（本机偏好，手牌 + 桌面出牌统一缩放） ---------- */
// 整体上调两档：原「特大/巨无霸」成为新的「标准/大」
const CARD_SCALES=[1.24,1.4,1.6,1.8];
let cardSizeIdx=2; // 默认「特大」
function applyCardSize(){
  document.documentElement.style.setProperty('--card-zoom', String(CARD_SCALES[cardSizeIdx]));
  if(typeof requestAnimationFrame==='function') requestAnimationFrame(()=>syncHandLayout());
}
function initCardSize(){
  try{
    const raw=localStorage.getItem('tsCardSize');
    if(raw!==null){
      const v=Number(raw);
      if(Number.isInteger(v) && v>=0 && v<CARD_SCALES.length) cardSizeIdx=v;
    }
  }catch(e){}
  applyCardSize();
}
function cycleCardSize(){
  cardSizeIdx=(cardSizeIdx+1)%CARD_SCALES.length;
  try{ localStorage.setItem('tsCardSize', String(cardSizeIdx)); }catch(e){}
  applyCardSize();
}

/* ---------- 语音提示（每一手出牌朗读） ---------- */
let voiceOn=true, zhVoices=[], voiceIdx=0, lastSpokenKey='';
let voiceBusy=false, voiceSeq=0; // 正在播报时暂不允许本地出牌
let voicePack=null, audioCtx=null; // 本地语音包
const clipCache=new Map();        // url -> Promise<AudioBuffer>
let voiceInit=true; // 首帧只记录状态，不播报历史事件
let lastEndedKey=null; // 已播报过「继续继续」的局
let prevRevealed=false; // 明鸡（对家打出叫牌）状态
let prevSeatState=[{passed:false,choice:null,dizhi:false},{passed:false,choice:null,dizhi:false},
                   {passed:false,choice:null,dizhi:false},{passed:false,choice:null,dizhi:false}];
// 音色排序：zh-CN 优先，常见高质量女声/网络音色优先
function rankVoice(v){
  const lang=(v.lang||'').toLowerCase(), name=(v.name||'');
  let s=0;
  if(lang==='zh-cn'||lang==='zh_cn') s+=40;
  else if(lang.indexOf('zh')===0) s+=20;
  if(/xiaoxiao|xiaoyi|huihui|yaoyao|tingting|meijia|female|女/i.test(name)) s+=15;
  if(/network/i.test(name)||/network/i.test(v.voiceURI||'')) s+=5;
  return s;
}
function refreshVoices(){
  if(!('speechSynthesis' in window)) return;
  let list=[];
  try{ list=(window.speechSynthesis.getVoices()||[]).filter(v=>/^zh/i.test(v.lang||'')); }catch(e){}
  list.sort((a,b)=>rankVoice(b)-rankVoice(a));
  zhVoices=list;
  if(zhVoices.length){
    let saved=null; try{ saved=localStorage.getItem('tsVoiceName'); }catch(e){}
    const si=saved?zhVoices.findIndex(v=>v.name===saved):-1;
    voiceIdx = si>=0 ? si : Math.min(voiceIdx, zhVoices.length-1);
  } else voiceIdx=0;
  const b=$('btnVoiceTone');
  if(b){
    b.style.display = (TTS_FALLBACK && zhVoices.length>1) ? 'inline-block' : 'none';
    b.textContent = zhVoices.length ? `音色 ${voiceIdx+1}/${zhVoices.length}` : '音色';
  }
}
function cycleVoiceTone(){
  if(zhVoices.length<=1){ flashMsg('设备只有一个中文音色'); return; }
  voiceIdx=(voiceIdx+1)%zhVoices.length;
  try{ localStorage.setItem('tsVoiceName', zhVoices[voiceIdx].name); }catch(e){}
  refreshVoices();
  speak(`第${voiceIdx+1}个音色`);
}
// 播报中禁用本地出牌按钮；播报结束（或语音不可用）后恢复
function voiceGate(){
  if(!G) return;
  if(voiceBusy){
    if(!G.ended && G.turn===mySeat){
      $('btnPlay').disabled=true;
      $('btnPass').disabled=true;
      if(G.confirming) $('btnHard').disabled=true;
    }
  } else if(!G.ended && G.turn===mySeat){
    if(G.confirming) enableConfirm(); else enablePlayer();
  }
}
function releaseVoice(){
  voiceSeq++;
  voiceBusy=false;
  voiceGate();
}
/* ---------- 本地语音包 ----------
 * 已接入真人语音包：不再使用系统 TTS；缺词条时静默。
 * 如需恢复「缺词条回退系统 TTS」，把 TTS_FALLBACK 改成 true。 */
const TTS_FALLBACK=false;
function initVoicePack(){
  try{
    fetch('voice/manifest.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(m=>{
      if(!m||!m.packs) return;
      let key=null; try{ key=localStorage.getItem('tsVoicePack'); }catch(e){}
      if(!key||!m.packs[key]) key=m.default;
      const p=m.packs[key]; if(!p||!p.files) return;
      voicePack={key,base:p.base||('voice/'+key+'/'),files:p.files,label:p.label||key};
    }).catch(()=>{});
  }catch(e){}
}
function ensureAudio(){
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) return null;
  if(!audioCtx){ try{ audioCtx=new AC(); }catch(e){ return null; } }
  if(audioCtx.state==='suspended'){ try{ audioCtx.resume(); }catch(e){} }
  return audioCtx;
}
// 首次触摸时解锁音频（部分 WebView 需要用户手势）
document.addEventListener('pointerdown', ()=>{ if(voicePack) ensureAudio(); }, {passive:true});
function getClip(ctx,t){
  const url=voicePack.base+voicePack.files[t];
  if(clipCache.has(url)) return clipCache.get(url);
  const p=fetch(url).then(r=>{ if(!r.ok) throw new Error('clip missing: '+url); return r.arrayBuffer(); })
    .then(ab=>ctx.decodeAudioData(ab)).then(buf=>{ clipCache.set(url,buf); return buf; });
  clipCache.set(url,p);
  return p;
}
let packSources=[];
function stopPackSources(){
  for(const s of packSources){ try{ s.stop(); }catch(e){} }
  packSources=[];
}
async function playPack(tokens, seq, noGate){
  if(!voicePack) return false;
  for(const t of tokens){ if(t!=='|' && !voicePack.files[t]) return false; }
  const ctx=ensureAudio(); if(!ctx) return false;
  try{
    const bufs=await Promise.all(tokens.map(t=> t==='|' ? null : getClip(ctx,t)));
    if(seq!==voiceSeq) return true; // 已被更新的播报取代
    stopPackSources(); // 新的播报打断上一段
    let at=ctx.currentTime+0.04;
    if(!noGate){ voiceBusy=true; voiceGate(); }
    for(let i=0;i<tokens.length;i++){
      if(tokens[i]==='|'){ at+=0.16; continue; }
      const b=bufs[i]; if(!b) continue;
      const src=ctx.createBufferSource(); src.buffer=b; src.connect(ctx.destination);
      src.onended=()=>{ const k=packSources.indexOf(src); if(k>=0) packSources.splice(k,1); };
      packSources.push(src);
      src.start(at); at+=b.duration;
    }
    if(!noGate){
      const done=()=>{ if(seq!==voiceSeq) return; voiceBusy=false; voiceGate(); };
      setTimeout(done, Math.ceil((at-ctx.currentTime)*1000)+600);
    }
    return true;
  }catch(e){ clipCache.clear(); return false; }
}
function speakTTS(text, seq, force){
  seq = (seq==null) ? ++voiceSeq : seq;
  if(!text) return;
  if(!force && !voiceOn){ releaseVoice(); return; }
  if(!('speechSynthesis' in window)){ releaseVoice(); return; }
  try{
    const synth=window.speechSynthesis;
    synth.cancel(); // 不排队积压，始终读最新一手
    const u=new SpeechSynthesisUtterance(text);
    u.lang='zh-CN'; u.rate=1.3; u.pitch=1.0;
    if(zhVoices[voiceIdx]) u.voice=zhVoices[voiceIdx];
    const done=()=>{ if(seq!==voiceSeq) return; voiceBusy=false; voiceGate(); };
    u.onend=done; u.onerror=done;
    voiceBusy=true;
    synth.speak(u);
    voiceGate();
    // 兜底：个别 WebView 不触发 onend，按文本长度估算后自动解锁
    setTimeout(done, Math.max(1500, text.length*300)+1000);
  }catch(e){ releaseVoice(); }
}
function speak(text, tokens){
  if(!voiceOn || (!text && !(tokens&&tokens.length))){ releaseVoice(); return; }
  if(voicePack && tokens && tokens.length){
    const seq=++voiceSeq;
    playPack(tokens, seq).then(ok=>{
      if(ok || seq!==voiceSeq) return;
      if(TTS_FALLBACK) speakTTS(text, seq); // 可选：缺词条回退系统 TTS
      else releaseVoice();                  // 否则静默
    });
    return;
  }
  if(TTS_FALLBACK) speakTTS(text);
  else releaseVoice();
}
// 手动「快点」：强制播放语音包里的 快点.m4a（不受语音开关/播报门控限制）
function playQuick(){
  const text='快点', tokens=['快点'];
  if(voicePack && voicePack.files && tokens.every(t=>voicePack.files[t])){
    const ctx=ensureAudio();
    if(ctx){ playPack(tokens, voiceSeq, true); return; }
  }
  if(TTS_FALLBACK) speakTTS(text, voiceSeq, true);
}
function applyVoiceBtn(){ const b=$('btnVoice'); if(b) b.textContent='语音：'+(voiceOn?'开':'关'); }
function initVoice(){
  try{ const v=localStorage.getItem('tsVoice'); if(v!==null) voiceOn=(v==='1'); }catch(e){}
  applyVoiceBtn();
  refreshVoices();
  initVoicePack();
  if('speechSynthesis' in window){ try{ window.speechSynthesis.onvoiceschanged=refreshVoices; }catch(e){} }
}
function toggleVoice(){
  voiceOn=!voiceOn;
  try{ localStorage.setItem('tsVoice', voiceOn?'1':'0'); }catch(e){}
  applyVoiceBtn();
  if(!voiceOn && 'speechSynthesis' in window){ try{ speechSynthesis.cancel(); }catch(e){} }
  if(voiceOn && TTS_FALLBACK) speak('语音提示已开启');
}
// 返回 {text, tokens}：text 供 TTS 兜底；tokens 为语音包词条（可整句拼接）
function playSpeech(cards){
  const p=TS.analyzePlay(cards, G&&G.cfg);
  if(!p) return null;
  // TTS 读法：J 读“沟”、Q 读“圈”、A 读“兼”；语音包按 1-J/2-Q/3-A 取文件
  const rt=r=>{ const s=TS.RANKS[r]; return s==='J'?'沟':(s==='Q'?'圈':(s==='A'?'兼':s)); };
  const rk=r=>TS.RANKS[r];
  switch(p.type){
    case 'single': {
      const c=cards[0];
      return (c&&c.j) ? {text:'王', tokens:['1-W']} : {text:rt(c.r), tokens:['1-'+rk(c.r)]};
    }
    case 'pair': {
      const allJ=cards.every(c=>c.j);
      return allJ ? {text:'对王', tokens:['2-W']} : {text:'对'+rt(p.val), tokens:['2-'+rk(p.val)]};
    }
    case 'triple': {
      const allJ=cards.every(c=>c.j);
      return allJ ? {text:'三个王', tokens:['3-W']} : {text:'三个'+rt(p.val), tokens:['3-'+rk(p.val)]};
    }
    case 'seqPair': return {text:'连对', tokens:['连对']};
    case 'airplane': return {text:'飞机', tokens:['飞机']};
    case 'fiftyK': return {text:'五十K', tokens:['五十K']};
    case 'bomb':
      // 4/5/6 张无番炸 → 「炸弹」；7 张以上 → 按「滚笼」播报
      if(p.fan===0) return {text:'炸弹', tokens:['炸弹']};
      return {text:'滚笼', tokens:['滚笼']};
    case 'rollcage': return {text:'滚笼', tokens:['滚笼']};
    case 'kingBomb': return {text:`${p.size}个王`, tokens:[`${p.size}-W`]};
    default: return null;
  }
}
// 出牌 / 不要 / 明独 / 不明独 / 插底：同一帧的事件合并成一句播报
function announceState(){
  if(!G) return;
  const msgs=[]; // {text, tokens}
  if(G.lastSeat>=0 && G.lastCards && G.lastCards.length){
    const key = G.playNo!=null ? ('#'+G.playNo) : (G.lastSeat+':'+G.lastCards.map(c=>c.id).join(','));
    if(key!==lastSpokenKey){
      lastSpokenKey=key;
      const sp=playSpeech(G.lastCards);
      if(sp) msgs.push(sp);
    }
  }
  for(let i=0;i<4;i++){
    const s=G.seats[i]; if(!s) continue;
    const cur={ passed:!!s.passed, choice:s.choice||null, dizhi:!s.out && !!s.hand && s.hand.length===1 };
    const prev=prevSeatState[i]||{passed:false,choice:null,dizhi:false};
    if(!voiceInit){
      if(cur.passed && !prev.passed) msgs.push({text:'不要',tokens:['不要']});
      if(cur.choice && cur.choice!==prev.choice){ const c=cur.choice==='mingdu'?'明独':'不独'; msgs.push({text:c,tokens:[c]}); }
      if(cur.dizhi && !prev.dizhi) msgs.push({text:'插底',tokens:['插底']});
    }
    prevSeatState[i]=cur;
  }
  // 非叫牌家打出明鸡牌（身份公开）时播报「明鸡」
  const rv=!!G.revealed;
  if(!voiceInit && rv && !prevRevealed) msgs.push({text:'明鸡',tokens:['明鸡']});
  prevRevealed=rv;
  // 每局结束：播报「继续继续」
  if(G.ended){
    const rk=G.seq||G.roundNo||0;
    if(rk!==lastEndedKey){ lastEndedKey=rk; msgs.push({text:'继续继续',tokens:['继续继续']}); }
  } else {
    lastEndedKey=null;
  }
  voiceInit=false;
  if(!msgs.length) return;
  const tokens=[];
  msgs.forEach((m,i)=>{ if(i) tokens.push('|'); tokens.push(...m.tokens); });
  speak(msgs.map(m=>m.text).join('，'), tokens);
}

/* ---------- 状态接收 ---------- */
let curRoomCode=''; // 当前房间号（换房间时清掉上一房间遗留的牌面）
function applyState(snap){
  if(snap.code && snap.code!==curRoomCode){
    curRoomCode=snap.code;
    // 换房间：清掉上一房间/上一局遗留的桌面、手牌与状态
    const h=$('hand'); if(h) h.innerHTML='';
    for(let k=0;k<4;k++){
      const tr=$('t'+k); if(tr) tr.innerHTML='';
      const hc=$('h'+k); if(hc) hc.innerHTML='';
      const he=$('hint'+k); if(he) he.innerHTML='';
    }
    const md=$('modal'); if(md) md.hidden=true;
    selected.clear(); hintList=[]; lastRoundNo=-1; lastSettle=null; lastSettleSeq=0;
    cumTotals=[0,0,0,0]; cumEndedSeq=0; resetPending=false; pendingPlay=false;
    lastSpokenKey=''; // 换房间后允许重新播报
    lastEndedKey=null;
    prevRevealed=false;
    voiceInit=true;
    prevSeatState=[{passed:false,choice:null,dizhi:false},{passed:false,choice:null,dizhi:false},
                   {passed:false,choice:null,dizhi:false},{passed:false,choice:null,dizhi:false}];
  }
  G = snap.G || null;
  seatNames = snap.seats.map(s=>s.name);
  seatTypes = snap.seats.map(s=>s.type);
  seatOffline = snap.seats.map(s=>!!s.offline);
  aiFill = snap.aiFill;
  settings = snap.settings || settings;
  // 房主可在「对局配置」里开启出牌记录框（默认不显示）
  const logEl=$('log');
  if(logEl) logEl.style.display = settings.showLog === true ? '' : 'none';
  // 只在换新局时清空预选；同一局内其他玩家出牌时保留已选牌（方便等待时预选下一手）
  const roundKey = G ? (G.seq||G.roundNo) : -1;
  if(!G || roundKey!==lastRoundNo){ selected.clear(); lastRoundNo=roundKey; }
  // 我的"出牌"已成功（轮到下家 / 对局结束）→ 此时清空预选；失败时快照不会变化，保留选择
  if(pendingPlay && G && (G.ended || (!G.confirming && G.turn!==mySeat))){
    pendingPlay=false;
    selected.clear();
  }
  // 客户端累计：每局结束累加一轮；新场开始（入场后第一局非结束时）重置
  if(G && G.ended && roundKey!==cumEndedSeq){
    cumEndedSeq=roundKey;
    try{
      const st2=TS.settleRound(G);
      for(let k=0;k<4;k++) cumTotals[k]+=st2.perFen[k];
      if(G.lastSeries) resetPending=true;
    }catch(e){}
  } else if(G && !G.ended && resetPending){
    cumTotals=[0,0,0,0];
    resetPending=false;
    cumEndedSeq=0;
  }
  hintCursor=0; hintList=[];
  if(!G){
    // 未开局：更新房间信息 + 座位名，显示等待
    if($('lblMode')) $('lblMode').textContent='等待开局';
    if($('lblRound')) $('lblRound').textContent='';
    if($('msg')) $('msg').textContent='等待全员准备…';
    if($('btnSort')) $('btnSort').style.display='none'; // 开局前不显示排序按钮
    if($('btnNext')) $('btnNext').style.display='none';
    for(let k=0;k<4;k++){ const he=$('hint'+k); if(he) he.innerHTML=''; }
    renderSeatNames();
    renderReadyIndicators();
    setBtn(false);
    return;
  }
  if($('btnSort')) $('btnSort').style.display='inline-block'; // 开局后显示排序按钮
  if($('lblMode')) $('lblMode').textContent = G.mode==='hard'?('硬牌 · '+seatNames[G.hardSeat]):'2V2';
  // 结算弹窗
  if(G.ended){
    // 最后一局：始终弹结算窗（后面不再有 G 快照可取）；非最后一局：已就绪则不再重复弹
    if(G.lastSeries || !seatReady[mySeat]) finishLocal();
    else $('modal').hidden = true;
  } else {
    $('modal').hidden = true;
  }
  render();
  announceState();
  // 牌桌上的"下一局"按钮：仅本局结束后显示（关闭计分板后也能进入下一局）
  if($('btnNext')) $('btnNext').style.display = (G && G.ended) ? 'inline-block' : 'none';
  // 按钮：确认轮 / 出牌轮
  if(G.ended){ setBtn(false); return; }
  if(G.confirming){ setBtn(false); if(G.turn===mySeat) enableConfirm(); }
  else { setBtn(false); if(G.turn===mySeat) enablePlayer(); }
  voiceGate(); // 语音播报未结束时保持按钮禁用
  syncHandLayout(); // 按钮显隐/换容器后重新定位（明独/不明独居中）
}

/* ---------- 渲染 ---------- */
function render(){
  if(!G) return;
  // 局末才结算一次（信息框外得分徽标用），避免每步广播都重算
  if(G.ended && (G.seq||G.roundNo)!==lastSettleSeq){ lastSettleSeq=G.seq||G.roundNo; try{ lastSettle=TS.settleRound(G); }catch(e){ lastSettle=null; } }
  else if(!G.ended){ lastSettle=null; }
  renderSeats(); renderHand(); renderCenter(); renderTop();
  syncHandLayout();
}
function renderTop(){
  $('lblMode').textContent = G.mode==='hard'?('硬牌 · '+seatNames[G.hardSeat]):'2V2';
  // 场/局：场=多局，当前是第几场/共几场
  const total=settings.rounds||1;
  const cur=series&&series.active ? series.roundCount : Math.min(1,total);
  $('lblRound').textContent = `第 ${cur}/${total} 场`;
  updateSeriesInfo();
}
// 仅渲染座位名字（未开局也可显示各玩家昵称 + 准备/掉线状态）
function renderSeatNames(){
  const realOf = v => (mySeat + v) % 4;
  for(let v=0;v<4;v++){
    const i=realOf(v);
    const nm=$('nm'+v);
    if(nm){
      const isHuman = seatTypes[i]==='human';
      if(isHuman){
        // 真人座位：信息框只显示昵称/掉线；准备状态显示在各自牌桌上
        nm.textContent = (seatNames[i]||(''));
        if(snapSeatOffline(i)) nm.textContent += ' ⚠️掉线';
      } else {
        // AI 空位：玩家进入前不显示 A/B/C/D 家
        nm.textContent = '';
      }
    }
    const av=$('av'+v); if(av) av.innerHTML=['南','东','北','西'][v];
    const pEl=$('p'+v); if(pEl) pEl.textContent = '';
  }
}
// 把「已准备 / 未准备」显示在各家自己的出牌区（牌桌上），绿色/红色圆点
function renderReadyIndicators(){
  const realOf = v => (mySeat + v) % 4;
  for(let v=0;v<4;v++){
    const tr=$('t'+v); if(!tr) continue;
    tr.innerHTML='';
    const i=realOf(v);
    if(seatTypes[i]!=='human') continue; // AI 空位不显示
    const ready=!!seatReady[i];
    const d=document.createElement('div');
    d.className='readyHint';
    d.innerHTML=`<span class="readyDot ${ready?'on':'off'}"></span><span>${ready?'已准备':'未准备'}</span>`;
    tr.appendChild(d);
  }
}
// 显示本场累计分数：改显示在每人 tag 右上侧（局数>1），不再放牌桌上方
function updateSeriesInfo(){
  const el=$('seriesInfo'); if(!el) return;
  el.textContent='';
}
function seatTag(i){
  if(G.mode==='hard') return i===G.hardSeat?'<span class="teamMark hard">硬</span>':'';
  // 明鸡已出：庄队(叫牌方+明鸡)统一金色◆，客队统一红色◆ —— 同队同标记
  if(G.revealed) return (i===G.landlord||i===G.partner)
    ? '<span class="teamMark ta">◆</span>'
    : '<span class="teamMark tb">◆</span>';
  return i===G.landlord ? '<span class="teamMark host">主</span>' : '';
}
function renderSeats(){
  // 视图重排：自己的座位(real=mySeat)显示在下方(南位 view0)
  const realOf = v => (mySeat + v) % 4;
  for(let v=0;v<4;v++){
    const i=realOf(v);
    const s=G.seats[i];
    const el=document.querySelector(`.seat[data-seat="${v}"]`); if(!el) continue;
    el.classList.toggle('active', G.turn===i && !G.ended);
    const nm=$('nm'+v);
    nm.textContent = (seatNames[i]||s.name);
    if(seatTypes[i]==='ai' && !s.out) nm.textContent += ' 🤖';
    // 掉线：在名字框显示"掉线·等待重连"
    if(seatTypes[i]==='human' && snapSeatOffline(i)) nm.textContent += ' ⚠️掉线·等待重连';
    // 4+ 王信息：仅当该家已打出至少一张王（kingPlayed）且开局 ≥4 王，才在头像上标注“>4王”
    const av=$('av'+v);
    if(av){
      av.innerHTML = ['南','东','北','西'][v];
      if(s.kingPlayed && s.kings>=4) av.innerHTML += `<span class="kingBadge">&gt;4王</span>`;
    }
    // 明鸡牌小卡：始终显示在叫牌方（庄家）tag 上，让大家知道叫的是什么牌；队友 tag 不显示
    const calledMiniHtml = (G.mode!=='hard' && G.called && !s.out && i===G.landlord)
      ? '<span class="calledMini">' + cardHTML({j:false,r:G.called.r,s:G.called.s},'mini') + '</span>' : '';
    if(G.mode!=='hard' && G.revealed){
      // 明鸡已出：同队用相同标记（◆/◇ + 座位底色），不用“同队/主/明”文字
      $('tag'+v).innerHTML = seatTag(i) + calledMiniHtml;
      el.classList.toggle('teamA', (i===G.landlord||i===G.partner));
      el.classList.toggle('teamB', (i!==G.landlord&&i!==G.partner));
    } else {
      el.classList.remove('teamA'); el.classList.remove('teamB');
      $('tag'+v).innerHTML = seatTag(i) + calledMiniHtml;
    }
    const pEl=$('p'+v); if(!pEl) continue;
    const rollN=s.rollcages.length;
    const rollFan=s.rollcages.reduce((a,r)=>a+r.fan,0);
    pEl.textContent =
      (v!==0 && settings.showRemain ? ('手牌 '+s.hand.length+' 张 · ') : '')+
      '抓分 '+s.caught+
      // 跑完：其打出的带番炸已生效，直接显示已得番数
      (s.out
        ? (' · 得'+rollFan+'笼')
        : (rollN>0?(' · 已打'+rollFan+'笼'):''))+
      (s.out?(' · '+['一','二','三','四'][s.outOrder-1]+'游'):'')+
      (G.mode==='hard'&&i===G.hardSeat?' · 硬牌':'');
    // 其他玩家手牌背面（自己的手牌在手牌区渲染）
    if(v!==0){
      const h=$('h'+v); h.innerHTML='';
      if(s.out){
        // 已跑完：手牌已空，不显示背面牌堆
      } else if(G.ended){
        // 局末：未出完的真实手牌，按点数顺序理好；较多时分两行、两行叠起
        h.classList.add('remainStack');
        const order=[...s.hand].sort((a,b)=>{
          const ka=a.j?-1:(TS.RANKS.length-1-a.r), kb=b.j?-1:(TS.RANKS.length-1-b.r);
          return ka-kb;
        });
        const ROW=14;
        const rows=Math.ceil(order.length/ROW);
        for(let ri=0;ri<rows;ri++){
          const row=document.createElement('div'); row.className='remainRow';
          order.slice(ri*ROW,(ri+1)*ROW).forEach(c=>{
            row.insertAdjacentHTML('beforeend', cardHTML(c,'mini remainCard'));
          });
          h.appendChild(row);
        }
      } else {
        h.classList.remove('remainStack');
        // 不显示剩余张数时：背面牌堆固定显示 5 张（隐藏真实数量，减小占地）
        const shown = settings.showRemain ? s.hand.length : 5;
        const n=Math.min(shown,15);
        for(let k=0;k<n;k++){ const d=document.createElement('div'); d.className='backCard'; h.appendChild(d); }
        if(settings.showRemain && s.hand.length>15){ const sp=document.createElement('span'); sp.textContent='+'+(s.hand.length-15); h.appendChild(sp); }
      }
    }
    // 右上角：当前已打出的带番炸总笼数
    if(G && rollFan>0){
      let tEl=el.querySelector('.cumSco');
      if(!tEl){ tEl=document.createElement('span'); el.appendChild(tEl); }
      tEl.className='cumSco fan';
      tEl.textContent=rollFan+'笼';
    } else {
      const tEl=el.querySelector('.cumSco'); if(tEl) tEl.remove();
    }
    // 右下角：本场累计分数（局数>1 且已打至少一局）
    if((settings.rounds||1)>1 && cumEndedSeq>0){
      const ct=cumTotals[i];
      let bEl=el.querySelector('.roundSco');
      if(!bEl){ bEl=document.createElement('span'); el.appendChild(bEl); }
      bEl.className='roundSco '+(ct>0?'plus':ct<0?'minus':'zero');
      bEl.textContent=(ct>0?'+':'')+ct;
    } else {
      const bEl=el.querySelector('.roundSco'); if(bEl) bEl.remove();
    }
    // 出牌区
    const tr=$('t'+v); tr.innerHTML='';
    const isDizhi = !s.out && s.hand.length===1;
    // 状态提示（插底 / x游）：南=准备按钮右侧；东/西=信息框下方；北=信息框右侧
    const hintEl=$('hint'+v);
    if(hintEl) hintEl.innerHTML='';
    const addAlert=()=>{
      if(!hintEl) return;
      const d=document.createElement('div');
      d.innerHTML='<span class="warnDizhi"><span class="icon">!</span></span>';
      hintEl.appendChild(d);
    };
    const addPlace=()=>{
      if(!hintEl) return;
      const d=document.createElement('div');
      d.textContent=['一','二','三','四'][s.outOrder-1]+'游';
      d.style.cssText='color:#ffe9b0;font-size:13px;font-weight:bold;';
      hintEl.appendChild(d);
    };
    if(i===G.turn && !G.ended){
      // 轮到该家：不显示任何占位符（插底提示在末尾统一追加）
    } else if(s.choice){
      const d=document.createElement('div');
      d.textContent = s.choice==='mingdu' ? '明独' : '不明独';
      d.style.cssText = s.choice==='mingdu' ? 'color:#ff9d8a;font-size:15px;font-weight:bold;padding:8px 0;' : 'color:#d9e8e0;font-size:14px;padding:8px 0;';
      tr.appendChild(d);
    } else if(s.passed){
      const d=document.createElement('div'); d.textContent='不要'; d.style.cssText='color:#ffb39a;font-size:17px;font-weight:bold;padding:8px 0;'; tr.appendChild(d);
    } else if(s.lastCards&&s.lastCards.length){
      // 南/北在桌面上下方，横向空间足够：所有牌叠放在同一排，不换行；
      // 东/西在两侧，仍按每排 7 张分行。
      const ROW = (v===0 || v===2) ? s.lastCards.length : 7;
      const rows=Math.ceil(s.lastCards.length/ROW);
      const pPlay=TS.analyzePlay(s.lastCards);
      const showFan = pPlay && (pPlay.type==='rollcage'||pPlay.type==='kingBomb'||(pPlay.type==='bomb'&&pPlay.fan>0));
      for(let ri=0;ri<rows;ri++){
        const row=document.createElement('div'); row.className='trickRow';
        s.lastCards.slice(ri*ROW,(ri+1)*ROW).forEach(c=>{
          // 明鸡牌出桌面：只有"明鸡/队友"打出叫牌的那张才加高亮，庄家自己出的不标
          const isCalledCard = (G.mode!=='hard' && i===G.partner && G.called && !c.j && c.r===G.called.r && c.s===G.called.s);
          row.insertAdjacentHTML('beforeend', cardHTML(c, isCalledCard ? 'calledOnDesk' : 'mini'));
        });
        tr.appendChild(row);
      }
      if(showFan){
        const lastCard=tr.querySelector('.trickRow:last-child .card:last-child');
        if(lastCard){
          const badge=document.createElement('span'); badge.textContent=`${pPlay.fan}笼`; badge.className='fanBadge'; lastCard.appendChild(badge);
        }
      }
      if(s.out && s.outOrder>0) addPlace(true); // 刚出完最后一手：出的牌 + 名次一起显示
    } else if(s.out && s.outOrder>0){
      addPlace(false); // 已跑且无牌可展示：单独显示 x游
    }
    // 插底提示始终显示（本局结束或该玩家已跑完才消失），不会被"不要/明独/出牌"覆盖
    if(!G.ended && isDizhi) addAlert();
  }
  const msg=$('msg');
  if(!G.ended){
    msg.textContent = G.turn===mySeat ? '轮到你了' : `轮到 ${seatNames[G.turn]}`;
    if(G.mode!=='hard'){
      msg.textContent += G.revealed ? ` · 对家已明：${seatNames[G.partner]}` : ` · 对家未明（叫牌 ${TS.cardName(G.called)}）`;
    } else {
      msg.textContent += ` · ${seatNames[G.hardSeat]} 硬牌 1打3`;
    }
  } else msg.textContent='本局结束';
  renderCorner();
}
function renderCorner(){
  const c=$('corner'); if(!c) return;
  // 房主可在「对局配置」里开启该信息框（默认不显示）
  c.style.display = settings.showCorner === true ? '' : 'none';
  c.innerHTML='';
  const mkChip=(label,val)=>`<div class="cornerRow"><span style="color:#a8c8b8">${label}</span><b>${val||'—'}</b></div>`;
  c.innerHTML += mkChip('叫牌', G.mode==='hard'?'硬牌':(G.called?TS.cardName(G.called):'—'));
  if(G.mode!=='hard' && G.called){
    c.innerHTML+=`<div class="cornerRow">${cardHTML({j:false,r:G.called.r,s:G.called.s},'mini')}<span>${seatNames[G.landlord]} 叫</span></div>`;
  }
  c.innerHTML += mkChip('明鸡', G.mode==='hard'?'—':(G.revealed?`已出 · ${seatNames[G.partner]}`:'未出'));
  c.innerHTML += mkChip('庄家', G.mode==='hard'?seatNames[G.hardSeat]:seatNames[G.landlord]);
}
function cardHTML(c,cls){
  if(c.j) return `<div class="card jk ${cls||''}"><span class="tl">王</span><span class="br">王</span><span class="ctr">王</span></div>`;
  const red=(c.s===1||c.s===3)?' red':'';
  const rn=TS.RANKS[c.r], ch=TS.SUIT_CH[c.s];
  return `<div class="card${red} ${cls||''}">`+
    `<span class="tl">${rn}<br>${ch}</span><span class="br">${rn}<br>${ch}</span><span class="ctr">${ch}</span></div>`;
}
function renderHand(){
  const handEl=$('hand'); handEl.innerHTML='';
  if(!G||mySeat<0){ return; }
  const s=G.seats[mySeat];
  if(s.out){
    if(G.ended) return; // 本局已结束：桌面不再显示“已出局”
    let show=null;
    if(G.mode!=='hard'){ show = G.landlord===mySeat ? G.partner : (G.partner===mySeat ? G.landlord : null); }
    if(show!=null && !G.seats[show].out){
      const hs=G.seats[show];
      // 先渲染队友牌，文字放在牌的右侧（避免被第一张牌的负边距遮住）
      renderCardFan(handEl, hs.hand);
      const cap=document.createElement('div');
      cap.textContent=`队友牌`;
      cap.style.cssText='color:#a8c8b8;font-size:12px;align-self:center;margin-left:8px;flex:0 0 auto;white-space:nowrap;';
      handEl.appendChild(cap);
    } else {
      const d=document.createElement('div'); d.textContent='已跑完'; d.style.cssText='padding:24px;color:#a8c8b8;font-size:14px;'; handEl.appendChild(d);
    }
    return;
  }
  const order=sortHandCards();
  order.forEach(idx=>{
    const c=s.hand[idx];
    const el=document.createElement('div');
    let cls='hcard'+(selected.has(idx)?' sel':'');
    if(G.mode!=='hard' && G.called && !c.j && c.r===G.called.r && c.s===G.called.s) cls+=' calledMark';
    el.className=cls;
    el.dataset.i=idx;
    el.innerHTML=cardHTML(c);
    el.onclick=()=>{
      if(G.ended) return;
      if(clickSuppress){ clickSuppress=false; return; } // 拖动手势后的 click 不再切换
      if(selected.has(idx)) selected.delete(idx); else selected.add(idx);
      el.classList.toggle('sel',selected.has(idx));
    };
    handEl.appendChild(el);
  });
  const btn=$('btnSort'); if(btn) btn.textContent = sortMode===0?'排序：点数':'排序：炸前置';
}
function renderCardFan(handEl, cards){
  const order=[...cards].sort((a,b)=>handKey(a)-handKey(b));
  order.forEach(c=>{
    const el=document.createElement('div');
    let cls='hcard';
    if(G.mode!=='hard' && G.called && !c.j && c.r===G.called.r && c.s===G.called.s) cls+=' calledMark';
    el.className=cls;
    el.innerHTML=cardHTML(c);
    handEl.appendChild(el);
  });
}
function renderCenter(){
  $('trickScore').textContent=`本轮分数 ${G.trickPoints} 分` + (G.lastSeat>=0?` · ${seatNames[G.lastSeat]} 压着`:'');
}
function describeShort(p){
  if(p.type==='rollcage') return `滚笼 ${p.s}×${p.k}（${p.soft?'软':'硬'} ${p.fan} 笼）`;
  if(p.type==='bomb') return `${p.size} 张炸（${p.fan} 笼）`;
  if(p.type==='fiftyK') return p.tonghua?'五十K（同花）':'杂五十K';
  if(p.type==='kingBomb') return `王炸（${p.fan} 笼）`;
  return p.type;
}

/* ---------- 结算（服务器已算出结果，仅本地展示） ---------- */
// 基础分（牌面分，不含炸番/王奖）：与炸番相加 = 本局分（队内同值）
function baseFenOf(st,i){
  const sign=st.winnerSeats.includes(i)?1:-1;
  if(st.mode==='hard') return (i===st.hardSeat?6:2)*sign;
  return Math.round(st.basePer*2)*sign;
}
function finishLocal(){
  try{
    const s=TS.settleRound(G);
    const tb=$('mTable');
    $('mTitle').textContent = `本局结束 · ${G.mode==='hard'
      ? `硬牌者 ${seatNames[G.hardSeat]} ${s.winnerSeats.includes(G.hardSeat)?'胜':'败'}`
      : `赢${s.winnerSeats.map(i=>seatNames[i]).join('、')}`}`;
    // 是否本场最后一局：由服务器标记（避免客户端根据已累计的局数猜错）
    lastRoundWasLast = !!G.lastSeries;
    const close=$('btnClose');
    if(close) close.textContent = lastRoundWasLast ? '本场结束' : '下一局';
    tb.innerHTML=`<tr><th>座位</th><th>名次</th><th>身份</th><th>牌面笼数</th><th>炸笼</th><th>本局(分)</th><th>累计(分)</th></tr>`;
    for(let v=0;v<4;v++){
      const i=(mySeat+v)%4, fv=s.perFen[i];
      const bs=baseFenOf(s,i);           // 基础分（牌面笼数，不含炸笼/王奖）
      const bombF=fv-bs;                  // 炸笼（含王奖后的差额）
      const gs=G.seats[i];
      const place = gs.out ? ['一','二','三','四'][gs.outOrder-1]+'游' : '—';
      const kb = s.kingBonus&&s.kingBonus[i] ? `（含王奖${s.kingBonus[i]}笼×3）` : '';
      const bb = s.bombBonus&&s.bombBonus[i] ? `（含硬炸奖${s.bombBonus[i]}笼×3）` : '';
      tb.innerHTML+=`<tr><td>${seatNames[i]}</td>`+
        `<td>${place}</td><td>${seatTag(i)}</td><td>${bs>0?'+':''}${bs}</td>`+
        `<td>${bombF>0?'+':''}${bombF}${kb}${bb}</td>`+
        `<td>${fv>0?'+':''}${fv}</td><td>${cumTotals[i]}</td></tr>`;
    }
    // 说明 + 轮累计
    const noteTxt = `牌面笼数 + 炸笼 = 本局分`;
    if(series && series.active && settings.rounds>1){
      tb.innerHTML+=`<tr><td colspan="7" class="note">${noteTxt} · 轮内第 ${series.roundCount}/${settings.rounds} 局 · 累计：${cumTotals.map((t,i)=>`${seatNames[i]} ${t>0?'+':''}${t}分`).join('  ')}</td></tr>`;
    } else {
      tb.innerHTML+=`<tr><td colspan="7" class="note">${noteTxt}</td></tr>`;
    }
    $('modal').hidden=false;
  }catch(e){}
}

/* ---------- 日志 ---------- */
function log(msg){ const el=$('log'); const d=document.createElement('div'); d.textContent=msg; el.appendChild(d); el.scrollTop=el.scrollHeight; }
function flashMsg(m){ $('msg').textContent=m; }
function addLog(msg){ log(msg); }

/* ---------- 网络回调用（net.js 调用） ---------- */
window.GameUI = {
  applyState,
  setSelf(seat, names, types, aiOn, offArr, readyArr){
    mySeat=seat; seatNames=names||[]; seatTypes=types||[]; seatOffline=offArr||[]; seatReady=readyArr||[]; aiFill=aiOn!==undefined?aiOn:true;
  },
  setSeries(s){
    series = s || null;
    updateSeriesInfo();
  },
  addLog,
};

/* ---------- 北家出牌区：始终贴在北家信息框下方 10px（随信息框高度自适应） ---------- */
function positionNorthTrick(){
  const seat=document.querySelector('.seatN');
  const tr=document.getElementById('t2');
  if(!seat||!tr) return;
  const top=seat.offsetTop + seat.offsetHeight + 10;
  tr.style.top=top+'px';
}

/* ---------- 本家信息框：始终悬在手牌上方（随牌面高度自适应上移） ---------- */
function positionSeatS(){
  const row=document.querySelector('.handRow');
  const info=document.querySelector('.handRow .seatS');
  const area=document.querySelector('.handArea');
  const hand=document.getElementById('hand');
  if(!row||!info||!area||!hand) return;
  // 累加 offsetTop 到 handRow（offset* 为布局坐标，旋转兜底不受 transform 影响）
  const topWithin=(el, stop)=>{ let y=0; for(let n=el; n && n!==stop; n=n.offsetParent) y+=n.offsetTop; return y; };
  const first=hand.querySelector('.hcard');
  let cardsTopInRow;
  if(first){
    cardsTopInRow = topWithin(first, row);
  } else {
    const pad=parseFloat(getComputedStyle(hand).paddingTop)||0;
    cardsTopInRow = topWithin(hand, row) + pad;
  }
  const bottom = Math.round(row.offsetHeight - cardsTopInRow + 6);
  info.style.bottom = bottom + 'px';
}

/* ---------- 明独/不明独：确认轮放在牌的中间 ---------- */
function layoutActionButtons(){
  if(!G) return;
  const mid=$('midBtns'), right=$('playBtns');
  const pass=$('btnPass'), hard=$('btnHard'), hint=$('btnHint');
  if(!mid||!right||!pass||!hard||!hint) return;
  if(G.confirming){
    // 初始确认轮：明独 + 不明独 放在牌的中间
    if(hard.parentElement!==mid) mid.appendChild(hard);
    if(pass.parentElement!==mid) mid.appendChild(pass);
  } else {
    // 出牌轮：出牌 + 不要 + 提示 放在牌的右上角
    if(pass.parentElement!==right) right.insertBefore(pass, hint);
    if(hint.parentElement!==right) right.appendChild(hint);
    if(hard.parentElement!==mid) mid.appendChild(hard);
  }
}
function positionMidBtns(){
  const row=document.querySelector('.handRow');
  const box=$('midBtns');
  const hand=document.getElementById('hand');
  if(!row||!box||!hand) return;
  const leftWithin=(el,stop)=>{ let x=0; for(let n=el; n && n!==stop; n=n.offsetParent) x+=n.offsetLeft; return x; };
  const topWithin=(el,stop)=>{ let y=0; for(let n=el; n && n!==stop; n=n.offsetParent) y+=n.offsetTop; return y; };
  const first=hand.querySelector('.hcard');
  const hasCards = !!first && hand.offsetWidth>0;
  const center = hasCards ? (leftWithin(hand,row)+hand.offsetWidth/2) : (row.offsetWidth/2);
  box.style.left = Math.max(0, Math.round(center - box.offsetWidth/2)) + 'px';
  const cardsTop = hasCards ? topWithin(first,row) : 0;
  box.style.bottom = Math.round(row.offsetHeight - cardsTop + 6) + 'px';
}

/* ---------- 手牌满 28 张时的宽度（用于固定按钮位置，不随剩牌减少左移） ---------- */
let handMetric=null; // {cardW, step} —— 未缩放尺寸（offset* 不含 zoom）
function fullHandWidth(){
  const hand=document.getElementById('hand');
  if(!hand) return 0;
  const cards=hand.querySelectorAll('.hcard');
  const zoom=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-zoom'))||1;
  if(cards.length>=2){
    handMetric={ cardW:cards[0].offsetWidth, step:cards[1].offsetLeft-cards[0].offsetLeft };
  }
  if(!handMetric) return 0;
  return (handMetric.cardW + 27*handMetric.step) * zoom; // 28 张（27 个叠放步进）
}

/* ---------- 出牌/不要/提示：钉在手牌右上方 ---------- */
function positionPlayBtns(){
  const row=document.querySelector('.handRow');
  const box=$('playBtns');
  const area=document.querySelector('.handArea');
  const hand=document.getElementById('hand');
  if(!row||!box||!area||!hand) return;
  const leftWithin=(el,stop)=>{ let x=0; for(let n=el; n && n!==stop; n=n.offsetParent) x+=n.offsetLeft; return x; };
  const topWithin=(el,stop)=>{ let y=0; for(let n=el; n && n!==stop; n=n.offsetParent) y+=n.offsetTop; return y; };
  const first=hand.querySelector('.hcard');
  const hasCards = !!first && hand.offsetWidth>0;
  let rightEdge;
  if(!hasCards && !handMetric){
    // 等待开局（从未发牌）：贴手牌行最右上方
    rightEdge = row.offsetWidth;
  } else if(row.classList.contains('handRowCompact')){
    // 紧凑：固定在手牌可视区右端（不随剩牌变化）
    rightEdge = leftWithin(area,row) + area.offsetWidth;
  } else {
    // 常规：按发牌时 28 张的右端固定，不随剩牌减少左移
    rightEdge = leftWithin(area,row) + area.offsetWidth/2 + fullHandWidth()/2;
  }
  rightEdge = Math.min(rightEdge, row.offsetWidth);
  box.style.right = Math.max(0, Math.round(row.offsetWidth - rightEdge)) + 'px';
  const cardsTop = hasCards ? topWithin(first,row) : 0;
  box.style.bottom = Math.round(row.offsetHeight - cardsTop + 6) + 'px';
}

/* ---------- 手牌行布局同步 ----------
 * 1) 窄屏或手牌+工具列放不下 → 紧凑模式（手牌横向滚动）
 * 2) 信息框、出牌按钮组随牌面位置/大小重新定位 */
function syncHandLayout(){
  const row=document.querySelector('.handRow');
  if(!row) return;
  layoutActionButtons();
  const hand=document.getElementById('hand');
  const tools=document.querySelector('.handTools');
  const w=row.clientWidth;
  const tw=tools?tools.offsetWidth:0;
  const fullW=fullHandWidth(); // 用发牌满手宽度判断，避免剩牌减少时布局跳动
  const compact = w>0 && (w<780 || (fullW>0 && fullW + 2*tw + 18 > w));
  row.classList.toggle('handRowCompact', compact);
  positionNorthTrick();
  positionSeatS();
  positionPlayBtns();
  positionMidBtns();
}
(function(){
  const row=document.querySelector('.handRow');
  const hand=document.getElementById('hand');
  if(window.ResizeObserver){
    const ro=new ResizeObserver(()=>syncHandLayout());
    if(row) ro.observe(row);
    if(hand) ro.observe(hand);
  }
  window.addEventListener('resize', ()=>setTimeout(syncHandLayout,120));
  window.addEventListener('orientationchange', ()=>setTimeout(syncHandLayout,350));
  setTimeout(syncHandLayout, 200);
})();

/* ---------- 按钮绑定 ---------- */
$('btnPlay').onclick=playerPlay;
$('btnPass').onclick=playerPass;
$('btnHint').onclick=playerHint;
$('btnSort').onclick=toggleSort;
$('btnSize').onclick=cycleCardSize;
$('btnVoice').onclick=toggleVoice;
if($('btnQuick')) $('btnQuick').onclick=playQuick;
if($('btnVoiceTone')) $('btnVoiceTone').onclick=cycleVoiceTone;
$('btnHard').onclick=playerHard;
initCardSize();
initVoice();
$('btnHe').onclick=playerHe;
$('btnClose').onclick=()=>{
  $('modal').hidden=true;
  // 非最后一局：点【下一局】自动就绪等全员；最后一局：不自动准备，需手动点【准备】
  if(!lastRoundWasLast) getNET().nextRound();
};
// 计分板右上角"关闭计分板"：点击即收起，露出牌桌（牌桌上另有"下一局"按钮）
(function(){
  const pk=$('btnPeek'); if(pk) pk.onclick=()=>{ $('modal').hidden=true; };
  const nx=$('btnNext'); if(nx) nx.onclick=()=>{ $('modal').hidden=true; if(!lastRoundWasLast) getNET().nextRound(); };
})();

/* ---------- 长按拖动一次选多张 + 点击桌面空白收回已选 ---------- */
(function(){
  const handEl=$('hand'); if(!handEl) return;
  const cardAt=(x,y)=>{ const el=document.elementFromPoint(x,y); return (el&&el.closest)?el.closest('.hcard'):null; };
  handEl.addEventListener('pointerdown',(e)=>{
    if(!G || mySeat<0 || G.seats[mySeat].out || G.ended) return;
    const cardEl = (e.target && e.target.closest) ? e.target.closest('.hcard') : null;
    if(!cardEl || !cardEl.dataset || cardEl.dataset.i===undefined) return;
    downInfo={idx:Number(cardEl.dataset.i), x:e.clientX, y:e.clientY, moved:false};
    try{ handEl.setPointerCapture(e.pointerId); }catch(_){}
  });
  handEl.addEventListener('pointermove',(e)=>{
    if(!downInfo) return;
    const dx=e.clientX-downInfo.x, dy=e.clientY-downInfo.y;
    if(!downInfo.moved && (Math.abs(dx)>6||Math.abs(dy)>6)){
      downInfo.moved=true;
      // 拖动开始：把按下的那张牌也纳入选中
      const sc=document.querySelector('.hcard[data-i="'+downInfo.idx+'"]');
      if(sc && !selected.has(downInfo.idx)){ selected.add(downInfo.idx); sc.classList.add('sel'); }
    }
    if(!downInfo.moved) return;
    const c=cardAt(e.clientX,e.clientY);
    if(c && c.dataset && c.dataset.i!==undefined){
      const idx=Number(c.dataset.i);
      if(!selected.has(idx)){ selected.add(idx); c.classList.add('sel'); }
    }
  });
  const endDrag=()=>{
    if(downInfo && downInfo.moved){
      clickSuppress=true; // 抑制随后的 click，避免拖完又切换选中
      setTimeout(()=>{ clickSuppress=false; }, 500);
    }
    downInfo=null;
  };
  handEl.addEventListener('pointerup',endDrag);
  handEl.addEventListener('pointercancel',endDrag);
  // 点击桌面任意空白处（非手牌/按钮/输入框）→ 收回已选牌
  const tableEl=document.querySelector('.table');
  if(tableEl) tableEl.addEventListener('click',(e)=>{
    const t=e.target;
    if(!t||!t.closest) return;
    if(t.closest('.hcard')||t.closest('button')||t.closest('input')) return;
    if(selected.size){ selected.clear(); render(); }
  });
})();
})();
