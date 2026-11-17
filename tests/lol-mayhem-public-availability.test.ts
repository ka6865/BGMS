import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({publicationPatch:'16.22'}));
vi.mock('server-only',()=>({}));
vi.mock('next/cache',()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock('@/lib/server/serviceRoleSupabase.server',()=>({createServiceRoleSupabase:()=>({from:(table:string)=>{
 const rows=table==='lol_mayhem_dataset_publications'?[{client_patch:mocks.publicationPatch,release_id:1,published_at:'now'}]
  :table==='lol_mayhem_augment_pick_rates'?[{platform_id:2104,pick_rate:'0.1',pick_rate_rank:1},{platform_id:1,pick_rate:'0.2',pick_rate_rank:2}]
  :table==='lol_mayhem_combos'?[{external_combo_id:1,champion_id:16,editorial_tags:[],source_url:'https://arammayhem.com/combos/1/'},{external_combo_id:2,champion_id:16,editorial_tags:[],source_url:'https://arammayhem.com/combos/2/'}]
  :table==='lol_mayhem_combo_augments'?[{external_combo_id:1,platform_id:2104,position:1},{external_combo_id:1,platform_id:1,position:2},{external_combo_id:2,platform_id:1,position:1}]:[];
 const query={select:()=>query,eq:()=>query,order:()=>query,limit:()=>query,range:()=>query,abortSignal:()=>query,single:async()=>({data:{metadata:{normalizerVersion:2,archiveHash:'a'.repeat(64)}},error:null}),then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:rows,error:null}).then(resolve)};
 return query;
}})}));
import {getPublicMayhemDataset} from '@/lib/lol/mayhemDatasetStore.server';
beforeEach(()=>{vi.stubEnv('LOL_PERSISTENCE_ENABLED','true');mocks.publicationPatch='16.22';});
it('기존 게시본의 선택률과 포함 조합도 현재 추천에서 제외한다',async()=>{
 const data=await getPublicMayhemDataset('16.22');
 expect(data?.rates.map(r=>r.augmentId)).toEqual([1]);expect(data?.combos.map(r=>r.id)).toEqual([2]);
});
it('현재 패치가 과거 게시본으로 대체돼도 현재 등장 정책을 따른다',async()=>{
 mocks.publicationPatch='16.21';
 expect((await getPublicMayhemDataset('16.22'))?.combos.map(r=>r.id)).toEqual([2]);
 expect((await getPublicMayhemDataset('16.21'))?.combos.map(r=>r.id)).toEqual([1,2]);
});
