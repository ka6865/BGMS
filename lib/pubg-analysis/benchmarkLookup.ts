import { ANALYSIS_CALCULATION_VERSION, SUPPORTED_ANALYSIS_CALCULATION_VERSIONS, isSupportedAnalysisCalculationVersion } from "./constants";
import { getBaseTier } from "./benchmarkScore";

/**
 * A benchmark row is only useful as an observed comparison once it represents
 * enough player-match samples.  The view exposes this as `match_count` (with
 * `sample_count` retained for older callers/fixtures).
 */
export const MIN_BENCHMARK_SAMPLE_COUNT = 5;
export const BENCHMARK_FILTER_VERSION = 8;
export const BENCHMARK_POPULATION_EVIDENCE_VERSION = 1;

/**
 * Read-path compatibility gate for benchmark aggregates.  A filter version
 * alone cannot prove that the human BR predicate was applied: pre-marker rows
 * can look like official/squad-fpp after the fact.  Both the current filter
 * contract and its explicit population provenance marker are therefore
 * required; rows omitting either field fail closed.
 */
export function isTrustedBenchmarkPopulation(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const candidate = row as Record<string, unknown>;
  const filterVersion = Number(candidate.filter_version);
  if (!Number.isFinite(filterVersion) || filterVersion !== BENCHMARK_FILTER_VERSION) return false;
  const evidence = candidate.population_evidence_version ?? candidate.populationEvidenceVersion;
  return Number(evidence) === BENCHMARK_POPULATION_EVIDENCE_VERSION;
}

/** Analysis consumers additionally require matching arithmetic provenance. */
export function isTrustedBenchmarkAggregate(row: unknown): boolean {
  return isTrustedBenchmarkPopulation(row)
    && isSupportedAnalysisCalculationVersion((row as Record<string, unknown>).calculation_version);
}

const TIER_GROUPS: Record<string, string[]> = {
  S: ["S+", "S"],
  A: ["A+", "A", "A-"],
  B: ["B+", "B", "B-"],
  C: ["C+", "C", "C-"],
  D: ["D+", "D", "D-"]
};

/** Only these exact labels are valid benchmark tiers at the evidence boundary. */
export const CANONICAL_BENCHMARK_TIERS = [
  "S+", "S",
  "A+", "A", "A-",
  "B+", "B", "B-",
  "C+", "C", "C-",
  "D+", "D", "D-",
] as const;

export type CanonicalBenchmarkTier = (typeof CANONICAL_BENCHMARK_TIERS)[number];

const CANONICAL_BENCHMARK_TIER_SET: ReadonlySet<string> = new Set(CANONICAL_BENCHMARK_TIERS);

export function isCanonicalBenchmarkTier(tier: unknown): tier is CanonicalBenchmarkTier {
  return typeof tier === "string" && CANONICAL_BENCHMARK_TIER_SET.has(tier);
}

const AVERAGE_FIELDS = [
  "avg_damage",
  "avg_kills",
  "avg_survival_time",
  "avg_duel_win_rate",
  "avg_initiative_rate",
  "avg_trade_rate",
  "avg_revive_rate",
  "avg_smoke_rate",
  "avg_pressure_index",
  "avg_team_wipes",
  "avg_reversal_rate",
  "avg_isolation_index",
  "avg_min_dist",
  "avg_counter_latency_ms",
  "avg_eligible_first_reply_latency_ms",
  "avg_eligible_counter_failure_rate",
  "avg_trade_latency_ms",
  "avg_solo_kill_rate",
  "avg_death_phase"
] as const;

const RATE_FIELDS = new Set<(typeof AVERAGE_FIELDS)[number]>([
  "avg_duel_win_rate",
  "avg_initiative_rate",
  "avg_trade_rate",
  "avg_revive_rate",
  "avg_smoke_rate",
  "avg_reversal_rate",
  "avg_solo_kill_rate",
  "avg_eligible_counter_failure_rate",
]);

