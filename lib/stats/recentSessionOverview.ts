import { selectRecentMatches, type RecentMatchOverviewInput } from "@/lib/stats/recentMatchOverview";

/** 앞 경기 시작과 이 시간 넘게 벌어지면 다른 세션으로 본다. */
export const SESSION_GAP_MS = 60 * 60 * 1000;
const SESSION_TEAMMATE_MIN_GAMES = 2;
const SESSION_TEAMMATE_LIMIT = 4;

export interface RecentSessionOverview {
  startedAt: string;
  lastStartedAt: string;
  games: number;
  wins: number;
  kills: number;
  averageDamage: number;
  bestRank: number | null;
  /** 세션 안 경기별 킬, 오래된 경기부터. */
  killsByMatch: number[];
  teammates: { name: string; games: number }[];
  /** 최근 20경기 안의 세션 수. */
  sessionCount: number;
}

const finiteOrZero = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

// 최근 20경기 요약과 같은 경기 집합을 시작 시각순으로 묶고, 가장 최근 세션을 요약한다.
export function buildRecentSessionOverview(input: RecentMatchOverviewInput): RecentSessionOverview | null {
  const timed = selectRecentMatches(input).matches
    .map((match) => ({ match, time: Date.parse(match.createdAt) }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => a.time - b.time);
  if (timed.length === 0) return null;

  const sessions: (typeof timed)[] = [];
  for (const item of timed) {
    const current = sessions[sessions.length - 1];
    if (current && item.time - current[current.length - 1].time <= SESSION_GAP_MS) current.push(item);
    else sessions.push([item]);
  }
  const latest = sessions[sessions.length - 1];
  const matches = latest.map(({ match }) => match);

  const ranks = matches.map((match) => match.stats?.winPlace).filter((rank): rank is number => typeof rank === "number" && rank >= 1);
  const killsByMatch = matches.map((match) => finiteOrZero(match.stats?.kills));
  const damage = matches.reduce((sum, match) => sum + finiteOrZero(match.stats?.damageDealt), 0);

  const teammateGames = new Map<string, { name: string; games: number }>();
  for (const match of matches) {
    for (const name of new Set((match.teammateNames ?? []).map((value) => value.trim()).filter(Boolean))) {
      const key = name.toLowerCase();
      const row = teammateGames.get(key) ?? { name, games: 0 };
      row.games += 1;
      teammateGames.set(key, row);
    }
  }

  return {
    startedAt: latest[0].match.createdAt,
    lastStartedAt: latest[latest.length - 1].match.createdAt,
    games: matches.length,
    wins: ranks.filter((rank) => rank === 1).length,
    kills: killsByMatch.reduce((sum, value) => sum + value, 0),
    averageDamage: Math.round(damage / matches.length),
    bestRank: ranks.length ? Math.min(...ranks) : null,
    killsByMatch,
    teammates: [...teammateGames.values()]
      .filter((row) => row.games >= SESSION_TEAMMATE_MIN_GAMES)
      .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, "ko"))
      .slice(0, SESSION_TEAMMATE_LIMIT),
    sessionCount: sessions.length,
  };
}
