import { describe, expect, it } from 'vitest';
import { planLegacyMapRetentionRecovery } from '../lib/pubg-analysis/legacyMapRetentionRecovery';
import { assessMatchRetentionCleanup, hasRetainedLegacyMapEvidence } from '../lib/pubg-analysis/matchRetentionCleanup';
import { buildTelemetryCacheKey, buildTelemetryPublicIdentity, buildTelemetryPlayerKey } from '../lib/pubg-analysis/telemetryCacheKey';

const now = Date.parse('2026-10-07T00:00:00Z');
const matchId = '123e4567-e89b-42d3-a456-426614174000';
const playedAt = '2026-07-26T15:21:20+00:00';
const accountId = 'account.target';
const key = buildTelemetryPlayerKey(accountId);
const enemy = buildTelemetryPlayerKey('account.enemy');
export function legacyMapRecoveryFixture() {
  const before = { account_id: null, player_id: 'target', platform: 'kakao', match_id: matchId, played_at: playedAt,
    game_mode: 'squad', map_name: 'Baltic_Main', kills: 1, damage: 12, win_place: 12, match_type: 'unavailable',
    knocks: null, survival_time: null, created_at: '2026-08-10T01:50:21Z', ranking_eligible: null };
  const identity = { matchId, platform: 'kakao' as const, playerId: accountId, mode: 'full' as const, telemetryVersion: 60 };
  const storagePath = buildTelemetryCacheKey(identity);
  const registry = { id: 1, match_id: matchId, platform: 'kakao', player_id: accountId, mode: 'full', status: 'ready',
    telemetry_version: 60, storage_path: storagePath, lease_token: null, lease_expires_at: null, updated_at: '2026-08-10T01:50:37Z' };
  const payload = { identity: buildTelemetryPublicIdentity(identity), startTime: playedAt, teamNames: ['target'], teammates: [key],
    mapName: '에란겔', zoneEvents: [], events: [
      { type: 'shot', time: playedAt, name: 'Target', accountId: key },
      { type: 'damage', time: playedAt, attackerName: 'Target', attackerAccountId: key,
        victimName: 'Enemy', victimAccountId: enemy, damage: 12.06 },
      { type: 'groggy', time: playedAt, attacker: 'Target', attackerAccountId: key, victim: 'Enemy', victimAccountId: enemy },
      { type: 'kill', time: playedAt, attacker: 'Target', attackerAccountId: key, victim: 'Enemy', victimAccountId: enemy },
    ] };
  return { before, registry, payload, key: storagePath, sha256: 'a'.repeat(64), etag: '"etag"', sizeBytes: 500, now };
}

