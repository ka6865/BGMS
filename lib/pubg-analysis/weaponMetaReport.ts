import { BENCHMARK_FILTER_VERSION, BENCHMARK_POPULATION_EVIDENCE_VERSION } from "./benchmarkLookup";

export const BURST_COMPARISON_MIN_MATCHES = 20;

/** Strict evidence gate retained for benchmark consumers. The public patch report
 * separately includes preserved historical samples; it never promotes their provenance.
 */
export function isSafeWeaponMetaPopulationRow(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const candidate = row as Record<string, unknown>;
  if (Number(candidate.filter_version) !== BENCHMARK_FILTER_VERSION) return false;
  const evidence = candidate.population_evidence_version ?? candidate.populationEvidenceVersion;
  return Number(evidence) === BENCHMARK_POPULATION_EVIDENCE_VERSION;
}

type ScopePickShare = {
  scope: "category";
  weapon_category: string;
  period: "pre" | "post";
  player_match_count: number;
  weapon_pick_count: number;
};

export function buildScopePickShares(rows: Array<{
  played_at: string; weapon_category: string; active_pick: boolean; match_id: string; platform: string; player_id: string;
}> , patchStartedAt: string): ScopePickShare[] {
  const allMatchesByPeriod = new Map<"pre" | "post", Set<string>>();
  const scopes = new Map<string, { picks: Set<string>; weapon_category: string; period: "pre" | "post" }>();
  for (const row of rows) {
    const period = Date.parse(row.played_at) < Date.parse(patchStartedAt) ? "pre" : "post";
    const identity = `${row.match_id}:${row.platform}:${row.player_id}`;
    const allMatches = allMatchesByPeriod.get(period) || new Set<string>();
    allMatches.add(identity);
    allMatchesByPeriod.set(period, allMatches);
    for (const category of [row.weapon_category, "ALL"]) {
      const key = `${period}:${category}`;
      const scope = scopes.get(key) || { picks: new Set<string>(), weapon_category: category, period };
      if (row.active_pick) scope.picks.add(identity);
      scopes.set(key, scope);
    }
  }
  return Array.from(scopes.values()).map((scope) => ({
    scope: "category",
    weapon_category: scope.weapon_category,
    period: scope.period,
    player_match_count: allMatchesByPeriod.get(scope.period)?.size || 0,
    weapon_pick_count: scope.picks.size,
  }));
}
