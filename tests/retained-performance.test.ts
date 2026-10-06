import { describe, expect, it, vi } from 'vitest';
import { buildRetainedPerformanceRow, persistRetainedPerformance, readRetainedPerformance } from '../lib/pubg/retainedPerformance';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '../lib/pubg-analysis/constants';
const identity = {matchId:'retained-match',platform:'steam',playerId:'target'};
function result() {
  return {matchId:identity.matchId,platform:'steam',player_id:'target',v:RESULT_VERSION,
    calculationVersion:ANALYSIS_CALCULATION_VERSION,populationEvidenceVersion:1,
    createdAt:'2026-09-01T00:00:00Z',mapName:'Erangel',gameMode:'squad',matchType:'official',
    isValidBenchmark:true,stats:{name:'Target',playerId:'account.target',kills:3,assists:2,damageDealt:400,winPlace:2},
    benchmark:{score:80,tier:'A',breakdown:{combat:30,tactical:30,survival:20}},
    badges:[{id:'carry',name:'캐리',desc:'팀 기여',event:{accountId:'account.victim'}}],
    tradeStats:{tradeKills:1,revCount:2,tradeLatencyMs:null,victimIds:['account.victim']},
    duelStats:{wins:2,losses:1,reversals:0,reversalAttempts:1,duelWinRate:66.7},
    weaponStats:{M416:{kills:3,damage:400,hits:20,victims:['account.victim']}},
    itemUseSummary:{smokes:2,frags:1,others:0},itemUseStats:{throwCount:3,lethalThrowCount:1,distanceDamage:{short:400,mid:0,long:0}},
    team:[{playerId:'account.teammate'}],timeline:[{location:{x:1,y:2}}],mapData:{events:[1]},
  };
}
describe('retained match performance',()=>{
  it('keeps measured performance without replay, events or other accounts',()=>{
    const row=buildRetainedPerformanceRow(result(),identity)!;
    expect(row.source_checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(row.ranking_eligible).toBe(true);
    expect(row.summary.stats.assists).toBe(2);
    expect(row.summary.tradeStats?.tradeLatencyMs).toBeNull();
    expect(row.summary.duelStats).toMatchObject({wins:2,losses:1});
    expect(row.summary.itemUseStats).toMatchObject({throwCount:3,distanceDamage:{short:400,mid:0,long:0}});
    expect(row.summary.team).toEqual([]);
    expect(JSON.stringify(row.summary)).not.toContain('account.victim');
    expect(JSON.stringify(row.summary)).not.toContain('account.teammate');
    expect(row.summary).not.toHaveProperty('mapData');
    expect(row.summary).not.toHaveProperty('timeline');
    expect(Buffer.byteLength(JSON.stringify(row.summary))).toBeLessThan(5000);
  });
  it('rejects copied identity and malformed official basic values',()=>{
    expect(buildRetainedPerformanceRow({...result(),matchId:'copied'},identity)).toBeNull();
    expect(buildRetainedPerformanceRow({...result(),platform:'kakao'},identity)).toBeNull();
    expect(buildRetainedPerformanceRow({...result(),stats:{...result().stats,name:'Other'}},identity)).toBeNull();
    expect(buildRetainedPerformanceRow({...result(),stats:{...result().stats,playerId:'target'}},identity)).toBeNull();
    expect(buildRetainedPerformanceRow({...result(),stats:{...result().stats,winPlace:0}},identity)).toBeNull();
  });
  it('preserves historical arithmetic without admitting it into current rankings',()=>{
    const row=buildRetainedPerformanceRow({...result(),calculationVersion:0,v:RESULT_VERSION-1},identity)!;
    expect(row.summary.performanceHistorical).toBe(true);
    expect(row.ranking_eligible).toBe(false);
    expect(row.score).toBe(80);
  });
  it('also keeps unranked observed performance',()=>{
    const row=buildRetainedPerformanceRow({...result(),isValidBenchmark:false,benchmark:null},identity)!;
    expect(row.benchmark).toBeNull();
    expect(row.summary.badges).toHaveLength(1);
    expect(row.ranking_eligible).toBe(false);
  });
  it('does not report persistence success when the DB fails',async()=>{
    const db={from:()=>({upsert:vi.fn().mockResolvedValue({error:{code:'503'}})})};
    expect(await persistRetainedPerformance(db as any,result(),identity)).toBe(false);
  });
  it('chooses the latest retained version and rejects account or date conflicts',async()=>{
    const row=buildRetainedPerformanceRow(result(),identity)!;
    const prior=buildRetainedPerformanceRow({...result(),calculationVersion:0},identity)!;
    const copied={...row,match_id:'copy',summary:{...row.summary,matchId:'copy',stats:{...row.summary.stats,playerId:'account.other'}}};
    const q:any={select:()=>q,eq:()=>q,in:async()=>({data:[row,prior,copied],error:null})};
    const summaries=await readRetainedPerformance({from:()=>q} as any,'steam','target',[identity.matchId,'copy'],'account.target');
    expect(Object.keys(summaries)).toEqual([identity.matchId]);
    expect(summaries[identity.matchId].performanceHistorical).toBe(false);
  });
});
