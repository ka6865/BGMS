import 'server-only';
import { createHash } from 'node:crypto';
import { createServiceRoleSupabase } from '@/lib/server/serviceRoleSupabase.server';
import { createSourceDownloader } from './augments/ingest';
import { createChampionSource } from './mayhemChampionSource';
import { createChampionDatasetCandidate, getChampionDatasetReadiness } from './mayhemChampionDatasetStore.server';
import { CHAMPION_DATASET_PREFIX as PREFIX, CHAMPION_DATASET_MAX_BATCH_BYTES, CHAMPION_DATASET_MAX_FILE_BYTES,
  normalizeChampionAugments, validateChampionStatsFile, type ChampionDatasetManifest, type ChampionManifestFile } from './mayhemChampionDataset';
const LEASE='ops:lol-mayhem-champion:champion_api_v1';
const JOB='mayhem-champion:champion_api_v1';
const sha=(body:string)=>createHash('sha256').update(body).digest('hex');
const signal=()=>AbortSignal.timeout(10_000);
const code=(error:unknown)=>error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)?error.message:'stats_sync_failed';
export type ChampionIngestSummary={dryRun:boolean;status:'validated'|'unchanged'|'awaiting_review'|'deferred_quota';champions:number;rows:number;id?:number;patch?:string;upstreamVersion?:string;bytes?:number};
export async function ingestChampionDataset(options:{apply:boolean}):Promise<ChampionIngestSummary> {
  const ready=getChampionDatasetReadiness();
  if(!ready.apiKeyConfigured)throw new Error('stats_api_key_missing');
  if(options.apply && (!ready.enabled||!ready.persistenceEnabled))throw new Error('stats_sync_disabled');
  if(options.apply && !ready.reuseConfirmed)throw new Error('stats_reuse_unconfirmed');
  const startedAt=Date.now();const fetchedAt=new Date(startedAt).toISOString();
  let token:string|null=null;let lastRenew=0;let previousFailures=0;let bytes=0;let rows=0;let previousCounts:Record<string,unknown>|null=null;
  const db=createServiceRoleSupabase((url,init)=>fetch(url,{...init,signal:init?.signal?AbortSignal.any([init.signal,signal()]):signal()}));
  const storage=db.storage.from('lol-augment-snapshots');
  async function rpc<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
    const result=await db.rpc(name,args);if(result.error)throw new Error('stats_database_error');return result.data as T;
  }
  async function renew(force=false){
    if(Date.now()-startedAt>540_000)throw new Error('stats_sync_deadline');
    if(token && (force||Date.now()-lastRenew>30_000)){await rpc('renew_lol_mayhem_champion_dataset_lease',{p_token:token});lastRenew=Date.now();}
  }
  const api=createChampionSource({apiKey:process.env.LOL_MAYHEM_STATS_API_KEY,beforeRequest:()=>renew()});
  async function read(path:string,limit=CHAMPION_DATASET_MAX_FILE_BYTES):Promise<string|null>{
    await renew();const result=await storage.download(path);
    if(result.error){const status=String((result.error as {statusCode?:unknown;status?:unknown}).statusCode??(result.error as {status?:unknown}).status);if(status==='404'||status==='400'&&/not found/i.test(result.error.message??''))return null;throw new Error('stats_storage_error');}
    if(!result.data||result.data.size>limit)throw new Error('stats_snapshot_invalid');return result.data.text();
  }
  async function upload(path:string,body:string,mutable=false){
    await renew();bytes+=Buffer.byteLength(body);if(bytes>CHAMPION_DATASET_MAX_BATCH_BYTES)throw new Error('stats_batch_too_large');
    const saved=await storage.upload(path,body,{contentType:'application/json',upsert:mutable});
    if(saved.error){if(mutable || await read(path)!==body)throw new Error('stats_storage_error');}
  }
  async function saveStatus(value:Record<string,unknown>){
    const result=await db.from('lol_data_sync_status').upsert({job_key:JOB,last_checked_at:fetchedAt,...value}).abortSignal(signal());
    if(result.error)throw new Error('stats_status_error');
  }
  let files:ChampionManifestFile[]=[];
  try {
    if(options.apply){
      const lease=await rpc<Array<{lease_token:string}>>('acquire_lol_collection_lease',{p_key:LEASE,p_ttl_seconds:120});token=lease[0]?.lease_token??null;if(!token)throw new Error('stats_lease_busy');lastRenew=Date.now();
      const previous=await db.from('lol_data_sync_status').select('consecutive_failures,counts').eq('job_key',JOB).abortSignal(signal()).maybeSingle();
      if(previous.error)throw new Error('stats_database_error');previousFailures=previous.data?.consecutive_failures??0;previousCounts=previous.data?.counts??null;
    }
    const version=await api.config();
    const [patch,states]=await Promise.all([
      db.from('lol_game_patches').select('client_patch,ddragon_version').eq('client_patch',version.gamePatch).abortSignal(signal()).single(),
      db.from('lol_augment_patch_states').select('platform_id').eq('client_patch',version.gamePatch).eq('mode_name','KIWI').eq('in_pool',true).order('platform_id').limit(1000).abortSignal(signal()),
    ]);
    if(patch.error||states.error||!states.data?.length||states.data.length>=1000)throw new Error('stats_official_catalog_missing');
    const ddragon=patch.data?.ddragon_version;if(typeof ddragon!=='string'||!/^\d+\.\d+\.\d+$/.test(ddragon)||!ddragon.startsWith(`${version.gamePatch}.`))throw new Error('stats_champion_catalog_missing');
    const allowed=new Set<number>(states.data.map(row=>row.platform_id));const catalogHash=sha(JSON.stringify([...allowed].sort((a,b)=>a-b)));
    if(options.apply&&previousCounts?.upstreamVersion===version.dataVersion&&previousCounts?.catalogHash===catalogHash&&previousCounts?.completed===true){await saveStatus({last_error_code:null,consecutive_failures:0});return{dryRun:false,status:'unchanged',champions:0,rows:0,patch:version.gamePatch,upstreamVersion:version.dataVersion};}
    const officialRaw=await createSourceDownloader((url,init)=>fetch(url,{...init,redirect:'error',signal:signal()}))(`https://ddragon.leagueoflegends.com/cdn/${ddragon}/data/en_US/champion.json`,true,CHAMPION_DATASET_MAX_FILE_BYTES);
    const official=JSON.parse(officialRaw) as {data?:Record<string,{key?:string}>};if(!official.data||typeof official.data!=='object')throw new Error('stats_champion_catalog_missing');
    const championIds=await api.champions(version);const registered=new Set(Object.values(official.data).map(v=>Number(v.key)));
    if(championIds.some(id=>!registered.has(id)))throw new Error('stats_unknown_champion');
    if(championIds.length!==registered.size)throw new Error('stats_incomplete_champion_list');
    let sourceDataDate='';
    const progressPath=`${PREFIX}/progress/${version.dataVersion}-${catalogHash}.json`;
    if(options.apply){
      const usage=await rpc<number|string>('get_lol_mayhem_champion_storage_bytes');
      if(!Number.isSafeInteger(Number(usage))||Number(usage)<0||Number(usage)+CHAMPION_DATASET_MAX_BATCH_BYTES+1024*1024>2*1024**3)throw new Error('stats_storage_budget');
      const progressBody=await read(progressPath,1024*1024);
      if(progressBody!==null){
        let progress:ChampionDatasetManifest;try{progress=JSON.parse(progressBody);}catch{throw new Error('stats_progress_invalid');}
        if(progress.schemaVersion!==1||progress.source!=='champion_api_v1'||progress.cohort!=='source_default'||progress.clientPatch!==version.gamePatch||progress.upstreamVersion!==version.dataVersion||progress.catalogHash!==catalogHash
          ||JSON.stringify(progress.expectedChampionIds)!==JSON.stringify(championIds)||!Array.isArray(progress.files)||progress.files.length>championIds.length)throw new Error('stats_progress_invalid');
        sourceDataDate=progress.sourceDataDate;files=progress.files;
        const seen=new Set<number>();
        for(const file of files){
          if(!championIds.includes(file.championId)||seen.has(file.championId)||file.rawPath!==`${PREFIX}/objects/${file.rawHash}.json`||file.normalizedPath!==`${PREFIX}/objects/${file.normalizedHash}.json`||!/^[a-f0-9]{64}$/.test(file.rawHash)||!/^[a-f0-9]{64}$/.test(file.normalizedHash))throw new Error('stats_progress_invalid');seen.add(file.championId);
          const [raw,normal]=await Promise.all([read(file.rawPath),read(file.normalizedPath)]);
          if(raw===null||normal===null||sha(raw)!==file.rawHash||sha(normal)!==file.normalizedHash||Buffer.byteLength(raw)!==file.rawBytes||Buffer.byteLength(normal)!==file.normalizedBytes)throw new Error('stats_progress_invalid');
          const normalized=validateChampionStatsFile(JSON.parse(normal));
          const reparsed=normalizeChampionAugments(JSON.parse(raw),{clientPatch:version.gamePatch,championId:file.championId,upstreamVersion:version.dataVersion,sourceDataDate,allowedAugmentIds:allowed,fetchedAt:normalized.fetchedAt,catalogHash});
          if(JSON.stringify(normalized)!==JSON.stringify(reparsed))throw new Error('stats_progress_invalid');rows+=normalized.rows.length;
        }
      }
    }
    const manifest=():ChampionDatasetManifest=>({schemaVersion:1,source:'champion_api_v1',cohort:'source_default',clientPatch:version.gamePatch,upstreamVersion:version.dataVersion,sourceDataDate,catalogHash,expectedChampionIds:championIds,files:[...files].sort((a,b)=>a.championId-b.championId),attribution:process.env.LOL_MAYHEM_STATS_ATTRIBUTION?.trim()??'',rightsBasis:process.env.LOL_MAYHEM_STATS_REUSE_BASIS?.trim()??'',normalizerVersion:1});
    for(const championId of championIds){
      if(files.some(file=>file.championId===championId))continue;
      await renew();const raw=await api.champion(championId);
      if(!Array.isArray(raw.value)||!Array.isArray(raw.value[0])||typeof raw.value[0][3]!=='string')throw new Error('invalid_champion_tuple');
      if(!sourceDataDate)sourceDataDate=raw.value[0][3];
      const normalized=normalizeChampionAugments(raw.value,{clientPatch:version.gamePatch,championId,upstreamVersion:version.dataVersion,sourceDataDate,allowedAugmentIds:allowed,fetchedAt,catalogHash});
      const body=JSON.stringify(normalized);const rawHash=sha(raw.body);const normalizedHash=sha(body);
      const file={championId,rawPath:`${PREFIX}/objects/${rawHash}.json`,rawHash,rawBytes:Buffer.byteLength(raw.body),normalizedPath:`${PREFIX}/objects/${normalizedHash}.json`,normalizedHash,normalizedBytes:Buffer.byteLength(body)};
      if(options.apply){await upload(file.rawPath,raw.body);await upload(file.normalizedPath,body);}
      else{bytes+=file.rawBytes+file.normalizedBytes;if(bytes>CHAMPION_DATASET_MAX_BATCH_BYTES)throw new Error('stats_batch_too_large');}
      files.push(file);rows+=normalized.rows.length;
      if(options.apply)await upload(progressPath,JSON.stringify(manifest()),true);
    }
    const after=await api.config();if(after.dataVersion!==version.dataVersion||after.gamePatch!==version.gamePatch)throw new Error('source_version_mismatch');
    if(files.length!==championIds.length)throw new Error('stats_incomplete_dataset');
    if(!options.apply)return{dryRun:true,status:'validated',champions:files.length,rows,bytes,patch:version.gamePatch,upstreamVersion:version.dataVersion};
    const metadata=manifest();const manifestBody=JSON.stringify(metadata);const captureHash=sha(manifestBody);const manifestPath=`${PREFIX}/captures/${captureHash}/manifest.json`;
    await upload(manifestPath,manifestBody);await renew(true);
    const id=await createChampionDatasetCandidate({clientPatch:version.gamePatch,upstreamVersion:version.dataVersion,sourceDataDate,captureHash,manifestPath,catalogHash,metadata,leaseToken:token!});
    await saveStatus({last_fetch_succeeded_at:new Date().toISOString(),last_data_changed_at:new Date().toISOString(),last_success_at:new Date().toISOString(),last_error_code:null,consecutive_failures:0,counts:{champions:files.length,rows,bytes,upstreamVersion:version.dataVersion,catalogHash,completed:true}});
    return{dryRun:false,status:'awaiting_review',id,champions:files.length,rows,bytes,patch:version.gamePatch,upstreamVersion:version.dataVersion};
  }catch(error){
    if(options.apply&&token){try{await saveStatus({last_error_code:code(error),consecutive_failures:previousFailures+1,counts:{champions:files.length,rows,completed:false}});}catch{console.warn('[lol-mayhem-champion] stats_status_error');}}
    if(code(error)==='stats_quota_deferred')return{dryRun:!options.apply,status:'deferred_quota',champions:files.length,rows};
    throw error;
  }finally{if(token){try{await rpc('release_lol_collection_lease',{p_key:LEASE,p_token:token});}catch{console.warn('[lol-mayhem-champion] stats_lease_release_failed');}}}
}
