/* =========================================================
 * 发布 APK（配应用内更新）：bump 版本 → 构建 → GitHub Release → 写 manifest
 *
 * 用法：
 *   GH_TOKEN=<repo 权限 token> node tools/release-apk.js --note "更新说明"
 *   GH_TOKEN=... node tools/release-apk.js --version 1.2.0
 *
 * 做了什么：
 *   1. android/app/build.gradle 的 versionCode+1、versionName 递增（可 --version 覆盖）
 *   2. 调 tools/build-apk.js 构建 production APK（dist/tongshandagong-production-debug.apk）
 *   3. 上传 APK 到 GitHub Release（tag vX.Y.Z），并写 app-update/manifest.json
 *      （apkUrl 指向 Release 下载地址；服务端 /api/app/update 据此提示更新）
 *
 * 仓库只提交 app-update/manifest.json（已从 gitignore 放行）；APK 不入库，由 GitHub Release 托管。
 * 没设置 GH_TOKEN 时只构建、不发布、不更新 manifest（避免指向不存在的 Release）。
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

// ---------- 3) 发布到 GitHub Release，并更新 app-update/manifest.json ----------
// APK 放 GitHub Release 托管；仓库里只提交几十字节的 manifest.json（APK 不入库）。
// 需要环境变量 GH_TOKEN（或 GITHUB_TOKEN），具备该仓库 Releases 写权限。
const note = argValue('--note') || '';
const repo = (process.env.APP_RELEASE_REPO || 'zhanghan4141-oss/tongshandagong').trim();
const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const tag = 'v' + versionName;
const assetName = `tongshandagong-${versionName}.apk`;
const assetUrl = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
const apiBase = `https://api.github.com/repos/${repo}`;

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

  let uploaded = false;
  if(!token){
    console.log('\n[release-apk] ⚠ 未设置 GH_TOKEN / GITHUB_TOKEN，跳过 GitHub Release 上传，也未更新 manifest。');
    console.log('  设置 token 后重跑同一命令即可：');
    console.log('    GH_TOKEN=<有 repo 权限的 token> node tools/release-apk.js --note "…"');
  } else {
    try{
      await publishRelease();
      uploaded = true;
      console.log(`\n[release-apk] 已发布 GitHub Release：${tag}（${repo}）`);
    }catch(e){
      console.error('[release-apk] GitHub Release 发布失败：' + (e && e.message ? e.message : e));
      process.exit(1);
    }
  }

  if(uploaded){
    const manifest = { version: versionName, note, apkUrl: assetUrl, publishedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(updDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log('[release-apk] 已写入 app-update/manifest.json（apkUrl → ' + assetUrl + '）');
  }

  console.log('\n✅ 发布完成。后续步骤：');
  console.log('  1. 提交 build.gradle 版本号' + (uploaded ? ' 与 app-update/manifest.json' : '') + '，push 后部署服务器');
  console.log('  2. 服务器只需 pull：/api/app/update 读取仓库里的 manifest，APK 由 GitHub Release 提供');
  console.log('  3. 本机体验：装 dist/tongshandagong-production-debug.apk');
})();