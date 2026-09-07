import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import type { StatsMatchModeMeta } from "@/types/stats-page";
import { classifyMatchMode } from "@/lib/stats/statsPageModel";

export interface RecentMatchOverviewInput {
  matchIds: readonly string[];
  summaries: Record<string, MatchSummaryData>;
  matchModeMeta?: Record<string, StatsMatchModeMeta>;
  summaryStatus: "idle" | "loading" | "ready" | "error";
}

export function buildRecentMatchOverview({ matchIds, summaries, matchModeMeta = {} }: RecentMatchOverviewInput) {
  // Anchor to the player's latest IDs, independently of history pagination and season filters.
  const ids = [...new Set(matchIds)].slice(0, 20);
  const loaded = ids.flatMap((id) => {
    const match = summaries[id];
    if (!match) return [];
    const meta = matchModeMeta[id];
    return [{ ...match, gameMode: meta?.gameMode || match.gameMode,
      matchType: meta?.matchType || match.matchType, mapName: meta?.mapName || match.mapName }];
  });
  const matches = loaded.filter((match) => ["ranked", "normal", "casual"].includes(classifyMatchMode(match)));
  const counts = { ranked: 0, normal: 0, casual: 0 };
  for (const match of matches) counts[classifyMatchMode(match) as keyof typeof counts] += 1;

  function values(key: "kills" | "assists" | "DBNOs" | "damageDealt" | "winPlace") {
    const result = matches.map((match) => {
      // Basic history rows contain placeholder zeroes for these unobserved fields.
      if (match.summarySource === "pubg_player_matches" && (key === "assists" || key === "DBNOs")) return null;
      const value = match.stats?.[key];
      return typeof value === "number" && Number.isFinite(value) && value >= (key === "winPlace" ? 1 : 0)
        ? value : null;
    });
    return result.length && result.every((value) => value !== null) ? result as number[] : null;
  }
  const sum = (values: number[] | null) => values ? values.reduce((total, value) => total + value, 0) : null;
  const ranks = values("winPlace");
  const damage = sum(values("damageDealt"));
  return {
    requestedCount: ids.length,
    loadedCount: loaded.length,
    matchCount: matches.length,
    excludedCount: loaded.length - matches.length,
    counts,
    kills: sum(values("kills")),
    assists: sum(values("assists")),
    dbnos: sum(values("DBNOs")),
    averageDamage: damage === null ? null : (damage / matches.length).toFixed(0),
    averageRank: ranks ? (ranks.reduce((total, value) => total + value, 0) / ranks.length).toFixed(1) : null,
    wins: ranks ? ranks.filter((rank) => rank === 1).length : null,
    winRate: ranks ? `${(ranks.filter((rank) => rank === 1).length / ranks.length * 100).toFixed(1)}%` : null,
    top10Rate: ranks ? `${(ranks.filter((rank) => rank <= 10).length / ranks.length * 100).toFixed(1)}%` : null,
  };
}

export type RecentMatchOverview = ReturnType<typeof buildRecentMatchOverview>;
