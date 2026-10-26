/* =========================================================
 * 通山打拱 · 引擎测试（Node）
 * 运行：node tests/engine.test.js
 * ========================================================= */
const TS = require('../js/engine.js');
const TSAI = require('../js/ai.js');
const { analyzePlay, canBeat, bombTier, settleRound, doPlay, handlePass,
        newGame, declareHard, legalLead, buildDeck, deal, mulberry32, pointOf,
        confirmAdvance, hardBombBonusOf } = TS;
const { genCandidates, aiChoose, runSim } = TSAI;

// 快速通过确认轮（四家都不表态）
function passConfirm(G){
  if(!G.confirming) return G;
  let guard=0;
  while(G.confirming && guard++<8){
    const seat=G.turn;
    confirmAdvance(G,seat);
  }
  return G;
}

let pass=0, fail=0;
function T(name, cond, extra){ if(cond){pass++;console.log('PASS '+name);} else {fail++;console.log('FAIL '+name+(extra!==undefined?' => '+JSON.stringify(extra):''));} }
const mk=(r,s)=>Array.isArray(r)?r.map((x,i)=>mk(x,s)):({id:Math.random()*1e9,r:TS.RANK_OF[r],s:({S:0,H:1,C:2,D:3})[s],j:false});
const mkj=()=>({id:Math.random()*1e9,r:-1,s:-1,j:true});
const cards=(P)=>P.map(([r,s])=>mk(r,s)); // [['A','S'],...]

