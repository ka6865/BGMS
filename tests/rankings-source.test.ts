import { ANALYSIS_CALCULATION_VERSION } from '../lib/pubg-analysis/constants';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const m=vi.hoisted(()=>({rpc:vi.fn(),abort:vi.fn()}));
vi.mock('next/cache',()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({rpc:(...args:unknown[])=>({abortSignal:(signal:AbortSignal)=>{m.abort(signal);return m.rpc(...args);}})})}));
import {getWeeklyTopDamage,getTopTierRanking} from '@/actions/rankings';
const generatedAt='2026-10-10T04:00:00Z';
beforeEach(()=>{vi.clearAllMocks();m.rpc.mockResolvedValue({data:{entries:[],generated_at:generatedAt,cache_hit:true,database_ms:2},error:null});});
describe('랭킹 데이터 원장',()=>{
 it('SQL의 플랫폼과 실제 경기 시각을 보존한다',async()=>{
  m.rpc.mockResolvedValue({error:null,data:{entries:[{platform:'kakao',player_id:'same',value:1234,secondary:8,tier:null,game_mode:'squad-fpp',map_name:'Kiki_Main',played_at:'2026-09-12T00:00:00Z',match_count:600}],generated_at:generatedAt,cache_hit:true,database_ms:2}});
  expect(await getWeeklyTopDamage('squad','fpp','official')).toMatchObject({hasError:false,generatedAt,cacheStatus:'hit',data:[{platform:'kakao',nickname:'same',created_at:'2026-09-12T00:00:00Z',match_count:600,map_name:'데스턴'}]});
  expect(m.rpc).toHaveBeenCalledWith('get_pubg_rankings_cached',expect.objectContaining({p_tab:'damage',p_modes:['squad-fpp'],p_match_type:'official'}));
 });
 it('비공개 명단 오류를 빈 명단처럼 처리하지 않는다',async()=>{
  m.rpc.mockResolvedValue({data:null,error:{message:'Invalid ranking privacy settings'}});expect(await getTopTierRanking()).toEqual({data:[],hasError:true});
 });
 it('계산 버전을 전달하되 비공개 판단은 DB의 현재 설정으로 수행한다',async()=>{
  await getTopTierRanking();
  expect(m.rpc).toHaveBeenCalledWith('get_pubg_rankings_cached',expect.objectContaining({p_tab:'tier',p_calculation:ANALYSIS_CALCULATION_VERSION,p_result:73}));
  expect(m.rpc.mock.calls[0][1]).not.toHaveProperty('p_excluded');
  expect(m.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
 });
 it('시각이 잘못된 캐시 응답을 공개하지 않는다',async()=>{
  m.rpc.mockResolvedValue({data:{entries:[],generated_at:'invalid'},error:null});
  expect(await getWeeklyTopDamage()).toEqual({data:[],hasError:true});
 });
 it('랭킹 페이지가 조회를 기다리지 않고 비공개 반영은 캐시 없는 API로 확인한다',()=>{
  const source=readFileSync(resolve(process.cwd(),'app/rankings/page.tsx'),'utf8');
  const client=readFileSync(resolve(process.cwd(),'app/rankings/RankingsClient.tsx'),'utf8');
  const api=readFileSync(resolve(process.cwd(),'app/api/rankings/route.ts'),'utf8');
  expect(source).toContain("dynamic = 'force-dynamic'");
  expect(source).not.toContain('unstable_cache');
  expect(source).not.toContain('getWeeklyTopDamage');
  expect(client).toContain("cache: 'no-store'");
  expect(api).toContain('private, no-store');
 });
 it('legacy 랭킹 행도 현재 캐시의 안정 계정 ID와 연결해 비공개 처리한다',()=>{
  const migration=readFileSync(resolve(process.cwd(),'supabase/migrations/20260921110000_support_privacy_ranking_identity.sql'),'utf8');
  expect(migration).toContain('public.pubg_player_cache cache');
  expect(migration).toContain("cache.lower_nickname=lower(m.player_id)");
  expect(migration).toContain("m.platform||':account:'||cache.id");
 });
 });
