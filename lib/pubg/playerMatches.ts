 import type { SupabaseClient } from "@supabase/supabase-js";
 import { normalizeName } from "@/lib/pubg-analysis/utils";
 import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
 
export interface PlayerMatchRecord {
   player_id: string;
   platform: string;
   match_id: string;
   played_at: string;
   game_mode: string;
   map_name: string;
   kills: number;
   damage: number;
   win_place: number;
  match_type: string;
}

export interface PlayerMatchesPage {
  matches: PlayerMatchRecord[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

const DEFAULT_PAGE_SIZE = 20;

export function normalizePlayerMatchesPage(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizePageSize(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PAGE_SIZE;
}
 
 export function buildCursorQueryFilter(nickname: string, platform: string, cursor?: string | null) {
   return {
     player_id: normalizeName(nickname),
     platform: normalizePlatform(platform),
     cursor: cursor || null,
   };
 }
 
export async function upsertPlayerMatches(
  supabase: SupabaseClient,
  records: PlayerMatchRecord[]
 ): Promise<boolean> {
   if (!records || records.length === 0) return true;
   const { error } = await supabase
     .from("pubg_player_matches")
     .upsert(records, { onConflict: "player_id,platform,match_id" });
   if (error) {
     console.error("[playerMatches] upsert failed:", error.message);
     return false;
   }
   return true;
 }
 
export async function fetchPlayerMatchesPaginated(
  supabase: SupabaseClient,
  nickname: string,
  platform: string,
  page = 1,
  limit = DEFAULT_PAGE_SIZE,
): Promise<PlayerMatchesPage> {
  const playerId = normalizeName(nickname);
  const normPlatform = normalizePlatform(platform);
  const safePage = normalizePlayerMatchesPage(page);
  const pageSize = normalizePageSize(limit);
  const from = (safePage - 1) * pageSize;
  const to = from + pageSize - 1;

  const query = supabase
    .from("pubg_player_matches")
    .select("player_id, platform, match_id, played_at, game_mode, map_name, kills, damage, win_place, match_type", { count: "exact" })
    .eq("player_id", playerId)
    .eq("platform", normPlatform)
    .order("played_at", { ascending: false })
    .order("match_id", { ascending: false })
    .range(from, to);

  const { data, error, count } = await query;
  if (error) {
    console.error("[playerMatches] fetch failed:", error.message);
    return { matches: [], page: safePage, pageSize, totalCount: 0, totalPages: 0 };
  }

  const matches = (data || []) as PlayerMatchRecord[];
  const totalCount = Math.max(0, count ?? 0);
  return {
    matches,
    page: safePage,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}
