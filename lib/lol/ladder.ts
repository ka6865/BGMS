export const LOL_LADDER_QUEUES = ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"] as const;
export const LOL_LADDER_TIERS = ["CHALLENGER", "GRANDMASTER", "MASTER"] as const;
export type LolLadderQueue = typeof LOL_LADDER_QUEUES[number];
export type LolLadderTier = typeof LOL_LADDER_TIERS[number];
export type LolLadderAggregate = {
  queue: LolLadderQueue; tier: LolLadderTier; player_count: number;
  cutoff_lp: number | null; top_lp: number | null; median_lp: number | null;
  fresh_blood_count: number; hot_streak_count: number;
};
export type LolLadderDaily = LolLadderAggregate & { day: string; observed_at: string };

export function lolKstDay(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(now);
}

export function aggregateLolLadder(raw: unknown, queue: LolLadderQueue, tier: LolLadderTier): LolLadderAggregate {
  const league = raw as { queue?: unknown; tier?: unknown; entries?: unknown } | null;
  if (!league || league.queue !== queue || league.tier !== tier || !Array.isArray(league.entries) || league.entries.length > 150_000) {
    throw new Error("랭크 명단 응답을 확인할 수 없습니다.");
  }
  const lps: number[] = [];
  let fresh = 0, hot = 0;
  for (const entry of league.entries) {
    if (!entry || !Number.isSafeInteger(entry.leaguePoints) || entry.leaguePoints < 0 || entry.leaguePoints > 100_000
      || typeof entry.freshBlood !== "boolean" || typeof entry.hotStreak !== "boolean") throw new Error("랭크 집계 값이 올바르지 않습니다.");
    lps.push(entry.leaguePoints);
    fresh += Number(entry.freshBlood);
    hot += Number(entry.hotStreak);
  }
  lps.sort((a, b) => a - b);
  const size = lps.length;
  return {
    queue, tier, player_count: size, cutoff_lp: size ? lps[0] : null, top_lp: size ? lps[size - 1] : null,
    median_lp: size ? (lps[Math.floor((size - 1) / 2)] + lps[Math.floor(size / 2)]) / 2 : null,
    fresh_blood_count: fresh, hot_streak_count: hot,
  };
}
