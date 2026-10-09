import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMatchSummary, type MatchSummaryData } from '../pubg-analysis/matchSummary';
import { getLegacyFullResultForHistory } from '../pubg-analysis/cacheIdentity';
import { isSupportedAnalysisCalculationVersion, RESULT_VERSION } from '../pubg-analysis/constants';
import { normalizeName } from '../pubg-analysis/utils';
import { computeFullResultSourceChecksum } from '../pubg-analysis/matchRetentionCleanup';

export const RETAINED_PERFORMANCE_VERSION = 1;
export const MAX_RETAINED_PERFORMANCE_BYTES = 32_768;
type Identity = { matchId: string; platform: string; playerId: string };
export type RetainedPerformanceRow = {
  platform: string; account_id: string; match_id: string; player_id: string;
  calculation_version: number; result_version: number; played_at: string;
  summary_version: number; source_checksum: string; summary: MatchSummaryData;
  benchmark: MatchSummaryData['benchmark'] | null; score: number | null;
  tier: string | null; ranking_eligible: boolean;
};

// 값만 보존한다. 이동 경로, 사건 목록, 상대 계정과 원본 이벤트는 포함하지 않는다.
const fields = {
  stats: ['name', 'playerId', 'winPlace', 'kills', 'assists', 'damageDealt', 'processedDamageDealt', 'DBNOs', 'timeSurvived', 'headshotKills', 'longestKill', 'heals', 'boosts', 'deathType', 'walkDistance', 'rideDistance', 'swimDistance', 'revives'],
  teamImpact: ['damageImpact', 'killImpact', 'teamDamageShare', 'teamKillShare', 'totalTeamDamage', 'totalTeamKills'],
  tradeStats: ['teammateKnocks', 'dangerousKnocks', 'smokeOpps', 'suppCount', 'tradeKills', 'smokeCount', 'smokeRescues', 'teamSmokeCovered', 'revCount', 'baitCount', 'tradeLatencyMs', 'counterLatencyMs', 'reactionLatencyMs', 'coverRate', 'coverRateSampleCount', 'enemyTeamWipes', 'tradeRate', 'suppRate', 'teammateKills'],
  duelStats: ['reversalRate', 'duelWinRate', 'totalDuels', 'wins', 'losses', 'reversals', 'reversalAttempts'],
  itemUseSummary: ['smokes', 'frags', 'molotovs', 'stuns', 'heals', 'boosts', 'others'],
  itemUseStats: ['smokes', 'frags', 'molotovs', 'stuns', 'heals', 'boosts', 'throwCount', 'lethalThrowCount', 'smokeCount', 'fragCount', 'molotovCount', 'stunCount', 'focusFireCount', 'crossfireExposureCount'],
  killContribution: ['solo', 'assist', 'cleanup'],
  myRank: ['damageRank', 'damagePercentile', 'killRank', 'totalTeams', 'totalPlayers'],
  isolationData: ['isolationIndex', 'minDist', 'heightDiff', 'isCrossfire', 'teammateCount'],
  initiativeStats: ['total', 'success', 'rate'],
} as const;
function record(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function pick(value: unknown, keys: readonly string[]) {
  if (!record(value)) return undefined;
  return Object.fromEntries(keys.filter(key => value[key] === null || typeof value[key] === 'boolean'
    || (typeof value[key] === 'number' && Number.isFinite(value[key]))
    || (typeof value[key] === 'string' && value[key].length <= 200)).map(key => [key, value[key]]));
}
export function buildRetainedPerformanceRow(full: unknown, identity: Identity): RetainedPerformanceRow | null {
  if (!record(full) || !['steam', 'kakao'].includes(identity.platform)) return null;
  const playerId = normalizeName(identity.playerId);
  const valid = getLegacyFullResultForHistory({ data: { fullResult: full } }, playerId, identity.platform);
  if (!valid || ['matchId', 'match_id', 'id'].some(key => full[key] != null && full[key] !== identity.matchId)) return null;
  const accountId = full.stats?.playerId;
  if (typeof accountId !== 'string' || !/^account\.[A-Za-z0-9_-]+$/.test(accountId)) return null;
  const playedAt = full.createdAt || full.matchInfo?.date;
  if (typeof playedAt !== 'string' || !Number.isFinite(Date.parse(playedAt)) || Date.parse(playedAt) > Date.now()) return null;
  const version = full.v;
  const calculation = full.calculationVersion ?? 0;
  if (!Number.isInteger(version) || version < 1 || !Number.isInteger(calculation) || calculation < 0) return null;
  const base = buildMatchSummary({ ...full, matchId: identity.matchId, createdAt: playedAt });
  if (!base) return null;
  const compact: Record<string, any> = {
    matchId: identity.matchId, createdAt: playedAt, mapName: base.mapName, mapId: base.mapId,
    gameMode: base.gameMode, matchType: base.matchType, v: version,
    isSummary: true, summarySource: 'pubg_match_performance', performanceOnly: true, calculationVersion: calculation,
    performanceHistorical: !isSupportedAnalysisCalculationVersion(calculation) || version !== RESULT_VERSION,
    totalTeams: full.totalTeams, totalPlayers: full.totalPlayers,
    totalTeamKills: full.totalTeamKills, totalTeamDamage: full.totalTeamDamage,
    team: [], killDetails: [], dbnoDetails: [], tacticalTimeline: [],
  };
  for (const [key, keys] of Object.entries(fields)) compact[key] = pick(full[key], keys);
  compact.badges = Array.isArray(full.badges) ? full.badges.slice(0, 32).map((badge: unknown) => pick(badge, ['id', 'name', 'desc'])).filter(Boolean) : [];
  if (record(full.weaponStats)) compact.weaponStats = Object.fromEntries(Object.entries(full.weaponStats).slice(0, 100)
    .map(([key, value]) => [key, pick(value, ['damage', 'damageDealt', 'kills', 'dbnos', 'dBNOs', 'hits', 'shots', 'headshots', 'headHits', 'accuracy', 'firstSecHits', 'sustainedHits', 'sustainedBurstCount'])]));
  if (record(full.itemUseStats?.distanceDamage)) compact.itemUseStats = { ...compact.itemUseStats,
    distanceDamage: pick(full.itemUseStats.distanceDamage, ['short', 'mid', 'long']) };
  compact.matchInfo = pick(full.matchInfo, ['rankPct', 'date', 'mode', 'matchType', 'mapId']);
  compact.combatPressure = pick(full.combatPressure, ['totalHits', 'maxHitDistance', 'utilityDamage', 'utilityHits', 'pressureIndex']);
  if (record(full.combatPressure?.utilityStats)) compact.combatPressure = { ...compact.combatPressure,
    utilityStats: pick(full.combatPressure.utilityStats, ['throwCount', 'lethalThrowCount', 'hitCount', 'damageEventCount', 'totalDamage', 'killCount', 'accuracy', 'accuracyRaw', 'avgDamagePerThrow']) };
  for (const key of ['teamWipeOccurred', 'goldenTimeDamage', 'initiative_rate', 'initiativeSampleCount', 'deathPhase', 'edgePlay', 'bluezoneWaste', 'leadShotKills', 'leadShotKnocks', 'ridingShotKills', 'ridingShotKnocks', 'roadKills', 'roadKnocks']) {
    Object.assign(compact, pick(full, [key]));
  }
  const benchmark = record(full.benchmark) && Number.isFinite(full.benchmark.score)
    && full.benchmark.score >= 0 && full.benchmark.score <= 100 ? full.benchmark : null;
  compact.benchmark = benchmark;
  compact.isValidBenchmark = full.isValidBenchmark === true;
  const serialized = JSON.stringify(compact);
  if (Buffer.byteLength(serialized) > MAX_RETAINED_PERFORMANCE_BYTES) return null;
  return {
    platform: identity.platform, account_id: accountId, match_id: identity.matchId, player_id: playerId,
    calculation_version: calculation, result_version: version, played_at: playedAt,
    summary_version: RETAINED_PERFORMANCE_VERSION,
    source_checksum: computeFullResultSourceChecksum(full)!,
    summary: JSON.parse(serialized), benchmark: benchmark as MatchSummaryData['benchmark'] | null,
    score: benchmark?.score ?? null, tier: typeof benchmark?.tier === 'string' ? benchmark.tier : null,
    ranking_eligible: full.isValidBenchmark === true && isSupportedAnalysisCalculationVersion(calculation)
      && version === RESULT_VERSION && full.populationEvidenceVersion === 1 && typeof benchmark?.tier === 'string',
  };
}
export async function persistRetainedPerformance(db: SupabaseClient, full: unknown, identity: Identity): Promise<boolean> {
  const row = buildRetainedPerformanceRow(full, identity);
  if (!row) return false;
  const { error } = await db.from('pubg_match_performance').upsert(row, {
    onConflict: 'platform,account_id,match_id,calculation_version,result_version',
  });
  return !error;
}

export async function readRetainedPerformance(db: SupabaseClient, platform: string, nickname: string, ids: string[], accountId?: string | null): Promise<Record<string, MatchSummaryData>> {
  if (!ids.length) return {};
  try {
    let query = db.from('pubg_match_performance').select('match_id,account_id,summary,summary_version,played_at,calculation_version,result_version,benchmark').eq('platform', platform);
    query = accountId && /^account\.[A-Za-z0-9_-]+$/.test(accountId) ? query.eq('account_id', accountId) : query.eq('player_id', normalizeName(nickname));
    const { data, error } = await query.in('match_id', ids);
    if (error) return {};
    const selected: Record<string, any> = {};
    for (const row of data || []) {
      const s = row.summary;
      if (row.summary_version !== RETAINED_PERFORMANCE_VERSION || !record(s) || s.matchId !== row.match_id
        || s.stats?.playerId !== row.account_id || Date.parse(s.createdAt) !== Date.parse(row.played_at)
        || ![s.stats?.kills, s.stats?.damageDealt, s.stats?.winPlace].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
        || s.stats.winPlace < 1) continue;
      const prior = selected[row.match_id];
      if (!prior || row.calculation_version > prior.calculation_version
        || (row.calculation_version === prior.calculation_version && row.result_version > prior.result_version)) selected[row.match_id] = row;
    }
    return Object.fromEntries(Object.entries(selected).map(([id, row]) => {
      const measured = record(row.benchmark) && Number.isFinite(row.benchmark.score)
        && row.benchmark.score >= 0 && row.benchmark.score <= 100 ? row.benchmark : null;
      return [id, measured ? { ...row.summary, benchmark: measured } : row.summary];
    }));
  } catch { return {}; }
}
