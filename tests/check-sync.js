/* =========================================================
 * 通山打拱 · 双副本一致性检查
 * public/js/{engine,ai}.js 必须是 js/ 下源文件的逐字节副本
 * （浏览器离线资源包也要同一份规则逻辑）。
 * 运行：node tests/check-sync.js （已挂入 npm test）
 * ========================================================= */
"use strict";
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const pairs = [
  ['js/engine.js', 'public/js/engine.js'],
  ['js/ai.js', 'public/js/ai.js'],
];
const sha = p => {
  try{
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');
  }catch(e){ return null; }
};
let pass = 0, fail = 0;
for(const [a, b] of pairs){
  const sa = sha(a), sb = sha(b);
  if(sa && sa === sb){ pass++; console.log('PASS 双副本一致：' + a + ' ⇄ ' + b); }
  else { fail++; console.log('FAIL 双副本不一致：' + a + ' vs ' + b + ' = ' + sa + ' / ' + sb); }
}
console.log(`\n结果：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);