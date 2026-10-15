import type { StatsBucket } from "@/types/stats-page";
import { validatedCachedBuckets } from "@/lib/pubg/playerPayload";

export type SeasonQueue = "normal" | "ranked";
export type SeasonMode = "solo" | "duo" | "squad";

export interface CachedSeasonRow {
  season_stats_data?: Record<string, any> | null;
  last_season_id?: unknown;
  updated_at?: string | null;
}

export interface SeasonBucketSummary {
  matches: number;
  /** 일반전은 K/D, 경쟁전은 KDA. 사망 수가 미측정이면 null이다. */
  ratio: string | null;
  winRate: string;
  avgDamage: number;
  tier: string | null;
  rp: number | null;
}

function isValidSeasonId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value !== "null" && value !== "undefined";
}

/** 웹 전적 API와 같이 마지막 시즌 캐시가 없으면 다른 유효 시즌 캐시로 대체한다. */
export function selectCachedSeason(row: CachedSeasonRow | null | undefined): { seasonId: string; stats: any } | null {
  const data = row?.season_stats_data;
  if (!data || typeof data !== "object") return null;
  const seasonId = isValidSeasonId(row.last_season_id) && data[row.last_season_id]
    ? row.last_season_id
    : Object.keys(data).find((key) => isValidSeasonId(key) && data[key]);
  return seasonId ? { seasonId, stats: data[seasonId] } : null;
}

// 웹 전적 화면과 같은 짧은 시즌 이름을 쓴다(예: division.bro.official.pc-2018-36 → 시즌 36).
export function seasonLabel(seasonId: string): string {
  return `시즌 ${seasonId.split("-").pop()}`;
}

/** 검증된 모드별 버킷 중 판수가 있는 것만 판수 내림차순으로 돌려준다. */
export function playedSeasonModes(seasonStats: any, queue: SeasonQueue): Array<[SeasonMode, StatsBucket]> {
  const buckets = validatedCachedBuckets(seasonStats?.[queue]);
  if (!buckets) return [];
  return (Object.entries(buckets) as Array<[SeasonMode, StatsBucket | null | undefined]>)
    .filter((entry): entry is [SeasonMode, StatsBucket] => Boolean(entry[1] && entry[1].roundsPlayed > 0))
    .sort((a, b) => b[1].roundsPlayed - a[1].roundsPlayed);
}

export function summarizeSeasonBucket(bucket: StatsBucket, queue: SeasonQueue): SeasonBucketSummary {
  const matches = bucket.roundsPlayed;
  const deaths = bucket.deaths ?? bucket.losses;
  const ranked = queue === "ranked";
  const ratio = typeof deaths === "number" && Number.isFinite(deaths) && deaths >= 0
    ? ((bucket.kills + (ranked ? bucket.assists : 0)) / Math.max(1, deaths)).toFixed(2)
    : null;
  const tier = ranked && bucket.currentTier?.tier
    ? `${bucket.currentTier.tier} ${bucket.currentTier.subTier ?? ""}`.trim()
    : null;
  return {
    matches,
    ratio,
    winRate: `${((bucket.wins / matches) * 100).toFixed(1)}%`,
    avgDamage: Math.round(bucket.damageDealt / matches),
    tier,
    rp: tier ? bucket.currentRankPoint ?? null : null,
  };
}

/** 통계별 갱신 시각을 우선하고, 이전 저장 통계(stale) 여부를 함께 돌려준다. */
export function seasonAvailability(seasonStats: any, queue: SeasonQueue, row: CachedSeasonRow): { updatedAt: string | null; stale: boolean } {
  const availability = seasonStats?.statsAvailability?.[queue];
  return {
    updatedAt: availability?.updatedAt || row.updated_at || null,
    stale: availability?.status === "stale",
  };
}
