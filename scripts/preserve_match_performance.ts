/** 분석 자료를 정리하기 전에 작은 성과 요약을 DB에 보존한다. 기본은 읽기만 수행한다. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildRetainedPerformanceRow } from '../lib/pubg/retainedPerformance';

export async function preserveMatchPerformance(db: SupabaseClient, input: {apply:boolean;limit:number;nickname?:string}) {
  const result = {mode:input.apply?'apply':'dry-run',scanned:0,prepared:0,saved:0,skipped:0};
  const {data,error}=await db.rpc('list_unretained_match_performance', {
    p_limit:input.limit,p_player_id:input.nickname?.toLowerCase().trim() ?? null,
  }).abortSignal(AbortSignal.timeout(30_000));
  if(error || !Array.isArray(data))throw new Error(`preserve-performance-source-read-failed:${error?.code ?? 'invalid-response'}`);
  const rows=[];
  for(const source of data){
    result.scanned++;
    const row=buildRetainedPerformanceRow(source.data?.fullResult,{matchId:source.match_id,platform:source.platform,playerId:source.player_id});
    if(!row){result.skipped++;continue;}
    rows.push(row);result.prepared++;
  }
  if(!input.apply)return result;
  for(let index=0;index<rows.length;index+=50){
    const batch=rows.slice(index,index+50);
    const {error:writeError}=await db.from('pubg_match_performance').upsert(batch,{onConflict:'platform,account_id,match_id,calculation_version,result_version'})
      .abortSignal(AbortSignal.timeout(30_000));
    if(writeError)throw new Error('preserve-performance-write-failed');
    const {data:saved,error:verifyError}=await db.from('pubg_match_performance')
      .select('platform,account_id,match_id,calculation_version,result_version,source_checksum,summary_version')
      .in('match_id',batch.map(row=>row.match_id)).abortSignal(AbortSignal.timeout(30_000));
    if(verifyError || !Array.isArray(saved))throw new Error('preserve-performance-readback-failed');
    for(const row of batch){
      if(!saved.some(s=>s.platform===row.platform && s.account_id===row.account_id && s.match_id===row.match_id
        && s.calculation_version===row.calculation_version && s.result_version===row.result_version
        && s.source_checksum===row.source_checksum && s.summary_version===row.summary_version))
        throw new Error('preserve-performance-readback-failed');
      result.saved++;
    }
  }
  return result;
}
async function main(){
  dotenv.config({path:process.env.BGMS_ENV_FILE || '.env.local',quiet:true});
  const argv=process.argv.slice(2),limitIndex=argv.indexOf('--limit'),nameIndex=argv.indexOf('--nickname');
  const limit=limitIndex<0?100:Number(argv[limitIndex+1]);
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('preserve-performance-limit-invalid');
  if(nameIndex>=0&&!/^[A-Za-z0-9_-]{3,30}$/.test(argv[nameIndex+1]||''))throw new Error('preserve-performance-nickname-invalid');
  if(!process.env.NEXT_PUBLIC_SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('preserve-performance-env-missing');
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  console.log(JSON.stringify(await preserveMatchPerformance(db,{apply:argv.includes('--apply'),limit,nickname:nameIndex<0?undefined:argv[nameIndex+1]})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch((error: unknown)=>{
  const reason = error instanceof Error && /^preserve-performance-[a-z-]+(?::[A-Za-z0-9-]+)?$/.test(error.message)
    ? error.message : 'preserve-performance-unexpected-failure';
  console.error(`성과 요약 보존에 실패했습니다. 원본 자료를 정리하지 않습니다. (${reason})`);process.exitCode=1;
});
