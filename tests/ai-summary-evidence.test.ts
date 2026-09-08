import { describe, expect, it } from 'vitest';
import { buildSummaryCardEvidence } from '../lib/pubg-analysis/aiSummaryCardEvidence';

describe('server summary card evidence', () => {
  it('keeps utility composition, rescue attempts, and rescue success separate', () => {
    const rows = buildSummaryCardEvidence({ totalUtilityThrows: 17, totalObservedSmokes: 8, totalLethalThrows: 8, totalObservedRescueSmokes: 1, totalTeammateKnocks: 3, totalSmokeRescues: 0 }, {
      sampleCount: 42, avgSmokeRate: 5.55555555555556, metricSampleCounts: { avgSmokeRate: 36 },
    });
    expect(rows.find(row => row.metricId === 'utility_throws')).toMatchObject({ userValue: '17회', benchmarkValue: null });
    expect(rows.find(row => row.metricId === 'utility_smokes')?.userValue).toBe('8회');
    expect(rows.find(row => row.metricId === 'utility_lethal_throws')?.userValue).toBe('8회');
    expect(rows.find(row => row.metricId === 'smoke_rescue_attempts')?.userValue).toBe('1회');
    expect(rows.find(row => row.metricId === 'smoke_opportunity_rate')).toMatchObject({ userValue: '0%', benchmarkValue: '5.6%', numerator: 0, denominator: 3, sampleCount: 36 });
    expect(buildSummaryCardEvidence({}, null).find(row => row.metricId === 'utility_smokes')?.userValue).toBeNull();
  });
  it('distinguishes missing, partial, and observed zero opportunity records', () => {
    const rows = buildSummaryCardEvidence({
      mLen: 4, avgDamage: 0, totalUtilityThrows: null,
      totalDuelWins: 0, totalDuelLosses: 0, avgDuelWinRate: null,
      totalTradeKills: 0, totalTeammateKnocks: 0,
      metricMatchCounts: { damage_average: 1, utility_throws: 3, duel_win_rate: 0, trade_success_rate: 4 },
    }, null);
    expect(rows.find(row => row.metricId === 'damage_average')).toMatchObject({ userValue: '0', userMatchCount: 1 });
    expect(rows.find(row => row.metricId === 'utility_throws')).toMatchObject({ userValue: null, userMatchCount: 3, unavailableReason: '선택된 4경기 중 3경기만 기록이 확인되어 전체 합계·비율을 표시하지 않습니다.' });
    expect(rows.find(row => row.metricId === 'duel_win_rate')).toMatchObject({ userValue: null, userMatchCount: 0, unavailableReason: '이 지표를 측정할 수 있는 기록이 없습니다.' });
    expect(rows.find(row => row.metricId === 'trade_success_rate')).toMatchObject({ userValue: null, userMatchCount: 4, unavailableReason: '해당 지표를 계산할 기회가 관측되지 않았습니다.' });
  });
  it('explains absent successful revenge and kill-composition samples without calling them failures', () => {
    const rows = buildSummaryCardEvidence({
      totalTradeKills: 0, avgBackupLatency: '측정 불가', soloKillRate: null,
      killContribFinal: { solo: 0, cleanup: 0, assist: 0 },
      metricMatchCounts: { backup_latency: 0, solo_kill_share: 4 },
    }, null);
    expect(rows.find(row => row.metricId === 'backup_latency')).toMatchObject({ userValue: null, unavailableReason: '복수 처치 성공 사례가 없어 시간을 계산할 수 없습니다.' });
    expect(rows.find(row => row.metricId === 'solo_kill_share')).toMatchObject({ userValue: null, denominator: 0, unavailableReason: '해당 지표를 계산할 기회가 관측되지 않았습니다.' });
  });
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
