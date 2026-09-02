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
export function isTrustedBenchmarkAggregate(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const candidate = row as Record<string, unknown>;
  const filterVersion = Number(candidate.filter_version);
  if (!Number.isFinite(filterVersion) || filterVersion !== BENCHMARK_FILTER_VERSION) return false;
  const evidence = candidate.population_evidence_version ?? candidate.populationEvidenceVersion;
  return Number(evidence) === BENCHMARK_POPULATION_EVIDENCE_VERSION;
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

  let exactQuery = supabase
    .from("benchmark_stats_by_tier")
    .select("*")
    .eq("game_mode", gameMode)
    .eq("match_type", matchType)
    .eq("tier", exactTier);
  if (signal) exactQuery = exactQuery.abortSignal(signal);
  const { data: exact, error: exactError } = await exactQuery.maybeSingle();

  if (exactError) {
    if (signal?.aborted) return null;
    throw exactError;
  }
  // A fine-tier row with too few samples is not an observed benchmark. Keep
  // looking for the existing same-base-tier aggregate before giving up.
  if (
    exact
    && isCanonicalBenchmarkTier(exact.tier)
    && exact.tier === exactTier
    && isTrustedBenchmarkAggregate(exact)
    && getMatchCount(exact) >= MIN_BENCHMARK_SAMPLE_COUNT
  ) return exact;
  if (signal?.aborted) return null;

  let groupedQuery = supabase
    .from("benchmark_stats_by_tier")
    .select("*")
    .eq("game_mode", gameMode)
    .eq("match_type", matchType)
    .in("tier", getBenchmarkTierFamily(exactTier));
  if (signal) groupedQuery = groupedQuery.abortSignal(signal);
  const { data: grouped, error: groupError } = await groupedQuery.limit(10);

  if (groupError) {
    if (signal?.aborted) return null;
    throw groupError;
  }
  if (!Array.isArray(grouped) || grouped.length === 0) return null;
  const family = new Set(getBenchmarkTierFamily(exactTier));
  const trustedGrouped = grouped.filter((row) => (
    isCanonicalBenchmarkTier(row?.tier)
    && family.has(row.tier)
    && isTrustedBenchmarkAggregate(row)
  ));
  if (trustedGrouped.length === 0) return null;
  const aggregated = aggregateTierBenchmarkRows(trustedGrouped, exactTier);
  return aggregated && getMatchCount(aggregated) >= MIN_BENCHMARK_SAMPLE_COUNT
    ? aggregated
    : null;
}
