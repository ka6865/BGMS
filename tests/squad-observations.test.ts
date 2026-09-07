import { describe, expect, it } from 'vitest';
import { SquadObservationCollector, aggregateSquadObservations } from '@/lib/pubg-analysis/squadObservations';
const actor=(accountId:string,x=10000)=>({accountId,location:{x,y:10000,z:0}});
const team=new Set(['a','b','c','d']);
const event=(_T:string,fields:Record<string,unknown>={})=>({_T,...fields});
const knock=(attacker='enemy',victim='a')=>event('LogPlayerMakeGroggy',{attacker:actor(attacker),victim:actor(victim)});
const kill=(victim='enemy',killer='b')=>event('LogPlayerKillV2',{killer:actor(killer),victim:actor(victim)});
function collect(events:Array<[number,Record<string,unknown>]>){
  const c=new SquadObservationCollector(team,'squad');c.observe(event('LogMatchStart'),0);
  events.forEach(([ts,e])=>c.observe(e,ts));c.observe(event('LogMatchEnd'),100000);return c.result();
}
describe('team observations independent of requester',()=>{
  it('counts all team knocks and only trades against the same knocker, once per life',()=>{
    const result=collect([[1000,knock()],[1001,knock()],[2000,kill('other')],[3000,kill()],[3001,{...kill(),_T:'LogPlayerKill'}]]);
    expect(result).toMatchObject({scope:'squad',status:'observed',knocks:1,tradeKills:1,tradeLatencyTotalMs:2000});
  });
  it.each([0,29999,30000])('uses the exclusive 30s trade boundary (%s)',delay=>{
    expect(collect([[1000,knock()],[1000+delay,kill()]]).tradeKills).toBe(delay<30000?1:0);
  });
  it('does not call a self-kill after revival a teammate trade',()=>{
    const result=collect([[1000,knock()],[2000,event('LogPlayerRevive',{victim:actor('a'),reviver:actor('b')})],[3000,kill('enemy','a')]]);
    expect(result).toMatchObject({revives:1,tradeKills:0});
  });
  it('uses team knocks for recovery and preserves smoke timing/distance/life identity',()=>{
    const smoke=event('LogPlayerUseThrowable',{attacker:actor('b'),weapon:{itemId:'Item_Weapon_SmokeBomb_C'},attackId:1});
    const revive=event('LogPlayerRevive',{victim:actor('a'),reviver:actor('b')});
    expect(collect([[1000,knock()],[2000,smoke],[3000,revive],[3001,revive]])).toMatchObject({knocks:1,revives:1,smokeRescues:1});
    expect(collect([[1000,knock()],[2000,revive],[3000,smoke]])).toMatchObject({revives:1,smokeRescues:0});
    expect(collect([[1000,knock()],[2000,{...smoke,attacker:actor('b',30000)}],[3000,revive]])).toMatchObject({smokeRescues:0});
  });
  it('holds smoke attribution when the relevant distance is missing',()=>{
    const result=collect([[1000,knock()],[2000,event('LogPlayerUseThrowable',{attacker:{accountId:'b'},weapon:{itemId:'SmokeBomb'}})],[3000,event('LogPlayerRevive',{victim:actor('a'),reviver:actor('b')})]]);
    expect(result).toMatchObject({status:'observed',knocks:1,revives:1,smokeRescues:null});
  });
  it('does not attach a later life revive to a previous knock',()=>{
    const result=collect([[1000,knock()],[2000,kill('a','enemy')],[3000,event('LogPlayerRedeployBRStart',{characters:[{character:actor('a')}]})],[4000,knock()],[5000,event('LogPlayerRevive',{victim:actor('a'),reviver:actor('b')})]]);
    expect(result).toMatchObject({knocks:2,revives:1});
  });
  it.each(['recallingPlayer', 'recalledPlayer'])('resets the returned life from singular %s, without resetting the recaller', field=>{
    const result=collect([[1000,knock()],[1500,knock('other','c')],[2000,kill('a','enemy')],[3000,event('LogPlayerRecall',{[field]:actor('a'),recaller:actor('c')})],[4000,knock()],[5000,event('LogPlayerRevive',{victim:actor('a'),reviver:actor('b')})],[6000,event('LogPlayerRevive',{victim:actor('c'),reviver:actor('d')})]]);
    expect(result).toMatchObject({status:'observed',knocks:3,revives:2});
  });
  it('accepts the canonical playerId actor alias including an empty accountId',()=>{
    const alias=(playerId:string)=>({playerId,accountId:''});
    expect(collect([[1000,event('LogPlayerMakeGroggy',{attacker:alias('enemy'),victim:alias('a')})],[2000,event('LogPlayerRevive',{victim:alias('a'),reviver:alias('b')})],[3000,event('LogPlayerKillV2',{killer:alias('b'),victim:alias('enemy')})]])).toMatchObject({status:'observed',knocks:1,revives:1,tradeKills:1,tradeLatencyTotalMs:2000});
  });
  it('holds a revive without its knock instead of reporting an observed zero',()=>{
    expect(collect([[1000,event('LogPlayerRevive',{victim:actor('a'),reviver:actor('b')})]])).toMatchObject({status:'missing',knocks:null,issues:['missing_knock_for_revive']});
  });
  it('withholds incomplete telemetry but preserves complete observed zeros',()=>{
    const c=new SquadObservationCollector(team,'squad');c.observe(event('LogMatchStart'),0);c.observe(knock(),1000);
    expect(c.result()).toMatchObject({status:'missing',knocks:null});
    expect(collect([])).toMatchObject({status:'observed',knocks:0,revives:0,tradeKills:0});
  });
  it('aggregates latency by event count, deduplicates matches, holds old/mixed/wrong-team records',()=>{
    const a=collect([[1000,knock()],[3000,kill()]]);
    const b=collect([[1000,knock()],[5000,kill()],[6000,knock('other','c')],[14000,kill('other')]]);
    const rows=[{matchId:'1',observation:a},{matchId:'2',observation:b}];
    expect(aggregateSquadObservations([...rows,rows[0]])).toMatchObject({knocks:3,tradeKills:3,avgTradeLatency:14000/3});
    for(const bad of [undefined,{...b,version:0},{...b,teamAccountIds:['a','b','c','outsider']}])
      expect(aggregateSquadObservations([rows[0],{matchId:'2',observation:bad}])).toMatchObject({status:'missing',knocks:null,avgTradeLatency:null});
  });
});
