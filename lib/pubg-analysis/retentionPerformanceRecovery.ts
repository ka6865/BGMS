import type { SupabaseClient } from '@supabase/supabase-js';
import { buildRetainedPerformanceRow, type RetainedPerformanceRow } from '../pubg/retainedPerformance';
import { hasObservedPlayerMatchValues } from '../pubg/playerMatches';
import { preparePerformanceMatch, type PerformanceJob } from '../pubg/performanceCalculation';
import { AnalysisEngine } from './AnalysisEngine';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION, MAP_NAMES } from './constants';
import { parseSharedTelemetrySource, type SharedTelemetrySource } from './sharedTelemetrySourceContract';
import { containsTelemetryAccountEvidence, hasMatchingTelemetryDefinition } from './telemetrySource';
import { getMatchDetailRetention } from './matchRetention';
import { normalizeName } from './utils';
import { preservePerformanceRows } from '../../scripts/preserve_match_performance';

export type RetentionBasicMatch = {
  account_id: string | null; player_id: string; platform: string; match_id: string; played_at: string;
  game_mode: string; map_name: string; kills: number; damage: number; win_place: number; match_type: string;
};
type ProcessedRow = { match_id: string; platform: string; player_id: string; data?: { fullResult?: unknown } };
type StoredPerformance = Record<string, any>;
const ACCOUNT_ID = /^account\.[A-Za-z0-9_-]+$/;

export function retainedRowMatchesBasic(row: RetainedPerformanceRow, basic: RetentionBasicMatch): boolean {
  return hasObservedPlayerMatchValues(basic) && row.match_id === basic.match_id && row.platform === basic.platform
    && row.account_id === basic.account_id && row.player_id === normalizeName(basic.player_id)
    && Date.parse(row.played_at) === Date.parse(basic.played_at)
    && row.summary.stats.kills === basic.kills && row.summary.stats.winPlace === basic.win_place
    && Math.floor(row.summary.stats.damageDealt) === basic.damage;
}

/** 당시 공식 경기와 실제 이벤트 증거로 계정을 연결한다. */
export function archiveParticipantForBasic(source: SharedTelemetrySource, basic: RetentionBasicMatch): any | null {
  const attrs = source.matchData.data.attributes;
  if (!hasObservedPlayerMatchValues(basic) || Date.parse(attrs.createdAt) !== Date.parse(basic.played_at)
    || attrs.gameMode !== basic.game_mode || attrs.matchType !== basic.match_type
    || ![attrs.mapId, attrs.mapName, MAP_NAMES[attrs.mapId], MAP_NAMES[attrs.mapName]].includes(basic.map_name)) return null;
  const matching = source.matchData.included.filter((item: any) => item?.type === 'participant'
    && normalizeName(item.attributes?.stats?.name ?? '') === normalizeName(basic.player_id));
  if (matching.length !== 1) return null;
  const stats = matching[0].attributes.stats;
  if (!ACCOUNT_ID.test(stats.playerId) || (basic.account_id && basic.account_id !== stats.playerId)
    || stats.kills !== basic.kills || Math.floor(stats.damageDealt) !== basic.damage || stats.winPlace !== basic.win_place
    || !containsTelemetryAccountEvidence(source.events, stats.playerId)) return null;
  return matching[0];
}

/** 공통 원본의 이벤트 projection에는 LogMatchDefinition이 없으므로 공식 시각도 대조한다. */
function completeArchivedSource(source: SharedTelemetrySource): boolean {
  if (source.events.length > 100_000) return false;
  const starts = source.events.filter(e => e._T === 'LogMatchStart');
  const ends = source.events.filter(e => e._T === 'LogMatchEnd');
  if (starts.length !== 1 || ends.length !== 1) return false;
  const played = Date.parse(source.matchData.data.attributes.createdAt);
  const start = Date.parse(starts[0]._D), end = Date.parse(ends[0]._D);
  const duration = source.matchData.data.attributes.duration;
  const hasDefinition = source.events.some(e => e._T === 'LogMatchDefinition');
  return Number.isFinite(start) && Number.isFinite(end) && Math.abs(start - played) <= 60_000
    && end > start && typeof duration === 'number' && duration > 0 && end - start <= (duration + 300) * 1000
    && (!hasDefinition || hasMatchingTelemetryDefinition(source.events, source.matchId, source.platform));
}

