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
  const match=(id:string,foreign=false)=>({v:73,calculationVersion:foreign?4:5,populationEvidenceVersion:1,matchId:id,createdAt:'2026-10-28T12:00:00Z',gameMode:'squad',matchType:'official',
    benchmark:{score:foreign?99:20,tier:'B'},stats:{playerId:foreign?'other':'a',winPlace:2},totalTeams:20,teamContext:{myRosterSize:1},
    roleEvidence:{...roleEvidence,distanceDamage:{short:foreign?10000:100,mid:0,long:0}}});
  const good=Array.from({length:3},(_,i)=>match(`good${i}`));
  const subject={account:'a',target:'Fixture',queriedAt:'2026-10-29T00:00:00Z',matches:good.map(m=>({match_id:m.matchId,played_at:m.createdAt})),results:good};
  const clean=auditRolePending([subject],'seed');
  const contaminated=auditRolePending([{...subject,results:[...good,...Array.from({length:3},(_,i)=>match(`foreign${i}`,true))]}],'seed');
  expect(contaminated).toEqual(clean);
  expect(contaminated.policies[1].targets[0].description).toContain('선정 3경기');
});
