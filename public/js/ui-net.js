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
let seatAvatars = [];      // 服务器座位头像 URL（微信授权头像）
let seatTypes = [];        // 服务器座位类型 human/ai
let seatOffline = [];      // 服务器座位掉线标记
let seatReady = [];        // 服务器座位准备标记
let settings = {};         // 房间设置
let series = null;         // 轮结算累计
let seriesOver = false;    // 本场已结束（服务端保留 G，牌桌冻结，等玩家准备）
let aiAutoOn = false;      // 玩家自己开启的「AI出牌」代打
let aiAutoKey = '';        // 已经代打过的回合标识，防止同一回合重复出牌
let aiAutoTimer = null;
let aiFill = true;
let selected = new Set();
let hintCursor=0, hintList=[];
let sortMode=1; // 默认「炸前置」（0=点数，1=炸前置，2=牌型）
let lastRoundNo=-1; // 用于判断是否换了新局（换局才清空预选）
let lastRoundWasLast=false; // 当前结算的这局是否为一场的最后一局
// 结算弹窗延迟展示：局末先构建好计分板，3 秒后再弹出
const SETTLE_DELAY_MS=3000;
let settleSeq=null;       // 当前已排定的结算局（G.seq / G.roundNo）
let settleShown=false;    // 本局结算是否已经到时间展示过
let settleTimer=null;     // 延迟弹出计时器

