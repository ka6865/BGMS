import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { availabilityCounts, archivePage, comboAvailability, parseMayhemArchive, type MayhemArchive } from '../lib/lol/mayhemArchive';
import { prepareReviewedMayhemDataset, type MayhemOfficialAugment } from '../lib/lol/mayhemReviewedDataset';
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
});