const NORMALIZED_METRIC_KEYS: Record<(typeof AVERAGE_FIELDS)[number], string> = {
  avg_damage: "avgDamage",
  avg_kills: "avgKills",
  avg_survival_time: "avgSurvivalTime",
  avg_duel_win_rate: "avgDuelWinRate",
  avg_initiative_rate: "avgInitiativeRate",
  avg_trade_rate: "avgTradeRate",
  avg_revive_rate: "avgReviveRate",
  avg_smoke_rate: "avgSmokeRate",
  avg_pressure_index: "avgPressureIndex",
  avg_team_wipes: "avgTeamWipes",
  avg_reversal_rate: "avgReversalRate",
  avg_isolation_index: "avgIsolationIndex",
  avg_min_dist: "avgMinDist",
  avg_counter_latency_ms: "avgCounterLatency",
  avg_eligible_first_reply_latency_ms: "avgFirstReplyLatency",
  avg_eligible_counter_failure_rate: "avgCounterFailureRate",
  avg_trade_latency_ms: "avgTradeLatency",
  avg_solo_kill_rate: "avgSoloKillRate",
  avg_death_phase: "avgDeathPhase",
};

/**
 * Return the canonical benchmark tier family for an observed tier. The
 * family deliberately contains only known labels; callers must not broaden
 * this to a prefix match (for example, `BLAH` is not a B-tier row).
 */
export function getBenchmarkTierFamily(tier: string | null): string[] {
  if (!isCanonicalBenchmarkTier(tier)) return [];
  const family = TIER_GROUPS[getBaseTier(tier)];
  return family ? [...family] : [];
}

function getRowWeight(row: any): number {
  const rawWeight = row?.match_count ?? row?.sample_count;
  try {
    const weight = Number(rawWeight);
    return Number.isFinite(weight) && weight > 0 ? weight : 0;
  } catch {
    return 0;
  }
}

function getMatchCount(row: any): number {
  const rawCount = row?.match_count ?? row?.sample_count;
  try {
    const count = Number(rawCount);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

function getFiniteMetricValue(value: unknown, field: (typeof AVERAGE_FIELDS)[number]): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  let parsed: number;
  try {
    parsed = Number(value);
  } catch {
    return null;
  }
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (RATE_FIELDS.has(field) && parsed > 100) return null;
  return parsed;
}

function metricCountAliases(field: (typeof AVERAGE_FIELDS)[number]): string[] {
  const base = field.replace(/^avg_/, "");
  const baseWithoutMs = base.replace(/_ms$/, "");
  return Array.from(new Set([
    `${field}_count`,
    `${field}_sample_count`,
    `${base}_count`,
    `${base}_sample_count`,
    `${baseWithoutMs}_count`,
    `${baseWithoutMs}_sample_count`,
    `${NORMALIZED_METRIC_KEYS[field]}_count`,
    `${NORMALIZED_METRIC_KEYS[field]}_sample_count`,
  ]));
}

function getMetricSampleCount(row: any, field: (typeof AVERAGE_FIELDS)[number]): number | null {
  const nested = row?.metric_sample_counts ?? row?.metricSampleCounts;
  const nestedCandidates = nested && typeof nested === "object"
    ? [nested[field], nested[field.replace(/^avg_/, "")], nested[NORMALIZED_METRIC_KEYS[field]]]
    : [];
  const directCandidates = metricCountAliases(field).map((key) => row?.[key]);
  for (const candidate of [...nestedCandidates, ...directCandidates]) {
    if (candidate === null || candidate === undefined || (typeof candidate === "string" && candidate.trim() === "")) continue;
    let parsed: number;
    try {
      parsed = Number(candidate);
    } catch {
      continue;
    }
    const total = getMatchCount(row);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 && parsed <= total) return parsed;
    // A malformed first candidate must not hide a later valid explicitly
    // named count column, so continue scanning aliases.
  }
  return null;
}

function removeMetricCountFields(target: any, field: (typeof AVERAGE_FIELDS)[number]): void {
  metricCountAliases(field).forEach((key) => delete target[key]);
  const nested = target.metric_sample_counts;
  if (nested && typeof nested === "object") {
    delete nested[field];
    delete nested[field.replace(/^avg_/, "")];
    delete nested[NORMALIZED_METRIC_KEYS[field]];
    if (Object.keys(nested).length === 0) delete target.metric_sample_counts;
  }
}

