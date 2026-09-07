import { describe, expect, it } from 'vitest';
import { AnalysisEngine } from '@/lib/pubg-analysis/AnalysisEngine';
import { UtilityHandler } from '@/lib/pubg-analysis/handlers/UtilityHandler';
import { CombatHandler } from '@/lib/pubg-analysis/handlers/CombatHandler';
import { buildMatchAiCoachingPrompt } from '@/lib/pubg-analysis/matchAiCoachingPrompt';

const actor=(name:string)=>({name,accountId:`account.${name}`,health:100,location:{x:10000,y:10000,z:0}});
function setup(){
  const engine=new AnalysisEngine('me','account.me',new Set(['me','mate']),new Set(['account.me','account.mate']),new Set(),new Set(),'ours');
  const state=(engine as any).state;
  state.gameMode='squad';
  return {engine,state,utility:new UtilityHandler(state),combat:new CombatHandler(state)};
}
const throwEvent=(attackId:number|undefined,item='Molotov')=>({_T:'LogPlayerUseThrowable',attackId,attacker:actor('me'),weapon:{itemId:`Item_Weapon_${item}_C`}});
const hitEvent=(attackId:number|undefined,victim='enemy',damage=10,weapon='ProjMolotov_C')=>({_T:'LogPlayerTakeDamage',attackId,attacker:actor('me'),victim:actor(victim),damage,damageCauserName:weapon,damageTypeCategory:'Damage_Molotov'});
const result=(engine:AnalysisEngine)=>engine.run([],{gameMode:'squad',mapName:'Baltic_Main'},[],[],{name:'me',timeSurvived:1000,winPlace:5},[],{});

describe('personal throwable evidence',()=>{
  it('counts one successful throw for repeated ticks and multiple victims',()=>{
    const {engine,utility}=setup();
    utility.handleEvent(throwEvent(1),1000);utility.handleEvent(throwEvent(2),2000);
    utility.handleEvent(hitEvent(1),3000);utility.handleEvent(hitEvent(1),4000);utility.handleEvent(hitEvent(1,'other'),5000);
    expect(result(engine).combatPressure.utilityStats).toMatchObject({hitCount:1,damageEventCount:3,accuracy:50,totalDamage:30});
  });
  it('excludes team/self/zero damage and non-throwable explosions',()=>{
    const {engine,utility}=setup();utility.handleEvent(throwEvent(1),1000);
    for(const event of [hitEvent(1,'me'),hitEvent(1,'mate'),hitEvent(1,'enemy',0),{...hitEvent(1),damageCauserName:'PanzerFaust100M_Projectile_C',damageTypeCategory:'Damage_Explosion_PanzerFaustWarhead'}]) utility.handleEvent(event,2000);
    expect(result(engine).combatPressure.utilityStats).toMatchObject({hitCount:0,accuracy:0,totalDamage:0,damageEventCount:0});
  });
  it.each([undefined,-1,99])('holds accuracy when damage cannot be linked to the observed throw (%s)',attackId=>{
    const {engine,utility}=setup();utility.handleEvent(throwEvent(1),1000);utility.handleEvent(hitEvent(attackId),2000);
    const data=result(engine);
    expect(data.combatPressure.utilityStats).toMatchObject({hitCount:null,accuracy:null,accuracyStatus:'missing',avgDamagePerThrow:null,totalDamage:10});
    expect(buildMatchAiCoachingPrompt({matchData:data}).playerReportSummary).toContain('피해형 투척 적중률 측정 불가');
  });
});

