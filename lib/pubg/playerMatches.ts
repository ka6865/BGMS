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
  knocks?: number | null;
  survival_time?: number | null;
}

export interface PlayerMatchesPage {
  matches: PlayerMatchRecord[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

/** Basic PUBG counters: preserve observed zero; missing/invalid stays null. */
export function normalizeBasicMatchStat(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2147483647
    ? Math.floor(value) : null;
}

/** Omit unobserved counters from conflict updates; inserts use nullable DB defaults. */
export function toPlayerMatchWriteRecord(record: PlayerMatchRecord): PlayerMatchRecord {
  const { knocks, survival_time, ...base } = record;
  const observedKnocks = normalizeBasicMatchStat(knocks);
  const observedSurvival = normalizeBasicMatchStat(survival_time);
  return {
    ...base,
    ...(observedKnocks !== null ? { knocks: observedKnocks } : {}),
    ...(observedSurvival !== null ? { survival_time: observedSurvival } : {}),
  };
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
   // PostgREST uses the union of a batch's keys for conflict updates. Group
   // identical column sets so a missing counter never becomes an explicit NULL.
   const batches = new Map<string, PlayerMatchRecord[]>();
   for (const input of records) {
     const record = toPlayerMatchWriteRecord(input);
     const key = Object.keys(record).sort().join(',');
     const batch = batches.get(key) ?? [];
     batch.push(record);
     batches.set(key, batch);
   }
   for (const batch of batches.values()) {
     const { error } = await supabase
       .from("pubg_player_matches")
       .upsert(batch, { onConflict: "player_id,platform,match_id" });
     if (error) {
       console.error("[playerMatches] upsert failed:", error.message);
       return false;
     }
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
    .select("player_id, platform, match_id, played_at, game_mode, map_name, kills, damage, win_place, match_type, knocks, survival_time", { count: "exact" })
    .eq("player_id", playerId)
    .eq("platform", normPlatform)
    .order("played_at", { ascending: false })
    .order("match_id", { ascending: false })
    .range(from, to);

  const { data, error, count } = await query;
  if (error) {
    console.error("[playerMatches] fetch failed:", error.message);
    throw error;
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
