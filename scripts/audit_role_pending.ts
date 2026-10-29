import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { aggregateMatches, roleCohortOf } from '../lib/pubg-analysis/summaryAggregate';
import { selectRecentMatches, selectBestMatches } from '../lib/pubg-analysis/recentMatchSelection';
import { calculateRoleRawScores, classifyRole, type RoleInfo } from '../lib/pubg-analysis/roleClassifier';
import { referencePercentile, roleScorePercentile, type RoleScoreKey, type RoleReference } from '../lib/pubg-analysis/roleReference';
import { buildCalibrationProfile, calibrationMatchWindow, calibrationResults, fitReferenceCandidate, roleWindowStability, quantiles, CALIBRATION_SEED, type CalibrationProfile } from '../lib/pubg-analysis/referenceCalibration';

type Subject = {account:string;target?:string;queriedAt:string;matches:Array<{match_id:string;played_at:string}>;results:any[]};
const cohortOf = (match:any) => roleCohortOf(match) ?? 'unknown';
const counts = (roles:RoleInfo[]) => roles.reduce((sum, role) => {
  const key = role.status === 'pending' ? role.presentation === 'combined' ? 'combined' : role.presentation === 'observed' ? 'observed' : 'unexplainedPending' : role.status ?? 'unknown';
  sum[key] = (sum[key] ?? 0) + 1; return sum;
}, {} as Record<string,number>);
const midShare = (stats:any):number|null => {
  const e=stats.roleEvidence,d=e?.distanceDamage,total=d ? d.short+d.mid+d.long : 0;
  return e?.distanceHitCount > 0 && total >= 300 ? 100*d.mid/total : null;
};

// 탐색 후보는 기존 분류기를 교체하지 않으며 고정한 train/holdout에서만 분포를 만든다.
function middleCandidate(profiles:CalibrationProfile[], subjects:Map<string,Subject>, reference:RoleReference) {
  const train=profiles.filter(p=>p.partition==='train'), held=profiles.filter(p=>p.partition==='holdout');
  const trainValues=train.map(p=>midShare(p.stats)).filter((v):v is number=>v!==null);
  const heldCount=held.filter(p=>midShare(p.stats)!==null).length;
  const q=quantiles(trainValues);
  const midReference:RoleReference={metrics:q ? {shortShare:q} : {},roles:{}};
  const raw=(stats:any)=>{const v=midShare(stats);return v===null?null:referencePercentile('shortShare',v,midReference);};
  const rawTrain=train.map(p=>raw(p.stats)).filter((v):v is number=>v!==null);
  const rq=quantiles(rawTrain);if(rq)midReference.roles.brawler=rq;
  const eligible=trainValues.length>=50 && heldCount>=20 && Boolean(rq);
  const qualified=(stats:any)=>{
    const share=midShare(stats),r=raw(stats),score=r===null?null:roleScorePercentile('brawler',r,midReference);
    const existing=Object.entries(calculateRoleRawScores(stats,reference).rawScores)
      .map(([key,value])=>value===null?null:roleScorePercentile(key as RoleScoreKey,value,reference)).filter((v):v is number=>v!==null);
    return eligible && share!==null && share>50 && score!==null && score>=85 && score>Math.max(0,...existing)
      && classifyRole(stats,null,'B',reference).primaryRole!=='fieldCommander';
  };
  const result={eligible,metricTrain:trainValues.length,metricHoldout:heldCount,qualifiedBeforeStability:0,stableCandidates:0,
    fromPending:0,replacesConfirmed:0,existingLeaderOverlap:{brawler:0,phantomOverwatch:0,executor:0} as Record<string,number>,partitions:{} as Record<string,{stable:number;fromPending:number;replacesConfirmed:number}>};
  for(const p of profiles){
    if(!qualified(p.stats))continue;
    result.qualifiedBeforeStability++;
    const subject=subjects.get(p.accountKey)!;
    const latest=selectRecentMatches(subject.results.map((value,sourceIndex)=>({id:value.matchId,createdAt:value.createdAt,gameMode:value.gameMode,matchType:value.matchType,mapName:value.mapName??null,sourceIndex,value}))).selected
      .filter(row=>cohortOf(row.value)===p.cohort);
    const baseIds=p.selectedMatchIds.slice().sort().join('|');
    const variants=latest.map((_,i)=>selectBestMatches(latest.filter((__,j)=>i!==j)))
      .filter(rows=>rows.map(row=>row.id).sort().join('|')!==baseIds);
    const passing=variants.filter(rows=>rows.length>=3 && qualified({...aggregateMatches(rows.map(row=>row.value),reference.evidenceVersion===2?{roleEvidenceVersion:2}:undefined),modeDistribution:p.stats.modeDistribution}));
    if(variants.length<3 || passing.length/variants.length<.8)continue;
    const before=roleWindowStability(subject.results,reference).decision;
    const partition=result.partitions[p.partition]??={stable:0,fromPending:0,replacesConfirmed:0};
    result.stableCandidates++;partition.stable++;
    const leader=Object.entries(calculateRoleRawScores(p.stats,reference).rawScores)
      .map(([key,value])=>[key,value===null?null:roleScorePercentile(key as RoleScoreKey,value,reference)] as const)
      .filter((row):row is readonly [string,number]=>row[1]!==null).sort((a,b)=>b[1]-a[1])[0]?.[0];
    if(leader && Object.hasOwn(result.existingLeaderOverlap,leader))result.existingLeaderOverlap[leader]++;
    if(before.status==='pending'){result.fromPending++;partition.fromPending++;}
    if(before.status==='confirmed'){result.replacesConfirmed++;partition.replacesConfirmed++;}
  }
  return result;
}

