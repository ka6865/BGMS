import { describe, expect, it } from 'vitest';
import { adaptObservedBenchmark } from '../lib/pubg-analysis/benchmarkAdapter';
import { combineCalculationBenchmarkRows } from '../lib/pubg-analysis/benchmarkLookup';
import { buildSummaryCardEvidence } from '../lib/pubg-analysis/aiSummaryCardEvidence';
import { buildMatchAiCoachingPrompt } from '../lib/pubg-analysis/matchAiCoachingPrompt';
import { applyMatchAiEvidencePolicy } from '../lib/pubg-analysis/matchAiEvidence';

const row = (calculation_version: number, measured: number, failure: number) => ({
  tier: 'B', game_mode: 'squad', match_type: 'official', calculation_version, match_count: 20,
  avg_counter_latency_ms: 2100, avg_counter_latency_ms_count: 18,
  avg_measured_counter_latency_ms: measured, avg_measured_counter_latency_ms_count: 6,
  avg_counter_failure_rate: failure, avg_counter_failure_rate_count: 18,
});

describe('counter latency benchmark split', () => {
  it('exposes the measured latency and failure rate as separate observed metrics', () => {
    const observed = adaptObservedBenchmark(row(5, 612.3, 66.6667));
    expect(observed).toMatchObject({ avgCounterLatency: 2.1, avgMeasuredCounterLatency: 0.61, avgCounterFailureRate: 66.7 });
    expect(observed?.metricSampleCounts).toMatchObject({ avgMeasuredCounterLatency: 6, avgCounterFailureRate: 18 });
    expect(observed?.rawMetricValues?.avgMeasuredCounterLatency).toBeCloseTo(0.6123);
  });

  it('keeps an older view without the new columns unavailable instead of defaulting', () => {
    const { avg_measured_counter_latency_ms: _m, avg_counter_failure_rate: _f, ...legacy } = row(5, 600, 60);
    const observed = adaptObservedBenchmark(legacy);
    expect(observed?.avgCounterLatency).toBe(2.1);
    expect(observed?.avgMeasuredCounterLatency).toBeUndefined();
    expect(observed?.avgCounterFailureRate).toBeUndefined();
  });

  it('compares the split metrics only within the current calculation', () => {
    const combined = combineCalculationBenchmarkRows([row(4, 900, 90), row(5, 500, 50)], 'B');
    expect(combined.avg_measured_counter_latency_ms).toBe(500);
    expect(combined.avg_counter_failure_rate).toBe(50);
  });
});

describe('summary card counter evidence', () => {
  const benchmark = adaptObservedBenchmark(row(5, 600, 60));

  it('compares measured latency and failure rate against matching benchmarks', () => {
    const rows = buildSummaryCardEvidence({
      avgReactionLatency: '1.80s', avgMeasuredReactionLatency: '0.60s',
      counterFailureRate: 50, counterFailureMatches: 1, counterObservedMatches: 2,
      metricMatchCounts: { reaction_latency: 1, counter_failure_rate: 2 }, rawMetricValues: { reaction_latency: 0.6 },
    }, benchmark);
    expect(rows.find(r => r.metricId === 'reaction_latency')).toMatchObject({ userValue: '0.6s', benchmarkValue: '0.6s' });
    expect(rows.find(r => r.metricId === 'counter_failure_rate')).toMatchObject({ userValue: '50%', benchmarkValue: '60%', numerator: 1, denominator: 2 });
  });

  it('explains a missing reaction time when every observed match was a penalty', () => {
    const rows = buildSummaryCardEvidence({
      avgMeasuredReactionLatency: '측정 불가', counterFailureRate: 100, counterFailureMatches: 2, counterObservedMatches: 2,
      metricMatchCounts: { reaction_latency: 0, counter_failure_rate: 2 }, rawMetricValues: { reaction_latency: null },
    }, benchmark);
    expect(rows.find(r => r.metricId === 'reaction_latency')).toMatchObject({ userValue: null, unavailableReason: '3초 안에 반격한 경기가 없어 시간을 계산할 수 없습니다.' });
    expect(rows.find(r => r.metricId === 'counter_failure_rate')?.userValue).toBe('100%');
  });
});

describe('single match counter comparison', () => {
  const eliteBenchmark = adaptObservedBenchmark(row(5, 600, 60));
  const base = { mapName: 'Erangel', gameMode: 'squad', stats: { winPlace: 3, kills: 1, damageDealt: 200, timeSurvived: 900 }, eliteBenchmark };

  it('compares a measured reaction with the measured benchmark, not the penalty average', () => {
    const { playerReportSummary } = buildMatchAiCoachingPrompt({ matchData: { ...base, tradeStats: { reactionLatencyMs: 400 } } });
    expect(playerReportSummary).toContain('0.40s (Elite Avg, 3초 안에 반격한 경기 기준: 0.6s)');
    expect(playerReportSummary).not.toContain('2.1s');
  });

  it('compares a penalty match with the benchmark failure rate', () => {
    const { playerReportSummary } = buildMatchAiCoachingPrompt({ matchData: { ...base, tradeStats: { reactionLatencyMs: 3000 }, duelStats: { reversalAttempts: 2 } } });
    expect(playerReportSummary).toContain('3초 내 대응 피해 미관측');
    expect(playerReportSummary).toContain('Elite 3초 내 대응 실패율: 60%');
  });

  it('withholds a reaction comparison when only the legacy penalty average was stored', () => {
    const legacy = { sampleCount: 20, avgCounterLatency: 2.1, metricSampleCounts: { avgCounterLatency: 18 } };
    const input = { briefFeedback: ['대응 사격 속도 0.40초로 비교 평균보다 빨랐습니다.'] };
    const result = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(input), { tradeStats: { reactionLatencyMs: 400 }, eliteBenchmark: legacy }));
    expect(result.briefFeedback[0]).toBe('같은 조건의 비교 자료가 없어 상대 평가는 보류합니다.');
  });
});
