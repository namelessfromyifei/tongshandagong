/* =========================================================
 * 通山打拱 · 强制横屏（进入房间后生效，仅 app / 移动端）
 * 流程：
 *   1) 进入牌桌（房间）→ 尝试 screen.orientation.lock('landscape') 锁定横屏
 *   2) 锁定失败 / 浏览器不支持（WebView、iOS 等常见）→
 *      竖屏状态下把 #app 旋转 90° 铺满屏幕，同样呈横屏观感
 *   3) 回大厅时撤掉旋转、解除锁定（大厅可竖屏）
 * PC 端不受任何影响（isMobile 判断拦截）。
 * ========================================================= */
(function(){
"use strict";

var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 0 && window.innerWidth < 1024);

var inTable = false;   // 是否已进入牌桌
var rotated = false;   // 旋转兜底是否生效
var locked  = false;   // 系统横屏锁定是否成功

function isPortrait(){ return window.innerHeight > window.innerWidth; }

// 尝试系统横屏锁定（仅支持时有效）
function tryLock(){
  if(!window.screen || !window.screen.orientation || !window.screen.orientation.lock){
    return Promise.resolve(false);
  }
  try{
    return window.screen.orientation.lock('landscape')
      .then(function(){ return true; })
      .catch(function(){ return false; });
  }catch(e){ return Promise.resolve(false); }
}
function unlock(){
  try{
    if(window.screen && window.screen.orientation && window.screen.orientation.unlock){
      window.screen.orientation.unlock();
    }
  }catch(e){}
}

// 旋转兜底：把 #app 旋成横屏铺满物理竖屏
function applyRotate(){
  if(rotated || !isMobile || !inTable) return;
  rotated = true;
  var app = document.getElementById('app');
  if(app) app.classList.add('landscapeRotate');
  document.body.classList.add('landscapeCompat');
  document.documentElement.style.overflow = 'hidden';
}
function clearRotate(){
  if(!rotated) return;
  rotated = false;
  var app = document.getElementById('app');
  if(app) app.classList.remove('landscapeRotate');
  document.body.classList.remove('landscapeCompat');
  document.documentElement.style.overflow = '';
}

// 依据当前朝向统一状态
function sync(){
  if(!inTable || !isMobile) return;
  if(isPortrait()){
    // 物理竖屏：先试锁定，失败则旋转兜底
    tryLock().then(function(ok){
      locked = ok;
      if(ok) clearRotate(); else applyRotate();
    });
  } else {
    // 已横屏（锁定生效或用户转动了手机）：撤掉兜底
    locked = true;
    clearRotate();
  }
}

window.addEventListener('orientationchange', function(){ setTimeout(sync, 250); });
window.addEventListener('resize', function(){ setTimeout(sync, 250); });

window.LANDSCAPE = {
  enter: function(){ inTable = true; setTimeout(sync, 250); },
  exit:  function(){ inTable = false; clearRotate(); unlock(); },
};
})();