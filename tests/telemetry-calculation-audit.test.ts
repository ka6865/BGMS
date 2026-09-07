import { describe, expect, it } from 'vitest';
import { sampleReplayPositions, filterTelemetryEvents } from '@/lib/pubg-analysis/telemetryContract';
import { createTelemetryAnalyzeCacheEnvelope, parseTelemetryAnalyzeCacheEnvelope } from '@/lib/pubg-analysis/telemetryCacheKey';
import { AnalysisEngine } from '@/lib/pubg-analysis/AnalysisEngine';
import { UtilityHandler } from '@/lib/pubg-analysis/handlers/UtilityHandler';
import { MapReplayHandler } from '@/lib/pubg-analysis/handlers/MapReplayHandler';
import { extractSquadCauseScenes } from '@/lib/pubg-analysis/squadCauseScenes';
import { PositionHandler } from '@/lib/pubg-analysis/handlers/PositionHandler';
import { calcBenchmarkScoreDetails, type MatchTierInput } from '@/lib/pubg-analysis/benchmarkScore';
import { deriveSquadRecoveryStatsFromTimeline } from '@/lib/pubg-analysis/squadRecoveryStats';
import type { TimelineEvent } from '@/lib/pubg-analysis/types';

function positionSetup() {
  const names=new Set(['me','alpha','beta']), ids=new Set(['account.me','account.alpha','account.beta']);
  const engine=new AnalysisEngine('me','account.me',names,ids,new Set(),new Set(),'ours');
  const state=(engine as any).state;
  state.hasLanded=true;
  const handler=new PositionHandler(state);
  for (const [name,x] of [['me',10000],['alpha',30000],['beta',50000],['enemy',20000]] as const) {
    state.teamMapping.set(name,name==='enemy'?'enemy-roster':'ours');
    state.teamMapping.set(`account.${name}`,name==='enemy'?'enemy-roster':'ours');
    handler.handleEvent({_T:'LogPlayerCreate',character:{name,accountId:`account.${name}`,location:{x,y:10000,z:0}}},0,0);
    state.playerLocations.set(`account.${name}`,{x,y:10000,z:0});
  }
  const sample=(name:string,x:number,ts:number)=>handler.handleEvent({_T:'LogPlayerPosition',character:{name,accountId:`account.${name}`,location:{x,y:10000,z:0}}},ts,ts);
  return {state,sample};
}
describe('telemetry formula audit regressions',()=>{
  it('measures each teammate identity, not the first account in a shared roster',()=>{
    const {state,sample}=positionSetup();sample('me',10000,200000);
    expect(state.isolationData.minDist).toBe(200);
    expect(state.isolationData.isolationIndex).toBe(6);
  });
  it('uses the latest position across account/name aliases and excludes a dead teammate',()=>{
    const {state,sample}=positionSetup();
    sample('alpha',60000,199000);
    state.playerAliveStatus.set('beta',false);
    sample('me',10000,200000);
    expect(state.playerLocations.get('account.alpha').x).toBe(60000);
    expect(state.isolationData.minDist).toBe(500);
    expect(state.isolationData.isolationIndex).toBe(10);
  });
  it('does not penalize a measured zero-ms response more than a one-ms response',()=>{
    const input={survivalTime:1200,rankPct:.3,initiativeRate:0,counterLatencyMs:0} as MatchTierInput;
    expect(calcBenchmarkScoreDetails(input,false).combat).toBe(calcBenchmarkScoreDetails({...input,counterLatencyMs:1},false).combat);
  });
});
const knock:TimelineEvent={ts:1000,type:'TEAM_KNOCK',victim:'Team-A',x:100,y:100};
const smoke:TimelineEvent={ts:5000,type:'ITEM_USE',weapon:'Smoke Grenade',playerName:'Helper',x:101,y:100};
const revive:TimelineEvent={ts:12000,type:'TEAM_REVIVE',victim:'Team-A',playerName:'Helper'};
describe('squad recovery causal order and distance',()=>{
  it('never attributes a smoke used after the revive as rescue',()=>{
    expect(deriveSquadRecoveryStatsFromTimeline([knock,{...revive,ts:4000},smoke]).squadSmokeRescues).toBe(0);
  });
  it('requires finite locations instead of assuming missing coordinates are near',()=>{
    expect(deriveSquadRecoveryStatsFromTimeline([knock,{...smoke,x:undefined,y:undefined},revive]).squadSmokeRescues).toBeNull();
    expect(deriveSquadRecoveryStatsFromTimeline([knock,{...smoke,x:NaN},revive]).squadSmokeRescues).toBeNull();
  });
  it.each(['Savage_Main','사녹'])('converts 8192 map coordinates to meters on a 4km map (%s)',(mapName)=>{
    const result=deriveSquadRecoveryStatsFromTimeline([knock,{...smoke,x:220},revive], mapName);
    expect(result.squadSmokeRescues).toBe(1);
    expect(result.smokeRescueCandidates[0].smokeDistanceM).toBe(60);
  });
  it('does not confuse names after removing hyphens',()=>{
    expect(deriveSquadRecoveryStatsFromTimeline([knock,smoke,{...revive,victim:'TeamA'}]).squadSmokeRescues).toBe(0);
  });
  it('does not cross a death and a new knock to assign a later revive to the first knock',()=>{
    const result=deriveSquadRecoveryStatsFromTimeline([knock,smoke,{ts:6000,type:'TEAM_DIED',victim:'Team-A'}, {...knock,ts:8000},revive]);
    expect(result.squadSmokeRescues).toBe(0);
  });
});


