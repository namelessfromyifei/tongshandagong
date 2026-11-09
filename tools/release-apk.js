/* =========================================================
 * 发布 APK（配应用内更新）：bump 版本 → 构建 → 分发 APK → 写 manifest
 *
 * 用法（三种分发方式，默认入仓）：
 *   node tools/release-apk.js --note "更新说明"
 *     默认：APK 写入 release/latest.apk（入库），push 后服务器 redeploy 自动同步到 app-update/
 *   node tools/release-apk.js --note "…" --release
 *     GitHub Release 分发（tag vX.Y.Z，需 GH_TOKEN）
 *   node tools/release-apk.js --note "…" --scp
 *     scp 直传服务器（需 APP_DEPLOY_SSH），可配 APP_DEPLOY_PORT / APP_DEPLOY_KEY
 *   --release 与 --scp 可同时使用（服务器为主、Release 兜底）。
 *
 * 做了什么：
 *   1. android/app/build.gradle 的 versionCode+1、versionName 递增（可 --version 覆盖）
 *   2. 调 tools/build-apk.js 构建 production APK
 *   3. 按上述方式分发 APK
 *   4. 写 app-update/manifest.json：
 *        入仓/服务器有 APK → apkUrl=/app-update/tongshandagong-<版本>.apk（同域，下载文件名带版本），有 Release 时兜底
 *        仅 Release         → apkUrl=Release 地址
 *      /api/app/update 会检查该文件是否存在且大小与 manifest 一致，缺失时自动退回 fallbackUrl。
 * ========================================================= */
"use strict";
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
const apkSrc = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const updDir = path.join(root, 'app-update');
const repoApkDir = path.join(root, 'release');
const repoApkPath = path.join(repoApkDir, 'latest.apk');

