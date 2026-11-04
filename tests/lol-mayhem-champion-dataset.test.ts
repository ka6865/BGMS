import { describe, expect, it } from 'vitest';
import { normalizeChampionAugments, validateChampionStatsFile, type ChampionStatsContext } from '../lib/lol/mayhemChampionDataset';
const context: ChampionStatsContext = { clientPatch: '16.21', championId: 29, allowedAugmentIds: new Set([3081,1134]), upstreamVersion: '16.21.5', sourceDataDate: '2026-10-30', fetchedAt: '2026-11-04T10:00:00Z', catalogHash: 'a'.repeat(64) };
const raw = (row: Record<string,unknown> = {}) => [['29', JSON.stringify({source:'tencent',region:'CN',augments:{'3081':{pick_rate:'0.0697',num_games:null,win_rate:'0.8',rank:'1',...row}}}), '16.21','2026-10-30']];
describe('챔피언별 선택 통계 신뢰 경계',()=>{
 it('원문 비율·null을 보존하고 승률·순위·임의 분모를 제거한다',()=>{
  const file=normalizeChampionAugments(raw(),context);
  expect(file.rows[0]).toMatchObject({reportedPickRate:'0.0697',reportedSampleCount:null,rateSource:'tencent',rateRegion:'CN',denominatorCount:null,selectionEvidence:'reported_rate',offerEligibility:'unknown'});
  expect(JSON.stringify(file)).not.toMatch(/win_rate|winRate|rank|tier/);
 });
 it('CN 선택률에 WORLD 업로드 표본을 같은 표본으로 붙이지 않는다',()=>{
  const file=normalizeChampionAugments(raw({num_games:'617',win_rate_source:'aramgg-client-upload',win_rate_region:'WORLD',win_rate_game_patch:'16.21',win_rate_date:'2026-10-31'}),context);
  expect(file.rows[0]).toMatchObject({reportedPickRate:'0.0697',reportedSampleCount:null,rateSource:'tencent',rateRegion:'CN',countSource:null,countRegion:null,countMeaning:null,selectionEvidence:'reported_rate'});
 });
 it('같은 출처·지역·패치·날짜인 표본만 유지한다',()=>{
  expect(normalizeChampionAugments(raw({num_games:'617',win_rate_source:'tencent',win_rate_region:'CN',win_rate_game_patch:'16.21',win_rate_date:'2026-10-30'}),context).rows[0]).toMatchObject({reportedSampleCount:617,countSource:'tencent',countRegion:'CN'});
 });
 it.each([{win_rate_source:'unknown'},{win_rate_region:null},{win_rate_game_patch:'16.20'},{win_rate_date:'2026-10-31'}])('표본 범위가 다르거나 명시적으로 미확인이면 공개 표본을 비운다',override=>{
  expect(normalizeChampionAugments(raw({num_games:'617',...override}),context).rows[0].reportedSampleCount).toBeNull();
 });
 it.each(['1.01','-0.1','NaN','Infinity',' 0.5',''])('잘못된 비율 %s 거부',rate=>expect(()=>normalizeChampionAugments(raw({pick_rate:rate}),context)).toThrow('invalid_pick_rate'));
 it('선택률 null과 0은 별개이며 둘 다 제시 불가로 바뀌지 않는다',()=>{
  expect(normalizeChampionAugments(raw({pick_rate:null}),context).rows[0]).toMatchObject({reportedPickRate:null,selectionEvidence:null,offerEligibility:'unknown'});
  expect(normalizeChampionAugments(raw({pick_rate:'0',num_games:'0'}),context).rows[0]).toMatchObject({reportedPickRate:'0',reportedSampleCount:0,selectionEvidence:null,offerEligibility:'unknown'});
 });
 it('같은 패치 카탈로그에 없는 숫자 ID는 거부한다',()=>expect(()=>normalizeChampionAugments(raw(),{...context,allowedAugmentIds:new Set([1134])})).toThrow('unknown_augment'));
 it.each([[],[['99','{}','16.21','2026-10-30']],[['29','{','16.21','2026-10-30']],[['29','{}','16.20','2026-10-30']],[['29','{}','16.21','2026-10-29']]].map(input=>({input})))('잘못된 tuple·JSON·버전·날짜 거부',({input})=>expect(()=>normalizeChampionAugments(input,context)).toThrow());
 it('허용되지 않은 source와 음수·분수 count 거부',()=>{
  expect(()=>normalizeChampionAugments(raw({num_games:'-1'}),context)).toThrow();
  expect(()=>normalizeChampionAugments(raw({num_games:'1.5'}),context)).toThrow();
  const v=raw();v[0][1]=JSON.stringify({source:'invented',augments:{}});expect(()=>normalizeChampionAugments(v,context)).toThrow();
 });
 it('저장된 정규화본도 allowlist로 재구성하고 중복·다른 모집단을 거부한다',()=>{
  const file=normalizeChampionAugments(raw(),context);
  expect(validateChampionStatsFile({...file,winRate:1})).toEqual(file);
  expect(()=>validateChampionStatsFile({...file,rows:[file.rows[0],file.rows[0]]})).toThrow();
  expect(()=>validateChampionStatsFile({...file,cohort:'KR'})).toThrow();
  expect(()=>validateChampionStatsFile({...file,rows:[{...file.rows[0],countRegion:'WORLD',reportedSampleCount:255,countSource:'aramgg-client-upload'}]})).toThrow();
 });
});
