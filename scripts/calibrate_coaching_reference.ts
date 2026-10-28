import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import dotenv from 'dotenv';
import {createClient} from '@supabase/supabase-js';
import {getPrivatePlayersList,matchesPrivatePlayer} from '../lib/pubg/privatePlayers';
import {AnalysisEngine} from '../lib/pubg-analysis/AnalysisEngine';
import {downloadFromR2} from '../lib/pubg-analysis/r2Service';
import {buildSharedTelemetrySourceKey,parseSharedTelemetrySource} from '../lib/pubg-analysis/sharedTelemetrySourceContract';
import {isAiSummaryEligibleMatch} from '../lib/pubg-analysis/matchEligibility';
import {getValidFullResultForMatch} from '../lib/pubg-analysis/cacheIdentity';
import {RESULT_VERSION,ANALYSIS_CALCULATION_VERSION} from '../lib/pubg-analysis/constants';
import {CALIBRATION_SEED,calibrationAccountKey,calibrationPartition,buildCalibrationProfile,fitReferenceCandidate,buildBenchmarkCoverage,type CalibrationProfile} from '../lib/pubg-analysis/referenceCalibration';

const modes=['solo','solo-fpp','duo','duo-fpp','squad','squad-fpp'];
type MatchRow={match_id:string;player_id:string;account_id:string;platform:string;played_at:string;game_mode:string;match_type:string};
type Subject={account:string;name:string;target?:string;matches:MatchRow[];results:any[];historyError?:string};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const write=(file:string,value:unknown)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});

