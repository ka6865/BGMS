import { describe, expect, it, vi } from 'vitest';
import { planLegacyTeamRetentionRecovery, preserveLegacyTeamRetentionPackets } from '../lib/pubg-analysis/legacyTeamRetentionPreservation';
import { legacyTeamRecoveryInput } from './fixtures/legacy-team-retention';
import { computeFullResultSourceChecksum } from '../lib/pubg-analysis/matchRetentionCleanup';

function input() {
  const fixture = legacyTeamRecoveryInput();
  return { basics: [fixture.sourceBasic, fixture.targetBasic],
    processed: [{ match_id: fixture.sourceBasic.match_id, platform: fixture.sourceBasic.platform,
      player_id: fixture.sourceBasic.player_id, data: { fullResult: fixture.sourceFullResult } }],
    performances: [] as any[],
    artifacts: [{ key: fixture.eventSource.legacyKey, sha256: fixture.eventSource.artifactSha256, events: fixture.eventSource.events }],
    now: Date.parse('2026-10-07T00:00:00Z'), maxCalculations: 5 };
}

describe('bounded legacy-team retention plan', () => {
  it('produces compact-only packets while leaving source snapshots unchanged', () => {
    const value = input(), snapshot = structuredClone(value);
    const { packets, calculations } = planLegacyTeamRetentionRecovery(value);
    expect(calculations).toBe(1);
    expect(packets).toHaveLength(1);
    expect(packets[0].performance).toMatchObject({ account_id: 'account.target', benchmark: null, score: null,
      tier: null, ranking_eligible: false, summary: { performanceHistorical: true } });
    expect(value).toEqual(snapshot);
  });
  it.each(['existing-personal', 'existing-performance', 'multiple-source', 'live-match', 'account-collision', 'no-budget'])(
    'does not propose writes for %s', reason => {
      const value = input();
      if (reason === 'existing-personal') value.processed.push({ ...value.processed[0], player_id: 'target' });
      if (reason === 'existing-performance') value.performances.push({ ...value.basics[1] });
      if (reason === 'multiple-source') value.processed.push({ ...value.processed[0] });
      if (reason === 'live-match') value.now = Date.parse(value.basics[1].played_at) + 86_400_000;
      if (reason === 'account-collision') value.basics.push({ ...value.basics[1], player_id: 'collision', account_id: 'account.target' });
      if (reason === 'no-budget') value.maxCalculations = 0;
      expect(planLegacyTeamRetentionRecovery(value).packets).toEqual([]);
    });
  it('supports nicknames containing underscores and rejects another artifact match', () => {
    const value = input();
    value.basics[0].player_id = 'source_name'; value.processed[0].player_id = 'source_name';
    const full = value.processed[0].data.fullResult as any;
    full.player_id = 'source_name'; full.stats.name = 'Source_Name'; full.team[0].name = 'Source_Name';
    (value.artifacts[0].events[1] as any).character.name = 'Source_Name';
    value.artifacts[0].key = `${value.basics[0].match_id}_source_name_v62_analyze.json`;
    expect(planLegacyTeamRetentionRecovery(value).packets).toHaveLength(1);
    value.artifacts[0].key = '00000000-0000-4000-8000-000000000000_source_name_v62_analyze.json';
    expect(planLegacyTeamRetentionRecovery(value).packets).toEqual([]);
  });
  it('requires all alternate artifacts to fit the computation budget', () => {
    const value = input(); value.artifacts.push({ ...value.artifacts[0], key: value.artifacts[0].key.replace('_v62_', '_v63_') });
    value.maxCalculations = 1;
    expect(planLegacyTeamRetentionRecovery(value).packets).toEqual([]);
    value.maxCalculations = 2;
    expect(planLegacyTeamRetentionRecovery(value)).toMatchObject({ calculations: 2, packets: [expect.anything()] });
  });
  it('preserves agreed observations from independently verified alternate projections', () => {
    const value = input();
    value.artifacts.push({ ...value.artifacts[0], key: value.artifacts[0].key.replace('_v62_', '_v63_'),
      sha256: 'b'.repeat(64), events: [...structuredClone(value.artifacts[0].events), { _T: 'LogPlayerAttack' }] });
    const planned = planLegacyTeamRetentionRecovery(value);
    expect(planned.packets).toHaveLength(1);
    expect(planned.packets[0].performance.summary).toMatchObject({
      stats: { kills: 3, damageDealt: 400.9, winPlace: 2 },
      retentionRecoveryAgreement: { policy: 'common-observations-only', artifacts: [expect.anything(), expect.anything()] },
    });
  });
  it('protects an invalid alternate even when another artifact verifies', () => {
    const value = input();
    value.artifacts.push({ ...value.artifacts[0], key: value.artifacts[0].key.replace('_v62_', '_v61_'),
      sha256: 'b'.repeat(64), events: value.artifacts[0].events.filter((event: any) => event._T !== 'LogMatchEnd') });
    expect(planLegacyTeamRetentionRecovery(value).packets).toEqual([]);
  });
  it('leaves conflicting distance observations unavailable without dropping official stats', () => {
    const value = input();
    (value.artifacts[0].events[1] as any).character.location = { x: 0, y: 0, z: 0 };
    const position = { _T: 'LogPlayerPosition', _D: '2026-09-01T00:03:00.000Z',
      character: { accountId: 'account.target', name: 'Target', teamId: 7, location: { x: 20000, y: 0, z: 0 } } };
    value.artifacts[0].events.splice(-1, 0, position as any);
    const alternate = structuredClone(value.artifacts[0]);
    alternate.key = alternate.key.replace('_v62_', '_v61_'); alternate.sha256 = 'b'.repeat(64);
    (alternate.events.at(-2) as any).character.location.x = 40000;
    value.artifacts.push(alternate);
    const { packets } = planLegacyTeamRetentionRecovery(value);
    expect(packets).toHaveLength(1);
    expect(packets[0].performance.summary).toMatchObject({ stats: { kills: 3, damageDealt: 400.9, winPlace: 2 },
      isolationData: { minDist: null, isolationIndex: null, teammateCount: null } });
    expect(packets[0].performance.source_checksum).toBe(computeFullResultSourceChecksum(packets[0].fullResult));
  });
});

