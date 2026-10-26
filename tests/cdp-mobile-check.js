/* CDP 验证脚本：模拟移动端横屏/竖屏，检查牌桌高度与选牌上弹是否被裁剪
 * 运行：node tests/cdp-mobile-check.js
 *   前置：本机 8080 起游戏服务（node server.js）；无头 Chrome 以远程调试端口 9224 启动
 */
const http = require('http');
const wsmod = require('ws');
const CDP = 'http://127.0.0.1:9224';

function fetchJson(url, opts){
  return new Promise((res,rej)=>{
    http.get(url, opts?Object.assign(opts,{method:'GET'}):{}, (r)=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{try{res(JSON.parse(b));}catch(e){rej(e);}});}).on('error',rej);
  });
}
function newPage(url){
  return new Promise((res,rej)=>{
    const body='http://localhost:8080';
    const req=http.request({host:'127.0.0.1',port:9224,path:'/json/new?about:blank',method:'PUT'},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>res(JSON.parse(b)));});
    req.on('error',rej); req.end();
  });
}

async function main(){
  const target = await newPage();
  const s = new wsmod(target.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ s.on('open',res); s.on('error',rej); });
  let id=0; const pending=new Map();
  s.on('message',d=>{ const m=JSON.parse(d); if(m.id&&pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id);} });
  const send=(method,params={})=>new Promise(res=>{ const i=++id; pending.set(i,res); s.send(JSON.stringify({id:i,method,params})); });
  const evtWaiters=[];
  s.on('message',d=>{ const m=JSON.parse(d); if(m.method){ for(const w of evtWaiters.slice()) if(w.method===m.method){ w.res(m.params); const k=evtWaiters.indexOf(w); evtWaiters.splice(k,1); } } });
  const once=(method)=>new Promise(res=>evtWaiters.push({method,res}));
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  async function evalJS(expr, awaitPromise){
    const m = await send('Runtime.evaluate', {expression:expr, returnByValue:true, awaitPromise:!!awaitPromise});
    if(m.result && m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
    return m.result && m.result.result ? m.result.result.value : undefined;
  }

  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled',{cacheDisabled:true}); // 防止旧 index.html 被缓存

  // 设置设备指标（mobile 移动端视口 + UA）
  async function setMetrics(w,h,orient){
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:2,mobile:true,
      screenOrientation:{type:orient,angle:orient==='portraitPrimary'?0:90},screenWidth:w,screenHeight:h});
    await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',platform:'Android',mobile:true});
  }
  // 驱动进入房间并勾选 AI 补位开局（房主单人 + AI 补位即可开局）
  async function enterRoom(){
    await evalJS(`document.getElementById('nameInput').value='测';document.getElementById('btnSetName').click();document.getElementById('btnCreate').click();true`);
    await sleep(150);
    await evalJS(`document.getElementById('btnCreateGo').click();true`);
    await sleep(600);
    // 打开对局配置 → 勾选 AI 补位 → 点开始对局（自动开局）
    await evalJS(`document.getElementById('btnStart').click();true`);
    await sleep(150);
    await evalJS(`var c=document.getElementById('setAIFill'); c.checked=true; c.dispatchEvent(new Event('change'));document.getElementById('btnSetGo').click();true`);
    await sleep(1200);
    return await evalJS(`(function(){var tw=document.getElementById('tableWrap');var g=window.__lastG; return {tableVisible:getComputedStyle(tw).display, hasG:!!g};})()`);
  }

  async function measure(name){
    const r = await evalJS(`(async function(){
      const table=document.querySelector('.table');
      const tw=document.getElementById('tableWrap');
      const hand=document.getElementById('hand');
      const hcs=[...hand.querySelectorAll('.hcard')];
      let sel=null;
      if(hcs.length){
        const c1=hcs[0];
        const nrm=c1.getBoundingClientRect();
        // 同步测量：跳过 transition，直接置选中态读最终几何
        c1.style.transition='none';
        c1.classList.add('sel');
        const hr=hand.getBoundingClientRect(), cr=c1.getBoundingClientRect();
        const hs=getComputedStyle(hand);
        sel={selTop:Math.round(cr.top), handTop:Math.round(hr.top), normalTop:Math.round(nrm.top),
             clipped: cr.top < hr.top, movedUp:Math.round(nrm.top-cr.top),
             handBoxH:Math.round(hr.height), padTop:hs.paddingTop, overflowY:hs.overflowY, cardCount:hcs.length};
      }
      const rect=table.getBoundingClientRect();
      const cs=getComputedStyle(table);
      const csTw=getComputedStyle(tw);
      // 本家信息框（改在 southMain 顶部）不应与手牌重叠
      const seatS=document.querySelector('.handRow .seatS');
      let firstLeft=null, infoRight=null, overlapCards=false;
      if(hcs.length && seatS){
        firstLeft=Math.round(hcs[0].getBoundingClientRect().left);
        infoRight=Math.round(seatS.getBoundingClientRect().right);
        overlapCards = firstLeft < infoRight; // 若信息框在下方/侧面会重叠
      }
      // 手牌中心与屏幕中心偏差（居中检查）
      let centerDelta=null;
      if(hcs.length){
        const l=hcs[0].getBoundingClientRect().left, r=hcs[hcs.length-1].getBoundingClientRect().right;
        centerDelta=Math.round(Math.abs((l+r)/2 - window.innerWidth/2));
      }
      // 出牌按钮与手牌顶端的间距（应很小=靠近牌）
      let btnGap=null;
      const btnPlay=document.getElementById('btnPlay');
      const fc=hcs.length?hcs[0]:null;
      if(btnPlay && fc){
        btnGap=Math.round(Math.max(0, fc.getBoundingClientRect().top - btnPlay.getBoundingClientRect().bottom));
      }
      // 北家出牌区 vs 北家信息框（应压在框下方，不遮挡）
      let northClear=null;
      const seatN=document.querySelector('.seat[data-seat="2"]');
      const trickN=document.getElementById('t2');
      if(seatN && trickN){
        northClear=Math.round(trickN.getBoundingClientRect().top - seatN.getBoundingClientRect().bottom);
      }
      return {vw:window.innerWidth, vh:window.innerHeight,
        tableH:Math.round(rect.height), tableBottom:Math.round(rect.bottom),
        tableCSSHeight:cs.height, tableMinH:cs.minHeight,
        twHeight:csTw.height, twDisplay:csTw.display, twFlexDir:csTw.flexDirection,
        mqLandscape:matchMedia('(orientation: landscape)').matches,
        mqMaxW920:matchMedia('(max-width: 920px)').matches,
        bodyClass:document.body.className, appClass:document.getElementById('app').className,
        gapBelowScroll:(document.documentElement.scrollHeight - window.innerHeight),
        sel:sel,
        firstCardLeft:firstLeft, infoBoxRight:infoRight, cardsUnderInfo:overlapCards,
        handCenterDelta:centerDelta, btnToCardsGap:btnGap, northClear:northClear};
    })()`, true);
    console.log('\n=== '+name+' ===');
    console.log(JSON.stringify(r,null,1));
    return r;
  }

  // ---- 场景A：原生横屏（默认 844x390；可用 W1/H1 环境变量改成窄屏复现） ----
  const W1 = process.env.W1?+process.env.W1:844, H1 = process.env.H1?+process.env.H1:390;
  await setMetrics(W1,H1,'landscapePrimary');
  await send('Page.navigate',{url:'http://localhost:8080/'});
  await sleep(2500);
  await enterRoom();
  const A = await measure('场景A 原生横屏 '+W1+'x'+H1);
  const Aok = A.tableBottom <= windowHeight(A.vh) + 3;
  function windowHeight(vh){ return vh; }

  // ---- 场景B：竖屏 390x844（旋转兜底） ----
  await setMetrics(390,844,'portraitPrimary');
  await send('Page.navigate',{url:'http://localhost:8080/'});
  await sleep(2500);
  await enterRoom();
  const B = await measure('场景B 竖屏+旋转兜底 390x844');

  console.log('\n判定：');
  console.log('A 横屏 表格铺满(底边≈视口高):', A.tableBottom>=(A.vh-12), '| 上弹裁剪:', A.sel?A.sel.clipped:'无手牌');
  console.log('B 兜底 表格铺满:', (B.tableBottom>=(B.vh-12)), '| 上弹裁剪:', B.sel?B.sel.clipped:'无手牌');
  process.exit(0);
}
main().catch(e=>{ console.error('ERR',e); process.exit(1); });