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
// HTML 转义：昵称/房间号拼 innerHTML 前必须经过（服务端已白名单，前端双保险）
function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// 手牌数量统一口径：服务端脱敏后，对手手牌为 []（只带 handCount）；本家/观战队友牌仍是完整数组
function handCountOf(s){
  if(s && s.handCount != null) return s.handCount;
  return (s && s.hand) ? s.hand.length : 0;
}
// NET 在 net.js 加载后才就绪，运行时取用
const getNET = () => window.NET || { act(){}, nextRound(){} };

let G = null;              // 服务器下发的快照（权威）
let mySeat = -1;           // 我坐在第几号真实座位
let seatNames = [];        // 服务器房间座位名
let seatAvatars = [];      // 服务器座位头像 URL（微信授权头像）
let seatTypes = [];        // 服务器座位类型 human/ai
let seatOffline = [];      // 服务器座位掉线标记
let seatOfflineAt = [0,0,0,0]; // 服务器座位掉线时刻（ms，踢出按钮判断用）
let hostSeat = -1;         // 房主座位号（快照下发）
const KICK_WAIT_MS = 30000; // 掉线满此时长(ms)后，房主可踢（对应服务端 OFFLINE_KICK_WAIT_MS）
let seatReady = [];        // 服务器座位准备标记
let settings = {};         // 房间设置
let series = null;         // 轮结算累计
let seriesOver = false;    // 本场已结束（服务端保留 G，牌桌冻结，等玩家准备）
let earlyEnded = false;    // 本场系「提前结束」收场（局间共识收场）：局数/标题文案改「本场(已)提前结束」
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
let cumTotals=[0,0,0,0];    // 本场累计：镜像服务端 series.totals（服务端权威，刷新/重连不丢）
let cumEndedSeq=0;
let pendingPlay=false;      // 本次"出牌"是否已发送（成功后清空预选，失败保留）
let hintDblIdx=-1, hintDblAt=0; // 双击单牌快捷出牌的最近点击记录
// 拖动选牌：按下记录、移动判定、抬起后抑制随后的 click（避免拖动再切换）
let downInfo=null, clickSuppress=false;
let lastHandSig='';    // #26 手牌差量：视图签名未变则跳过重建（省去反复拼 28 张牌）
let renderCornerKey=''; // #26 信息框缓存：设置内容未变不重建
let boardCleared=false; // 点「准备/下一局」后清空上局牌桌，等新局（在牌桌上显示准备圆点）
let prevBoardCleared=false; // 上一帧的 boardCleared（用于「刚清桌」的一次性重置）
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
  if(window.TSAI) hintList=TSAI.genCandidates(G.seats[mySeat].hand, G.lastPlay||null, G.cfg);
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
    b.style.display = ('speechSynthesis' in window && zhVoices.length>1) ? 'inline-block' : 'none';
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
  if(p.type==='bomb'){
    // 单点番炸没有「N笼」词条（7张软=1、7硬/8软=2 …）：不许混报成滚笼，直接报「炸弹」
    return {text:`${p.fan}番炸`, tokens:['炸弹']};
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
    case 'kingBomb': {
      const kw = `${p.size}-W`;
      if(voicePack && voicePack.files && voicePack.files[kw]){
        return {text:`${p.size}个王`, tokens:[kw]};
      }
      // 语音包只配到 8-W：9~12 王兜底报「炸弹」，避免静音
      return {text:`${p.size}个王（王炸）`, tokens:['炸弹']};
    }
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
    const cur={ passed:!!s.passed, choice:s.choice||null, dizhi:!s.out && handCountOf(s)===1, out:!!s.out };
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
    cumTotals=[0,0,0,0]; cumEndedSeq=0; pendingPlay=false;
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
  window.__lastG = G; // 供联调工具读取（tests/cdp-mobile-check.js 的 enterRoom 检查 hasG）
  seriesOver = !!snap.seriesOver;
  earlyEnded = !!snap.earlyEnded; // 提前收场标记（服务端 finalizeEndSeries 置 true，startRound 清 false）
  // 点「准备/下一局」清空上局牌桌：新一局开始恢复桌面；我准备（场未结束）则清空并显示准备圆点
  if(G && !G.ended){
    boardCleared=false;
    try{ localStorage.removeItem('tsCleared'); }catch(e){} // 新一局开始：忘掉上一局的清桌标记
  } else if(G && G.ended){
    const clearKey = curRoomCode + ':' + (G.seq||G.roundNo);
    let saved=null;
    try{ saved=JSON.parse(localStorage.getItem('tsCleared')||'null'); }catch(e){}
    if(snap.ready && snap.ready[mySeat]){
      boardCleared=true;
      try{ localStorage.setItem('tsCleared', JSON.stringify({key:clearKey})); }catch(e){}
    } else if(saved && saved.key===clearKey){
      // 同房同局（seq 全局唯一）点过准备/下一局：中途退出/刷新/重连回来仍保持已清桌。
      // 不区分局末/场末——局末已清、随后共识提前收场成场末的「同一局」，清桌状态照样延续，
      // 刷新不再让已去掉的旧信息重现。
      boardCleared=true;
    } else if(G.seats[mySeat] && G.seats[mySeat].blanked){
      // 场末冻结房的新玩家（本人该座刚被服务端 blankGameSeatData 清残打标）：
      // 整桌按「刚进房间」显示；blanked 随服务端 G 持续，刷新/重进同样不再显示旧局信息。
      boardCleared=true;
    } else {
      boardCleared=false;
    }
  }
  // 刚点过准备/下一局：整桌残留（叫牌卡、4王、笼数、累计分…）一次性清干净
  if(boardCleared && !prevBoardCleared) clearBoardDom();
  prevBoardCleared = boardCleared;
  // 服务端脱敏：明鸡未公开前对家身份只对本人可见（youArePartner → 本人座位即对家）
  if(G && snap.youArePartner) G.partner = mySeat;
  seatNames = snap.seats.map(s=>s.name);
  seatAvatars = snap.seats.map(s=>s.avatar||'');
  seatTypes = snap.seats.map(s=>s.type);
  seatOffline = snap.seats.map(s=>!!s.offline);
  seatOfflineAt = snap.seats.map(s=>s.offlineAt||0);
  hostSeat = (snap.hostSeat!=null ? snap.hostSeat : -1);
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
  // 本场累计/徽标以服务端为准：series.totals 由服务端逐局累计（刷新/重连不丢），客户端只展示
  if(G && G.ended && roundKey!==cumEndedSeq) cumEndedSeq=roundKey;              // 记“本场已打过局”标志（徽标/计分板）
  if(G && !G.ended && !seriesOver && (!snap.series || snap.series.roundCount===0) && cumEndedSeq!==0){
    cumEndedSeq=0;                                                             // 新的一场已开始（首局进行中）：累计从零展示
  }
  cumTotals = (snap.series && snap.series.totals) ? snap.series.totals.slice() : [0,0,0,0];
  // 局末结算以服务端下发为准（snap.settle）；极早期 ended 帧未带 settle 时用全量 G 本地兜底（局末 G 已全公开，数值一致）
  if(G && G.ended){
    lastSettle = snap.settle || (function(){ try{ return TS.settleRound(G); }catch(e){ return lastSettle; } })();
  } else {
    lastSettle = null;
  }
  // 右上角二选一：场进行中显示「结束场次」（点击发起共识收场，AI 房同样适用），
  // 否则（场末/未开局）显示「退出房间」——退出仅在场结束后提供
  const lv=$('btnLeave'), esB=$('btnEndSeries');
  if(lv && esB){
    const inPlay = !!(G && !seriesOver);
    lv.style.display = inPlay ? 'none' : '';
    esB.style.display = inPlay ? 'inline-block' : 'none';
  }
  hintCursor=0; hintList=[];
  if(!G){
    // 未开局：更新房间信息 + 座位名，显示等待
    if($('lblMode')) $('lblMode').textContent='等待开局';
    if($('lblRound')) $('lblRound').textContent='';
    if($('msg')) $('msg').textContent='等待全员准备…';
    if($('btnAI')){ if(aiAutoOn) aiAutoSet(false); $('btnAI').style.display='none'; }
    if($('tableMsg')) $('tableMsg').textContent='';
    clearBoardDom(); // 未开局/提前收场：把上一局的叫牌卡、4王、笼数、累计分等全部清掉
    const _md=$('modal'); if(_md) _md.hidden=true; // 场末有人退出/收场后：旧计分板一起收起
    renderSeatNames();
    boardCleared=false;
    renderWaitingView(); // 空桌态：顶部条/按钮/出牌排/圆点全按「刚进房」（公共出口，见函数定义）
    renderKickButtons();
    return;
  }
  // 刚点过【准备】/【下一局】（本局已结束、G 仍冻结等全员就绪）：显示同「刚进房」的空桌态。
  // 桌面已在上面 609 行清过一次；这里不再按旧局信息重画/重播（render/播报/结算调度一并跳过）。
  // 覆盖：自然场末点【准备】、局末点【下一局】、提前收场（局间结束场次）冻结点【准备】。
  if(G && G.ended && boardCleared){
    renderWaitingView();
    renderKickButtons();
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
      finishLocal(lastSettle); // 只填充表格，不在这里弹出
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
  renderKickButtons(); // 未开场/场末：房主视角给掉线满 30s 的真人显示「踢出房间」
  if(G && G.ended && boardCleared) renderReadyIndicators(false); // 点过下一局、桌面清空后才显示各家准备状态
  // 场末计分板按钮兜底：本场结束且计分板弹窗未开时始终可见，可重开计分板
  if(G && G.ended && seriesOver){ const b=$('btnSettle'); if(b && $('modal').hidden) b.style.display='inline-block'; }
  announceState();
  aiAutoMaybePlay(); // 开了 AI代打：轮到我就自动出牌
  // 牌桌上的"下一局"按钮：仅本局结束后显示（关闭计分板后也能进入下一局）
  if($('btnNext')){
    $('btnNext').style.display = (G && G.ended && !seriesOver) ? 'inline-block' : 'none';
    // 局末已点过准备 → 按钮变成「取消准备」
    $('btnNext').textContent = (G && G.ended && seatReady[mySeat]) ? '取消准备' : '下一局';
  }
  // 按钮：确认轮 / 出牌轮
  if(G.ended){
    setBtn(false);
    layoutActionButtons(); // 场末：准备/计分板；局间：下一局/计分板 → 都放到出牌排（计分板在左）
    // 局末/场末：关闭计分板后，计分板按钮保留在出牌排（弹窗未开时可见），可重开
    const _stB=$('btnSettle'); if(_stB && $('modal').hidden) _stB.style.display='inline-block';
    // 局末：出牌 / 提示 / 不要 / 牌大小 四个按钮不再显示
    ['btnPlay','btnHint','btnPass','btnSize'].forEach(id=>{ const b=$(id); if(b) b.style.display='none'; });
    syncHandLayout(); // 提示（xx游/准备）出现后，两侧出牌区要让位重新定位
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
    // 我已出完（看队友手牌）：出牌/提示/不要 全部隐藏
    const meOut = !!G.seats[mySeat].out;
    // 出牌轮恢复“出牌/提示/不要”，避免沿用确认轮的文字和显隐
    $('btnPlay').style.display = meOut ? 'none' : 'inline-block';
    $('btnHint').style.display = meOut ? 'none' : 'inline-block';
    $('btnPass').style.display = meOut ? 'none' : 'inline-block';
    $('btnPass').textContent='不要';
    if(G.turn===mySeat && !meOut) enablePlayer();
  }
  voiceGate(); // 语音播报未结束时保持按钮禁用
  syncHandLayout(); // 按钮显隐/换容器后重新定位（明独/不明独居中）
}

/* ---------- 渲染 ---------- */
function render(){
  if(!G) return;
  // 局末结算由 applyState 从服务端 settle 维护（脱敏后不本地重算）；非局末清空
  if(!G.ended) lastSettle=null;
  renderSeats(); renderHand(); renderCenter(); renderTop();
  syncHandLayout();
}
function renderTop(){
  $('lblMode').textContent = G.mode==='hard'?('硬牌 · '+seatNames[G.hardSeat]):'2V2';
  // 局数直接用服务端下发的 G.roundNo：进行中即显示当前局，不再等本局结算后才 +1
  const total=settings.rounds||1;
  // 提前收场（局间共识收场，场末冻结）：局数文案改「本场提前结束」；其余（局中/局末/自然场末）照常第 x/y 局
  $('lblRound').textContent = (seriesOver && earlyEnded) ? '本场提前结束' : `第 ${G.roundNo||1}/${total} 局`;
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
// 点「准备/下一局」时把整张牌桌的残留一次性清干净（叫牌卡可能在任意一家的 tag 上）
function clearBoardDom(){
  for(let k=0;k<4;k++){
    ['t','h','hint'].forEach(pre=>{ const e=$(pre+k); if(e) e.innerHTML=''; });
    const tag=$('tag'+k); if(tag) tag.innerHTML='';
    const av=$('av'+k); if(av) av.querySelectorAll('.kingBadge').forEach(n=>n.remove());
    const seat=document.querySelector(`.seat[data-seat="${k}"]`);
    if(seat) seat.querySelectorAll('.cumSco,.roundSco').forEach(n=>n.remove());
    const pts=$('p'+k); if(pts) pts.textContent='';
  }
  const hand=$('hand'); if(hand) hand.innerHTML='';
  const ts=$('trickScore'); if(ts) ts.textContent='';
}
// 准备提示：场初放在各座位的出牌区；局末/场末改放信息框旁的 hint 区，
// 这样场末冻结的牌桌不会被清掉。
function renderReadyIndicators(inTrick){
  const realOf = v => (mySeat + v) % 4;
  for(let v=0;v<4;v++){
    const host = inTrick ? $('t'+v) : $('hint'+v);
    if(!host) continue;
    if(inTrick) host.innerHTML='';
    else host.querySelectorAll('.readyHint').forEach(n=>n.remove()); // 只清自己追加的，保留游/插底/叫牌
    const i=realOf(v);
    if(seatTypes[i]!=='human') continue; // AI 空位不显示
    const ready=!!seatReady[i];
    const d=document.createElement('div');
    d.className='readyHint';
    d.innerHTML=`<span class="readyDot ${ready?'on':'off'}"></span><span>${ready?'已准备':'未准备'}</span>`;
    host.appendChild(d);
  }
}
/* 空桌态渲染（=「刚进房/未开局」的展示：顶部条、按钮、出牌排、准备圆点）。
 * 用在两类帧：
 *   ① !G 帧（未开局/提前收场清残局）——原有行为不变；
 *   ② G.ended && boardCleared 帧（刚点过【准备】/【下一局】，等全员就绪）——
 *      此时 G 仍冻结，render() 会把旧局信息重画回来，这里在帧末统一覆盖成「刚进房」，
 *      并清掉旧局「庄」徽标残留。不碰 G / boardCleared 标志本身。 */
function renderWaitingView(){
  if($('lblMode')) $('lblMode').textContent='等待开局';
  if($('lblRound')) $('lblRound').textContent='';
  if($('msg')) $('msg').textContent='等待全员准备…';
  if($('tableMsg')) $('tableMsg').textContent='';
  if($('btnSort')) $('btnSort').style.display='none';
  if($('btnSize')) $('btnSize').style.display='none';
  if($('btnNext')) $('btnNext').style.display='none';
  if($('btnSettle')) $('btnSettle').style.display='none';
  if($('btnAI')) $('btnAI').style.display='none';
  setBtn(false);
  if($('btnPlay')) $('btnPlay').style.display='none';
  if($('btnHint')) $('btnHint').style.display='none';
  if($('btnPass')) $('btnPass').style.display='none';
  if($('btnPass')) $('btnPass').textContent='不要';
  // 准备按钮居中（此时无对局，btnReady 挪到中间位置）
  layoutActionButtons();
  positionMidBtns();
  // 冻结帧上旧局「庄」徽标还挂着头像圈：空桌态清点回名字首字（同刚进房，无庄标）
  for(let k=0;k<4;k++){
    const av=$('av'+k); if(!av) continue;
    const at=av.querySelector('.avTxt');
    if(at && /^庄/.test(at.textContent)) at.textContent = at.textContent.replace(/^庄/,'');
  }
  renderReadyIndicators(true); // 场初样式：准备圆点在出牌区
}
// 准备提示改由 renderReadyIndicators 显示在牌桌（出牌区）上：#13 座位徽标方案已弃用
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
// 座位行差量签名（renderSeats 重装跳过用）：renderSeats 每个座位读到的一切字段都进签名。
// 保守策略：宁可多刷，不可漏刷——漏刷=陈旧渲染（可见缺陷）；多刷只是回到无差量的原成本。
let lastSeatSig = ['', '', '', ''];
let prevTurn = -3; // 上一帧轮次座位：对局转移瞬间「当前/上一轮次」两座都要强制重装
function seatSig(v){
  const i = (mySeat + v) % 4;
  const s = G.seats[i];
  const c = G.called;
  const rc = s.rollcages || [];
  return [
    G.seq || G.roundNo, G.ended ? 1 : 0, G.mode, G.revealed ? 1 : 0, G.confirming ? 1 : 0,
    G.landlord, G.partner, G.hardSeat, c ? c.r + '.' + c.s : '',
    settings.showRemain ? 1 : 0, settings.rounds, cumEndedSeq,
    mySeat, boardCleared ? 1 : 0,
    seatNames[i], seatTypes[i], seatOffline[i] ? 1 : 0, seatAvatars[i],
    handCountOf(s),
    s.out ? (s.outOrder || 0) : 0,
    s.caught, s.choice || '', s.passed ? 1 : 0, s.kings, s.kingPlayed ? 1 : 0,
    rc.length > 0 ? rc.length + ':' + rc.reduce((a, r) => a + (r.fan || 0), 0) : 0,
    s.lastCards ? s.lastCards.map(x => x.id).join(',') : '',
    s.hand ? s.hand.map(x => x.id).join(',') : '',
    cumTotals[i]
  ].join('|');
}
// 未开场/场末：房主视角给「掉线满 30s 的真人」显示「踢出房间」按钮（牌桌前方）
function renderKickButtons(){
  document.querySelectorAll('.kickSeatBtn').forEach(n=>n.remove());
  if(mySeat<0 || hostSeat!==mySeat) return;   // 仅房主视角
  if(G && !G.ended) return;                    // 对局进行中不显示
  const realOf = v => (mySeat + v) % 4;
  for(let v=0;v<4;v++){
    const i=realOf(v);
    if(seatTypes[i]!=='human' || !seatOffline[i]) continue;
    if(Date.now() - (seatOfflineAt[i]||0) < KICK_WAIT_MS) continue;
    const el=document.querySelector('.seat[data-seat="'+v+'"]'); if(!el) continue;
    const b=document.createElement('button');
    b.className='kickSeatBtn';
    b.textContent='踢出房间';
    b.onclick=()=>{ if(window.NET && window.NET.kickSeat) window.NET.kickSeat(i); };
    el.appendChild(b);
  }
}
function renderSeats(){
  // 视图重排：自己的座位(real=mySeat)显示在下方(南位 view0)
  const realOf = v => (mySeat + v) % 4;
  for(let v=0;v<4;v++){
    const i=realOf(v);
    const s=G.seats[i];
    const el=document.querySelector(`.seat[data-seat="${v}"]`); if(!el) continue;
    // 新玩家入座场末空位：G 侧已 blanked —— 只画名字/头像的「刚进房间空座」，跳过对局信息
    if(s && s.blanked){
      const nmEl=$('nm'+v);
      if(nmEl) nmEl.textContent = (seatNames[i]||'空位').trim();
      paintAvatar($('av'+v), seatAvatars[i]||'', (seatNames[i]||'').trim().charAt(0));
      const tEl=$('tag'+v); if(tEl) tEl.innerHTML='';
      const pE=$('p'+v); if(pE) pE.textContent='';
      const tR=$('t'+v); if(tR) tR.innerHTML='';
      const hR=$('h'+v); if(hR) hR.innerHTML='';
      const hN=$('hint'+v); if(hN) hN.innerHTML='';
      el.classList.remove('teamA','teamB','plain','active','hasCalled');
      el.querySelectorAll('.cumSco,.roundSco').forEach(n=>n.remove()); // 上一帧该行残留的分数徽标一并收掉
      continue;
    }
    // —— 廉价段（每帧都执行）：纯 classList 翻转，无 DOM 重建 ——
    el.classList.toggle('active', G.turn===i && !G.ended);
    // 明鸡牌小卡：始终显示在叫牌方（庄家）tag 上（明鸡出/跑/局中都不消失）；队友 tag 不显示。
    // 本家（南）不放在 tag 里 —— 会把信息框撑高、压到左边西家；改放到信息框右侧的 hint 区。
    const isCaller = (G.mode!=='hard' && G.called && i===G.landlord);
    const calledCardHtml = isCaller ? '<span class="calledMini">' + cardHTML({j:false,r:G.called.r,s:G.called.s},'mini calledOnDesk') + '</span>' : '';
    const calledMiniHtml = (isCaller && v!==0) ? calledCardHtml : '';
    el.classList.toggle('hasCalled', !!(isCaller && v!==0));
    if(G.mode!=='hard' && G.revealed){
      // 头像圆圈颜色：庄家红 + 出明鸡牌的也红 → teamA；其余两家蓝 → teamB
      el.classList.toggle('teamA', (i===G.landlord||i===G.partner));
      el.classList.toggle('teamB', (i!==G.landlord&&i!==G.partner));
      el.classList.remove('plain');
    } else {
      // 硬牌局：硬牌玩家红（teamA）、其他三家蓝（teamB）；2V2 明鸡未出：庄家红，其他三家灰（plain）
      el.classList.toggle('teamA', G.mode==='hard' ? (i===G.hardSeat) : (i===G.landlord));
      el.classList.toggle('teamB', G.mode==='hard' && i!==G.hardSeat);
      el.classList.toggle('plain', G.mode!=='hard' && i!==G.landlord);
    }
    // —— 重型段（签名差量）：依赖没变且不在轮次转移两座上 → 整行跳过 ——
    const sig = seatSig(v);
    const rebuild = (i===G.turn || i===prevTurn) || sig !== lastSeatSig[v];
    if(rebuild) lastSeatSig[v] = sig;
    if(!rebuild) continue;
    const nm=$('nm'+v);
    nm.textContent = (seatNames[i]||s.name);
    if(seatTypes[i]==='ai' && !s.out && (seatNames[i]||s.name)!=='空位') nm.textContent += ' 🤖';
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
    // 叫牌小卡挂 tag（庄家座/明鸡相关；依赖字段都已在 seatSig 里）
    const tg=$('tag'+v); if(tg) tg.innerHTML = seatTag(i) + calledMiniHtml;
    const pEl=$('p'+v); if(!pEl) continue;
    // 点「准备」清空上局：保留座位名/头像，抓分、背面牌堆、出牌区全部清空等新局
    if(boardCleared){
      const tr=$('t'+v); if(tr) tr.innerHTML='';
      const hc=$('h'+v); if(hc) hc.innerHTML='';
      const he=$('hint'+v); if(he) he.innerHTML='';   // 叫牌小卡/游/插底一并清掉
      const tg=$('tag'+v); if(tg) tg.innerHTML='';    // 其他三家的叫牌小卡挂在 tag 上，这里也清掉
      const av=$('av'+v); if(av) av.querySelectorAll('.kingBadge').forEach(n=>n.remove()); // 4王标记
      el.querySelectorAll('.cumSco,.roundSco').forEach(n=>n.remove()); // 笼数/积分徽标
      pEl.textContent='';
      continue;
    }
    const rollN=s.rollcages.length;
    const rollFan=s.rollcages.reduce((a,r)=>a+r.fan,0);
    pEl.textContent='';
    if(v!==0 && settings.showRemain) pEl.append(`手牌 ${handCountOf(s)} 张 · `);
    pEl.append('抓分 ');
    const caughtEl=document.createElement('span');
    caughtEl.className='caughtNum';
    caughtEl.textContent=s.caught;
    pEl.append(caughtEl);
    pEl.append(
      // 跑完：其打出的带番炸已生效，直接显示已得番数
      // 笼数带色（.cageNum → --num）：append() 只认文本/元素节点，不能拼 HTML 字符串，
      // 否则页面会原样显示 <span…> 字面量；此处数字为服务端下发的纯数值，无注入面
      ...(()=>{
        const cage = (s.out || rollN>0)
          ? (()=>{ const sp=document.createElement('span'); sp.className='cageNum'; sp.textContent=rollFan; return sp; })()
          : null;
        const body = s.out ? [' · 得', cage, '笼'] : (rollN>0 ? [' · 已打', cage, '笼'] : []);
        body.push((G.mode==='hard'&&i===G.hardSeat) ? ' · 硬牌' : '');
        return body;
      })()
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
        const shown = settings.showRemain ? handCountOf(s) : 5;
        const n = Math.min(shown, 15);
        for(let k=0;k<n;k++){ const d=document.createElement('div'); d.className='backCard ghost'; h.appendChild(d); }
        if(settings.showRemain && handCountOf(s)>15){
          const sp=document.createElement('span'); sp.className='ghost'; sp.textContent='+'+(handCountOf(s)-15); h.appendChild(sp);
        }
      } else {
        h.classList.remove('remainStack');
        // 不显示剩余张数时：背面牌堆固定显示 5 张（隐藏真实数量，减小占地）
        const shown = settings.showRemain ? handCountOf(s) : 5;
        const n=Math.min(shown,15);
        for(let k=0;k<n;k++){ const d=document.createElement('div'); d.className='backCard'; h.appendChild(d); }
        if(settings.showRemain && handCountOf(s)>15){ const sp=document.createElement('span'); sp.textContent='+'+(handCountOf(s)-15); h.appendChild(sp); }
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
    const isDizhi = !s.out && handCountOf(s)===1;
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
      d.style.cssText='color:var(--num);font-size:17px;font-weight:normal;'; // x游：与「抓分 xx」数字同色、不加粗
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
        ? 'color:#fff;font-size:19px;font-weight:bold;padding:8px 0;'
        : 'color:#fff;font-size:18px;font-weight:bold;padding:8px 0;';
      tr.appendChild(d);
    } else if(s.passed){
      const d=document.createElement('div'); d.textContent='不要'; d.style.cssText='color:#fff;font-size:21px;font-weight:bold;padding:8px 0;'; tr.appendChild(d);
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
      const pPlay=TS.analyzePlay(s.lastCards, G.cfg);
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
  prevTurn = G.turn; // 记录上一帧轮次：对局转移瞬间「当前/上一轮次」两座在循环头里强制重装
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
  // #26 仅当设置内容变化时才重建 DOM（避免每次广播都刷信息框）
  const sk=JSON.stringify(settings);
  if(renderCornerKey!==sk){
    renderCornerKey=sk;
    c.innerHTML='';
    const mkChip=(label,val)=>`<div class="cornerRow"><span style="color:#a8c8b8">${label}</span><b>${val||'—'}</b></div>`;
    c.innerHTML += mkChip('局数', `${settings.rounds||1} 局`);
    c.innerHTML += mkChip('王总数', `${settings.kings||8} 个`);
    c.innerHTML += mkChip('王单出', settings.jokerValue===2 ? '算 2' : '算 3');
    c.innerHTML += mkChip('半边', `${settings.halfFan||1} 分`);
    c.innerHTML += mkChip('笼数封顶', settings.fanCap ? `${settings.fanCap} 笼` : '不封顶');
    c.innerHTML += mkChip('未跑奖', settings.tailBonus ? '可拿王奖' : '不拿');
  }
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
// #26 手牌视图签名：视图依赖数据没变就跳过重建（含出局观战队友牌）
function handViewSig(){
  const s=G.seats[mySeat];
  if(s.out){
    let mate=-1;
    if(!G.ended && G.mode!=='hard'){
      const m=(G._mate!=null)?G._mate:-1;
      if(m>=0 && !G.seats[m].out) mate=m;
    }
    return ['o', G.ended?'e':'-', mate,
            mate>=0?seatNames[mate]:'',
            (mate>=0&&G.revealed)?'r':'',
            mate>=0?G.seats[mate].hand.map(c=>c.id).join(','):''].join('|');
  }
  return ['i', sortMode, G.ended?'e':'i',
          [...selected].sort((a,b)=>a-b).join(','),
          s.hand.map(c=>c.id).join(',')].join('|');
}
function renderHand(){
  const handEl=$('hand');
  if(!G||mySeat<0){ if(handEl) handEl.innerHTML=''; return; }
  // 点「准备」后清空手牌区，等新局发牌
  if(boardCleared && G && G.ended){
    handEl.innerHTML='';
    const d=document.createElement('div'); d.textContent='已清空，等待新局…'; d.style.cssText='padding:24px;color:#a8c8b8;font-size:14px;';
    handEl.appendChild(d);
    return;
  }
  // #26 差量：手牌视图没变时直接复用现有 DOM（对手出牌等帧免去重拼 28 张牌）
  const sig=handViewSig();
  if(sig===lastHandSig && handEl && handEl.childNodes.length>0){ return; }
  lastHandSig=sig;
  handEl.innerHTML='';
  const s=G.seats[mySeat];
  if(s.out){
    if(G.ended) return; // 本局已结束：桌面不再显示“已出局”
    let show=null;
    if(G.mode!=='hard'){
      // 2V2 有两支队伍：庄家队（庄家+明鸡）和另外两名玩家。
      // 队友位由服务端脱敏下发（G._mate）：明鸡未公开前本地 teamOf 拿不到对家，直接算会错认。
      const mate = (G._mate != null) ? G._mate : null;
      if(mate != null && mate >= 0) show = mate;
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
      lastHandSig = handViewSig(); // 就地改选后同步签名，确保后续「点桌面清选→重建」不被差量误跳
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
let centerKey = ''; // #tableMsg 差量键：表头/分数都没变则不重拼 innerHTML
function renderCenter(){
  const el=$('trickScore');
  el.textContent='';
  el.append('本轮分数 ');
  const num=G.trickPoints||0;
  const numEl=document.createElement('span');
  numEl.className='scoreNum';
  numEl.textContent=num;
  el.append(numEl, ' 分');
  // 中间不再显示“谁压着”
  // 房间号右侧同步一份：对家信息 + 本轮分数，字号更大，方便一眼看到
  const tm=$('tableMsg');
  if(tm){
    const m=$('msg');
    const head=(m && m.textContent) ? m.textContent : '';
    const key = head + '|' + num;
    // 差量：表头/得分都没变就不重拼 innerHTML（得分常随抓分变、表头稳定，正好互补）
    // #tableMsg 是 innerHTML 直插：head 里的昵称（对家/硬牌者）必须转义，防 textContent→innerHTML 反弹 XSS
    if(centerKey !== key){
      centerKey = key;
      tm.innerHTML = (head ? `<span class="m1">${esc(head)}</span>` : '') +
        `<span class="m2">本轮分数 <b>${num}</b> 分</span>`;
    }
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
function teamDotHtml(s,i){
  // 身份列：红/绿圆圈按「牌面+滚笼」净额定胜负（胜绿败红）。
  // 胜负不看出牌名次（winnerSeats）也不看奖金：每座「牌面+滚笼」＝奖金前的
  // perSeatNoBonus（±(牌面基础+滚笼Δ)），>0 → 该座所在队本局牌面+滚笼赢（绿）；
  // =0（平）→ 无胜方，全红。硬牌局同理（随牌面+滚笼净额，与起跑名次解耦）。
  const net = (s && s.perSeatNoBonus) ? (s.perSeatNoBonus[i]||0) : NaN;
  return `<span class="teamDot ${(net>1e-9)?'g':'r'}"></span>`;
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
function finishLocal(settle){
  try{
    // 用服务端下发的结算结果（脱敏后客户端不再本地重算）；缺省时用全量 G 兜底
    const s = settle || (function(){ try{ return TS.settleRound(G); }catch(e){ return null; } })();
    if(!s) return;
    const tb=$('mTable');
    // 是否本场最后一局：由服务器标记（避免客户端根据已累计的局数猜错）
    lastRoundWasLast = !!G.lastSeries;
    // 标题右侧直接带局数：（第2局/共3局）；提前收场 → （第2局/本场已提前结束）
    const roundTxt = (seriesOver && earlyEnded)
      ? `（第${G.roundNo||1}局/本场已提前结束）`
      : `（第${G.roundNo||1}局/共${settings.rounds||1}局）`;
    $('mTitle').textContent = `${lastRoundWasLast?'本场结束':'本局结束'} · ${G.mode==='hard'
      ? `硬牌者 ${seatNames[G.hardSeat]} ${s.winnerSeats.includes(G.hardSeat)?'胜':'败'}`
      : `${s.winnerSeats.map(i=>seatNames[i]).join('、')}赢`}${roundTxt}`;
    // 「下一局」已从计分板移除：局末推进改由牌桌下方【下一局】(btnNext)，场末由【准备】开下一场
    tb.innerHTML=`<tr><th>名字</th><th>顺序</th><th>身份</th><th>抓分</th><th>牌面(笼)</th><th>滚笼(笼)</th><th>奖金(笼)</th><th>本局(分)</th><th>本场(分)</th></tr>`;
    for(let v=0;v<4;v++){
      const i=(mySeat+v)%4, fv=s.perFen[i];
      const bs=baseCageOf(s,i);              // 牌面笼数（番，带符号，半笼=0.5）
      const cageC = (s.perSeatNoBonus?.[i]??s.perSeat[i])-bs; // 滚笼（不含奖金的差额）
      const bonusC = bonusNetOf(s,i); // 奖金净额（王奖/硬炸奖），单位=笼
      const gs=G.seats[i];
      const place = gs.out ? ['一','二','三','四'][gs.outOrder-1]+'游' : ''; // 没跑的玩家顺序留空，不用占位符
      const kb = s.kingBonus&&s.kingBonus[i] ? `（王奖${s.kingBonus[i]}笼×3）` : '';
      const bb = s.bombBonus&&s.bombBonus[i] ? `（硬炸奖${s.bombBonus[i]}笼×3）` : '';
      // 抓分：优先用引擎归属后的值（尾游的抓分归对面队伍），旧缓存引擎回退到原始值
      const caughtVal = (s.effCaught && s.effCaught[i]!=null) ? s.effCaught[i] : gs.caught;
      tb.innerHTML+=`<tr><td>${esc(seatNames[i])}</td>`+
        `<td>${place}</td><td>${teamDotHtml(s,i)}</td><td>${caughtVal}</td><td>${bs>0?'+':''}${bs}</td>`+
        `<td>${cageC>0?'+':''}${cageC}</td>`+
        `<td>${bonusC>0?'+':''}${bonusC}${kb}${bb}</td>`+
        `<td class="fenGold">${fv>0?'+':''}${fv}</td><td>${cumTotals[i]}</td></tr>`;
    }
    // 说明 + 轮累计
    const noteTxt = `牌面(笼) + 滚笼(笼) + 奖金(笼) = 番数；番数 × 2 × 半番 = 本局分（半番默认1 → ×2）`;
    if(series && series.active && settings.rounds>1){
      tb.innerHTML+=`<tr><td colspan="9" class="note">${noteTxt} · 轮内第 ${series.roundCount}/${settings.rounds} 局 · 累计：${cumTotals.map((t,i)=>`${esc(seatNames[i])} ${t>0?'+':''}${t}分`).join('  ')}</td></tr>`;
    } else {
      tb.innerHTML+=`<tr><td colspan="9" class="note">${noteTxt}</td></tr>`;
    }
    // 不在这里弹出：由 applyState 统一延迟 3 秒显示
  }catch(e){}
}

/* ---------- 日志 ---------- */
function log(msg){ const el=$('log'); const d=document.createElement('div'); d.textContent=msg; el.appendChild(d); el.scrollTop=el.scrollHeight; }
function flashMsg(m){
  // 牌桌内提示先投给浮动 toast（#msg 被 CSS 隐藏、桌上看不见）；无 toast 时退回 #msg
  if(window.showTableToast){ window.showTableToast(m); return; }
  $('msg').textContent=m;
}
function addLog(msg){ log(msg); }

/* 被顶替退回大厅：清空牌桌 DOM 与对局状态（等同换房间的清理），供 net.js 的 displaced 回调 */
function resetTable(){
  const h=$('hand'); if(h) h.innerHTML='';
  for(let k=0;k<4;k++){
    const tr=$('t'+k); if(tr) tr.innerHTML='';
    const hc=$('h'+k); if(hc) hc.innerHTML='';
    const he=$('hint'+k); if(he) he.innerHTML='';
  }
  clearBoardDom();
  const md=$('modal'); if(md) md.hidden=true;
  clearSettleTimer(); settleSeq=null; settleShown=false;
  selected.clear(); hintList=[]; lastRoundNo=-1; lastSettle=null; lastSettleSeq=0;
  curRoomCode=''; // 下次进房强制走「换房间」清理路径
}

/* ---------- 当前时间（#lblClock，第 x/y 局下方） ---------- */
setInterval(()=>{ const c=$('lblClock'); if(c) c.textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}); }, 5000);

/* ---------- 网络回调用（net.js 调用） ---------- */
window.GameUI = {
  applyState,
  resetTable,
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
  // gap 加大：左右玩家出牌区往外侧移（西→右、东→左各 10px），
  // 避免压住信息框外侧下方显示的 xx游/插底提示。
  const gap=16, tableW=table.clientWidth;
  // 信息框外侧的提示（xx游 / 准备状态）占用的宽度：出牌区要避开它，自动让位
  const hintW = el => (el ? el.offsetWidth : 0);
  const pad = n => (n>0 ? n + 8 : gap);
  const wPad = pad(hintW(document.getElementById('hint3')));
  const ePad = pad(hintW(document.getElementById('hint1')));
  // 西家：紧贴信息框右侧（有提示时再往右让开）
  tw.style.left=(w.offsetLeft + w.offsetWidth + wPad)+'px';
  tw.style.right='auto';
  // 东家：紧贴信息框左侧（有提示时再往左让开）
  te.style.left='auto';
  te.style.right=(tableW - e.offsetLeft + ePad)+'px';
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
  if(!G){ // 未开局：准备按钮放中间
    if(ready.parentElement!==mid) mid.appendChild(ready);
    return;
  }
  if(seriesOver){ // 本场结束后：准备放「不要」槽位（出牌排右侧），计分板在它左边
    if(ready.parentElement!==right) right.appendChild(ready);
    const st=$('btnSettle');
    if(st){
      if(st.parentElement!==right) right.appendChild(st);
      // HTMLCollection 无 indexOf：用 Array 化再比，确保 计分板 在 准备 左边
      const kids=[...right.children];
      if(kids.indexOf(st) > kids.indexOf(ready)) right.insertBefore(st, ready);
    }
    return;
  }
  if(G.ended && !seriesOver){ // 一局结束（非末局）：计分板 + 下一局 放到出牌排（计分板在左）
    const nx=$('btnNext');
    const st=$('btnSettle');
    if(nx && nx.parentElement!==right) right.appendChild(nx);
    if(st){
      if(st.parentElement!==right) right.appendChild(st);
      const kids=[...right.children];
      if(nx && kids.indexOf(st) > kids.indexOf(nx)) right.insertBefore(st, nx);
    }
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
let __layoutRaf=0;
function syncHandLayout(){
  // #26 布局节流：同一帧内多次调用合并为一次（render/applyState/resize 常赶在同帧）；
  // 无 requestAnimationFrame 环境退回直接执行（行为同旧版）。
  if(typeof requestAnimationFrame==='function'){
    if(__layoutRaf) return;
    __layoutRaf=requestAnimationFrame(()=>{ __layoutRaf=0; syncHandLayoutCore(); });
    return;
  }
  syncHandLayoutCore();
}
function syncHandLayoutCore(){
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
// 「下一局」已从计分板移除（局末改由牌桌下方 btnNext 推进；btnNext 接线在下方）
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
    // 已经准备过（局末点了下一局）→ 再点即取消准备
    if(G && G.ended && !seriesOver && seatReady[mySeat]){ getNET().toggleReady(); return; }
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
    lastHandSig = handViewSig(); // 就地改选后同步签名，防差量跳过后续清选重建
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
    if(clickSuppress) return; // 拖动选牌刚落合的合成 click：不触发「点桌面收回选牌」
    if(selected.size){ selected.clear(); render(); }
  });
})();
})();