export function aggregateTierBenchmarkRows(rows: any[], targetTier: string | null): any | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  if (!isCanonicalBenchmarkTier(targetTier)) return null;
  const family = new Set(getBenchmarkTierFamily(targetTier));
  const canonicalRows = rows.filter((row) => isCanonicalBenchmarkTier(row?.tier) && family.has(row.tier));
  if (canonicalRows.length === 0) return null;

  const totalWeight = canonicalRows.reduce((sum, row) => sum + getRowWeight(row), 0);
  if (totalWeight <= 0) return null;

  const aggregated: any = {
    ...canonicalRows[0],
    tier: getBaseTier(targetTier),
    match_count: totalWeight,
    sample_count: totalWeight
  };

  delete aggregated.metric_sample_counts;
  delete aggregated.metricSampleCounts;
  // Do not inherit per-metric count columns from the first source row. They
  // are re-emitted only when every contributing value has an explicit count;
  // otherwise the arithmetic remains available to pure callers but the
  // observed adapter will (correctly) fail closed for that metric.
  AVERAGE_FIELDS.forEach((field) => removeMetricCountFields(aggregated, field));

  AVERAGE_FIELDS.forEach(field => {
    let weightedSum = 0;
    let fieldWeight = 0;
    let completeMetricCount = true;

    canonicalRows.forEach(row => {
      const value = getFiniteMetricValue(row?.[field], field);
      if (value === null) return;

      const explicitMetricWeight = getMetricSampleCount(row, field);
      const metricWeight = explicitMetricWeight ?? getRowWeight(row);
      if (explicitMetricWeight === null || explicitMetricWeight === undefined) completeMetricCount = false;
      if (metricWeight <= 0) return;
      weightedSum += value * metricWeight;
      fieldWeight += metricWeight;
    });

    // Aggregation remains a pure arithmetic helper: callers may inspect the
    // weighted value even when its per-metric population is below the
    // observed threshold. `adaptObservedBenchmark` is the evidence boundary
    // that enforces n >= 5 before a metric is exposed to AI/UI consumers.
    if (fieldWeight > 0) {
      aggregated[field] = weightedSum / fieldWeight;
      if (completeMetricCount) {
        aggregated[`${field}_count`] = fieldWeight;
        aggregated.metric_sample_counts = {
          ...(aggregated.metric_sample_counts || {}),
          [NORMALIZED_METRIC_KEYS[field]]: fieldWeight,
        };
      }
    } else {
      // The spread above preserves source columns for compatibility, but an
      // all-null or under-sampled metric is not an observed aggregate and
      // must stay absent. Never substitute the row's total match_count here:
      // NULLIF(-1) can leave each AVG with a smaller valid population.
      delete aggregated[field];
      removeMetricCountFields(aggregated, field);
    }
  });

  return aggregated;
}

/**
 * 계산 5에서 의미가 바뀐 비교 지표. 이 지표는 계산 5 행끼리만 평균을 낸다(2026-10-27 결정 4a).
 * - 팀 전멸: 내 기여(서 있는 적 피해·기절·처치/확킬/기절 유발)가 있는 전멸만 센다
 * - 소생·연막·트레이드(지연 포함): 자가 소생 제외, 처치·소생 중복 제거, 구조 사건 단위 연막
 * - 반격 지연·선제·역전·교전 승률·압박: 팀원·자해 피해와 기절한 적 피격을 교전에서 뺀다
 * - 단독 킬 비중: 팀원·자해 처치와 중복 처치를 킬 기여에서 뺀다
 * 나머지(딜량·킬·생존 시간·고립·최소 거리·사망 단계)는 API 결과나 위치 기반이라 2~5를 함께 쓴다.
 */
export const CALCULATION_5_REDEFINED_METRICS: ReadonlySet<(typeof AVERAGE_FIELDS)[number]> = new Set([
  "avg_team_wipes",
  "avg_revive_rate",
  "avg_smoke_rate",
  "avg_trade_rate",
  "avg_trade_latency_ms",
  "avg_counter_latency_ms",
  "avg_eligible_first_reply_latency_ms",
  "avg_eligible_counter_failure_rate",
  "avg_initiative_rate",
  "avg_reversal_rate",
  "avg_duel_win_rate",
  "avg_pressure_index",
  "avg_solo_kill_rate",
]);

/**
 * 한 티어·모드 칸의 계산 5 표본이 이 수 이상이면 모든 지표를 계산 5로만 비교한다(날짜가 아니라 칸별 표본 기준).
 * 지표 노출 최소값(MIN_BENCHMARK_SAMPLE_COUNT=5)보다 충분히 크게 잡아, 소수 경기로 기준이 흔들리지 않게 한다.
 */
export const CALCULATION_5_FULL_SWITCH_MIN_MATCHES = 300;

function deleteMetric(target: any, field: (typeof AVERAGE_FIELDS)[number]): void {
  delete target[field];
  removeMetricCountFields(target, field);
}

