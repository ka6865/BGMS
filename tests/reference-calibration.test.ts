import {describe,expect,it,vi}from'vitest';
import {buildCalibrationProfile,calibrationAccountKey,calibrationPartition,fitReferenceCandidate,buildBenchmarkCoverage,quantiles}from'../lib/pubg-analysis/referenceCalibration';
const match=(id:string,score=50,extra:Record<string,unknown>={})=>({matchId:id,createdAt:'2026-10-27T12:00:00Z',gameMode:'squad',matchType:'official',v:73,calculationVersion:5,populationEvidenceVersion:1,benchmark:{score,tier:'B'},stats:{damageDealt:100,playerId:"a"},...extra});
describe('offline coaching reference calibration',()=>{
 it('rejects unknown-score holes rather than replacing missing latest matches',()=>{
  const r=buildCalibrationProfile({accountKey:'a',expectedMatchIds:['1','2','3'],matches:[match('1'),match('2')]},'seed');
  expect(r.reason).toBe('incomplete_window');
 });
 it('selects latest ten then best five, with dedup and qualified-only reply',()=>{
  const ms=Array.from({length:10},(_,i)=>match(String(i),i*10));
  const r=buildCalibrationProfile({accountKey:'a',expectedMatchIds:ms.map(m=>m.matchId),matches:[...ms,ms[0]]},'seed');
  expect(r.profile?.selectedMatchIds).toEqual(['9','8','7','6','5']);
  expect(r.profile?.stats.avgReactionLatency).toBe('측정 불가');
 });
 it('excludes older arithmetic and mixed cohorts from fitting',()=>{
  expect(buildCalibrationProfile({accountKey:'a',expectedMatchIds:['1','2','3'],matches:[match('1'),match('2'),match('3',30,{calculationVersion:4})]},'seed').reason).toBe('incomplete_window');
  expect(buildCalibrationProfile({accountKey:'a',expectedMatchIds:['1','2','3'],matches:[match('1'),match('2'),match('3',30,{matchType:'competitive'})]},'seed').reason).toBe('mixed_cohort');
 });
 it('keeps account partitions stable and isolates named targets',()=>{
  expect(calibrationPartition('a','seed')).toBe(calibrationPartition('a','seed'));
  expect(calibrationPartition('a','seed',true)).toBe('target');
 });
 it('interpolates empirical quantiles without dropping observed zero',()=>{
  expect(quantiles([0,10,20])?.[5]).toBe(10);
  expect(quantiles([])).toBeNull();
 });
 it('uses per-metric n>=30 and never copies raw reply into qualified benchmarks',()=>{
  const ms=Array.from({length:30},(_,i)=>({...match(String(i)),accountKey:'a',tradeStats:{reactionLatencyMs:3},initiative_rate:50}));
  const rows=buildBenchmarkCoverage(ms);
  expect(rows[0].metrics.avgFirstReplyLatency).toMatchObject({count:0,mean:null,comparisonEligible:false});
  expect(rows[0].metrics.avgInitiativeRate).toMatchObject({count:30,mean:50,comparisonEligible:true,accounts:1});
  expect(buildBenchmarkCoverage(ms.slice(1))[0].metrics.avgInitiativeRate.comparisonEligible).toBe(false);
 });
 it('does not train on target accounts or promote an undersampled cohort',()=>{
  const r=buildCalibrationProfile({accountKey:'a',target:'KangHeeSung_',expectedMatchIds:['1','2','3'],matches:[match('1'),match('2'),match('3')]},'seed');
  const fitted=fitReferenceCandidate([r.profile!],'seed');
  expect(fitted.cohorts[0].trainAccounts).toBe(0);
  expect(fitted.cohorts[0].reference.metrics).toEqual({});
  expect(fitted.activationAllowed).toBe(false);
 });
 it('rejects duplicate account profiles before fitting',()=>{
  const r=buildCalibrationProfile({accountKey:'a',expectedMatchIds:['1','2','3'],matches:[match('1'),match('2'),match('3')]},'seed');
  expect(()=>fitReferenceCandidate([r.profile!,r.profile!],'seed')).toThrow(/duplicate/);
 });
 it('imports the calibration CLI without network or credential side effects',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  try{await import('../scripts/calibrate_coaching_reference');expect(fetch).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
 });
 it('requires both training50 and holdout20 before fitting a candidate metric',()=>{
  const make=(count:number,partition:'train'|'holdout')=>Array.from({length:count},(_,i)=>({accountKey:`${partition}-${i}`,cohort:'steam|squad|official',partition,selectedMatchIds:['1','2','3'],tier:'B',stats:{mLen:3,userInitiativeRate:80,totalInitiativeAttempts:10,avgReactionLatency:'0.90s',avgMeasuredReactionLatency:'0.90s',modeDistribution:{main:'squad'}}}));
  expect(fitReferenceCandidate([...make(49,'train'),...make(20,'holdout')],'seed').cohorts[0].reference.metrics).toEqual({});
  expect(fitReferenceCandidate([...make(50,'train'),...make(19,'holdout')],'seed').cohorts[0].reference.metrics).toEqual({});
  const fit=fitReferenceCandidate([...make(50,'train'),...make(20,'holdout')],'seed');
  expect(fit.cohorts[0].reference.metrics.reactionSec).toHaveLength(11);
  expect(fit.cohorts[0].reference.roles.pointMan).toHaveLength(11);
  expect(fit.cohorts[0].stability).toMatchObject({runs:100,titleAgreement:1});
  expect(fit.activationAllowed).toBe(false);
 });

 it('rejects non-human-BR provenance even with a current calculation marker',()=>{
  const bad=match('3',50,{matchType:'custom'});
  expect(buildCalibrationProfile({accountKey:'a',expectedMatchIds:['1','2','3'],matches:[match('1'),match('2'),bad]},'seed').reason).toBe('incomplete_window');
  expect(buildBenchmarkCoverage([{...bad,accountKey:'a',initiative_rate:100}])).toEqual([]);
 });
 it('replays a frozen local snapshot without credentials or network',async()=>{
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'bgms-calibration-'));
  const fetch=vi.fn(()=>{throw new Error('network forbidden')});vi.stubGlobal('fetch',fetch);
  try{
    const row={match_id:'00000000-0000-4000-8000-000000000001',player_id:'fixture',account_id:'account.fixture',platform:'steam',played_at:'2026-10-27T00:00:00Z',game_mode:'squad',match_type:'official'};
    writeFileSync(join(dir,'pool.json'),JSON.stringify({rows:[row],since:'2026-10-01',queriedAt:'2026-10-28'}));
    writeFileSync(join(dir,`history-${calibrationAccountKey(row.account_id)}.json`),JSON.stringify([row]));
    writeFileSync(join(dir,'private-registry.json'),'[]');
    const r2=await import('../lib/pubg-analysis/r2Service');
    const download=vi.spyOn(r2,'downloadFromR2').mockRejectedValue(new Error('network forbidden'));
    const {runCalibration}=await import('../scripts/calibrate_coaching_reference');
    await runCalibration(['--pool',join(dir,'pool.json'),'--output',dir,'--offline']);
    expect(JSON.parse(readFileSync(join(dir,'report.json'),'utf8'))).toMatchObject({activationAllowed:false,sourceMissing:1,errorCounts:{offline_canonical_missing:1}});
    expect(download).not.toHaveBeenCalled();
    download.mockRestore();
    expect(fetch).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});}
 });

 it('retains diagnostic training quantiles and actual paired-role counts while withholding sparse references',()=>{
  const make=(key:string,partition:'train'|'holdout')=>({accountKey:key,cohort:'steam|squad|official',partition,selectedMatchIds:['1','2','3'],tier:'B',stats:{mLen:3,userInitiativeRate:80,totalInitiativeAttempts:10,avgReactionLatency:'0.9s',avgMeasuredReactionLatency:'0.9s',modeDistribution:{main:'squad'}}});
  const fit=fitReferenceCandidate([make('one','train'),make('two','train'),make('three','holdout')],'seed').cohorts[0];
  expect(fit.reference.metrics).toEqual({});
  expect(fit.trainingQuantiles.metrics.reactionSec).toHaveLength(11);
  expect(fit.trainingQuantiles.roles.pointMan).toHaveLength(11);
  expect(fit.roleCoverage.pointMan).toMatchObject({train:2,holdout:1,eligible:false});
 });

 it('does not fit or benchmark another account copied into a local analysis cache',()=>{
  const copied=match('3',50,{stats:{damageDealt:100,playerId:'other'},initiative_rate:90});
  expect(buildCalibrationProfile({accountKey:'a',expectedMatchIds:['1','2','3'],matches:[match('1'),match('2'),copied]},'seed').reason).toBe('incomplete_window');
  expect(buildBenchmarkCoverage([{...copied,accountKey:'a'}])).toEqual([]);
 });

 it('evaluates named duo accounts in a separate cohort instead of dropping them from squad sampling',()=>{
  const ms=['1','2','3'].map(id=>match(id,50,{gameMode:'duo',matchType:'competitive',initiative_rate:50}));
  const r=buildCalibrationProfile({accountKey:'a',target:'KangHeeSung_',expectedMatchIds:['1','2','3'],matches:ms},'seed');
  expect(r.profile).toMatchObject({cohort:'steam|duo|competitive',partition:'target',stats:{modeDistribution:{main:'duo'}}});
  expect(buildBenchmarkCoverage(ms.map(m=>({...m,accountKey:'a'})))[0].cohort).toBe('steam|duo|competitive|B');
 });

 it('permits only same-mode/type tier-family fallback with independent metric counts',()=>{
  const ms=Array.from({length:30},(_,i)=>({...match(String(i),50,{benchmark:{score:50,tier:i<15?'B+':'B-'},initiative_rate:50}),accountKey:'a'}));
  const rows=buildBenchmarkCoverage(ms);
  expect(rows.find(r=>r.cohort==='steam|squad|official|B+')?.metrics.avgInitiativeRate.comparisonEligible).toBe(false);
  expect(rows.find(r=>r.cohort==='steam|squad|official|family:B')).toMatchObject({scope:'tier_family',metrics:{avgInitiativeRate:{count:30,comparisonEligible:true}}});
  const split=buildBenchmarkCoverage(ms.map((m,i)=>i<15?m:{...m,gameMode:'squad-fpp'}));
  expect(split.filter(r=>r.scope==='tier_family').every(r=>r.metrics.avgInitiativeRate.comparisonEligible===false)).toBe(true);
 });

});

