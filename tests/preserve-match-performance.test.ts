import { describe, expect, it, vi } from 'vitest';
import { preserveLinkedMatchPerformance, preserveMatchPerformance, sourceReadRetry } from '../scripts/preserve_match_performance';
import { buildRetainedPerformanceRow } from '../lib/pubg/retainedPerformance';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '../lib/pubg-analysis/constants';

const source={match_id:'preserve-match',platform:'steam',player_id:'target',data:{fullResult:{
  matchId:'preserve-match',platform:'steam',player_id:'target',v:RESULT_VERSION,
  calculationVersion:ANALYSIS_CALCULATION_VERSION,populationEvidenceVersion:1,
  createdAt:'2026-09-01T00:00:00Z',mapName:'Erangel',gameMode:'squad',matchType:'official',
  isValidBenchmark:false,benchmark:null,stats:{name:'Target',playerId:'account.target',kills:3,damageDealt:400,winPlace:2},
}}};
const compact=()=>buildRetainedPerformanceRow(source.data.fullResult,{matchId:source.match_id,platform:'steam',playerId:'target'})!;

function matchesOr(row:Record<string,any>,expression:string):boolean{
  const evaluate=(term:string):boolean=>{
    if(term.startsWith('and('))return term.slice(4,-1).split(',').every(evaluate);
    const [field,operator,value]=term.split('.');
    if(operator==='is' && value==='null')return row[field]==null;
    if(row[field]==null)return false;
    if(operator==='eq')return row[field]===Number(value);
    if(operator==='lt')return row[field]<Number(value);
    if(operator==='neq')return row[field]!==Number(value);
    throw new Error(`unsupported test filter: ${term}`);
  };
  return (expression.match(/and\([^)]*\)|[^,]+/g)??[]).some(evaluate);
}

function fixture(existing?:Record<string,any>,completeConcurrently=false,fixtureOptions:{writeError?:boolean;readback?:'summary-null'|'player-mismatch'|'date-mismatch'}={}){
  let stored=existing ? structuredClone(existing) : undefined;
  const payloads:Record<string,unknown>[]=[];
  const upsert=vi.fn(async(batch:any[],upsertOptions:any)=>{
    expect(upsertOptions.ignoreDuplicates).toBe(true);
    if(fixtureOptions.writeError)return {error:{code:'write-failed'}};
    if(!stored)stored=structuredClone(batch[0]);
    if(completeConcurrently)stored={...compact(),source_checksum:'f'.repeat(64),summary:{...compact().summary,concurrent:true}};
    return {error:null};
  });
  const db:any={rpc:vi.fn(()=>({abortSignal:async()=>({data:[source],error:null})})),from:()=>{
    let action='select',payload:any,orExpression='';
    const filters:Record<string,unknown>={};
    const q:any={upsert,select:()=>q,eq:(key:string,value:unknown)=>{filters[key]=value;return q;},
      or:(expression:string)=>{orExpression=expression;return q;},in:()=>q,update:(value:any)=>{action='update';payload=value;payloads.push(value);return q;},
      abortSignal:()=>{
        if(action==='select'){
          if(!stored)return Promise.resolve({data:[],error:null});
          const readback=structuredClone(stored);
          if(fixtureOptions.readback==='summary-null')readback.summary=null;
          if(fixtureOptions.readback==='player-mismatch')readback.player_id='copied-player';
          if(fixtureOptions.readback==='date-mismatch')readback.played_at='2000-01-01T00:00:00Z';
          return Promise.resolve({data:[readback],error:null});
        }
        if(stored && Object.entries(filters).every(([key,value])=>stored![key]===value)
          && matchesOr(stored,orExpression))Object.assign(stored,payload);
        return Promise.resolve({error:null});
      }};
    // upsert also returns an abortable PostgREST builder.
    q.upsert=(batch:any[],options:any)=>({abortSignal:()=>upsert(batch,options)});
    return q;
  }};
  return {db,stored:()=>stored,payloads,upsert};
}

