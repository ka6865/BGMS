import {expect,it,vi} from 'vitest';
import {auditRolePending} from '../scripts/audit_role_pending';
it('audits offline without IO on import, and refuses ambiguous snapshots',()=>{
  const fetch=vi.fn(()=>{throw new Error('network forbidden');});vi.stubGlobal('fetch',fetch);
  try {
    expect(auditRolePending([])).toMatchObject({activationAllowed:false,sourceProfiles:0,pairedProfiles:0});
    expect(()=>auditRolePending({})).toThrow('invalid_role_snapshot');
    const subject={account:'a',matches:[],results:[]};
    expect(()=>auditRolePending([subject,subject])).toThrow('duplicate_accounts');
    expect(fetch).not.toHaveBeenCalled();
  } finally {vi.unstubAllGlobals();}
});

it('uses the validated account and retention window for fitting, decisions and variants',()=>{
  const roleEvidence={version:1,validWeaponHits:6,distanceHitCount:6,distanceDamage:{short:100,mid:0,long:0},maxHitDist:20,pressureIndex:1,
    focusFireCount:0,rescueCount:0,rescueOpportunityCount:0,positionSampleCount:0,edgePlayCount:0};
  const match=(id:string,foreign=false)=>({v:73,calculationVersion:foreign?4:5,populationEvidenceVersion:1,matchId:id,createdAt:'2026-10-28T12:00:00Z',gameMode:'squad',matchType:'official',platform:'steam',
    benchmark:{score:foreign?99:20,tier:'B'},stats:{playerId:foreign?'other':'a',winPlace:2},totalTeams:20,teamContext:{myRosterSize:1},
    roleEvidence:{...roleEvidence,distanceDamage:{short:foreign?10000:100,mid:0,long:0}}});
  const good=Array.from({length:3},(_,i)=>match(`good${i}`));
  const subject={account:'a',target:'Fixture',queriedAt:'2026-10-29T00:00:00Z',matches:good.map(m=>({match_id:m.matchId,played_at:m.createdAt})),results:good};
  const clean=auditRolePending([subject],'seed');
  const contaminated=auditRolePending([{...subject,results:[...good,...Array.from({length:3},(_,i)=>match(`foreign${i}`,true))]}],'seed');
  expect(contaminated).toEqual(clean);
  expect(contaminated.policies[1].targets[0].description).toContain('선정 3경기');
});

it('separates missing role evidence from a missing reference CDF and keeps the exact 85 boundary',async()=>{
  const {roleSummary,preciseRoles}=await import('../scripts/audit_role_pending');
  const {aggregateMatches}=await import('../lib/pubg-analysis/summaryAggregate');
  const levels=[5,10,20,30,40,50,60,70,80,90,95];
  const evidence={version:1,validWeaponHits:6,distanceHitCount:6,distanceDamage:{short:254.88,mid:45.12,long:0},maxHitDist:20,pressureIndex:1.2,focusFireCount:0,rescueCount:0,rescueOpportunityCount:0,positionSampleCount:0,edgePlayCount:0};
  const row=(id:string,roleEvidence:any)=>({matchId:id,createdAt:'2026-10-28T12:00:00Z',gameMode:'squad',matchType:'official',platform:'steam',v:73,calculationVersion:5,populationEvidenceVersion:1,
    benchmark:{score:50,tier:'B'},stats:{playerId:'a'},teamContext:{myRosterSize:1},roleEvidence});
  const stats=(roleEvidence:any)=>({...aggregateMatches(['1','2','3'].map(id=>row(id,roleEvidence)),{roleEvidenceVersion:2}),mLen:3,modeDistribution:{main:'squad'}});
  const withDistance=stats(evidence),withoutDistance=stats({...evidence,distanceHitCount:0,maxHitDist:null,distanceDamage:{short:0,mid:0,long:0}});
  const cohort='steam|squad|official';
  const reference={evidenceVersion:2 as const,cohort,metrics:{shortShare:levels},roles:{brawler:levels}};
  // 84.96은 반올림하면 85.0이지만 판정과 사유 분류는 반올림 전 값으로 한다.
  expect(preciseRoles(withDistance,reference)[0].score).toBeCloseTo(84.96,2);
  const profile=(key:string,s:any)=>({accountKey:key,cohort,partition:'train' as const,selectedMatchIds:['1','2','3'],tier:'B',stats:s});
  const pendingWindow={decision:{status:'pending',primaryRole:'pending'},runs:5,disagreements:{rank_flip:0,lost_confirmation:0,gained_confirmation:0,state_change:0,insufficient:0,commander_change:0}} as any;
  const windows=new Map([['scored',pendingWindow],['missing',pendingWindow]]);
  const summary=(roles:any)=>roleSummary([profile('scored',withDistance),profile('missing',withoutDistance)],windows,
    [{cohort,reference:{...reference,roles},roleCoverage:{brawler:{train:2,holdout:0,eligible:false}}}])[0];
  expect(summary({brawler:levels})).toMatchObject({scored:1,noReferenceCdf:0,missingRequiredEvidence:1,pendingTop:{belowThreshold:1,unstable:0}});
  expect(summary({})).toMatchObject({scored:0,noReferenceCdf:1,missingRequiredEvidence:1});
});
