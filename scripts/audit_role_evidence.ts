import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readLocalCalibrationSource,calculateCalibrationResult,type CalibrationSubject} from './calibrate_coaching_reference';
import {parseSharedTelemetrySource} from '../lib/pubg-analysis/sharedTelemetrySourceContract';
import {buildCalibrationProfile,calibrationMatchWindow,calibrationAccountKey,fitReferenceCandidate,roleWindowStability,CALIBRATION_SEED,type CalibrationProfile} from '../lib/pubg-analysis/referenceCalibration';
import {selectRecentMatches} from '../lib/pubg-analysis/recentMatchSelection';
import {isCanonicalMatchId} from '../lib/pubg-analysis/telemetryIdentity';
import {classifyRole} from '../lib/pubg-analysis/roleClassifier';

/** 보관된 로컬 원본만 읽고, 계정 목록 대신 익명 집계를 출력한다. */
export async function runRoleEvidenceAudit(args:string[]) {
  const options:Record<string,string>={},directories:string[]=[];
  for(let i=0;i<args.length;i++){
    const key=args[i],value=args[++i];
    if(!['--input','--source-dir','--output','--max-profiles','--snapshot'].includes(key)||!value)throw new Error('Usage: --input private-subjects.json --source-dir local-directory [--source-dir ...] --output anonymous-report.json [--max-profiles 150] [--snapshot private-results.json.gz]');
    if(key==='--source-dir')directories.push(path.resolve(value));else options[key]=value;
  }
  if(!options['--input']||!options['--output']||!directories.length)throw new Error('input, sources and output required');
  const limit=Number(options['--max-profiles']??150);
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('invalid profile limit');
  const inputText=fs.readFileSync(options['--input'],'utf8');
  const subjects=JSON.parse(inputText) as CalibrationSubject[];
  if(!Array.isArray(subjects)||subjects.length>20000)throw new Error('invalid subject array');
  if(new Set(subjects.map(s=>s.account)).size!==subjects.length)throw new Error('duplicate account subjects');
  const checksum=createHash('sha256').update(inputText).digest('hex');
  const expected=(subject:CalibrationSubject)=>calibrationMatchWindow(subject.matches,subject.queriedAt).map(row=>row.match_id);
  const sourceExists=(id:string)=>isCanonicalMatchId(id)&&directories.some(dir=>['.json','.json.gz','.json.zst'].some(extension=>fs.existsSync(path.join(dir,id+extension))));
  const candidates=subjects.flatMap(subject=>{
    const ids=expected(subject);
    const old=buildCalibrationProfile({accountKey:subject.account,target:subject.target,expectedMatchIds:ids,matches:subject.results},CALIBRATION_SEED);
    if(!old.profile)return [];
    return [{subject,ids,old:old.profile,complete:ids.every(sourceExists)}];
  });
  const complete=candidates.filter(candidate=>candidate.complete).sort((a,b)=>Number(Boolean(b.subject.target))-Number(Boolean(a.subject.target))
    || calibrationAccountKey(a.subject.account).localeCompare(calibrationAccountKey(b.subject.account)));
  // 표본 수가 되는 cohort는 train50/holdout20을 먼저 확보하고 hash 순서를 유지한다.
  const selected=complete.filter(row=>row.subject.target);
  const cohorts=[...new Set(complete.map(row=>row.old.cohort))].sort();
  for(const cohort of cohorts){
    const train=complete.filter(row=>row.old.cohort===cohort&&row.old.partition==='train');
    const held=complete.filter(row=>row.old.cohort===cohort&&row.old.partition==='holdout');
    if(train.length>=50&&held.length>=20&&selected.length+70<=limit)selected.push(...train.slice(0,50),...held.slice(0,20));
  }
  for(const row of complete){if(selected.length>=limit)break;if(!selected.includes(row))selected.push(row);}
  if(selected.length>limit)throw new Error('limit_below_named_targets');
  const profiles:CalibrationProfile[]=[],rows:Array<{subject:CalibrationSubject;results:any[];profile:CalibrationProfile;old:CalibrationProfile}>=[];
  const errors:Record<string,number>={};let replayedMatches=0,sourceBytes=0;
  const changedLegacyScores:Array<{account:string;matches:number}>=[];
  for(const candidate of selected){
    const results:any[]=[];
    for(const id of candidate.ids){
      let raw:string|null=null;
      for(const dir of directories){raw=readLocalCalibrationSource(dir,id);if(raw!==null)break;}
      if(raw===null){errors.source_missing=(errors.source_missing??0)+1;break;}
      sourceBytes+=Buffer.byteLength(raw);
      const source=parseSharedTelemetrySource(JSON.parse(raw),id,'steam');
      if(!source)throw new Error('invalid_local_source');
      results.push(calculateCalibrationResult(source,candidate.subject.account,candidate.subject.name));replayedMatches++;
    }
    const next=buildCalibrationProfile({accountKey:candidate.subject.account,target:candidate.subject.target,expectedMatchIds:candidate.ids,matches:results},CALIBRATION_SEED,{evidenceVersion:1});
    if(!next.profile){const key=next.reason??'profile_unavailable';errors[key]=(errors[key]??0)+1;continue;}
    const changes=results.filter(result=>{
      const before=candidate.subject.results.find(row=>row.matchId===result.matchId);
      return before&&JSON.stringify(before.benchmark)!==JSON.stringify(result.benchmark);
    }).length;
    if(changes)changedLegacyScores.push({account:calibrationAccountKey(candidate.subject.account),matches:changes});
    profiles.push(next.profile);rows.push({subject:candidate.subject,results,profile:next.profile,old:candidate.old});
    if(profiles.length%10===0)console.log(JSON.stringify({stage:'local_replay',profiles:profiles.length,selected:selected.length,matches:replayedMatches}));
  }
  if(options['--snapshot']){
    const file=path.resolve(options['--snapshot']);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    fs.writeFileSync(file,gzipSync(JSON.stringify(rows.map(row=>({...row.subject,results:row.results})))),{mode:0o600});
  }
  const candidate=fitReferenceCandidate(profiles,CALIBRATION_SEED,{evidenceVersion:1});
  const movements=rows.map(row=>{
    const reference=candidate.cohorts.find(cohort=>cohort.cohort===row.profile.cohort)!.reference;
    const before=classifyRole({...row.old.stats,avgReactionLatency:'측정 불가'},null,row.old.tier);
    const latest=selectRecentMatches(row.results.map((value,sourceIndex)=>({id:value.matchId,createdAt:value.createdAt,gameMode:value.gameMode,matchType:value.matchType,mapName:value.mapName??null,sourceIndex,value}))).selected.map(item=>item.value);
    const stability=roleWindowStability(latest,reference);
    const after=stability.decision;
    return {account:calibrationAccountKey(row.subject.account),...(row.subject.target?{target:row.subject.target}:{}),partition:row.profile.partition,
      cohort:row.profile.cohort,before:before.title,after:after.title,status:after.status,reason:after.reason,scores:after.scores,
      observedRoleCount:after.observedRoleCount,windowAgreement:stability.agreement,
      selectedMatchChanges:row.old.selectedMatchIds.filter(id=>!row.profile.selectedMatchIds.includes(id)).length,
      rescueRate:row.profile.stats.roleEvidence!.rescueOpportunityCount>0?row.profile.stats.roleEvidence!.rescueCount/row.profile.stats.roleEvidence!.rescueOpportunityCount*100:null};
  });
  const report={schemaVersion:1,evidenceVersion:1,activationAllowed:false,
    validationKind:'development replay; previously inspected sample, not independent final validation',inputChecksum:checksum,
    sourceInventory:{subjects:subjects.length,eligibleProfiles:candidates.length,completeSourceProfiles:complete.length,selectedProfiles:selected.length,limit},
    replayedProfiles:profiles.length,replayedMatches,sourceBytes,errors,
    storedSnapshotBenchmarkDifferences:changedLegacyScores,
    benchmarkComparisonNote:'Stored snapshots can predate current engine fixes. Exact legacy invariance is tested against the same input in engine regression; snapshot differences are reported, not hidden.',
    candidate,movements};
  fs.mkdirSync(path.dirname(path.resolve(options['--output'])),{recursive:true});
  fs.writeFileSync(options['--output'],JSON.stringify(report,null,2)+'\n',{mode:0o600});
  return report;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))runRoleEvidenceAudit(process.argv.slice(2)).then(report=>console.log(JSON.stringify({profiles:report.replayedProfiles,matches:report.replayedMatches,inventory:report.sourceInventory,activationAllowed:false}))).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