describe('personal trade and support attribution',()=>{
  const knock=(enemy:string)=>({_T:'LogPlayerMakeGroggy',attacker:actor(enemy),victim:actor('mate'),dBNOId:1});
  const kill=(enemy:string,killer='me')=>({_T:'LogPlayerKillV2',killer:actor(killer),victim:actor(enemy)});
  it('requires killing the actual knocker and credits a duplicated kill only once',()=>{
    const {state,combat}=setup();combat.handleEvent(knock('knocker'),1000,1000);
    combat.handleEvent(kill('unrelated'),2000,2000);expect(state.totalTradeKills).toBe(0);
    combat.handleEvent(kill('knocker'),3000,3000);combat.handleEvent(kill('knocker'),3000,3000);
    expect(state.totalTradeKills).toBe(1);expect(state.tradeLatencies).toEqual([2000]);
  });
  it('does not count a kill outside the 30 second window',()=>{
    const {state,combat}=setup();combat.handleEvent(knock('knocker'),1000,1000);combat.handleEvent(kill('knocker'),31000,31000);
    expect(state.totalTradeKills).toBe(0);
  });
  it('uses teammate enemy kills as support share denominator, independent of friendly knocks',()=>{
    const {engine,state,combat}=setup();
    for(const enemy of ['a','b']) {state.myVictimDamage.set(enemy,60);combat.handleEvent(kill(enemy,'mate'),1000,1000);}
    combat.handleEvent(kill('c','mate'),2000,2000);
    expect(result(engine).tradeStats).toMatchObject({suppCount:2,teammateKills:3,suppRate:200/3});
  });
  it('clears damage support after a kill so a recalled enemy is not credited twice',()=>{
    const {state,combat}=setup();state.myVictimDamage.set('enemy',60);
    combat.handleEvent(kill('enemy','mate'),1000,1000);combat.handleEvent(kill('enemy','mate'),1000,1000);
    combat.handleEvent(kill('enemy','mate'),2000,2000);
    expect(state.totalSuppCount).toBe(1);
  });
});

import { applyMatchAiEvidencePolicy } from '@/lib/pubg-analysis/matchAiEvidence';
import { sanitizeUnsupportedAiSummaryBenchmarkLanguage } from '@/lib/pubg-analysis/aiSummaryDebate';
describe('real Gemini evidence failure regressions',()=>{
  const match={isolationData:{isolationIndex:.36},combatPressure:{utilityStats:{throwCount:12,lethalThrowCount:4,hitCount:1,accuracyStatus:'observed'}}};
  it('repairs total-vs-lethal count confusion and low-isolation/missing-benchmark claims',()=>{
    const response=JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify({signature:'실속 없는 고립형 생존자',briefFeedback:['피해형 투척물 12회 중 4회를 활용했으나 적중률 25%입니다.','대응 사격 속도가 상위권 기준에 비해 크게 처졌습니다.'],actionItems:[{desc:'다음에는 피해형 투척 3회 사용을 연습해 보세요.'}]}),match));
    expect(response.signature).toBe('대열 유지형 플레이어');
    expect(response.briefFeedback[0]).toContain('총 투척 12회, 피해형 투척 4회');
    expect(response.briefFeedback[1]).toContain('비교 자료가 없어');
    expect(response.actionItems[0].desc).toContain('3회');
  });
  it('keeps user-only qualitative observations without granting benchmark or invented-number claims',()=>{
    const options={allowedMode:'squad',observedUserMetricKeys:['death_phase','smoke_opportunity_rate']};
    expect(sanitizeUnsupportedAiSummaryBenchmarkLanguage('평균 사망 페이즈가 중후반부에 위치합니다.',{},options)).toContain('중후반부');
    expect(sanitizeUnsupportedAiSummaryBenchmarkLanguage('평균 사망 페이즈는 상위권보다 높습니다.',{},options)).not.toContain('상위권보다');
    expect(sanitizeUnsupportedAiSummaryBenchmarkLanguage('평균 사망 페이즈 999입니다.',{},options)).not.toContain('999');
    expect(sanitizeUnsupportedAiSummaryBenchmarkLanguage('복수 성공률은 낮습니다.',{},options)).not.toContain('낮습니다');
  });
});

