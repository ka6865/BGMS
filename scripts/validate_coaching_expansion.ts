import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { calibrationMatchWindow, calibrationPartition, calibrationAccountKey, buildCalibrationProfile, fitReferenceCandidate, buildBenchmarkCoverage, buildReplyPrecision, bootstrapReferenceStability, roleWindowStability, calibrationResults, CALIBRATION_SEED, type CalibrationProfile } from '../lib/pubg-analysis/referenceCalibration';
import { classifyRole, calculateRoleRawScores } from '../lib/pubg-analysis/roleClassifier';
import type { CalibrationSubject } from './calibrate_coaching_reference';
import { RESULT_VERSION,ANALYSIS_CALCULATION_VERSION,POPULATION_EVIDENCE_VERSION } from '../lib/pubg-analysis/constants';

/** 추가 benchmark 관측은 역할 프로필이나 후보 fitting에 넣지 않는다. */
export function evaluateBenchmarkSupplement(development:CalibrationSubject[], confirmation:CalibrationSubject[], supplement:CalibrationSubject[], seed=CALIBRATION_SEED) {
  const all=[...development,...confirmation,...supplement];
  if(new Set(all.map(s=>s.account)).size!==all.length)throw new Error('overlapping calibration accounts');
  if([...confirmation,...supplement].some(s=>s.target))throw new Error('named targets cannot confirm calibration');
  if(supplement.length>2000||supplement.some(s=>s.matches.length>10))throw new Error('supplement window cap exceeded');
  const developmentGames=new Set(development.flatMap(s=>s.matches.map(m=>m.match_id)));
  const priorGames=new Set([...development,...confirmation].flatMap(s=>s.matches.map(m=>m.match_id)));
  const addedGames=supplement.flatMap(s=>s.matches.map(m=>m.match_id));
  if(addedGames.some(id=>priorGames.has(id)))throw new Error('supplement overlaps a prior game');
  if(new Set(addedGames).size!==addedGames.length)throw new Error('supplement requires one account per game');
  const normalize=(subjects:CalibrationSubject[])=>subjects.map(s=>({...s,matches:calibrationMatchWindow(s.matches,s.queriedAt)}));
  const first=normalize(confirmation),added=normalize(supplement);
  const matchesFor=(subjects:CalibrationSubject[])=>subjects.flatMap(s=>{
    const wanted=new Set(s.matches.map(m=>m.match_id));
    const results=s.results.filter(m=>wanted.has(m.matchId));
    if(new Set(results.map(m=>m.matchId)).size!==results.length)throw new Error('duplicate benchmark result');
    return results.map(m=>{
      if(m.stats?.playerId!==s.account||m.v!==RESULT_VERSION||m.calculationVersion!==ANALYSIS_CALCULATION_VERSION||m.populationEvidenceVersion!==POPULATION_EVIDENCE_VERSION)throw new Error('invalid benchmark result identity or version');
      return {...m,accountKey:s.account};
    });
  });
  const firstMatches=matchesFor(first).filter(m=>!developmentGames.has(m.matchId)),addedMatches=matchesFor(added);
  return {schemaVersion:1,seed,activationAllowed:false,confirmationAccounts:confirmation.length,supplementAccounts:supplement.length,
    confirmationPlayerMatches:firstMatches.length,requestedSupplementPlayerMatches:addedGames.length,supplementPlayerMatches:addedMatches.length,
    unavailableSupplementPlayerMatches:added.reduce((n,s)=>n+s.matches.length,0)-addedMatches.length,
    excludedExpiredRequests:{confirmation:confirmation.reduce((n,s)=>n+s.matches.length,0)-first.reduce((n,s)=>n+s.matches.length,0),supplement:addedGames.length-added.reduce((n,s)=>n+s.matches.length,0)},
    gameOverlapWithPriorRequested:0,oneAccountPerSupplementGame:true,
    supplementBenchmarkCoverage:buildBenchmarkCoverage(addedMatches),
    supplementReplyPrecision:buildReplyPrecision(addedMatches,`${seed}|benchmark-supplement-1`),
    combinedReplyPrecision:buildReplyPrecision([...firstMatches,...addedMatches],`${seed}|final`)};
}

