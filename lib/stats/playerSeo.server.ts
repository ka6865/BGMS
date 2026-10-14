import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";

export type PlayerSeoSummary = {
  seasonId: string;
  rounds: number;
  wins: number;
  avgDamage: number;
  killsPerRound: number;
};

export type PlayerSeoState =
  | { status: "private" }
  | { status: "unknown" }
  | { status: "public"; nickname: string; summary: PlayerSeoSummary | null };

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

/**
 * 검색 노출 여부. 실제 검색된 적이 있고 시즌 전적이 저장된 공개 플레이어만 노출한다.
 * 비공개 확인이나 조회가 실패하면 노출하지 않는다.
 */
export const getPlayerSeoState = cache(async (platform: string, nickname: string): Promise<PlayerSeoState> => {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/['";\s]+/g, "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").replace(/['";\s]+/g, "").trim();
  const lowerNickname = nickname.trim().toLowerCase();
  if (!url || !key || !lowerNickname) return { status: "unknown" };
  try {
    const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    if (await isPlayerPrivate(platform, nickname, undefined, client)) return { status: "private" };
    const { data, error } = await client
      .from("pubg_player_cache")
      .select("nickname, search_count, season_stats_data")
      .eq("platform", platform)
      .eq("lower_nickname", lowerNickname)
      .maybeSingle();
    if (error || !data || !(Number(data.search_count) > 0) || !data.season_stats_data) return { status: "unknown" };
    return { status: "public", nickname: String(data.nickname || nickname), summary: summarizeSeasonStats(data.season_stats_data) };
  } catch {
    return { status: "private" };
  }
});
