import { MIN_BENCHMARK_SAMPLE_COUNT } from "./benchmarkLookup";

export const BENCHMARK_PROVENANCE_LABEL = "모드·매치 유형·티어 기준 BGMS 표본 평균(플랫폼·맵·수집원 혼합)";

export function formatBenchmarkProvenance(
  sampleCount?: unknown,
  context?: {
    gameMode?: unknown;
    matchType?: unknown;
    tier?: unknown;
    metricSampleCount?: unknown;
  },
): string {
  const count = Number(sampleCount);
  const scope = [
    context?.gameMode === undefined || context?.gameMode === null ? "" : `모드 ${String(context.gameMode).trim()}`,
    context?.matchType === undefined || context?.matchType === null ? "" : `매치 유형 ${String(context.matchType).trim()}`,
    context?.tier === undefined || context?.tier === null ? "" : `티어 ${String(context.tier).trim()}`,
  ].filter(Boolean).join(" · ");
  const sample = Number.isFinite(count) && count >= 0
    ? `${count} player-match 표본`
    : "player-match 표본";
  const metricCount = Number(context?.metricSampleCount);
  const metricSample = Number.isFinite(metricCount) && metricCount >= 0
    ? `; 해당 지표 n=${metricCount}`
    : "";
  return `${BENCHMARK_PROVENANCE_LABEL}${scope ? ` [${scope}]` : ""}; ${sample}${metricSample}`;
}

/**
 * benchmark_stats_by_tier 뷰의 snake_case 데이터를
 * AI 프롬프트 및 앱 내 표준인 camelCase로 변환하고 정규화하는 어댑터
 */

export interface RawTierBenchmark {
  game_mode: string;
  match_type: string;
  tier: string;
  match_count?: number | null;
  avg_damage?: number | null;
  avg_kills?: number | null;
  avg_survival_time?: number | null;
  avg_duel_win_rate?: number | null;
  avg_initiative_rate?: number | null;
  avg_trade_rate?: number | null;
  avg_revive_rate?: number | null;
  avg_smoke_rate?: number | null;
  avg_pressure_index?: number | null;
  avg_team_wipes?: number | null;
  avg_reversal_rate?: number | null;
  avg_isolation_index?: number | null;
  avg_min_dist?: number | null;
  avg_counter_latency_ms?: number | null;
  avg_trade_latency_ms?: number | null;
  avg_solo_kill_rate?: number | null;
  avg_death_phase?: number | null;
  sample_count?: number | null;
  /** Optional per-metric valid sample counts supplied by a future view. */
  metric_sample_counts?: Partial<Record<keyof NormalizedBenchmark, number | null>> | null;
  metricSampleCounts?: Partial<Record<keyof NormalizedBenchmark, number | null>> | null;
  [key: string]: unknown;
}

export interface NormalizedBenchmark {
  avgDamage: number;
  avgKills: number;
  avgSurvivalTime: number;
  avgDuelWinRate: number;
  avgInitiativeRate: number;
  avgTradeRate: number;
  avgReviveRate: number;
  avgSmokeRate: number;
  avgPressureIndex: number;
  avgTeamWipes: number;
  avgReversalRate: number;
  // 추가된 필드들
  avgIsolationIndex: number;
  avgMinDist: number;
  avgCounterLatency: number;
  avgTradeLatency: number;
  avgSoloKillRate: number;
  avgDeathPhase: number;
}

/**
 * An observed summary benchmark.  Unlike `NormalizedBenchmark`, fields are
 * optional so a NULL metric remains unavailable instead of being replaced by
 * a plausible-looking constant.  `sampleCount` is always present and is
 * guaranteed to meet the shared minimum sample threshold.
 */
export type ObservedBenchmark = Partial<NormalizedBenchmark> & {
  sampleCount: number;
  metricSampleCounts?: Partial<Record<keyof NormalizedBenchmark, number>>;
};

/**
 * 비율 지표(0~100)를 안전하게 클램핑하고 정규화합니다.
 */
function normalizeRate(value: number | undefined | null, defaultValue: number = 0): number {
  if (value === undefined || value === null || isNaN(value)) return defaultValue;
  // 만약 DB 값이 0~1 범위라면 100을 곱함
  const normalized = value <= 1 && value > 0 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

/**
 * 일반 수치 지표를 안전하게 처리합니다.
 */
function normalizeValue(value: number | undefined | null, defaultValue: number = 0): number {
  if (value === undefined || value === null || isNaN(value)) return defaultValue;
  return Math.max(0, value);
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return undefined;
  }
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  } catch {
    return undefined;
  }
}

