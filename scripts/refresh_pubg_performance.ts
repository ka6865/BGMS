/** No work without --apply. Each calculation runs in a killable memory-bounded child. */
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { PersistedFinalResult } from '../lib/pubg-analysis/persistMatchAnalysis';
import type { PerformanceJob } from '../lib/pubg/performanceCalculation';

export function performanceSettlement(result: any) {
  const state = result?.rankingEligible === true ? 'done' : 'excluded';
  return { state, result: state === 'done' ? result : null } as const;
}

export async function runLimitedChild(job: PerformanceJob, timeoutMs = 110_000): Promise<any> {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=512','--import','tsx',process.argv[1],'--calculate'], {stdio:['pipe','pipe','pipe']});
    let output='',error=''; let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    child.stdout.on('data',chunk=>{ output+=chunk; if(output.length>100_000)child.kill('SIGKILL'); });
    child.stderr.on('data',chunk=>{ error=(error+chunk).slice(-1000); });
    child.on('error',err=>{clearTimeout(timer);reject(err);});
    child.on('exit',code=>{clearTimeout(timer);if(code!==0){
      const reported = error.match(/(?:^|\n)BGMS_ERROR:([^\n]*)/)?.[1]?.trim();
      reject(new Error(timedOut?'calculation_timeout':reported || `calculation_failed:${error.slice(0,100)}`));return;}
      try {const line=output.split('\n').find(s=>s.startsWith('BGMS_RESULT:')); if(!line)throw new Error('missing_result');resolve(JSON.parse(line.slice(12)));}catch(err){reject(err);}
    });
    child.stdin.end(JSON.stringify(job));
  });
}
async function readJson(url:string, headers:Record<string,string> = {}, maxBytes=64*1024*1024) {
  const res=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(25_000)});
  if(!res.ok) throw new Error(`upstream_${res.status}`);
  if(Number(res.headers.get('content-length'))>maxBytes)throw new Error('payload_too_large');
  const reader=res.body?.getReader();if(!reader)throw new Error('empty_body');
  const chunks:Uint8Array[]=[];let total=0;
  for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxBytes){await reader.cancel();throw new Error('payload_too_large');}chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function main() {
  if(!process.argv.includes('--apply') && !process.argv.includes('--calculate')){console.log(JSON.stringify({mode:'dry-run',concurrency:1,maxJobs:3,dailyLimit:30,childMemoryMB:512,childTimeoutSeconds:110}));return;}
  const {default:dotenv}=await import('dotenv');dotenv.config({path:'.env.local',quiet:true});
  const {createClient}=await import('@supabase/supabase-js');
  const {ANALYSIS_CALCULATION_VERSION,RESULT_VERSION}=await import('../lib/pubg-analysis/constants');
  const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
  if(process.argv.includes('--calculate')){
    let input='';for await(const chunk of process.stdin)input+=chunk;const job=JSON.parse(input) as PerformanceJob;
    const {getValidFullResultForMatch,hasCurrentCalculation}=await import('../lib/pubg-analysis/cacheIdentity');
    const cached=await db.from('processed_match_telemetry').select('data').eq('platform',job.platform).eq('player_id',job.player_id).eq('match_id',job.match_id).maybeSingle();
    if(cached.error)throw new Error('cache_read_failed');
    const full=getValidFullResultForMatch(cached.data,{matchId:job.match_id,platform:job.platform,playerId:job.player_id,minResultVersion:RESULT_VERSION,requireExactResultVersion:true});
    const {buildBenchmarkRow}=await import('../lib/pubg-analysis/persistMatchAnalysis');
    if(full && hasCurrentCalculation(full) && (full.stats as Record<string,unknown>)?.playerId===job.account_id && full.populationEvidenceVersion===1 && full.benchmark){
      const row=buildBenchmarkRow({matchId:job.match_id,platform:job.platform,playerNickname:job.player_id,finalResult:full as unknown as PersistedFinalResult,source:'user',forceBenchmark:false});
      console.log('BGMS_RESULT:'+JSON.stringify({benchmark:full.benchmark,rankingEligible:Boolean(row)}));return;
    }
    const {relationshipBoundTelemetryAsset,parseOrdinaryTelemetryUrl}=await import('../lib/pubg-analysis/telemetrySource');
    const {preparePerformanceMatch,calculatePerformance}=await import('../lib/pubg/performanceCalculation');
    const {fetchTierBenchmarkStats}=await import('../lib/pubg-analysis/benchmarkLookup');
    const {adaptObservedBenchmark}=await import('../lib/pubg-analysis/benchmarkAdapter');
    const match=await readJson(`https://api.pubg.com/shards/${job.platform}/matches/${encodeURIComponent(job.match_id)}`,{Authorization:`Bearer ${process.env.PUBG_API_KEY}`,Accept:'application/vnd.api+json'},8*1024*1024);
    const c=preparePerformanceMatch(job,match),binding=relationshipBoundTelemetryAsset(match);
    if(!binding)throw new Error('asset_missing');
    const assetUrl=parseOrdinaryTelemetryUrl((binding.asset.attributes as any)?.URL,binding.id);
    const events=await readJson(assetUrl);
    const stats=await fetchTierBenchmarkStats(db,{gameMode:c.attributes.gameMode,matchType:c.attributes.matchType,tier:c.tier});
    const result=calculatePerformance(job,match,events,adaptObservedBenchmark(stats) || {sampleCount: 0});
    console.log('BGMS_RESULT:'+JSON.stringify(result));return;
  }
  // opt-in is required in addition to --apply, including manual invocations.
  if(process.env.PUBG_PERFORMANCE_ENABLED!=='true')throw new Error('PUBG_PERFORMANCE_ENABLED is not true');
  const started=Date.now();let done=0,failed=0;
  const call=async(name:string,args:Record<string,unknown>)=>{const r=await db.rpc(name,args).abortSignal(AbortSignal.timeout(15000));if(r.error)throw new Error(`${name}:${r.error.code}`);return r.data;};
  await call('cleanup_pubg_performance_retention',{p_keep_days:90});
  await call('seed_pubg_performance_jobs',{p_calculation:ANALYSIS_CALCULATION_VERSION,p_result:RESULT_VERSION});
  for(let i=0;i<3 && Date.now()-started<240_000;i++){
    const jobs=await call('claim_pubg_performance_job',{p_daily_limit:30});const job=jobs?.[0] as PerformanceJob|undefined;if(!job)break;
    try{
      const result=await runLimitedChild(job,Math.min(110_000,240_000-(Date.now()-started)));
      const settlement=performanceSettlement(result);
      if(!await call('finish_pubg_performance_job',{p_token:job.lease_token,p_state:settlement.state,p_result:settlement.result}))throw new Error('lease_lost');done++;
    }catch(error){
      failed++;const reason=error instanceof Error?error.message:'calculation_failed';
      const settled=await call('finish_pubg_performance_job',{p_token:job.lease_token,p_state:reason.includes('upstream_404')?'unavailable':'retry',p_error:reason});
      if(!settled)throw new Error('lease_lost');break; // A failing batch stops; no error storm.
    }
  }
  console.log(JSON.stringify({done,failed,durationMs:Date.now()-started}));if(failed)process.exitCode=1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch((error)=>{
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`BGMS_ERROR:${reason.slice(0,200)}`);
  console.error('Performance worker failed; check job state.');
  process.exitCode=1;
});