/**
 * 지원 계산 버전 행을 합친다. 의미가 바뀐 지표는 현재 계산 행만 쓰고, 현재 계산 표본이 충분하면 전부 현재 계산만 쓴다.
 * 의미가 바뀐 지표의 표본 수는 현재 계산 행 기준으로 다시 붙여, 표본이 5 미만이면 adaptObservedBenchmark가 그 지표만 뺀다.
 */
export function combineCalculationBenchmarkRows(rows: any[], targetTier: string | null): any | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const currentRows = rows.filter((row) => row?.calculation_version === ANALYSIS_CALCULATION_VERSION);
  const current = currentRows.length > 0 ? aggregateTierBenchmarkRows(currentRows, targetTier) : null;
  if (current && getMatchCount(current) >= CALCULATION_5_FULL_SWITCH_MIN_MATCHES) {
    return { ...current, calculation_version: ANALYSIS_CALCULATION_VERSION };
  }
  if (currentRows.length === rows.length) return current;
  const combined = aggregateTierBenchmarkRows(rows, targetTier);
  if (!combined) return null;
  CALCULATION_5_REDEFINED_METRICS.forEach((field) => {
    deleteMetric(combined, field);
    if (!current || current[field] === undefined) return;
    combined[field] = current[field];
    // 현재 계산 집계에 지표별 표본 수가 없으면 노출 근거도 없다. 전체 표본 수로 대신하지 않는다.
    const count = getMetricSampleCount(current, field);
    if (count === null) return;
    combined[`${field}_count`] = count;
    combined.metric_sample_counts = { ...(combined.metric_sample_counts || {}), [NORMALIZED_METRIC_KEYS[field]]: count };
  });
  return { ...combined, calculation_version: Math.max(...rows.map((row) => Number(row?.calculation_version) || 0)) };
}

export async function fetchTierBenchmarkStats(
  supabase: any,
  options: {
    gameMode: string;
    matchType?: string | null;
    tier: string | null;
    signal?: AbortSignal;
  }
): Promise<any | null> {
  const gameMode = options.gameMode || "squad";
  const matchType = String(options.matchType || "official").toLowerCase();
  const exactTier = options.tier || "C";
  const signal = options.signal;

  if (signal?.aborted) return null;
  if (!isCanonicalBenchmarkTier(exactTier)) return null;

  const exactRows: any[] = [];
  for (const calculation of SUPPORTED_ANALYSIS_CALCULATION_VERSIONS) {
    let query: any = supabase.from("benchmark_stats_by_tier_v2").select("*")
      .eq("calculation_version", calculation).eq("game_mode", gameMode)
      .eq("match_type", matchType).eq("tier", exactTier);
    if (signal) query = query.abortSignal(signal);
    const { data: exact, error } = await query.maybeSingle();
    if (signal?.aborted) return null;
    if (error) throw error;
    if (exact?.tier === exactTier && exact.calculation_version === calculation
      && isTrustedBenchmarkAggregate(exact)) exactRows.push(exact);
  }
  // 버전별 행을 표본 수로 합친다. 계산 5에서 의미가 바뀐 지표는 계산 5끼리만 쓴다. 저장된 점수는 바꾸지 않는다.
  const exact = exactRows.length === 1 && exactRows[0].calculation_version === ANALYSIS_CALCULATION_VERSION
    ? exactRows[0] : combineCalculationBenchmarkRows(exactRows, exactTier);
  if (exact && getMatchCount(exact) >= MIN_BENCHMARK_SAMPLE_COUNT) return { ...exact, tier: exactTier };

  const family = new Set(getBenchmarkTierFamily(exactTier));
  const trustedGrouped: any[] = [];
  for (const calculation of SUPPORTED_ANALYSIS_CALCULATION_VERSIONS) {
    let query: any = supabase.from("benchmark_stats_by_tier_v2").select("*")
      .eq("calculation_version", calculation).eq("game_mode", gameMode)
      .eq("match_type", matchType).in("tier", [...family]);
    if (signal) query = query.abortSignal(signal);
    const { data: grouped, error } = await query.limit(10);
    if (signal?.aborted) return null;
    if (error) throw error;
    if (Array.isArray(grouped)) trustedGrouped.push(...grouped.filter(row => (
      row?.calculation_version === calculation && family.has(row.tier) && isTrustedBenchmarkAggregate(row)
    )));
  }
  const aggregated = combineCalculationBenchmarkRows(trustedGrouped, exactTier);
  return aggregated && getMatchCount(aggregated) >= MIN_BENCHMARK_SAMPLE_COUNT ? aggregated : null;
}