const topRoles=(stats:any,reference:RoleReference)=>Object.entries(calculateRoleRawScores(stats,reference).rawScores)
  .map(([key,value])=>[key,value===null?null:roleScorePercentile(key as RoleScoreKey,value,reference)] as const)
  .filter((row):row is readonly [string,number]=>row[1]!==null).sort((a,b)=>b[1]-a[1]).map(([role,score])=>({role,score:Number(score.toFixed(1))}));

/** 역할별 근거·판정·경기 창 불일치 집계. 판정 규칙을 바꾸지 않고 기존 결과만 센다. */
function roleSummary(profiles:CalibrationProfile[], windows:Map<string,ReturnType<typeof roleWindowStability>>, cohorts:Array<{cohort:string;reference:RoleReference;roleCoverage:Record<string,{train:number;holdout:number;eligible:boolean}>}>) {
  const rows:Record<string,any>={};
  for(const c of cohorts){
    const group=profiles.filter(p=>p.cohort===c.cohort);
    for(const [role,coverage] of Object.entries(c.roleCoverage)){
      const row:any={cohort:c.cohort,role,referenceEligible:coverage.eligible,train:coverage.train,holdout:coverage.holdout,
        observableProfiles:0,missingRequiredEvidence:0,confirmedPrimary:0,confirmedSecondary:0,
        pendingTop:{unstable:0,belowThreshold:0,fewChangedVariants:0,cohort:0},observedOrCombinedTop:0,
        disagreements:{rank_flip:0,lost_confirmation:0,gained_confirmation:0,state_change:0,insufficient:0,commander_change:0}};
      for(const p of group){
        const window=windows.get(p.accountKey)!,decision=window.decision,top=topRoles(p.stats,c.reference);
        const observable=top.some(t=>t.role===role);
        if(observable)row.observableProfiles++;else row.missingRequiredEvidence++;
        if(decision.status==='confirmed'&&decision.primaryRole===role)row.confirmedPrimary++;
        if(decision.status==='confirmed'&&decision.secondaryRole===role)row.confirmedSecondary++;
        if(top[0]?.role!==role)continue;
        for(const [key,value] of Object.entries(window.disagreements))row.disagreements[key]+=value;
        if(decision.status!=='pending')continue;
        if(decision.cohortCheck&&decision.cohortCheck!=='match')row.pendingTop.cohort++;
        else if(top[0].score<85)row.pendingTop.belowThreshold++;
        else if(window.runs<3)row.pendingTop.fewChangedVariants++;
        else row.pendingTop.unstable++;
        if(decision.presentation==='observed'||decision.presentation==='combined')row.observedOrCombinedTop++;
      }
      rows[`${c.cohort}|${role}`]=row;
    }
  }
  return Object.values(rows);
}

