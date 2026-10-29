import { buildBackupCoachingContext } from "./backupCoaching";
import { hasComparableBenchmarkMetric, type NormalizedBenchmark } from "./benchmarkAdapter";
import { TACTICAL_THRESHOLDS } from "./constants";

/** 비교 근거가 없을 때 쓰는 기본 주제. 사용자 본인 텔레메트리만으로 다룰 수 있다. */
export const DEFAULT_SUMMARY_TOPICS = ["화력", "교전 주도권", "포지셔닝"] as const;

type TopicIssue = { topic: string; gap: number };

const isObservedMetric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readObservedNumber(value: unknown): number | null {
  if (isObservedMetric(value)) return value;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  return Number(value);
}

/**
 * 최근 요약의 토론 주제 3개를 고른다.
 *
 * 비교 주제는 카드에 실제로 비교값이 붙는 지표(hasComparableBenchmarkMetric,
 * MIN_COMPARISON_SAMPLE_COUNT 이상 표본)만 후보로 삼는다. 비교 평균이 있어도 표본이
 * 부족하면 카드가 "비교 표본이 30경기 미만"으로 보류되므로, 그런 지표로 주제를 채우면
 * 비교할 수 있는 다른 주제가 밀려난다. 비교 주제가 3개보다 적을 때만 사용자 관측 주제로 채운다.
 */
export function selectSummaryDebateTopics(
  stats: Record<string, any> | null | undefined,
  bench: unknown,
  options: { userTradeRate: number | null },
): string[] {
  if (!stats) return [...DEFAULT_SUMMARY_TOPICS];

  const userOnlyIssues: TopicIssue[] = [
    { topic: "유틸리티 활용", gap: stats.totalUtilityThrows === null ? 0.05 : stats.totalUtilityThrows < 5 ? 0.4 : 0.1 },
    { topic: "포지셔닝", gap: parseFloat(stats.avgIsolationStr) > 3.5 ? 0.35 : 0.05 },
    { topic: "생존 운영", gap: typeof stats.avgDeathPhase === "number" && stats.avgDeathPhase > 7 ? 0.2 : 0.05 },
  ];
  if (!bench || typeof bench !== "object") return userOnlyIssues.map(({ topic }) => topic);

  const b = bench as Record<string, any>;
  const comparable = (key: keyof NormalizedBenchmark) => hasComparableBenchmarkMetric(bench, key) && isObservedMetric(b[key]);
  const comparisonIssues: TopicIssue[] = [];

  if (comparable("avgDamage") && isObservedMetric(stats.avgDamage)) {
    comparisonIssues.push({ topic: "화력", gap: Math.abs(stats.avgDamage - b.avgDamage) / Math.max(b.avgDamage, 1) });
  }
  if (comparable("avgInitiativeRate") && isObservedMetric(stats.userInitiativeRate)) {
    comparisonIssues.push({ topic: "교전 주도권", gap: Math.abs(stats.userInitiativeRate - b.avgInitiativeRate) / 100 });
  }
  if (comparable("avgDuelWinRate") && isObservedMetric(stats.avgDuelWinRate)) {
    comparisonIssues.push({ topic: "1:1 결정력", gap: Math.abs(stats.avgDuelWinRate - b.avgDuelWinRate) / 100 });
  }

  const tradeRateGap = comparable("avgTradeRate") && options.userTradeRate !== null
    ? Math.abs(options.userTradeRate - b.avgTradeRate) / 100
    : null;
  const userBackupLatency = parseFloat(String(stats.avgBackupLatency ?? ""));
  const backupContext = buildBackupCoachingContext({
    avgBackupLatency: stats.avgBackupLatency,
    totalTradeKills: stats.totalTradeKills,
    totalRevCount: stats.totalRevCount,
    totalSmokeRescues: stats.totalSmokeRescues,
    totalTeamWipes: stats.totalTeamWipes,
    totalTeammateKnocks: stats.totalTeammateKnocks,
    benchmarkTradeLatency: b.avgTradeLatency,
  });
  const backupLatencyGap = isNaN(userBackupLatency) || backupContext.shouldAvoidSlowBackupBlame || !comparable("avgTradeLatency")
    ? null
    : Math.min(1.0, Math.abs(userBackupLatency - b.avgTradeLatency) / 20);
  const tradeAndBackupGaps = [tradeRateGap, backupLatencyGap].filter((gap): gap is number => gap !== null);
  if (tradeAndBackupGaps.length > 0) {
    comparisonIssues.push({ topic: "복수 성공률 및 백업", gap: Math.max(...tradeAndBackupGaps) });
  }

  // 고립 지수는 방향 없이 비교 평균과의 거리만 본다. 지수 상한(5)으로 나눠 비율 지표와 같은 0~1 척도로 맞춘다.
  const userIsolation = readObservedNumber(stats.rawMetricValues?.isolation_average) ?? readObservedNumber(stats.avgIsolationStr);
  if (comparable("avgIsolationIndex") && userIsolation !== null) {
    comparisonIssues.push({ topic: "포지셔닝", gap: Math.abs(userIsolation - b.avgIsolationIndex) / TACTICAL_THRESHOLDS.ISOLATION_MAX_RATIO });
  }

  const byGap = (a: TopicIssue, c: TopicIssue) => c.gap - a.gap;
  const comparisonTopics = comparisonIssues.sort(byGap).map(({ topic }) => topic);
  const fillTopics = userOnlyIssues.filter(({ topic }) => !comparisonTopics.includes(topic)).sort(byGap).map(({ topic }) => topic);
  return [...comparisonTopics, ...fillTopics].slice(0, 3);
}