describe('independent calibration precision',()=>{
 it('bootstraps reply time by account and keeps exact tiers separate from families',async()=>{
  const {buildReplyPrecision}=await import('../lib/pubg-analysis/referenceCalibration');
  const rows=Array.from({length:40},(_,i)=>({...match(String(i),50,{stats:{playerId:'a'+i},benchmark:{score:50,tier:i%2?'A+':'A-'}}),accountKey:'a'+i,
   duelStats:{firstReplyEvidence:{version:1,eligibleCount:1,alreadyFiringCount:0,unknownCount:0,within3sCount:1,latencySumMs:1000,noReplyCount:0}}}));
  const precision=buildReplyPrecision(rows,'fixed');
  const family=precision.find((r:any)=>r.cohort.endsWith('family:A'));
  expect(family).toMatchObject({count:40,accounts:40,mean:1,lower95:1,upper95:1,halfWidth:0,precisionEligible:true});
  expect(precision.filter((r:any)=>r.scope==='exact').every((r:any)=>r.precisionEligible===false)).toBe(true);
  expect(buildReplyPrecision(rows,'fixed')).toEqual(precision);
 });
 it('does not turn raw-only reply observations or one heavily repeated account into independent evidence',async()=>{
  const {buildReplyPrecision}=await import('../lib/pubg-analysis/referenceCalibration');
  expect(buildReplyPrecision([{...match('1'),accountKey:'a',tradeStats:{firstReplyLatencyMs:1}}],'fixed')).toEqual([]);
  const rows=Array.from({length:30},(_,i)=>({...match(String(i)),accountKey:'a',duelStats:{firstReplyEvidence:{version:1,eligibleCount:1,alreadyFiringCount:0,unknownCount:0,within3sCount:1,latencySumMs:0,noReplyCount:0}}}));
  expect(buildReplyPrecision(rows,'fixed')[0]).toMatchObject({count:30,accounts:1,mean:0,precisionEligible:false});
 });
});

