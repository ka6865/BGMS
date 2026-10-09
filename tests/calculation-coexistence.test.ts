import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_CALCULATION_VERSION } from '../lib/pubg-analysis/constants';
import { getValidFullResultForMatch, hasCurrentCalculation, hasSupportedCalculation } from '../lib/pubg-analysis/cacheIdentity';
import { fetchTierBenchmarkStats } from '../lib/pubg-analysis/benchmarkLookup';

describe('기존 계산 보존과 신규 계산 공존', () => {
  it.each([2, 3])('계산 %s를 그대로 조회하며 신규 writer 기준은 3이다', calculationVersion => {
    const fullResult = { matchId: 'match', player_id: 'player', platform: 'steam', v: 73,
      calculationVersion, populationEvidenceVersion: 1, stats: { name: 'Player' },
      benchmark: { score: 77, impactScore: calculationVersion === 2 ? 88 : 84 } };
    const row = { match_id: 'match', player_id: 'player', platform: 'steam', data: { fullResult } };
    const snapshot = structuredClone(row);
    expect(getValidFullResultForMatch(row, { matchId: 'match', playerId: 'player', platform: 'steam',
      minResultVersion: 73, requireSupportedCalculation: true, requirePopulationEvidence: true })).toEqual(fullResult);
    expect(row).toEqual(snapshot);
    expect(hasCurrentCalculation(fullResult)).toBe(calculationVersion === 3);
    expect(ANALYSIS_CALCULATION_VERSION).toBe(3);
  });

  it.each([undefined, null, 1, 4, '2', '3'])('미지원 계산 %s는 조회 근거로 허용하지 않는다', calculationVersion => {
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
});
