import type { SupabaseClient } from '@supabase/supabase-js';
import { isDeepStrictEqual } from 'node:util';
import { buildRetainedPerformanceRow, MAX_RETAINED_PERFORMANCE_BYTES, type RetainedPerformanceRow } from '../pubg/retainedPerformance';
import { getMatchDetailRetention } from './matchRetention';
import { normalizeName } from './utils';
import { recoverLegacyTeamPerformance, type LegacyRetentionBasic } from './legacyTeamRetentionRecovery';
import { retainedRowMatchesBasic } from './retentionPerformanceRecovery';
import { computeFullResultSourceChecksum } from './matchRetentionCleanup';

export type LegacyTeamEventArtifact = { key: string; sha256: string; events: unknown[] };
type ProcessedSource = { match_id: string; platform: string; player_id: string; data?: { fullResult?: any } };
export type LegacyTeamRetentionPacket = {
  before: LegacyRetentionBasic; sourceBasic: LegacyRetentionBasic; processedSource: ProcessedSource;
  expectedBasic: LegacyRetentionBasic; fullResult: Record<string, any>; performance: RetainedPerformanceRow;
};

/** 사본마다 다른 관측값은 미확인으로 남기고, 모든 사본에서 일치하는 값만 보존한다. */
function commonObservedValue(left: unknown, right: unknown): unknown {
  if (isDeepStrictEqual(left, right)) return structuredClone(left);
  if (left && right && typeof left === 'object' && typeof right === 'object'
    && !Array.isArray(left) && !Array.isArray(right)) {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key =>
      [key, commonObservedValue(a[key], b[key])]));
  }
  return null;
}

function mergeVerifiedObservations(selected: LegacyTeamRetentionPacket, next: LegacyTeamRetentionPacket): boolean {
  // 개인 식별자와 공식 기본 통계가 다른 사본은 부분 집계로도 병합하지 않는다.
  const official = ['matchId', 'createdAt', 'mapName', 'gameMode', 'matchType', 'v', 'stats', 'totalPlayers', 'totalTeams'];
  if (!isDeepStrictEqual(selected.expectedBasic, next.expectedBasic)
    || official.some(key => !isDeepStrictEqual((selected.performance.summary as any)[key], (next.performance.summary as any)[key]))) return false;
  const summary = selected.performance.summary as any, alternate = next.performance.summary as any;
  for (const key of [...new Set([...Object.keys(summary), ...Object.keys(alternate)])]) {
    if (key === 'retentionRecoveryEvidence' || key === 'retentionRecoveryAgreement') continue;
    if (!isDeepStrictEqual(summary[key], alternate[key])) {
      summary[key] = commonObservedValue(summary[key], alternate[key]);
      selected.fullResult[key] = commonObservedValue(selected.fullResult[key], next.fullResult[key]);
    }
  }
  selected.performance.source_checksum = computeFullResultSourceChecksum(selected.fullResult)!;
  return true;
}

