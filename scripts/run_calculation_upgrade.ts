/** Explicit local raw files only. Dry-run by default; apply uses an exact saved plan. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { AnalysisEngine } from '../lib/pubg-analysis/AnalysisEngine';
import { filterTelemetryEvents } from '../lib/pubg-analysis/telemetryContract';
import { hasMatchingTelemetryDefinition } from '../lib/pubg-analysis/telemetrySource';
import { getValidFullResultForMatch, hasCurrentCalculation } from '../lib/pubg-analysis/cacheIdentity';
import { buildBenchmarkRow } from '../lib/pubg-analysis/persistMatchAnalysis';
import { normalizeName } from '../lib/pubg-analysis/utils';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '../lib/pubg-analysis/constants';

dotenv.config({ path: '.env.local', quiet: true });
const { values } = parseArgs({ options: { manifest: {type:'string'}, output: {type:'string'}, apply: {type:'boolean'}, plan: {type:'string'} } });
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v, (_key,value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value)).digest('hex');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Supabase server environment required');
const db = createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const read = async (table:string,target:any) => {
  const {data,error}=await db.from(table).select('*').eq('match_id',target.matchId).eq('platform',target.platform).eq('player_id',normalizeName(target.nickname)).abortSignal(AbortSignal.timeout(15000)).maybeSingle();
  if(error) throw new Error(`${table} read failed: ${error.code}`); return data;
};
if(values.apply){
  if(!values.plan) throw new Error('--apply requires the reviewed --plan path');
  const plan=JSON.parse(await readFile(values.plan,'utf8'));
  if(plan.version!==1 || plan.calculationVersion!==ANALYSIS_CALCULATION_VERSION || plan.project!==new URL(url).hostname || !Array.isArray(plan.upgrades) || plan.upgrades.length<1 || plan.upgrades.length>10 || plan.hash!==hash(plan.upgrades)) throw new Error('Invalid/stale plan');
  let applied=0;
  for(const row of plan.upgrades){
    // Sequential single-row transaction; any changed snapshot stops the batch.
    const {data,error}=await db.rpc('upgrade_analysis_calculation',row).abortSignal(AbortSignal.timeout(30000));
    if(error || data!==true) throw new Error(`Stopped after ${applied} upgrades: ${error?.code??'snapshot_changed'}`);
    applied++;
    const actual=await read('processed_match_telemetry',{matchId:row.p_match_id,platform:row.p_platform,nickname:row.p_player_id});
    const benchmark=await read('global_benchmarks',{matchId:row.p_match_id,platform:row.p_platform,nickname:row.p_player_id});
    if(hash(actual?.data?.fullResult)!==hash(row.p_full_result) || benchmark?.calculation_version!==ANALYSIS_CALCULATION_VERSION || !Object.entries(row.p_benchmark).every(([field,value])=>hash(benchmark?.[field])===hash(value))) throw new Error('Postcondition failed; batch stopped');
  }
  console.log(JSON.stringify({applied,providerCalls:0,upstreamDownloads:0}));
}else{
  if(!values.manifest || !values.output) throw new Error('Use --manifest targets.json --output plan.json (dry-run); then --apply --plan plan.json');
  const targets=JSON.parse(await readFile(values.manifest,'utf8'));
  if(!Array.isArray(targets)||targets.length<1||targets.length>10) throw new Error('Explicit 1–10 targets required');
  const seen=new Set<string>(), files=new Map<string,any>(), upgrades:any[]=[], decisions:any[]=[];
  const jsonFile=async(path:string)=>{if(!files.has(path))files.set(path,JSON.parse(await readFile(path,'utf8')));return files.get(path);};
  for(const target of targets){
    if(!['steam','kakao'].includes(target.platform)||!target.matchId||!target.nickname||!target.matchFile||!target.telemetryFile)throw new Error('Incomplete target');
    const identity=`${target.platform}/${target.matchId}/${normalizeName(target.nickname)}`;
    if(seen.has(identity)) throw new Error('Duplicate target');seen.add(identity);
    const processed=await read('processed_match_telemetry',target), benchmark=await read('global_benchmarks',target);
    const old=getValidFullResultForMatch(processed,{matchId:target.matchId,platform:target.platform,playerId:target.nickname,minResultVersion:RESULT_VERSION,requireExactResultVersion:true});
    if(!old||!benchmark||hasCurrentCalculation(old)){decisions.push({identity,status:!old?'canonical_missing':!benchmark?'benchmark_missing':'already_current'});continue;}
    let match:any,raw:any;
    try{match=await jsonFile(target.matchFile);raw=await jsonFile(target.telemetryFile);}catch(error:any){if(error.code==='ENOENT'){decisions.push({identity,status:'raw_missing'});continue;}throw error;}
    if(match.data?.id!==target.matchId||!hasMatchingTelemetryDefinition(raw,target.matchId,target.platform)||!raw.some((e:any)=>e._T==='LogMatchStart')||!raw.some((e:any)=>e._T==='LogMatchEnd'))throw new Error('Raw identity mismatch');
    const participants=match.included.filter((p:any)=>p.type==='participant'),rosters=match.included.filter((p:any)=>p.type==='roster');
    const requester=participants.find((p:any)=>normalizeName(p.attributes?.stats?.name)===normalizeName(target.nickname));
    const roster=requester&&rosters.find((r:any)=>r.relationships?.participants?.data?.some((p:any)=>p.id===requester.id));
    if(!roster)throw new Error('Canonical roster missing');
    const members=participants.filter((p:any)=>roster.relationships.participants.data.some((r:any)=>r.id===p.id));
    const ids=new Set<string>(members.map((p:any)=>p.attributes.stats.playerId)),names=new Set<string>(members.map((p:any)=>normalizeName(p.attributes.stats.name)));
    const stats=requester.attributes.stats;
    if((old.stats as any)?.playerId!==stats.playerId && (old.stats as any)?.accountId!==stats.playerId) throw new Error('Previous player binding differs');
    const run=(events:any[])=>{
      const result:any=new AnalysisEngine(stats.name,stats.playerId,names,ids,new Set(),new Set(),roster.id).run(events,{...match.data.attributes,id:target.matchId},rosters,participants,stats,members.map((p:any)=>p.attributes.stats),{});
      delete result.processedAt;delete result.mapData;
      return {...result,platform:target.platform,player_id:normalizeName(target.nickname)};
    };
    const full=run(raw),filtered=run(filterTelemetryEvents(raw,{mode:'full',teamAccountIds:ids,teamNames:names}));
    if(hash(full)!==hash(filtered))throw new Error('Filtered arithmetic differs from raw');
    const nextBenchmark=buildBenchmarkRow({matchId:target.matchId,platform:target.platform,playerNickname:target.nickname,source:'user',forceBenchmark:false,finalResult:full,matchAttr:match.data.attributes});
    if(!nextBenchmark){decisions.push({identity,status:'benchmark_ineligible'});continue;}
    upgrades.push({p_match_id:target.matchId,p_platform:target.platform,p_player_id:normalizeName(target.nickname),p_expected_data:processed.data,p_expected_benchmark:benchmark,p_full_result:full,p_benchmark:nextBenchmark});
    decisions.push({identity,status:'ready',calculationVersion:full.calculationVersion,squadObservation:full.squadObservation});
  }
  await writeFile(values.output,JSON.stringify({version:1,project:new URL(url).hostname,calculationVersion:ANALYSIS_CALCULATION_VERSION,hash:hash(upgrades),upgrades,decisions},null,2),{mode:0o600});
  console.log(JSON.stringify({dryRun:true,targets:targets.length,ready:upgrades.length,decisions,providerCalls:0,upstreamDownloads:0}));
}
