/** Offline only: no API requests, database writes, cache writes or model calls. */
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { AnalysisEngine } from '../lib/pubg-analysis/AnalysisEngine';
import { filterTelemetryEvents, sampleReplayPositions } from '../lib/pubg-analysis/telemetryContract';
import { createTelemetryAnalyzeCacheEnvelope, parseTelemetryAnalyzeCacheEnvelope } from '../lib/pubg-analysis/telemetryCacheKey';
import { hasMatchingTelemetryDefinition } from '../lib/pubg-analysis/telemetrySource';
import { ANALYSIS_CALCULATION_VERSION, TELEMETRY_VERSION } from '../lib/pubg-analysis/constants';
import { SquadFocusFireCollector } from '../lib/pubg-analysis/squadFocusFire';
import { deriveSquadRecoveryStatsFromTimeline } from '../lib/pubg-analysis/squadRecoveryStats';
import { normalizeName } from '../lib/pubg-analysis/utils';
import { parseTelemetryPlatform } from '../lib/pubg-analysis/telemetryIdentity';

const {values}=parseArgs({options:{match:{type:'string'},telemetry:{type:'string'},nickname:{type:'string'},platform:{type:'string',default:'steam'},output:{type:'string'},'all-team':{type:'boolean',default:false}}});
if(!values.match||!values.telemetry||!values.nickname) throw new Error('Usage: --match match.json --telemetry telemetry.json --nickname NAME [--platform steam] [--all-team] [--output report.json]');
const match=JSON.parse(await readFile(values.match,'utf8'));
const raw=JSON.parse(await readFile(values.telemetry,'utf8'));
const platform=parseTelemetryPlatform(values.platform);
if(!hasMatchingTelemetryDefinition(raw,match.data?.id,platform)) throw new Error('Raw match identity mismatch');
const participants=match.included.filter((p:any)=>p.type==='participant');
const rosters=match.included.filter((r:any)=>r.type==='roster');
const requester=participants.find((p:any)=>normalizeName(p.attributes?.stats?.name)===normalizeName(values.nickname!));
const roster=requester && rosters.find((r:any)=>r.relationships?.participants?.data?.some((p:any)=>p.id===requester.id));
if(!roster) throw new Error('Requested player has no canonical roster');
const members=participants.filter((p:any)=>roster.relationships.participants.data.some((ref:any)=>ref.id===p.id));
const teamIds=new Set<string>(members.map((p:any)=>p.attributes.stats.playerId));
const teamNames=new Set<string>(members.map((p:any)=>normalizeName(p.attributes.stats.name)));
const context={mode:'full' as const,teamAccountIds:teamIds,teamNames};
const projected=filterTelemetryEvents(raw,context);
const size=(value:unknown)=>{const body=JSON.stringify(value);return {jsonBytes:Buffer.byteLength(body),gzipBytes:gzipSync(body).length};};
const fields=['benchmark','tradeStats','isolationData','initiative_rate','initiativeSampleCount','duelStats','combatPressure','itemUseSummary','bluezoneWaste','avgCircleLuck','avgVehicleMastery','squadFocusFire','squadObservation','stats','teamImpact','weaponStats','squadWeaponStats','zoneStrategy','goldenTimeDamage','killContribution','itemUseStats','timeline','mapData'];
const results:any[]=[];
for(const member of values['all-team']?members:[requester]){
  const stats=member.attributes.stats;
  const identity={matchId:match.data.id,platform,playerId:stats.playerId,mode:'lite' as const,telemetryVersion:TELEMETRY_VERSION};
  const restored=parseTelemetryAnalyzeCacheEnvelope(JSON.parse(JSON.stringify(createTelemetryAnalyzeCacheEnvelope(identity,projected))),identity);
  if(!restored) throw new Error('Cache round trip rejected');
  const outputs:Record<string,any>={},times:Record<string,number>={};
  for(const [label,events] of Object.entries({raw,projected,restored:filterTelemetryEvents(restored,context)})){
    const engine=new AnalysisEngine(stats.name,stats.playerId,teamNames,teamIds,new Set(),new Set(),roster.id);
    const started=performance.now();
    outputs[label]=engine.run(events as any[],{...match.data.attributes,id:match.data.id},rosters,participants,stats,members.map((p:any)=>p.attributes.stats),{});
    times[label]=Math.round((performance.now()-started)*100)/100;
  }
  const differences=fields.filter(key=>JSON.stringify(outputs.raw[key])!==JSON.stringify(outputs.projected[key])||JSON.stringify(outputs.projected[key])!==JSON.stringify(outputs.restored[key]));
  const result=outputs.projected;
  const rawRevives=raw.filter((event:any)=>event._T==='LogPlayerRevive' && teamIds.has(event.victim?.accountId) && teamIds.has(event.reviver?.accountId)).length;
  const recovery=deriveSquadRecoveryStatsFromTimeline(result.timeline,match.data.attributes.mapName);
  const windows=[3000,5000,8000].map(windowMs=>{
    const collector=new SquadFocusFireCollector(teamIds,match.data.attributes.gameMode,windowMs);
    for(const event of raw) collector.observe(event,Date.parse(event._D));
    return collector.result();
  });
  results.push({squadObservation:result.squadObservation,nickname:stats.name,differences,engineMs:times,score:result.benchmark.score,isolation:result.isolationData.isolationIndex,personalThrows:result.itemUseStats?.throwCount ?? result.combatPressure.utilityStats.throwCount,teamRevives:{raw:rawRevives,timeline:recovery.squadRevives},teamSmokeRescues:recovery.squadSmokeRescues,focusFire:windows,liteMapSize:size(sampleReplayPositions(result.mapData.events,'lite')),fullMapSize:size(result.mapData.events)});
}
if(values['all-team'] && results.some(row=>JSON.stringify(row.squadObservation)!==JSON.stringify(results[0].squadObservation))) throw new Error('Requester-dependent team observations');
const report={matchId:match.data.id,platform,calculationVersion:ANALYSIS_CALCULATION_VERSION,events:{raw:raw.length,projected:projected.length},size:{raw:size(raw),fullProjection:size(projected)},results,limitations:['Only these local matches were replayed; no live collection or provider call.', 'Agreement does not prove a heuristic is calibrated or establishes intent.', 'Legacy processed results and benchmarks are unchanged; rollout requires a bounded version migration.']};
if(values.output) await writeFile(values.output,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(results.some(row=>row.differences.length||row.teamRevives.raw!==row.teamRevives.timeline)) process.exitCode=1;
