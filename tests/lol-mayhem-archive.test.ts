import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { availabilityCounts, archivePage, comboAvailability, parseMayhemArchive, type MayhemArchive } from '../lib/lol/mayhemArchive';
import { prepareReviewedMayhemDataset, type MayhemOfficialAugment, type ReviewedMapping } from '../lib/lol/mayhemReviewedDataset';
import type { MayhemDataset } from '../lib/lol/mayhemDataset';
const official = (id: number, name: string, enabled = true): MayhemOfficialAugment => ({ id, name, nameEn: name, rarity: 'gold', text: '효과', enabled, inPool: true, internal: false, state: enabled ? 'official_active' : 'official_disabled', icon: null, notice: null, isNew: false });
const file = (rows: unknown[]) => ({ url: '', body: JSON.stringify({ schemaVersion: 1, licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', meta: { releaseId: 'source:1' }, rows }), hash: '', etag: null, lastModified: null });
function prepare() {
  const names = ['Normal', 'Unknown'];
  const dataset: MayhemDataset = { batchHash: '', releaseId: 'source:1', raw: { index: file([]), augments: file(names.map(name=>({ augmentId: name.toLowerCase(),name:{en:name,'ko-KR':name},rarity:'gold' }))), combos: file([{augmentIds:['normal','unknown'],augmentNames:names.map(name=>({en:name,'ko-KR':name}))}]) },rates:names.map(name=>({externalId:name.toLowerCase(),pickRate:1,pickRateRank:1,sourcePatch:'26.21'})),combos:[{comboId:1,championId:'Brand',augmentIds:['normal','unknown'],types:[],sourceUrl:'https://arammayhem.com/combo/one/'}], metadata:{sourcePatch:'26.21',sourceStatsDate:null,statsDateSource:null,license:'CC BY 4.0',attribution:'Data: arammayhem.com'} };
  return {dataset,patch:'16.21',sourcePatch:'16.21',combos:dataset.combos.map(c=>({...c,championId:63})),officials:{'16.21':[official(1,'Normal'),official(2,'Disabled',false)]},mappings:[{external_id:'normal',platform_id:1,client_patch:'16.21',status:'approved'}]};
}
describe('검토된 증강과 보존 상태',()=>{
  it('미연결을 삭제로 추측하지 않고 조합 전체를 현재 추천에서 제외한다',()=>{const r=prepareReviewedMayhemDataset(prepare());expect(r.rates.map(a=>a.externalId)).toEqual(['normal']);expect(r.combos).toHaveLength(0);expect(r.summary.augments).toEqual({active:1,disabled:1,removed:0,unverified:1});expect(r.archive.combos[0].augments).toHaveLength(2);expect(r.archive.combos[0].status).toBe('unverified');});
  it('공식 비활성을 승인된 연결이 있어도 현재 추천에 포함하지 않는다',()=>{const p=prepare();p.officials['16.21'][0]=official(1,'Normal',false);const r=prepareReviewedMayhemDataset(p);expect(r.rates).toHaveLength(0);expect(r.archive.augments.find(a=>a.officialId===1)?.status).toBe('disabled');});
  it('내부 증강은 보존 공개에서도 제외한다',()=>{const p=prepare();p.officials['16.21'][1].internal=true;expect(prepareReviewedMayhemDataset(p).archive.augments.some(a=>a.officialId===2)).toBe(false);});
  it('삭제·비활성·미확인 순서로 전체 조합의 상태를 정한다',()=>{expect(comboAvailability(['active','disabled'])).toBe('disabled');expect(comboAvailability(['disabled','removed'])).toBe('removed');expect(comboAvailability(['active','unverified'])).toBe('unverified');});
  it('손상된 참조·상태·중복·외부 URL은 거부한다',()=>{const a=prepareReviewedMayhemDataset(prepare()).archive;for(const mutate of [(x:MayhemArchive)=>x.augments.push(x.augments[0]),(x:MayhemArchive)=>x.combos[0].augments.push('external:missing'),(x:MayhemArchive)=>x.combos[0].status='active',(x:MayhemArchive)=>x.combos[0].sourceUrl='https://evil.test/']) {const copy=structuredClone(a);mutate(copy);expect(()=>parseMayhemArchive(copy,'16.21')).toThrow('invalid_mayhem_archive');}});
  it('원본 평가로 조합을 거르고 평가별 개수는 거르기 전 기준으로 센다',()=>{const base:MayhemArchive={schemaVersion:1,patch:'16.22',augments:[{key:'official:1',officialId:1,externalIds:[],name:'A',nameEn:null,sourceName:null,rarity:'gold',status:'active',removedPatch:null,reason:'',text:'',sourceUrl:null}],combos:[1,2,3].map(id=>({id,championId:63,augments:['official:1'],status:'active' as const,types:id===3?['trap']:['god','strong'],sourceUrl:'https://arammayhem.com/combo/x/'}))};const page=archivePage(base,{kind:'combos',status:'active',query:'',championId:null,offset:0,type:'trap'},'now');expect(page.total).toBe(1);expect(page.kind==='combos'&&page.typeCounts).toEqual({god:2,strong:2,trap:1});});
  it('상태·챔피언·이름 필터와 페이지 범위를 함께 적용한다',()=>{const a=prepareReviewedMayhemDataset(prepare()).archive;const page=archivePage(a,{kind:'augments',status:'disabled',query:'Disabled',championId:null,offset:0},'now');expect(page.total).toBe(1);expect(page.counts.disabled).toBe(1);expect(archivePage(a,{kind:'combos',status:'all',query:'',championId:1,offset:0},'now').total).toBe(0);expect(archivePage(a,{kind:'augments',status:'all',query:'',championId:null,offset:50},'now').rows).toEqual([]);expect(availabilityCounts(a.augments).active).toBe(1);});
});

import review from '../lib/lol/data/mayhem-augment-review-16.21.json';
describe('실제 이름·등급 예외와 삭제 근거',()=>{
  function fromReview(id: string) {
    const r=review.reviews.find(r=>r.externalId===id)!;
    const p=prepare(); const name={'ko-KR':r.sourceName,en:r.sourceNameEn};
    p.dataset.raw.augments=file([{augmentId:id,name,...(r.sourceRarity?{rarity:r.sourceRarity}:{})}]);
    p.dataset.raw.combos=file([{augmentIds:[id],augmentNames:[name]}]);
    p.dataset.rates=[{externalId:id,pickRate:1,pickRateRank:1,sourcePatch:'26.21'}];
    p.combos=[{comboId:1,championId:63,augmentIds:[id],types:[],sourceUrl:'https://arammayhem.com/combo/test/'}];
    p.officials['16.21']=[{...official(r.officialId??1361,r.officialName??'이케시아의 몰락',r.status!=='disabled'),nameEn:r.officialNameEn??"Icathia’s Fall",rarity:(r.officialRarity??'gold') as MayhemOfficialAugment['rarity']}];
    p.mappings=r.officialId?[{external_id:id,platform_id:r.officialId,client_patch:'16.21',status:'approved'}]:[];
    return p;
  }
  it.each(['double_defense','terror','pursuit_of_power','quest_steel_your_heart','quest_wooglets_witchcap','quest_urfs_champion'])('설명으로 검토하고 저장한 연결을 쓴다: %s',id=>{const r=prepareReviewedMayhemDataset(fromReview(id));expect(r.rates).toHaveLength(1);expect(r.combos).toHaveLength(1);expect(r.summary.augments.active).toBe(1);});
  it('예전 삭제 명칭을 같은 한국어 이름의 현행 증강으로 오인하지 않는다',()=>{const p=fromReview('void_immolation');p.mappings=[{external_id:'void_immolation',platform_id:1361,client_patch:'16.21',status:'approved'}];const r=prepareReviewedMayhemDataset(p);expect(r.rates).toHaveLength(0);expect(r.archive.augments.find(a=>a.key==='external:void_immolation')).toMatchObject({status:'removed',removedPatch:'26.18',officialId:null});expect(r.archive.augments.find(a=>a.officialId===1361)?.status).toBe('active');});
  it('공식 비활성은 보존하며 현재 조합에서 제외한다',()=>{const p=fromReview('vampirism');p.mappings=[];const r=prepareReviewedMayhemDataset(p);expect(r.summary.augments.disabled).toBe(1);expect(r.summary.combos.disabled).toBe(1);expect(r.rates).toHaveLength(0);});
  it('기존 삭제 메타데이터만으로 현행 공식 증강을 삭제 처리하지 않는다',()=>{const p=fromReview('clown_college');const raw=JSON.parse(p.dataset.raw.augments.body);raw.rows[0].retiredPatch='26.17';p.dataset.raw.augments.body=JSON.stringify(raw);expect(prepareReviewedMayhemDataset(p).summary.augments.active).toBe(1);});
  it('공식 영문명이나 등급이 바뀌면 검토 예외를 자동 재사용하지 않는다',()=>{const p=fromReview('double_defense');p.officials['16.21'][0].nameEn='Changed';expect(prepareReviewedMayhemDataset(p).archive.combos[0].status).toBe('unverified');});
  function nextPatch(id: string) {
    const p=fromReview(id);
    const officials:Record<string,MayhemOfficialAugment[]>={...p.officials,'16.22':p.officials['16.21'].map(a=>({...a}))};
    const mappings:ReviewedMapping[]=p.mappings.length?p.mappings:[{external_id:id,platform_id:1361,client_patch:'16.21',status:'approved'}];
    return {...p,patch:'16.22',sourcePatch:'16.22',officials,mappings};
  }
  it('같은 ID·이름·등급이면 설명으로 검수한 연결도 새 패치에서 쓰고 저장 대상으로 돌려준다',()=>{const r=prepareReviewedMayhemDataset(nextPatch('double_defense'));expect(r.rates).toHaveLength(1);expect(r.combos).toHaveLength(1);expect(r.carried).toEqual([expect.objectContaining({client_patch:'16.22',from:expect.objectContaining({client_patch:'16.21'})})]);expect(r.archive.augments.find(a=>a.officialId===2144)?.reason).toContain('16.21');});
  it('새 패치에서 이름이나 등급이 바뀌면 이어받지 않는다',()=>{for(const change of [{nameEn:'Changed'},{name:'바뀜'},{rarity:'prismatic' as const}]){const p=nextPatch('double_defense');Object.assign(p.officials['16.22'][0],change);const r=prepareReviewedMayhemDataset(p);expect(r.rates).toHaveLength(0);expect(r.carried).toEqual([]);}});
  it('원래 패치의 삭제 판정은 이어받아도 현행 증강으로 바꾸지 않는다',()=>{const r=prepareReviewedMayhemDataset(nextPatch('void_immolation'));expect(r.rates).toHaveLength(0);expect(r.carried).toEqual([]);expect(r.archive.augments.find(a=>a.key==='external:void_immolation')?.status).toBe('removed');});
  it('저장된 이어받은 연결은 원래 패치 기준으로 다시 판정하고 다시 저장하지 않는다',()=>{const p=nextPatch('double_defense');p.mappings.push({external_id:'double_defense',platform_id:2144,client_patch:'16.22',status:'approved',evidence:{note:'이어받음',carriedFrom:'16.21'}});const r=prepareReviewedMayhemDataset(p);expect(r.rates).toHaveLength(1);expect(r.carried).toEqual([]);});
  it('검수한 삭제·비활성 판정은 다음 패치에서도 유지하고 공식 이름이 바뀐 비활성은 확인 중으로 둔다',()=>{
    const removed=prepareReviewedMayhemDataset({...nextPatch('void_immolation'),mappings:[]});
    expect(removed.archive.augments.find(a=>a.key==='external:void_immolation')?.status).toBe('removed');
    const disabled=nextPatch('vampirism');disabled.mappings=[];
    expect(prepareReviewedMayhemDataset(disabled).summary.augments).toMatchObject({disabled:1,unverified:0});
    disabled.officials['16.22'][0].nameEn='Changed';
    expect(prepareReviewedMayhemDataset(disabled).summary.augments.unverified).toBe(1);
  });
  it('비활성으로 검수한 증강이 새 패치 공식 자료에서 빠지면 삭제로 판정한다',()=>{
    const p=nextPatch('vampirism');p.mappings=[];p.officials['16.22']=[official(9999,'Other')];
    const r=prepareReviewedMayhemDataset(p);
    expect(r.archive.augments.find(a=>a.key==='external:vampirism')).toMatchObject({status:'removed',removedPatch:'26.22'});
    expect(r.summary.combos).toMatchObject({removed:1,unverified:0});
  });
  it('새 패치에서 사람이 거절한 연결은 이어받지 않는다',()=>{const p=nextPatch('double_defense');p.mappings.push({external_id:'double_defense',platform_id:2144,client_patch:'16.22',status:'rejected'});const r=prepareReviewedMayhemDataset(p);expect(r.rates).toHaveLength(0);expect(r.carried).toEqual([]);});
});
