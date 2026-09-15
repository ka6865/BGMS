import { AnalysisEngine } from '@/lib/pubg-analysis/AnalysisEngine';
import { normalizeName } from '@/lib/pubg-analysis/utils';
import { hasMatchingTelemetryDefinition, containsTelemetryAccountEvidence } from '@/lib/pubg-analysis/telemetrySource';
import { evaluateMatchEligibility } from '@/lib/pubg-analysis/matchEligibility';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '@/lib/pubg-analysis/constants';
import type { ObservedBenchmark } from '@/lib/pubg-analysis/benchmarkAdapter';

export type PerformanceJob = {
  platform: 'steam' | 'kakao'; account_id: string; match_id: string; player_id: string;
  calculation_version: number; result_version: number; lease_token: string;
};
export function preparePerformanceMatch(job: PerformanceJob, match: any) {
  if (!/^account\.[A-Za-z0-9_-]+$/.test(job.account_id)) throw new Error('account_identity_invalid');
  if (job.platform !== 'steam' && job.platform !== 'kakao') throw new Error('platform_identity_invalid');
  if (!job.match_id || !job.player_id || normalizeName(job.player_id) !== job.player_id) throw new Error('job_identity_invalid');
  if (match?.data?.id !== job.match_id || !Number.isFinite(Date.parse(match.data?.attributes?.createdAt))) throw new Error('match_identity_invalid');
  const participants = (match.included || []).filter((p: any) => p.type === 'participant');
  const rosters = (match.included || []).filter((r: any) => r.type === 'roster');
  const mine = participants.filter((p: any) => p.attributes?.stats?.playerId === job.account_id);
  if (mine.length !== 1 || normalizeName(mine[0].attributes.stats.name) !== job.player_id) throw new Error('player_identity_invalid');
  const stats = mine[0].attributes.stats;
  const roster = rosters.find((r: any) => r.relationships?.participants?.data?.some((p: any) => p.id === mine[0].id));
  if (!roster) throw new Error('roster_missing');
  const members = participants.filter((p: any) => roster.relationships.participants.data.some((r: any) => r.id === p.id));
  // Keep lookup tier population identical to the detailed match route for this calculation version.
  const human = participants.filter((p: any) => !p.attributes.accountId?.startsWith('ai.')).sort((a: any,b: any) => b.attributes.stats.damageDealt-a.attributes.stats.damageDealt);
  const percentile = (human.findIndex((p: any) => p.id === mine[0].id)+1)/Math.max(1,human.length);
  return { participants, rosters, stats, roster, members, attributes: {...match.data.attributes, id: job.match_id}, tier: percentile<=0.1?'S':percentile<=0.3?'A':percentile<=0.6?'B':'C' };
}
export function calculatePerformance(job: PerformanceJob, match: any, events: any[], benchmark: ObservedBenchmark) {
  if (job.calculation_version !== ANALYSIS_CALCULATION_VERSION || job.result_version !== RESULT_VERSION) throw new Error('version_changed');
  if (!hasMatchingTelemetryDefinition(events, job.match_id, job.platform)
    || !containsTelemetryAccountEvidence(events, job.account_id)
    || !events.some(e=>e._T==='LogMatchStart') || !events.some(e=>e._T==='LogMatchEnd')) throw new Error('telemetry_identity_incomplete');
  const c = preparePerformanceMatch(job, match);
  const names = new Set<string>(c.members.map((p:any)=>normalizeName(p.attributes.stats.name)));
  const accounts = new Set<string>(c.members.map((p:any)=>p.attributes.stats.playerId));
  const eligibility = evaluateMatchEligibility({...c.attributes,stats:c.stats,telemetryEvents:events},'benchmark');
  if (!eligibility.eligible) return null;
  const result = new AnalysisEngine(c.stats.name,job.account_id,names,accounts,new Set(),new Set(),c.roster.id)
    .run(events,c.attributes,c.rosters,c.participants,c.stats,c.members.map((p:any)=>p.attributes.stats),benchmark);
  return { benchmark: result.benchmark, rankingEligible: result.isValidBenchmark === true };
}
