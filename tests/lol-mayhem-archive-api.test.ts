import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({guard:vi.fn(),get:vi.fn(),catalog:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/lol/publicAccess.server',()=>({guardLolPublicRequest:mock.guard}));
vi.mock('@/lib/lol/augments/catalog.server',()=>({getCachedLolAugmentCatalog:mock.catalog}));
vi.mock('@/lib/lol/mayhemArchive.server',()=>({getPublicMayhemArchive:mock.get}));
import {GET} from '../app/api/lol/mayhem/archive/route';
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('LOL_MAYHEM_DATASET_ENABLED','true');mock.guard.mockResolvedValue(null);mock.catalog.mockResolvedValue({artwork:{1:'assets/ux/kiwi/augments/icons/test.png',2:'https://invalid.test/a.png'}});mock.get.mockResolvedValue({archive:{schemaVersion:1,patch:'16.21',augments:[],combos:[]},publishedAt:'now'});});
const get=(query='patch=16.21')=>GET(new Request('https://bgms.kr/api/lol/mayhem/archive?'+query));
describe('공개 보존 자료 API',()=>{
  it('꺼진 기능과 게시되지 않은 후보는 노출하지 않는다',async()=>{vi.stubEnv('LOL_MAYHEM_DATASET_ENABLED','false');expect((await get()).status).toBe(404);expect(mock.get).not.toHaveBeenCalled();vi.stubEnv('LOL_MAYHEM_DATASET_ENABLED','true');mock.get.mockResolvedValue(null);expect((await get()).status).toBe(404);});
  it('기존 공개 요청 제한을 적용한다',async()=>{mock.guard.mockResolvedValue(new Response('',{status:429}));expect((await get()).status).toBe(429);expect(mock.get).not.toHaveBeenCalled();});
  it.each(['patch=16.21&status=bad','patch=16.21&kind=bad','patch=16.21&offset=-1','patch=16.21&offset=10000','patch=16.21&championId=100001','patch=16.21&patch=16.22','patch=16.21&secret=x','patch=16.21&q=%00','patch=16.21&q='+ 'x'.repeat(101)])('잘못된 입력을 거부한다: %s',async query=>{expect((await get(query)).status).toBe(400);expect(mock.get).not.toHaveBeenCalled();});
  it('모든 상태 필터에 페이지와 안전한 헤더를 제공한다',async()=>{for(const status of ['active','disabled','removed','unverified','all']){const r=await get('patch=16.21&kind=augments&status='+status);expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(await r.json()).toMatchObject({kind:'augments',rows:[],pageSize:50});}});
  it('DB와 원본 오류의 내부 정보를 숨긴다',async()=>{mock.get.mockRejectedValue(new Error('private object path'));const r=await get();expect(r.status).toBe(503);expect(await r.text()).not.toContain('private object');});
});

it('비활성 공식 아이콘과 삭제 원본 이미지를 붙이며 잘못된 경로는 쓰지 않는다',async()=>{
 const a=(key:string,officialId:number|null,status:string)=>({key,officialId,status,externalIds:[],name:key,nameEn:null,sourceName:null,rarity:'gold',removedPatch:null,reason:'기록',text:'',sourceUrl:null});
 mock.get.mockResolvedValue({archive:{schemaVersion:1,patch:'16.21',augments:[a('official:1',1,'disabled'),a('official:2',2,'active'),a('external:rabble_rousing',null,'removed')],combos:[]},publishedAt:'now'});
 const r=await get('patch=16.21&kind=augments&status=all');const b=await r.json();expect(b.rows[0].iconUrl).toBe('/api/lol/augment-icons/16.21/assets/ux/kiwi/augments/icons/test.png');expect(b.rows[1].iconUrl).toBeNull();expect(b.rows[2].iconUrl).toMatch(/^\/lol\/augment-art\/[a-f0-9]{64}\.webp$/);
});
it('외부 ID가 같아도 검토하지 않은 패치에 삭제 이미지를 재사용하지 않는다',async()=>{
 mock.get.mockResolvedValue({archive:{schemaVersion:1,patch:'16.22',augments:[{key:'external:rabble_rousing',officialId:null,status:'unverified',externalIds:[],name:'새 원본',nameEn:null,sourceName:null,rarity:null,removedPatch:null,reason:'확인 중',text:'',sourceUrl:null}],combos:[]},publishedAt:'now'});
 const r=await get('patch=16.22&kind=augments&status=all');expect((await r.json()).rows[0].iconUrl).toBeNull();
});