describe('bulk retained performance preservation',()=>{
  it('fills a benchmark-only row without replacing measured score, tier or ranking eligibility',async()=>{
    const measured={score:97,tier:'S',breakdown:{combat:40,tactical:35,survival:22}};
    const before={...compact(),summary:null,summary_version:null,source_checksum:null,
      score:97,tier:'S',benchmark:measured,ranking_eligible:true};
    const f=fixture(before);
    expect(await preserveMatchPerformance(f.db,{apply:true,limit:1})).toMatchObject({saved:1});
    expect(f.stored()).toMatchObject({score:97,tier:'S',benchmark:measured,ranking_eligible:true,
      summary:compact().summary,source_checksum:compact().source_checksum});
    expect(f.payloads[0]).not.toHaveProperty('score');
    expect(f.payloads[0]).not.toHaveProperty('ranking_eligible');
  });
  it('inserts a new observed row and verifies its compact identity',async()=>{
    const f=fixture();
    expect(await preserveMatchPerformance(f.db,{apply:true,limit:1})).toMatchObject({prepared:1,saved:1});
    expect(f.stored()).toEqual(compact());
  });
  it('stops when the database upsert fails',async()=>{
    const f=fixture(undefined,false,{writeError:true});
    await expect(preserveMatchPerformance(f.db,{apply:true,limit:1})).rejects.toThrow('preserve-performance-write-failed');
    expect(f.stored()).toBeUndefined();
  });
  it('rejects a readback with a missing summary even when its checksum matches',async()=>{
    const f=fixture(undefined,false,{readback:'summary-null'});
    await expect(preserveMatchPerformance(f.db,{apply:true,limit:1})).rejects.toThrow('preserve-performance-readback-failed');
    expect(f.stored()?.source_checksum).toBe(compact().source_checksum);
  });
  it.each(['player-mismatch','date-mismatch'] as const)('rejects copied %s identity on readback',async(readback)=>{
    const f=fixture(undefined,false,{readback});
    await expect(preserveMatchPerformance(f.db,{apply:true,limit:1})).rejects.toThrow('preserve-performance-readback-failed');
  });
  it('preserves a concurrently completed summary and fails verification when the source changed',async()=>{
    const f=fixture({...compact(),summary:null,summary_version:null},true);
    await expect(preserveMatchPerformance(f.db,{apply:true,limit:1})).rejects.toThrow('preserve-performance-readback-failed');
    expect(f.stored()?.summary.concurrent).toBe(true);
    expect(f.stored()?.source_checksum).toBe('f'.repeat(64));
  });
  it('원본 조회가 57014 로 걸려도 다시 시도해 통과하고, 계속 걸리면 지금처럼 중단한다',async()=>{
    const original=sourceReadRetry.delaysMs;
    sourceReadRetry.delaysMs=[0,0];
    try{
      const f=fixture();
      const rows=await f.db.rpc().abortSignal();
      let failures=2;
      f.db.rpc=vi.fn(()=>({abortSignal:async()=>failures-->0?{data:null,error:{code:'57014'}}:rows}));
      expect(await preserveMatchPerformance(f.db,{apply:false,limit:1})).toMatchObject({prepared:1});
      expect(f.db.rpc).toHaveBeenCalledTimes(3);

      f.db.rpc=vi.fn(()=>({abortSignal:async()=>({data:null,error:{code:'57014'}})}));
      await expect(preserveMatchPerformance(f.db,{apply:false,limit:1})).rejects.toThrow('preserve-performance-source-read-failed:57014');
      expect(f.db.rpc).toHaveBeenCalledTimes(3);

      f.db.rpc=vi.fn(()=>({abortSignal:async()=>({data:null,error:{code:'42501'}})}));
      await expect(preserveMatchPerformance(f.db,{apply:false,limit:1})).rejects.toThrow('preserve-performance-source-read-failed:42501');
      expect(f.db.rpc).toHaveBeenCalledTimes(1);
    }finally{sourceReadRetry.delaysMs=original;}
  });
  it('dry-run prepares the result without writing any row',async()=>{
    const f=fixture();
    expect(await preserveMatchPerformance(f.db,{apply:false,limit:1})).toMatchObject({prepared:1,saved:0});
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.payloads).toEqual([]);
  });
  it.each([null,{...compact().summary,newer:true}])('does not downgrade newer summary version even if its payload is %s',async(summary)=>{
    const before={...compact(),summary_version:2,summary};
    const f=fixture(before);
    await expect(preserveMatchPerformance(f.db,{apply:true,limit:1})).rejects.toThrow('preserve-performance-readback-failed');
    expect(f.stored()).toEqual(before);
  });
});

function linkedFixture(profiles: Record<string, unknown>[], sources = [source]) {
  const f = fixture();
  const storage = f.db.from;
  const profileRead = vi.fn(async (start: number, end: number) => ({ data: profiles.slice(start, end + 1), error: null }));
  f.db.from = (table: string) => {
    if (table !== 'profiles') return storage(table);
    let start = 0, end = 999;
    const query = {
      select: () => query, order: () => query,
      range: (first: number, last: number) => { start = first; end = last; return query; },
      abortSignal: () => profileRead(start, end),
    };
    return query;
  };
  f.db.rpc = vi.fn((_name: string, params: { p_platform: string; p_player_id: string; p_limit: number }) => ({
    abortSignal: async () => ({ data: sources.filter(row => row.platform === params.p_platform && row.player_id === params.p_player_id).slice(0, params.p_limit), error: null }),
  }));
  return { ...f, profileRead };
}

