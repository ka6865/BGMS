import { hasObservedBenchmarkMetric, type NormalizedBenchmark, type ObservedBenchmark } from './benchmarkAdapter';
import type { SummaryEvidenceInput } from './aiSummaryCards';

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?(?:s)?$/.test(value) ? Number(value.replace(/s$/, '')) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function rate(numerator: unknown, denominator: unknown): number | null {
  const n = numberOrNull(numerator);
  const d = numberOrNull(denominator);
  return n !== null && d !== null && d > 0 ? Math.min(100, Math.round(n / d * 100)) : null;
}

/** Assemble only observed user values and independently sampled benchmark values. */
export function buildSummaryCardEvidence(stats: Record<string, unknown>, benchmark: ObservedBenchmark | null): SummaryEvidenceInput[] {
  const entries: SummaryEvidenceInput[] = [];
  const add = (metricId: string, label: string, user: unknown, unit: string, benchmarkKey?: keyof NormalizedBenchmark, numerator?: unknown, denominator?: unknown) => {
    const value = numberOrNull(user);
    const benchmarkObserved = benchmarkKey !== undefined && hasObservedBenchmarkMetric(benchmark, benchmarkKey);
    const comparison = benchmarkObserved && benchmark ? numberOrNull(benchmark[benchmarkKey!]) : null;
    const format = (n: number | null) => n === null ? null : `${Number(n.toFixed(unit === '%' ? 1 : 2))}${unit}`;
    const denominatorValue = numberOrNull(denominator);
    const userValue = denominator !== undefined && (denominatorValue === null || denominatorValue <= 0) ? null : format(value);
    entries.push({
      metricId, label, userValue,
      benchmarkLabel: `동일 티어 평균 ${label.replace(/^평균 /, '')}`,
      benchmarkValue: comparison === null ? null : format(comparison),
      unit,
      sampleCount: benchmarkObserved && benchmarkKey ? benchmark?.metricSampleCounts?.[benchmarkKey] ?? null : null,
      ...(numerator !== undefined ? { numerator: numberOrNull(numerator) } : {}),
      ...(denominator !== undefined ? { denominator: denominatorValue } : {}),
      ...(userValue === null ? { unavailableReason: denominator !== undefined && denominatorValue === 0 ? '해당 지표를 계산할 기회가 관측되지 않았습니다.' : '이 지표를 측정할 수 있는 기록이 없습니다.' } : comparison === null ? { unavailableReason: '같은 조건의 비교 자료가 없습니다.' } : {}),
    });
  };
  add('damage_average', '평균 화력', stats.avgDamage, '', 'avgDamage');
  add('initiative_rate', '주도권 성공률', stats.userInitiativeRate, '%', 'avgInitiativeRate', stats.totalInitiativeSuccess, stats.totalInitiativeAttempts);
  const duelCount = numberOrNull(stats.totalDuelWins) !== null && numberOrNull(stats.totalDuelLosses) !== null ? Number(stats.totalDuelWins) + Number(stats.totalDuelLosses) : null;
  add('duel_win_rate', '1:1 교전 승률', stats.avgDuelWinRate, '%', 'avgDuelWinRate', stats.totalDuelWins, duelCount);
  add('pressure_index', '평균 압박 지수', stats.avgPressureIndex, '', 'avgPressureIndex');
  add('reaction_latency', '대응 사격 속도', stats.avgReactionLatency, 's', 'avgCounterLatency');
  add('backup_latency', '백업 속도', stats.avgBackupLatency, 's', 'avgTradeLatency');
  add('trade_success_rate', '복수 성공률', rate(stats.totalTradeKills, stats.totalTeammateKnocks), '%', 'avgTradeRate', stats.totalTradeKills, stats.totalTeammateKnocks);
  add('smoke_opportunity_rate', '아군 기절 대비 연막 구출률', rate(stats.totalSmokeRescues, stats.totalTeammateKnocks), '%', 'avgSmokeRate', stats.totalSmokeRescues, stats.totalTeammateKnocks);
  add('solo_kill_share', '솔로 킬 비중', stats.soloKillRate, '%', 'avgSoloKillRate');
  add('utility_throws', '총 투척 횟수', stats.totalUtilityThrows, '회');
  add('isolation_average', '평균 고립 지수', stats.avgIsolationStr, '');
  add('death_phase', '평균 사망 페이즈', stats.avgDeathPhase, '', 'avgDeathPhase');
  return entries;
}