it('excludes stale canonical rows outside the current frozen match window',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),zlib=await import('node:zlib');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bgms-canonical-window-'));
 const identity=await import('../lib/pubg-analysis/cacheIdentity');const validate=vi.spyOn(identity,'getValidFullResultForMatch').mockImplementation((row:any)=>row.data);
 try{
  const id='00000000-0000-4000-8000-000000000001',stale='00000000-0000-4000-8000-000000000002',account='account.fixture';
  const row={match_id:id,player_id:'fixture',account_id:account,platform:'steam',played_at:'2026-10-27T00:00:00Z',game_mode:'squad',match_type:'official'};
  fs.writeFileSync(path.join(dir,'pool.json'),JSON.stringify({rows:[row]}));fs.writeFileSync(path.join(dir,'private-registry.json'),'[]');
  fs.writeFileSync(path.join(dir,`history-${calibrationAccountKey(account)}.json`),JSON.stringify([row]));
  fs.writeFileSync(path.join(dir,`canonical-${calibrationAccountKey(account)}.json.gz`),zlib.gzipSync(JSON.stringify([id,stale].map(match_id=>({match_id,data:match(match_id,50,{stats:{playerId:account},initiative_rate:80})})))));
  const{runCalibration}=await import('../scripts/calibrate_coaching_reference');await runCalibration(['--pool',path.join(dir,'pool.json'),'--output',dir,'--offline']);
  const report=JSON.parse(fs.readFileSync(path.join(dir,'report.json'),'utf8'));
  expect(report.canonicalUsed).toBe(1);expect(report.analysedPlayerMatches).toBe(1);expect(validate).toHaveBeenCalledTimes(1);
 }finally{validate.mockRestore();fs.rmSync(dir,{recursive:true,force:true});}
});