export function auditRolePending(input:unknown, seed=CALIBRATION_SEED) {
  if(!Array.isArray(input) || input.some(s=>!s || typeof s.account!=='string' || !s.account || !Array.isArray(s.matches) || !Array.isArray(s.results)))throw new Error('invalid_role_snapshot');
  if(new Set(input.map(s=>s.account)).size!==input.length)throw new Error('duplicate_accounts');
  const subjects=(input as Subject[]).map(s=>({...s,results:calibrationResults({accountKey:s.account,
    expectedMatchIds:calibrationMatchWindow(s.matches,s.queriedAt).map(m=>m.match_id),matches:s.results})}));
  const byAccount=new Map(subjects.map(s=>[s.account,s]));
  const exclusions:Record<string,number>={};
  const builds=([1,2] as const).map(evidenceVersion=>{
    const profiles:CalibrationProfile[]=[];
    for(const s of subjects){
      const built=buildCalibrationProfile({accountKey:s.account,target:s.target,expectedMatchIds:calibrationMatchWindow(s.matches,s.queriedAt).map(m=>m.match_id),matches:s.results},seed,{evidenceVersion});
      if(built.profile)profiles.push(built.profile);else{const key=`v${evidenceVersion}:${built.reason}`;exclusions[key]=(exclusions[key]??0)+1;}
    }
    const fit=fitReferenceCandidate(profiles,seed,{evidenceVersion});
    return {evidenceVersion,profiles,fit};
  });
  // 계정별 경기 창 검사는 한 번만 계산해 판정·불일치·대상·역할 요약에 함께 쓴다.
  const windows=builds.map(b=>new Map(b.profiles.map(p=>[p.accountKey,roleWindowStability(byAccount.get(p.accountKey)!.results,b.fit.cohorts.find(c=>c.cohort===p.cohort)!.reference)])));
  const decisions=windows.map(w=>new Map([...w].map(([key,window])=>[key,window.decision])));
  const paired=builds[0].profiles.filter(p=>decisions[1].has(p.accountKey));
  return {schemaVersion:1,activationAllowed:false,seed,sourceProfiles:subjects.length,pairedProfiles:paired.length,exclusions,
    validationKind:'fixed development replay; coverage and stability, not accuracy or independent final validation',
    rules:{primaryPercentile:85,changedBest5Stability:.8,minimumChangedVariants:3,minTrainAccounts:50,minHoldoutAccounts:20,
      newTitle:'50m<=distance<200m; own damage >50%; separately fitted metric and role CDF; must beat existing roles in baseline and >=80% changed windows; not added to commander count'},
    paired:builds.map((b,i)=>({evidenceVersion:b.evidenceVersion,counts:counts(paired.map(p=>decisions[i].get(p.accountKey)!))})),
    windowDisagreements:builds.map((b,i)=>({evidenceVersion:b.evidenceVersion,...b.profiles.reduce((sum,p)=>{
      const w=windows[i].get(p.accountKey)!;
      if(w.decision.status!=='pending')return sum;
      for(const [key,value] of Object.entries(w.disagreements))sum[key]=(sum[key]??0)+value;
      if(w.decision.presentation==='combined'){sum.combinedProfiles=(sum.combinedProfiles??0)+1;if(w.disagreements.rank_flip===0)sum.combinedWithoutRankFlip=(sum.combinedWithoutRankFlip??0)+1;}
      return sum;},{} as Record<string,number>)})),
    transitions:paired.reduce((sum,p)=>{const before=decisions[0].get(p.accountKey)!,after=decisions[1].get(p.accountKey)!;
      const key=`${before.status}->${after.status}/${after.presentation??'role'}`;sum[key]=(sum[key]??0)+1;return sum;},{} as Record<string,number>),
    policies:builds.map((b,i)=>({evidenceVersion:b.evidenceVersion,profiles:b.profiles.length,counts:counts([...decisions[i].values()]),
      cohorts:b.fit.cohorts.map(c=>({cohort:c.cohort,trainAccounts:c.trainAccounts,holdoutAccounts:c.holdoutAccounts,targetAccounts:c.targetAccounts,
        reference:c.reference,coverage:c.coverage,roleCoverage:c.roleCoverage,referenceBootstrap:{runs:c.stability.runs,titleAgreement:c.stability.titleAgreement},
        middleCandidate:middleCandidate(b.profiles.filter(p=>p.cohort===c.cohort),byAccount,c.reference)})),
      cohortChecks:[...windows[i].values()].reduce((sum,w)=>{const key=w.decision.cohortCheck??'none';sum[key]=(sum[key]??0)+1;return sum;},{} as Record<string,number>),
      roleSummary:roleSummary(b.profiles,windows[i],b.fit.cohorts),
      targets:b.profiles.filter(p=>p.target).map(p=>{const window=windows[i].get(p.accountKey)!;const role=window.decision;
        return {target:p.target,selectedMatches:p.selectedMatchIds.length,title:role.title,status:role.status,presentation:role.presentation??null,
          primaryRole:role.primaryRole,secondaryRole:role.secondaryRole,reason:role.reason,description:role.description,evidence:role.evidence,
          primaryAgreement:window.agreement,changedOrLegacyRuns:window.runs,disagreements:window.disagreements,cohortCheck:role.cohortCheck??null,
          topRoles:topRoles(p.stats,b.fit.cohorts.find(c=>c.cohort===p.cohort)!.reference).slice(0,3),midShare:midShare(p.stats)};})})),
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),input=args[args.indexOf('--input')+1],output=args[args.indexOf('--output')+1];
  if(!args.includes('--input')||!args.includes('--output')||!input||!output)throw new Error('usage: --input private-snapshot.json.gz --output report.json');
  const bytes=readFileSync(input),snapshot=input.endsWith('.gz')?gunzipSync(bytes).toString('utf8'):bytes.toString('utf8');
  const report={...auditRolePending(JSON.parse(snapshot)),inputSha256:createHash('sha256').update(bytes).digest('hex')};
  writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({sourceProfiles:report.sourceProfiles,pairedProfiles:report.pairedProfiles,paired:report.paired,activationAllowed:false}));
}
