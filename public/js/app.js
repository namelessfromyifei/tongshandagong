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
  // 下载进度区（App 内下载时显示）
  var prog = document.createElement('div');
  prog.id = 'updProgress';
  prog.style.cssText = 'display:none;margin:0 0 10px;color:#cfe6da;font-size:13px;';
  var progText = document.createElement('div');
  progText.id = 'updProgressText';
  var barWrap = document.createElement('div');
  barWrap.id = 'updProgressBar';
  barWrap.style.cssText = 'height:6px;background:rgba(255,255,255,.15);border-radius:3px;overflow:hidden;margin-top:6px;display:none;';
  var barFill = document.createElement('div');
  barFill.id = 'updProgressFill';
  barFill.style.cssText = 'height:100%;width:0;background:#e8c15a;transition:width .2s;';
  barWrap.appendChild(barFill);
  prog.appendChild(progText);
  prog.appendChild(barWrap);
  box.appendChild(prog);

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
  var ui = { ov:ov, prog:prog, progText:progText, barWrap:barWrap, barFill:barFill };
  var btnLater = btn('稍后再说', false, function(){ ov.remove(); });
  var btnBackup = null;
  if(d.fallbackUrl && d.fallbackUrl !== d.apkUrl){
    btnBackup = btn('备用下载', false, function(){ downloadApk(d.fallbackUrl); });
  }
  var btnDownload = btn('立即下载', true, function(){ startInAppUpdate(d, ui); });
  ui.btnLater = btnLater; ui.btnBackup = btnBackup; ui.btnDownload = btnDownload;
  row.appendChild(btnLater);
  if(btnBackup) row.appendChild(btnBackup);
  row.appendChild(btnDownload);
  box.appendChild(row);
  ov.appendChild(box);
  document.body.appendChild(ov);
}

function setUpdateProgress(ui, pct, text){
  if(!ui) return;
  ui.prog.style.display = 'block';
  ui.progText.textContent = text || '';
  if(pct == null){
    ui.barWrap.style.display = 'none';
  } else {
    ui.barWrap.style.display = 'block';
    ui.barFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
}

// App 内下载 APK → 拉起系统安装器；任意一步失败都回退到浏览器下载
function startInAppUpdate(d, ui){
  var P2 = plugins();
  var FS = P2.Filesystem, AI = P2.ApkInstaller;
  if(!FS || typeof FS.downloadFile !== 'function' || !AI || typeof AI.install !== 'function'){
    fallbackDownload(d.apkUrl, ui, '当前版本不支持 App 内安装，改为浏览器下载');
    return;
  }
  var safeVer = String(d.version || 'latest').replace(/[^0-9A-Za-z._-]/g, '_');
  var path = 'tongshandagong-' + safeVer + '.apk';
  ui.btnDownload.disabled = true;
  if(ui.btnBackup) ui.btnBackup.style.display = 'none';
  if(ui.btnLater) ui.btnLater.style.display = 'none';
  setUpdateProgress(ui, 0, '下载中… 0%');
  var listener = null;
  try{
    var h = FS.addListener('progress', function(p){
      var pct = (p && p.contentLength > 0) ? Math.round(p.bytes / p.contentLength * 100) : null;
      setUpdateProgress(ui, pct, pct == null ? '下载中…' : '下载中… ' + Math.min(100, pct) + '%');
    });
    if(h && typeof h.remove === 'function'){ listener = h; }
    else if(h && typeof h.then === 'function'){ h.then(function(hh){ listener = hh; }); }
  }catch(e){}
  var stopListen = function(){ try{ if(listener && listener.remove) listener.remove(); }catch(e){} };
  FS.downloadFile({ url: d.apkUrl, path: path, directory: 'CACHE', progress: true })
    .then(function(res){
      stopListen();
      setUpdateProgress(ui, 100, '下载完成，正在打开安装页…');
      installDownloadedApk(res && res.path, d, ui);
    })
    .catch(function(){
      stopListen();
      fallbackDownload(d.apkUrl, ui, '下载失败，已改为浏览器下载');
    });
}

function installDownloadedApk(path, d, ui){
  var AI = plugins().ApkInstaller;
  if(!path || !AI || typeof AI.install !== 'function'){
    fallbackDownload(d.apkUrl, ui);
    return;
  }
  AI.install({ path: path }).then(function(){
    setUpdateProgress(ui, 100, '已打开安装页，请按提示完成安装');
    if(ui.btnLater){ ui.btnLater.style.display = 'inline-block'; ui.btnLater.textContent = '关闭'; }
  }).catch(function(err){
    var code = String((err && (err.code || err.message)) || '');
    if(code.indexOf('NEED_PERMISSION') >= 0){
      setUpdateProgress(ui, 100, '请允许「安装未知应用」后返回，再点下方按钮');
      if(ui.btnDownload){
        ui.btnDownload.disabled = false;
        ui.btnDownload.textContent = '重新安装';
        ui.btnDownload.onclick = function(){ installDownloadedApk(path, d, ui); };
      }
      if(ui.btnLater) ui.btnLater.style.display = 'inline-block';
      return;
    }
    fallbackDownload(d.apkUrl, ui, '安装页打开失败，已改为浏览器下载');
  });
}

function fallbackDownload(url, ui, msg){
  if(ui && msg) setUpdateProgress(ui, null, msg);
  downloadApk(url);
  // 交给浏览器后关闭自定义弹窗
  setTimeout(function(){
    try{ if(ui && ui.ov && ui.ov.parentNode) ui.ov.parentNode.removeChild(ui.ov); }catch(e){}
  }, 1500);
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
