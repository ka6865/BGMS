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
   cursor?: string | null,
   limit = 20
 ): Promise<{ matches: PlayerMatchRecord[]; nextCursor: string | null }> {
   const playerId = normalizeName(nickname);
   const normPlatform = normalizePlatform(platform);
 
   let query = supabase
     .from("pubg_player_matches")
    .select("player_id, platform, match_id, played_at, game_mode, map_name, kills, damage, win_place, match_type")
     .eq("player_id", playerId)
     .eq("platform", normPlatform)
     .order("played_at", { ascending: false })
     .limit(limit);
 
   if (cursor) {
     query = query.lt("played_at", cursor);
   }
 
   const { data, error } = await query;
   if (error) {
     console.error("[playerMatches] fetch failed:", error.message);
     return { matches: [], nextCursor: null };
   }
 
   const matches = (data || []) as PlayerMatchRecord[];
   const nextCursor = matches.length >= limit ? matches[matches.length - 1].played_at : null;
   return { matches, nextCursor };
 }