function observedRate(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined || number < 0 || number > 100) return undefined;
  return normalizeRate(number);
}

function observedNonNegative(value: unknown, decimals: number | null = null): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined || number < 0) return undefined;
  return decimals === null ? number : Number(number.toFixed(decimals));
}

function metricCountAliases(key: keyof NormalizedBenchmark, rawFields: readonly string[]): string[] {
  const aliases = new Set<string>();
  const normalizedKey = String(key);
  const addAliasesForField = (rawField: string) => {
    const base = rawField.replace(/^avg_/, "");
    const baseWithoutMs = base.replace(/_ms$/, "");
    [
      `${rawField}_count`,
      `${rawField}_sample_count`,
      `${base}_count`,
      `${base}_sample_count`,
      `${baseWithoutMs}_count`,
      `${baseWithoutMs}_sample_count`,
    ].forEach((alias) => aliases.add(alias));
  };
  rawFields.forEach(addAliasesForField);
  aliases.add(`${normalizedKey}_count`);
  aliases.add(`${normalizedKey}_sample_count`);
  return Array.from(aliases);
}

function metricSampleCount(
  raw: any,
  key: keyof NormalizedBenchmark,
  rawFields: readonly string[],
  totalSampleCount: number,
): number | undefined {
  const nested = raw?.metric_sample_counts ?? raw?.metricSampleCounts;
  const nestedValues = nested && typeof nested === "object"
    ? [nested[key], ...rawFields.flatMap((field) => [nested[field], nested[field.replace(/^avg_/, "")]])]
    : [];
  const countFields = metricCountAliases(key, rawFields);
  for (const candidate of [...nestedValues, ...countFields.map((field) => raw?.[field])]) {
    const count = finiteNumber(candidate);
    if (count !== undefined && Number.isInteger(count) && count >= 0 && count <= totalSampleCount) return count;
  }
  return undefined;
}

/**
 * Adapt only a benchmark row that is safe to present as an observed average.
 * This is intentionally separate from `adaptBenchmark`: match/single-match
 * consumers still rely on that adapter's historical defaults, while the
 * multi-match AI summary must fail closed when its sample or metric is absent.
 */
export function adaptObservedBenchmark(raw: any): ObservedBenchmark | null {
  if (!raw) return null;

  const sampleCount = finiteNumber(raw.match_count ?? raw.sample_count);
  if (sampleCount === undefined || sampleCount < MIN_BENCHMARK_SAMPLE_COUNT) return null;

  const observed: ObservedBenchmark = { sampleCount };
  const counterLatencyMs = observedNonNegative(raw.avg_counter_latency_ms ?? raw.avg_counter_latency, 2);
  const tradeLatencyMs = observedNonNegative(raw.avg_trade_latency_ms ?? raw.avg_trade_latency, 2);
  const values: Array<{
    key: keyof NormalizedBenchmark;
    value: number | undefined;
    rawFields: readonly string[];
  }> = [
    { key: "avgDamage", value: observedNonNegative(raw.avg_damage, 0), rawFields: ["avg_damage"] },
    { key: "avgKills", value: observedNonNegative(raw.avg_kills, 1), rawFields: ["avg_kills"] },
    { key: "avgSurvivalTime", value: observedNonNegative(raw.avg_survival_time, 0), rawFields: ["avg_survival_time"] },
    { key: "avgDuelWinRate", value: observedRate(raw.avg_duel_win_rate), rawFields: ["avg_duel_win_rate"] },
    { key: "avgInitiativeRate", value: observedRate(raw.avg_initiative_rate), rawFields: ["avg_initiative_rate"] },
    { key: "avgTradeRate", value: observedRate(raw.avg_trade_rate), rawFields: ["avg_trade_rate"] },
    { key: "avgReviveRate", value: observedRate(raw.avg_revive_rate), rawFields: ["avg_revive_rate"] },
    { key: "avgSmokeRate", value: observedRate(raw.avg_smoke_rate), rawFields: ["avg_smoke_rate"] },
    { key: "avgPressureIndex", value: observedNonNegative(raw.avg_pressure_index, 2), rawFields: ["avg_pressure_index"] },
    { key: "avgTeamWipes", value: observedNonNegative(raw.avg_team_wipes, 2), rawFields: ["avg_team_wipes"] },
    { key: "avgReversalRate", value: observedRate(raw.avg_reversal_rate), rawFields: ["avg_reversal_rate"] },
    { key: "avgIsolationIndex", value: observedNonNegative(raw.avg_isolation_index, 2), rawFields: ["avg_isolation_index"] },
    { key: "avgMinDist", value: observedNonNegative(raw.avg_min_dist, 0), rawFields: ["avg_min_dist"] },
    { key: "avgCounterLatency", value: counterLatencyMs === undefined ? undefined : Number((counterLatencyMs / 1000).toFixed(2)), rawFields: ["avg_counter_latency_ms", "avg_counter_latency"] },
    { key: "avgTradeLatency", value: tradeLatencyMs === undefined ? undefined : Number((tradeLatencyMs / 1000).toFixed(2)), rawFields: ["avg_trade_latency_ms", "avg_trade_latency"] },
    { key: "avgSoloKillRate", value: observedRate(raw.avg_solo_kill_rate), rawFields: ["avg_solo_kill_rate"] },
    { key: "avgDeathPhase", value: observedNonNegative(raw.avg_death_phase, 1), rawFields: ["avg_death_phase"] },
  ];

  const metricSampleCounts: Partial<Record<keyof NormalizedBenchmark, number>> = {};
  values.forEach(({ key, value, rawFields }) => {
    const count = metricSampleCount(raw, key, rawFields, sampleCount);
    if (value === undefined || count === undefined || count < MIN_BENCHMARK_SAMPLE_COUNT) return;
    observed[key] = value as never;
    metricSampleCounts[key] = count;
  });
  if (Object.keys(metricSampleCounts).length > 0) observed.metricSampleCounts = metricSampleCounts;

  return observed;
}

