import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";

import { summarizeSeasonStats, type PlayerSeoSummary } from "@/lib/stats/seasonSummary";

export { summarizeSeasonStats } from "@/lib/stats/seasonSummary";
export type { PlayerSeoSummary } from "@/lib/stats/seasonSummary";

export type PlayerSeoState =
  | { status: "private" }
  | { status: "unknown" }
  | { status: "public"; nickname: string; summary: PlayerSeoSummary | null };

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
