/** Opt-in: replays local real telemetry and calls real Gemini through production AI routes.
 * Database/auth/cache writes are isolated in memory; no operating data is changed.
 * RUN_TELEMETRY_GEMINI_REAL=true npx vitest run tests/telemetry-gemini-real.integration.test.ts
 */
import { config } from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnalysisEngine } from '@/lib/pubg-analysis/AnalysisEngine';
import { filterTelemetryEvents } from '@/lib/pubg-analysis/telemetryContract';
import { createTelemetryAnalyzeCacheEnvelope, parseTelemetryAnalyzeCacheEnvelope } from '@/lib/pubg-analysis/telemetryCacheKey';
import { hasMatchingTelemetryDefinition } from '@/lib/pubg-analysis/telemetrySource';
import { TELEMETRY_VERSION, ANALYSIS_CALCULATION_VERSION } from '@/lib/pubg-analysis/constants';
import { collectAiCoachingQualitySignals } from '@/lib/pubg-analysis/aiCoachingQuality';

const audit=vi.hoisted(()=>({rows:[] as any[],calls:[] as any[],writes:[] as any[],cases:[] as any[],source:[] as any[]}));
const db=vi.hoisted(()=>({from(table:string){
  if(!['processed_match_telemetry','global_benchmarks','benchmark_stats_by_tier','match_ai_coaching_cache','player_ai_summary_cache','squad_ai_coaching_cache'].includes(table)) throw new Error(`Unexpected DB access: ${table}`);
  const predicates:Array<(row:any)=>boolean>=[];
  let single=false;
  const result=()=>{const rows=table==='processed_match_telemetry'?audit.rows.filter(row=>predicates.every(test=>test(row))):[];return {data:single?(rows[0]??null):rows,error:null};};
  const chain:any={
    select:()=>chain,eq:(key:string,value:any)=>{predicates.push(row=>row[key]===value);return chain;},
    in:(key:string,values:any[])=>{predicates.push(row=>values.includes(row[key]));return chain;},
    order:()=>chain,limit:()=>chain,abortSignal:()=>chain,
    maybeSingle:()=>{single=true;return chain;},
    then:(resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject),
    upsert:(value:any)=>{audit.writes.push({table,value});return chain;},
  };return chain;
}}));
vi.mock('@/utils/supabase/guard',()=>({withAuthGuard:async()=>({user:{id:'local-audit'},supabaseAdmin:db})}));
vi.mock('@/utils/supabase/server',()=>({createClient:async()=>db}));
vi.mock('@/lib/pubg-analysis/aiUsageTracker',()=>({trackAiUsage:vi.fn(),trackAiFailure:vi.fn()}));
vi.mock('@google/generative-ai',async(importOriginal)=>{
  const sdk=await importOriginal<any>();
  return {...sdk,GoogleGenerativeAI:class extends sdk.GoogleGenerativeAI{
    getGenerativeModel(params:any,options:any){
      const model=super.getGenerativeModel(params,options);
      const record=(prompt:any)=>{const entry={model:params.model,system:params.systemInstruction,prompt,raw:'',usage:null as any};audit.calls.push(entry);return entry;};
      return {
        async generateContent(prompt:any,opts:any){const entry=record(prompt);const result=await model.generateContent(prompt,opts);entry.raw=result.response.text();entry.usage=result.response.usageMetadata;return result;},
        async generateContentStream(prompt:any,opts:any){
          const entry=record(prompt);const result=await model.generateContentStream(prompt,opts);
          const stream=(async function*(){for await(const chunk of result.stream){entry.raw+=chunk.text();yield chunk;}})();
          return {stream,response:result.response.then((response:any)=>{entry.usage=response.usageMetadata;return response;})};
        },
      };
    }
  }};
});
import { POST as analyze } from '@/app/api/pubg/ai-analyze/route';
import { POST as summary } from '@/app/api/pubg/ai-summary/route';
import { POST as squad } from '@/app/api/pubg/ai-squad/route';
import { getSquadAnalysisData } from '@/lib/pubg-analysis/squadAnalysis';

