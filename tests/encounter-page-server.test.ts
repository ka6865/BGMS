import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({tables:{} as Record<string,any[]>,errors:new Set<string>(),writes:[] as any[],load:vi.fn(),rpc:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/pubg/deathEncounters.server',()=>({loadDeathEncounters:m.load}));
vi.mock('@/lib/pubg/banWatch.server',()=>({
 requireBanWatchUserId:async()=> 'user-1',
 BanWatchError:class extends Error{constructor(public code:string,public status:number,message=code,public retryAfterSeconds?:number){super(message);}},
 getBanWatchAdminClient:()=>({rpc:m.rpc,from:(table:string)=>{
   const filters:((r:any)=>boolean)[]=[];
   const result=()=>({data:(m.tables[table]||[]).filter(r=>filters.every(f=>f(r))),error:m.errors.has(table)?{code:'unavailable'}:null});
   const q:any={select:()=>q,eq:(k:string,v:any)=>{filters.push(r=>r[k]===v);return q;},in:(k:string,v:any[])=>{filters.push(r=>v.includes(r[k]));return q;},maybeSingle:async()=>{const r=result();return {...r,data:r.data[0]||null};},then:(resolve:any)=>Promise.resolve(result()).then(resolve),upsert:async(row:any)=>{m.writes.push({table,row});return {error:null};}};return q;
 }}),
}));
import {encounterContext,readEncounter,collectEncounter,encounterProfile} from '@/lib/pubg/encounterPage.server';
const source={platform:'steam',matchId:'m',verifiedSubjectAccountId:'account.subject',verifiedSubjectNicknameAtMatch:'Subject'};
beforeEach(()=>{
 m.tables={'pubg_player_cache':[{id:'account.subject',platform:'steam',lower_nickname:'subject',nickname:'Subject'}]};m.errors.clear();m.writes=[];m.load.mockReset();m.rpc.mockReset();vi.restoreAllMocks();
});
describe('상대 페이지 서버',()=>{
 it('공개 범위 조회 실패 시 플레이어 정보를 공개하지 않는다',async()=>{m.errors.add('system_settings');await expect(encounterContext('steam','Subject')).rejects.toMatchObject({status:503});});
 it('플랫폼이 다르면 같은 닉네임의 계정을 재사용하지 않는다',async()=>{await expect(encounterContext('kakao','Subject')).rejects.toMatchObject({status:404});});
 it('저장된 빈 상대 결과는 원본을 재다운로드하지 않는다',async()=>{
  const c=await encounterContext('steam','Subject');m.tables.pubg_encounter_cache=[{platform:'steam',subject_account_id:'account.subject',match_id:'m',extractor_version:2,result:{source,encounters:[]}}];
  expect(await collectEncounter(c,'m')).toMatchObject({encounters:[]});expect(m.load).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
 });
 it('원본 조회가 실패하면 전체 수집 슬롯을 즉시 반납한다',async()=>{
  const c=await encounterContext('steam','Subject');const failure=new Error('source failed');
  m.rpc.mockImplementation(async(name:string)=>name==='claim_pubg_encounter'?{data:'lease-1',error:null}:{data:true,error:null});m.load.mockRejectedValue(failure);
  await expect(collectEncounter(c,'m')).rejects.toBe(failure);
  expect(m.rpc).toHaveBeenCalledWith('fail_pubg_encounter',{p_token:'lease-1'});
 });
 it('캐시 내부 identity가 다르면 거부한다',async()=>{
  const c=await encounterContext('steam','Subject');m.tables.pubg_encounter_cache=[{platform:'steam',subject_account_id:'account.subject',match_id:'m',extractor_version:2,result:{source:{...source,verifiedSubjectAccountId:'account.other'},encounters:[]}}];
  await expect(readEncounter(c,'m')).rejects.toMatchObject({status:503});
 });
 it('별칭을 바꿔 비공개된 상대도 현재 계정 ID로 숨긴다',async()=>{
  m.tables.system_settings=[{key:'private_players_list',value:JSON.stringify([{platform:'steam',nickname:'Hidden'}])}];
  m.tables.pubg_player_cache.push({id:'account.target',platform:'steam',lower_nickname:'hidden'});
  const c=await encounterContext('steam','Subject');m.tables.pubg_encounter_cache=[{platform:'steam',subject_account_id:'account.subject',match_id:'m',extractor_version:2,result:{source,encounters:[{targetAccountId:'account.target',nicknameAtMatch:'OldName'}]}}];
  expect(await readEncounter(c,'m')).toMatchObject({encounters:[]});
 });
 it('현재 닉네임을 모르는 비공개 상대도 저장된 계정 ID로 숨긴다',async()=>{
  m.tables.system_settings=[{key:'private_players_list',value:JSON.stringify([{platform:'steam',nickname:'Former',account_id:'account.target'}])}];
  const c=await encounterContext('steam','Subject');m.tables.pubg_encounter_cache=[{platform:'steam',subject_account_id:'account.subject',match_id:'m',extractor_version:2,result:{source,encounters:[{targetAccountId:'account.target',nicknameAtMatch:'Current'}]}}];
  expect(await readEncounter(c,'m')).toMatchObject({encounters:[]});
 });
 it('비공개 subject도 닉네임 변경 후 계정 ID로 차단한다',async()=>{
  m.tables.system_settings=[{key:'private_players_list',value:JSON.stringify([{platform:'steam',nickname:'Former',account_id:'account.subject'}])}];
  await expect(encounterContext('steam','Subject')).rejects.toMatchObject({status:403});
 });
 it('일반전 평딜과 경쟁전 티어를 정확한 모드 캐시에서 읽으며 외부 요청하지 않는다',async()=>{
  const now=new Date().toISOString();m.tables.pubg_encounter_seasons=[{platform:'steam',season_id:'season-1',checked_at:now}];
  m.tables.pubg_encounter_profiles=[{platform:'steam',account_id:'account.target',season_id:'season-1',match_type:'official',checked_at:now,stats:{squad:{roundsPlayed:10,damageDealt:1000}}},{platform:'steam',account_id:'account.target',season_id:'season-1',match_type:'competitive',checked_at:now,stats:{squad:{roundsPlayed:20,damageDealt:6000,currentTier:{tier:'Gold',subTier:'I'}}}}];
  const fetch=vi.spyOn(globalThis,'fetch');const c=await encounterContext('steam','Subject');
  expect(await encounterProfile(c,'account.target',{game_mode:'squad',match_type:'official'},false)).toMatchObject({averageDamage:100,rounds:10,tier:'골드 I',pending:false});expect(fetch).not.toHaveBeenCalled();
 });
 it('예산 부족 시 기존 통계는 유지하고 다음 시도 시각만 갱신한다',async()=>{
  m.tables.pubg_encounter_seasons=[{platform:'steam',season_id:'season-1',checked_at:new Date().toISOString()}];
  const row={platform:'steam',account_id:'account.target',season_id:'season-1',match_type:'competitive',checked_at:'2020-01-01T00:00:00Z',stats:{squad:{roundsPlayed:10,damageDealt:2000}}};m.tables.pubg_encounter_profiles=[row];m.rpc.mockResolvedValue({data:false,error:null});
  const c=await encounterContext('steam','Subject');const result=await encounterProfile(c,'account.target',{game_mode:'squad',match_type:'competitive'},true);
  expect(result.averageDamage).toBe(200);expect(m.writes[0].row).toMatchObject({stats:row.stats,checked_at:row.checked_at});
 });
});