/** evidenceVersion을 지정하지 않으면 기존 legacy 검증과 같다. 2를 지정하면 EV2 후보와 cohort 조건으로 같은 분리 검증을 한다. */
export function evaluateCoachingExpansion(development:CalibrationSubject[], confirmation:CalibrationSubject[]=[], seed=CALIBRATION_SEED, options:{evidenceVersion?:2}={}) {
  const all=[...development,...confirmation];
  if(new Set(all.map(s=>s.account)).size!==all.length)throw new Error('overlapping calibration accounts');
  if(confirmation.some(s=>s.target))throw new Error('named targets cannot confirm calibration');
  const developmentGameIds=new Set(development.flatMap(s=>s.matches.map(m=>m.match_id)));
  const requested={development:development.reduce((n,s)=>n+s.matches.length,0),confirmation:confirmation.reduce((n,s)=>n+s.matches.length,0)};
  development=development.map(s=>({...s,matches:calibrationMatchWindow(s.matches,s.queriedAt)}));
  confirmation=confirmation.map(s=>({...s,matches:calibrationMatchWindow(s.matches,s.queriedAt)}));
  const excludedExpiredRequests={development:requested.development-development.reduce((n,s)=>n+s.matches.length,0),confirmation:requested.confirmation-confirmation.reduce((n,s)=>n+s.matches.length,0)};
  function profilesFor(subjects:CalibrationSubject[]){
    const profiles:CalibrationProfile[]=[],rejections:Record<string,number>={};
    for(const s of subjects){const r=buildCalibrationProfile({accountKey:s.account,target:s.target,expectedMatchIds:s.matches.map(m=>m.match_id),matches:s.results},seed,options);
      if(r.profile)profiles.push(r.profile);else rejections[r.reason??'unknown']=(rejections[r.reason??'unknown']??0)+1;}
    return {profiles,rejections};
  }
  const dev=profilesFor(development),final=profilesFor(confirmation),candidate=fitReferenceCandidate(dev.profiles,seed,options);
  const matchesFor=(subjects:CalibrationSubject[])=>subjects.filter(s=>!s.target).flatMap(s=>{const expected=new Set(s.matches.map(m=>m.match_id));return s.results.filter(m=>expected.has(m.matchId)).map(m=>({...m,accountKey:s.account}));});
  const developmentMatches=matchesFor(development),allConfirmationMatches=matchesFor(confirmation);
  const confirmationMatches=allConfirmationMatches.filter(m=>!developmentGameIds.has(m.matchId));
  const disjointProfiles=final.profiles.filter(p=>p.selectedMatchIds.every(id=>!developmentGameIds.has(id)));
  const finalCohorts=candidate.cohorts.map(c=>{
    const train=dev.profiles.filter(p=>p.cohort===c.cohort&&p.partition==='train'),held=disjointProfiles.filter(p=>p.cohort===c.cohort);
    const stability=bootstrapReferenceStability(train,held,c.reference,`${seed}|final|${c.cohort}`);
    const roleAccounts=new Map<string,string[]>();
    const accountAgreement=new Map((stability.accountAgreement??[]).map(a=>[a.account,a.agreement]));
    const roleObservations:Record<string,number>={};
    const titles:Record<string,number>={};
    for(const p of held){const raw=calculateRoleRawScores(p.stats,c.reference).rawScores;for(const [key,value]of Object.entries(raw))if(value!==null){roleObservations[key]=(roleObservations[key]??0)+1;if(!roleAccounts.has(key))roleAccounts.set(key,[]);roleAccounts.get(key)!.push(calibrationAccountKey(p.accountKey));}
      const result=classifyRole(p.stats,null,p.tier,c.reference);titles[result.primaryRole]=(titles[result.primaryRole]??0)+1;}
    const roleValidation=Object.fromEntries([...roleAccounts].map(([role,accounts])=>{
      const agreements=accounts.map(a=>accountAgreement.get(a)??0),titleAgreement=Number((agreements.reduce((s,v)=>s+v,0)/accounts.length).toFixed(8));
      return [role,{accounts:accounts.length,titleAgreement,stableAccounts:agreements.filter(v=>v>=.8).length,eligible:accounts.length>=20&&titleAgreement>=.8}];
    }));
    // EV2에서는 같은 고정 기준으로 확인 계정의 경기 창 교체 안정성도 따로 센다(기준 재적합 없음).
    const windowChecks=options.evidenceVersion===2?held.map(p=>{
      const subject=confirmation.find(s=>s.account===p.accountKey)!;
      const results=calibrationResults({accountKey:subject.account,expectedMatchIds:subject.matches.map(m=>m.match_id),matches:subject.results});
      const w=roleWindowStability(results,c.reference);
      return {account:calibrationAccountKey(p.accountKey),status:w.decision.status,primaryRole:w.decision.primaryRole,presentation:w.decision.presentation??null,
        cohortCheck:w.decision.cohortCheck??null,changedVariants:w.runs,agreement:w.agreement,disagreements:w.disagreements};
    }):undefined;
    return {cohort:c.cohort,accounts:held.length,roleObservations,roleValidation,titles,stability,
      stableRoleCandidates:Object.keys(c.reference.roles).filter(role=>roleValidation[role]?.eligible),...(windowChecks?{windowChecks}:{})};
  });
  return {schemaVersion:1,seed,activationAllowed:false,excludedExpiredRequests,
    development:{accounts:development.length,playerMatches:developmentMatches.length,completeProfiles:dev.profiles.length,rejections:dev.rejections,
      benchmarkCoverage:buildBenchmarkCoverage(developmentMatches),replyPrecision:buildReplyPrecision(developmentMatches,seed),
      trainingReplyPrecision:buildReplyPrecision(matchesFor(development.filter(s=>calibrationPartition(s.account,seed)==='train')),seed),
      holdoutReplyPrecision:buildReplyPrecision(matchesFor(development.filter(s=>calibrationPartition(s.account,seed)==='holdout')),`${seed}|holdout`)},
    confirmation:{accounts:confirmation.length,playerMatches:allConfirmationMatches.length,completeProfiles:final.profiles.length,rejections:final.rejections,
      gameDisjointProfiles:disjointProfiles.length,gameDisjointPlayerMatches:confirmationMatches.length,overlapExcludedProfiles:final.profiles.length-disjointProfiles.length,overlapExcludedPlayerMatches:allConfirmationMatches.length-confirmationMatches.length,
      benchmarkCoverage:buildBenchmarkCoverage(confirmationMatches),replyPrecision:buildReplyPrecision(confirmationMatches,`${seed}|final`),cohorts:finalCohorts},candidate};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{development:{type:'string'},confirmation:{type:'string'},'benchmark-supplement':{type:'string'},output:{type:'string'},'evidence-version':{type:'string'}}});
  if(values['evidence-version']!==undefined&&values['evidence-version']!=='2')throw new Error('--evidence-version supports only 2');
  const evidenceOptions=values['evidence-version']==='2'?{evidenceVersion:2 as const}:{};
  if(!values.development||!values.output)throw new Error('--development and --output required');
  if(values['benchmark-supplement']&&!values.confirmation)throw new Error('--confirmation required for benchmark supplement');
  const development=JSON.parse(fs.readFileSync(values.development,'utf8')),confirmation=values.confirmation?JSON.parse(fs.readFileSync(values.confirmation,'utf8')):[];
  const report={...evaluateCoachingExpansion(development,confirmation,CALIBRATION_SEED,evidenceOptions),...(values['benchmark-supplement']?{benchmarkSupplement:evaluateBenchmarkSupplement(development,confirmation,JSON.parse(fs.readFileSync(values['benchmark-supplement'],'utf8')))}:{})};
  fs.writeFileSync(values.output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({development:report.development.completeProfiles,confirmation:report.confirmation.completeProfiles,activationAllowed:false}));
}
