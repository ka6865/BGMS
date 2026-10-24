import type { LolChampionMastery, LolChampionPerformance, LolPlayerMatchSummary } from "./types";

export function parseLolMasteries(value: unknown): LolChampionMastery[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error("invalid mastery response");
  const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const optional = (value: unknown) => number(value) ? value : null;
  const seen = new Set<number>();
  return value.map(row => {
    if (!row || !number(row.championId) || row.championId === 0 || seen.has(row.championId)
      || !number(row.championLevel) || !number(row.championPoints) || !number(row.lastPlayTime)
      || row.lastPlayTime > 8.64e15) throw new Error("invalid mastery response");
    seen.add(row.championId);
    return {
      championId: row.championId, championLevel: row.championLevel, championPoints: row.championPoints, lastPlayTime: row.lastPlayTime,
      championPointsUntilNextLevel: optional(row.championPointsUntilNextLevel), championSeasonMilestone: optional(row.championSeasonMilestone),
    };
  });
}

export function summarizeLolChampionPerformance(rows: LolPlayerMatchSummary[]): LolChampionPerformance[] {
  const champions = new Map<number, { champion: LolChampionPerformance; kills: number; deaths: number; assists: number; complete: boolean }>();
  for (const row of rows) {
    if (![400, 420, 430, 440, 480, 490, 450, 100].includes(row.queue_id) || row.remake !== false || row.win === null || !row.champion_id || row.duration_seconds === null || row.duration_seconds < 300) continue;
    const current = champions.get(row.champion_id) ?? {
      champion: { championId: row.champion_id, championName: row.champion_name ?? "알 수 없음", championImageId: row.champion_name ?? "",
        games: 0, wins: 0, winRatePct: 0, kda: null, perfect: false },
      kills: 0, deaths: 0, assists: 0, complete: true,
    };
    current.champion.games += 1;
    current.champion.wins += Number(row.win);
    current.complete &&= [row.kills, row.deaths, row.assists].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
    current.kills += row.kills ?? 0;
    current.deaths += row.deaths ?? 0;
    current.assists += row.assists ?? 0;
    champions.set(row.champion_id, current);
  }
  return [...champions.values()].map(({ champion, kills, deaths, assists, complete }) => ({
    ...champion, winRatePct: champion.wins / champion.games * 100,
    kda: complete && deaths > 0 ? (kills + assists) / deaths : null,
    perfect: complete && deaths === 0 && kills + assists > 0,
  }));
}

export function hasGoodLolRecentPerformance(champion: LolChampionPerformance): boolean {
  return champion.games >= 3 && champion.winRatePct >= 60 && (champion.perfect || (champion.kda !== null && champion.kda >= 3));
}

export function lolMasteryBadge(champion: LolChampionPerformance, masteryTop: boolean): string | null {
  if (champion.games < 3) return null;
  if (hasGoodLolRecentPerformance(champion)) return masteryTop ? "주력" : "떠오르는 챔피언";
  return null;
}
