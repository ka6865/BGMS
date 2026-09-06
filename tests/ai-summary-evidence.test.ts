import { describe, expect, it } from 'vitest';
import { buildSummaryCardEvidence } from '../lib/pubg-analysis/aiSummaryCardEvidence';

describe('server summary card evidence', () => {
  const stats = { avgDamage: 320, userInitiativeRate: 0, totalInitiativeSuccess: 0, totalInitiativeAttempts: 2, totalTradeKills: 0, totalTeammateKnocks: 0, totalSmokeRescues: 0, avgDuelWinRate: null, totalDuelWins: 0, totalDuelLosses: 0, totalUtilityThrows: 0, avgIsolationStr: '측정 불가', avgDeathPhase: null };
  it('keeps observed zero and unknown user values distinct without a benchmark', () => {
    const rows = buildSummaryCardEvidence(stats, null);
    expect(rows.find(row => row.metricId === 'initiative_rate')?.userValue).toBe('0%');
    expect(rows.find(row => row.metricId === 'utility_throws')?.userValue).toBe('0회');
    expect(rows.find(row => row.metricId === 'isolation_average')?.userValue).toBeNull();
    expect(rows.find(row => row.metricId === 'duel_win_rate')?.userValue).toBeNull();
    expect(rows.every(row => row.benchmarkValue === null)).toBe(true);
  });
  it('never turns absent opportunities or undersampled comparisons into zero evidence', () => {
    const rows = buildSummaryCardEvidence(stats, { sampleCount: 10, avgDamage: 300, metricSampleCounts: { avgDamage: 4 } });
    expect(rows.find(row => row.metricId === 'damage_average')?.benchmarkValue).toBeNull();
    expect(rows.find(row => row.metricId === 'smoke_opportunity_rate')).toMatchObject({ userValue: null, denominator: 0 });
    expect(rows.find(row => row.metricId === 'trade_success_rate')?.userValue).toBeNull();
  });
  it('preserves valid benchmark zero and formats rates without floating point tails', () => {
    const rows = buildSummaryCardEvidence(stats, { sampleCount: 10, avgDamage: 0, avgInitiativeRate: 61.2647058823529, metricSampleCounts: { avgDamage: 5, avgInitiativeRate: 5 } });
    expect(rows.find(row => row.metricId === 'damage_average')?.benchmarkValue).toBe('0');
    expect(rows.find(row => row.metricId === 'initiative_rate')).toMatchObject({ benchmarkValue: '61.3%', sampleCount: 5 });
  });
});