export function adaptBenchmark(raw: any): NormalizedBenchmark {
  // 기본값 설정 (티어 데이터가 없을 경우를 대비한 폴백)
  const defaultValues: NormalizedBenchmark = {
    avgDamage: 250,
    avgKills: 2.5,
    avgSurvivalTime: 900,
    avgDuelWinRate: 50,
    avgInitiativeRate: 35,
    avgTradeRate: 30,
    avgReviveRate: 30,
    avgSmokeRate: 40,
    avgPressureIndex: 2.0,
    avgTeamWipes: 0.2,
    avgReversalRate: 15,
    avgIsolationIndex: 2.5,
    avgMinDist: 15,
    avgCounterLatency: 0.5,
    avgTradeLatency: 12.0,
    avgSoloKillRate: 50,
    avgDeathPhase: 6
  };

  if (!raw) return defaultValues;

  return {
    avgDamage: Math.round(normalizeValue(raw.avg_damage, defaultValues.avgDamage)),
    avgKills: Number(normalizeValue(raw.avg_kills, defaultValues.avgKills).toFixed(1)),
    avgSurvivalTime: Math.round(normalizeValue(raw.avg_survival_time, defaultValues.avgSurvivalTime)),
    avgDuelWinRate: normalizeRate(raw.avg_duel_win_rate, defaultValues.avgDuelWinRate),
    avgInitiativeRate: normalizeRate(raw.avg_initiative_rate, defaultValues.avgInitiativeRate),
    avgTradeRate: normalizeRate(raw.avg_trade_rate, defaultValues.avgTradeRate),
    avgReviveRate: normalizeRate(raw.avg_revive_rate, defaultValues.avgReviveRate),
    avgSmokeRate: normalizeRate(raw.avg_smoke_rate, defaultValues.avgSmokeRate),
    avgPressureIndex: Number(normalizeValue(raw.avg_pressure_index, defaultValues.avgPressureIndex).toFixed(2)),
    avgTeamWipes: Number(normalizeValue(raw.avg_team_wipes, defaultValues.avgTeamWipes).toFixed(2)),
    avgReversalRate: normalizeRate(raw.avg_reversal_rate, defaultValues.avgReversalRate),
    avgIsolationIndex: Number(normalizeValue(raw.avg_isolation_index, defaultValues.avgIsolationIndex).toFixed(2)),
    avgMinDist: Math.round(normalizeValue(raw.avg_min_dist, defaultValues.avgMinDist)),
    avgCounterLatency: Number(normalizeValue((raw.avg_counter_latency_ms || raw.avg_counter_latency) / 1000, defaultValues.avgCounterLatency).toFixed(2)),
    avgTradeLatency: Number(normalizeValue((raw.avg_trade_latency_ms || raw.avg_trade_latency) / 1000, defaultValues.avgTradeLatency).toFixed(2)),
    avgSoloKillRate: normalizeRate(raw.avg_solo_kill_rate, defaultValues.avgSoloKillRate),
    avgDeathPhase: Number(normalizeValue(raw.avg_death_phase, defaultValues.avgDeathPhase).toFixed(1)),
  };
}
