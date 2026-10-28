import { createHash } from 'node:crypto';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION, POPULATION_EVIDENCE_VERSION } from './constants';
import { selectRecentMatches, selectBestMatches } from './recentMatchSelection';
import { aggregateMatches, isCompetitiveMatch } from './summaryAggregate';
import { extractRoleMetrics, calculateRoleRawScores, classifyRole } from './roleClassifier';
import { ROLE_REFERENCE_PERCENTILES, ROLE_REFERENCE_QUANTILES, type RoleMetricKey, type RoleReference, type RoleScoreKey } from './roleReference';
import { firstReplyLatencyMs, firstReplyFailureRate } from './firstReply';
import { isAiSummaryEligibleMatch } from './matchEligibility';
import { isCanonicalBenchmarkTier, getBenchmarkTierFamily } from './benchmarkLookup';
import { MIN_COMPARISON_SAMPLE_COUNT } from './benchmarkAdapter';

export const CALIBRATION_SEED = 'bgms-coaching-reference-2026-10-28';
const MIN_TRAIN_ACCOUNTS = 50;
const MIN_HOLDOUT_ACCOUNTS = 20;
const BOOTSTRAP_RUNS = 100;
const metricKeys = Object.keys(ROLE_REFERENCE_QUANTILES) as RoleMetricKey[];
export type CalibrationInput = { accountKey: string; target?: string; expectedMatchIds: string[]; matches: any[] };
export type CalibrationProfile = {
  accountKey: string; target?: string; cohort: string; partition: 'train' | 'holdout' | 'target';
  selectedMatchIds: string[]; stats: any; tier: string;
};
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const current = (m: any) => m?.v === RESULT_VERSION && m?.calculationVersion === ANALYSIS_CALCULATION_VERSION
  && m?.populationEvidenceVersion === POPULATION_EVIDENCE_VERSION && isAiSummaryEligibleMatch(m) && finite(m?.benchmark?.score) && m.benchmark.score <= 100;
const hash = (value: string) => createHash('sha256').update(value).digest();
export const calibrationAccountKey = (id: string) => hash(id).toString('hex').slice(0, 16);
export function calibrationPartition(accountKey: string, seed: string, target = false): CalibrationProfile['partition'] {
  return target ? 'target' : hash(`${seed}|${accountKey}`).readUInt32BE(0) % 100 < 80 ? 'train' : 'holdout';
}

export function buildCalibrationProfile(input: CalibrationInput, seed: string): { profile?: CalibrationProfile; reason?: string } {
  const expected = [...new Set(input.expectedMatchIds)];
  const wanted = new Set(expected);
  const known = input.matches.filter(m => wanted.has(m?.matchId) && current(m) && m.stats?.playerId === input.accountKey);
  if (!expected.length || expected.length > 10 || expected.some(id => !known.some(m => m.matchId === id))) return { reason: 'incomplete_window' };
  const latest = selectRecentMatches(known.map((m, sourceIndex) => ({
    id: m.matchId, createdAt: m.createdAt, gameMode: m.gameMode, matchType: m.matchType,
    mapName: m.mapName ?? null, sourceIndex, value: m,
  }))).selected;
  const best = selectBestMatches(latest).map(m => m.value);
  if (best.length < 3) return { reason: 'fewer_than_three_matches' };
  const cohorts = new Set(best.map(m => `steam|${String(m.gameMode).trim().toLowerCase()}|${isCompetitiveMatch(m) ? 'competitive' : 'official'}`));
  if (cohorts.size !== 1) return { reason: 'mixed_cohort' };
  const cohort = [...cohorts][0];
  if (!/^steam\|(?:duo|squad)(?:-fpp)?\|(?:official|competitive)$/.test(cohort)) return { reason: 'outside_squad_scope' };
  const stats = aggregateMatches(best);
  return { profile: {
    accountKey: input.accountKey, ...(input.target ? { target: input.target } : {}), cohort,
    partition: calibrationPartition(input.accountKey, seed, Boolean(input.target)),
    selectedMatchIds: best.map(m => m.matchId), tier: best[0].benchmark.tier ?? 'B',
    stats: { ...stats, avgReactionLatency: stats.avgMeasuredReactionLatency, modeDistribution: { main: cohort.split('|')[1].includes('duo') ? 'duo' : 'squad' } },
  } };
}

