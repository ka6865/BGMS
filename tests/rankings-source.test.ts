import {beforeEach,describe,it,expect,vi} from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const m=vi.hoisted(()=>({rpc:vi.fn(),privacy:vi.fn()}));
vi.mock('next/cache',()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({rpc:m.rpc,from:()=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:m.privacy};return q;}})}));
import {getWeeklyTopDamage,getTopTierRanking} from '@/actions/rankings';
beforeEach(()=>{vi.clearAllMocks();m.privacy.mockResolvedValue({data:null,error:null});m.rpc.mockResolvedValue({data:[],error:null});});
describe('랭킹 데이터 원장',()=>{
 it('SQL의 플랫폼과 실제 경기 시각을 보존한다',async()=>{
  m.rpc.mockResolvedValue({error:null,data:[{platform:'kakao',player_id:'same',value:1234,secondary:8,tier:null,game_mode:'squad-fpp',map_name:'Kiki_Main',played_at:'2026-09-12T00:00:00Z',match_count:600}]});
  expect(await getWeeklyTopDamage('squad','fpp','official')).toMatchObject({hasError:false,data:[{platform:'kakao',nickname:'same',created_at:'2026-09-12T00:00:00Z',match_count:600,map_name:'데스턴'}]});
  expect(m.rpc).toHaveBeenCalledWith('get_pubg_rankings',expect.objectContaining({p_tab:'damage',p_modes:['squad-fpp'],p_match_type:'official'}));
 });
 it('비공개 명단 오류를 빈 명단처럼 처리하지 않는다',async()=>{
  m.privacy.mockResolvedValue({data:null,error:{code:'down'}});expect(await getTopTierRanking()).toEqual({data:[],hasError:true});expect(m.rpc).not.toHaveBeenCalled();
 });
 it('비공개 대상과 계산 버전을 집계에 전달한다',async()=>{
  m.privacy.mockResolvedValue({data:{value:JSON.stringify([{platform:'steam',nickname:'Hidden'}])},error:null});await getTopTierRanking();
  expect(m.rpc).toHaveBeenCalledWith('get_pubg_rankings',expect.objectContaining({p_tab:'tier',p_excluded:['steam:hidden'],p_calculation:2,p_result:73}));
 });
 it('프라이버시 등록 직후 랭킹 SSR이 오래된 페이지 캐시에 머물지 않는다',()=>{
  const source=readFileSync(resolve(process.cwd(),'app/rankings/page.tsx'),'utf8');
  expect(source).toContain("dynamic = 'force-dynamic'");
  expect(source).not.toContain('unstable_cache');
  expect(source).toContain("getWeeklyTopDamage('all')");
 });
 it('legacy 랭킹 행도 현재 캐시의 안정 계정 ID와 연결해 비공개 처리한다',()=>{
  const migration=readFileSync(resolve(process.cwd(),'supabase/migrations/20260921110000_support_privacy_ranking_identity.sql'),'utf8');
  expect(migration).toContain('public.pubg_player_cache cache');
  expect(migration).toContain("cache.lower_nickname=lower(m.player_id)");
  expect(migration).toContain("m.platform||':account:'||cache.id");
 });
 });