describe('personal telemetry counts and score population',()=>{
  it('does not inflate human damage rank with bots using official stats.playerId',()=>{
    const participant=(name:string,id:string,damageDealt:number)=>({attributes:{stats:{name,playerId:id,damageDealt}}});
    const humans=[participant('Other','account.other',500),participant('Me','account.me',100)];
    const bots=Array.from({length:8},(_,i)=>participant(`Bot${i}`,`ai.${i}`,0));
    const run=(participants:any[])=>new AnalysisEngine('Me','account.me',new Set(['me']),new Set(['account.me']),new Set(),new Set(),'ours')
      .run([], {gameMode:'squad'}, [], participants, {name:'Me',damageDealt:100,timeSurvived:1200,winPlace:10}, [], {}).benchmark!.breakdown!.combat;
    expect(run([...humans,...bots])).toBe(run(humans));
  });
  it('tracks simultaneous teammate knocks separately for personal smoke rescue credit',()=>{
    const engine=new AnalysisEngine('me','account.me',new Set(['me','alpha','beta']),new Set(['account.me','account.alpha','account.beta']),new Set(),new Set(),'ours');
    const state=(engine as any).state, handler=new UtilityHandler(state);
    const actor=(name:string,x:number)=>({name,accountId:`account.${name}`,location:{x,y:100,z:0}});
    for(const [name,x] of [['me',100],['alpha',200],['beta',20000]] as const) state.playerLocations.set(name,{x,y:100,z:0});
    state.teammateKnockEvents=[1000,1000];
    for(const name of ['alpha','beta']) {
      state.playerAliveStatus.set(name,'groggy');
      handler.handleEvent({_T:'LogPlayerMakeGroggy',victim:actor(name,200)},1000);
    }
    handler.handleEvent({_T:'LogPlayerUseThrowable',attackId:1,attacker:actor('me',100),weapon:{itemId:'Item_Weapon_SmokeBomb_C'}},2000);
    handler.handleEvent({_T:'LogPlayerRevive',victim:actor('beta',20000)},3000);
    expect(state.totalSmokeRescues).toBe(0);
    handler.handleEvent({_T:'LogPlayerRevive',victim:actor('alpha',200)},4000);
    expect(state.totalSmokeRescues).toBe(1);
  });
});


describe('analysis cache projection contract',()=>{
  const identity={matchId:'audit-match',platform:'steam' as const,playerId:'account.me',mode:'lite' as const,telemetryVersion:61};
  const context={mode:'full' as const,teamNames:new Set(['me']),teamAccountIds:new Set(['account.me'])};
  it('rejects an old unmarked cache whose positions may already have been sampled',()=>{
    const envelope=createTelemetryAnalyzeCacheEnvelope(identity,[]);
    const old={...envelope} as any;
    delete old.analyzeFormat;
    expect(parseTelemetryAnalyzeCacheEnvelope(old,identity)).toBeNull();
  });
  it('preserves all analysis positions over cache round trips, while display lite samples once',()=>{
    const raw=Array.from({length:100},(_,i)=>({_T:'LogPlayerPosition',_D:new Date(i*1000).toISOString(),character:{name:'enemy',accountId:'account.enemy',location:{x:i,y:100,z:0}}}));
    const full=filterTelemetryEvents(raw,context);
    const cached=parseTelemetryAnalyzeCacheEnvelope(JSON.parse(JSON.stringify(createTelemetryAnalyzeCacheEnvelope(identity,full))),identity)!;
    const restored=filterTelemetryEvents(cached,context);
    expect(restored).toEqual(full);
    expect(restored).toHaveLength(100);
    expect(filterTelemetryEvents(restored,{...context,mode:'lite'})).toHaveLength(10);
  });
  it('samples only rendered enemy positions after calculations',()=>{
    const enemy=Array.from({length:100},()=>({type:'position',isTeam:false}));
    const team=Array.from({length:20},()=>({type:'position',isTeam:true}));
    expect(sampleReplayPositions([...enemy,...team,{type:'kill',isTeam:false}], 'lite')).toHaveLength(31);
  });
  it('keeps supported throwable identity aliases through field projection',()=>{
    const [event]=filterTelemetryEvents([{_T:'LogPlayerUseThrowable',attack_id:7,projectileId:'p7'}],context);
    expect(event).toMatchObject({attack_id:7,projectileId:'p7'});
  });
});


describe('replay health and recovery scene evidence', () => {
  it.each(['recalledPlayer','recallingPlayer'])('emits returned player life for singular %s and excludes the initiator',field=>{
    const {state}=positionSetup();
    new MapReplayHandler(state).handleEvent({_T:'LogPlayerRecall',[field]:{name:'enemy',accountId:'account.enemy',location:{x:100,y:100,z:0}},recaller:{name:'me'}},1000,1000);
    expect(state.mapEvents.at(-1)).toMatchObject({type:'create',name:'enemy',isTeam:false,relativeTimeMs:1000});
  });
  it('preserves measured zero health in replay positions', () => {
    const {state}=positionSetup();
    new MapReplayHandler(state).handleEvent({_T:'LogPlayerPosition',character:{name:'me',accountId:'account.me',health:0,location:{x:100,y:100,z:0}}},1000,1000);
    expect(state.mapEvents.at(-1).health).toBe(0);
  });
  it.each([
    [knock,{...revive,ts:4000},smoke],
    [knock,{...smoke,x:2000},revive],
    [knock,{...smoke,x:undefined,y:undefined},revive],
    [knock,smoke,{ts:6000,type:'TEAM_DIED',victim:'Team-A'},revive],
  ])('does not describe unrelated smoke as a successful rescue (%#)', (...timeline) => {
    const scenes=extractSquadCauseScenes([{matchId:'audit',mapName:'Baltic_Main',fullResult:{timeline:timeline as TimelineEvent[]}}]);
    expect(scenes.some(scene=>scene.type==='revive_save')).toBe(false);
  });
});
