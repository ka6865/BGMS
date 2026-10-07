import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RetainedPerformanceRow } from '../pubg/retainedPerformance';
import type { MatchSummaryData } from './matchSummary';
import { MAP_NAMES } from './constants';
import { getMatchDetailRetention } from './matchRetention';
import { buildTelemetryCacheKey, buildTelemetryPublicIdentity } from './telemetryCacheKey';
import { parseTelemetryPayload } from './telemetryPayload';
import { computeFullResultSourceChecksum, legacyMapBasicSnapshot } from './matchRetentionCleanup';

type Row = Record<string, any>;
export type LegacyMapRetentionPacket = { before: Row; registry: Row; expectedBasic: Row; performance: RetainedPerformanceRow };
const ACCOUNT = /^account\.[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTEXT = 'partial-legacy-map-events';

function record(value: unknown): value is Row { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function normalized(value: unknown): string { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }

/** 지도에서 관측한 이벤트만 보존하며 공식 경기 유형이나 완전한 분석으로 취급하지 않는다. */
export function planLegacyMapRetentionRecovery(input: {
  before: Row; registry: Row; payload: unknown; key: string; sha256: string; etag: string; sizeBytes: number; now?: number;
}): LegacyMapRetentionPacket | null {
  const { before, registry } = input;
  const now = input.now ?? Date.now();
  const known = (v: unknown) => typeof v === 'string' && v.trim() && !['unknown', 'unavailable'].includes(normalized(v));
  if (before.account_id !== null || !['steam', 'kakao'].includes(before.platform)
    || !/^[a-f0-9-]{36}$/.test(before.match_id) || !/^[a-z0-9._-]{1,64}$/.test(before.player_id)
    || getMatchDetailRetention(before.played_at, now).status !== 'expired'
    || !known(before.map_name) || !known(before.game_mode) || typeof before.match_type !== 'string' || !before.match_type
    || ![before.kills, before.damage, before.win_place].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 2147483647)
    || ![before.knocks, before.survival_time].every(v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 2147483647))
    || before.win_place < 1 || (before.kills === 0 && before.damage === 0 && before.win_place === 99)
    || registry.match_id !== before.match_id || registry.platform !== before.platform || !ACCOUNT.test(registry.player_id)
    || registry.mode !== 'full' || registry.status !== 'ready' || registry.lease_token != null
    || (registry.lease_expires_at && Date.parse(registry.lease_expires_at) > now)
    || !Number.isSafeInteger(registry.id) || !Number.isSafeInteger(registry.telemetry_version) || registry.telemetry_version < 1
    || !Number.isFinite(Date.parse(registry.updated_at)) || !SHA256.test(input.sha256) || !input.etag.trim()
    || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 8 * 1024 * 1024) return null;
  const identity = { matchId: before.match_id, platform: before.platform, playerId: registry.player_id,
    mode: 'full' as const, telemetryVersion: registry.telemetry_version };
  let payload;
  try {
    if (buildTelemetryCacheKey(identity) !== input.key || registry.storage_path !== input.key) return null;
    payload = parseTelemetryPayload(input.payload, buildTelemetryPublicIdentity(identity));
  } catch { return null; }
  if (Date.parse(payload.startTime) !== Date.parse(before.played_at) || payload.events.length > 100_000
    || ![before.map_name, MAP_NAMES[before.map_name]].includes(payload.mapName)
    || payload.teamNames.filter(n => normalized(n) === before.player_id).length !== 1) return null;
  const playerKey = payload.identity.playerKey;
  const names = new Set<string>();
  const accounts = new Set<string>();
  let kills = 0, damage = 0, knocks = 0, shots = 0, revives = 0;
  for (const raw of payload.events) {
    if (!record(raw) || typeof raw.type !== 'string' || !Number.isFinite(Date.parse(raw.time))) return null;
    for (const [nameField, accountField] of [['name', 'accountId'], ['attackerName', 'attackerAccountId'],
      ['victimName', 'victimAccountId'], ['attacker', 'attackerAccountId'], ['victim', 'victimAccountId']]) {
      if (raw[nameField] == null) continue;
      const name = normalized(raw[nameField]);
      const account = raw[accountField];
      if (account === playerKey) { if (!name) return null; names.add(name); }
      if (name === before.player_id && account !== undefined) { if (typeof account !== 'string') return null; accounts.add(account); }
    }
    if (raw.attackerAccountId === playerKey) {
      if (raw.type === 'damage' && raw.victimAccountId !== playerKey) {
        if (typeof raw.damage !== 'number' || !Number.isFinite(raw.damage) || raw.damage < 0) return null;
        damage += raw.damage;
      }
      if (raw.type === 'kill' && raw.victimAccountId !== playerKey && raw.isSystem !== true) kills++;
      if (raw.type === 'groggy' && raw.victimAccountId !== playerKey && raw.isSystem !== true) knocks++;
      if (raw.type === 'revive') revives++;
    }
    if (raw.type === 'shot' && raw.accountId === playerKey) shots++;
  }
  if (names.size !== 1 || !names.has(before.player_id) || accounts.size !== 1 || !accounts.has(playerKey)
    || kills !== before.kills || Math.floor(damage) !== before.damage) return null;
  const expectedBasic = { ...before, account_id: registry.player_id };
  const summary = {
    matchId: before.match_id, createdAt: before.played_at, mapName: before.map_name,
    gameMode: before.game_mode, matchType: before.match_type, v: 0,
    isSummary: true, summarySource: 'pubg_match_performance', performanceOnly: true, performanceHistorical: true,
    retentionRecoveryContext: CONTEXT,
    stats: { name: before.player_id, playerId: registry.player_id, kills: before.kills,
      damageDealt: damage, winPlace: before.win_place, rank: before.win_place,
      ...(before.knocks !== null ? { DBNOs: before.knocks } : {}),
      ...(before.survival_time !== null ? { timeSurvived: before.survival_time } : {}) },
    replayObservedMetrics: { knocks, shotEvents: shots, reviveEvents: revives },
    retentionRecoveryEvidence: { kind: 'legacy-map-retention-v1', key: input.key, sha256: input.sha256,
      etag: input.etag, sizeBytes: input.sizeBytes, basicSnapshot: legacyMapBasicSnapshot(expectedBasic),
      registryId: registry.id, registryUpdatedAt: registry.updated_at },
  };
  const performance: RetainedPerformanceRow = {
    platform: before.platform, account_id: registry.player_id, match_id: before.match_id, player_id: before.player_id,
    calculation_version: 0, result_version: 0, played_at: before.played_at, summary_version: 1,
    source_checksum: computeFullResultSourceChecksum(summary)!, summary: summary as unknown as MatchSummaryData,
    benchmark: null, score: null, tier: null, ranking_eligible: false,
  };
  return { before, registry, expectedBasic, performance };
}

