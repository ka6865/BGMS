/** Explicit all-user rollout. Immutable inventory, one source match and one CAS at a time. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, rename, unlink, access, statfs, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { stableHash } from './calculation_upgrade_batch';
import { acquireCalculationUpgradeCheckpointLock } from './calculation_upgrade_checkpoint';
import { groupRolloutRows, assertRolloutSnapshot, assertRolloutProgress, type RolloutRow, type RolloutMatch } from './calculation_upgrade_rollout_helpers';
import { assertHttpsHost, readJsonBodyWithinLimit } from './fetch_calculation_upgrade_raw_helpers';

dotenv.config({path:'.env.local',quiet:true});
const {values}=parseArgs({options:{
  'output-dir':{type:'string',default:'tmp/calculation-upgrade-full-rollout'},
  catalog:{type:'string',default:'tmp/calculation-upgrade-raw-catalog.json'},
  apply:{type:'boolean',default:false},'canonical-only':{type:'boolean',default:false},'acquire-raw':{type:'boolean',default:false},
  'max-matches':{type:'string',default:'25'},'max-source-mib':{type:'string',default:'32'},'max-download-mib':{type:'string',default:'512'},
  'max-runtime-minutes':{type:'string',default:'10'},
}});
const positive=(s:string|undefined,max:number)=>{const n=Number(s);if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error('invalid_rollout_limit');return n;};
const maxMatches=positive(values['max-matches'],20000),maxBytes=positive(values['max-download-mib'],256000)*1024*1024;
const sourceLimit=positive(values['max-source-mib'],128)*1024*1024;
const runtimeMs=positive(values['max-runtime-minutes'],720)*60000;
if(values['acquire-raw']&&!values.apply)throw new Error('raw_acquisition_requires_apply');
const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error('Supabase server environment required');
const project=new URL(url).hostname;
const canonicalOnly=values['canonical-only']===true;
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const output=resolve(values['output-dir']!);await mkdir(output,{recursive:true,mode:0o700});
const exists=async(p:string)=>{try{await access(p);return true;}catch{return false;}};
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const save=async(p:string,v:unknown)=>{const temp=`${p}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(v),{mode:0o600});await rename(temp,p);};
const statePath=resolve(output,'state.json'),snapshotPath=resolve(output,'inventory.json');
const lock=await acquireCalculationUpgradeCheckpointLock(statePath);
const started=Date.now();let downloadedThisRun=0,handledThisRun=0;
let state:any;
const child=promisify(execFile);
async function run(script:string,args:string[]){
  try{const r=await child(process.execPath,['node_modules/tsx/dist/cli.mjs',script,...args],{maxBuffer:1024*1024,timeout:180000});return JSON.parse(r.stdout.trim());}
  catch(error:any){throw new Error(`child_failed:${script}:${String(error.stderr||error.message).slice(0,500)}`);}
}
async function readDb(query:any){const r=await query.abortSignal(AbortSignal.timeout(20000));if(r.error)throw new Error(`database_read:${r.error.code||r.error.message}`);return r.data??[];}
async function fetchJson(target:URL,headers:Record<string,string>,label:string){
  state.upstreamRequests++;await save(statePath,state);
  const response=await fetch(target,{headers,redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`${label}_http_${response.status}`);
  const r=await readJsonBodyWithinLimit(response,{maxBytes:label==='telemetry'?sourceLimit:2*1024*1024,remainingBytes:maxBytes-downloadedThisRun,label});
  downloadedThisRun+=r.bytes;state.downloadedBytes+=r.bytes;await save(statePath,state);return r;
}
async function acquire(group:RolloutMatch,dir:string){
  const matchFile=resolve(dir,'match.json'),telemetryFile=resolve(dir,'telemetry.json');
  if(await exists(matchFile)&&await exists(telemetryFile))return {kind:'local_official_raw',matchId:group.matchId,platform:group.platform,matchFile,telemetryFile};
  const disk=await statfs(output);if(disk.bavail*disk.bsize<512*1024*1024)throw new Error('disk_space_below_512_mib');
  if(maxBytes-downloadedThisRun<sourceLimit+2*1024*1024)throw new Error('download_run_cap');
  const apiKey=(process.env.PUBG_API_KEY??'').split(' ')[0];if(!apiKey)throw new Error('PUBG_API_KEY missing');
  const m=await fetchJson(assertHttpsHost(`https://api.pubg.com/shards/${group.platform}/matches/${group.matchId}`,/^api\.pubg\.com$/i,'match'),{Authorization:`Bearer ${apiKey}`,Accept:'application/vnd.api+json'},'match');
  const match=m.value;
  if(match?.data?.id!==group.matchId||match.data.attributes?.shardId!==group.platform)throw new Error('match_identity_rejected');
  if(!['official','competitive'].includes(match.data.attributes?.matchType)||!['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp'].includes(match.data.attributes?.gameMode))throw new Error('source_population_ineligible');
  const assetId=match.data.relationships?.assets?.data?.[0]?.id;
  const asset=match.included?.find((row:any)=>row.type==='asset'&&row.id===assetId);
  const t=await fetchJson(assertHttpsHost(String(asset?.attributes?.URL),/(^|\.)pubg\.com$/i,'telemetry'),{Accept:'application/json'},'telemetry');
  if(!Array.isArray(t.value))throw new Error('telemetry_not_array');
  await save(matchFile,match);await save(telemetryFile,t.value);
  return {kind:'local_official_raw',matchId:group.matchId,platform:group.platform,matchFile,telemetryFile};
}
try{
  let snapshot:any;
  if(await exists(snapshotPath))snapshot=await json(snapshotPath);
  else{
    const max=await readDb(db.from('global_benchmarks').select('id').order('id',{ascending:false}).limit(1));
    const highWater=max[0]?.id??0,rows:RolloutRow[]=[];let cursor=0;
    for(;;){
      const page=await readDb(db.from('global_benchmarks').select('id,match_id,platform,player_id,created_at')
        .in('platform',['steam','kakao']).eq('filter_version',8).eq('population_evidence_version',1)
        .in('match_type',['official','competitive']).in('game_mode',['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp'])
        .or('calculation_version.is.null,calculation_version.lt.2').gt('id',cursor).lte('id',highWater).order('id',{ascending:true}).limit(500));
      rows.push(...page);if(rows.length>20000)throw new Error('inventory_row_cap');
      if(page.length<500)break;cursor=page.at(-1).id;
    }
    if(canonicalOnly){
      rows.length=0;
      const eligible=new Set<string>();let bcursor=0;
      for(;;){const page=await readDb(db.from('global_benchmarks').select('id,match_id,platform,player_id').gt('id',bcursor).lte('id',highWater).eq('filter_version',8).eq('population_evidence_version',1).in('match_type',['official','competitive']).in('game_mode',['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp']).order('id').limit(500));for(const b of page)eligible.add(`${b.platform}/${b.match_id}/${b.player_id}`);if(page.length<500)break;bcursor=page.at(-1).id;}
      const cutoff=new Date().toISOString();let rowId=0;
      for(let offset=0;;offset+=250){
        const page=await readDb(db.from('processed_match_telemetry').select('match_id,platform,player_id,created_at').in('platform',['steam','kakao']).lte('created_at',cutoff).order('match_id').order('platform').order('player_id').range(offset,offset+249));
        for(const r of page){
          if(eligible.has(`${r.platform}/${r.match_id}/${r.player_id}`))continue;
          rows.push({id:++rowId,match_id:r.match_id,platform:r.platform,player_id:r.player_id,created_at:r.created_at});
        }
        if(offset>20000)throw new Error('canonical_inventory_cap');if(page.length<250)break;
      }
    }
    snapshot={version:1,project,calculationVersion:2,canonicalOnly,createdAt:new Date().toISOString(),highWater,rows,hash:stableHash(rows)};
    assertRolloutSnapshot(snapshot,project);await save(snapshotPath,snapshot);
  }
  assertRolloutSnapshot(snapshot,project);if(Boolean(snapshot.canonicalOnly)!==canonicalOnly)throw new Error('rollout_mode_mismatch');const groups=groupRolloutRows(snapshot.rows);
  state=await exists(statePath)?await json(statePath):{version:1,project,inventoryHash:snapshot.hash,nextIndex:0,totalMatches:groups.length,totalRows:snapshot.rows.length,upstreamRequests:0,downloadedBytes:0,results:[],phase:'prepared'};
  assertRolloutProgress(state,snapshot.hash,project,groups.length);
  if(!values.apply){await save(statePath,state);console.log(JSON.stringify({dryRun:true,rows:snapshot.rows.length,matches:groups.length,nextIndex:state.nextIndex,snapshot:snapshotPath}));}
  else{
    const catalogPath=resolve(values.catalog!);const catalog=await exists(catalogPath)?await json(catalogPath):{version:1,sources:[]};
    if(catalog.version!==1||!Array.isArray(catalog.sources))throw new Error('invalid_source_catalog');
    const sources=new Map<string,any>(catalog.sources.map((s:any)=>[`${s.platform}/${s.matchId}`,{...s,matchFile:resolve(dirname(catalogPath),s.matchFile),telemetryFile:resolve(dirname(catalogPath),s.telemetryFile)}]));
    state.phase='running';delete state.error;await save(statePath,state);
    while(state.nextIndex<groups.length&&handledThisRun<maxMatches&&Date.now()-started<runtimeMs&&!await exists(resolve(output,'PAUSE'))){
      const index=state.nextIndex,group=groups[index],dir=resolve(output,`match-${index}`);await mkdir(dir,{recursive:true,mode:0o700});
      const result:any={index,platform:group.platform,matchId:group.matchId,targetRows:group.rows.length,decisions:[],checkpoints:[]};
      // Inspect just version markers before paying for a raw download.
      const meta=await readDb(db.from('processed_match_telemetry').select('player_id,v:data->fullResult->v,calculation:data->fullResult->calculationVersion').eq('match_id',group.matchId).eq('platform',group.platform));
      const currentVersion=meta.filter((r:any)=>(canonicalOnly?[72,73]:[73]).includes(Number(r.v)));
      let source=sources.get(`${group.platform}/${group.matchId}`),owned=false;
      const requestedPlayers=new Set(group.rows.map(r=>r.player_id));
      const requestedMeta=meta.filter((r:any)=>requestedPlayers.has(r.player_id));
      if(canonicalOnly&&requestedMeta.length===requestedPlayers.size&&requestedMeta.every((r:any)=>Number(r.calculation)===2)){result.status='already_current';}
      else if(!currentVersion.length){result.status=meta.length?'legacy_version':'canonical_missing';}
      else{
        if(!source){
          if(!values['acquire-raw'])throw new Error('raw_acquisition_not_enabled');
          try{source=await acquire(group,dir);owned=true;}
          catch(error:any){if(/^(match_http_404|telemetry_http_40[34])$/.test(error.message)){result.status='official_source_unavailable';result.reason=error.message;}else if(error.message==='source_population_ineligible'){result.status='population_ineligible';}else throw error;}
        }
        if(source){
          const pairBytes=(await stat(source.matchFile)).size+(await stat(source.telemetryFile)).size;
          if(pairBytes>sourceLimit+2*1024*1024)throw new Error('raw_pair_exceeds_prepare_cap');
          const localCatalog=resolve(dir,'catalog.json');await save(localCatalog,{version:1,sources:[source]});
          if(canonicalOnly){
            for(let part=0;part<Math.ceil(group.rows.length/10);part++){
              const plan=resolve(dir,`canonical-${part}.json`),checkpoint=`${plan}.checkpoint.json`,targetsFile=resolve(dir,`targets-${part}.json`);
              if(!await exists(plan)){
                await save(targetsFile,group.rows.slice(part*10,part*10+10).map(r=>({matchId:r.match_id,platform:r.platform,playerId:r.player_id})));
                await run('scripts/calculation_upgrade_canonical_batch.ts',['--targets',targetsFile,'--catalog',localCatalog,'--output',plan]);
              }
              if(await exists(checkpoint)){if((await json(checkpoint)).phase!=='completed')await run('scripts/calculation_upgrade_canonical_batch.ts',['--resume',checkpoint,'--apply']);}
              else await run('scripts/calculation_upgrade_canonical_batch.ts',['--plan',plan,'--apply']);
              const completed=await json(checkpoint);if(completed.phase!=='completed')throw new Error('canonical_apply_not_completed');
              result.decisions.push(...completed.decisions);result.checkpoints.push({path:checkpoint,writes:completed.counters.databaseWrites});
            }
          }else{
          // Revisit the SAME match until the bounded ten-row batch has no deferred rows.
          for(let part=0;part<100;part++){
            const plan=resolve(dir,`part-${part}.json`),checkpoint=`${plan}.checkpoint.json`;
            if(!await exists(plan))await run('scripts/prepare_calculation_upgrade_batch.ts',['--pending-only','--platform',group.platform,'--match-id',group.matchId,'--catalog',localCatalog,'--output',plan,'--scan-limit','100','--batch-size','10','--max-source-bytes',String(sourceLimit+2*1024*1024),'--max-total-source-bytes',String(sourceLimit+2*1024*1024)]);
            let manifest=await json(plan);
            if(manifest.decisions.some((d:any)=>d.status==='raw_unavailable'||d.status==='source_byte_cap'))throw new Error('prepared_source_validation_failed:'+plan);
            if(manifest.upgrades.length){
              if(await exists(checkpoint)){
                const prior=await json(checkpoint);
                if(prior.phase!=='completed')await run('scripts/apply_calculation_upgrade_batch.ts',['--resume',checkpoint,'--apply']);
              }else await run('scripts/apply_calculation_upgrade_batch.ts',['--plan',plan,'--checkpoint',checkpoint,'--apply']);
              manifest=await json(checkpoint);
              if(manifest.phase!=='completed')throw new Error('apply_not_completed');
              result.checkpoints.push({path:checkpoint,writes:manifest.counters.databaseWrites});
            }
            result.decisions.push(...manifest.decisions.filter((d:any)=>d.status!=='deferred_batch_limit'));
            if(!manifest.decisions.some((d:any)=>d.status==='deferred_batch_limit'))break;
            if(!manifest.upgrades.length||part===99)throw new Error('batch_made_no_progress');
          }
          }
          result.status='processed';
        }
      }
      state.results.push(result);state.nextIndex++;handledThisRun++;await save(statePath,state);
      // Delete only this job's downloaded scratch pair AFTER persisted verified outcomes.
      if(owned){await unlink(resolve(dir,'match.json'));await unlink(resolve(dir,'telemetry.json'));}
      console.log(JSON.stringify({processedMatches:state.nextIndex,totalMatches:groups.length,status:result.status,completedRows:result.decisions.filter((d:any)=>d.status==='completed').length,downloadedBytes:state.downloadedBytes}));
    }
    state.phase=state.nextIndex===groups.length?'completed':'paused';await save(statePath,state);
    console.log(JSON.stringify({phase:state.phase,processedMatches:state.nextIndex,totalMatches:groups.length,upstreamRequests:state.upstreamRequests,downloadedBytes:state.downloadedBytes,state:statePath}));
  }
}catch(error:any){if(state){state.phase='paused';state.error=error.message;await save(statePath,state);}throw error;}
finally{await lock.release();}
