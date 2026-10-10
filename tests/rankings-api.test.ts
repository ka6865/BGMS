import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m=vi.hoisted(()=>({damage:vi.fn(),kills:vi.fn(),tier:vi.fn()}));
vi.mock('@/actions/rankings',()=>({getWeeklyTopDamage:m.damage,getWeeklyTopKills:m.kills,getTopTierRanking:m.tier}));
import { GET } from '@/app/api/rankings/route';

beforeEach(()=>{
 vi.clearAllMocks();
 for (const mock of Object.values(m)) mock.mockResolvedValue({hasError:false,data:[],generatedAt:'2026-10-10T04:00:00Z',cacheStatus:'hit',databaseMs:12,aggregationMs:0});
});
describe('랭킹 API 캐시 경계',()=>{
 it('집계 시각과 내부 캐시 상태를 전달하면서 HTTP 응답은 저장하지 않는다',async()=>{
  m.kills.mockResolvedValue({hasError:false,data:[{rank:1,nickname:'Visible',player_id:'visible',platform:'steam',account_id:'account.internal',value:5,game_mode:'솔로',map_name:'에란겔'}],generatedAt:'2026-10-10T04:00:00Z',cacheStatus:'hit',databaseMs:12,aggregationMs:0});
  const response=await GET(new NextRequest('http://localhost/api/rankings?tab=kills&mode=solo&perspective=fpp&matchType=official'));
  expect(m.kills).toHaveBeenCalledExactlyOnceWith('solo','fpp','official');
  expect(m.damage).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-ranking-cache')).toBe('hit');
  expect(response.headers.get('server-timing')).toContain('db;dur=12, aggregate;dur=0');
  const body=await response.json();
  expect(body.generatedAt).toBe('2026-10-10T04:00:00Z');
  expect(body.entries[0]).toMatchObject({playerId:'visible',value:5});
  expect(JSON.stringify(body)).not.toContain('account.internal');
 });
 it('실패한 비공개 검증 결과는 캐시나 빈 정상 목록으로 반환하지 않는다',async()=>{
  m.tier.mockResolvedValue({hasError:true,data:[]});
  const response=await GET(new NextRequest('http://localhost/api/rankings?tab=tier'));
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).not.toHaveProperty('entries');
 });
 it('잘못된 필터는 기존 기본값으로 정규화한다',async()=>{
  await GET(new NextRequest('http://localhost/api/rankings?tab=bad&mode=bad&perspective=bad&matchType=bad'));
  expect(m.damage).toHaveBeenCalledExactlyOnceWith('all','all','all');
 });
});