describe('linked member performance preservation', () => {
  const profile = { pubg_platform: 'steam', pubg_nickname: 'Target', last_active_at: '2020-01-01' };

  it('deduplicates linked identities without requiring recent activity and writes verified summaries', async () => {
    const f = linkedFixture([profile, { ...profile, pubg_nickname: ' TARGET ' }, { pubg_platform: 'xbox', pubg_nickname: 'Target' }, { pubg_platform: 'steam', pubg_nickname: null }]);
    expect(await preserveLinkedMatchPerformance(f.db, { apply: true, limit: 1000 })).toMatchObject({
      scope: 'linked', linkedIdentities: 1, visitedIdentities: 1, scanned: 1, prepared: 1, saved: 1, skipped: 0,
    });
    expect(f.db.rpc).toHaveBeenCalledWith('list_linked_unretained_match_performance', { p_platform: 'steam', p_player_id: 'target', p_limit: 100 });
    expect(f.stored()).toEqual(compact());
  });

  it('keeps platforms separate and dry-run never writes', async () => {
    const f = linkedFixture([profile, { ...profile, pubg_platform: 'kakao' }]);
    expect(await preserveLinkedMatchPerformance(f.db, { apply: false, limit: 1000 })).toMatchObject({ linkedIdentities: 2, visitedIdentities: 2, prepared: 1, saved: 0 });
    expect(f.db.rpc.mock.calls.map((call: any[]) => call[1].p_platform)).toEqual(['kakao', 'steam']);
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it('paginates the profile list and does not query sources for unlinked players', async () => {
    const f = linkedFixture(Array.from({ length: 1001 }, () => profile));
    expect(await preserveLinkedMatchPerformance(f.db, { apply: false, limit: 1 })).toMatchObject({ linkedIdentities: 1, scanned: 1, limitReached: true });
    expect(f.profileRead.mock.calls).toEqual([[0, 999], [1000, 1999]]);
    expect(f.db.rpc).toHaveBeenCalledTimes(1);
    const empty = linkedFixture([]);
    expect(await preserveLinkedMatchPerformance(empty.db, { apply: false, limit: 10 })).toMatchObject({ linkedIdentities: 0, scanned: 0 });
    expect(empty.db.rpc).not.toHaveBeenCalled();
  });

  it('bounds each identity and the whole run while reporting a full identity page', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...source, match_id: `match-${index}`, data: { fullResult: { ...source.data.fullResult, matchId: `match-${index}` } } }));
    const f = linkedFixture([profile, { ...profile, pubg_nickname: 'Other' }], rows);
    const result = await preserveLinkedMatchPerformance(f.db, { apply: false, limit: 50 });
    expect(result).toMatchObject({ scanned: 50, prepared: 50, limitReached: true, sourceLimitReachedIdentities: 1 });
    expect(f.db.rpc.mock.calls.every((call: any[]) => call[1].p_limit <= 50)).toBe(true);
  });

  it('fails closed on profile, RPC and storage errors', async () => {
    const f = linkedFixture([profile]);
    f.profileRead.mockResolvedValueOnce({ data: null as any, error: { code: '42501' } as any });
    await expect(preserveLinkedMatchPerformance(f.db, { apply: false, limit: 10 })).rejects.toThrow('preserve-performance-profiles-read-failed');
    f.db.rpc.mockImplementationOnce(() => ({ abortSignal: async () => ({ data: null, error: { code: '42501' } }) }));
    await expect(preserveLinkedMatchPerformance(f.db, { apply: false, limit: 10 })).rejects.toThrow('preserve-performance-source-read-failed:42501');
    f.upsert.mockResolvedValueOnce({ error: { code: 'write-failed' } });
    await expect(preserveLinkedMatchPerformance(f.db, { apply: true, limit: 10 })).rejects.toThrow('preserve-performance-write-failed');
  });

  it('rejects an RPC row for another identity before writing', async () => {
    const f = linkedFixture([profile]);
    f.db.rpc.mockImplementationOnce(() => ({ abortSignal: async () => ({ data: [{ ...source, platform: 'kakao' }], error: null }) }));
    await expect(preserveLinkedMatchPerformance(f.db, { apply: true, limit: 10 })).rejects.toThrow('preserve-performance-source-identity-mismatch');
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it.each([0, 1001, 1.5])('rejects invalid limits (%s)', async limit => {
    await expect(preserveLinkedMatchPerformance(linkedFixture([profile]).db, { apply: false, limit })).rejects.toThrow('preserve-performance-limit-invalid');
  });
});
