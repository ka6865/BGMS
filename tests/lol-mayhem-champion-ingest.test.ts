import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({db:vi.fn(),config:vi.fn(),champions:vi.fn(),champion:vi.fn(),rpc:vi.fn(),upload:vi.fn(),download:vi.fn(),upsert:vi.fn(),candidate:vi.fn(),from:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('../lib/server/serviceRoleSupabase.server',()=>({createServiceRoleSupabase:mocks.db}));
vi.mock('../lib/lol/mayhemChampionSource',()=>({createChampionSource:()=>({config:mocks.config,champions:mocks.champions,champion:mocks.champion,remaining:()=>180})}));
vi.mock('../lib/lol/mayhemChampionDatasetStore.server',()=>({createChampionDatasetCandidate:mocks.candidate,getChampionDatasetReadiness:()=>({enabled:process.env.LOL_MAYHEM_CHAMPION_DATASET_ENABLED==='true',persistenceEnabled:process.env.LOL_PERSISTENCE_ENABLED==='true',apiKeyConfigured:!!process.env.LOL_MAYHEM_STATS_API_KEY,reuseConfirmed:process.env.LOL_MAYHEM_STATS_REUSE_CONFIRMED==='true'})}));
import { ingestChampionDataset } from '../lib/lol/mayhemChampionIngest.server';
const version={schemaVersion:1,gamePatch:'16.21',dataVersion:'16.21.5'};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('LOL_MAYHEM_STATS_API_KEY','test');vi.stubEnv('LOL_MAYHEM_CHAMPION_DATASET_ENABLED','true');vi.stubEnv('LOL_PERSISTENCE_ENABLED','true');vi.stubEnv('LOL_MAYHEM_STATS_REUSE_CONFIRMED','true');vi.stubEnv('LOL_MAYHEM_STATS_REUSE_BASIS','documented-permission');vi.stubEnv('LOL_MAYHEM_STATS_ATTRIBUTION','Example API');
 mocks.config.mockResolvedValue(version);mocks.champions.mockResolvedValue([29,99]);
 mocks.champion.mockImplementation(async(id:number)=>{const value=[[String(id),JSON.stringify({source:'tencent',region:'CN',augments:{'3081':{pick_rate:'0.0697',num_games:null}}}),'16.21','2026-10-30']];return{value,body:JSON.stringify(value)};});
 mocks.rpc.mockImplementation((name:string)=>Promise.resolve({data:name==='acquire_lol_collection_lease'?[{lease_token:'token'}]:name==='get_lol_mayhem_champion_storage_bytes'?0:null,error:null}));
 mocks.upload.mockResolvedValue({error:null});mocks.download.mockResolvedValue({data:null,error:{status:404}});mocks.candidate.mockResolvedValue(42);mocks.upsert.mockImplementation(()=>({abortSignal:async()=>({error:null})}));
 mocks.from.mockImplementation((table:string)=>{
 const value=table==='lol_game_patches'?{client_patch:'16.21',ddragon_version:'16.21.1'}:table==='lol_augment_patch_states'?[{platform_id:3081}]:[];
 const query={select:()=>query,eq:()=>query,order:()=>query,limit:()=>query,abortSignal:()=>query,maybeSingle:async()=>({data:table==='lol_data_sync_status'?null:value,error:null}),single:async()=>({data:value,error:null}),upsert:mocks.upsert,then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:value,error:null}).then(resolve)};return query;});
 mocks.db.mockReturnValue({rpc:mocks.rpc,from:mocks.from,storage:{from:()=>({upload:mocks.upload,download:mocks.download})}});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:{Twitch:{key:'29'},Lux:{key:'99'}}}))));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('챔피언 통계 수집 운영 경계',()=>{
 it('키·쓰기 설정 누락은 네트워크와 DB 호출 전에 차단한다',async()=>{
  vi.stubEnv('LOL_MAYHEM_STATS_API_KEY','');await expect(ingestChampionDataset({apply:false})).rejects.toThrow('stats_api_key_missing');expect(mocks.config).not.toHaveBeenCalled();expect(mocks.db).not.toHaveBeenCalled();
  vi.stubEnv('LOL_MAYHEM_STATS_API_KEY','test');vi.stubEnv('LOL_MAYHEM_CHAMPION_DATASET_ENABLED','false');await expect(ingestChampionDataset({apply:true})).rejects.toThrow('stats_sync_disabled');
 });
 it('공식 목록의 일부만 받은 경우 유료 상세 수집과 후보 생성을 차단한다',async()=>{
  mocks.champions.mockResolvedValue([29]);await expect(ingestChampionDataset({apply:true})).rejects.toThrow('stats_incomplete_champion_list');expect(mocks.champion).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();expect(mocks.candidate).not.toHaveBeenCalled();
 });
 it('dry-run은 공식 카탈로그를 읽지만 DB·Storage를 쓰지 않는다',async()=>{
  expect(await ingestChampionDataset({apply:false})).toMatchObject({dryRun:true,status:'validated',champions:2});expect(mocks.upload).not.toHaveBeenCalled();expect(mocks.upsert).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.candidate).not.toHaveBeenCalled();
 });
 it('완전한 manifest 후보를 생성하고 공개 RPC는 호출하지 않는다',async()=>{
  expect(await ingestChampionDataset({apply:true})).toMatchObject({id:42,status:'awaiting_review',champions:2});expect(mocks.candidate).toHaveBeenCalledOnce();expect(mocks.candidate.mock.calls[0][0].metadata.files).toHaveLength(2);expect(mocks.rpc.mock.calls.some(([name])=>String(name).startsWith('review_'))).toBe(false);expect(mocks.rpc).toHaveBeenLastCalledWith('release_lol_collection_lease',{p_key:'ops:lol-mayhem-champion:champion_api_v1',p_token:'token'});
 });
 it('공개 재사용 확인 전에도 근거가 있는 비공개 후보는 수집한다',async()=>{
  vi.stubEnv('LOL_MAYHEM_STATS_REUSE_CONFIRMED','false');expect(await ingestChampionDataset({apply:true})).toMatchObject({status:'awaiting_review'});expect(mocks.candidate).toHaveBeenCalledOnce();
 });
 it('수집 근거·출처가 없으면 쓰기를 차단한다',async()=>{
  vi.stubEnv('LOL_MAYHEM_STATS_REUSE_BASIS','');await expect(ingestChampionDataset({apply:true})).rejects.toThrow('stats_collection_basis_missing');expect(mocks.upload).not.toHaveBeenCalled();
 });
 it('저장 예산 초과는 업로드 전에 종료한다',async()=>{
  mocks.rpc.mockImplementation((name:string)=>Promise.resolve({data:name==='acquire_lol_collection_lease'?[{lease_token:'token'}]:2*1024**3,error:null}));await expect(ingestChampionDataset({apply:true})).rejects.toThrow('stats_storage_budget');expect(mocks.upload).not.toHaveBeenCalled();
 });
 it('quota途中停止は候補を作らず進捗を保ち次の実行で再開する',async()=>{
  const objects=new Map<string,string>();mocks.upload.mockImplementation(async(path:string,body:string)=>{objects.set(path,body);return{error:null};});mocks.download.mockImplementation(async(path:string)=>objects.has(path)?{data:new Blob([objects.get(path)!]),error:null}:{data:null,error:{status:404}});
  const good=mocks.champion.getMockImplementation()!;mocks.champion.mockImplementation(async(id:number)=>{if(id===99)throw new Error('stats_quota_deferred');return good(id);});
  expect(await ingestChampionDataset({apply:true})).toMatchObject({status:'deferred_quota'});expect(mocks.candidate).not.toHaveBeenCalled();
  mocks.champion.mockImplementation(good);mocks.champion.mockClear();expect(await ingestChampionDataset({apply:true})).toMatchObject({status:'awaiting_review'});expect(mocks.champion).toHaveBeenCalledTimes(1);expect(mocks.champion).toHaveBeenCalledWith(99);
 });
 it('상태 기록·lease 해제 실패가 원래 수집 오류를 덮어쓰지 않는다',async()=>{
  mocks.champion.mockRejectedValue(new Error('stats_api_key_invalid'));
  mocks.upsert.mockImplementation(()=>({abortSignal:async()=>({error:{message:'database down'}})}));
  const rpc=mocks.rpc.getMockImplementation()!;mocks.rpc.mockImplementation((name:string,args:unknown)=>name==='release_lol_collection_lease'?Promise.resolve({error:{message:'database down'}}):rpc(name,args));
  await expect(ingestChampionDataset({apply:true})).rejects.toThrow('stats_api_key_invalid');
 });
 it('원본 버전 혼합과 저장 실패는 후보 생성을 차단한다',async()=>{
  mocks.config.mockResolvedValueOnce(version).mockResolvedValue({...version,dataVersion:'16.21.6'});await expect(ingestChampionDataset({apply:true})).rejects.toThrow('source_version_mismatch');expect(mocks.candidate).not.toHaveBeenCalled();
  mocks.config.mockResolvedValue(version);mocks.upload.mockResolvedValue({error:{statusCode:'500'}});await expect(ingestChampionDataset({apply:true})).rejects.toThrow('stats_storage_error');expect(mocks.candidate).not.toHaveBeenCalled();
 });
});