describe('구형 지도에서 관측한 성과만 보존', () => {
  it('계정·닉네임·시각·맵·기존 킬/피해 일치로 연결하고 분류/순위/기본 관측은 그대로 보존한다', () => {
    const input = legacyMapRecoveryFixture();
    const packet = planLegacyMapRetentionRecovery(input)!;
    expect(packet.expectedBasic).toEqual({ ...input.before, account_id: accountId });
    expect(packet.performance).toMatchObject({ calculation_version: 0, result_version: 0, score: null, tier: null,
      benchmark: null, ranking_eligible: false, summary: { matchType: 'unavailable',
        retentionRecoveryContext: 'partial-legacy-map-events', performanceHistorical: true,
        stats: { kills: 1, damageDealt: 12.06, winPlace: 12 },
        replayObservedMetrics: { knocks: 1, shotEvents: 1, reviveEvents: 0 } } });
    expect(packet.performance.summary.stats).not.toHaveProperty('timeSurvived');
    expect(packet.performance.summary).not.toHaveProperty('badges');
    expect(JSON.stringify(packet.performance.summary).length).toBeLessThan(2000);
    expect(hasRetainedLegacyMapEvidence(packet.performance, packet.expectedBasic)).toBe(true);
  });

  it.each(['identity', 'name', 'reverse-name', 'kills', 'damage', 'map', 'date', 'lease', 'recent', 'partial-mode', 'hash', 'placeholder'])('%s가 충돌하면 기록·연결을 만들지 않는다', kind => {
    const input = legacyMapRecoveryFixture();
    if (kind === 'identity') input.payload.identity.playerKey = enemy;
    if (kind === 'name') input.payload.events[0].name = 'Other';
    if (kind === 'reverse-name') input.payload.events[0].accountId = enemy;
    if (kind === 'kills') input.before.kills = 2;
    if (kind === 'damage') input.before.damage = 13;
    if (kind === 'map') input.payload.mapName = '미라마';
    if (kind === 'date') input.payload.startTime = '2026-07-27T15:21:20Z';
    if (kind === 'lease') input.registry.lease_token = 'lease' as any;
    if (kind === 'recent') input.now = Date.parse(playedAt) + 1000;
    if (kind === 'partial-mode') input.registry.mode = 'lite';
    if (kind === 'hash') input.sha256 = 'invalid';
    if (kind === 'placeholder') { input.before.kills = 0; input.before.damage = 0; input.before.win_place = 99; }
    expect(planLegacyMapRetentionRecovery(input)).toBeNull();
  });

  it('미확인 유형은 일반 요약으로 통과하지 않으며, 이 보존 경로도 개인 지도 하나만 정리한다', () => {
    const fixture = legacyMapRecoveryFixture();
    const packet = planLegacyMapRetentionRecovery(fixture)!;
    const object = { kind: 'personal-map' as const, key: fixture.key, etag: fixture.etag, sizeBytes: fixture.sizeBytes,
      sha256: fixture.sha256, accountId, playerId: 'target', mode: 'full' as const, telemetryVersion: 60 };
    const input = { matchId, platform: 'kakao' as const, playedAt, now,
      accounts: [{ accountId, basicMatch: packet.expectedBasic, processedRows: [], retainedPerformanceRows: [packet.performance] }],
      referencedAccountIds: [accountId], activeMapLease: false, pendingOrActiveDiscovery: false,
      pendingOrActivePerformanceJob: false, masterStoragePaths: [], objects: [object] };
    expect(assessMatchRetentionCleanup(input)).toMatchObject({ eligible: true, plannedObjectCount: 1 });
    const damaged = structuredClone(packet.performance);
    (damaged.summary as any).retentionRecoveryContext = 'other';
    input.accounts[0].retainedPerformanceRows = [damaged];
    expect(assessMatchRetentionCleanup(input).eligible).toBe(false);
    input.accounts[0].retainedPerformanceRows = [packet.performance];
    const result = assessMatchRetentionCleanup({ ...input, objects: [{ ...object, kind: 'personal-analysis' as const,
      key: fixture.key.replace('.json', '_analyze.json') }] });
    expect(result.objects).toEqual([]);
    expect(result.reasons).toContain('partial_map_summary_covers_map_only');
    expect(assessMatchRetentionCleanup({ ...input, objects: [{ ...object, sha256: 'b'.repeat(64) }] }).objects).toEqual([]);
  });

  it('보존 요약·기본 관측의 사후 변경과 점수 생성은 삭제 근거를 무효화한다', () => {
    const packet = planLegacyMapRetentionRecovery(legacyMapRecoveryFixture())!;
    const changed = structuredClone(packet.performance);
    changed.summary.stats.damageDealt = 13;
    expect(hasRetainedLegacyMapEvidence(changed, packet.expectedBasic)).toBe(false);
    expect(hasRetainedLegacyMapEvidence(packet.performance, { ...packet.expectedBasic, win_place: 13 })).toBe(false);
    expect(hasRetainedLegacyMapEvidence(packet.performance, { ...packet.expectedBasic, survival_time: 10 })).toBe(false);
    expect(hasRetainedLegacyMapEvidence({ ...packet.performance, ranking_eligible: true }, packet.expectedBasic)).toBe(false);
  });

  it('이미 저장된 기절·생존 기록만 요약에 보존하고 지도 사건 수로 공식 기록을 채우지 않는다', () => {
    const input = legacyMapRecoveryFixture();
    input.before.knocks = 0 as any;
    input.before.survival_time = 1234 as any;
    const packet = planLegacyMapRetentionRecovery(input)!;
    expect(packet.performance.summary.stats).toMatchObject({ DBNOs: 0, timeSurvived: 1234 });
    expect((packet.performance.summary as any).replayObservedMetrics.knocks).toBe(1);
    expect(hasRetainedLegacyMapEvidence(packet.performance, packet.expectedBasic)).toBe(true);
    expect(hasRetainedLegacyMapEvidence(packet.performance, { ...packet.expectedBasic, knocks: 1 })).toBe(false);
    input.before.survival_time = -1 as any;
    expect(planLegacyMapRetentionRecovery(input)).toBeNull();
  });
});
