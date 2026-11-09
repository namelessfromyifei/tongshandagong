/* =========================================================
 * 通山打拱 · App 外壳适配（仅在 Capacitor 原生环境生效）
 * - 沉浸式：隐藏状态栏，内容铺满
 * - SplashScreen：页面就绪后收起
 * - 返回键：牌桌内确认退出房间，大厅直接退出 App
 * - 应用内更新（方案1）：启动拉 /api/app/update，发现新版弹窗提示下载
 * 浏览器中不做任何事。
 * ========================================================= */
(function(){
"use strict";

var C = window.Capacitor;
if(!C || !C.isNativePlatform || !C.isNativePlatform()) return;

var P = C.Plugins || {};
document.documentElement.classList.add('isApp');

try{
  if(P.StatusBar){
    P.StatusBar.setOverlaysWebView({ overlay: true });
    P.StatusBar.hide();
  }
}catch(e){}

/* 下拉通知栏/快捷设置收起后，部分机型会重新露出状态栏并在牌桌顶部留下残影。
 * 重新获得焦点/回到前台时再隐藏一次状态栏（页面重绘由 MainActivity.onWindowFocusChanged 里的
 * webView.invalidate() 负责）。 */
function keepImmersive(){
  try{ if(P.StatusBar) P.StatusBar.hide(); }catch(e){}
}
try{
  window.addEventListener('focus', keepImmersive);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) keepImmersive(); });
  if(P.App && P.App.addListener){
    P.App.addListener('appStateChange', function(st){ if(st && st.isActive) keepImmersive(); });
  }
}catch(e){}

try{
  if(P.SplashScreen) P.SplashScreen.hide();
}catch(e){}

/* 返回键：牌桌里先确认，大厅里直接退出 */
try{
  if(P.App && P.App.addListener){
    P.App.addListener('backButton', function(){
      var app = document.getElementById('app');
      var inTable = app && app.classList.contains('inTable');
      if(inTable){
        // 弹窗已打开：返回键只关闭弹窗，不退出房间
        if(window.EXIT_DIALOG && window.EXIT_DIALOG.isOpen()){ window.EXIT_DIALOG.close(); return; }
        if(window.ASK_LEAVE){ window.ASK_LEAVE(); return; }
        if(window.confirm('确定退出房间吗？')) {
          var btn = document.getElementById('btnLeave');
          if(btn) btn.click();
        }
      } else if(P.App.exitApp){
        P.App.exitApp();
      }
    });
  }
}catch(e){}

/* ---------- 应用内更新检查 ---------- */
function plugins(){ return (window.Capacitor && window.Capacitor.Plugins) || {}; }
// 本机已装版本：优先读 App 插件（versionName）；不可用时返回 null（跳过检查）
function getInstalledVersion(){
  try{
    var A = plugins().App;
    if(A && typeof A.getInfo === 'function'){
      return A.getInfo().then(function(i){ return (i && i.version) ? String(i.version) : null; });
    }
  }catch(e){}
  return Promise.resolve(null);
}
// a>b 返回正数；缺段按 0 补
function cmpVersion(a, b){
  var pa = String(a || '0').split('.').map(function(x){ return parseInt(x, 10) || 0; });
  var pb = String(b || '0').split('.').map(function(x){ return parseInt(x, 10) || 0; });
  for(var i = 0; i < 3; i++){
    if((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
// 检查更新：cb(status, installedVersion, data)
// status: update=有新版并已弹窗 / latest=已是最新 / unknown=拿不到当前版本 / fail=请求失败
function checkAppUpdate(cb){
  var done = function(){ if(typeof cb === 'function') cb.apply(null, arguments); };
  try{
    if(!window.NET || typeof window.NET.apiUrl !== 'function'){ done('fail'); return; }
    fetch(window.NET.apiUrl('/api/app/update'), { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!d || !d.update || !d.version){ // 服务器没配 manifest：视为已是最新
          getInstalledVersion().then(function(inst){ done('latest', inst, d); });
          return;
        }
        getInstalledVersion().then(function(inst){
          if(!inst){ done('unknown', null, d); return; }
          if(cmpVersion(d.version, inst) <= 0){ done('latest', inst, d); return; }
          showUpdatePrompt(d);
          done('update', inst, d);
        });
      })
      .catch(function(){ done('fail'); });
  }catch(e){ done('fail'); }
}
// 供大厅「检查更新」按钮手动调用
window.APP_UPDATE = { check: checkAppUpdate };
var _updateShown = false;
function showUpdatePrompt(d){
  if(_updateShown) return;
  _updateShown = true;
  var ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.68);z-index:99999;' +
    'display:flex;align-items:center;justify-content:center;';
  var box = document.createElement('div');
  box.style.cssText = 'background:#0f3d2a;border:1px solid rgba(255,255,255,.25);border-radius:14px;' +
    'padding:20px 18px;max-width:84vw;color:#eef3ea;font:15px/1.6 system-ui,-apple-system,sans-serif;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.6);';
  var h = document.createElement('h3');
  h.style.cssText = 'margin:0 0 10px;color:#e8c15a;font-size:19px;';
  h.textContent = '发现新版本 v' + d.version;
  box.appendChild(h);
  if(d.note){
    var nt = document.createElement('p');
    nt.style.cssText = 'margin:0 0 12px;white-space:pre-wrap;color:#cfe6da;max-height:30vh;overflow:auto;';
    nt.textContent = d.note;
    box.appendChild(nt);
  }
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:6px;';
  function btn(label, primary, cb){
    var b = document.createElement('button');
    b.style.cssText = 'border:none;border-radius:8px;padding:9px 16px;font-size:15px;cursor:pointer;' +
      (primary ? 'background:#e8c15a;color:#223;font-weight:bold;' : 'background:rgba(255,255,255,.12);color:#eef3ea;');
    b.textContent = label;
    b.onclick = cb;
    return b;
  }
  row.appendChild(btn('稍后再说', false, function(){ ov.remove(); }));
  if(d.fallbackUrl && d.fallbackUrl !== d.apkUrl){
    row.appendChild(btn('备用下载', false, function(){ downloadApk(d.fallbackUrl); }));
  }
  row.appendChild(btn('立即下载', true, function(){ downloadApk(d.apkUrl); }));
  box.appendChild(row);
  ov.appendChild(box);
  document.body.appendChild(ov);
}
function downloadApk(url){
  var abs = String(url || '');
  if(!abs) return;
  try{
    var B = plugins().Browser;
    if(B && typeof B.open === 'function'){
      // 打开系统浏览器/自定义标签下载 APK，下载完成后从通知栏点按安装
      B.open({ url: abs });
      return;
    }
  }catch(e){}
  try{ window.open(abs, '_blank'); }catch(e){}
}
function boot(){
  checkAppUpdate();
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
})();
