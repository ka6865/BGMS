import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRetainedPerformanceRow } from '../lib/pubg/retainedPerformance';
import { createSharedTelemetrySource } from '../lib/pubg-analysis/sharedTelemetrySourceContract';
import { preserveExpiredMatchPerformance, retainedRowMatchesBasic } from '../lib/pubg-analysis/retentionPerformanceRecovery';
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from '../lib/pubg-analysis/constants';

const mocks = vi.hoisted(() => ({ preserve: vi.fn(), calculate: vi.fn() }));
vi.mock('../scripts/preserve_match_performance', () => ({ preservePerformanceRows: mocks.preserve }));
vi.mock('../lib/pubg-analysis/AnalysisEngine', () => ({ AnalysisEngine: class { run = mocks.calculate; } }));
const matchId = 'f6c1d2b3-1111-4222-8333-444455556666';
const playedAt = '2026-09-01T00:00:00Z';
const basic = { account_id: 'account.target', player_id: 'target', platform: 'steam', match_id: matchId,
  played_at: playedAt, game_mode: 'squad', map_name: 'Baltic_Main', match_type: 'official', kills: 3, damage: 400, win_place: 2 };
const full = { matchId, platform: 'steam', player_id: 'target', v: RESULT_VERSION,
  calculationVersion: ANALYSIS_CALCULATION_VERSION, createdAt: playedAt, mapName: 'Erangel', gameMode: 'squad', matchType: 'official',
  stats: { name: 'Target', playerId: 'account.target', kills: 3, damageDealt: 400.9, winPlace: 2, timeSurvived: 1200 },
  isValidBenchmark: false, benchmark: null };