let lastSettle=null, lastSettleSeq=0; // 局末结算（信息框外得分徽标用）
let cumTotals=[0,0,0,0];    // 客户端按局累计（规避服务器快照时序导致的"累计=0"）
let cumEndedSeq=0, resetPending=false;
let pendingPlay=false;      // 本次"出牌"是否已发送（成功后清空预选，失败保留）
let hintDblIdx=-1, hintDblAt=0; // 双击单牌快捷出牌的最近点击记录
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
  const bombSize=new Map(); // 归入炸弹时的实际张数（扣除已作五十K的）
  for(const c of hand){
    if(c.j){ kind.set(c.id, 2); continue; }
    if((c.r===R5||c.r===R10||c.r===RK) && used[c.r]<groups){ used[c.r]++; kind.set(c.id, 0); continue; }
    // 炸判定：用剩余张数（总张数 − 已被五十K 占用），而非总计数
    const remain=cnt[c.r]-(used[c.r]||0);
    if(remain>=4){ kind.set(c.id, 1); bombSize.set(c.id, remain); continue; }
    kind.set(c.id, 3);
  }
  return {cnt, kind, bombSize};
}
// 按牌型大类给每张牌分组（供"牌型"排序 sortMode=2）：0炸 1王 2五十K 3三个 4对子 5单个
function buildGroupMap(hand){
  const cnt=new Array(TS.RANKS.length).fill(0);
  for(const c of hand){ if(!c.j) cnt[c.r]++; }
  const groups=Math.min(cnt[R5],cnt[R10],cnt[RK]); // 最多能配几组五十K
  // 前 groups 张 5/10/K 打上"五十K"标记（三类同步各取其一）
  const isFifty=new Set();
  const gUsed={[R5]:0,[R10]:0,[RK]:0};
  for(const c of hand){
    if(!c.j && (c.r===R5||c.r===R10||c.r===RK) && gUsed[c.r]<groups){
      isFifty.add(c.id); gUsed[c.r]++;
    }
  }
  const g=new Map();
  for(const c of hand){
    if(c.j){ g.set(c.id,1); continue; }                    // 王：紧跟炸，位于三张牌型最左侧
    if(isFifty.has(c.id)){ g.set(c.id,2); continue; }      // 五十K 组
    const remain=cnt[c.r]-(gUsed[c.r]||0);                 // 此点其余分组剩余张数
    if(remain>=4){ g.set(c.id,0); continue; }              // 炸
    g.set(c.id, remain>=3?3:(remain>=2?4:5));              // 三个/对子/单个
  }
  return g;
}
function sortHandCards(){
  const hand = G ? G.seats[mySeat].hand : [];
  const {kind, bombSize}=buildKindMap(hand);
  const idx=hand.map((c,i)=>i);
  if(sortMode===0){
    idx.sort((a,b)=>{ const ka=handKey(hand[a]), kb=handKey(hand[b]); return ka-kb || (hand[a].id<hand[b].id?-1:1); });
    return idx;
  }
  if(sortMode===2){
    // 按牌型大类归拢：炸 → 王 → 五十K → 三个 → 对子 → 单个；同类内从大到小
    const groupMap=buildGroupMap(hand);
    idx.sort((a,b)=>{
      const ca=hand[a], cb=hand[b];
      const ga=groupMap.get(ca.id), gb=groupMap.get(cb.id);
      if(ga!==gb) return ga-gb;
      if(ga===1) return ca.id<cb.id?-1:1; // 王之间稳定排序
      return handKey(ca)-handKey(cb) || (ca.id<cb.id?-1:1);
    });
    return idx;
  }
  idx.sort((a,b)=>{
    const ca=hand[a], cb=hand[b];
    const ka=kind.get(ca.id), kb=kind.get(cb.id);
    if(ka!==kb) return ka-kb;
    if(ka===2) return ca.id<cb.id?-1:1;
    if(ka===0||ka===1){
      if(ka===0) return handKey(ca)-handKey(cb);
      const sa=bombSize.get(ca.id), sb=bombSize.get(cb.id);
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
  $('btnHint').disabled=!on; // 提示按钮：不隐藏，仅禁用（出牌轮一直可见）
  $('btnHard').style.display='none';
  $('btnHe').style.display='none';
}
function enablePlayer(){
  const mine = G && !G.ended && G.turn===mySeat;
  $('btnPlay').style.display = 'inline-block'; // 出牌轮恢复显示（确认轮隐藏）
  $('btnPlay').disabled = !mine;
  $('btnPass').style.display='inline-block'; // 确认轮隐藏过（表态后）则恢复
  $('btnPass').disabled = !mine || !G.lastPlay;
  $('btnPass').textContent = '不要';
  $('btnHard').disabled=false;
  $('btnHard').style.display='none';
  $('btnHe').style.display='none';
  $('btnHint').style.display='inline-block';
  $('btnHint').disabled = !mine;
}
function enableConfirm(){
  const seat=mySeat;
  $('btnPlay').style.display = 'none'; // 明独/不明独阶段不显示出牌
  // 已表态（明独/不明独）：操作按钮不再显示
  if(G.seats[seat] && G.seats[seat].choice){
    $('btnHe').style.display='none';
    $('btnHard').style.display='none';
    $('btnPass').style.display='none';
    $('btnHint').style.display='none';
    $('btnPlay').disabled=true;
    return;
  }
  $('btnHe').style.display = TS.handHasBomb(G.seats[seat].hand) ? 'none' : 'inline-block';
  $('btnHard').style.display='inline-block';
  $('btnHard').disabled=false;
  $('btnPass').style.display='inline-block';
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
  // 本地校验所选牌是否符合出牌规则；非法则中央提示，不发送
  const p=TS.analyzePlay(cards, G.cfg);
  if(!p) return flashMsg('所选的牌不合规则');
  if(G.lastPlay && !TS.canBeat(G.lastPlay,p)) return flashMsg('所选的牌不合规则');
  // 先发送，待成功后（广播轮到我下家）再清空预选；失败时保留选择便于调整
  pendingPlay=true;
  getNET().act({type:'play', seat:mySeat, cards});
}
function playerPass(force){
  if(!G) return;
  if(!force && voiceBusy){ flashMsg('语音播放中，请稍候…'); return; }
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
  if(hintList.length===0){
    flashMsg('没有能压的牌');
    // 已无牌可压：直接点击"不要"（无出牌权时提示也保持当前）——仅当能过牌时自动不要
    // force=true：过牌是被动动作，语音播放中也不阻塞（避免误报"语音播放中，请稍候"）
    if(G.lastPlay && G.turn===mySeat) playerPass(true);
    return;
  }
  // 提示优先级：同类型牌优先（同类中最小恰能压的在前），没有同类才用炸里最小的
  // kindOf = 牌型大类：普通牌按 type；炸按 tier（五十K/无番炸/番炸类），确保"同类"判断准确
  const kindOf = p => TS.isBomb(p) ? ('b'+TS.bombTier(p)) : p.type;
  const lb=G.lastPlay;
  hintList.sort((a,b)=>{
    const pa=a.play, pb=b.play;
    const sameA = lb ? kindOf(pa)===kindOf(lb) : true;
    const sameB = lb ? kindOf(pb)===kindOf(lb) : true;
    if(sameA!==sameB) return sameA?-1:1;
    return TSAI.playStrength(pa)-TSAI.playStrength(pb);
  });
  hintCursor=(hintCursor+1)%hintList.length;
  const cand=hintList[hintCursor];
  const ids=new Set(cand.cards.map(c=>c.id));
  selected.clear();
  G.seats[mySeat].hand.forEach((c,i)=>{ if(ids.has(c.id)) selected.add(i); });
  render();
  flashMsg(describeShort(cand.play));
}
function toggleSort(){ sortMode=(sortMode+1)%3; render(); }

/* ---------- 牌大小调节（本机偏好，手牌 + 桌面出牌统一缩放） ---------- */
// 整体上调两档：原「特大/巨无霸」成为新的「标准/大」
const CARD_SCALES=[1.24,1.4,1.6,1.8];
let cardSizeIdx=2; // 默认第三档「特大」
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
let lastRoundKey=null;  // 当前局标识（换局时重置状态）
const PASS_TAKES=['不要','不要2','不要3']; // 三种「不要」随机播
let lastPassSeq=0; // 上次播报的 passSeq（engine 每次"不要"递增，用于每次点击都播）
let prevKingPlayed=[false,false,false,false]; // 各家"已打出第一张王"上升沿（≥4王触发"报王"播报）
let prevSeatState=[{passed:false,choice:null,dizhi:false,out:false},{passed:false,choice:null,dizhi:false,out:false},
                   {passed:false,choice:null,dizhi:false,out:false},{passed:false,choice:null,dizhi:false,out:false}];
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
// 手动「生崽」（按钮原名为“快点”）：强制播放语音包里的 快点.m4a（不受语音开关/播报门控限制）
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
// 有番炸的播报：番数有笼数语音（Xlong）→ 直接报"N笼"；否则回退软滚/硬滚/滚笼
// 现有笼数语音：4/6/8/10/16/32/64/128/256
const FAN_LONG_TOKENS={4:true,6:true,8:true,10:true,16:true,32:true,64:true,128:true,256:true};
function fanBombSpeech(p){
  if(p.fan>0 && FAN_LONG_TOKENS[p.fan]){
    return {text:`${p.fan}笼`, tokens:[`${p.fan}long`]};
  }
  if(p.fan===1) return {text:'软滚', tokens:['软滚']};
  if(p.fan===2) return {text:'硬滚', tokens:['硬滚']};
  return {text:'滚笼', tokens:['滚笼']};
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
    case 'fiftyCage': return fanBombSpeech(p); // 五十K大炸：带番播报（软/硬/滚笼按番数）
    case 'bomb':
      // 4/5/6 张无番炸 → 「炸弹」；有番炸按番数/软硬选词
      if(p.fan===0) return {text:'炸弹', tokens:['炸弹']};
      return fanBombSpeech(p);
    case 'rollcage':
      return fanBombSpeech(p);
    case 'kingBomb': return {text:`${p.size}个王`, tokens:[`${p.size}-W`]};
    default: return null;
  }
}
// 出牌 / 不要 / 明独 / 不明独 / 插底：同一帧的事件合并成一句播报
function announceState(){
  if(!G) return;
  const rkey=G.seq||G.roundNo||0;
  if(rkey!==lastRoundKey){ lastRoundKey=rkey; lastPassSeq=0; }
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
    const cur={ passed:!!s.passed, choice:s.choice||null, dizhi:!s.out && !!s.hand && s.hand.length===1, out:!!s.out };
    const prev=prevSeatState[i]||{passed:false,choice:null,dizhi:false,out:false};
    if(!voiceInit){
      if(cur.choice && cur.choice!==prev.choice){ const c=cur.choice==='mingdu'?'明独':'不独'; msgs.push({text:c,tokens:[c]}); }
      if(cur.dizhi && !prev.dizhi) msgs.push({text:'插底',tokens:['插底']});
      // 起到了 ≥4 王：该家第一次打出王时播报"报王"
      const kp = !!s.kingPlayed && (s.kings||0)>=4;
      if(kp && !prevKingPlayed[i]) msgs.push({text:'报王', tokens:['报王']});
      // 任意玩家出完最后一手牌：播报跑完提示音
      if(cur.out && !prev.out){
        msgs.push({text:'出完了',tokens:['出完']});
      }
    }
    // 首帧（voiceInit=true）也要同步记录报王状态，避免刷新重连后误判为"新报王"
    prevKingPlayed[i] = !!(s.kingPlayed && (s.kings||0)>=4);
    prevSeatState[i]=cur;
  }
  // 出牌轮"不要"：按 passSeq 计数差值播报（同一圈再次轮到点"不要"也必播）
  const ps=Number(G.passSeq)||0;
  if(!voiceInit && ps>lastPassSeq){
    const n=ps-lastPassSeq;
    for(let k=0;k<n;k++){
      const take=PASS_TAKES[Math.floor(Math.random()*PASS_TAKES.length)];
      msgs.push({text:'不要',tokens:[take]});
    }
  }
  lastPassSeq=ps;

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
    clearSettleTimer(); settleSeq=null; settleShown=false;
    selected.clear(); hintList=[]; lastRoundNo=-1; lastSettle=null; lastSettleSeq=0;
    cumTotals=[0,0,0,0]; cumEndedSeq=0; resetPending=false; pendingPlay=false;
    lastSpokenKey=''; // 换房间后允许重新播报
    lastEndedKey=null;
    prevRevealed=false;
    lastRoundKey=null;
    lastPassSeq=0;
    prevKingPlayed=[false,false,false,false];
    voiceInit=true;
    prevSeatState=[{passed:false,choice:null,dizhi:false,out:false},{passed:false,choice:null,dizhi:false,out:false},
                   {passed:false,choice:null,dizhi:false,out:false},{passed:false,choice:null,dizhi:false,out:false}];
  }
  G = snap.G || null;
  seriesOver = !!snap.seriesOver;
  seatNames = snap.seats.map(s=>s.name);
  seatAvatars = snap.seats.map(s=>s.avatar||'');
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
    // 未发牌：不显示排序/牌大小
    if($('btnSort')) $('btnSort').style.display='none';
    if($('btnSize')) $('btnSize').style.display='none';
    if($('btnNext')) $('btnNext').style.display='none';
    if($('btnSettle')) $('btnSettle').style.display='none';
    if($('btnAI')){ if(aiAutoOn) aiAutoSet(false); $('btnAI').style.display='none'; }
    if($('tableMsg')) $('tableMsg').textContent='';
    for(let k=0;k<4;k++){ const he=$('hint'+k); if(he) he.innerHTML=''; }
    renderSeatNames();
    renderReadyIndicators();
    setBtn(false);
    // 未开局恢复出牌轮按钮的显隐与文字（确认轮曾隐藏）
    $('btnPlay').style.display='inline-block';
    $('btnHint').style.display='inline-block';
    $('btnPass').style.display='inline-block';
    $('btnPass').textContent='不要';
    // 准备按钮居中（此时 G 为空，btnReady 挪到中间位置）
    layoutActionButtons();
    positionMidBtns();
    return;
  }
  // 发牌后显示排序/牌大小
  if($('btnSort')) $('btnSort').style.display='inline-block';
  if($('btnSize')) $('btnSize').style.display='inline-block';
  // AI出牌按钮：房主在“对局配置”里允许后才出现
  if($('btnAI')){
    if((!settings.aiAuto || seriesOver) && aiAutoOn) aiAutoSet(false);
    $('btnAI').style.display = (settings.aiAuto && !seriesOver) ? 'inline-block' : 'none';
  }
  if($('lblMode')) $('lblMode').textContent = G.mode==='hard'?('硬牌 · '+seatNames[G.hardSeat]):'2V2';
  // 结算弹窗：局末先静默构建计分板，3 秒后再显示
  if(G.ended){
    const rk=G.seq||G.roundNo;
    const shouldShow=!!(G.lastSeries || !seatReady[mySeat]);
    if(shouldShow){
      if(settleSeq!==rk){ settleSeq=rk; settleShown=false; clearSettleTimer(); }
      finishLocal(); // 只填充表格，不在这里弹出
      if(!settleShown) scheduleSettleModal(rk, !!G.lastSeries);
    } else {
      clearSettleTimer();
      settleShown=false;
      $('modal').hidden = true;
    }
  } else {
    clearSettleTimer();
    settleSeq=null;
    settleShown=false;
    $('modal').hidden = true;
  }
  render();
  announceState();
  aiAutoMaybePlay(); // 开了 AI代打：轮到我就自动出牌
  // 牌桌上的"下一局"按钮：仅本局结束后显示（关闭计分板后也能进入下一局）
  if($('btnNext')) $('btnNext').style.display = (G && G.ended && !seriesOver) ? 'inline-block' : 'none';
  // 按钮：确认轮 / 出牌轮
  if(G.ended){
    setBtn(false);
    // 局末：出牌 / 提示 / 不要 / 牌大小 四个按钮不再显示
    ['btnPlay','btnHint','btnPass','btnSize'].forEach(id=>{ const b=$(id); if(b) b.style.display='none'; });
    return;
  }
  if($('btnSettle')) $('btnSettle').style.display='none';
  if(G.confirming){
    setBtn(false);
    // 明独/不明独阶段：不显示“出牌/提示”，只保留表态按钮
    $('btnPlay').style.display='none';
    $('btnHint').style.display='none';
    // 仅轮到我且未表态时才显示表态按钮（"不要"不会在中间出现）
    if(G.turn===mySeat && !(G.seats[mySeat] && G.seats[mySeat].choice)) enableConfirm();
    else { $('btnPass').style.display='none'; $('btnHard').style.display='none'; }
  }
  else {
    setBtn(false);
    // 出牌轮恢复“出牌/提示/不要”，避免沿用确认轮的文字和显隐
    $('btnPlay').style.display='inline-block';
    $('btnHint').style.display='inline-block';
    $('btnPass').style.display='inline-block';
    $('btnPass').textContent='不要';
    if(G.turn===mySeat) enablePlayer();
  }
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
// 头像：有微信头像时显示图片，否则显示文字（昵称首字/庄标）
function paintAvatar(av, url, label){
  if(!av) return;
  // 保留已加载的同 URL 图片，避免每次快照重绘都重新请求/闪烁
  const old=av.querySelector('img.avImg');
  const keep=(url && old && old.getAttribute('src')===url) ? old : null;
  av.innerHTML='';
  av.classList.toggle('hasAv', !!url);
  if(url){
    const img=keep || document.createElement('img');
    if(!keep){
      img.className='avImg'; img.alt=''; img.referrerPolicy='no-referrer';
      img.src=url;
    }
    img.onerror=()=>{ img.remove(); av.classList.remove('hasAv'); };
    av.appendChild(img);
  }
  if(label){
    const sp=document.createElement('span');
    sp.className='avTxt'; sp.textContent=label;
    av.appendChild(sp);
  }
}
// 仅渲染座位名字（未开局也可显示各玩家昵称 + 准备/掉线状态）
function renderSeatNames(){
  const realOf = v => (mySeat + v) % 4;
  for(let v=0;v<4;v++){
    const i=realOf(v);
    const isHuman = seatTypes[i]==='human';
    const nm=$('nm'+v);
    if(nm){
      if(isHuman){
        // 真人座位：信息框只显示昵称/掉线；准备状态显示在各自牌桌上
        nm.textContent = (seatNames[i]||(''));
        if(snapSeatOffline(i)) nm.textContent += ' ⚠️掉线';
      } else {
        // AI 空位：玩家进入前不显示 A/B/C/D 家
        nm.textContent = '';
      }
    }
    // 未开局：显示微信头像；无头像时用昵称首字兜底
    const av=$('av'+v);
    paintAvatar(av, isHuman?seatAvatars[i]:'', isHuman?((seatNames[i]||'').trim().charAt(0)):'');
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
  // 庄家标记已放到头像圆圈里（"庄"字），信息框 tag 不再显示"老板"
  return '';
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
    // 4+ 王信息显示在头像上；头像圆圈不显示东南西北字，庄家（老板）圆圈里显示"庄"
    const av=$('av'+v);
    if(av){
      const firstChar=((seatNames[i]||s.name||'').trim().charAt(0));
      const avLabel=(i===G.landlord && G.mode!=='hard') ? '庄' : (seatAvatars[i] ? '' : firstChar);
      paintAvatar(av, seatAvatars[i], avLabel);
      if(s.kingPlayed && s.kings>=4){
        const badge=document.createElement('span');
        badge.className='kingBadge';
        badge.textContent='>4王';
        av.appendChild(badge);
      }
    }
    // 明鸡牌小卡：始终显示在叫牌方（庄家）tag 上（明鸡出/跑/局中都不消失）；队友 tag 不显示。
    // 本家（南）不放在 tag 里 —— 会把信息框撑高、压到左边西家；改放到信息框右侧的 hint 区。
    const isCaller = (G.mode!=='hard' && G.called && i===G.landlord);
    const calledCardHtml = isCaller ? '<span class="calledMini">' + cardHTML({j:false,r:G.called.r,s:G.called.s},'mini') + '</span>' : '';
    const calledMiniHtml = (isCaller && v!==0) ? calledCardHtml : '';
    // 其他三家的叫牌卡改为绝对定位浮在信息框右侧，不参与文字行高；右侧留出通道给它
    if(el) el.classList.toggle('hasCalled', !!(isCaller && v!==0));
    if(G.mode!=='hard' && G.revealed){
      // 头像圆圈颜色：庄家红 + 出明鸡牌的也红 → teamA；其余两家蓝 → teamB
      el.classList.toggle('teamA', (i===G.landlord||i===G.partner));
      el.classList.toggle('teamB', (i!==G.landlord&&i!==G.partner));
      el.classList.remove('plain');
      $('tag'+v).innerHTML = seatTag(i) + calledMiniHtml;
    } else {
      // 明鸡未出（或是硬牌局）：庄家红（teamA），其他三家灰（plain）
      el.classList.toggle('teamA', i===G.landlord);
      el.classList.toggle('teamB', false);
      el.classList.toggle('plain', G.mode!=='hard' && i!==G.landlord);
      $('tag'+v).innerHTML = seatTag(i) + calledMiniHtml;
    }
    const pEl=$('p'+v); if(!pEl) continue;
    const rollN=s.rollcages.length;
    const rollFan=s.rollcages.reduce((a,r)=>a+r.fan,0);
    pEl.textContent='';
    if(v!==0 && settings.showRemain) pEl.append(`手牌 ${s.hand.length} 张 · `);
    pEl.append('抓分 ');
    const caughtEl=document.createElement('span');
    caughtEl.className='caughtNum';
    caughtEl.textContent=s.caught;
    pEl.append(caughtEl);
    pEl.append(
      // 跑完：其打出的带番炸已生效，直接显示已得番数
      (s.out
        ? (` · 得${rollFan}笼`)
        : (rollN>0?(` · 已打${rollFan}笼`):''))+
      // 信息框里不再显示“一游/二游…”（名次在牌桌提示和计分板里已有）
      (G.mode==='hard'&&i===G.hardSeat?' · 硬牌':'')
    );
    // 其他玩家手牌背面（自己的手牌在手牌区渲染）
    if(v!==0){
      const h=$('h'+v); h.innerHTML='';
      if(s.out){
        // 已跑完：手牌已空，不显示背面牌堆
      } else if(G.ended){
        // 局末：剩余牌改到牌桌上摊开，这里放同数量的透明占位牌。
        // 目的：信息框宽度不因“背面牌堆消失”而变窄，否则 positionSideTricks() 会把两侧出牌区内移，整个牌桌跳一下。
        h.classList.remove('remainStack');
        const shown = settings.showRemain ? s.hand.length : 5;
        const n = Math.min(shown, 15);
        for(let k=0;k<n;k++){ const d=document.createElement('div'); d.className='backCard ghost'; h.appendChild(d); }
        if(settings.showRemain && s.hand.length>15){
          const sp=document.createElement('span'); sp.className='ghost'; sp.textContent='+'+(s.hand.length-15); h.appendChild(sp);
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
    // 本家是庄家：叫牌小卡挂在信息框右侧（不占信息框高度）
    if(hintEl && v===0 && calledCardHtml) hintEl.insertAdjacentHTML('beforeend', calledCardHtml);
    const makeAlert=()=>{
      const w=document.createElement('span');
      w.className='warnDizhi';
      w.innerHTML='<span class="icon">!</span>';
      return w;
    };
    const addAlert=()=>{
      if(!hintEl) return;
      const d=document.createElement('div');
      d.appendChild(makeAlert());
      hintEl.appendChild(d);
    };
    const addPlace=()=>{
      if(!hintEl) return;
      const d=document.createElement('div');
      d.textContent=['一','二','三','四'][s.outOrder-1]+'游';
      d.style.cssText='color:#fff;font-size:17px;font-weight:bold;';
      hintEl.appendChild(d);
    };
    // 局末摊牌：没出完的牌当作一手牌摊到桌面上（替代原先塞在信息框里的缩略牌）。
    // 自己的牌仍在下方手牌区，这里只处理其余三家。
    if(G.ended && v!==0 && !s.out && s.hand && s.hand.length){
      // 牌序与手牌一致：王在前，其余按 2→3 从大到小
      const left=[...s.hand].sort((a,b)=> handKey(a)-handKey(b) || (a.id<b.id?-1:1));
      // 北家在正上方：横向空间最宽，全部排成一行，避免向下压到中间提示；
      // 东西两侧窄，每行 7 张
      const ROW = v===2 ? left.length : 7;
      const rows = Math.ceil(left.length/ROW);
      for(let ri=0; ri<rows; ri++){
        const row=document.createElement('div');
        row.className='trickRow remainDesk';
        left.slice(ri*ROW,(ri+1)*ROW).forEach(c=>{
          row.insertAdjacentHTML('beforeend', cardHTML(c,'mini'));
        });
        tr.appendChild(row);
      }
    } else if(i===G.turn && !G.ended){
      // 轮到该家：不显示任何占位符（插底提示在末尾统一追加）
    } else if(s.choice){
      const d=document.createElement('div');
      d.textContent = s.choice==='mingdu' ? '明独' : '不明独';
      d.style.cssText = s.choice==='mingdu'
        ? 'color:#ffe9b0;font-size:19px;font-weight:bold;padding:8px 0;'
        : 'color:#ffe9b0;font-size:18px;font-weight:bold;padding:8px 0;';
      tr.appendChild(d);
    } else if(s.passed){
      const d=document.createElement('div'); d.textContent='不要'; d.style.cssText='color:#ffe9b0;font-size:21px;font-weight:bold;padding:8px 0;'; tr.appendChild(d);
    } else if(s.lastCards&&s.lastCards.length){
      // 出到桌面的牌按点数理顺展示（不改变实际牌，仅排列顺序）：王放最后，其余按 3->2 升序
      const deskCards=[...s.lastCards].sort((a,b)=>{
        if(a.j&&b.j) return a.id-b.id;
        if(a.j) return 1;
        if(b.j) return -1;
        return a.r-b.r || a.id-b.id;
      });
      // 南/北在桌面上下方，横向空间足够：所有牌叠放在同一排，不换行；
      // 东/西在两侧，仍按每排 7 张分行。
      const ROW = (v===0 || v===2) ? deskCards.length : 7;
      const rows=Math.ceil(deskCards.length/ROW);
      const pPlay=TS.analyzePlay(s.lastCards);
      const showFan = pPlay && (pPlay.type==='rollcage'||pPlay.type==='kingBomb'||(pPlay.type==='bomb'&&pPlay.fan>0)||pPlay.type==='fiftyCage');
      for(let ri=0;ri<rows;ri++){
        const row=document.createElement('div'); row.className='trickRow';
        deskCards.slice(ri*ROW,(ri+1)*ROW).forEach(c=>{
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
    // 插底提示始终显示（本局结束或该玩家已跑完才消失），固定在原来的座位提示位置
    if(!G.ended && isDizhi) addAlert();
  }
  // 中间提示不再显示“轮到谁”
  const msg=$('msg');
  if(!G.ended){
    msg.textContent = G.mode!=='hard'
      ? (G.revealed ? `对家已明：${seatNames[G.partner]}` : `对家未明（叫牌 ${TS.cardName(G.called)}）`)
      : `${seatNames[G.hardSeat]} 硬牌 1打3`;
  } else msg.textContent = seriesOver ? '本场结束' : '本局结束';
  renderCorner();
}
function renderCorner(){
  const c=$('corner'); if(!c) return;
  // 房主可在「对局配置」里开启该信息框（默认不显示）；显示当前牌局设置
  const show=settings.showCorner === true;
  c.style.display = show ? 'flex' : 'none';
  // 同步给牌桌：信息框隐藏时，标题/房间号/我是谁 靠左，不占用信息框的位置
  const table=c.closest ? c.closest('.table') : document.querySelector('.table');
  if(table) table.classList.toggle('cornerOn', show);
  c.innerHTML='';
  const mkChip=(label,val)=>`<div class="cornerRow"><span style="color:#a8c8b8">${label}</span><b>${val||'—'}</b></div>`;
  c.innerHTML += mkChip('局数', `${settings.rounds||1} 局`);
  c.innerHTML += mkChip('王总数', `${settings.kings||8} 个`);
  c.innerHTML += mkChip('王单出', settings.jokerValue===2 ? '算 2' : '算 3');
  c.innerHTML += mkChip('半边', `${settings.halfFan||1} 分`);
  c.innerHTML += mkChip('笼数封顶', settings.fanCap ? `${settings.fanCap} 笼` : '不封顶');
  c.innerHTML += mkChip('尾游', settings.tailBonus ? '有奖金' : '无奖金');
}
function cardHTML(c,cls){
  if(c.j) return `<div class="card jk ${cls||''}"><span class="tl">王</span><span class="br">王</span><span class="ctr">王</span></div>`;
  const red=(c.s===1||c.s===3)?' red':'';
  const rn=TS.RANKS[c.r], ch=TS.SUIT_CH[c.s];
  // “10”是两个字符，角标比其他点数宽，叠牌时容易被相邻牌盖住 → 压窄数字，左上角再整体往左挪一点
  const isTen = rn==='10';
  const ten = isTen ? ' ten' : '';
  return `<div class="card${red} ${cls||''}">`+
    `<span class="tl${isTen?' tlten':''}"><span class="rk${ten}">${rn}</span><br>${ch}</span>`+
    `<span class="br"><span class="rk${ten}">${rn}</span><br>${ch}</span>`+
    `<span class="ctr">${ch}</span></div>`;
}
function renderHand(){
  const handEl=$('hand'); handEl.innerHTML='';
  if(!G||mySeat<0){ return; }
  const s=G.seats[mySeat];
  if(s.out){
    if(G.ended) return; // 本局已结束：桌面不再显示“已出局”
    let show=null;
    if(G.mode!=='hard'){
      // 2V2 有两支队伍：庄家队（庄家+明鸡）和另外两名玩家。
      // 之前只处理了庄家队，非庄家队的玩家跑完后找不到队友，会误显示“已跑完”。
      const mate=TS.teamOf(G,mySeat).find(i=>i!==mySeat);
      if(mate!=null) show=mate;
    }
    if(show!=null && !G.seats[show].out){
      const hs=G.seats[show];
      // 提示文字放在牌的正上方、靠右；明鸡已出才点名，未明时只说"队友牌"，避免提前泄露身份
      const wrap=document.createElement('div');
      wrap.className='mateHand';
      const cap=document.createElement('div');
      cap.className='mateCap';
      cap.textContent = G.revealed ? `队友 ${seatNames[show]} 的手牌` : '队友牌';
      wrap.appendChild(cap);
      const row=document.createElement('div');
      row.className='mateCards';
      renderCardFan(row, hs.hand, show);
      wrap.appendChild(row);
      handEl.appendChild(wrap);
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
    // 仅明鸡（队友）手里那张叫牌才标记；庄家（叫牌人）自己的不标
    if(G.mode!=='hard' && G.called && mySeat===G.partner && !c.j && c.r===G.called.r && c.s===G.called.s) cls+=' calledMark';
    el.className=cls;
    el.dataset.i=idx;
    el.innerHTML=cardHTML(c);
    // 双击同一张单牌且能压过上家 → 直接出牌作为快捷方式
    el.onclick=()=>{
      if(G.ended) return;
      if(clickSuppress){ clickSuppress=false; return; } // 拖动手势后的 click 不再切换
      // 双击记录必须在点击时更新；不能放在渲染时，否则拿到的是过期状态
      const now=Date.now();
      const dbl = (hintDblIdx===idx) && (now-hintDblAt>=0) && (now-hintDblAt<350);
      hintDblIdx=idx; hintDblAt=now;
      const mySeatState=G.seats[mySeat];
      if(dbl && G.turn===mySeat && mySeatState && !mySeatState.out && !G.confirming){
        // 双击单张：仅当是合法单牌且能压过上家时直接出
        const p=TS.analyzePlay([c], G.cfg);
        if(p && p.type==='single' && (!G.lastPlay || TS.canBeat(G.lastPlay,p))){
          selected.clear();
          mySeatState.hand.forEach((x,i)=>{ if(x.id===c.id) selected.add(i); });
          playerPlay();
          hintDblIdx=-1; hintDblAt=0; // 防止第三击再次触发
          return;
        }
      }
      if(selected.has(idx)) selected.delete(idx); else selected.add(idx);
      el.classList.toggle('sel',selected.has(idx));
    };
    handEl.appendChild(el);
  });
  const btn=$('btnSort'); if(btn) btn.textContent = '排序';
}
function renderCardFan(handEl, cards, forSeat){
  const order=[...cards].sort((a,b)=>handKey(a)-handKey(b));
  order.forEach(c=>{
    const el=document.createElement('div');
    let cls='hcard';
    // 仅明鸡（队友）拿着的那张叫牌才标记；庄家自己的叫牌不标
    if(G.mode!=='hard' && G.called && forSeat===G.partner && !c.j && c.r===G.called.r && c.s===G.called.s) cls+=' calledMark';
    el.className=cls;
    el.innerHTML=cardHTML(c);
    handEl.appendChild(el);
  });
}
function renderCenter(){
  const el=$('trickScore');
  el.textContent='';
  el.append('本轮分数 ');
  const num=document.createElement('span');
  num.className='scoreNum';
  num.textContent=G.trickPoints;
  el.append(num, ' 分');
  // 中间不再显示“谁压着”
  // 房间号右侧同步一份：对家信息 + 本轮分数，字号更大，方便一眼看到
  const tm=$('tableMsg');
  if(tm){
    const m=$('msg');
    const head=(m && m.textContent) ? m.textContent : '';
    tm.innerHTML = (head ? `<span class="m1">${head}</span>` : '') +
      `<span class="m2">本轮分数 <b>${G.trickPoints}</b> 分</span>`;
  }
}
function describeShort(p){
  if(p.type==='rollcage') return `滚笼 ${p.s}×${p.k}（${p.soft?'软':'硬'} ${p.fan} 笼）`;
  if(p.type==='bomb') return `${p.size} 张炸（${p.fan} 笼）`;
  if(p.type==='fiftyK') return p.tonghua?'五十K（同花）':'杂五十K';
  if(p.type==='fiftyCage') return `五十K大炸 ${p.t}张×3（${p.soft?'软':'硬'} ${p.fan} 笼）`;
  if(p.type==='kingBomb') return `王炸（${p.fan} 笼）`;
  return p.type;
}

/* ---------- 结算（服务器已算出结果，仅本地展示） ---------- */
// 牌面笼数（基础笼，单位=番）：半笼=0.5；带符号（赢队+，输队-）
function baseCageOf(st,i){
  const sign=st.winnerSeats.includes(i)?1:-1;
  // 硬牌：硬牌者收三家各 2 番＝6 番，三家各输 2 番
  if(st.mode==='hard') return (i===st.hardSeat?6:2)*sign;
  return st.basePer*sign; // 半番×输方没跑人数
}
function teamDotHtml(i){
  // 身份列：红/绿圆圈标识队伍（庄队绿、客队红；硬牌＝硬牌者绿、三家红）
  const green = G.mode==='hard' ? (i===G.hardSeat) : (i===G.landlord||i===G.partner);
  return `<span class="teamDot ${green?'g':'r'}"></span>`;
}
// 奖金净额（王奖/硬炸奖，单位=笼）：我是获奖者从三家各收 → +奖×3；每有他人获奖我付一份 → −奖。
// 不依赖 perSeatNoBonus 减法，旧版/新版 engine 都正确（修复旧缓存下奖金恒 0 的问题）
function bonusNetOf(s,i){
  let net=0;
  for(let k=0;k<4;k++){
    const total=(s.kingBonus&&s.kingBonus[k]||0)+(s.bombBonus&&s.bombBonus[k]||0);
    if(!total) continue;
    if(k===i) net += total*3;
    else net -= total;
  }
  return net;
}
function clearSettleTimer(){
  if(settleTimer){ clearTimeout(settleTimer); settleTimer=null; }
}
// 局末延迟 3 秒再显示计分板；最后一局即使 G 已被服务端清空也要弹
function scheduleSettleModal(rk, isLast){
  if(settleTimer) return;
  settleTimer=setTimeout(()=>{
    settleTimer=null;
    settleShown=true;
    const sameRound = !!(G && G.ended && (G.seq||G.roundNo)===rk);
    if(isLast || (sameRound && !seatReady[mySeat])){
      const md=$('modal');
      if(md) md.hidden=false;
    }
  }, SETTLE_DELAY_MS);
}
function finishLocal(){
  try{
    const s=TS.settleRound(G);
    const tb=$('mTable');
    // 是否本场最后一局：由服务器标记（避免客户端根据已累计的局数猜错）
    lastRoundWasLast = !!G.lastSeries;
    // 标题右侧直接带局数：（第2局/共3局）
    const roundTxt = `（第${G.roundNo||1}局/共${settings.rounds||1}局）`;
    $('mTitle').textContent = `${lastRoundWasLast?'本场结束':'本局结束'} · ${G.mode==='hard'
      ? `硬牌者 ${seatNames[G.hardSeat]} ${s.winnerSeats.includes(G.hardSeat)?'胜':'败'}`
      : `赢${s.winnerSeats.map(i=>seatNames[i]).join('、')}`}${roundTxt}`;
    const close=$('btnClose');
    if(close) close.textContent = lastRoundWasLast ? '本场结束' : '下一局';
    tb.innerHTML=`<tr><th>名字</th><th>顺序</th><th>身份</th><th>抓分</th><th>牌面笼数</th><th>滚笼</th><th>奖金</th><th>本局(分)</th><th>本场(分)</th></tr>`;
    for(let v=0;v<4;v++){
      const i=(mySeat+v)%4, fv=s.perFen[i];
      const bs=baseCageOf(s,i);              // 牌面笼数（番，带符号，半笼=0.5）
      const cageC = (s.perSeatNoBonus?.[i]??s.perSeat[i])-bs; // 滚笼（不含奖金的差额）
      const bonusC = bonusNetOf(s,i); // 奖金净额（王奖/硬炸奖），单位=笼
      const gs=G.seats[i];
      const place = gs.out ? ['一','二','三','四'][gs.outOrder-1]+'游' : '—';
      const kb = s.kingBonus&&s.kingBonus[i] ? `（王奖${s.kingBonus[i]}笼×3）` : '';
      const bb = s.bombBonus&&s.bombBonus[i] ? `（硬炸奖${s.bombBonus[i]}笼×3）` : '';
      // 抓分：优先用引擎归属后的值（尾游的抓分归对面队伍），旧缓存引擎回退到原始值
      const caughtVal = (s.effCaught && s.effCaught[i]!=null) ? s.effCaught[i] : gs.caught;
      tb.innerHTML+=`<tr><td>${seatNames[i]}</td>`+
        `<td>${place}</td><td>${teamDotHtml(i)}</td><td>${caughtVal}</td><td>${bs>0?'+':''}${bs}</td>`+
        `<td>${cageC>0?'+':''}${cageC}</td>`+
        `<td>${bonusC>0?'+':''}${bonusC}${kb}${bb}</td>`+
        `<td>${fv>0?'+':''}${fv}</td><td>${cumTotals[i]}</td></tr>`;
    }
    // 说明 + 轮累计
    const noteTxt = `牌面笼数 + 滚笼 + 奖金 = 本局分`;
    if(series && series.active && settings.rounds>1){
      tb.innerHTML+=`<tr><td colspan="9" class="note">${noteTxt} · 轮内第 ${series.roundCount}/${settings.rounds} 局 · 累计：${cumTotals.map((t,i)=>`${seatNames[i]} ${t>0?'+':''}${t}分`).join('  ')}</td></tr>`;
    } else {
      tb.innerHTML+=`<tr><td colspan="9" class="note">${noteTxt}</td></tr>`;
    }
    // 不在这里弹出：由 applyState 统一延迟 3 秒显示
  }catch(e){}
}

/* ---------- 日志 ---------- */
function log(msg){ const el=$('log'); const d=document.createElement('div'); d.textContent=msg; el.appendChild(d); el.scrollTop=el.scrollHeight; }
function flashMsg(m){ $('msg').textContent=m; }
function addLog(msg){ log(msg); }

/* ---------- 网络回调用（net.js 调用） ---------- */
window.GameUI = {
  applyState,
  setSelf(seat, names, types, aiOn, offArr, readyArr, avatars){
    mySeat=seat; seatNames=names||[]; seatTypes=types||[]; seatOffline=offArr||[]; seatReady=readyArr||[]; seatAvatars=avatars||[]; aiFill=aiOn!==undefined?aiOn:true;
  },
  setSeries(s){
    series = s || null;
    updateSeriesInfo();
  },
  addLog,
};

/* ---------- 东/西家出牌区：始终贴着各自信息框（随信息框宽度自适应） ---------- */
function positionSideTricks(){
  const table=document.querySelector('.table');
  const w=document.querySelector('.seatW'), e=document.querySelector('.seatE');
  const tw=document.getElementById('t3'), te=document.getElementById('t1');
  if(!table||!w||!e||!tw||!te) return;
  // 旋转兜底（landscapeCompat）也走同一套计算：offset* 是布局坐标，不受 #app 旋转影响，
  // 之前直接交给 CSS 的 180px 兜底会让东西家牌区离信息框约 70px，不够贴近。
  // CSS 里的 180px 仅作为 JS 执行前的初始兜底，随后会被这里的 inline 定位覆盖。
  const gap=6, tableW=table.clientWidth;
  // 西家：紧贴信息框右侧
  tw.style.left=(w.offsetLeft + w.offsetWidth + gap)+'px';
  tw.style.right='auto';
  // 东家：紧贴信息框左侧
  te.style.left='auto';
  te.style.right=(tableW - e.offsetLeft + gap)+'px';
}

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
  const mateHand=hand.querySelector('.mateHand');
  // 重算时机：
  //  - 还没开局（G 为空）：刚进房间时按当前布局定位
  //  - 自己正常握牌：跟随手牌位置
  //  - 出完牌后（显示队友手牌 / 局末空手牌）：保持上一位置，避免信息框上下跳动
  const keepPos = !!(G && (mateHand || !first));
  if(!keepPos || !info.style.bottom){
    let cardsTopInRow;
    if(first){
      cardsTopInRow = topWithin(first, row);
    } else {
      const pad=parseFloat(getComputedStyle(hand).paddingTop)||0;
      cardsTopInRow = topWithin(hand, row) + pad;
    }
    // 尽量贴近手牌：选中牌会向上浮 6*zoom，留 2px 余量即可，不再固定留 6px
    const z=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-zoom'))||1;
    const gap=Math.max(0, Math.round(6*z - 10));
    const bottom = Math.round(row.offsetHeight - cardsTopInRow + gap);
    info.style.bottom = bottom + 'px';
  }

  // 牌面开到最大档时手牌区更高，信息框跟着上移，会压到左边西家的信息框。
  // 真压上了就把本家信息框横向右移，避开西家这一列（高度不变，不影响别的定位）。
  info.style.left='';
  const west=document.querySelector('.seatW');
  // 竖屏旋转兜底时 #app 整体转了 90°，用屏幕坐标换算会错位，不用这套修正
  if(west && !document.body.classList.contains('landscapeCompat')){
    const rr=row.getBoundingClientRect(), ir=info.getBoundingClientRect(), wr=west.getBoundingClientRect();
    const overlap = ir.top < wr.bottom+4 && ir.left < wr.right+4 && ir.right > wr.left+4;
    if(overlap){
      const leftPx=Math.round(wr.right + 8 - rr.left);
      if(leftPx>32) info.style.left=leftPx+'px';
    }
  }
}

/* ---------- 明独/不明独：确认轮放在牌的中间；未开局准备按钮也居中 ---------- */
function layoutActionButtons(){
  const mid=$('midBtns'), right=$('playBtns'), ready=$('btnReady');
  const pass=$('btnPass'), hard=$('btnHard'), hint=$('btnHint');
  if(!mid||!right||!pass||!hard||!hint||!ready) return;
  if(!G || seriesOver){
    // 未开局 / 本场已结束：准备按钮放中间，出牌/表态按钮隐藏
    if(ready.parentElement!==mid) mid.appendChild(ready);
    return;
  }
  if(G.confirming){
    // 初始确认轮：仅当轮到我且未表态时，明独 + 不明独 放中间；否则不在中间显示
    const mayAct = G.turn===mySeat && !(G.seats[mySeat] && G.seats[mySeat].choice);
    if(mayAct){
      if(hard.parentElement!==mid) mid.appendChild(hard);
      if(pass.parentElement!==mid) mid.appendChild(pass);
    } else {
      if(hard.parentElement!==right) right.appendChild(hard);
      if(pass.parentElement!==right) right.appendChild(pass);
      hard.style.display='none';
      pass.style.display='none';
    }
  } else {
    // 出牌轮：出牌 + 提示 + 不要 放在牌的右上角（证明提示在前、不要在最后）
    if(hint.parentElement!==right) right.insertBefore(hint, pass);
    if(pass.parentElement!==right) right.appendChild(pass);
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
  // 尽量贴近手牌，但给选中牌的上浮（6*zoom）留 2px 余量
  const z2=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-zoom'))||1;
  const gap2=Math.max(0, Math.round(6*z2 - 10));
  box.style.bottom = Math.round(row.offsetHeight - cardsTop + gap2) + 'px';
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
  // 尽量贴近手牌，但给选中牌的上浮（6*zoom）留 2px 余量
  const z2=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-zoom'))||1;
  const gap2=Math.max(0, Math.round(6*z2 - 10));
  box.style.bottom = Math.round(row.offsetHeight - cardsTop + gap2) + 'px';
}

/* ---------- 手牌行布局同步 ----------
 * 1) 窄屏或手牌+工具列放不下 → 紧凑模式（手牌横向滚动）
 * 2) 信息框、出牌按钮组随牌面位置/大小重新定位 */
function syncHandLayout(){
  const row=document.querySelector('.handRow');
  if(!row) return;
  layoutActionButtons();
  const hand=document.getElementById('hand');
  const w=row.clientWidth;
  const fullW=fullHandWidth(); // 用发牌满手宽度判断，避免剩牌减少时布局跳动
  // 工具按钮已移到手牌上方，手牌行不再为右侧按钮列预留宽度
  const compact = w>0 && (w<780 || (fullW>0 && fullW + 18 > w));
  row.classList.toggle('handRowCompact', compact);
  positionSideTricks();
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

/* ---------- 全屏（进房自动尝试；未全屏显示“全屏”，全屏显示“退出全屏”） ---------- */
(function initFullscreen(){
  const b=$('btnFullscreen'); if(!b) return;
  const isMobile=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints>0 && window.innerWidth<1024);
  // App（Capacitor）本身已是沉浸式全屏 + 原生横屏锁，这组按钮没有意义
  const isNativeApp=!!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const fsEl=()=>document.fullscreenElement || document.webkitFullscreenElement || null;
  const apply=()=>{
    b.textContent=fsEl() ? '退出全屏' : '全屏';
    b.style.display=(isMobile && !isNativeApp) ? 'inline-block' : 'none';
  };
  // 全屏默认第四档（1.8），退出全屏回到第三档（1.6）
  const syncCardSizeForFullscreen=()=>{
    cardSizeIdx=fsEl()?3:2;
    applyCardSize();
  };
  const enterFullscreenIfMobile=()=>{
    if(!isMobile || isNativeApp || fsEl()) return;
    const el=document.documentElement;
    try{
      if(el.requestFullscreen){
        const p=el.requestFullscreen();
        if(p && p.catch) p.catch(()=>{});
      }else if(el.webkitRequestFullscreen){
        el.webkitRequestFullscreen();
      }
    }catch(e){}
  };
  window.enterGameFullscreen=enterFullscreenIfMobile;
  b.onclick=async()=>{
    if(!fsEl()){ enterFullscreenIfMobile(); return; }
    try{
      if(document.exitFullscreen) await document.exitFullscreen();
      else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
    }catch(e){}
    apply();
    syncCardSizeForFullscreen();
    setTimeout(()=>window.dispatchEvent(new Event('resize')), 200);
  };
  const onChange=()=>{ apply(); syncCardSizeForFullscreen(); setTimeout(()=>window.dispatchEvent(new Event('resize')), 200); };
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  // 进房时如果没有用户手势导致自动全屏失败，进桌后第一次触摸再尝试一次
  let tapTried=false;
  document.addEventListener('pointerdown',(e)=>{
    if(tapTried) return;
    // 第一次触摸就是全屏按钮时，交给按钮自身处理，避免 pointerdown 先进全屏、click 又退出；
    // 同时标记已处理，避免用户退出全屏后下一次普通点击又被自动拉回全屏
    if(isNativeApp) return;
    if(e.target && e.target.closest && e.target.closest('#btnFullscreen')){ tapTried=true; return; }
    const app=document.getElementById('app');
    if(!app || !app.classList.contains('inTable')) return;
    tapTried=true;
    if(!fsEl()) enterFullscreenIfMobile();
  }, true);
  apply();
})();
initCardSize();
initVoice();

/* ---------- AI 代打：房主在“对局配置”里允许后，玩家可一键让 AI 替自己出牌 ---------- */
function aiAutoSet(on){
  aiAutoOn=!!on;
  if(!aiAutoOn && aiAutoTimer){ clearTimeout(aiAutoTimer); aiAutoTimer=null; }
  const b=$('btnAI');
  if(b){
    b.textContent = aiAutoOn ? 'AI出牌中' : 'AI出牌';
    b.classList.toggle('gold', aiAutoOn);
  }
}
function aiAutoMaybePlay(){
  const stopTimer=()=>{ if(aiAutoTimer){ clearTimeout(aiAutoTimer); aiAutoTimer=null; } };
  // 不该代打时，撤销已排队的动作
  if(!aiAutoOn || !G || G.ended || mySeat<0){ stopTimer(); return; }
  const me=G.seats[mySeat];
  if(!me || me.out || G.turn!==mySeat || (G.confirming && me.choice)){ stopTimer(); return; }
  // 同一回合只代打一次：已经排过队就保留（不要因为一次重渲染把定时器清掉）
  const key=[G.seq||G.roundNo, G.playNo||0, G.turn, G.confirming?1:0].join(':');
  if(aiAutoKey===key) return;
  stopTimer();
  aiAutoKey=key;
  aiAutoTimer=setTimeout(()=>{
    aiAutoTimer=null;
    if(!aiAutoOn || !G || G.ended || G.turn!==mySeat || !window.NET) return;
    const st=G.seats[mySeat]; if(!st || st.out) return;
    if(G.confirming){
      if(st.choice) return;
      NET.act({type:'confirm', choice:'pass'}); // 代打一律不明独
      return;
    }
    if(!st.hand || !st.hand.length) return;
    let ch=null;
    try{ ch = window.TSAI ? window.TSAI.aiChoose(G, mySeat) : null; }catch(e){ ch=null; }
    if(ch && ch.cards && ch.cards.length) NET.act({type:'play', cards: ch.cards});
    else if(G.lastPlay) NET.act({type:'pass'});
  }, 800);
}
if($('btnAI')){
  $('btnAI').onclick=()=>{
    aiAutoSet(!aiAutoOn);
    if(aiAutoOn) aiAutoMaybePlay();
  };
}

$('btnHe').onclick=playerHe;
$('btnClose').onclick=()=>{
  $('modal').hidden=true;
  if($('btnSettle')) $('btnSettle').style.display='none';
  // 非最后一局：点【下一局】自动就绪等全员；最后一局：不自动准备，需手动点【准备】
  if(!lastRoundWasLast) getNET().nextRound();
};
// 计分板右上角"关闭计分板"：收起后，牌桌上出现【计分板】按钮（在【下一局】左侧），可重新打开
(function(){
  const showSettleBtn=on=>{ const b=$('btnSettle'); if(b) b.style.display=on?'inline-block':'none'; };
  const pk=$('btnPeek'); if(pk) pk.onclick=()=>{
    $('modal').hidden=true;
    if(G && G.ended) showSettleBtn(true);
  };
  const st=$('btnSettle'); if(st) st.onclick=()=>{
    $('modal').hidden=false;
    showSettleBtn(false);
  };
  const nx=$('btnNext'); if(nx) nx.onclick=()=>{
    $('modal').hidden=true;
    showSettleBtn(false);
    if(!lastRoundWasLast) getNET().nextRound();
  };
})();

/* ---------- 长按拖动一次选多张 / 取消选中 + 点击桌面空白收回已选 ---------- */
(function(){
  const handEl=$('hand'); if(!handEl) return;
  const cardAt=(x,y)=>{ const el=document.elementFromPoint(x,y); return (el&&el.closest)?el.closest('.hcard'):null; };
  // 切换一张牌的选中状态（滑动经过时，选中 ↔ 取消）
  const toggleSel=(idx, el)=>{
    if(selected.has(idx)){ selected.delete(idx); el.classList.remove('sel'); }
    else { selected.add(idx); el.classList.add('sel'); }
  };
  handEl.addEventListener('pointerdown',(e)=>{
    if(!G || mySeat<0 || G.seats[mySeat].out || G.ended) return;
    const cardEl = (e.target && e.target.closest) ? e.target.closest('.hcard') : null;
    if(!cardEl || !cardEl.dataset || cardEl.dataset.i===undefined) return;
    downInfo={idx:Number(cardEl.dataset.i), x:e.clientX, y:e.clientY, moved:false, seen:new Set()};
    try{ handEl.setPointerCapture(e.pointerId); }catch(_){}
  });
  handEl.addEventListener('pointermove',(e)=>{
    if(!downInfo) return;
    const dx=e.clientX-downInfo.x, dy=e.clientY-downInfo.y;
    if(!downInfo.moved && (Math.abs(dx)>6||Math.abs(dy)>6)){
      downInfo.moved=true;
      // 拖动开始：把按下的那张牌也纳入本次拖动（已选中的→取消）
      const sc=document.querySelector('.hcard[data-i="'+downInfo.idx+'"]');
      downInfo.seen.add(downInfo.idx);
      if(sc) toggleSel(downInfo.idx, sc);
    }
    if(!downInfo.moved) return;
    const c=cardAt(e.clientX,e.clientY);
    if(c && c.dataset && c.dataset.i!==undefined){
      const idx=Number(c.dataset.i);
      if(downInfo.seen.has(idx)) return;
      downInfo.seen.add(idx);
      toggleSel(idx, c);
    }
  });
  const endDrag=()=>{
    if(downInfo && downInfo.moved){
      // 抑制紧接着的那一次 click（浏览器会在 pointerup 后自动补发，需吞掉避免误切换/误双击）
      // 时间尽量短：click 在抬起后几毫秒即派发，150ms 足够覆盖，又不阻塞随后的正常点击
      clickSuppress=true;
      setTimeout(()=>{ clickSuppress=false; }, 150);
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