function argValue(name){
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const useRelease = process.argv.includes('--release');
const useScp = process.argv.includes('--scp');
const repoMode = !useRelease && !useScp; // 默认：APK 入仓，服务器 pull 后同步

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

// ---------- 3) 发布：服务器静态托管（主）+ GitHub Release（兜底） ----------
// 服务器上 app-update/latest.apk 由 scp 上传；GitHub Release 托管备份，仓库只提交几十字节的 manifest.json。
const note = argValue('--note') || '';
const repo = (process.env.APP_RELEASE_REPO || 'zhanghan4141-oss/tongshandagong').trim();
const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const tag = 'v' + versionName;
const assetName = `tongshandagong-${versionName}.apk`;
const assetUrl = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
const apiBase = `https://api.github.com/repos/${repo}`;
const localApkName = `tongshandagong-${versionName}.apk`; // 下载保存的文件名带版本
const LOCAL_APK_URL = '/app-update/' + localApkName;

// 服务器上传（scp）：APP_DEPLOY_SSH=user@host，可选 APP_DEPLOY_PORT / APP_DEPLOY_KEY / APP_DEPLOY_DIR
const deploySsh = (process.env.APP_DEPLOY_SSH || '').trim();
const deployPort = (process.env.APP_DEPLOY_PORT || '').trim();
const deployKey = (process.env.APP_DEPLOY_KEY || '').trim();
const deployDir = (process.env.APP_DEPLOY_DIR || '/home/admin/tongshandagong/app-update').trim();

function shellQuote(s){
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function sshArgs(portFlag){
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if(deployPort) args.push(portFlag, deployPort);
  if(deployKey) args.push('-i', deployKey);
  return args;
}
function uploadToServer(){
  console.log(`\n[release-apk] 上传 APK 到服务器 ${deploySsh}:${deployDir} ……`);
  const mk = spawnSync('ssh', sshArgs('-p').concat([deploySsh, `mkdir -p ${shellQuote(deployDir)}`]),
    { stdio: 'inherit', timeout: 120000 });
  if(mk.error) throw mk.error;
  if(mk.status !== 0) throw new Error(`ssh 创建目录失败（退出码 ${mk.status}）`);
  const up = spawnSync('scp', sshArgs('-P').concat([apkSrc, `${deploySsh}:${deployDir}/${localApkName}`]),
    { stdio: 'inherit', timeout: 300000 });
  if(up.error) throw up.error;
  if(up.status !== 0) throw new Error(`scp 上传失败（退出码 ${up.status}）`);
  console.log('[release-apk] 服务器上传完成');
}

function ghHeaders(extra){
  return Object.assign({
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'tongshandagong-release',
  }, extra || {});
}
async function ghFetch(method, url, opts){
  const res = await fetch(url, Object.assign({ method, headers: ghHeaders(opts && opts.headers) }, opts || {}));
  return res;
}
async function ghJson(method, url, body){
  const opts = body != null ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const res = await ghFetch(method, url, opts);
  const txt = await res.text();
  if(!res.ok) throw new Error(`GitHub API ${method} ${url} → ${res.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}
async function publishRelease(){
  // 取或建 release
  let rel = null;
  const relRes = await ghFetch('GET', `${apiBase}/releases/tags/${tag}`);
  if(relRes.status === 200) rel = await relRes.json();
  else if(relRes.status !== 404) throw new Error(`查询 Release 失败：${relRes.status} ${(await relRes.text()).slice(0, 200)}`);
  if(!rel){
    rel = await ghJson('POST', `${apiBase}/releases`, {
      tag_name: tag, name: `通山打拱 v${versionName}`, body: note, draft: false, prerelease: false, make_latest: 'true',
    });
  } else {
    rel = await ghJson('PATCH', `${apiBase}/releases/${rel.id}`, {
      name: `通山打拱 v${versionName}`, body: note, make_latest: 'true',
    });
  }
  // 同名资产已存在则先删，再上传（支持重发同一版本）
  const assets = await ghJson('GET', `${apiBase}/releases/${rel.id}/assets?per_page=100`);
  for(const a of (assets || [])){
    if(a.name === assetName) await ghFetch('DELETE', `${apiBase}/releases/assets/${a.id}`);
  }
  const apk = fs.readFileSync(apkSrc);
  const up = await ghFetch('POST', `https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`, {
    headers: { 'Content-Type': 'application/vnd.android.package-archive' },
    body: apk,
  });
  if(!up.ok) throw new Error(`上传 APK 失败：${up.status} ${(await up.text()).slice(0, 300)}`);
}

(async () => {
  fs.mkdirSync(updDir, { recursive: true });
  fs.copyFileSync(apkSrc, path.join(updDir, 'latest.apk')); // 本地留一份，便于直接装机（不入库）
  const apkSize = fs.statSync(apkSrc).size;

  let ghUrl = '';
  let ghErr = '';
  let serverOk = false;
  let serverErr = '';
  let repoOk = false;

  // 默认分发：APK 入仓（release/latest.apk），随 git push 到服务器，由 redeploy 同步进 app-update/
  if(repoMode){
    fs.mkdirSync(repoApkDir, { recursive: true });
    fs.copyFileSync(apkSrc, repoApkPath);
    repoOk = true;
    console.log('\n[release-apk] 已写入 release/latest.apk（提交并 push 后，服务器部署时自动同步到 app-update/）');
  }

  if(useRelease){
    if(!token){
      console.error('[release-apk] --release 需要 GH_TOKEN / GITHUB_TOKEN');
      process.exit(1);
    }
    try{
      await publishRelease();
      ghUrl = assetUrl;
      console.log(`\n[release-apk] 已发布 GitHub Release：${tag}（${repo}）`);
    }catch(e){
      ghErr = e && e.message ? e.message : String(e);
      console.error('[release-apk] GitHub Release 发布失败：' + ghErr);
    }
  }

  if(useScp){
    if(!deploySsh){
      console.error('[release-apk] --scp 需要 APP_DEPLOY_SSH=user@host');
      process.exit(1);
    }
    try{
      uploadToServer();
      serverOk = true;
    }catch(e){
      serverErr = e && e.message ? e.message : String(e);
      console.error('[release-apk] 服务器上传失败：' + serverErr);
    }
  }

  if(!repoOk && !ghUrl && !serverOk){
    console.error('\n[release-apk] 所有分发方式均未成功，未更新 manifest。');
    if(ghErr) console.error('  GitHub：' + ghErr);
    if(serverErr) console.error('  服务器：' + serverErr);
    process.exit(1);
  }

  // 服务器/仓库有 APK → 主用同域静态地址；只有 Release 时走 Release 地址
  const hasLocal = repoOk || serverOk;
  const manifest = {
    version: versionName,
    note,
    apkUrl: hasLocal ? LOCAL_APK_URL : ghUrl,
    fallbackUrl: hasLocal && ghUrl ? ghUrl : '',
    apkSize,
    publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(updDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('[release-apk] 已写入 app-update/manifest.json（apkUrl → ' +
    (hasLocal ? '服务器 ' + LOCAL_APK_URL : assetUrl) + (manifest.fallbackUrl ? '，兜底 → Release' : '') + '）');

  console.log('\n✅ 发布完成。后续步骤：');
  if(repoOk){
    console.log('  1. 提交 build.gradle、release/latest.apk、app-update/manifest.json，push');
    console.log('  2. 服务器 redeploy 的 git pull 会检测到 APK 变化并同步到 app-update/' + localApkName);
    console.log('  3. 本机体验：装 dist/tongshandagong-production-debug.apk');
  } else {
    console.log('  1. 提交 build.gradle 版本号与 app-update/manifest.json，push 后部署服务器');
    console.log('  2. ' + (serverOk
      ? '服务器上 ' + localApkName + ' 已由本次上传就位；/api/app/update 读取仓库里的 manifest'
      : '服务器未上传，客户端走 Release 地址；/api/app/update 读取仓库里的 manifest'));
    console.log('  3. 本机体验：装 dist/tongshandagong-production-debug.apk');
  }
})();