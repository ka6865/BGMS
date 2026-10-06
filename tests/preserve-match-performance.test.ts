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
