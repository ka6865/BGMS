import 'server-only';
import { getBanWatchAdminClient, requireBanWatchUserId, BanWatchError } from './banWatch.server';
import { isBanAccountId,isBanPlatform } from './banStatus';
import { loadDeathEncounters, type DeathEncounterLoadResult } from './deathEncounters.server';
import { summarizeEncounterProfile } from './encounterProfiles';

export async function encounterContext(platform:unknown,nickname:unknown) {
  const userId=await requireBanWatchUserId();
  if(!isBanPlatform(platform)||typeof nickname!=='string'||!nickname.trim()||nickname.length>64)throw new BanWatchError('invalid_input',400,'플레이어 정보를 확인해주세요.');
  const db=getBanWatchAdminClient();
  const privacy=await db.from('system_settings').select('value').eq('key','private_players_list').maybeSingle();
  if(privacy.error)throw new BanWatchError('store_unavailable',503,'공개 범위를 확인하지 못했습니다.');
  const privateRows=privacy.data?.value?JSON.parse(privacy.data.value):[];
  if(!Array.isArray(privateRows))throw new BanWatchError('store_unavailable',503,'공개 범위를 확인하지 못했습니다.');
  const targetPlatform=String(platform).toLowerCase();
  const scopedPrivateRows=privateRows.filter(p=>String(p?.platform||'').toLowerCase()===targetPlatform||String(p?.platform||'').toLowerCase()==='all');
  const privateNames=new Set<string>(scopedPrivateRows.map(p=>String(p?.lower_nickname||p?.nickname||'').trim().toLowerCase()).filter(Boolean));
  const privateAccountIds=new Set<string>(scopedPrivateRows.map(p=>String(p?.account_id||'').trim()).filter(Boolean));
  if(privateNames.has(nickname.trim().toLowerCase()))throw new BanWatchError('invalid_input',403,'비공개 플레이어입니다.');
  const {data,error}=await db.from('pubg_player_cache').select('id,nickname').eq('platform',platform).eq('lower_nickname',nickname.toLowerCase().trim()).maybeSingle();
  if(error)throw new BanWatchError('store_unavailable',503,'전적 저장소를 확인하지 못했습니다.');
  if(!data || !isBanAccountId(data.id))throw new BanWatchError('not_found',404,'전적 화면에서 플레이어를 먼저 갱신해주세요.');
  if(privateAccountIds.has(data.id))throw new BanWatchError('invalid_input',403,'비공개 플레이어입니다.');
  return {db,userId,platform,accountId:data.id,nickname:data.nickname||nickname,playerId:nickname.toLowerCase().trim(),privateNames,privateAccountIds};
}
export type EncounterContext=Awaited<ReturnType<typeof encounterContext>>;
export async function matchForContext(c:EncounterContext,matchId:unknown) {
  if(typeof matchId!=='string'||matchId.length>128)throw new BanWatchError('invalid_input',400,'경기를 확인해주세요.');
  const {data,error}=await c.db.from('pubg_player_matches').select('*').eq('platform',c.platform).eq('player_id',c.playerId).eq('match_id',matchId).maybeSingle();
  if(error)throw new BanWatchError('store_unavailable',503,'경기 저장소를 확인하지 못했습니다.');
  if(!data || (data.account_id && data.account_id!==c.accountId))throw new BanWatchError('not_found',404,'선택한 플레이어의 경기가 아닙니다.');
  return data;
}
async function visible(c:EncounterContext,result:DeathEncounterLoadResult):Promise<DeathEncounterLoadResult> {
  if(c.privateNames.size===0&&c.privateAccountIds.size===0)return result;
  const ids=[...new Set(result.encounters.map(e=>e.targetAccountId))];
  const hidden=new Set<string>();
  if(ids.length){
    const current=await c.db.from('pubg_player_cache').select('id,lower_nickname').eq('platform',c.platform).in('id',ids);
    if(current.error)throw new BanWatchError('store_unavailable',503,'상대 공개 범위를 확인하지 못했습니다.');
    for(const row of current.data||[])if(c.privateAccountIds.has(row.id)||c.privateNames.has(row.lower_nickname))hidden.add(row.id);
  }
  return {...result,encounters:result.encounters.filter(e=>!c.privateNames.has(e.nicknameAtMatch.toLowerCase())&&!c.privateAccountIds.has(e.targetAccountId)&&!hidden.has(e.targetAccountId))};
}
export async function readEncounter(c:EncounterContext,matchId:string) {
  const {data,error}=await c.db.from('pubg_encounter_cache').select('result').eq('platform',c.platform).eq('subject_account_id',c.accountId).eq('match_id',matchId).eq('extractor_version',2).maybeSingle();
  if(error)throw new BanWatchError('store_unavailable',503,'상대 기록 저장소를 준비 중입니다.');
  if(!data?.result)return null;
  const result=data.result as DeathEncounterLoadResult;
  if(result.source?.verifiedSubjectAccountId!==c.accountId||result.source?.platform!==c.platform||result.source?.matchId!==matchId)throw new BanWatchError('store_failed',503,'경기 상대 기록을 확인하지 못했습니다.');
  return visible(c,result);
}
export async function collectEncounter(c:EncounterContext,matchId:string) {
  const previous=await readEncounter(c,matchId);if(previous)return previous;
  const {data:token,error}=await c.db.rpc('claim_pubg_encounter',{p_platform:c.platform,p_subject:c.accountId,p_match:matchId});
  if(error)throw new BanWatchError('store_failed',503,'상대 기록 수집을 시작하지 못했습니다.');
  if(!token)throw new BanWatchError('encounter_busy',429,'이 경기의 상대 기록을 확인 중입니다.',15);
  try {
    const result=await loadDeathEncounters({platform:c.platform,matchId,subjectAccountId:c.accountId,nickname:c.nickname});
    const saved=await c.db.rpc('finish_pubg_encounter',{p_token:token,p_result:result});
    if(saved.error||saved.data!==true)throw new BanWatchError('store_failed',503,'상대 기록을 저장하지 못했습니다.');
    return visible(c,result);
  } catch (error) {
    // Release the global slot immediately. The row-level cooldown prevents a
    // failing match from being downloaded repeatedly while other users continue.
    try { await c.db.rpc('fail_pubg_encounter',{p_token:token}); } catch { /* original error wins */ }
    throw error;
  }
}
async function limitedApi(c:EncounterContext,path:string) {
  const budget=await c.db.rpc('claim_pubg_encounter_profile_request');
  if(budget.error)throw new BanWatchError('store_failed',503,'통계 조회 예산을 확인하지 못했습니다.');
  if(!budget.data)throw new BanWatchError('rate_limited',429,'통계 조회 대기 중입니다.',60);
  const response=await fetch(`https://api.pubg.com/shards/${c.platform}/${path}`,{headers:{Authorization:`Bearer ${process.env.PUBG_API_KEY}`,Accept:'application/vnd.api+json'},signal:AbortSignal.timeout(10000),redirect:'error'});
  if(response.status===429){
    const retry=response.headers.get('Retry-After');
    const retrySeconds=retry && Number.isFinite(Number(retry))?Number(retry):retry?Math.ceil((Date.parse(retry)-Date.now())/1000):0;
    const reset=Number(response.headers.get('X-RateLimit-Reset'));
    const resetSeconds=Number.isFinite(reset)&&reset>0?Math.ceil((reset*1000-Date.now())/1000):0;
    throw new BanWatchError('rate_limited',429,'PUBG 통계 조회 대기 중입니다.',Math.max(60,Number.isFinite(retrySeconds)?retrySeconds:0,resetSeconds));
  }
  if(!response.ok)throw new BanWatchError('store_unavailable',503,'상대 통계를 확인하지 못했습니다.');
  return response.json();
}
export async function encounterProfile(c:EncounterContext,accountId:string,match:any,refresh:boolean) {
  if(!['official','competitive'].includes(match.match_type)||!['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp'].includes(match.game_mode))throw new BanWatchError('invalid_input',400,'이 경기 모드의 시즌 통계는 지원하지 않습니다.');
  const seasonResponse=await c.db.from('pubg_encounter_seasons').select('*').eq('platform',c.platform).maybeSingle();
  if(seasonResponse.error)throw new BanWatchError('store_unavailable',503,'시즌 정보를 확인하지 못했습니다.');
  let season=seasonResponse.data;
  if(refresh&&(!season||Date.now()-Date.parse(season.checked_at)>6*3600000)){
    const payload=await limitedApi(c,'seasons');const current=payload.data?.find((s:any)=>s.attributes?.isCurrentSeason);
    if(!current?.id)throw new BanWatchError('store_unavailable',503,'현재 시즌을 확인하지 못했습니다.');
    season={platform:c.platform,season_id:current.id,checked_at:new Date().toISOString()};
    const saved=await c.db.from('pubg_encounter_seasons').upsert(season);if(saved.error)throw new BanWatchError('store_failed',503);
  }
  if(!season)return summarizeEncounterProfile(null,match.game_mode,match.match_type,null,null);
  const rows=await c.db.from('pubg_encounter_profiles').select('*').eq('platform',c.platform).eq('account_id',accountId).eq('season_id',season.season_id);
  if(rows.error)throw new BanWatchError('store_unavailable',503);
  const snapshots=new Map<string,any>((rows.data||[]).map(r=>[r.match_type,r]));
  let retry=0;
  if(refresh)for(const type of (match.match_type==='competitive'?['competitive']:['competitive','official'])){
    const old=snapshots.get(type);
    if(old?.checked_at&&Date.now()-Date.parse(old.checked_at)<6*3600000)continue;
    if(old?.retry_at&&Date.parse(old.retry_at)>Date.now()){retry=Math.max(retry,Date.parse(old.retry_at));continue;}
    try{
      const payload=await limitedApi(c,`players/${encodeURIComponent(accountId)}/seasons/${encodeURIComponent(season.season_id)}${type==='competitive'?'/ranked':''}`);
      const stats=type==='competitive'?payload.data?.attributes?.rankedGameModeStats:payload.data?.attributes?.gameModeStats;
      if(!stats||typeof stats!=='object'||Array.isArray(stats))throw new Error('invalid_stats');
      const row={platform:c.platform,account_id:accountId,season_id:season.season_id,match_type:type,stats,checked_at:new Date().toISOString(),retry_at:new Date().toISOString()};
      const write=await c.db.from('pubg_encounter_profiles').upsert(row);if(write.error)throw new BanWatchError('store_failed',503);snapshots.set(type,row);
    }catch(error){
      const seconds=error instanceof BanWatchError&&error.status===429?error.retryAfterSeconds||60:900;
      retry=Date.now()+seconds*1000;
      const write=await c.db.from('pubg_encounter_profiles').upsert({...old,platform:c.platform,account_id:accountId,season_id:season.season_id,match_type:type,retry_at:new Date(retry).toISOString()});
      if(write.error)throw new BanWatchError('store_failed',503);break;
    }
  }
  return {...summarizeEncounterProfile(season.season_id,match.game_mode,match.match_type,snapshots.get('official'),snapshots.get('competitive')),retryAt:retry?new Date(retry).toISOString():null};
}
