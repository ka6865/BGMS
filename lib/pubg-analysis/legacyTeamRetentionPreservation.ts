import type { SupabaseClient } from '@supabase/supabase-js';
import { isDeepStrictEqual } from 'node:util';
import { buildRetainedPerformanceRow, type RetainedPerformanceRow } from '../pubg/retainedPerformance';
import { getMatchDetailRetention } from './matchRetention';
import { normalizeName } from './utils';
import { recoverLegacyTeamPerformance, type LegacyRetentionBasic } from './legacyTeamRetentionRecovery';
import { retainedRowMatchesBasic } from './retentionPerformanceRecovery';

export type LegacyTeamEventArtifact = { key: string; sha256: string; events: unknown[] };
type ProcessedSource = { match_id: string; platform: string; player_id: string; data?: { fullResult?: any } };
export type LegacyTeamRetentionPacket = {
  before: LegacyRetentionBasic; sourceBasic: LegacyRetentionBasic; processedSource: ProcessedSource;
  expectedBasic: LegacyRetentionBasic; fullResult: Record<string, any>; performance: RetainedPerformanceRow;
};

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
    let selectedEvents: unknown[] | null = null;
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
      if (!recovered) continue;
      const row = buildRetainedPerformanceRow(recovered.fullResult,
        { matchId: before.match_id, platform: before.platform, playerId: before.player_id });
      if (!row || !retainedRowMatchesBasic(row, recovered.expectedBasic)) continue;
      row.summary = JSON.parse(JSON.stringify(recovered.compact));
      row.benchmark = null; row.score = null; row.tier = null; row.ranking_eligible = false;
      const packet = { before, sourceBasic, processedSource, expectedBasic: recovered.expectedBasic,
        fullResult: recovered.fullResult, performance: row };
      if (selected) {
        const prior = { ...selected.performance.summary } as any;
        const next = { ...row.summary } as any;
        delete prior.retentionRecoveryEvidence;
        delete next.retentionRecoveryEvidence;
        if (!isDeepStrictEqual(selectedEvents, artifact.events) || !isDeepStrictEqual(prior, next)) { ambiguous = true; break; }
      } else { selected = packet; selectedEvents = artifact.events; }
    }
    if (selected && !ambiguous && !exhausted && !input.basics.some(other => other !== before
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
  for (const packet of packets) {
    const { data, error } = await db.rpc('recover_retention_legacy_team', { p_packet: packet })
      .abortSignal(AbortSignal.timeout(15_000));
    if (error || data?.saved !== true || !isDeepStrictEqual(data.basic, packet.expectedBasic))
      throw new Error('retention-legacy-team-write-unverified');
    const identity = packet.performance;
    const [{ data: basics, error: basicError }, { data: rows, error: readError }] = await Promise.all([
      db.from('pubg_player_matches').select('*').eq('platform', identity.platform).eq('match_id', identity.match_id)
        .eq('player_id', identity.player_id).limit(2).abortSignal(AbortSignal.timeout(15_000)),
      db.from('pubg_match_performance').select('*').eq('platform', identity.platform).eq('match_id', identity.match_id)
        .eq('account_id', identity.account_id).limit(2).abortSignal(AbortSignal.timeout(15_000)),
    ]);
    if (basicError || readError || basics?.length !== 1 || rows?.length !== 1
      || !isDeepStrictEqual(basics[0], packet.expectedBasic)
      || Object.entries(identity).some(([key, value]) => key === 'played_at'
        ? Date.parse(rows[0][key]) !== Date.parse(String(value)) : !isDeepStrictEqual(rows[0][key], value)))
      throw new Error('retention-legacy-team-readback-unverified');
    saved++;
  }
  return saved;
}
