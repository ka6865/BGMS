import { hasComparableBenchmarkMetric, hasObservedBenchmarkMetric, MIN_COMPARISON_SAMPLE_COUNT, type NormalizedBenchmark, type ObservedBenchmark } from './benchmarkAdapter';
import type { SummaryEvidenceInput } from './aiSummaryCards';

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?(?:s)?$/.test(value) ? Number(value.replace(/s$/, '')) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function rate(numerator: unknown, denominator: unknown): number | null {
  const n = numberOrNull(numerator);
  const d = numberOrNull(denominator);
  return n !== null && d !== null && d > 0 ? Math.min(100, n / d * 100) : null;
}

/** Assemble only observed user values and independently sampled benchmark values. */
export function buildSummaryCardEvidence(stats: Record<string, unknown>, benchmark: ObservedBenchmark | null): SummaryEvidenceInput[] {
  const entries: SummaryEvidenceInput[] = [];
  const add = (metricId: string, label: string, user: unknown, unit: string, benchmarkKey?: keyof NormalizedBenchmark, numerator?: unknown, denominator?: unknown) => {
    const counts = stats.metricMatchCounts as Record<string, number> | undefined;
    const userMatchCount = counts?.[metricId];
    const rawValues = stats.rawMetricValues as Record<string, unknown> | undefined;
    const value = unit === '%' && numerator !== undefined && denominator !== undefined
      ? rate(numerator, denominator)
      : numberOrNull(rawValues && Object.hasOwn(rawValues, metricId) ? rawValues[metricId] : user);
    const benchmarkObserved = benchmarkKey !== undefined && hasComparableBenchmarkMetric(benchmark, benchmarkKey);
    const smallBenchmark = benchmarkKey !== undefined && !benchmarkObserved && hasObservedBenchmarkMetric(benchmark, benchmarkKey);
    const comparison = benchmarkObserved && benchmark ? numberOrNull(benchmark.rawMetricValues?.[benchmarkKey!] ?? benchmark[benchmarkKey!]) : null;
    const format = (n: number | null) => n === null ? null : `${Number(n.toFixed(unit === '%' ? 1 : 2))}${unit}`;
    const denominatorValue = numberOrNull(denominator);
    const userValue = denominator !== undefined && (denominatorValue === null || denominatorValue <= 0) ? null : format(value);
    entries.push({
      metricId, label, userValue,
      userNumericValue: userValue === null ? null : value,
      benchmarkNumericValue: comparison,
      ...(userMatchCount !== undefined ? { userMatchCount } : {}),
      benchmarkLabel: `동일 티어 평균 ${label.replace(/^평균 /, '')}`,
      benchmarkValue: comparison === null ? null : format(comparison),
      unit,
      sampleCount: benchmarkObserved && benchmarkKey ? benchmark?.metricSampleCounts?.[benchmarkKey] ?? null : null,
      ...(numerator !== undefined ? { numerator: numberOrNull(numerator) } : {}),
      ...(denominator !== undefined ? { denominator: denominatorValue } : {}),
      ...(userValue === null ? { unavailableReason: denominator !== undefined && denominatorValue === 0 ? '해당 지표를 계산할 기회가 관측되지 않았습니다.' : '이 지표를 측정할 수 있는 기록이 없습니다.' } : comparison === null ? { unavailableReason: smallBenchmark ? `비교 표본이 ${MIN_COMPARISON_SAMPLE_COUNT}경기 미만이라 비교하지 않습니다.` : '같은 조건의 비교 자료가 없습니다.' } : {}),
    });
    const entry = entries[entries.length - 1];
    if (userMatchCount === 0) {
      entry.userValue = null;
      entry.userNumericValue = null;
      entry.unavailableReason = metricId === 'backup_latency' && numberOrNull(stats.totalTradeKills) === 0
        ? '복수 처치 성공 사례가 없어 시간을 계산할 수 없습니다.'
        : metricId === 'reaction_latency' && (numberOrNull(stats.counterObservedMatches) ?? 0) > 0
          ? '3초 안에 반격한 경기가 없어 시간을 계산할 수 없습니다.'
          : '이 지표를 측정할 수 있는 기록이 없습니다.';
    } else if (entry.userValue === null && userMatchCount !== undefined && typeof stats.mLen === 'number' && userMatchCount < stats.mLen) {
      entry.unavailableReason = `선택된 ${stats.mLen}경기 중 ${userMatchCount}경기만 기록이 확인되어 전체 합계·비율을 표시하지 않습니다.`;
    }
  };
  add('damage_average', '평균 화력', stats.avgDamage, '', 'avgDamage');
  add('initiative_rate', '선제 타격 성공률', stats.userInitiativeRate, '%', 'avgInitiativeRate', stats.totalInitiativeSuccess, stats.totalInitiativeAttempts);
  const duelCount = numberOrNull(stats.totalDuelWins) !== null && numberOrNull(stats.totalDuelLosses) !== null ? Number(stats.totalDuelWins) + Number(stats.totalDuelLosses) : null;
  add('duel_win_rate', '1:1 교전 승률', stats.avgDuelWinRate, '%', 'avgDuelWinRate', stats.totalDuelWins, duelCount);
  add('pressure_index', '평균 압박 지수', stats.avgPressureIndex, '', 'avgPressureIndex');
  // 3초 패널티 경기는 반응 시간이 아니므로 실측 평균과 실패율을 따로 비교한다.
  add('reaction_latency', '반격 소요 시간', stats.avgMeasuredReactionLatency, 's', 'avgFirstReplyLatency');
  add('counter_failure_rate', '3초 내 대응 실패율', stats.counterFailureRate, '%', 'avgCounterFailureRate', stats.counterFailureMatches, stats.counterObservedMatches);
  add('backup_latency', '백업 속도', stats.avgBackupLatency, 's', 'avgTradeLatency');
  add('trade_success_rate', '복수 성공률', rate(stats.totalTradeKills, stats.totalTeammateKnocks), '%', 'avgTradeRate', stats.totalTradeKills, stats.totalTeammateKnocks);
  add('smoke_opportunity_rate', '아군 기절 대비 연막 구출률', rate(stats.totalSmokeRescues, stats.totalTeammateKnocks), '%', 'avgSmokeRate', stats.totalSmokeRescues, stats.totalTeammateKnocks);
  const contributions = stats.killContribFinal as Record<string, unknown> | undefined;
  const contributionValues = contributions ? [contributions.solo, contributions.cleanup, contributions.assist].map(numberOrNull) : null;
  const contributionTotal = contributionValues?.every((value): value is number => value !== null)
    ? contributionValues.reduce((sum, value) => sum + value, 0) : undefined;
  add('solo_kill_share', '솔로 킬 비중', stats.soloKillRate, '%', 'avgSoloKillRate', contributions?.solo, contributionTotal);
  add('utility_throws', '총 투척 횟수', stats.totalUtilityThrows, '회');
  add('utility_smokes', '연막 사용', stats.totalObservedSmokes, '회');
  add('utility_lethal_throws', '피해형 투척', stats.totalLethalThrows, '회');
  add('smoke_rescue_attempts', '구출 연막 시도', stats.totalObservedRescueSmokes, '회');
  // 비교 수치만 보여 준다. 2.0 미만은 평균보다 높아도 양호한 대열로 해석하므로
  // AI_SUMMARY_HIGHER_IS_BETTER에 방향을 두지 않아 서버가 유리·불리를 판정하지 않는다.
  add('isolation_average', '평균 고립 지수', stats.avgIsolationStr, '', 'avgIsolationIndex');
  add('death_phase', '평균 사망 페이즈', stats.avgDeathPhase, '', 'avgDeathPhase');
  return entries;
}