const enabled=process.env.RUN_TELEMETRY_GEMINI_REAL==='true';
const suite=enabled?describe:describe.skip;
const inputDir=process.env.TELEMETRY_REAL_INPUT_DIR || 'tmp/squad-focus-fire';
const outputDir=process.env.TELEMETRY_GEMINI_OUTPUT_DIR || 'tmp/telemetry-gemini-audit';
const ids=['c3fd0fe9-cdf5-4d12-8d40-d98cb30e72ab','5f7180ba-e242-4833-9124-5407c8695348'];
const request=(body:any)=>new Request('http://localhost/api/pubg/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const stable=(result:any)=>{const {processedAt,...values}=result;void processedAt;return values;};
beforeAll(async()=>{
  if(!enabled)return;
  config({path:'.env.local',quiet:true});
  if(!process.env.GOOGLE_GEMINI_API_KEY)throw new Error('Gemini API key missing');
  for(const id of ids){
    const match=JSON.parse(await readFile(`${inputDir}/${id}-match.json`,'utf8'));
    const raw=JSON.parse(await readFile(`${inputDir}/${id}-telemetry.json`,'utf8'));
    expect(hasMatchingTelemetryDefinition(raw,id,'steam')).toBe(true);
    const participants=match.included.filter((p:any)=>p.type==='participant'),rosters=match.included.filter((r:any)=>r.type==='roster');
    const me=participants.find((p:any)=>p.attributes.stats.name==='MiaeQ_Q');
    const roster=rosters.find((r:any)=>r.relationships.participants.data.some((p:any)=>p.id===me.id));
    const members=participants.filter((p:any)=>roster.relationships.participants.data.some((ref:any)=>ref.id===p.id));
    const names=new Set<string>(members.map((p:any)=>p.attributes.stats.name.toLowerCase())),accountIds=new Set<string>(members.map((p:any)=>p.attributes.stats.playerId));
    const context={mode:'full' as const,teamNames:names,teamAccountIds:accountIds};
    const projected=filterTelemetryEvents(raw,context);
    for(const member of members){
      const stats=member.attributes.stats;
      const identity={matchId:id,platform:'steam' as const,playerId:stats.playerId,mode:'lite' as const,telemetryVersion:TELEMETRY_VERSION};
      const cached=parseTelemetryAnalyzeCacheEnvelope(JSON.parse(JSON.stringify(createTelemetryAnalyzeCacheEnvelope(identity,projected))),identity)!;
      const run=(events:any[])=>new AnalysisEngine(stats.name,stats.playerId,names,accountIds,new Set(),new Set(),roster.id).run(events,{...match.data.attributes,id},rosters,participants,stats,members.map((p:any)=>p.attributes.stats),{});
      const full=run(projected);
      expect(stable(run(raw))).toEqual(stable(full));
      expect(stable(run(filterTelemetryEvents(cached,context)))).toEqual(stable(full));
      const canonical={...full,platform:'steam',player_id:stats.name.toLowerCase()};
      audit.rows.push({match_id:id,platform:'steam',player_id:stats.name.toLowerCase(),updated_at:match.data.attributes.createdAt,data:{fullResult:canonical}});
      audit.source.push({matchId:id,nickname:stats.name,rawEvents:raw.length,projectedEvents:projected.length,utility:full.combatPressure.utilityStats,trade:full.tradeStats,isolation:full.isolationData,score:full.benchmark});
    }
  }
},60000);
afterAll(async()=>{
  if(!enabled)return;
  await mkdir(outputDir,{recursive:true});
  await writeFile(`${outputDir}/real-route-report.json`,JSON.stringify({calculationVersion:ANALYSIS_CALCULATION_VERSION,source:audit.source,calls:audit.calls,cases:audit.cases,cacheWritesCaptured:audit.writes.map(row=>({table:row.table,value:row.value})),limitations:['Only local real source matches used; live DB/auth/cache persistence is mocked.','Actual production route prompt builders and response policies and real Gemini SDK are executed.','No same-version benchmark population exists in this audit; comparisons remain unavailable.']},null,2));
});
async function runCase(name:string,route:(r:Request)=>Promise<Response>,body:any){
  const first=audit.calls.length;
  const response=await route(request(body));
  const text=await response.text();
  const records=response.headers.get('content-type')?.includes('ndjson')?text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  let final=records.length?(records.find(row=>row.type==='final')?.data??records.filter(row=>row.type==='chunk').map(row=>row.data).join('')):JSON.parse(text);
  if(typeof final==='string') {try {final=JSON.parse(final);}catch{/* Report unparseable provider text. */}}
  audit.cases.push({name,status:response.status,records,final,calls:audit.calls.slice(first).map((_,offset)=>first+offset),quality:collectAiCoachingQualitySignals(JSON.stringify(final))});
  expect(audit.calls.slice(first).every(call=>!JSON.stringify(call.prompt).includes('999999'))).toBe(true);
  expect(response.status).toBe(200);
  expect(records.some(row=>row.type==='error'||(row.type==='done'&&row.valid===false))).toBe(false);
  expect(audit.calls.slice(first).some(call=>call.raw.length>0)).toBe(true);
  return final;
}
suite('actual telemetry through production AI routes and real Gemini',()=>{
  for(const nickname of ['MiaeQ_Q','KangHeeSung_','Suk-Cun'])for(const coachingStyle of ['mild','spicy']){
    it(`match ${nickname} ${coachingStyle}`,async()=>{await runCase(`match-${nickname}-${coachingStyle}`,analyze,{nickname,platform:'steam',coachingStyle,matchData:{matchId:ids[1],combatPressure:{utilityDamage:999999}}});},120000);
  }
  it('summary MiaeQ_Q produces three server-bound cards',async()=>{
    const final=await runCase('summary-MiaeQ_Q',summary,{nickname:'MiaeQ_Q',platform:'steam',matchIds:ids,summaryContractVersion:2});
    expect(final.debateIssues).toHaveLength(3);
  },120000);
  for(const coachingStyle of ['mild','spicy'])it(`squad ${coachingStyle} holds unmeasured grade`,async()=>{
    const groups=await getSquadAnalysisData('MiaeQ_Q','steam');
    const groupKey=(groups as any).groups[0]?.groupKey;
    expect(groupKey).toBeTruthy();
    const final=await runCase(`squad-${coachingStyle}`,squad,{nickname:'MiaeQ_Q',platform:'steam',groupKey,coachingStyle});
    expect(final.squadGrade).toBeNull();
  },120000);
});
