import { describe, expect, it, vi } from 'vitest';
import { preserveMatchPerformance } from '../scripts/preserve_match_performance';
import { buildRetainedPerformanceRow } from '../lib/pubg/retainedPerformance';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '../lib/pubg-analysis/constants';

const source={match_id:'preserve-match',platform:'steam',player_id:'target',data:{fullResult:{
  matchId:'preserve-match',platform:'steam',player_id:'target',v:RESULT_VERSION,
  calculationVersion:ANALYSIS_CALCULATION_VERSION,populationEvidenceVersion:1,
  createdAt:'2026-09-01T00:00:00Z',mapName:'Erangel',gameMode:'squad',matchType:'official',
  isValidBenchmark:false,benchmark:null,stats:{name:'Target',playerId:'account.target',kills:3,damageDealt:400,winPlace:2},
}}};
const compact=()=>buildRetainedPerformanceRow(source.data.fullResult,{matchId:source.match_id,platform:'steam',playerId:'target'})!;

function fixture(existing?:Record<string,any>,completeConcurrently=false){
  let stored=existing ? structuredClone(existing) : undefined;
  const payloads:Record<string,unknown>[]=[];
  const upsert=vi.fn(async(batch:any[],options:any)=>{
    expect(options.ignoreDuplicates).toBe(true);
    if(!stored)stored=structuredClone(batch[0]);
    if(completeConcurrently)stored={...compact(),source_checksum:'f'.repeat(64),summary:{...compact().summary,concurrent:true}};
    return {error:null};
  });
  const db:any={rpc:vi.fn(()=>({abortSignal:async()=>({data:[source],error:null})})),from:()=>{
    let action='select',payload:any;
    const filters:Record<string,unknown>={};
    const q:any={upsert,select:()=>q,eq:(key:string,value:unknown)=>{filters[key]=value;return q;},
      or:()=>q,in:()=>q,update:(value:any)=>{action='update';payload=value;payloads.push(value);return q;},
      abortSignal:()=>{
        if(action==='select')return Promise.resolve({data:stored?[stored]:[],error:null});
        if(stored && Object.entries(filters).every(([key,value])=>stored![key]===value)
          && (!stored.summary || stored.summary_version!==1))Object.assign(stored,payload);
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
  it('preserves a concurrently completed summary and fails verification when the source changed',async()=>{
    const f=fixture({...compact(),summary:null,summary_version:null},true);
    await expect(preserveMatchPerformance(f.db,{apply:true,limit:1})).rejects.toThrow('preserve-performance-readback-failed');
    expect(f.stored()?.summary.concurrent).toBe(true);
    expect(f.stored()?.source_checksum).toBe('f'.repeat(64));
  });
  it('dry-run prepares the result without writing any row',async()=>{
    const f=fixture();
    expect(await preserveMatchPerformance(f.db,{apply:false,limit:1})).toMatchObject({prepared:1,saved:0});
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.payloads).toEqual([]);
  });
});
