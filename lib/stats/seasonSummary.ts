export type PlayerSeoSummary = {
  seasonId: string;
  rounds: number;
  wins: number;
  avgDamage: number;
  killsPerRound: number;
};

type ModeStats = { roundsPlayed?: unknown; wins?: unknown; kills?: unknown; damageDealt?: unknown };

const count = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

/** 가장 최근 시즌의 모든 모드 합계. 시즌 ID는 `...pc-2018-42`처럼 끝 번호로 정렬한다. */
export function summarizeSeasonStats(seasonStats: unknown): PlayerSeoSummary | null {
  if (!seasonStats || typeof seasonStats !== "object") return null;
  const seasonNumber = (id: string) => Number(id.match(/(\d+)$/)?.[1] ?? -1);
  const [seasonId] = Object.keys(seasonStats).filter((id) => seasonNumber(id) >= 0).sort((a, b) => seasonNumber(b) - seasonNumber(a));
  if (!seasonId) return null;
  const season = (seasonStats as Record<string, unknown>)[seasonId];
  if (!season || typeof season !== "object") return null;
  let rounds = 0, wins = 0, kills = 0, damage = 0;
  for (const group of Object.values(season as Record<string, unknown>)) {
    if (!group || typeof group !== "object") continue;
    for (const mode of Object.values(group as Record<string, ModeStats>)) {
      if (!mode || typeof mode !== "object") continue;
      rounds += count(mode.roundsPlayed);
      wins += count(mode.wins);
      kills += count(mode.kills);
      damage += count(mode.damageDealt);
    }
  }
  if (rounds === 0) return null;
  return { seasonId, rounds, wins, avgDamage: Math.round(damage / rounds), killsPerRound: Math.round((kills / rounds) * 10) / 10 };
}

