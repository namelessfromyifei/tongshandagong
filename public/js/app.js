/* =========================================================
 * 通山打拱 · App 外壳适配（仅在 Capacitor 原生环境生效）
 * - 沉浸式：隐藏状态栏，内容铺满
 * - SplashScreen：页面就绪后收起
 * - 返回键：牌桌内确认退出房间，大厅直接退出 App
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
})();
