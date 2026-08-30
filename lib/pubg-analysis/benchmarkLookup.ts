import { getBaseTier } from "./benchmarkScore";

const TIER_GROUPS: Record<string, string[]> = {
  S: ["S+", "S"],
  A: ["A+", "A", "A-"],
  B: ["B+", "B", "B-"],
  C: ["C+", "C", "C-"],
  D: ["D+", "D", "D-"]
};

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

function getTierGroup(tier: string | null): string[] {
  return TIER_GROUPS[getBaseTier(tier)] || TIER_GROUPS.C;
}

function getRowWeight(row: any): number {
  const weight = Number(row?.match_count || row?.sample_count || 1);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

export function aggregateTierBenchmarkRows(rows: any[], targetTier: string | null): any | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const totalWeight = rows.reduce((sum, row) => sum + getRowWeight(row), 0);
  if (totalWeight <= 0) return null;

  const aggregated: any = {
    ...rows[0],
    tier: getBaseTier(targetTier),
    match_count: totalWeight,
    sample_count: totalWeight
  };

  AVERAGE_FIELDS.forEach(field => {
    let weightedSum = 0;
    let fieldWeight = 0;

    rows.forEach(row => {
      const value = Number(row?.[field]);
      if (!Number.isFinite(value)) return;

      const weight = getRowWeight(row);
      weightedSum += value * weight;
      fieldWeight += weight;
    });

    if (fieldWeight > 0) {
      aggregated[field] = weightedSum / fieldWeight;
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
  if (exact) return exact;
  if (signal?.aborted) return null;

  let groupedQuery = supabase
    .from("benchmark_stats_by_tier")
    .select("*")
    .eq("game_mode", gameMode)
    .eq("match_type", matchType)
    .in("tier", getTierGroup(exactTier));
  if (signal) groupedQuery = groupedQuery.abortSignal(signal);
  const { data: grouped, error: groupError } = await groupedQuery.limit(10);

  if (groupError) {
    if (signal?.aborted) return null;
    throw groupError;
  }
  if (!grouped || grouped.length === 0) return null;
  return aggregateTierBenchmarkRows(grouped, exactTier);
}
