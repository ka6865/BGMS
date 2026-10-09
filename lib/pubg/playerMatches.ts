 import type { SupabaseClient } from "@supabase/supabase-js";
 import { normalizeName } from "@/lib/pubg-analysis/utils";
 import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
 
export interface PlayerMatchRecord {
  account_id?: string;
  retention_scope?: "legacy" | "basic_only" | "detail";
  ranking_eligible?: boolean;
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

export type PlayerMatchHistoryFilter = "all" | "normal" | "ranked" | "casual" | "tdm";

export function buildPlayerMatchIdentityFilter(nickname: string, accountId?: string | null): string | null {
  if (!accountId || !/^account\.[A-Za-z0-9_-]+$/.test(accountId)) return null;
  return `account_id.eq.${accountId},and(account_id.is.null,player_id.eq.${JSON.stringify(normalizeName(nickname))})`;
}

const PLAYER_MATCH_HISTORY_FILTERS = new Set<PlayerMatchHistoryFilter>([
  "all",
  "normal",
  "ranked",
  "casual",
  "tdm",
]);

export function normalizePlayerMatchHistoryFilter(value: unknown): PlayerMatchHistoryFilter {
  return typeof value === "string" && PLAYER_MATCH_HISTORY_FILTERS.has(value as PlayerMatchHistoryFilter)
    ? value as PlayerMatchHistoryFilter
    : "all";
}

/** Basic PUBG counters: preserve observed zero; missing/invalid stays null. */
export function normalizeBasicMatchStat(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2147483647
    ? Math.floor(value) : null;
}

/** Required NOT NULL fields must be observed, not filled with display defaults. */
export function hasObservedPlayerMatchValues(value: unknown, options: { allowZeroPlacement?: boolean } = {}): value is PlayerMatchRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const integer = (v: unknown, minimum: number) => typeof v === "number"
    && Number.isSafeInteger(v) && v >= minimum && v <= 2147483647;
  const knownText = (v: unknown) => typeof v === "string" && Boolean(v.trim())
    && !["unknown", "unavailable"].includes(v.trim().toLowerCase());
  return integer(row.kills, 0) && integer(row.win_place, options.allowZeroPlacement ? 0 : 1)
    && typeof row.damage === "number" && Number.isFinite(row.damage)
    && row.damage >= 0 && row.damage <= 2147483647
    && typeof row.played_at === "string" && Number.isFinite(Date.parse(row.played_at))
    && knownText(row.game_mode) && knownText(row.map_name)
    && row.match_type !== "unavailable";
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
  records: PlayerMatchRecord[],
  options: { ignoreDuplicates?: boolean; throwOnError?: boolean; atomic?: boolean } = {},
 ): Promise<boolean> {
   if (!records || records.length === 0) return true;
   if (records.some(record => !hasObservedPlayerMatchValues(record))) return false;
   const accounts = new Map<string, string>();
   for (const record of records) {
     const key = JSON.stringify([record.player_id, record.platform, record.match_id]);
     if (record.account_id) {
       if (accounts.has(key) && accounts.get(key) !== record.account_id) return false;
       accounts.set(key, record.account_id);
     }
   }
   const { atomic, throwOnError, ...writeOptions } = options;
   if (atomic) {
     const { data, error } = await supabase.rpc("upsert_pubg_participant_matches", {
       p_records: records.map(toPlayerMatchWriteRecord),
     });
     const failure = error ?? (data !== records.length ? new Error("player-match-upsert-count-mismatch") : null);
     if (failure) {
       if (throwOnError) throw failure;
       console.error("[playerMatches] upsert failed:", failure.message);
       return false;
     }
     return true;
   }
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
     const unique = new Map(batch.map(record => [JSON.stringify([record.player_id, record.platform, record.match_id]), record]));
     const { error } = await supabase
       .from("pubg_player_matches")
       .upsert([...unique.values()], { onConflict: "player_id,platform,match_id", ...writeOptions });
     if (error) {
       if (throwOnError) throw error;
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
  filter: PlayerMatchHistoryFilter = "all",
  accountId?: string | null,
): Promise<PlayerMatchesPage> {
  const playerId = normalizeName(nickname);
  const normPlatform = normalizePlatform(platform);
  const safePage = normalizePlayerMatchesPage(page);
  const pageSize = normalizePageSize(limit);
  const from = (safePage - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("pubg_player_matches")
    .select("player_id, platform, account_id, retention_scope, match_id, played_at, game_mode, map_name, kills, damage, win_place, match_type, knocks, survival_time", { count: "exact" })
    .eq("platform", normPlatform);
  const identityFilter = buildPlayerMatchIdentityFilter(nickname, accountId);
  query = identityFilter ? query.or(identityFilter) : query.eq("player_id", playerId);

  if (filter === "ranked") {
    query = query.or("match_type.ilike.%competitive%,match_type.ilike.%ranked%,game_mode.ilike.%competitive%,game_mode.ilike.%ranked%");
  } else if (filter === "casual") {
    query = query.or("match_type.ilike.%airoyale%,match_type.ilike.%botmatch%,game_mode.ilike.%-ai,game_mode.ilike.ai-%,game_mode.ilike.%-ai-%,game_mode.ilike.%-bot,game_mode.ilike.bot-%,game_mode.ilike.%-bot-%");
  } else if (filter === "tdm") {
    query = query.or("game_mode.ilike.%tdm%,map_name.ilike.PillarCompound_Main,map_name.ilike.Italy_TDM_Main");
  } else if (filter === "normal") {
    query = query
      .not("match_type", "ilike", "%competitive%")
      .not("match_type", "ilike", "%ranked%")
      .not("match_type", "in", "(unknown,unavailable)")
      .not("game_mode", "ilike", "%competitive%")
      .not("game_mode", "ilike", "%ranked%")
      .not("game_mode", "ilike", "%tdm%")
      .not("map_name", "in", "(PillarCompound_Main,Italy_TDM_Main)");
  }

  const { data, error, count } = await query
    .order("played_at", { ascending: false })
    .order("match_id", { ascending: false })
    .range(from, to);
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