const row = () => buildRetainedPerformanceRow(full, { matchId, platform: 'steam', playerId: 'target' })!;
function source(platform: 'steam' | 'kakao' = 'steam') {
  return createSharedTelemetrySource({ data: { id: matchId, attributes: {
    createdAt: playedAt, gameMode: 'squad', matchType: 'official', mapId: 'Baltic_Main', mapName: 'Baltic_Main', duration: 1200,
  } }, included: [
    { type: 'participant', id: 'p1', attributes: { stats: full.stats } },
    { type: 'roster', id: 'r1', relationships: { participants: { data: [{ id: 'p1', type: 'participant' }] } } },
  ] }, platform, [ { _T: 'LogMatchStart', _D: playedAt },
    { _T: 'LogPlayerPosition', character: { name: 'Target', accountId: 'account.target' } },
    { _T: 'LogMatchEnd', _D: '2026-09-01T00:20:00Z' } ]);
}
const input = () => ({ matchId, platform: 'steam' as const, basics: [{ ...basic }],
  processed: [{ match_id: matchId, platform: 'steam', player_id: 'target', data: { fullResult: full } }],
  performances: [] as any[], now: Date.parse('2026-10-07T00:00:00Z') });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.preserve.mockImplementation(async (_db, rows) => rows.length);
  mocks.calculate.mockReturnValue(full);
});
describe('expired archive performance preservation', () => {
  it('copies an observed DB result and waits for verified persistence', async () => {
    const result = await preserveExpiredMatchPerformance({} as any, input());
    expect(result).toEqual({ linkedAccounts: 0, savedSummaries: 1, recoveredSummaries: 0 });
    expect(mocks.preserve.mock.calls[0][1]).toEqual([row()]);
    expect(mocks.calculate).not.toHaveBeenCalled();
  });
  it.each([{ kills: 4 }, { damage: 401 }, { win_place: 3 }, { played_at: '2026-09-02T00:00:00Z' }])(
    'protects a result whose measured basic values differ: %s', async (changed) => {
      const i = input(); Object.assign(i.basics[0], changed);
      expect(await preserveExpiredMatchPerformance({} as any, i)).toMatchObject({ savedSummaries: 0 });
      expect(mocks.preserve.mock.calls[0][1]).toEqual([]);
    });
  it('does not infer a missing account from a display name or fullResult alone', async () => {
    const db = { from: vi.fn() }; const i: any = input(); i.basics[0].account_id = null;
    expect(await preserveExpiredMatchPerformance(db as any, i)).toMatchObject({ linkedAccounts: 0, savedSummaries: 0 });
    expect(db.from).not.toHaveBeenCalled();
  });
  it('links only the exact observed row using official archived match and real account events', async () => {
    const filters: any[] = []; const update = vi.fn(); const q: any = {
      eq: (k: string, v: any) => { filters.push([k, v]); return q; }, is: (k: string, v: any) => { filters.push([k, v]); return q; },
      select: () => q, abortSignal: async () => ({ data: [{ ...basic }], error: null }),
    }; update.mockReturnValue(q);
    const db: any = { from: () => ({ update }) }; const i: any = input(); i.basics[0].account_id = null; i.source = source();
    expect(await preserveExpiredMatchPerformance(db, i)).toMatchObject({ linkedAccounts: 1, savedSummaries: 1 });
    expect(update).toHaveBeenCalledWith({ account_id: 'account.target' });
    expect(filters).toEqual(expect.arrayContaining([['account_id', null], ['played_at', playedAt], ['kills', 3], ['damage', 400], ['win_place', 2]]));
  });
  it('stops if conditional account binding changed or its readback failed', async () => {
    const q: any = { eq: () => q, is: () => q, select: () => q, abortSignal: async () => ({ data: [], error: null }) };
    const i: any = input(); i.basics[0].account_id = null; i.source = source();
    await expect(preserveExpiredMatchPerformance({ from: () => ({ update: () => q }) } as any, i))
      .rejects.toThrow('retention-account-binding-unverified');
    expect(mocks.preserve).not.toHaveBeenCalled();
  });
  it('reconstructs a missing result only from complete exact shared source without new ranking eligibility', async () => {
    mocks.calculate.mockReturnValue({ ...full, benchmark: { score: 80, tier: 'A' }, isValidBenchmark: true });
    const i: any = input(); i.processed = []; i.source = source();
    expect(await preserveExpiredMatchPerformance({} as any, i)).toMatchObject({ savedSummaries: 1, recoveredSummaries: 1 });
    expect(mocks.calculate.mock.calls[0][6]).toEqual({ sampleCount: 0 });
    expect(mocks.preserve.mock.calls[0][1][0].ranking_eligible).toBe(false);
    expect(mocks.preserve.mock.calls[0][1][0].score).toBeNull();
    expect(mocks.preserve.mock.calls[0][1][0].benchmark).toBeNull();
  });
  it.each([source('kakao'), { ...source(), checksum: '0'.repeat(64) }])('protects cross-platform or corrupted source', async (archive) => {
    const i: any = input(); i.processed = []; i.source = archive;
    expect(await preserveExpiredMatchPerformance({} as any, i)).toMatchObject({ recoveredSummaries: 0 });
    expect(mocks.calculate).not.toHaveBeenCalled();
  });
  it('protects incomplete existing fullResult instead of replacing it with new arithmetic', async () => {
    const i: any = input(); i.processed[0].data.fullResult = { invalid: true }; i.source = source();
    expect(await preserveExpiredMatchPerformance({} as any, i)).toMatchObject({ recoveredSummaries: 0 });
    expect(mocks.calculate).not.toHaveBeenCalled();
  });
  it('keeps completed and future retained summaries and honors the calculation budget', async () => {
    const i: any = input(); i.performances = [row()]; i.source = source();
    expect(await preserveExpiredMatchPerformance({} as any, i)).toMatchObject({ savedSummaries: 0 });
    i.performances = []; i.processed = []; i.maxCalculations = 0;
    expect(await preserveExpiredMatchPerformance({} as any, i)).toMatchObject({ recoveredSummaries: 0 });
    expect(mocks.calculate).not.toHaveBeenCalled();
  });
  it('fails closed when verified DB persistence rejects and does not hide the failure', async () => {
    mocks.preserve.mockRejectedValue(new Error('preserve-performance-readback-failed'));
    await expect(preserveExpiredMatchPerformance({} as any, input())).rejects.toThrow('preserve-performance-readback-failed');
  });
  it('does no writes for a recent match or copied identity', async () => {
    const i = input(); i.now = Date.parse(playedAt) + 1000;
    expect(await preserveExpiredMatchPerformance({} as any, i)).toMatchObject({ savedSummaries: 0 });
    expect(mocks.preserve).not.toHaveBeenCalled();
    expect(retainedRowMatchesBasic(row(), { ...basic, account_id: 'account.copy' })).toBe(false);
  });
});
