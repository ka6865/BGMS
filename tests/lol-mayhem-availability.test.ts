import { describe, expect, it } from 'vitest';
import { getMayhemAvailabilityOverride } from '@/lib/lol/mayhemAvailability';
import { applyMayhemAvailabilityOverrides, archivePage, parseMayhemArchive, type MayhemArchive } from '@/lib/lol/mayhemArchive';
const interrupted=[2032,2034,2043,2080,2083,2091,2104,2107,2115,2127,2134,2137];
const archive = (): MayhemArchive => ({schemaVersion:1,patch:'16.22',augments:[
 {key:'official:2104',officialId:2104,externalIds:['spirit_bomb'],name:'영혼 폭탄',nameEn:'Spirit Bomb',sourceName:null,rarity:'prismatic',status:'active',removedPatch:null,reason:'공식 카탈로그: 사용 중',text:'효과',sourceUrl:null},
 {key:'official:1',officialId:1,externalIds:[],name:'정상',nameEn:'Normal',sourceName:null,rarity:'gold',status:'active',removedPatch:null,reason:'공식 카탈로그: 사용 중',text:'효과',sourceUrl:null},
],combos:[{id:1,championId:16,augments:['official:2104','official:1'],status:'active',types:[],sourceUrl:'https://arammayhem.com/combos/1/'}]});
describe('패치별 등장 중단 검토',()=>{
 it.each(interrupted)('%i는 근거가 있는 16.22에서만 확인 중으로 분류한다',id=>{
  expect(getMayhemAvailabilityOverride('16.22',id)).toMatchObject({status:'unverified',reason:expect.stringContaining('등장 중단 추정')});
  expect(getMayhemAvailabilityOverride('16.21',id)).toBeNull();expect(getMayhemAvailabilityOverride('16.23',id)).toBeNull();
 });
 it('재장전과 관련 없는 증강은 자동 제외하지 않는다',()=>{
  expect(getMayhemAvailabilityOverride('16.22',2126)).toBeNull();expect(getMayhemAvailabilityOverride('16.22',1)).toBeNull();
 });
 it('공개 보관함 복사본에서만 증강·포함 조합 상태를 함께 바꾼다',()=>{
  const original=archive(),body=JSON.stringify(original),result=applyMayhemAvailabilityOverrides(original);
  expect(JSON.stringify(original)).toBe(body);
  expect(result.augments[0]).toMatchObject({status:'unverified',removedPatch:null,reason:expect.stringContaining('등장 중단 추정')});
  expect(result.combos[0].status).toBe('unverified');expect(result.augments[1].status).toBe('active');
  expect(parseMayhemArchive(result,'16.22')).toEqual(result);
  const page=archivePage(result,{kind:'augments',status:'unverified',query:'영혼',championId:null,offset:0},'now');
  expect(page).toMatchObject({total:1,counts:{active:0,unverified:1},rows:[{officialId:2104,status:'unverified'}]});
 });
 it('공식 삭제·비활성은 통계 추정으로 낮추지 않는다',()=>{
  for(const status of ['removed','disabled'] as const){const original=archive();original.augments[0].status=status;original.combos[0].status=status;
   expect(applyMayhemAvailabilityOverrides(original).augments[0]).toEqual(original.augments[0]);}
 });
 it('과거 패치 보관함을 현재 추정으로 덮어쓰지 않는다',()=>{
  const original=archive();original.patch='16.21';expect(applyMayhemAvailabilityOverrides(original)).toEqual(original);
 });
});
