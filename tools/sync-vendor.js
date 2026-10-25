/* =========================================================
 * 把服务端依赖里的浏览器端脚本复制到 public/vendor/
 *
 * 目的：Socket.IO 客户端原本由服务端在 /socket.io/socket.io.js 提供，
 *       App 用本地资源包时必须自带这份脚本，否则启动要依赖网络。
 *       版本取自 node_modules/socket.io，与服务端始终一致。
 * 运行：node tools/sync-vendor.js（npm run sync:vendor）
 * ========================================================= */
"use strict";
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js');
const destDir = path.join(root, 'public', 'vendor');
const dest = path.join(destDir, 'socket.io.min.js');

if(!fs.existsSync(src)){
  console.error('[sync-vendor] 找不到 ' + src + '，请先 npm install');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'socket.io', 'package.json'), 'utf8'));
console.log('[sync-vendor] socket.io ' + pkg.version + ' -> public/vendor/socket.io.min.js');