describe('legacy-team compact write verification', () => {
  function db(packet: ReturnType<typeof planLegacyTeamRetentionRecovery>['packets'][number], changed = false) {
    const calls: string[] = [];
    const client = { rpc: vi.fn(() => ({ abortSignal: async () => {
      calls.push('atomic-rpc'); return { data: { saved: true, basic: packet.expectedBasic }, error: null };
    } })), from: vi.fn((table: string) => {
      calls.push(table);
      const q: any = { select: () => q, eq: () => q, limit: () => q, abortSignal: async () => ({
        data: table === 'pubg_player_matches' ? [packet.expectedBasic] : [{ ...packet.performance,
          ...(changed ? { summary: { stats: { kills: 999 } } } : {}) }], error: null,
      }) };
      return q;
    }) };
    return { client, calls };
  }
  it('checks the actual basic and compact rows after the atomic RPC', async () => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const { client, calls } = db(packet);
    expect(await preserveLegacyTeamRetentionPackets(client as any, [packet])).toBe(1);
    expect(calls).toEqual(['atomic-rpc', 'pubg_player_matches', 'pubg_match_performance']);
    expect(client.rpc).toHaveBeenCalledWith('recover_retention_legacy_team', { p_packet: packet });
  });
  it('halts cleanup when readback content differs even after a successful response', async () => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    await expect(preserveLegacyTeamRetentionPackets(db(packet, true).client as any, [packet]))
      .rejects.toThrow('retention-legacy-team-readback-unverified');
  });
  it('does not expose failed database responses', async () => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const client = { rpc: () => ({ abortSignal: async () => ({ error: { message: 'private data' } }) }) };
    await expect(preserveLegacyTeamRetentionPackets(client as any, [packet])).rejects.toThrow('retention-legacy-team-write-unverified');
  });
});
