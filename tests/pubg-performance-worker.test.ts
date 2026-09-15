import { describe, expect, it } from 'vitest';
import { performanceSettlement } from '../scripts/refresh_pubg_performance';

describe('performanceSettlement', () => {
  it('stores only ranking-eligible performance results', () => {
    const eligible = { benchmark: { score: 56.6, tier: 'B+' }, rankingEligible: true };

    expect(performanceSettlement(eligible)).toEqual({ state: 'done', result: eligible });
  });

  it('excludes a result without a publishable ranking tier', () => {
    const excluded = {
      benchmark: { score: 0, tier: null },
      rankingEligible: false,
    };

    expect(performanceSettlement(excluded)).toEqual({ state: 'excluded', result: null });
    expect(performanceSettlement(null)).toEqual({ state: 'excluded', result: null });
  });
});
