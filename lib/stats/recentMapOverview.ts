import { getMapDisplayName, isBattleRoyaleMapName } from "@/lib/stats/mapDisplayName";
import { selectRecentMatches, type RecentMatchOverviewInput } from "@/lib/stats/recentMatchOverview";

export const RECENT_MAP_OVERVIEW_LIMIT = 5;

export interface RecentMapOverviewRow {
  mapName: string;
  games: number;
  averageRank: string;
  top10Rate: string;
  averageDamage: string;
}

function observedNumber(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : null;
}

// 최근 20경기 요약과 같은 경기 집합에서 맵별 성적을 집계한다.
// 순위나 피해량이 관측되지 않은 경기와 데스매치·미지원 맵은 0으로 채우지 않고 제외한다.
export function buildRecentMapOverview(input: RecentMatchOverviewInput): RecentMapOverviewRow[] {
  const groups = new Map<string, { games: number; rankSum: number; top10: number; damageSum: number }>();
  for (const match of selectRecentMatches(input).matches) {
    if (!isBattleRoyaleMapName(match.mapName)) continue;
    const rank = observedNumber(match.stats?.winPlace, 1);
    const damage = observedNumber(match.stats?.damageDealt, 0);
    if (rank === null || damage === null) continue;
    const name = getMapDisplayName(match.mapName) ?? match.mapName;
    const group = groups.get(name) ?? { games: 0, rankSum: 0, top10: 0, damageSum: 0 };
    group.games += 1;
    group.rankSum += rank;
    group.top10 += rank <= 10 ? 1 : 0;
    group.damageSum += damage;
    groups.set(name, group);
  }
  return [...groups.entries()]
    .sort(([nameA, a], [nameB, b]) => b.games - a.games || nameA.localeCompare(nameB, "ko"))
    .slice(0, RECENT_MAP_OVERVIEW_LIMIT)
    .map(([mapName, group]) => ({
      mapName,
      games: group.games,
      averageRank: (group.rankSum / group.games).toFixed(1),
      top10Rate: `${(group.top10 / group.games * 100).toFixed(0)}%`,
      averageDamage: (group.damageSum / group.games).toFixed(0),
    }));
}
