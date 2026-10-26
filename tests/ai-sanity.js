/* =========================================================
 * 通山打拱 · AI 行为单测（Node）
 * 验证重点：王不乱出、快速跑掉、不炸队友、跟牌省王。
 * 运行：node tests/ai-sanity.js
 * ========================================================= */
const TS = require('../js/engine.js');
const TSAI = require('../js/ai.js');
let pass=0, fail=0;
const T=(n,c,d)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(d!==undefined?' => '+JSON.stringify(d):''));} };
const mkj=()=>({id:Math.random()*1e9,r:-1,s:-1,j:true});
const mk=(r)=> ({id:Math.random()*1e9,r:TS.RANK_OF[r],s:0,j:false});
const pickAI=(hand, leadPlay)=>{
  const G=TS.newGame(1);
  // 让测试者在 2 号位，清理无关状态
  G.mode='2v2'; G.landlord=0; G.partner=1;
  G.turn=2; G.lastSeat=-1; G.lastPlay=null; G.ended=false; G.confirming=false;
  G.seats[2].hand=hand;
  if(leadPlay){ G.lastPlay=leadPlay; G.lastSeat=2; G.passes=0; }
  return G;
};

/* 1) 领出：王不乱出 —— 有真实对子/小牌时不用王凑对或凑五十K */
{
  const hand=[mkj(),mkj(),mk('5'),mk('5'),mk('3'),mk('7'),mk('9'),mk('K'),mk('A')];
  const G=pickAI(hand, null);
  const ch=TSAI.aiChoose(G,2);
  T('领出不用王（出真实小牌而非王凑五十K/对子）',
    !!ch && ch.cards.every(c=>!c.j) && ch.cards.length===1,
    {cards:ch&&ch.cards.map(c=>c.j?'王':TS.RANKS[c.r])});
}

/* 2) 快速跑：整手一手可出完 → 直接整手甩（3,3,3,3,4,4,4,4 = 滚笼） */
{
  const hand=[mk('3'),mk('3'),mk('3'),mk('3'),mk('4'),mk('4'),mk('4'),mk('4')];
  const G=pickAI(hand, null);
  const ch=TSAI.aiChoose(G,2);
  T('手牌一言成滚笼 → 整手跑完', !!ch && ch.cards.length===hand.length, {n:ch&&ch.cards.length});
}

/* 2b) 快速甩：手多但有无番炸走小牌 → 领出甩掉无番炸（一次清 4 张） */
{
  const hand=[mk('5'),mk('5'),mk('5'),mk('5'),mk('8'),mk('9'),mk('J'),mk('Q')];
  const G=pickAI(hand, null);
  const ch=TSAI.aiChoose(G,2);
  T('手多时领出甩无番炸（清仓优先）', !!ch && ch.cards.length>=4, {n:ch&&ch.cards.length});
}

/* 3) 不炸队友：无跟牌轮队友刚出的牌，有炸也不压 */
{
  const hand=[mkj(),mkj(),mkj(),mkj(),mk('K'),mk('9'),mk('8'),mk('7')];
  const G=pickAI(hand, {type:'single',val:TS.RANK_OF['9']});
  G.lastSeat=3; // 3号是2号的队友（开局0/1为一队，2/3为一队）
  const ch=TSAI.aiChoose(G,2);
  T('队友出的牌有炸也不压（过）', ch===null, {ch:ch&&ch.play});
}

/* 4) 跟牌省王：对方出对K，只能用王凑对才能压 → 忍过 */
{
  const hand=[mkj(),mk('A'),mk('3'),mk('4'),mk('5'),mk('6'),mk('7'),mk('8')];
  const G=pickAI(hand, {type:'pair',val:TS.RANK_OF['K']});
  G.lastSeat=1; // 对手出的
  const ch=TSAI.aiChoose(G,2);
  T('跟牌不浪费王（对K用王凑对不压，过）', ch===null, {ch:ch&&ch.play});
}

/* 5) 对手近跑（2张）且有便宜炸 → 拦截 */
{
  const hand=[mk('8'),mk('8'),mk('8'),mk('8'),mk('3'),mk('4'),mk('5'),mk('6'),mk('7'),mk('9'),mk('J'),mk('Q')];
  const G=pickAI(hand, {type:'single',val:TS.RANK_OF['A']});
  G.lastSeat=1; // 对手（单A）
  G.seats[1].hand=[mk('2'),mk('2')]; // 对手只剩2张，快跑完
  const ch=TSAI.aiChoose(G,2);
  T('对手即将跑完时用炸拦截', !!ch && TS.isBomb(ch.play), {play:ch&&ch.play});
}

/* 6) 明独局：三个对手不能把明独者当队友 —— 明独者领出单3，AI 手有 A 要压 */
{
  const hand=[mk('A'),mk('3'),mk('4'),mk('5'),mk('6'),mk('7'),mk('8'),mk('9')];
  const G=pickAI(hand, {type:'single',val:TS.RANK_OF['3']});
  G.mode='hard'; G.hardSeat=0; G.lastSeat=0; // 明独者在 0 号领出单 3
  const ch=TSAI.aiChoose(G,2);
  T('明独局：AI 压明独者的单3（不再当他队友而"过"）', !!ch && ch.cards.length===1, {ch:ch&&ch.play});
}

console.log(`\n结果：${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);