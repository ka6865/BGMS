import {beforeEach,expect,it,vi}from'vitest';
const mock=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('server-only',()=>({}));vi.mock('next/cache',()=>({unstable_cache:(f:unknown)=>f}));vi.mock('../lib/lol/augments/persistence.server',()=>({getLolAugmentCatalog:mock.get}));
import{getCachedLolAugmentCatalog}from'../lib/lol/augments/catalog.server';
beforeEach(()=>vi.resetAllMocks());
it('현재 도감에서 제외하는 비활성 증강도 이미지 목록에는 포함한다',async()=>{
 const a=(id:number,enabled:boolean,isInternal=false)=>({platformId:id,enabled,isInternal,inPool:true,rarity:'gold',iconLargePath:`assets/ux/kiwi/augments/icons/a${id}.png`,iconSmallPath:null,localizations:{ko_kr:{name:'증강',text:'효과'},en_us:{name:'Augment'}}});
 mock.get.mockResolvedValue({clientPatch:'16.21',displayPatch:'26.21',releasedAt:'now',notesUrlKo:null,augments:[a(1,true),a(2,false),a(3,false,true)],changes:[]});
 const r=await getCachedLolAugmentCatalog('16.21');expect(r?.view.augments.map(a=>a.id)).toEqual([1]);expect(r?.artwork).toEqual({1:'assets/ux/kiwi/augments/icons/a1.png',2:'assets/ux/kiwi/augments/icons/a2.png'});
});
it('게시된 카탈로그가 없으면 빈 이미지 목록을 꾸미지 않는다',async()=>{mock.get.mockResolvedValue(null);expect(await getCachedLolAugmentCatalog('16.21')).toBeNull();});