export function calculateArchivedRetentionPerformance(job: PerformanceJob, source: SharedTelemetrySource): RetainedPerformanceRow {
  if (!parseSharedTelemetrySource(source, job.match_id, job.platform) || !completeArchivedSource(source)
    || source.events.length > 100_000) throw new Error('retention-recovered-source-invalid');
  const prepared = preparePerformanceMatch(job, source.matchData);
  const names = new Set<string>(prepared.members.map((p: any) => normalizeName(p.attributes.stats.name)));
  const accounts = new Set<string>(prepared.members.map((p: any) => p.attributes.stats.playerId));
  const result = new AnalysisEngine(prepared.stats.name, job.account_id, names, accounts, new Set(), new Set(), prepared.roster.id)
    .run(source.events, prepared.attributes, prepared.rosters, prepared.participants, prepared.stats,
      prepared.members.map((p: any) => p.attributes.stats), { sampleCount: 0 });
  const retained = buildRetainedPerformanceRow({ ...result, benchmark: null, isValidBenchmark: false },
    { matchId: job.match_id, platform: job.platform, playerId: job.player_id });
  if (!retained) throw new Error('retention-recovered-performance-invalid');
  return { ...retained, ranking_eligible: false };
}

export async function preserveExpiredMatchPerformance(db: SupabaseClient, input: {
  matchId: string; platform: 'steam' | 'kakao'; basics: RetentionBasicMatch[];
  processed: ProcessedRow[]; performances: StoredPerformance[]; source?: SharedTelemetrySource | null;
  maxCalculations?: number; now?: number;
}): Promise<{ linkedAccounts: number; savedSummaries: number; recoveredSummaries: number }> {
  const result = { linkedAccounts: 0, savedSummaries: 0, recoveredSummaries: 0 };
  const now = input.now ?? Date.now();
  if (!input.basics.length || input.basics.some(b => b.platform !== input.platform || b.match_id !== input.matchId
    || getMatchDetailRetention(b.played_at, now).status !== 'expired')) return result;
  let source = input.source ? parseSharedTelemetrySource(input.source, input.matchId, input.platform) : null;
  if (source && !completeArchivedSource(source)) source = null;
  const pending: RetainedPerformanceRow[] = [];
  for (const original of input.basics) {
    let basic = { ...original };
    const participant = source ? archiveParticipantForBasic(source, basic) : null;
    if (!basic.account_id && participant) {
      let update = db.from('pubg_player_matches').update({ account_id: participant.attributes.stats.playerId })
        .eq('platform', input.platform).eq('match_id', input.matchId).eq('player_id', basic.player_id).is('account_id', null);
      // 전체 관측값을 비교해 다른 작업이 바꾼 행은 결합하지 않는다.
      for (const column of ['played_at', 'game_mode', 'map_name', 'kills', 'damage', 'win_place', 'match_type'] as const)
        update = update.eq(column, basic[column]);
      const { data, error } = await update.select('account_id,player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type')
        .abortSignal(AbortSignal.timeout(15_000));
      if (error || !Array.isArray(data) || data.length !== 1
        || data[0].account_id !== participant.attributes.stats.playerId) throw new Error('retention-account-binding-unverified');
      basic = data[0] as RetentionBasicMatch;
      result.linkedAccounts++;
    }
    if (!basic.account_id || !ACCOUNT_ID.test(basic.account_id)) continue;
    const retained = input.performances.some(p => p.account_id === basic.account_id && p.platform === input.platform
      && p.match_id === input.matchId && p.summary_version >= 1 && p.summary != null
      && Date.parse(p.played_at) === Date.parse(basic.played_at));
    if (retained) continue;
    const originals = input.processed.filter(p => p.platform === input.platform && p.match_id === input.matchId
      && normalizeName(p.player_id) === normalizeName(basic.player_id));
    const rows = originals.map(p => buildRetainedPerformanceRow(p.data?.fullResult, {
      matchId: input.matchId, platform: input.platform, playerId: basic.player_id,
    })).filter((row): row is RetainedPerformanceRow => Boolean(row && retainedRowMatchesBasic(row, basic)));
    if (rows.length) { pending.push(...rows); continue; }
    // 기존 fullResult가 불완전하면 보호한다. 기존 분석 결과가 없는 행만 복구한다.
    if (!source || !participant || originals.some(p => p.data?.fullResult)
      || result.recoveredSummaries >= (input.maxCalculations ?? 5)) continue;
    const job: PerformanceJob = { platform: input.platform, match_id: input.matchId, account_id: basic.account_id,
      player_id: normalizeName(basic.player_id), calculation_version: ANALYSIS_CALCULATION_VERSION,
      result_version: RESULT_VERSION, lease_token: '' };
    // 과거 경기의 측정값을 복구하며 근거 없는 점수와 현재 랭킹 자격은 만들지 않는다.
    const calculated = calculateArchivedRetentionPerformance(job, source);
    if (!retainedRowMatchesBasic(calculated, basic)) throw new Error('retention-recovered-performance-mismatch');
    pending.push(calculated);
    result.recoveredSummaries++;
  }
  result.savedSummaries = await preservePerformanceRows(db, pending);
  return result;
}
