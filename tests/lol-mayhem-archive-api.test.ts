import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({guard:vi.fn(),get:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/lol/publicAccess.server',()=>({guardLolPublicRequest:mock.guard}));
vi.mock('@/lib/lol/mayhemArchive.server',()=>({getPublicMayhemArchive:mock.get}));
import {GET} from '../app/api/lol/mayhem/archive/route';
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('LOL_MAYHEM_DATASET_ENABLED','true');mock.guard.mockResolvedValue(null);mock.get.mockResolvedValue({archive:{schemaVersion:1,patch:'16.21',augments:[],combos:[]},publishedAt:'now'});});
const get=(query='patch=16.21')=>GET(new Request('https://bgms.kr/api/lol/mayhem/archive?'+query));
describe('공개 보존 자료 API',()=>{
  it('꺼진 기능과 게시되지 않은 후보는 노출하지 않는다',async()=>{vi.stubEnv('LOL_MAYHEM_DATASET_ENABLED','false');expect((await get()).status).toBe(404);expect(mock.get).not.toHaveBeenCalled();vi.stubEnv('LOL_MAYHEM_DATASET_ENABLED','true');mock.get.mockResolvedValue(null);expect((await get()).status).toBe(404);});
  it('기존 공개 요청 제한을 적용한다',async()=>{mock.guard.mockResolvedValue(new Response('',{status:429}));expect((await get()).status).toBe(429);expect(mock.get).not.toHaveBeenCalled();});
  it.each(['patch=16.21&status=bad','patch=16.21&kind=bad','patch=16.21&offset=-1','patch=16.21&offset=10000','patch=16.21&championId=100001','patch=16.21&patch=16.22','patch=16.21&secret=x','patch=16.21&q=%00','patch=16.21&q='+ 'x'.repeat(101)])('잘못된 입력을 거부한다: %s',async query=>{expect((await get(query)).status).toBe(400);expect(mock.get).not.toHaveBeenCalled();});
  it('모든 상태 필터에 페이지와 안전한 헤더를 제공한다',async()=>{for(const status of ['active','disabled','removed','unverified','all']){const r=await get('patch=16.21&kind=augments&status='+status);expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(await r.json()).toMatchObject({kind:'augments',rows:[],pageSize:50});}});
  it('DB와 원본 오류의 내부 정보를 숨긴다',async()=>{mock.get.mockRejectedValue(new Error('private object path'));const r=await get();expect(r.status).toBe(503);expect(await r.text()).not.toContain('private object');});
});