/** 기본 관측값을 보존한 계정 연결과 작은 성과 요약을 원자 저장한 뒤 둘 다 재조회한다. */
export async function preserveLegacyMapRetentionPacket(db: SupabaseClient, packet: LegacyMapRetentionPacket): Promise<void> {
  const { data, error } = await db.rpc('recover_retention_legacy_map', { p_packet: packet })
    .abortSignal(AbortSignal.timeout(15_000));
  if (error || data?.saved !== true || !isDeepStrictEqual(data.basic, packet.expectedBasic))
    throw new Error('retention-legacy-map-write-unverified');
  const identity = packet.performance;
  const [{ data: basics, error: basicError }, { data: saved, error: readError }] = await Promise.all([
    db.from('pubg_player_matches').select('*').eq('platform', identity.platform).eq('match_id', identity.match_id)
      .eq('player_id', identity.player_id).limit(2).abortSignal(AbortSignal.timeout(15_000)),
    db.from('pubg_match_performance').select('*').eq('platform', identity.platform).eq('match_id', identity.match_id)
      .eq('account_id', identity.account_id).limit(2).abortSignal(AbortSignal.timeout(15_000)),
  ]);
  if (basicError || readError || basics?.length !== 1 || saved?.length !== 1
    || !isDeepStrictEqual(basics[0], packet.expectedBasic) || Object.entries(identity).some(([key, v]) => key === 'played_at'
      ? Date.parse(saved[0][key]) !== Date.parse(String(v)) : !isDeepStrictEqual(saved[0][key], v)))
    throw new Error('retention-legacy-map-readback-unverified');
}
