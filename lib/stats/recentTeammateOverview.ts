import { selectRecentMatches, type RecentMatchOverviewInput } from "@/lib/stats/recentMatchOverview";

export const RECENT_TEAMMATE_OVERVIEW_LIMIT = 5;

export interface RecentTeammateOverviewRow {
  name: string;
  games: number;
  averageRank: string | null;
}

// 최근 20경기 요약과 같은 경기 집합에서 같은 팀이었던 공개 참가자를 집계한다.
// 팀원 정보가 관측된 경기만 세며, 2경기 이상 함께한 팀원만 표시한다.
export function buildRecentTeammateOverview(input: RecentMatchOverviewInput): RecentTeammateOverviewRow[] {
  const groups = new Map<string, { name: string; games: number; rankSum: number; rankGames: number }>();
  for (const match of selectRecentMatches(input).matches) {
    const names = new Set((match.teammateNames ?? []).map(name => name.trim()).filter(Boolean));
    const rank = match.stats?.winPlace;
    const observedRank = typeof rank === "number" && Number.isFinite(rank) && rank >= 1 ? rank : null;
    for (const name of names) {
      const key = name.toLowerCase();
      const group = groups.get(key) ?? { name, games: 0, rankSum: 0, rankGames: 0 };
      group.games += 1;
      if (observedRank !== null) {
        group.rankSum += observedRank;
        group.rankGames += 1;
      }
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .filter(([, group]) => group.games >= 2)
    .sort(([keyA, a], [keyB, b]) => b.games - a.games || keyA.localeCompare(keyB, "ko"))
    .slice(0, RECENT_TEAMMATE_OVERVIEW_LIMIT)
    .map(([, group]) => ({
      name: group.name,
      games: group.games,
      averageRank: group.rankGames ? (group.rankSum / group.rankGames).toFixed(1) : null,
    }));
}
