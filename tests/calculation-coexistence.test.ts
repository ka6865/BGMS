import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_CALCULATION_VERSION } from '../lib/pubg-analysis/constants';
import { getValidFullResultForMatch, hasCurrentCalculation, hasSupportedCalculation } from '../lib/pubg-analysis/cacheIdentity';
import { CALCULATION_5_FULL_SWITCH_MIN_MATCHES, CALCULATION_5_REDEFINED_METRICS, fetchTierBenchmarkStats } from '../lib/pubg-analysis/benchmarkLookup';
import { adaptObservedBenchmark } from '../lib/pubg-analysis/benchmarkAdapter';

describe('기존 계산 보존과 신규 계산 공존', () => {
  it.each([2, 3, 4, 5])('계산 %s를 그대로 조회하며 신규 writer 기준은 5이다', calculationVersion => {
    const fullResult = { matchId: 'match', player_id: 'player', platform: 'steam', v: 73,
      calculationVersion, populationEvidenceVersion: 1, stats: { name: 'Player' },
      benchmark: { score: 77, impactScore: calculationVersion === 2 ? 88 : 84 } };
    const row = { match_id: 'match', player_id: 'player', platform: 'steam', data: { fullResult } };
    const snapshot = structuredClone(row);
    expect(getValidFullResultForMatch(row, { matchId: 'match', playerId: 'player', platform: 'steam',
      minResultVersion: 73, requireSupportedCalculation: true, requirePopulationEvidence: true })).toEqual(fullResult);
    expect(row).toEqual(snapshot);
    expect(hasCurrentCalculation(fullResult)).toBe(calculationVersion === 5);
    expect(ANALYSIS_CALCULATION_VERSION).toBe(5);
  });

  it.each([undefined, null, 1, 6, '2', '3', '4', '5'])('미지원 계산 %s는 조회 근거로 허용하지 않는다', calculationVersion => {
    expect(hasSupportedCalculation({ calculationVersion })).toBe(false);
  });

  it('v2만 있는 운영 표본을 계속 읽고 v3 표본이 생기면 관측 수로 함께 집계한다', async () => {
    const rows = [2, 3].map(calculation_version => ({ tier: 'A+', filter_version: 8,
      population_evidence_version: 1, calculation_version, match_count: calculation_version === 2 ? 6 : 2,
      avg_damage: calculation_version === 2 ? 200 : 600, avg_damage_count: calculation_version === 2 ? 6 : 2 }));
    let includeNew = false;
    const db = { from: () => {
      let calculation: unknown;
      const query: any = { select: vi.fn().mockReturnThis(), eq: vi.fn((key, value) => {
        if (key === 'calculation_version') calculation = value;
        return query;
      }), maybeSingle: async () => ({ data: rows.find(row => row.calculation_version === calculation
        && (includeNew || calculation === 2)) ?? null, error: null }) };
      return query;
    } };
    const scope = { gameMode: 'squad', matchType: 'official', tier: 'A+' };
    expect(await fetchTierBenchmarkStats(db, scope)).toMatchObject({ match_count: 6, avg_damage: 200 });
    includeNew = true;
    expect(await fetchTierBenchmarkStats(db, scope)).toMatchObject({ tier: 'A+', match_count: 8,
      avg_damage: 300, avg_damage_count: 8 });
  });

  describe('계산 5에서 의미가 바뀐 지표', () => {
    function benchmarkDb(rows: any[]) {
      return { from: () => {
        let calculation: unknown;
        const query: any = { select: vi.fn().mockReturnThis(), eq: vi.fn((key, value) => {
          if (key === 'calculation_version') calculation = value;
          return query;
        }), in: vi.fn().mockReturnThis(), limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: rows.find(row => row.calculation_version === calculation) ?? null, error: null }) };
        return query;
      } };
    }
    const row = (calculation_version: number, match_count: number, damage: number, wipes: number) => ({
      tier: 'A', filter_version: 8, population_evidence_version: 1, calculation_version, match_count,
      avg_damage: damage, avg_damage_count: match_count, avg_team_wipes: wipes, avg_team_wipes_count: match_count,
      avg_revive_rate: wipes * 10, avg_revive_rate_count: match_count });
    const scope = { gameMode: 'squad', matchType: 'official', tier: 'A' };

    it('계산 5 표본이 없으면 의미가 바뀐 지표를 비교에서 뺀다', async () => {
      const stats = await fetchTierBenchmarkStats(benchmarkDb([row(3, 40, 300, 2), row(4, 60, 400, 3)]), scope);
      expect(stats).toMatchObject({ tier: 'A', match_count: 100, avg_damage: 360, avg_damage_count: 100 });
      expect(stats.avg_team_wipes).toBeUndefined();
      expect(stats.avg_team_wipes_count).toBeUndefined();
      expect(stats.avg_revive_rate).toBeUndefined();
      expect(adaptObservedBenchmark(stats)).not.toHaveProperty('avgTeamWipes');
    });

    it('의미가 바뀐 지표는 계산 5끼리, 나머지는 2~5를 합쳐 비교한다', async () => {
      const stats = await fetchTierBenchmarkStats(benchmarkDb([row(4, 90, 400, 3), row(5, 10, 500, 1)]), scope);
      expect(stats).toMatchObject({ match_count: 100, avg_damage: 410, avg_damage_count: 100,
        avg_team_wipes: 1, avg_team_wipes_count: 10, avg_revive_rate: 10, avg_revive_rate_count: 10, calculation_version: 5 });
      expect(adaptObservedBenchmark(stats)).toMatchObject({ sampleCount: 100, avgDamage: 410, avgTeamWipes: 1 });
    });

    it('계산 5 표본이 5 미만이면 그 지표만 노출하지 않는다', async () => {
      const stats = await fetchTierBenchmarkStats(benchmarkDb([row(4, 90, 400, 3), row(5, 3, 500, 1)]), scope);
      expect(stats).toMatchObject({ match_count: 93, avg_team_wipes: 1, avg_team_wipes_count: 3 });
      const observed = adaptObservedBenchmark(stats);
      expect(observed).toHaveProperty('avgDamage');
      expect(observed).not.toHaveProperty('avgTeamWipes');
    });

    it(`칸의 계산 5 표본이 ${CALCULATION_5_FULL_SWITCH_MIN_MATCHES}경기 이상이면 모든 지표를 계산 5로만 비교한다`, async () => {
      const stats = await fetchTierBenchmarkStats(benchmarkDb([
        row(4, 900, 400, 3), row(5, CALCULATION_5_FULL_SWITCH_MIN_MATCHES, 500, 1)]), scope);
      expect(stats).toMatchObject({ match_count: CALCULATION_5_FULL_SWITCH_MIN_MATCHES, avg_damage: 500, avg_team_wipes: 1,
        calculation_version: 5 });
    });

    it('의미가 바뀐 지표 목록에는 API·위치 기반 지표가 없다', () => {
      for (const field of ['avg_damage', 'avg_kills', 'avg_survival_time', 'avg_isolation_index', 'avg_min_dist', 'avg_death_phase']) {
        expect(CALCULATION_5_REDEFINED_METRICS.has(field as any)).toBe(false);
      }
    });
  });
});