import { applySquadEvidencePolicy } from '@/lib/pubg-analysis/squadAiEvidence';
describe('observed edge cases from review',()=>{
  it('uses a valid alias when attackId is invalid and recognizes C4/category evidence',()=>{
    const {engine,utility}=setup();
    utility.handleEvent({...throwEvent(-1,'C4'),_T:'LogThrowableUse',character:actor('me'),item:{itemId:'Item_Weapon_C4_C'},attack_id:5},1000);
    utility.handleEvent({...hitEvent(-1),attack_id:5,damageCauserName:'Projectile_C',damageTypeCategory:'Damage_Explosion_C4'},2000);
    expect(result(engine).combatPressure.utilityStats).toMatchObject({lethalThrowCount:1,hitCount:1,accuracy:100});
  });
  it('excludes account-only groggy victim and self damage without a roster',()=>{
    const {engine,state,utility,combat}=setup();
    const knock={_T:'LogPlayerMakeGroggy',attacker:actor('mate'),victim:actor('enemy')};
    combat.handleEvent(knock,1000,1000);utility.handleEvent(knock,1000);
    state.teamNames.clear();state.teamAccountIds.clear();
    utility.handleEvent(throwEvent(1),1500);
    utility.handleEvent({...hitEvent(1),victim:{accountId:'account.enemy'}},2000);
    utility.handleEvent({...hitEvent(1),victim:{accountId:'account.me'}},2000);
    expect(result(engine).combatPressure.utilityStats.totalDamage).toBe(0);
  });
  it('deduplicates kills across event timestamps and keeps initiative assist credit',()=>{
    const {state,combat}=setup();
    const session={userStarted:true,alreadySucceeded:false,outcome:undefined};
    const personal={sessions:new Map([['enemy',session]]),duelWins:0,success:0};
    state.playerCombatData.set('account.me',personal);state.myVictimDamage.set('enemy',60);
    const kill={_T:'LogPlayerKillV2',killer:actor('mate'),victim:actor('enemy')};
    combat.handleEvent(kill,2000,2000);combat.handleEvent({...kill,_T:'LogPlayerKill'},2001,2001);
    expect(state.totalSuppCount).toBe(1);expect(state.supportTeammateKills).toBe(1);
    expect(personal.success).toBe(1);expect(session.outcome).toBe('win');
  });
  it('does not turn rescue counts or personal shares into invented behavior',()=>{
    const result=applySquadEvidencePolicy({coaching:'연막 구출 성공 수가 0회이므로 연막탄 아껴서 국 끓여 먹을 겁니까?',memberFeedbacks:[{fault:'교전 관여에서 소극적인 모습입니다.',advice:'후방 지원에 머물지 말고 나서세요.'}]},{totalSmokeRescues:0},null,{});
    expect(result.coaching).not.toContain('국 끓');
    expect(result.memberFeedbacks[0].fault).toContain('단정할 근거가 부족');
    expect(result.memberFeedbacks[0].advice).not.toContain('후방');
  });
});

it('attributes a later KillV2 and resets support evidence for a recalled victim',()=>{
  const {state,combat}=setup();state.myVictimDamage.set('enemy',60);
  combat.handleEvent({_T:'LogPlayerKill',victim:actor('enemy')},1000,1000);
  combat.handleEvent({_T:'LogPlayerKillV2',killer:actor('mate'),victim:{accountId:'account.enemy'}},1001,1001);
  expect(state.totalSuppCount).toBe(1);expect(state.supportTeammateKills).toBe(1);
  combat.handleEvent({_T:'LogPlayerRecall',recalledPlayers:[actor('enemy')]},2000,2000);
  combat.handleEvent({_T:'LogPlayerKillV2',killer:actor('mate'),victim:actor('enemy')},3000,3000);
  expect(state.supportTeammateKills).toBe(2);expect(state.totalSuppCount).toBe(1);
});

it.each(['LogPlayerRedeployBRStart','LogPlayerRedeployBrStart'])('resets kill dedupe for %s nested characters',type=>{
  const {state,combat}=setup();const kill={_T:'LogPlayerKillV2',killer:actor('mate'),victim:actor('enemy')};
  combat.handleEvent(kill,1000,1000);
  combat.handleEvent({_T:type,characters:[{character:actor('enemy')}]},2000,2000);
  combat.handleEvent(kill,3000,3000);expect(state.supportTeammateKills).toBe(2);
});

it('repairs unsupported rear-position titles and smoke-only utility dismissal',()=>{
  const final=JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify({signature:'든든한 후방 화력 지원자',briefFeedback:['피해형 투척물이 없어 유틸리티 교전 보조 능력을 발휘하지 못했습니다.']}),{combatPressure:{utilityStats:{throwCount:2,lethalThrowCount:0,hitCount:0}}}));
  expect(final.signature).not.toContain('후방');expect(final.briefFeedback[0]).toContain('총 투척 2회');
});

it('binds squad member contribution numbers to their own metric, including cache responses',()=>{
  const result=applySquadEvidencePolicy({memberFeedbacks:[{name:'MiaeQ_Q',praise:'평균 357 데미지와 21%의 킬 기여도를 기록했습니다.',fault:'킬 비중 21%입니다.',advice:'어시스트 비중 9%입니다.'}]},{},null,{},[{name:'MiaeQ_Q',shares:{damage:25,kill:36,assist:9,dbno:21}}]);
  expect(result.memberFeedbacks[0].praise).toContain('킬 비중 36%');
  expect(result.memberFeedbacks[0].fault).toContain('킬 비중 36%');
  expect(result.memberFeedbacks[0].advice).toContain('어시스트 비중 9%');
});
