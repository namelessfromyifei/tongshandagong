/* =========================================================
 * 构建 Android 调试 APK，可指定服务器地址
 *
 * 用法：
 *   node tools/build-apk.js                                  # 用默认线上地址
 *   node tools/build-apk.js --server http://8.148.29.231     # 域名备案前的 IP 内测
 *   node tools/build-apk.js --server https://example.com
 *
 * 做了什么：
 *   1. 把 --server 写入 public/js/env.js（构建后还原）
 *   2. http 地址时临时把 Capacitor 改成 http scheme + 允许明文（构建后还原）
 *   3. cap sync → gradlew assembleDebug
 *   4. 把 APK 复制到 dist/
 *   5. 再 sync 一次，让 android/ 里的资源回到线上配置
 * ========================================================= */
"use strict";
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, 'public', 'js', 'env.js');
const capPath = path.join(root, 'capacitor.config.json');
const distDir = path.join(root, 'dist');
const apkSrc = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

function argValue(name){
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function run(cmd, cwd){
  const r = spawnSync(cmd, { cwd, shell: true, stdio: 'inherit', env: process.env });
  if(r.status !== 0) throw new Error('命令执行失败：' + cmd);
}

/* Capacitor 7 需要 JDK 21+。gradle.properties 里不再写死本机路径，
 * 这里自动找一个可用的 JDK 21+（当前 JAVA_HOME 不合格时），保证 npm run apk 开箱能跑。 */
function javaMajor(home){
  try{
    const r = spawnSync(path.join(home, 'bin', 'java'), ['-version'], { encoding: 'utf8' });
    const s = String(r.stderr || '') + String(r.stdout || '');
    const m = s.match(/version "(\d+)/);
    return m ? Number(m[1]) : 0;
  }catch(e){ return 0; }
}
function resolveJavaHome(){
  const cur = process.env.JAVA_HOME;
  if(cur && javaMajor(cur) >= 21) return cur;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [];
  // ~/.jdks/*（IntelliJ 下载的 JDK 常在这里）
  try{
    for(const d of fs.readdirSync(path.join(home, '.jdks'))) candidates.push(path.join(home, '.jdks', d));
  }catch(e){}
  // 常见安装位置
  const extra = process.platform === 'win32'
    ? ['C:/Program Files/Java', 'D:/Program Files/Java', 'C:/Program Files/Eclipse Adoptium']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  for(const base of extra){
    try{
      for(const d of fs.readdirSync(base)){
        const p = path.join(base, d);
        candidates.push(p);
        candidates.push(path.join(p, 'Contents', 'Home')); // macOS 的 .jdk 包
      }
    }catch(e){}
  }
  for(const c of candidates){
    if(javaMajor(c) >= 21) return c;
  }
  return null;
}
const javaHome = resolveJavaHome();
if(!javaHome){
  console.error('[build-apk] 找不到 JDK 21+，请先安装并设置 JAVA_HOME');
  process.exit(1);
}
process.env.JAVA_HOME = javaHome;
console.log('[build-apk] Java: ' + javaHome);

let target = null;
const raw = argValue('--server');
if(raw){
  let u;
  try{ u = new URL(raw); }catch(e){ console.error('--server 不是合法地址：' + raw); process.exit(1); }
  if(u.protocol !== 'http:' && u.protocol !== 'https:'){
    console.error('--server 只支持 http/https');
    process.exit(1);
  }
  target = u.origin; // 去掉路径和末尾斜杠
}

const isHttp = target ? target.startsWith('http:') : false;

// 备份原始文件，构建结束后还原
const envBackup = fs.readFileSync(envPath, 'utf8');
const capBackup = fs.readFileSync(capPath, 'utf8');

try{
  if(target){
    fs.writeFileSync(envPath,
      '/* 由 tools/build-apk.js 临时生成，构建结束后还原 */\n' +
      'window.TS_SERVER_ORIGIN = ' + JSON.stringify(target) + ';\n');

    const cap = JSON.parse(capBackup);
    cap.server = cap.server || {};
    cap.server.androidScheme = isHttp ? 'http' : 'https';
    if(isHttp) cap.server.cleartext = true;
    else delete cap.server.cleartext;
    fs.writeFileSync(capPath, JSON.stringify(cap, null, 2) + '\n');

    console.log('[build-apk] 服务器地址：' + target + (isHttp ? '（明文 HTTP，仅测试用）' : ''));
  }

  run('npx cap sync android', root);
}finally{
  // 资源已复制进 android/，这里立刻还原，避免把内测地址留在仓库里
  fs.writeFileSync(envPath, envBackup);
  fs.writeFileSync(capPath, capBackup);
}

try{
  // Windows 下必须带 .\ ，否则 cmd 不会在当前目录查找
  const gradlew = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  run(gradlew + ' assembleDebug', path.join(root, 'android'));

  fs.mkdirSync(distDir, { recursive: true });
  const host = target ? new URL(target).host.replace(/[^a-zA-Z0-9.-]/g, '_') : 'production';
  const out = path.join(distDir, 'tongshandagong-' + host + '-debug.apk');
  fs.copyFileSync(apkSrc, out);
  console.log('\n[build-apk] 完成：' + out);
  if(target) console.log('[build-apk] 该包连接 ' + target);
}finally{
  // android/ 里的资源恢复成线上配置，避免下次直接跑 Android Studio 时连错地址
  run('npx cap sync android', root);
}