export async function runCalibration(args:string[]) {
  const options:Record<string,string>={};let offline=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--offline'){offline=true;continue;}
    if(!['--pool','--output','--reuse-source-dir'].includes(args[i])||!args[i+1])throw new Error('Usage: --pool private-snapshot.json --output local-directory [--reuse-source-dir directory] [--offline]');
    options[args[i]]=args[++i];
  }
  if(!options['--pool']||!options['--output'])throw new Error('pool and output are required');
  if(!offline)dotenv.config({path:'.env.local',quiet:true});
  const db=offline?null:createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
  const sourcePool=fs.readFileSync(options['--pool'],'utf8');
  const pool=JSON.parse(sourcePool) as {rows:MatchRow[];queriedAt:string;since:string};
  if(!Array.isArray(pool.rows)||pool.rows.length>20000)throw new Error('invalid bounded pool');
  const out=path.resolve(options['--output']);fs.mkdirSync(out,{recursive:true,mode:0o700});
  for(const dir of ['sources','analyses'])fs.mkdirSync(path.join(out,dir),{recursive:true,mode:0o700});
  const registryFile=path.join(out,'private-registry.json');
  const privatePlayers:Awaited<ReturnType<typeof getPrivatePlayersList>>=offline?JSON.parse(fs.readFileSync(registryFile,'utf8')):await getPrivatePlayersList(db!);
  if(!Array.isArray(privatePlayers)||!privatePlayers.every(p=>typeof p.platform==='string'&&typeof p.nickname==='string'&&typeof p.lower_nickname==='string'))throw new Error('invalid privacy snapshot');
  if(!offline)write(registryFile,privatePlayers);
  const groups=new Map<string,MatchRow[]>();let privateExcluded=0;
  for(const row of pool.rows){
    if(row.platform!=='steam'||!/^account\.[A-Za-z0-9_-]+$/.test(row.account_id??''))continue;
    if(matchesPrivatePlayer(privatePlayers,'steam',row.player_id,row.account_id)){privateExcluded++;continue;}
    if(!modes.includes(row.game_mode)||!['official','competitive'].includes(row.match_type))continue;
    if(!groups.has(row.account_id))groups.set(row.account_id,[]);
    groups.get(row.account_id)!.push(row);
  }
  const targetNames=new Map([['kangheesung_','KangHeeSung_'],['miaeq_q','MiaeQ_Q']]);
  const targets=[...groups].filter(([,rows])=>rows.some(r=>targetNames.has(r.player_id.toLowerCase())));
  const targetIds=new Set(targets.map(([id])=>id));
  const candidates=[...groups].filter(([id,rows])=>!targetIds.has(id)&&rows.some(r=>['squad','squad-fpp'].includes(r.game_mode)))
    .sort(([a],[b])=>digest(CALIBRATION_SEED+a).localeCompare(digest(CALIBRATION_SEED+b))).slice(0,400);
  const subjects:Subject[]=[...targets,...candidates].map(([account,rows])=>({account,name:rows[0].player_id,
    target:targetNames.get(rows.find(r=>targetNames.has(r.player_id.toLowerCase()))?.player_id.toLowerCase()??''),matches:[],results:[]}));
  const errorCounts:Record<string,number>={};const error=(reason:string)=>{errorCounts[reason]=(errorCounts[reason]??0)+1;};
  for(let i=0;i<subjects.length;i++){
    const s=subjects[i];
    const file=path.join(out,`history-${calibrationAccountKey(s.account)}.json`);
    if(fs.existsSync(file)){s.matches=JSON.parse(fs.readFileSync(file,'utf8'));continue;}
    if(offline){s.historyError='offline_history_missing';error(s.historyError);continue;}
    const {data,error:e}=await db!.from('pubg_player_matches').select('match_id,player_id,account_id,platform,played_at,game_mode,match_type')
      .eq('platform','steam').eq('account_id',s.account).in('game_mode',modes).in('match_type',['official','competitive'])
      .lte('played_at',pool.rows[0].played_at).order('played_at',{ascending:false}).order('match_id',{ascending:true}).limit(10);
    if(e){s.historyError=e.code;error('history_query_'+e.code);continue;}
    s.matches=data??[];write(file,s.matches);
    if(i%50===0)console.log(JSON.stringify({stage:'history',done:i,total:subjects.length}));
  }
  const jobs=new Map<string,Array<{subject:Subject;row:MatchRow}>>();
  for(const subject of subjects)for(const row of subject.matches){
    if(!jobs.has(row.match_id))jobs.set(row.match_id,[]);jobs.get(row.match_id)!.push({subject,row});
  }
  write(path.join(out,'subjects-private.json'),subjects.map(s=>({account:s.account,name:s.name,target:s.target,matches:s.matches,historyError:s.historyError})));
  const entries=[...jobs];let cursor=0,done=0,downloaded=0,localSources=0,sourceMissing=0,sourceInvalid=0,recomputed=0,decodedBytes=0;
  async function worker(){
    while(cursor<entries.length){
      const [id,owners]=entries[cursor++];
      try{
        let text:string|null=null;
        const own=path.join(out,'sources',id+'.json.gz');
        const reuse=options['--reuse-source-dir']?path.join(options['--reuse-source-dir'],id+'.json'):'';
        if(fs.existsSync(own)){text=gunzipSync(fs.readFileSync(own)).toString('utf8');localSources++;}
        else if(reuse&&fs.existsSync(reuse)){text=fs.readFileSync(reuse,'utf8');localSources++;}
        else if(!offline){
          text=await downloadFromR2(buildSharedTelemetrySourceKey(id,'steam'));
          if(text){downloaded++;decodedBytes+=Buffer.byteLength(text);fs.writeFileSync(own,gzipSync(text),{mode:0o600});}
        }
        if(!text){sourceMissing++;continue;}
        const source=parseSharedTelemetrySource(JSON.parse(text),id,'steam');
        if(!source){sourceInvalid++;error('invalid_source_contract');continue;}
        if(!isAiSummaryEligibleMatch(source.matchData.data.attributes)){error('source_population_excluded');continue;}
        const participants=source.matchData.included.filter((x:any)=>x.type==='participant');
        const rosters=source.matchData.included.filter((x:any)=>x.type==='roster');
        for(const {subject,row} of owners){
          const analysisFile=path.join(out,'analyses',`${id}.${calibrationAccountKey(subject.account)}.json.gz`);
          if(fs.existsSync(analysisFile)){
            const cached=JSON.parse(gunzipSync(fs.readFileSync(analysisFile)).toString('utf8'));
            if(cached.checksum===source.checksum&&cached.account===subject.account&&cached.result?.calculationVersion===ANALYSIS_CALCULATION_VERSION&&cached.result?.v===RESULT_VERSION&&cached.result?.stats?.playerId===subject.account&&cached.result?.matchId===id){subject.results.push(cached.result);continue;}
          }
          const me=participants.find((p:any)=>p.attributes.stats.playerId===subject.account);
          const roster=me&&rosters.find((r:any)=>r.relationships.participants.data.some((p:any)=>p.id===me.id));
          if(!me||!roster){error('source_account_missing');continue;}
          const members=participants.filter((p:any)=>roster.relationships.participants.data.some((x:any)=>x.id===p.id));
          const engine=new AnalysisEngine(me.attributes.stats.name,subject.account,new Set<string>(members.map((p:any)=>p.attributes.stats.name.toLowerCase())),new Set<string>(members.map((p:any)=>p.attributes.stats.playerId)),new Set(),new Set(),roster.id,'lite');
          const result=engine.run(structuredClone(source.events),{id,...source.matchData.data.attributes},rosters,participants,me.attributes.stats,members.map((p:any)=>p.attributes.stats),{});
          if(Reflect.get(result.stats,'playerId')!==subject.account||result.matchId!==row.match_id)throw new Error('analysis_identity_mismatch');
          const compact={...result,platform:'steam',player_id:row.player_id,timeline:result.timeline?.filter((e:any)=>['KILL','KNOCK','DOWNED','TEAM_KNOCK'].includes(e.type)).map((e:any)=>({type:e.type,weapon:e.weapon})),tacticalTimeline:[],mapData:undefined};
          subject.results.push(compact);recomputed++;
          fs.writeFileSync(analysisFile,gzipSync(JSON.stringify({checksum:source.checksum,account:subject.account,result:compact})),{mode:0o600});
        }
      }catch(e){error(e instanceof Error&&e.message==='analysis_identity_mismatch'?e.message:'source_or_analysis_error');}
      finally{done++;if(done%25===0)console.log(JSON.stringify({stage:'analysis',done,total:entries.length,recomputed,localSources,downloaded,sourceMissing,sourceInvalid,decodedMB:Math.round(decodedBytes/1e6)}));}
    }
  }
  await Promise.all([worker(),worker()]);
  let canonicalUsed=0;
  for(let index=0;index<subjects.length;index++){
    const s=subjects[index],known=new Set(s.results.map(m=>m.matchId));
    const missing=s.matches.filter(r=>!known.has(r.match_id));
    if(!missing.length)continue;
    const cachedFile=path.join(out,`canonical-${calibrationAccountKey(s.account)}.json.gz`);
    let rows:any[]=[];
    if(fs.existsSync(cachedFile))rows=JSON.parse(gunzipSync(fs.readFileSync(cachedFile)).toString('utf8'));
    else{
      if(offline){error('offline_canonical_missing');continue;}
      const {data,error:e}=await db!.from('processed_match_telemetry').select('match_id,player_id,platform,data').eq('platform','steam')
        .eq('player_id',s.name).in('match_id',missing.map(r=>r.match_id));
      if(e){error('canonical_query_'+e.code);continue;}rows=data??[];
      fs.writeFileSync(cachedFile,gzipSync(JSON.stringify(rows)),{mode:0o600});
    }
    for(const row of rows){
      const result=getValidFullResultForMatch(row,{matchId:row.match_id,playerId:s.name,platform:'steam',minResultVersion:RESULT_VERSION,
        requireCurrentCalculation:true,requireExactResultVersion:true,requirePopulationEvidence:true});
      if(result&&(result.stats as any)?.playerId===s.account&&!known.has(row.match_id)){
        s.results.push(result);known.add(row.match_id);canonicalUsed++;
      }
    }
    if(index%50===0)console.log(JSON.stringify({stage:'canonical',done:index,total:subjects.length,canonicalUsed}));
  }
  const profiles:CalibrationProfile[]=[];const rejectionCounts:Record<string,number>={};const targetsReport:any[]=[];
  for(const s of subjects){
    const {profile,reason}=buildCalibrationProfile({accountKey:s.account,target:s.target,expectedMatchIds:s.matches.map(r=>r.match_id),matches:s.results},CALIBRATION_SEED);
    if(profile)profiles.push(profile);else rejectionCounts[reason??'unknown']=(rejectionCounts[reason??'unknown']??0)+1;
    if(s.target)targetsReport.push({target:s.target,expected:s.matches.length,available:s.results.length,status:reason??'complete',cohort:profile?.cohort});
  }
  const matches=subjects.flatMap(s=>s.results.map(m=>({...m,accountKey:s.account})));
  const trainingMatches=subjects.filter(s=>calibrationPartition(s.account,CALIBRATION_SEED,Boolean(s.target))==='train').flatMap(s=>s.results.map(m=>({...m,accountKey:s.account})));
  const holdoutMatches=subjects.filter(s=>calibrationPartition(s.account,CALIBRATION_SEED,Boolean(s.target))==='holdout').flatMap(s=>s.results.map(m=>({...m,accountKey:s.account})));
  write(path.join(out,'inputs-private.json'),subjects);
  const candidate=fitReferenceCandidate(profiles,CALIBRATION_SEED);
  const report={schemaVersion:1,offline,generatedAt:new Date().toISOString(),poolChecksum:digest(sourcePool),seed:CALIBRATION_SEED,
    frame:{rows:pool.rows.length,capped:pool.rows.length===20000,accounts:groups.size,squadCandidates:[...groups.values()].filter(rs=>rs.some(r=>['squad','squad-fpp'].includes(r.game_mode))).length,privateExcluded},
    selectedAccounts:subjects.length,requestedPlayerMatches:subjects.reduce((n,s)=>n+s.matches.length,0),uniqueMatches:jobs.size,
    analysedPlayerMatches:matches.length,recomputed,canonicalUsed,localSources,downloaded,sourceMissing,sourceInvalid,decodedBytes,
    completeProfiles:profiles.length,rejectionCounts,errorCounts,targets:targetsReport,
    benchmarkCoverage:buildBenchmarkCoverage(matches),benchmarkCandidate:buildBenchmarkCoverage(trainingMatches),benchmarkHoldout:buildBenchmarkCoverage(holdoutMatches),candidate,
    targetMovements:candidate.cohorts.flatMap(c=>c.movements.filter(m=>m.partition==='target')),
    activationAllowed:false,limitations:['capped BGMS stored/search frame','source-retention bias','complete-window exclusion bias','coverage guards do not prove role accuracy','no production writes or activation'],
  };
  write(path.join(out,'profiles-private.json'),profiles);
  write(path.join(out,'report.json'),report);
  write(path.join(out,'candidate.json'),candidate);
  console.log(JSON.stringify({stage:'complete',selectedAccounts:subjects.length,analysedPlayerMatches:matches.length,completeProfiles:profiles.length,rejectionCounts,cohorts:candidate.cohorts.map(c=>({cohort:c.cohort,train:c.trainAccounts,holdout:c.holdoutAccounts,status:c.status})),output:path.join(out,'report.json')}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runCalibration(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:'calibration_failed');process.exitCode=1;});
}
