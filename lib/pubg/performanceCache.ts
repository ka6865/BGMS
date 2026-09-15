import type { SupabaseClient } from '@supabase/supabase-js';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '@/lib/pubg-analysis/constants';
import type { MatchSummaryData } from '@/lib/pubg-analysis/matchSummary';
export async function readPerformanceCache(db: SupabaseClient, platform:string, nickname:string, ids:string[]):Promise<Record<string,MatchSummaryData['benchmark']>> {
  if(!ids.length)return {};
  try {
    const {data,error}=await db.from('pubg_match_performance').select('match_id,benchmark').eq('platform',platform).eq('player_id',nickname.toLowerCase().trim()).eq('calculation_version',ANALYSIS_CALCULATION_VERSION).eq('result_version',RESULT_VERSION).in('match_id',ids);
    if(error)return {}; // Optional additive cache never makes basic history unavailable.
    return Object.fromEntries((data||[]).filter(r=>r.benchmark && Number.isFinite(r.benchmark.score) && r.benchmark.score>=0 && r.benchmark.score<=100).map(r=>[r.match_id,r.benchmark]));
  }catch{return {};}
}
export type PerformanceState = 'pending'|'running'|'done'|'retry'|'unavailable'|'excluded';
export async function readPerformanceStates(db:SupabaseClient,platform:string,nickname:string,ids:string[]):Promise<Record<string,PerformanceState>>{
  if(!ids.length)return {};
  try{
    const {data,error}=await db.from('pubg_performance_jobs').select('match_id,state').eq('platform',platform).eq('player_id',nickname.toLowerCase().trim()).eq('calculation_version',ANALYSIS_CALCULATION_VERSION).eq('result_version',RESULT_VERSION).in('match_id',ids);
    if(error)return {};
    return Object.fromEntries((data||[]).filter(r=>['pending','running','done','retry','unavailable','excluded'].includes(r.state)).map(r=>[r.match_id,r.state]));
  }catch{return {};}
}
