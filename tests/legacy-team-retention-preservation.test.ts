import { describe, expect, it, vi } from 'vitest';
import { planLegacyTeamRetentionRecovery, preserveLegacyTeamRetentionPackets } from '../lib/pubg-analysis/legacyTeamRetentionPreservation';
import { legacyTeamRecoveryInput } from './fixtures/legacy-team-retention';
import { computeFullResultSourceChecksum } from '../lib/pubg-analysis/matchRetentionCleanup';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

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
    expect(client.rpc).toHaveBeenCalledWith('recover_retention_legacy_team', { p_packet: {
      ...packet,
      before: { retention_scope: 'legacy', ...packet.before },
      sourceBasic: { retention_scope: 'legacy', ...packet.sourceBasic },
      expectedBasic: { retention_scope: 'legacy', ...packet.expectedBasic },
    } });
  });
  it.each([200, 504])('과거 packet을 HTTP %i 응답과 새 legacy 행에 대조하며 원본과 checksum을 유지한다', async status => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const snapshot = structuredClone(packet);
    const stored = { ...packet, expectedBasic: { ...packet.expectedBasic, retention_scope: 'legacy' } };
    const { client } = db(stored);
    if (status === 504) client.rpc.mockImplementation(() => ({ abortSignal: async () => ({
      data: null, error: { message: 'transport failure' }, status,
    }) }) as any);
    expect(await preserveLegacyTeamRetentionPackets(client as any, [packet])).toBe(1);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    const sent = (client.rpc.mock.calls[0] as unknown as [string, { p_packet: typeof stored }])[1].p_packet;
    expect(sent.before).toEqual({ ...packet.before, retention_scope: 'legacy' });
    expect(sent.sourceBasic).toEqual({ ...packet.sourceBasic, retention_scope: 'legacy' });
    expect(sent.expectedBasic).toEqual(stored.expectedBasic);
    expect(sent.performance).toEqual(snapshot.performance);
    expect(sent.fullResult).toEqual(snapshot.fullResult);
    expect(packet).toEqual(snapshot);
  });
  it.each(['legacy', 'basic_only', 'detail'])('명시된 %s scope는 제출과 응답 비교에서 유지한다', async retention_scope => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    for (const row of [packet.before, packet.sourceBasic, packet.expectedBasic]) Object.assign(row, { retention_scope });
    const { client } = db(packet);
    expect(await preserveLegacyTeamRetentionPackets(client as any, [packet])).toBe(1);
    expect(client.rpc).toHaveBeenCalledWith('recover_retention_legacy_team', { p_packet: packet });
  });
  it.each([null, 'invalid'])('명시된 잘못된 scope %s는 legacy로 바꾸지 않고 RPC 거부를 유지한다', async retention_scope => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    for (const row of [packet.before, packet.sourceBasic, packet.expectedBasic]) Object.assign(row, { retention_scope });
    const { client, calls } = db(packet);
    client.rpc.mockImplementation(() => ({ abortSignal: async () => ({
      data: null, error: { code: 'P0001' }, status: 400,
    }) }) as any);
    await expect(preserveLegacyTeamRetentionPackets(client as any, [packet]))
      .rejects.toThrow('retention-legacy-team-write-unverified');
    expect(client.rpc).toHaveBeenCalledWith('recover_retention_legacy_team', { p_packet: packet });
    expect(calls).toEqual([]);
  });
  it.each(['response', 'readback', 'ambiguous'])('%s의 변경된 scope는 과거 packet과 같다고 인정하지 않는다', async phase => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const changed = { ...packet, expectedBasic: { ...packet.expectedBasic, retention_scope: 'detail' } };
    const { client } = db(changed);
    if (phase !== 'response') {
      client.rpc.mockImplementation(() => ({
        abortSignal: async () => {
          if (phase === 'ambiguous') return { data: null, error: { message: 'transport failure' }, status: 504 };
          return { data: { saved: true, basic: packet.expectedBasic }, error: null, status: 200 };
        },
      }) as any);
    }
    await expect(preserveLegacyTeamRetentionPackets(client as any, [packet]))
      .rejects.toThrow(phase === 'response' ? 'retention-legacy-team-write-unverified' : 'retention-legacy-team-readback-unverified');
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
  it('halts cleanup when readback content differs even after a successful response', async () => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    await expect(preserveLegacyTeamRetentionPackets(db(packet, true).client as any, [packet]))
      .rejects.toThrow('retention-legacy-team-readback-unverified');
  });
  it.each([0, 502, 503, 504])('verifies a committed write after an ambiguous HTTP %i response without repeating it', async status => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const { client, calls } = db(packet);
    client.rpc.mockImplementation(() => ({ abortSignal: async () => ({
      data: null, error: { message: 'private transport details' }, status,
    }) }) as any);
    expect(await preserveLegacyTeamRetentionPackets(client as any, [packet])).toBe(1);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['pubg_player_matches', 'pubg_match_performance']);
  });
  it('keeps deletion blocked when an ambiguous response has no matching saved summary', async () => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const { client } = db(packet, true);
    client.rpc.mockImplementation(() => ({ abortSignal: async () => ({
      data: null, error: { message: 'private transport details' }, status: 504,
    }) }) as any);
    await expect(preserveLegacyTeamRetentionPackets(client as any, [packet]))
      .rejects.toThrow('retention-legacy-team-readback-unverified');
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403])('does not reconcile an explicit HTTP %i rejection through an existing row', async status => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const { client, calls } = db(packet);
    client.rpc.mockImplementation(() => ({ abortSignal: async () => ({
      data: null, error: { code: 'P0001', message: 'private database details' }, status,
    }) }) as any);
    await expect(preserveLegacyTeamRetentionPackets(client as any, [packet]))
      .rejects.toThrow('retention-legacy-team-write-unverified');
    expect(calls).toEqual([]);
  });
  it('does not accept an invalid success response even when readback could match', async () => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const { client, calls } = db(packet);
    client.rpc.mockImplementation(() => ({ abortSignal: async () => ({
      data: { saved: true, basic: { ...packet.expectedBasic, kills: 999 } }, error: null, status: 200,
    }) }) as any);
    await expect(preserveLegacyTeamRetentionPackets(client as any, [packet]))
      .rejects.toThrow('retention-legacy-team-write-unverified:200');
    expect(calls).toEqual([]);
  });
  it.each(['lock-unavailable', 'lock-budget-exceeded', 'snapshot-changed', 'active-lease', 'target-exists', 'validation-rejected'])(
    'reports only the fixed database rejection reason %s', async details => {
      const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
      const client = { rpc: () => ({ abortSignal: async () => ({
        error: { message: 'PRIVATE_SENTINEL', details }, status: 400,
      }) }) };
      await expect(preserveLegacyTeamRetentionPackets(client as any, [packet]))
        .rejects.toThrow(`retention-legacy-team-write-unverified:400:${details}`);
    });
  it('redacts database details outside the fixed rejection reasons', async () => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const client = { rpc: () => ({ abortSignal: async () => ({
      error: { message: 'PRIVATE_SENTINEL', details: 'private row contents' }, status: 400,
    }) }) };
    const message = await preserveLegacyTeamRetentionPackets(client as any, [packet]).catch(error => error.message);
    expect(message).toBe('retention-legacy-team-write-unverified:400:unknown');
  });
  it('does not expose failed database responses', async () => {
    const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
    const client = { rpc: () => ({ abortSignal: async () => ({ error: { message: 'private data' } }) }) };
    await expect(preserveLegacyTeamRetentionPackets(client as any, [packet])).rejects.toThrow('retention-legacy-team-write-unverified');
  });
});

