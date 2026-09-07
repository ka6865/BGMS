import {withCalculationUpgradeWriteLock} from './calculation_upgrade_write_lock';
/** Canonical-only source preparation and bounded exact-snapshot application. No benchmark writes. */
import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {createClient} from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {calculateUpgradeFromOfficialRaw} from './calculation_upgrade_raw';
import {stableHash} from './calculation_upgrade_batch';
import {acquireCalculationUpgradeCheckpointLock} from './calculation_upgrade_checkpoint';
const {values}=parseArgs({options:{targets:{type:'string'},catalog:{type:'string'},output:{type:'string'},plan:{type:'string'},resume:{type:'string'},apply:{type:'boolean'}}});
dotenv.config({path:'.env.local',quiet:true});
const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw new Error('Supabase environment required');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),project=new URL(url).hostname;
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const save=async(p:string,v:unknown)=>{const temp=`${p}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(v),{mode:0o600});await rename(temp,p);};
const read=async(t:any)=>{const r=await db.from('processed_match_telemetry').select('match_id,platform,player_id,data').eq('match_id',t.matchId).eq('platform',t.platform).eq('player_id',t.playerId).abortSignal(AbortSignal.timeout(15000)).maybeSingle();if(r.error)throw new Error(`canonical_read:${r.error.code}`);return r.data;};
if(values.apply){
 if((values.plan?1:0)+(values.resume?1:0)!==1)throw new Error('one_plan_or_resume_required');
 const input=resolve(values.resume??values.plan!),checkpoint=values.resume?input:`${input}.checkpoint.json`;
 const lock=await acquireCalculationUpgradeCheckpointLock(checkpoint);let plan:any;
 try{
  plan=await json(input);
  if(plan.kind!=='canonical-calculation-upgrade'||plan.version!==1||plan.project!==project||plan.calculationVersion!==2||!Array.isArray(plan.upgrades)||plan.upgrades.length>10||plan.hash!==stableHash(plan.upgrades))throw new Error('invalid_canonical_plan');
  const initialWrites=plan.counters.databaseWrites;
  plan.phase='running';const started=Date.now();await save(checkpoint,plan);
  for(const upgrade of plan.upgrades){
   if(Date.now()-started>120000)throw new Error('canonical_batch_time_cap');
   const t=upgrade.identity,current=await read(t);plan.counters.databaseReads++;
   const mark=()=>{const d=plan.decisions.find((x:any)=>x.identity.matchId===t.matchId&&x.identity.platform===t.platform&&x.identity.playerId===t.playerId);if(!d)throw new Error('missing_decision');d.status='completed';};
   if(stableHash(current?.data?.fullResult)===stableHash(upgrade.fullResult)){mark();await save(checkpoint,plan);continue;}
   if(stableHash(current?.data)!==stableHash(upgrade.expectedData))throw new Error('canonical_snapshot_contended');
   plan.counters.databaseWrites++;await save(checkpoint,plan);
   const r=await withCalculationUpgradeWriteLock(project, async()=> await db.rpc('upgrade_analysis_calculation_canonical',{p_match_id:t.matchId,p_platform:t.platform,p_player_id:t.playerId,p_expected_data:upgrade.expectedData,p_full_result:upgrade.fullResult}).abortSignal(AbortSignal.timeout(30000)));
   if(r.error||r.data!==true)throw new Error(`canonical_apply:${r.error?.code??'contended'}`);
   const actual=await read(t);plan.counters.databaseReads++;
   if(stableHash(actual?.data?.fullResult)!==stableHash(upgrade.fullResult))throw new Error('canonical_postcondition_failed');
   mark();await save(checkpoint,plan);
  }
  plan.phase='completed';await save(checkpoint,plan);console.log(JSON.stringify({phase:plan.phase,completed:plan.decisions.filter((d:any)=>d.status==='completed').length,rpcWriteAttempts:plan.counters.databaseWrites-initialWrites,cumulativeWriteAttempts:plan.counters.databaseWrites}));
 }catch(error:any){if(plan?.kind==='canonical-calculation-upgrade'){plan.phase='paused';plan.error=error.message;await save(checkpoint,plan);}throw error;}
 finally{await lock.release();}
}else{
 if(!values.targets||!values.catalog||!values.output)throw new Error('targets_catalog_output_required');
 const targets=await json(values.targets);if(!Array.isArray(targets)||targets.length<1||targets.length>10)throw new Error('target_cap');
 const seen=new Set<string>();for(const t of targets){const id=`${t.platform}/${t.matchId}/${t.playerId}`;if(seen.has(id)||!['steam','kakao'].includes(t.platform)||!t.playerId||!t.matchId)throw new Error('invalid_target');seen.add(id);}
 const catalog=await json(values.catalog);if(catalog.version!==1||!Array.isArray(catalog.sources))throw new Error('invalid_catalog');
 const sources=new Map<string,any>(),upgrades:any[]=[],decisions:any[]=[];let reads=0;
 for(const identity of targets){
  const previous=await read(identity);reads++;
  if(!previous){decisions.push({identity,status:'canonical_missing'});continue;}
  if(previous.data?.fullResult?.calculationVersion===2){decisions.push({identity,status:'already_current'});continue;}
  const k=`${identity.platform}/${identity.matchId}`;
  if(!sources.has(k)){
   const pair=catalog.sources.find((p:any)=>p.kind==='local_official_raw'&&p.matchId===identity.matchId&&p.platform===identity.platform);if(!pair)throw new Error('source_missing');
   if((await stat(pair.matchFile)).size>2*1024*1024||(await stat(pair.telemetryFile)).size>128*1024*1024)throw new Error('source_byte_cap');
   sources.set(k,{match:await json(pair.matchFile),telemetry:await json(pair.telemetryFile)});
  }
  const {full}=calculateUpgradeFromOfficialRaw(identity,previous,sources.get(k),[72,73]);
  upgrades.push({identity,expectedData:previous.data,fullResult:full});decisions.push({identity,status:'prepared'});
 }
 const plan={kind:'canonical-calculation-upgrade',version:1,project,calculationVersion:2,hash:stableHash(upgrades),phase:'prepared',upgrades,decisions,counters:{databaseReads:reads,databaseWrites:0}};
 await save(resolve(values.output),plan);console.log(JSON.stringify({prepared:upgrades.length,decisions:decisions.length}));
}
