import { cache } from "react";
import { unstable_cache } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { getPrivatePlayersList, isPlayerPrivate, matchesPrivatePlayer } from "@/lib/pubg/privatePlayers";

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

// 사이트맵에는 최근 30일 안에 2번 이상 검색된 공개 플레이어만 싣는다. 검색이 드문 페이지는 내용이 비슷해 색인되기 어렵다.
const SITEMAP_PLAYER_LIMIT = 1000;
const SITEMAP_PLAYER_RECENT_DAYS = 30;
const SITEMAP_PLAYER_MIN_SEARCHES = 2;

/**
 * 사이트맵용 공개 플레이어 목록. getPlayerSeoState와 같은 기준(검색 이력·시즌 전적·비공개 제외)에 최근 검색 조건을 더한다.
 * 조회나 비공개 목록 확인이 실패하면 예외를 던져 빈 결과가 캐시되지 않게 한다.
 */
async function readPublicPlayersForSitemap(): Promise<{ platform: string; nickname: string; updatedAt: string | null }[]> {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/['";\s]+/g, "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").replace(/['";\s]+/g, "").trim();
  if (!url || !key) throw new Error("sitemap_players_unconfigured");
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const privateList = await getPrivatePlayersList(client);
  const since = new Date(Date.now() - SITEMAP_PLAYER_RECENT_DAYS * 86_400_000).toISOString();
  // 같은 검색 수끼리 순서가 흔들리지 않게 id로도 정렬한다.
  const { data, error } = await client.from("pubg_player_cache").select("id, platform, nickname, updated_at")
    .gte("search_count", SITEMAP_PLAYER_MIN_SEARCHES).gte("last_seen_at", since).not("season_stats_data", "is", null)
    .order("search_count", { ascending: false }).order("id").limit(SITEMAP_PLAYER_LIMIT);
  if (error || !data) throw new Error("sitemap_players_query_failed");
  return data
    .filter((row) => row.nickname && !matchesPrivatePlayer(privateList, row.platform, row.nickname, row.id ?? undefined))
    .map((row) => ({ platform: String(row.platform), nickname: String(row.nickname), updatedAt: row.updated_at ?? null }));
}

// 사이트맵은 요청마다 만들어지므로 플레이어 목록은 하루 한 번만 다시 읽는다.
// shortcut: 비공개 전환은 최대 하루 뒤 사이트맵에서 빠진다(페이지 자체는 즉시 비공개). 바로 빼야 하면 비공개 저장 시 태그 무효화를 더한다.
export const listPublicPlayersForSitemap = unstable_cache(readPublicPlayersForSitemap, ["stats-sitemap-players-v1"], { revalidate: 86_400 });