describe('격리 RPC 검증 seed의 과거 packet 호환성', () => {
  const program = ts.transpileModule(readFileSync('scripts/verify_legacy_team_retention_rpc.mts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  it.each(['missing', 'legacy', 'basic_only', 'detail', null, 'invalid'])(
    '전체 record INSERT 전에 %s scope를 보완하거나 그대로 유지한다', retention_scope => {
      const packet = planLegacyTeamRetentionRecovery(input()).packets[0];
      if (retention_scope !== 'missing') {
        for (const row of [packet.before, packet.sourceBasic, packet.expectedBasic]) Object.assign(row, { retention_scope });
      }
      const snapshot = structuredClone(packet);
      let sql = '';
      const spawn = vi.fn((_command: string, _args: string[], options: { input: string }) => {
        sql = options.input;
        return { status: 0, stdout: '', stderr: '' };
      });
      runInNewContext(program, {
        exports: {}, Buffer,
        process: { env: { BGMS_RETENTION_PACKET_FILE: '/private/packet.json',
          BGMS_RETENTION_PGHOST: '127.0.0.1', BGMS_RETENTION_PGPORT: '5432' }, stdout: { write: vi.fn() } },
        require: (name: string) => {
          if (name === 'node:fs') return { readFileSync: () => JSON.stringify([packet]), statSync: () => ({ mode: 0o600 }) };
          if (name === 'node:child_process') return { spawnSync: spawn };
          if (name === 'node:os') return { tmpdir: () => '/tmp' };
          if (name === 'node:path') return { join: (...parts: string[]) => parts.join('/') };
          throw new Error('unexpected verification dependency');
        },
      });
      const records = [...sql.matchAll(/decode\('([A-Za-z0-9+/=]+)','base64'\)/g)]
        .map(match => JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')));
      expect(records).toEqual([
        { retention_scope: 'legacy', ...packet.before },
        { retention_scope: 'legacy', ...packet.sourceBasic }, packet.processedSource,
        { retention_scope: 'legacy', ...packet.expectedBasic }, packet.fullResult, packet.performance,
      ]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(sql).toContain('jsonb_populate_record(null::public.pubg_player_matches, p.before_row)');
      expect(sql).toContain('jsonb_populate_record(null::public.pubg_player_matches, p.source_basic)');
      expect(packet).toEqual(snapshot);
    });
});