function quantile(sorted: number[], p: number): number {
  const index = (sorted.length - 1) * p;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}
export function quantiles(values: number[]): number[] | null {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  return sorted.length ? ROLE_REFERENCE_PERCENTILES.map(p => Number(quantile(sorted,p/100).toFixed(8))) : null;
}

export function buildBenchmarkCoverage(matches: any[]) {
  const buckets = new Map<string, Array<{ account: string; values: Record<string, number | null> }>>();
  const seen = new Set<string>();
  for (const m of matches) {
    if (!current(m) || m.isValidBenchmark === false || m.stats?.playerId !== m.accountKey || !isCanonicalBenchmarkTier(m.benchmark.tier)) continue;
    const identity = `${m.accountKey}|${m.matchId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const mode = String(m.gameMode).trim().toLowerCase();
    if (!['duo','duo-fpp','squad','squad-fpp'].includes(mode)) continue;
    const key = `steam|${mode}|${isCompetitiveMatch(m) ? 'competitive' : 'official'}|${m.benchmark.tier}`;
    const reply = firstReplyLatencyMs(m);
    const values = { avgInitiativeRate: finite(m.initiative_rate) && m.initiative_rate <= 100 ? m.initiative_rate : null,
      avgFirstReplyLatency: reply === null ? null : reply / 1000, avgCounterFailureRate: firstReplyFailureRate(m) };
    const family=getBenchmarkTierFamily(m.benchmark.tier);
    const familyKey=key.slice(0,key.lastIndexOf('|')+1)+'family:'+m.benchmark.tier.replace(/[+-]$/,'');
    for(const bucketKey of [key,...(family.length?[familyKey]:[])]){
      if(!buckets.has(bucketKey))buckets.set(bucketKey,[]);
      buckets.get(bucketKey)!.push({account:m.accountKey,values});
    }
  }
  return [...buckets].sort(([a],[b])=>a.localeCompare(b)).map(([cohort, rows])=>({cohort, scope:cohort.includes('|family:')?'tier_family':'exact', playerMatches:rows.length,
    accounts:new Set(rows.map(r=>r.account)).size,
    metrics:Object.fromEntries(['avgInitiativeRate','avgFirstReplyLatency','avgCounterFailureRate'].map(metric=>{
      const observed=rows.filter(r=>r.values[metric]!==null);
      const concentration=new Map<string,number>();for(const r of observed)concentration.set(r.account,(concentration.get(r.account)??0)+1);
      return [metric,{count:observed.length,accounts:concentration.size,
        mean:observed.length ? Number((observed.reduce((s,r)=>s+r.values[metric]!,0)/observed.length).toFixed(8)):null,
        maxAccountShare:observed.length ? Math.max(...concentration.values())/observed.length:null,
        comparisonEligible:observed.length>=MIN_COMPARISON_SAMPLE_COUNT}];
    })),
  }));
}

/** 개인-경기 평균의 계정 cluster bootstrap. 같은 계정의 여러 경기는 함께 재표집한다. */
export function buildReplyPrecision(matches: any[], seed: string) {
  const groups=new Map<string,{scope:string;values:Map<string,number[]>;matches:Set<string>}>();
  const seen=new Set<string>();
  for(const m of matches){
    const value=firstReplyLatencyMs(m),identity=`${m.accountKey}|${m.matchId}`;
    if(value===null||seen.has(identity))continue;
    const cells=buildBenchmarkCoverage([m]);if(!cells.length)continue;seen.add(identity);
    for(const cell of cells){
      if(!groups.has(cell.cohort))groups.set(cell.cohort,{scope:cell.scope,values:new Map(),matches:new Set()});
      const group=groups.get(cell.cohort)!;group.matches.add(m.matchId);
      if(!group.values.has(m.accountKey))group.values.set(m.accountKey,[]);
      group.values.get(m.accountKey)!.push(value/1000);
    }
  }
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([cohort,group])=>{
    const accounts=[...group.values.values()].map(values=>({n:values.length,sum:values.reduce((s,v)=>s+v,0)}));
    const count=accounts.reduce((s,a)=>s+a.n,0),mean=accounts.reduce((s,a)=>s+a.sum,0)/count;
    let state=hash(`${seed}|${cohort}`).readUInt32BE(0)||1;
    const means=Array.from({length:1000},()=>{
      let n=0,sum=0;for(let i=0;i<accounts.length;i++){
        state^=state<<13;state^=state>>>17;state^=state<<5;
        const a=accounts[Math.floor((state>>>0)/4294967296*accounts.length)];n+=a.n;sum+=a.sum;
      }return sum/n;
    }).sort((a,b)=>a-b);
    const lower95=quantile(means,.025),upper95=quantile(means,.975),halfWidth=(upper95-lower95)/2;
    return {cohort,scope:group.scope,count,accounts:accounts.length,uniqueMatches:group.matches.size,mean,lower95,upper95,halfWidth,
      precisionEligible:count>=MIN_COMPARISON_SAMPLE_COUNT&&accounts.length>=20&&halfWidth<=.15};
  });
}

function referenceFor(train: CalibrationProfile[], holdout: CalibrationProfile[]) {
  const reference: RoleReference = {metrics:{},roles:{}};
  const trainingQuantiles: RoleReference = {metrics:{},roles:{}};
  const coverage: Record<string,{train:number;holdout:number;eligible:boolean}> = {};
  const trainMetrics=train.map(p=>extractRoleMetrics(p.stats)), holdoutMetrics=holdout.map(p=>extractRoleMetrics(p.stats));
  for (const key of metricKeys) {
    const values=trainMetrics.map(m=>m[key]).filter((v):v is number=>v!==null);
    const held=holdoutMetrics.filter(m=>m[key]!==null).length;
    const eligible=values.length>=MIN_TRAIN_ACCOUNTS && held>=MIN_HOLDOUT_ACCOUNTS;
    coverage[key]={train:values.length,holdout:held,eligible};
    const qs=quantiles(values);
    if(qs)trainingQuantiles.metrics[key]=qs;
    if(eligible)reference.metrics[key]=qs!;
  }
  const diagnosticTrain=train.map(p=>calculateRoleRawScores(p.stats,trainingQuantiles).rawScores);
  const diagnosticHoldout=holdout.map(p=>calculateRoleRawScores(p.stats,trainingQuantiles).rawScores);
  const rawTrain=train.map(p=>calculateRoleRawScores(p.stats,reference).rawScores);
  const rawHoldout=holdout.map(p=>calculateRoleRawScores(p.stats,reference).rawScores);
  const roleKeys=rawTrain.length ? Object.keys(rawTrain[0]) as RoleScoreKey[] : [];
  const roleCoverage: typeof coverage={};
  for(const role of roleKeys){
    const values=rawTrain.map(m=>m[role]).filter((v):v is number=>v!==null);
    const held=rawHoldout.filter(m=>m[role]!==null).length;
    const eligible=values.length>=MIN_TRAIN_ACCOUNTS && held>=MIN_HOLDOUT_ACCOUNTS;
    const diagnosticValues=diagnosticTrain.map(m=>m[role]).filter((v):v is number=>v!==null);
    const diagnosticQs=quantiles(diagnosticValues);if(diagnosticQs)trainingQuantiles.roles[role]=diagnosticQs;
    roleCoverage[role]={train:diagnosticValues.length,holdout:diagnosticHoldout.filter(m=>m[role]!==null).length,eligible};
    if(eligible)reference.roles[role]=quantiles(values)!;
  }
  return {reference,trainingQuantiles,coverage,roleCoverage};
}

export function bootstrapReferenceStability(train: CalibrationProfile[], held: CalibrationProfile[], reference: RoleReference, seed:string) {
  if (!Object.keys(reference.metrics).length || !held.length) return {runs:0,titleAgreement:null,metricIntervals:{}};
  let state=hash(seed).readUInt32BE(0)||1;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
  const intervals:Record<string,number[][]>={};
  const expected=held.map(p=>classifyRole(p.stats,null,p.tier,reference).title);
  let same=0, comparisons=0;const accountSame=held.map(()=>0);
  for(let run=0;run<BOOTSTRAP_RUNS;run++){
    const sample=Array.from({length:train.length},()=>train[Math.floor(random()*train.length)]);
    const ref:RoleReference={metrics:{},roles:{}};
    const metrics=sample.map(p=>extractRoleMetrics(p.stats));
    for(const key of Object.keys(reference.metrics) as RoleMetricKey[]){
      const qs=quantiles(metrics.map(m=>m[key]).filter((v):v is number=>v!==null));
      if(qs){ref.metrics[key]=qs;(intervals[key]??=[]).push(qs);}
    }
    const raw=sample.map(p=>calculateRoleRawScores(p.stats,ref).rawScores);
    for(const role of Object.keys(reference.roles) as RoleScoreKey[]){
      const qs=quantiles(raw.map(m=>m[role]).filter((v):v is number=>v!==null));if(qs)ref.roles[role]=qs;
    }
    held.forEach((p,i)=>{comparisons++;if(classifyRole(p.stats,null,p.tier,ref).title===expected[i]){same++;accountSame[i]++;}});
  }
  return {runs:BOOTSTRAP_RUNS,titleAgreement:comparisons?same/comparisons:null,
    accountAgreement:held.map((p,i)=>({account:calibrationAccountKey(p.accountKey),agreement:accountSame[i]/BOOTSTRAP_RUNS})),
    metricIntervals:Object.fromEntries(Object.entries(intervals).map(([key,rows])=>[key,{
      lower95:ROLE_REFERENCE_PERCENTILES.map((_,i)=>quantile(rows.map(r=>r[i]).sort((a,b)=>a-b),.025)),
      upper95:ROLE_REFERENCE_PERCENTILES.map((_,i)=>quantile(rows.map(r=>r[i]).sort((a,b)=>a-b),.975)),
    }]))};
}

export function fitReferenceCandidate(profiles: CalibrationProfile[], seed:string) {
  if(new Set(profiles.map(p=>p.accountKey)).size!==profiles.length)throw new Error('duplicate account profiles');
  const cohorts=[...new Set(profiles.map(p=>p.cohort))].sort().map(cohort=>{
    const group=profiles.filter(p=>p.cohort===cohort),train=group.filter(p=>p.partition==='train'),held=group.filter(p=>p.partition==='holdout');
    const fit=referenceFor(train,held);
    const stability=bootstrapReferenceStability(train,held,fit.reference,`${seed}|${cohort}`);
    const distribution:Record<string,Record<string,number>>={before:{},candidate:{}};
    const movements=group.filter(p=>p.partition!=='train').map(p=>{
      const before=classifyRole({...p.stats,avgReactionLatency:'측정 불가'},null,p.tier);
      const after=classifyRole(p.stats,null,p.tier,fit.reference);
      if(p.partition==='holdout'){
        distribution.before[before.primaryRole]=(distribution.before[before.primaryRole]??0)+1;
        distribution.candidate[after.primaryRole]=(distribution.candidate[after.primaryRole]??0)+1;
      }
      return {account:calibrationAccountKey(p.accountKey),...(p.target?{target:p.target}:{}),partition:p.partition,
        matches:p.selectedMatchIds.length,before:before.title,candidate:after.title,beforeRole:before.primaryRole,candidateRole:after.primaryRole,
        qualifiedReply:p.stats.avgMeasuredReactionLatency,initiative:p.stats.userInitiativeRate};
    });
    return {cohort,trainAccounts:train.length,holdoutAccounts:held.length,targetAccounts:group.filter(p=>p.partition==='target').length,
      status:Object.keys(fit.reference.roles).length?'candidate_review_required':'insufficient_samples',...fit,stability,distribution,movements};
  });
  return {schemaVersion:1,calculationVersion:ANALYSIS_CALCULATION_VERSION,resultVersion:RESULT_VERSION,
    selection:'recent-valid-10-v1/best5',seed,minTrainAccounts:MIN_TRAIN_ACCOUNTS,minHoldoutAccounts:MIN_HOLDOUT_ACCOUNTS,
    activationAllowed:false,population:'BGMS stored/search sample; not all PUBG players',cohorts};
}
