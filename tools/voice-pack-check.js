/* =========================================================
 * 本地语音包校验：检查 manifest.json 与音频文件是否齐全
 * 用法：node tools/voice-pack-check.js [manifest路径]
 * 默认：public/voice/manifest.json（相对 public/ 解析 base）
 * ========================================================= */
"use strict";
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const manifestPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(PUBLIC, 'voice', 'manifest.json');

// 引擎实际会播报的词条（整句键：张数-点数）
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const TOKENS = [
  ...RANKS.map(r=>'1-'+r), ...RANKS.map(r=>'2-'+r), ...RANKS.map(r=>'3-'+r),
  '1-W','2-W','3-W',
  ...[4,5,6,7,8,9,10,11,12].map(n=>n+'-W'),
  '连对','飞机','五十K',
  '过','不独','明独','插底','滚笼','继续继续','快点','明鸡','炸弹','不要'
];

function main(){
  if(!fs.existsSync(manifestPath)){
    console.error(`找不到 manifest：${manifestPath}`);
    console.error('请先执行： cp public/voice/manifest.example.json public/voice/manifest.json');
    process.exit(1);
  }
  let m;
  try{ m=JSON.parse(fs.readFileSync(manifestPath,'utf8')); }
  catch(e){ console.error('manifest JSON 解析失败：'+e.message); process.exit(1); }
  if(!m || !m.packs || typeof m.packs!=='object'){
    console.error('manifest 缺少 packs 字段'); process.exit(1);
  }

  let fail=0;
  for(const [name,pack] of Object.entries(m.packs)){
    const base = pack.base || ('voice/'+name+'/');
    const dir = path.join(PUBLIC, base);
    const files = pack.files || {};
    const missingTokens = TOKENS.filter(t=>!files[t]);
    const missingFiles = [];
    for(const [tok,file] of Object.entries(files)){
      const p = path.join(dir, file);
      if(!fs.existsSync(p)) missingFiles.push(`${tok} -> ${file}`);
    }
    console.log(`\n== 语音包 ${name}（${pack.label||''}）==`);
    console.log(`目录：${dir}`);
    console.log(`词条：${Object.keys(files).length}/${TOKENS.length}`);
    if(missingTokens.length) console.log('缺少词条（这些句子会回退 TTS）：'+missingTokens.join('、'));
    if(missingFiles.length){
      console.log('缺少音频文件：');
      missingFiles.forEach(x=>console.log('  - '+x));
      fail++;
    }
    if(!missingTokens.length && !missingFiles.length) console.log('✅ 语音包完整');
  }
  process.exit(fail?1:0);
}
main();
