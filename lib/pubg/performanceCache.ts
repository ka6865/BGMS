import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPPORTED_ANALYSIS_CALCULATION_VERSIONS, RESULT_VERSION } from '@/lib/pubg-analysis/constants';
import type { MatchSummaryData } from '@/lib/pubg-analysis/matchSummary';
export async function readPerformanceCache(db: SupabaseClient, platform:string, nickname:string, ids:string[], accountId?:string|null):Promise<Record<string,MatchSummaryData['benchmark']>> {
  if(!ids.length)return {};
  try {
    let query=db.from('pubg_match_performance').select('match_id,benchmark,calculation_version').eq('platform',platform);
    query=accountId && /^account\.[A-Za-z0-9_-]+$/.test(accountId) ? query.eq('account_id',accountId) : query.eq('player_id',nickname.toLowerCase().trim());
    const {data,error}=await query.in('calculation_version',[...SUPPORTED_ANALYSIS_CALCULATION_VERSIONS]).eq('result_version',RESULT_VERSION).in('match_id',ids).order('calculation_version',{ascending:true});
    if(error)return {}; // Optional additive cache never makes basic history unavailable.
    return Object.fromEntries((data||[]).filter(r=>r.benchmark && Number.isFinite(r.benchmark.score) && r.benchmark.score>=0 && r.benchmark.score<=100).map(r=>[r.match_id,r.benchmark]));
  }catch{return {};}
}
export type PerformanceState = 'pending'|'running'|'done'|'retry'|'unavailable'|'excluded';
export async function readPerformanceStates(db:SupabaseClient,platform:string,nickname:string,ids:string[],accountId?:string|null):Promise<Record<string,PerformanceState>>{
  if(!ids.length)return {};
  try{
    let query=db.from('pubg_performance_jobs').select('match_id,state,calculation_version').eq('platform',platform);
    query=accountId && /^account\.[A-Za-z0-9_-]+$/.test(accountId) ? query.eq('account_id',accountId) : query.eq('player_id',nickname.toLowerCase().trim());
    const {data,error}=await query.in('calculation_version',[...SUPPORTED_ANALYSIS_CALCULATION_VERSIONS]).eq('result_version',RESULT_VERSION).in('match_id',ids).order('calculation_version',{ascending:true});
    if(error)return {};
    return Object.fromEntries((data||[]).filter(r=>['pending','running','done','retry','unavailable','excluded'].includes(r.state)).map(r=>[r.match_id,r.state]));
  }catch{return {};}
}
