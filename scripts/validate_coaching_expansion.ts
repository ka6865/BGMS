import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { calibrationPartition, calibrationAccountKey, buildCalibrationProfile, fitReferenceCandidate, buildBenchmarkCoverage, buildReplyPrecision, bootstrapReferenceStability, CALIBRATION_SEED, type CalibrationProfile } from '../lib/pubg-analysis/referenceCalibration';
import { classifyRole, calculateRoleRawScores } from '../lib/pubg-analysis/roleClassifier';
import type { CalibrationSubject } from './calibrate_coaching_reference';

export function evaluateCoachingExpansion(development:CalibrationSubject[], confirmation:CalibrationSubject[]=[], seed=CALIBRATION_SEED) {
  const all=[...development,...confirmation];
  if(new Set(all.map(s=>s.account)).size!==all.length)throw new Error('overlapping calibration accounts');
  if(confirmation.some(s=>s.target))throw new Error('named targets cannot confirm calibration');
  function profilesFor(subjects:CalibrationSubject[]){
    const profiles:CalibrationProfile[]=[],rejections:Record<string,number>={};
    for(const s of subjects){const r=buildCalibrationProfile({accountKey:s.account,target:s.target,expectedMatchIds:s.matches.map(m=>m.match_id),matches:s.results},seed);
      if(r.profile)profiles.push(r.profile);else rejections[r.reason??'unknown']=(rejections[r.reason??'unknown']??0)+1;}
    return {profiles,rejections};
  }
  const dev=profilesFor(development),final=profilesFor(confirmation),candidate=fitReferenceCandidate(dev.profiles,seed);
  const matchesFor=(subjects:CalibrationSubject[])=>subjects.filter(s=>!s.target).flatMap(s=>{const expected=new Set(s.matches.map(m=>m.match_id));return s.results.filter(m=>expected.has(m.matchId)).map(m=>({...m,accountKey:s.account}));});
  const developmentMatches=matchesFor(development),allConfirmationMatches=matchesFor(confirmation);
  const developmentGameIds=new Set(development.flatMap(s=>s.matches.map(m=>m.match_id)));
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
    return {cohort:c.cohort,accounts:held.length,roleObservations,roleValidation,titles,stability,
      stableRoleCandidates:Object.keys(c.reference.roles).filter(role=>roleValidation[role]?.eligible)};
  });
  return {schemaVersion:1,seed,activationAllowed:false,
    development:{accounts:development.length,playerMatches:developmentMatches.length,completeProfiles:dev.profiles.length,rejections:dev.rejections,
      benchmarkCoverage:buildBenchmarkCoverage(developmentMatches),replyPrecision:buildReplyPrecision(developmentMatches,seed),
      trainingReplyPrecision:buildReplyPrecision(matchesFor(development.filter(s=>calibrationPartition(s.account,seed)==='train')),seed),
      holdoutReplyPrecision:buildReplyPrecision(matchesFor(development.filter(s=>calibrationPartition(s.account,seed)==='holdout')),`${seed}|holdout`)},
    confirmation:{accounts:confirmation.length,playerMatches:allConfirmationMatches.length,completeProfiles:final.profiles.length,rejections:final.rejections,
      gameDisjointProfiles:disjointProfiles.length,gameDisjointPlayerMatches:confirmationMatches.length,overlapExcludedProfiles:final.profiles.length-disjointProfiles.length,overlapExcludedPlayerMatches:allConfirmationMatches.length-confirmationMatches.length,
      benchmarkCoverage:buildBenchmarkCoverage(confirmationMatches),replyPrecision:buildReplyPrecision(confirmationMatches,`${seed}|final`),cohorts:finalCohorts},candidate};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{development:{type:'string'},confirmation:{type:'string'},output:{type:'string'}}});
  if(!values.development||!values.output)throw new Error('--development and --output required');
  const report=evaluateCoachingExpansion(JSON.parse(fs.readFileSync(values.development,'utf8')),values.confirmation?JSON.parse(fs.readFileSync(values.confirmation,'utf8')):[]);
  fs.writeFileSync(values.output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({development:report.development.completeProfiles,confirmation:report.confirmation.completeProfiles,activationAllowed:false}));
}
