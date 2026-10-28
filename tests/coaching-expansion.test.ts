import { describe,expect,it,vi } from 'vitest';
import { evaluateCoachingExpansion } from '../scripts/validate_coaching_expansion';
const subject=(account:string,target?:string)=>({account,name:account,target,queriedAt:'2026-10-28T00:00:00Z',matches:[],results:[]});
describe('isolated confirmation of coaching references',()=>{
 it('never fits confirmation accounts or named targets into the candidate',()=>{
  const dev=[subject('a','KangHeeSung_')],held=[subject('b')];
  const before=evaluateCoachingExpansion(dev),after=evaluateCoachingExpansion(dev,held);
  expect(after.candidate).toEqual(before.candidate);expect(after.activationAllowed).toBe(false);
  expect(after.confirmation.accounts).toBe(1);expect(after.confirmation.rejections).toEqual({incomplete_window:1});
 });
 it('rejects overlap and a target disguised as independent confirmation',()=>{
  expect(()=>evaluateCoachingExpansion([subject('a')],[subject('a')])).toThrow(/overlapping/);
  expect(()=>evaluateCoachingExpansion([],[subject('a','MiaeQ_Q')])).toThrow(/named targets/);
 });
});

it('withholds a role whose observed accounts are unstable despite a high overall agreement',async()=>{
 const calibration=await import('../lib/pubg-analysis/referenceCalibration'),roles=await import('../lib/pubg-analysis/roleClassifier');
 const final=Array.from({length:40},(_,i)=>subject('held'+i));
 const spies=[
  vi.spyOn(calibration,'buildCalibrationProfile').mockImplementation(input=>({profile:{accountKey:input.accountKey,cohort:'steam|duo|competitive',partition:'holdout',selectedMatchIds:['1','2','3'],tier:'B',stats:{point:Number(input.accountKey.replace('held',''))<20}}})),
  vi.spyOn(calibration,'fitReferenceCandidate').mockReturnValue({cohorts:[{cohort:'steam|duo|competitive',reference:{metrics:{},roles:{pointMan:Array(11).fill(50)}}}]} as any),
  vi.spyOn(calibration,'bootstrapReferenceStability').mockReturnValue({runs:100,titleAgreement:.8,metricIntervals:{},accountAgreement:final.map((s,i)=>({account:calibration.calibrationAccountKey(s.account),agreement:i<20?.6:1}))}),
  vi.spyOn(roles,'calculateRoleRawScores').mockImplementation(stats=>({metricPercentiles:{},rawScores:{pointMan:stats.point?50:null}} as any)),
 ];
 try{const cohort=evaluateCoachingExpansion([],final).confirmation.cohorts[0];expect(cohort.stableRoleCandidates).toEqual([]);expect(cohort.roleValidation.pointMan).toMatchObject({accounts:20,titleAgreement:.6,eligible:false});}
 finally{spies.forEach(s=>s.mockRestore());}
});

it('excludes shared games from independent confirmation and ignores results outside the requested window',()=>{
 const build=(account:string,ids:string[])=>({account,name:account,queriedAt:'2026-10-28T00:00:00Z',matches:ids.map(match_id=>({match_id,player_id:account,account_id:account,platform:'steam',played_at:'2026-10-27T00:00:00Z',game_mode:'squad',match_type:'official'})),
  results:ids.map(matchId=>({matchId,createdAt:'2026-10-27T00:00:00Z',gameMode:'squad',matchType:'official',v:73,calculationVersion:5,populationEvidenceVersion:1,benchmark:{score:50,tier:'B'},stats:{playerId:account},initiative_rate:80}))});
 const dev=build('dev',['1','2','3']),held=build('held',['1','4','5']);held.results.push({...held.results[0],matchId:'stale'});
 const report=evaluateCoachingExpansion([dev],[held]);
 expect(report.confirmation).toMatchObject({completeProfiles:1,playerMatches:3,gameDisjointProfiles:0,gameDisjointPlayerMatches:2,overlapExcludedProfiles:1,overlapExcludedPlayerMatches:1});
 expect(report.confirmation.cohorts.every(c=>c.accounts===0)).toBe(true);
});

it('uses the app retention window at the frozen collection time before requiring scores or benchmarking',()=>{
 const account='retention-fixture',ids=['fresh1','fresh2','fresh3'];
 const s={account,name:account,queriedAt:'2026-10-28T00:00:00Z',matches:[...ids,'expired'].map(match_id=>({match_id,player_id:account,account_id:account,platform:'steam',played_at:match_id==='expired'?'2026-10-12T00:00:00Z':'2026-10-27T00:00:00Z',game_mode:'squad',match_type:'official'})),
  results:ids.map(matchId=>({matchId,createdAt:'2026-10-27T00:00:00Z',gameMode:'squad',matchType:'official',v:73,calculationVersion:5,populationEvidenceVersion:1,benchmark:{score:50,tier:'B'},stats:{playerId:account},initiative_rate:80}))};
 const report=evaluateCoachingExpansion([s]);
 expect(report.development).toMatchObject({completeProfiles:1,playerMatches:3});expect(report.excludedExpiredRequests).toEqual({development:1,confirmation:0});
 vi.useFakeTimers();vi.setSystemTime(new Date('2035-01-01T00:00:00Z'));
 try{expect(evaluateCoachingExpansion([s])).toEqual(report);}finally{vi.useRealTimers();}
});