/* ===== 牌具 ===== */
{
  const deck=buildDeck();
  T('牌具112张', deck.length===112);
  T('8个王', deck.filter(c=>c.j).length===8);
  const hands=deal(mulberry32(42));
  T('4人各28张', hands.every(h=>h.length===28));
}
/* ===== 牌型识别 ===== */
{
  T('单张8', analyzePlay([mk('8','S')]).type==='single');
  T('单王算3(val0)', (p=>p.type==='single'&&p.val===0)(analyzePlay([mkj()])));
  T('对子', (p=>p.type==='pair')(analyzePlay([mk('8','S'),mk('8','H')])));
  T('王配牌成对', (p=>p.type==='pair')(analyzePlay([mk('8','S'),mkj()])));
  T('两王成对3', (p=>p.type==='pair'&&p.val===0)(analyzePlay([mkj(),mkj()])));
  T('三条', (p=>p.type==='triple')(analyzePlay([mk('9','S'),mk('9','H'),mk('9','C')])));
  T('两王+9=三条', (p=>p.type==='triple')(analyzePlay([mkj(),mkj(),mk('9','S')])));
  T('4张同牌=无番炸', (p=>p.type==='bomb'&&p.size===4&&p.fan===0)(analyzePlay([mk('8','S'),mk('8','H'),mk('8','C'),mk('8','D')])));
  T('6张同牌=无番炸', (p=>p.type==='bomb'&&p.size===6&&p.fan===0)(analyzePlay([mk('8','S'),mk('8','H'),mk('8','C'),mk('8','D'),mk('8','S'),mk('8','H')])));
  T('7张硬=2番', (p=>p.type==='bomb'&&p.size===7&&!p.soft&&p.fan===2)(analyzePlay([mk('8','S'),mk('8','H'),mk('8','C'),mk('8','D'),mk('8','S'),mk('8','H'),mk('8','C')])));
  T('7张软=1番', (p=>p.type==='bomb'&&p.size===7&&p.soft&&p.fan===1)(analyzePlay([mk('8','S'),mk('8','H'),mk('8','C'),mk('8','D'),mk('8','S'),mk('8','H'),mkj()])));
  T('8张(2副)=硬4番', (p=>p.type==='bomb'&&p.size===8&&p.fan===4)(analyzePlay([mk('8','S'),mk('8','H'),mk('8','C'),mk('8','D'),mk('8','S'),mk('8','H'),mk('8','C'),mk('8','D')])));
  T('8张软(6张2+2王)=2番', (p=>p.type==='bomb'&&p.size===8&&p.fan===2)(analyzePlay([mk('2','S'),mk('2','H'),mk('2','C'),mk('2','D'),mk('2','S'),mk('2','H'),mkj(),mkj()])));
  // 癞子可把同点数炸扩展到 8 张以上
  const eight8 = [['8','S'],['8','H'],['8','C'],['8','D'],['8','S'],['8','H'],['8','C'],['8','D']];
  T('9张软炸(8张8+1王)=4番', (p=>p.type==='bomb'&&p.size===9&&p.soft&&p.fan===4)(analyzePlay([...cards(eight8),mkj()])));
  T('10张软炸(8张8+2王)=8番', (p=>p.type==='bomb'&&p.size===10&&p.soft&&p.fan===8)(analyzePlay([...cards(eight8),mkj(),mkj()])));
  T('11张软炸(8张8+3王)=16番', (p=>p.type==='bomb'&&p.size===11&&p.soft&&p.fan===16)(analyzePlay([...cards(eight8),mkj(),mkj(),mkj()])));
  T('9个王炸=14番', (p=>p.type==='kingBomb'&&p.size===9&&p.fan===14)(analyzePlay([...Array(9)].map(()=>mkj()))));
  T('候选包含9张软炸', genCandidates([...cards(eight8),mkj()], null).some(c=>c.play.type==='bomb'&&c.play.size===9));
  // 笼数封顶
  const sixteen=[...cards(eight8),...Array.from({length:8},()=>mkj())]; // 8 张真牌 + 8 王
  T('无封顶：16张软炸=512番', analyzePlay(sixteen).fan===512);
  T('封顶32：16张软炸按32番', analyzePlay(sixteen,{fanCap:32}).fan===32);
  T('封顶64：16张软炸按64番', analyzePlay(sixteen,{fanCap:64}).fan===64);
  const q7=[['Q','S'],['Q','H'],['Q','C'],['Q','D'],['Q','S'],['Q','H'],['Q','C']];
  const j7=[['J','S'],['J','H'],['J','C'],['J','D'],['J','S'],['J','H'],['J','C']];
  T('7+7硬滚笼=16番', analyzePlay(cards([...q7,...j7])).fan===16);
  T('封顶8：7+7硬滚笼按8番', analyzePlay(cards([...q7,...j7]),{fanCap:8}).fan===8);
  T('封顶8：8王炸12番→8番', analyzePlay([...Array(8)].map(()=>mkj()),{fanCap:8}).fan===8);
  T('五十K同花', (p=>p.type==='fiftyK'&&p.tonghua&&p.suit===0)(analyzePlay([mk('5','S'),mk('10','S'),mk('K','S')])));
  T('杂五十K', (p=>p.type==='fiftyK'&&!p.tonghua)(analyzePlay([mk('5','S'),mk('10','H'),mk('K','C')])));
  T('五十K用王凑同花', (p=>p.type==='fiftyK'&&p.tonghua)(analyzePlay([mk('5','S'),mk('10','S'),mkj()])));
  // 五十K大炸：5/10/K 三类各 t 张，软2硬4，每升一级翻番
  const f50 = (t,soft)=>[ ...Array.from({length:t},()=>mk('5','S')).concat(Array.from({length:t},()=>mk('10','H'))).concat(Array.from({length:t},()=>mk('K','C'))) ];
  T('五十K大炸 4+4+4硬=4番', (p=>p.type==='fiftyCage'&&!p.soft&&p.fan===4)(analyzePlay(f50(4))));
  T('五十K大炸 5+5+5硬=8番', (p=>p.type==='fiftyCage'&&p.t===5&&p.fan===8)(analyzePlay(f50(5))));
  T('五十K大炸 4+4+4+1王=软2番', (p=>p.type==='fiftyCage'&&p.soft&&p.fan===2)(analyzePlay([...f50(4).slice(0,3),mkj(),...f50(4).slice(3)]
    .slice(0,12))));
  T('候选包含五十K大炸', genCandidates(f50(4), null).some(c=>c.play.type==='fiftyCage'));
  T('五十K大炸 5级>4级（同硬）', canBeat(analyzePlay(f50(4)), analyzePlay(f50(5)))===true);
  T('王炸4=4番', (p=>p.type==='kingBomb'&&p.fan===4)(analyzePlay([mkj(),mkj(),mkj(),mkj()])));
  T('王炸8=12番', (p=>p.type==='kingBomb'&&p.fan===12)(analyzePlay([mkj(),mkj(),mkj(),mkj(),mkj(),mkj(),mkj(),mkj()])));
  T('王炸同张数先出为大', canBeat(analyzePlay(Array(4).fill(mkj())), analyzePlay(Array(4).fill(mkj())))===false);
  T('王炸张数多者胜', canBeat(analyzePlay(Array(4).fill(mkj())), analyzePlay(Array(5).fill(mkj())))===true);
  T('滚笼4+4硬=2番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===2)(analyzePlay(cards([['A','S'],['A','H'],['A','C'],['A','D'],['K','S'],['K','H'],['K','C'],['K','D']]))));
  T('滚笼4+4软=1番', (p=>p.type==='rollcage'&&p.soft&&p.fan===1)(analyzePlay([...cards([['A','S'],['A','H'],['A','C'],['A','D'],['K','S'],['K','H'],['K','C']]),mkj()])));
  T('滚笼5+5硬=4番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===4)(analyzePlay(cards([['A','S'],['A','H'],['A','C'],['A','D'],['A','S'],['K','S'],['K','H'],['K','C'],['K','D'],['K','S']]))));
  T('滚笼6+6硬=8番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===8)(analyzePlay(cards([['Q','S'],['Q','H'],['Q','C'],['Q','D'],['Q','S'],['Q','H'],['J','S'],['J','H'],['J','C'],['J','D'],['J','S'],['J','H']]))));
  T('滚笼7+7硬=16番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===16)(analyzePlay(cards([['Q','S'],['Q','H'],['Q','C'],['Q','D'],['Q','S'],['Q','H'],['Q','C'],['J','S'],['J','H'],['J','C'],['J','D'],['J','S'],['J','H'],['J','C']]))));
  T('滚笼8+8硬=32番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===32)(analyzePlay(cards([['A','S'],['A','H'],['A','C'],['A','D'],['A','S'],['A','H'],['A','C'],['A','D'],['2','S'],['2','H'],['2','C'],['2','D'],['2','S'],['2','H'],['2','C'],['2','D']]))));
  T('滚笼4+4+4硬=4番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===4)(analyzePlay(cards([['A','S'],['A','H'],['A','C'],['A','D'],['K','S'],['K','H'],['K','C'],['K','D'],['Q','S'],['Q','H'],['Q','C'],['Q','D']]))));
  T('滚笼4+4+4+4硬=8番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===8)(analyzePlay(cards([['A','S'],['A','H'],['A','C'],['A','D'],['K','S'],['K','H'],['K','C'],['K','D'],['Q','S'],['Q','H'],['Q','C'],['Q','D'],['J','S'],['J','H'],['J','C'],['J','D']]))));
  T('滚笼跨A-2(AAAA 2222)=硬2番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===2)(analyzePlay(cards([['A','S'],['A','H'],['A','C'],['A','D'],['2','S'],['2','H'],['2','C'],['2','D']]))));
  T('K-A-2三连滚笼合法', (p=>p.type==='rollcage')(analyzePlay(cards([['K','S'],['K','H'],['K','C'],['K','D'],['A','S'],['A','H'],['A','C'],['A','D'],['2','S'],['2','H'],['2','C'],['2','D']]))));
  T('滚笼2222 3333(环形2-3相邻)=硬2番', (p=>p.type==='rollcage'&&!p.soft&&p.fan===2)(analyzePlay(cards([['2','S'],['2','H'],['2','C'],['2','D'],['3','S'],['3','H'],['3','C'],['3','D']]))));
  T('滚笼2222 3333 4444=4番', (p=>p.type==='rollcage'&&p.fan===4)(analyzePlay(cards([['2','S'],['2','H'],['2','C'],['2','D'],['3','S'],['3','H'],['3','C'],['3','D'],['4','S'],['4','H'],['4','C'],['4','D']]))));
  T('环形滚笼2222 3333 压得过 AAAA 2222(2>11)', (()=>{
    const a=analyzePlay(cards([['2','S'],['2','H'],['2','C'],['2','D'],['3','S'],['3','H'],['3','C'],['3','D']]));
    const b=analyzePlay(cards([['A','S'],['A','H'],['A','C'],['A','D'],['2','S'],['2','H'],['2','C'],['2','D']]));
    return canBeat(b,a);
  })());
  T('连对', (p=>p.type==='seqPair')(analyzePlay(cards([['4','S'],['4','H'],['5','S'],['5','H']]))));
  T('连对不含2', analyzePlay(cards([['2','S'],['2','H'],['3','S'],['3','H']]))===null);
  T('连对K-A合法', (p=>p.type==='seqPair'&&p.top===11)(analyzePlay(cards([['K','S'],['K','H'],['A','S'],['A','H']]))));
  T('飞机', (p=>p.type==='airplane')(analyzePlay(cards([['7','S'],['7','H'],['7','C'],['8','S'],['8','H'],['8','C']]))));
  T('飞机不含2', analyzePlay(cards([['2','S'],['2','H'],['2','C'],['3','S'],['3','H'],['3','C']]))===null);
  T('三带一非法', analyzePlay(cards([['7','S'],['7','H'],['7','C'],['8','S']]))===null);
}
/* ===== 大小比较 ===== */
{
  const roll=(arr)=>analyzePlay(cards(arr));
  const rc=(start,k,s,soft)=>({type:'rollcage',s,k,start,len:k,top:start+k-1,soft,fan:soft?Math.pow(2,(s-4)+(k-2)):2*Math.pow(2,(s-4)+(k-2))});
  // NULL 测试：直接构造等番滚笼对象
  // 同番：点数高者胜（逐级比）
  T('AAAA KKKK > 5555 4444(逐级比点数)', canBeat(rc(4,2,4,false), rc(10,2,4,false)));            // prev 5555 4444 (start4), next AAAA KKKK(start10)
  T('5555 4444 不能压 AAAA KKKK', !canBeat(rc(10,2,4,false), rc(4,2,4,false)));
  T('3333 4444 不能压 AAAA KKKK', !canBeat(rc(10,2,4,false), rc(3,2,4,false)));
  T('7张(at rank8) 压不过 4+4滚笼(start9)', !canBeat(rc(9,2,4,false), {type:'bomb',size:7,rank:8,soft:false,fan:2})); // prev滚笼9999 8888, next 7张炸rank8
  T('4+4滚笼(start9) 压过 7张炸(at rank8)', canBeat({type:'bomb',size:7,rank:8,soft:false,fan:2}, rc(9,2,4,false)));
  T('王炸同番最大(4王压6+6软4番)', canBeat(rc(3,2,6,true), {type:'kingBomb',size:4,fan:4}));        // prev 6+6软(4番) next 4王(4番)
  T('4王压不过5王', canBeat({type:'kingBomb',size:4,fan:4},{type:'kingBomb',size:5,fan:6}) );
  T('8王(12番)压不过8+8硬(32番)→番高者大', canBeat({type:'kingBomb',size:8,fan:12},{type:'rollcage',s:8,k:2,start:11,len:2,top:12,soft:false,fan:32}));
  {
    const e8=[['8','S'],['8','H'],['8','C'],['8','D'],['8','S'],['8','H'],['8','C'],['8','D']];
    T('10张软炸压9张软炸(番高者大)', canBeat(
      analyzePlay([...cards(e8),mkj()]),
      analyzePlay([...cards(e8),mkj(),mkj()])
    ));
  }
  T('无番炸压五十K', canBeat(roll([['5','S'],['10','H'],['K','C']]), {type:'bomb',size:4,rank:8,soft:false,fan:0}));
  T('五十K不能压4炸', !canBeat({type:'bomb',size:4,rank:8,soft:false,fan:0}, roll([['5','S'],['10','H'],['K','C']])));
  T('黑桃五十K压方块五十K', canBeat(roll([['5','D'],['10','D'],['K','D']]), roll([['5','S'],['10','S'],['K','S']])));
  T('同花五十K压杂五十K', canBeat(roll([['5','S'],['10','H'],['K','C']]), roll([['5','S'],['10','S'],['K','S']])));
  T('杂五十K先出为大', !canBeat(roll([['5','S'],['10','H'],['K','C']]), roll([['5','H'],['10','C'],['K','S']])));
  T('单2压A', canBeat(analyzePlay([mk('A','S')]), analyzePlay([mk('2','S')])));
  T('连对比顶', canBeat(analyzePlay(cards([['7','S'],['7','H'],['8','S'],['8','H']])), analyzePlay(cards([['8','S'],['8','H'],['9','S'],['9','H']]))));
  T('飞机比点数', canBeat(analyzePlay(cards([['7','S'],['7','H'],['7','C'],['8','S'],['8','H'],['8','C']])), analyzePlay(cards([['8','S'],['8','H'],['8','C'],['9','S'],['9','H'],['9','C']]))));
  T('单5压单3', canBeat(analyzePlay([mk('3','S')]), analyzePlay([mk('5','S')])));
  T('同类型不同长度不能比(连对3连vs2连)', !canBeat(analyzePlay(cards([['5','S'],['5','H'],['6','S'],['6','H']])), analyzePlay(cards([['6','S'],['6','H'],['7','S'],['7','H'],['8','S'],['8','H']]))));
  T('无番炸可领出（需求放开）', legalLead(newGame(1), {type:'bomb',size:4,rank:8,soft:false,fan:0})===true);
  T('滚笼可领出', legalLead(newGame(1), {type:'rollcage',s:4,k:2,start:0,len:2,top:1,soft:false,fan:2})===true);
}
/* ===== 结算 ===== */
function mkGame(seed){
  const G=newGame(seed);
  // 受控：庄=0，对家=1
  G.landlord=0; G.partner=1; G.mode='2v2';
  G.seats[0].isLandlord=true; G.seats[1].isPartner=true;
  // 清零奖金字段，避免随机发牌触发王奖金/硬炸奖金干扰基础结算测试（各有独立用例）
  for(const s of G.seats){ s.kings=0; s.hardBombBonus=0; }
  return G;
}
function setOut(G,seats){ for(const i of seats){ G.seats[i].out=true; } }
// 场景1：庄队(0,1)跑完，客队(2,3)0分 → basePer=2（每人2番），无滚笼
{
  const G=mkGame(7); setOut(G,[0,1]); G.seats[2].caught=0; G.seats[3].caught=0; G.firstOut=0;
  const s=settleRound(G);
  T('结算1 客队0分：basePer=2', Math.abs(s.basePer-2)<1e-9);
  T('结算1 各输家各输2番(不除二)', Math.abs(s.perSeat[2]+2)<1e-9 && Math.abs(s.perSeat[3]+2)<1e-9);
  T('结算1 赢家各收2番', Math.abs(s.perSeat[0]-2)<1e-9 && Math.abs(s.perSeat[1]-2)<1e-9);
  T('结算1 perFen 半番=1分→2番=4分', s.perFen[0]===4 && s.perFen[2]===-4);
}
// 场景2：庄队跑完，客队有分 → basePer=1
{
  const G=mkGame(8); setOut(G,[0,1]); G.seats[2].caught=15; G.seats[3].caught=0;
  const s=settleRound(G);
  T('结算2 客队有分：basePer=1', Math.abs(s.basePer-1)<1e-9);
  T('结算2 各输1番', Math.abs(s.perSeat[2]+1)<1e-9);
}
// 场景3：客队跑了一个(3号)剩2号末游且客队抓到分 → 输队没跑人数=1 → basePer=0.5
{
  const G=mkGame(9); setOut(G,[0,1,3]); G.seats[2].caught=10; G.seats[3].caught=0;
  const s=settleRound(G);
  T('结算3 跑了一个：basePer=0.5', Math.abs(s.basePer-0.5)<1e-9);
  T('结算3 各输半番', Math.abs(s.perSeat[2]+0.5)<1e-9 && Math.abs(s.perSeat[3]+0.5)<1e-9);
}
// 场景3b：设好名次后，没有一游那一队的尾游（2号，唯一没跑完的）抓分归对家；
//          手里没出的牌的分不算（那些牌没打出来）
{
  const G=mkGame(9); setOut(G,[0,1,3]); G.seats[2].caught=10; G.seats[3].caught=0;
  G.seats[0].outOrder=1; G.seats[1].outOrder=2; G.seats[3].outOrder=3; // 一游=0
  // 尾游手里还剩 5 + K = 15 分（不应该被算进去）
  G.seats[2].hand=[{id:9001,r:TS.RANK_OF['5'],s:0,j:false},{id:9002,r:TS.RANK_OF['K'],s:1,j:false}];
  const s=settleRound(G);
  T('结算3b 尾游抓分归零', s.effCaught[2]===0, s.effCaught);
  T('结算3b 尾游抓分归一游，不含手里牌分', s.effCaught[0]===10, s.effCaught);
  T('结算3b 输方归属后0分→翻倍 basePer=1', Math.abs(s.basePer-1)<1e-9, s.basePer);
  T('结算3b 原始抓分仍保留在 caught 里', s.caught[2]===10, s.caught);
}
// 场景4：滚笼归属——2号(客队)打过2番滚笼且跑完→归客队(L)？ 注意规则：跑完→算自己队
//   2号跑了→L=2 → Δ=-2（W=0,L=2）→ 庄队反而要承担？ 不——赢了牌的庄队净额=base+Δ
{
  const G=mkGame(10); setOut(G,[0,1]); G.seats[2].caught=15; G.seats[2].rollcages.push({fan:2}); // 2号客队没跑→归庄队 W
  const s=settleRound(G);
  T('结算4 客队滚笼未跑归庄队 W=2', Math.abs(s.W-2)<1e-9);
  T('结算4 Δ=2，输家各输1+2=3番', Math.abs(s.perSeat[2]+3)<1e-9);
}
// 场景5：庄队有人打滚笼且跑了→归庄队
{
  const G=mkGame(11); setOut(G,[0,1]); G.seats[0].rollcages.push({fan:4}); G.seats[2].caught=15;
  const s=settleRound(G);
  T('结算5 庄队滚笼跑了算自己 W=4', Math.abs(s.W-4)<1e-9);
  T('结算5 输家各输1+4=5番', Math.abs(s.perSeat[2]+5)<1e-9);
}
// 场景6：Δ为负不封底——客队滚笼打且跑完归自己队，庄队反而整体为负
{
  const G=mkGame(12); setOut(G,[0,1,3]); G.seats[3].caught=15; // 客队3号跑了(三游)
  G.seats[3].rollcages.push({fan:8}); // 3号跑完→滚笼归客队(L=8)
  const s=settleRound(G);
  // 赢队庄队：basePer=0.5(输队没跑人数=1) → 2人同值 0.5+(-8)=-7.5番(负=倒付)
  T('结算6 Δ=-8 庄队整体为负(不封底)', Math.abs(s.perSeat[0]+7.5)<1e-9 && Math.abs(s.perSeat[1]+7.5)<1e-9);
  T('结算6 输家客队倒收', Math.abs(s.perSeat[2]-7.5)<1e-9 && Math.abs(s.perSeat[3]-7.5)<1e-9);
}
// 硬牌
{
  const G=mkGame(13); G.mode='hard'; G.hardSeat=0; setOut(G,[0]); // 硬牌者一游→胜
  const s=settleRound(G);
  T('硬牌者胜：三家各输2番', Math.abs(s.perSeat[1]+2)<1e-9 && Math.abs(s.perSeat[2]+2)<1e-9 && Math.abs(s.perSeat[3]+2)<1e-9 && Math.abs(s.perSeat[0]-6)<1e-9);
}
{
  const G=mkGame(14); G.mode='hard'; G.hardSeat=0; setOut(G,[1]); // 任一对方先跑→硬牌者负
  const s=settleRound(G);
  T('硬牌者败：向三家各输2番', Math.abs(s.perSeat[0]+6)<1e-9 && Math.abs(s.perSeat[1]-2)<1e-9);
}
{
  const G=mkGame(15); G.mode='hard'; G.hardSeat=0; setOut(G,[0]);
  G.seats[1].rollcages.push({fan:2}); // 客队打的滚笼没跑→归硬牌者队 W
  G.seats[0].rollcages.push({fan:4}); // 硬牌者滚笼跑完→归自己 W
  const s=settleRound(G);
  T('硬牌滚笼归属 W=4+2=6', Math.abs(s.W-6)<1e-9);
  T('硬牌者胜+Δ=6：收到 6+3*6=24番', Math.abs(s.perSeat[0]-24)<1e-9);
}

/* ===== 接风 / 顺风（跑完者无人接牌） ===== */function mkPassScene(revealed){
  const G=mkGame(777);
  // 构造：庄家0打完最后一手已跑完，其余三人1/2/3都在等，一圈近乎结束
  G.lastSeat=0; G.passes=2; // 已有两家 pass
  G.seats[0].out=true; G.seats[0].outOrder=1;
  G.revealed=revealed;
  G.lastPlay={type:'single',val:12}; G.lastCards=[mk('2','S')];
  return G;
}
{
  // 未明鸡 → 下家顺风（下家为1号）
  const G=mkPassScene(false);
  TS.handlePass(G, 3); // 第3家pass，凑满一圈
  T('接风 未明鸡→下家(1号)', G.turn===1);
}
{
  // 明鸡已公开 → 队友(1号)带风
  const G=mkPassScene(true);
  G.partner=1; G.seats[1].isPartner=true;
  TS.handlePass(G, 3);
  T('接风 明鸡→队友(1号)', G.turn===1);
}
{
  // 明鸡已公开但队友已跑完 → 回到下一位活跃者
  const G=mkPassScene(true);
  G.partner=1; G.seats[1].isPartner=true;
  G.seats[1].out=true; G.seats[1].outOrder=2;
  TS.handlePass(G, 3);
  T('接风 明鸡队友已跑→下一位', G.turn===2);
}
{
  // 反向：跑完的是对家(1号)，明鸡公开 → 庄家(0)带风接手
  const G=mkGame(778);
  G.lastSeat=1; G.passes=2;
  G.seats[1].out=true; G.seats[1].outOrder=1;
  G.partner=1; G.seats[1].isPartner=true;
  G.revealed=true;
  G.lastPlay={type:'single',val:12}; G.lastCards=[mk('2','S')];
  TS.handlePass(G, 3);
  T('接风 跑完的是对家→庄家(0)带风', G.turn===0);
}
/* ===== 出牌流程 ===== */
{
  const G=newGame(123);
  passConfirm(G); // 过确认轮
  // 领出无番炸：已放开，应可出
  const seat=G.turn;
  const hand=G.seats[seat].hand;
  const bombCards=hand.filter(c=>!c.j).slice(0,4);
  if(bombCards.length===4){
    const p=analyzePlay(bombCards);
    if(p&&p.type==='bomb'&&p.size<=6){
      const r=doPlay(G,seat,bombCards);
      T('流程 领出无番炸允许', r.ok===true);
    }
  }
  // 分数累计：出 5/10/K 计入 trickPoints
  {
    const G2=newGame(321);
    passConfirm(G2);
    const leader=G2.turn; const LS=G2.seats[leader];
    const c3={id:9001,r:0,s:0,j:false}; LS.hand.push(c3);
    const t0=G2.trickPoints;
    TS.doPlay(G2,leader,[c3]);
    const t1=G2.trickPoints;
    const c10={id:9002,r:7,s:0,j:false}; LS.hand.push(c10);
    G2.turn=leader; TS.doPlay(G2,leader,[c10]); // 绕回合限制，测累计
    const t2=G2.trickPoints;
    T('流程 出3不累加分', t1===t0);
    T('流程 出10累加10分', t2-t1===10);
  }
}
/* ===== 对局冒烟 & 模拟 ===== */
{
  const G=newGame(2026);
  passConfirm(G); // 过确认轮
  let guard=0, n=0;
  while(!G.ended && guard++<2000){
    const seat=G.turn;
    if(G.seats[seat].out){ TS.advanceTurn(G); continue; }
    const ch=TSAI.aiChoose(G,seat);
    if(ch===null){ if(G.lastPlay) TS.handlePass(G,seat); else T('流程 AI在领出时不应过',false,{ch}); TS.advanceTurn(G); }
    else { const r=TS.doPlay(G,seat,ch.cards); if(!r.ok){ T('流程 doPlay应成功',false,r); break; } }
    n++;
  }
  T('流程 随机局2000步内结束', G.ended===true);
  if(G.ended){
    const s=settleRound(G);
    T('流程 结算和为零', Math.abs(s.perSeat[0]+s.perSeat[1]+s.perSeat[2]+s.perSeat[3])<1e-6);
    T('流程 分数数值合理', [0,1,2,3].every(i=>isFinite(s.perFen[i])));
  }
}
{
  let allEnded=true, sum0=true;
  for(let seed=0;seed<30;seed++){
    const G=newGame(seed*999+7);
    passConfirm(G); // 过确认轮（暂不许硬牌，测 2V2 主流程）
    let guard=0, n=0;
    while(!G.ended && guard++<3000){
      const seat=G.turn;
      if(G.seats[seat].out){ TS.advanceTurn(G); continue; }
      const ch=TSAI.aiChoose(G,seat);
      if(ch===null){ if(G.lastPlay) TS.handlePass(G,seat); TS.advanceTurn(G); }
      else { const r=TS.doPlay(G,seat,ch.cards); if(!r.ok){ allEnded=false; break; } }
      n++;
    }
    if(!G.ended){ allEnded=false; }
    if(G.ended){
      const s=settleRound(G);
      const tot=s.perSeat[0]+s.perSeat[1]+s.perSeat[2]+s.perSeat[3];
      if(Math.abs(tot)>1e-6) sum0=false;
    }
  }
  T('模拟 30局全结束', allEnded);
  T('模拟 30局结算和均归零', sum0);
}
/* ===== passSeq：每次"不要"递增（播报用，不改流程） ===== */
{
  const G=newGame(889);
  passConfirm(G);
  const seq0=G.passSeq||0;
  G.lastPlay={type:'single',val:1}; G.lastSeat=0; G.leader=0; G.turn=1; G.passes=0;
  for(const s of G.seats) s.out=false;
  TS.handlePass(G,1);
  T('passSeq：一次不要 +1', (G.passSeq||0)===seq0+1);
  TS.handlePass(G,2);
  T('passSeq：同一轮再次不要也 +1', (G.passSeq||0)===seq0+2);
}
/* ===== 确认轮 & 硬牌轮 ===== */
{
  const G=newGame(555);
  T('确认轮：新局在 confirming 状态', G.confirming===true);
  T('确认轮：确认轮中不能直接出牌', doPlay(G,G.turn,[mk('3','S')]).ok===false);
  // 各家确认
  let guard=0; while(G.confirming && guard++<8){ const s=G.turn; confirmAdvance(G,s); }
  T('确认轮：四家确认后进入出牌', G.confirming===false && G.turn===G.landlord);
  T('确认轮：过确认后可出牌', doPlay(G,G.turn,[...G.seats[G.turn].hand].slice(0,1)).ok===true);
}
/* ===== 有番数的炸都计入 rollcages 统计 ===== */
{
  const G=newGame(31);
  passConfirm(G);
  const seat=G.turn;
  // 注入 4 张王打王炸（有番）
  const kings=[mkj(),mkj(),mkj(),mkj()];
  G.seats[seat].hand=G.seats[seat].hand.concat(kings);
  const r=doPlay(G,seat,kings);
  T('王炸出牌后计入 rollcages', r.ok && G.seats[seat].rollcages.length===1 && G.seats[seat].rollcages[0].fan>=4);
}
{
  const G=newGame(32);
  passConfirm(G);
  const seat=G.turn;
  // 注入 7 张同牌打 7 张番炸（有番）
  const c8=cards([['8','S'],['8','H'],['8','C'],['8','D'],['8','S'],['8','H'],['8','C']]);
  G.seats[seat].hand=G.seats[seat].hand.concat(c8);
  const r=doPlay(G,seat,c8);
  T('7张番炸计入 rollcages', r.ok && G.seats[seat].rollcages.length===1 && G.seats[seat].rollcages[0].fan===2);
}
/* ===== 和牌（整局重发） ===== */
{
  const G=newGame(777);
  const fresh=TS.declareRestart(G);
  T('和牌：重发新局', fresh!==G && fresh.confirming===true && fresh.seats.every(s=>s.hand.length===28));
}
/* ===== 和牌/毁牌重发：保 roundNo、随机换牌、沿用 cfg ===== */
{
  const G=newGame(41, {kings:12, fanCap:32});
  G.roundNo=5;
  const fresh=TS.declareRestart(G, {kings:12, fanCap:32}, 999);
  T('重发保留 roundNo', fresh!==G && fresh.roundNo===5);
  T('重发换了发牌（不再沿用旧种子同牌）', (()=>{
    const key=g=>g.seats.map(s=>s.hand.map(c=>c.r+':'+c.s).join(',')).join('|');
    return key(fresh)!==key(G);
  })());
  T('重发沿用房间设置（cfg 进入新局）', fresh.cfg && fresh.cfg.kings===12 && fresh.cfg.fanCap===32);
  const fresh2=TS.declareRestart(G, undefined, 7);
  T('无 cfg 兜底：仍换牌且保 roundNo', fresh2!==G && fresh2.roundNo===5);
}
/* ===== 王奖金 ===== */
{
  const G=mkGame(51);
  // seat0: 4王一游 → 收三人各1番；seat1: 5王四游 → 无奖金
  G.seats[0].kings=4; G.seats[0].out=true; G.seats[0].outOrder=1; G.seats[0].caught=20;
  G.seats[1].kings=5; G.seats[1].out=true; G.seats[1].outOrder=4; G.seats[1].caught=0;
  G.seats[2].out=true; G.seats[2].outOrder=2; G.seats[2].caught=0;
  G.seats[3].out=true; G.seats[3].outOrder=3; G.seats[3].caught=0;
  const s=settleRound(G);
  T('王奖金：4王一游收3番', Math.abs(s.perSeat[0]-3)<1e-9 && s.kingBonus[0]===1);
  T('王奖金：5王四游无奖金', s.kingBonus[1]===undefined && Math.abs(s.perSeat[1]+1)<1e-9); // perSeat[1] 含基础输1番
}
{
  const G=mkGame(52);
  G.seats[0].kings=5; G.seats[0].out=true; G.seats[0].outOrder=2; G.seats[0].caught=10;
  G.seats[1].out=true; G.seats[1].outOrder=1; G.seats[1].caught=0;
  G.seats[2].out=true; G.seats[2].outOrder=3; G.seats[2].caught=0;
  G.seats[3].out=true; G.seats[3].outOrder=4; G.seats[3].caught=0;
  const s=settleRound(G);
  // seat0 赢队、基础0 + 王奖金(5王=2番×3人=6番) = +6
  T('王奖金：5王二游+基础0=6番', Math.abs(s.perSeat[0]-6)<1e-9 && s.kingBonus[0]===2);
}
/* ===== 王奖金：未跑也有奖金（决策 D：四游不可达，改为未跑可拿） ===== */
{
  const G=mkGame(82);
  G.seats[0].kings=4; G.seats[0].out=true; G.seats[0].outOrder=1; G.seats[0].caught=10;
  G.seats[1].kings=4; G.seats[1].out=false;                     // 未跑
  G.seats[2].out=true; G.seats[2].outOrder=2; G.seats[2].caught=0;
  G.seats[3].out=true; G.seats[3].outOrder=3; G.seats[3].caught=0;
  G.cfg={tailBonus:true};
  const s=settleRound(G);
  T('王奖金：未跑也有奖金（开关开）', s.kingBonus[1]===1 && s.kingBonus[0]===1);
}
{
  const G=mkGame(83);
  G.seats[0].kings=4; G.seats[0].out=true; G.seats[0].outOrder=1; G.seats[0].caught=10;
  G.seats[1].kings=4; G.seats[1].out=false;                     // 未跑
  G.seats[2].out=true; G.seats[2].outOrder=2; G.seats[2].caught=0;
  G.seats[3].out=true; G.seats[3].outOrder=3; G.seats[3].caught=0;
  G.cfg={tailBonus:false};
  const s=settleRound(G);
  T('王奖金：未跑者开关未开不拿', s.kingBonus[1]===undefined);
}
/* ===== 王奖金：未跑也有奖金（决策 D：四游不可达，改为未跑可拿） ===== */
{
  const G=mkGame(82);
  G.seats[0].kings=4; G.seats[0].out=true; G.seats[0].outOrder=1; G.seats[0].caught=10;
  G.seats[1].kings=4; G.seats[1].out=false;                     // 未跑
  G.seats[2].out=true; G.seats[2].outOrder=2; G.seats[2].caught=0;
  G.seats[3].out=true; G.seats[3].outOrder=3; G.seats[3].caught=0;
  G.cfg={tailBonus:true};
  const s=settleRound(G);
  T('王奖金：未跑也有奖金（开关开）', s.kingBonus[1]===1 && s.kingBonus[0]===1);
}
{
  const G=mkGame(83);
  G.seats[0].kings=4; G.seats[0].out=true; G.seats[0].outOrder=1; G.seats[0].caught=10;
  G.seats[1].kings=4; G.seats[1].out=false;                     // 未跑
  G.seats[2].out=true; G.seats[2].outOrder=2; G.seats[2].caught=0;
  G.seats[3].out=true; G.seats[3].outOrder=3; G.seats[3].caught=0;
  G.cfg={tailBonus:false};
  const s=settleRound(G);
  T('王奖金：未跑者开关未开不拿', s.kingBonus[1]===undefined);
}
/* ===== 硬炸奖金（起到 7/8 张纯牌同点） ===== */
{
  const seven=cards([['8','S'],['8','H'],['8','C'],['8','D'],['8','S'],['8','H'],['8','C']]);
  const eight=cards([['9','S'],['9','H'],['9','C'],['9','D'],['9','S'],['9','H'],['9','C'],['9','D']]);
  T('硬炸奖：7张纯牌=1', hardBombBonusOf(seven)===1);
  T('硬炸奖：8张纯牌=2', hardBombBonusOf(eight)===2);
  T('硬炸奖：7张纯牌+1王仍算7张=1', hardBombBonusOf([...seven,mkj()])===1);
  T('硬炸奖：纯王不算', hardBombBonusOf([...Array(8)].map(()=>mkj()))===0);
  T('硬炸奖：6张+2王不算', hardBombBonusOf([...cards([['8','S'],['8','H'],['8','C'],['8','D'],['8','S'],['8','H']]),mkj(),mkj()])===0);
  T('硬炸奖：两门7张累加=2', hardBombBonusOf([...seven,...cards([['9','S'],['9','H'],['9','C'],['9','D'],['9','S'],['9','H'],['9','C']])])===2);
}
{
  const G=mkGame(53);
  // seat0: 7张硬炸一游 → 其他三家各1番；seat1: 8张硬炸但四游 → 无奖金
  G.seats[0].hardBombBonus=1; G.seats[0].out=true; G.seats[0].outOrder=1; G.seats[0].caught=20;
  G.seats[1].hardBombBonus=2; G.seats[1].out=true; G.seats[1].outOrder=4; G.seats[1].caught=0;
  G.seats[2].out=true; G.seats[2].outOrder=2; G.seats[2].caught=0;
  G.seats[3].out=true; G.seats[3].outOrder=3; G.seats[3].caught=0;
  const s=settleRound(G);
  T('硬炸奖：7张一游收3番', Math.abs(s.perSeat[0]-3)<1e-9 && s.bombBonus[0]===1);
  T('硬炸奖：8张四游无奖金(仍需付他人1番)', s.bombBonus[1]===undefined && Math.abs(s.perSeat[1]+1)<1e-9);
  T('硬炸奖：其他三家各扣1番', Math.abs(s.perSeat[2]+1)<1e-9 && Math.abs(s.perSeat[3]+1)<1e-9);
}
/* ===== 硬牌结束判定 ===== */
{
  const G=newGame(61);
  G.mode='hard'; G.hardSeat=0;
  G.seats[0].out=true;
  T('硬牌：明独者一游结束', TS.modeEnded(G)===true);
  G.seats[0].out=false;
  G.seats[2].out=true;
  T('硬牌：任一对方先跑结束', TS.modeEnded(G)===true);
  G.seats[2].out=false;
  T('硬牌：都没跑未结束', TS.modeEnded(G)===false);
}

/* ===== 出牌规范化 / 去重（防牌对象伪造） ===== */
{
  const G=newGame(7); passConfirm(G);
  const seat=G.turn, S=G.seats[seat];
  const one=S.hand[0];
  T('去重：同一张 id 出两次被拒', doPlay(G,seat,[one,one]).ok===false);
  const forged=Object.assign({},one,{r:12,s:3}); // 伪造字段：把真实牌改成“2”
  const rf=doPlay(G,seat,[forged]);
  T('伪造字段：按手里真实牌判定(不受 r 修改影响)', rf.ok===true && G.seats[seat].lastCards[0]===one);
  T('规范化：不在手牌的 id 被拒', doPlay(G,seat,[{id:999999,r:12,s:0,j:false}]).ok===false);
  T('规范化：缺 id 的牌被拒', doPlay(G,seat,[{r:12,s:0,j:false}]).ok===false);
  T('规范化：非数组被拒', doPlay(G,seat,'x').ok===false);
  T('规范化：空数组不能出', doPlay(G,seat,[]).ok===false);
}
{
  T('规范化：混入 null 被拒', (()=>{
    const G2=newGame(9); passConfirm(G2);
    const s2=G2.turn;
    return doPlay(G2,s2,[G2.seats[s2].hand[0],null]).ok===false;
  })());
  T('analyzePlay：非数组→null', analyzePlay(null)===null);
  T('analyzePlay：混入 null→null', analyzePlay([mk('3','S'),null])===null);
}

/* ===== 确认轮：回合与幂等（防乱序/重复表态） ===== */
{
  {
    const G=newGame(3);
    const first=G.turn, other=(first+1)%4;
    T('确认轮：未轮到的人表态被拒', TS.confirmChoice(G, other, 'pass')===false);
    T('确认轮：被拒后 confirms 不变', G.confirms.length===0);
  }
  {
    const G=newGame(4);
    const s=G.turn;
    TS.confirmChoice(G, s, 'pass');
    T('确认轮：同一人重复表态被拒', TS.confirmChoice(G, s, 'pass')===false && G.confirms.length===1);
  }
  {
    const G=newGame(22);
    const s=G.turn;
    T('确认轮：轮到的人可表态', TS.confirmChoice(G, s, 'pass')===true);
  }
}
{
  const G=newGame(23); passConfirm(G);
  T('确认轮结束后不能再表态', TS.confirmChoice(G, G.landlord, 'pass')===false);
}

/* ===== 明独（硬牌）队伍归属（teamOf） ===== */
{
  const G=newGame(31); G.mode='hard'; G.hardSeat=1;
  T('明独：明独者一人成队', (()=>{ const t=TS.teamOf(G,G.hardSeat); return t.length===1 && t[0]===G.hardSeat; })());
  for(const i of [0,2,3]){
    const t=TS.teamOf(G,i);
    const exp=[0,1,2,3].filter(k=>k!==G.hardSeat);
    T('明独：非明独者与其余三家成队(i='+i+')', t.length===3 && exp.every(k=>t.includes(k)));
  }
}

/* ===== cfg 全链路：候选/提示与房间设置一致（fanCap / jokerValue） ===== */
{
  const sixteen=()=>[...Array.from({length:8},()=>mk('8','S')),...Array.from({length:8},()=>mkj())]; // 8 真牌 + 8 王
  T('候选带 cfg：16张软炸 fanCap32 → 32 番', (()=>{
    const c=genCandidates(sixteen(), null, {fanCap:32}).find(x=>x.play.type==='bomb'&&x.play.size===16);
    return !!c && c.play.fan===32;
  })());
  T('候选无 cfg：16张软炸 → 512 番（默认不封顶）', (()=>{
    const c=genCandidates(sixteen(), null).find(x=>x.play.type==='bomb'&&x.play.size===16);
    return !!c && c.play.fan===512;
  })());
  T('候选带 cfg：jokerValue=2 时单王算 2（val 12）', (()=>{
    const it=genCandidates([mkj()], null, {jokerValue:2}).find(x=>x.cards.length===1);
    return !!it && it.play.val===12;
  })());
  T('候选无 cfg：单王仍算 3（val 0）', (()=>{
    const it=genCandidates([mkj()], null).find(x=>x.cards.length===1);
    return !!it && it.play.val===0;
  })());
}

/* ===== 最后一手抓分入账（终局 = 决胜手） ===== */
{
  const G=newGame(73); passConfirm(G);
  G.mode='2v2'; G.landlord=0; G.partner=1;
  G.seats[1].out=true; G.seats[1].outOrder=1; G.seats[1].hand=[];
  G.seats[0].hand=[mk('5','S')];                       // 庄家只剩一张 5（分值牌，点5）
  G.seats[2].hand=[mk('3','S'),mk('4','S')];
  G.seats[3].hand=[mk('5','S')];
  G.confirming=false; G.lastPlay=null; G.lastSeat=-1; G.passes=0; G.trickPoints=0;
  G.turn=0; G.leader=0;
  const r=TS.doPlay(G,0,[G.seats[0].hand[0]]);
  T('终局手：本手分数结给最后出牌者', r.ok && r.end===true && G.seats[0].caught===5 && G.trickPoints===0);
}

/* ===== 同番跨类：五十K大炸 > 单点番炸/滚笼，< 王炸（决策 E） ===== */
{
  const cage  = {type:'fiftyCage', t:4, size:12, soft:false, fan:4, top:10};
  const bomb8 = {type:'bomb', size:8, rank:12, soft:false, fan:4};
  const roll  = {type:'rollcage', s:5, k:2, start:0, len:2, top:1, soft:false, fan:4};
  const king4 = {type:'kingBomb', size:4, fan:4};
  T('同番4：五十K大炸压过8张单点炸', canBeat(bomb8, cage)===true);
  T('同番4：8张单点炸压不过五十K大炸', canBeat(cage, bomb8)===false);
  T('同番4：五十K大炸压过滚笼', canBeat(roll, cage)===true);
  T('同番4：滚笼压不过五十K大炸', canBeat(cage, roll)===false);
  T('同番4：王炸压过五十K大炸', canBeat(cage, king4)===true);
  T('同番4：五十K大炸压不过王炸', canBeat(king4, cage)===false);
}

console.log(`\n结果：${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);