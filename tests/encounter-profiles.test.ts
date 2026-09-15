import {describe,it,expect} from 'vitest';
import {summarizeEncounterProfile} from '@/lib/pubg/encounterProfiles';
const stamp='2026-09-13T00:00:00Z';
describe('상대 시즌 통계',()=>{
 it('일반/경쟁과 FPP/TPP 통계를 섞지 않는다',()=>{
  const normal={checked_at:stamp,stats:{squad:{roundsPlayed:10,damageDealt:2000},'squad-fpp':{roundsPlayed:20,damageDealt:9000}}};
  const ranked={checked_at:stamp,stats:{squad:{roundsPlayed:5,damageDealt:1500,currentTier:{tier:'Diamond',subTier:'III'}}}};
  expect(summarizeEncounterProfile('season-1','squad','official',normal,ranked)).toMatchObject({tier:'다이아몬드 III',averageDamage:200,rounds:10,pending:false});
  expect(summarizeEncounterProfile('season-1','squad','competitive',normal,ranked).averageDamage).toBe(300);
  expect(summarizeEncounterProfile('season-1','squad-fpp','competitive',normal,ranked).averageDamage).toBeNull();
 });
 it('실제 0딜과 경기 없음/미확인을 구분한다',()=>{
  const make=(stats:any)=>({stats:{squad:stats},checked_at:stamp});
  expect(summarizeEncounterProfile('s','squad','official',make({roundsPlayed:1,damageDealt:0}),null).averageDamage).toBe(0);
  expect(summarizeEncounterProfile('s','squad','official',make({roundsPlayed:0,damageDealt:0}),null)).toMatchObject({rounds:0,averageDamage:null});
  expect(summarizeEncounterProfile('s','squad','official',make({roundsPlayed:1}),null).averageDamage).toBeNull();
  expect(summarizeEncounterProfile('s','squad','official',make({roundsPlayed:-1,damageDealt:100}),null).rounds).toBeNull();
 });
});
