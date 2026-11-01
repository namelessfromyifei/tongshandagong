/* =========================================================
 * 发布 APK（配应用内更新）：bump 版本 → 构建 → 更新 app-update/
 *
 * 用法：
 *   node tools/release-apk.js                              # versionName 自动 +1（patch），versionCode+1
 *   node tools/release-apk.js --version 1.2.0              # 指定新版本号
 *   node tools/release-apk.js --note "修复掉线提示/横屏逻辑"  # 更新说明（App 弹窗展示）
 *
 * 做了什么：
 *   1. android/app/build.gradle 的 versionCode+1、versionName 递增（可 --version 覆盖）
 *   2. 调 tools/build-apk.js 构建 production APK（dist/tongshandagong-production-debug.apk）
 *   3. 拷贝 app-update/latest.apk + 写 app-update/manifest.json（服务端 /api/app/update 据此提示）
 *
 * app-update/ 已 gitignore：不进仓库，只存在于服务器/本机。
 * 服务端部署后 App 即能检查到新版本（无需改环境变量）。
 * ========================================================= */
"use strict";
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
const apkSrc = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const updDir = path.join(root, 'app-update');

function argValue(name){
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// ---------- 1) bump 版本 ----------
let gradle = fs.readFileSync(gradlePath, 'utf8');
const codeRe = /(versionCode\s+)(\d+)/;
const nameRe = /(versionName\s+")([^"]+)(")/;
const codeMatch = gradle.match(codeRe);
const nameMatch = gradle.match(nameRe);
if(!codeMatch || !nameMatch){
  console.error('[release-apk] 在 build.gradle 找不到 versionCode/versionName');
  process.exit(1);
}
let versionName = argValue('--version');
if(versionName && !/^\d+\.\d+\.\d+$/.test(versionName)){
  console.error('[release-apk] --version 需形如 x.y.z');
  process.exit(1);
}
if(!versionName){
  const parts = nameMatch[2].split('.');
  parts[2] = String((Number(parts[2]) || 0) + 1);
  versionName = parts.join('.');
}
const versionCode = Number(codeMatch[2]) + 1;
gradle = gradle.replace(codeRe, '$1' + versionCode);
gradle = gradle.replace(nameRe, '$1' + versionName + '$3');
fs.writeFileSync(gradlePath, gradle);
console.log(`[release-apk] 版本 → ${versionName} (versionCode ${versionCode})`);

// ---------- 2) 构建 ----------
console.log('\n[release-apk] 开始构建……');
// 注意：不要 shell:true——cmd 会把带空格的参数路径拆坏（Windows）
const r = spawnSync(process.execPath, ['tools/build-apk.js'], { cwd: root, stdio: 'inherit' });
if(r.status !== 0){ console.error('[release-apk] 构建失败'); process.exit(r.status || 1); }
if(!fs.existsSync(apkSrc)){
  console.error('[release-apk] 找不到构建产物：' + apkSrc);
  process.exit(1);
}

// ---------- 3) 更新 app-update/ ----------
fs.mkdirSync(updDir, { recursive: true });
const note = argValue('--note') || '';
fs.copyFileSync(apkSrc, path.join(updDir, 'latest.apk'));
const manifest = { version: versionName, note, publishedAt: new Date().toISOString() };
fs.writeFileSync(path.join(updDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('[release-apk] 已更新 app-update/latest.apk + manifest.json（版本 ' + versionName + '）');

console.log('\n✅ 发布完成。后续步骤：');
console.log('  1. 部署服务器（redeploy.sh）；App 端每次启动会检查 /api/app/update 并弹窗提示下载');
console.log('  2. 本机体验：装 dist/tongshandagong-production-debug.apk');
console.log('  3. build.gradle 的版本改动随仓库提交，后续再发按此流程即可');