/** The plan is bounded and read-only. An ambiguous source never becomes a write. */
export function planLegacyTeamRetentionRecovery(input: {
  basics: LegacyRetentionBasic[]; processed: ProcessedSource[]; performances: Array<Record<string, any>>;
  artifacts: LegacyTeamEventArtifact[]; now: number; maxCalculations: number;
}): { packets: LegacyTeamRetentionPacket[]; calculations: number } {
  const result = { packets: [] as LegacyTeamRetentionPacket[], calculations: 0 };
  const allowance = Math.min(5, Math.max(0, Math.floor(input.maxCalculations)));
  if (!Number.isFinite(allowance) || input.artifacts.length > 3 || input.basics.length > 100
    || input.basics.some(b => getMatchDetailRetention(b.played_at, input.now).status !== 'expired')) return result;
  const artifacts = [...input.artifacts].sort((a, b) => Number(/_v(\d+)_analyze\.json$/.exec(b.key)?.[1] ?? 0)
    - Number(/_v(\d+)_analyze\.json$/.exec(a.key)?.[1] ?? 0));
  for (const before of input.basics) {
    if (before.account_id !== null || input.processed.some(p => p.match_id === before.match_id
      && p.platform === before.platform && normalizeName(p.player_id) === normalizeName(before.player_id))
      || input.performances.some(p => p.match_id === before.match_id && p.platform === before.platform
        && normalizeName(p.player_id) === normalizeName(before.player_id))) continue;
    const sources = input.processed.filter(p => p.match_id === before.match_id && p.platform === before.platform
      && Array.isArray(p.data?.fullResult?.team) && p.data!.fullResult.team.some((s: any) =>
        normalizeName(s?.name ?? '') === normalizeName(before.player_id)));
    if (sources.length !== 1) continue;
    const processedSource = sources[0];
    const sourceBasics = input.basics.filter(b => b.match_id === processedSource.match_id && b.platform === processedSource.platform
      && normalizeName(b.player_id) === normalizeName(processedSource.player_id));
    if (sourceBasics.length !== 1) continue;
    const sourceBasic = sourceBasics[0];
    let selected: LegacyTeamRetentionPacket | null = null;
    const verifiedArtifacts: Array<{ key: string; sha256: string }> = [];
    let ambiguous = false;
    let exhausted = false;
    for (const artifact of artifacts) {
      const nick = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_([a-z0-9._-]+)_v[1-9][0-9]*_analyze\.json$/i.exec(artifact.key)?.[1];
      if (!nick || ![before.player_id, processedSource.player_id].some(name => normalizeName(name) === normalizeName(nick))) continue;
      if (result.calculations >= allowance) { exhausted = true; break; }
      result.calculations++;
      const recovered = recoverLegacyTeamPerformance({ targetBasic: before, targetHasPersonalAnalysis: false, sourceBasic,
        sourceIdentity: { matchId: processedSource.match_id, platform: processedSource.platform, playerId: processedSource.player_id },
        sourceFullResult: processedSource.data?.fullResult,
        eventSource: { matchId: before.match_id, platform: before.platform, legacyKey: artifact.key, requestedLegacyKey: artifact.key,
          verification: 'verified-nickname', verifiedNickname: nick, artifactSha256: artifact.sha256, events: artifact.events } });
      if (!recovered) { ambiguous = true; break; }
      const row = buildRetainedPerformanceRow(recovered.fullResult,
        { matchId: before.match_id, platform: before.platform, playerId: before.player_id });
      if (!row || !retainedRowMatchesBasic(row, recovered.expectedBasic)) { ambiguous = true; break; }
      row.summary = JSON.parse(JSON.stringify(recovered.compact));
      row.benchmark = null; row.score = null; row.tier = null; row.ranking_eligible = false;
      const packet = { before, sourceBasic, processedSource, expectedBasic: recovered.expectedBasic,
        fullResult: recovered.fullResult, performance: row };
      if (selected) {
        if (!mergeVerifiedObservations(selected, packet)) { ambiguous = true; break; }
      } else selected = packet;
      verifiedArtifacts.push({ key: artifact.key, sha256: artifact.sha256 });
    }
    if (selected && verifiedArtifacts.length > 1) (selected.performance.summary as any).retentionRecoveryAgreement = {
      policy: 'common-observations-only', artifacts: verifiedArtifacts,
    };
    if (selected && !ambiguous && !exhausted
      // jsonb::text의 구분 공백보다 큰 표현으로 RPC 크기 제한을 먼저 확인한다.
      && Buffer.byteLength(JSON.stringify(selected.performance.summary, null, 1)) <= MAX_RETAINED_PERFORMANCE_BYTES
      && !input.basics.some(other => other !== before
      && other.match_id === before.match_id && other.platform === before.platform
      && other.account_id === selected!.expectedBasic.account_id)
      && !result.packets.some(other => other.before.match_id === before.match_id && other.before.platform === before.platform
        && other.expectedBasic.account_id === selected!.expectedBasic.account_id)) result.packets.push(selected);
    if (result.calculations >= allowance) break;
  }
  return result;
}

/** No upsert: the service-only RPC checks snapshots and commits basic + compact together. */
export async function preserveLegacyTeamRetentionPackets(db: SupabaseClient, packets: LegacyTeamRetentionPacket[]): Promise<number> {
  if (packets.length > 5) throw new Error('retention-legacy-team-limit-invalid');
  let saved = 0;
  for (const original of packets) {
    // 과거 packet의 누락 필드만 보완하고 명시된 scope와 나머지 스냅샷은 유지한다.
    const packet = { ...original,
      before: { retention_scope: 'legacy', ...original.before },
      sourceBasic: { retention_scope: 'legacy', ...original.sourceBasic },
      expectedBasic: { retention_scope: 'legacy', ...original.expectedBasic },
    };
    const { data, error, status } = await db.rpc('recover_retention_legacy_team', { p_packet: packet })
      .abortSignal(AbortSignal.timeout(15_000));
    // 응답 유실 뒤에는 쓰기를 반복하지 않고 실제 저장된 두 행을 대조한다.
    const responseLost = error && (status === 0 || (status >= 500 && status <= 599));
    if (!responseLost && (error || data?.saved !== true
      || !isDeepStrictEqual({ retention_scope: 'legacy', ...data.basic }, packet.expectedBasic))) {
      const reason = ['lock-unavailable', 'lock-budget-exceeded', 'snapshot-changed', 'active-lease',
        'target-exists', 'validation-rejected'].includes(error?.details ?? '') ? error!.details : 'unknown';
      throw new Error(`retention-legacy-team-write-unverified:${status ?? 'unknown'}:${reason}`);
    }
    const identity = packet.performance;
    const [{ data: basics, error: basicError }, { data: rows, error: readError }] = await Promise.all([
      db.from('pubg_player_matches').select('*').eq('platform', identity.platform).eq('match_id', identity.match_id)
        .eq('player_id', identity.player_id).limit(2).abortSignal(AbortSignal.timeout(15_000)),
      db.from('pubg_match_performance').select('*').eq('platform', identity.platform).eq('match_id', identity.match_id)
        .eq('account_id', identity.account_id).limit(2).abortSignal(AbortSignal.timeout(15_000)),
    ]);
    if (basicError || readError || basics?.length !== 1 || rows?.length !== 1
      || !isDeepStrictEqual({ retention_scope: 'legacy', ...basics[0] }, packet.expectedBasic)
      || Object.entries(identity).some(([key, value]) => key === 'played_at'
        ? Date.parse(rows[0][key]) !== Date.parse(String(value)) : !isDeepStrictEqual(rows[0][key], value)))
      throw new Error(`retention-legacy-team-readback-unverified:${status ?? 'unknown'}`);
    saved++;
  }
  return saved;
}
