 import type { SupabaseClient } from "@supabase/supabase-js";
 import { normalizeName } from "@/lib/pubg-analysis/utils";
 
 export interface SyncCandidateUser {
   nickname: string;
   platform: string;
   priority: 1 | 2;
 }
 
 export function isSyncEligible(updatedAtIso?: string | null, thresholdDays = 10, nowMs = Date.now()): boolean {
   if (!updatedAtIso) return true;
   const updatedMs = new Date(updatedAtIso).getTime();
   if (!Number.isFinite(updatedMs)) return true;
   return updatedMs < (nowMs - thresholdDays * 24 * 60 * 60 * 1000);
 }
 
 export async function fetchSyncCandidateUsers(
   supabase: SupabaseClient,
   limit = 15
 ): Promise<SyncCandidateUser[]> {
   const candidates: SyncCandidateUser[] = [];
   const tenDaysAgoIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
 
   // 1순위: profiles 내 닉네임 연동 유저
   const { data: profileUsers } = await supabase
     .from("profiles")
     .select("pubg_nickname, pubg_platform, updated_at")
     .not("pubg_nickname", "is", null)
     .lt("updated_at", tenDaysAgoIso)
     .limit(limit);
 
   if (profileUsers) {
     for (const p of profileUsers) {
       if (p.pubg_nickname) {
         candidates.push({
           nickname: p.pubg_nickname,
           platform: p.pubg_platform || "steam",
           priority: 1,
         });
       }
     }
   }
 
   if (candidates.length >= limit) {
     return candidates.slice(0, limit);
   }
 
   // 2순위: pubg_player_cache 내 고빈도 유저 (search_count >= 3)
   const remainingLimit = limit - candidates.length;
   const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
   const { data: cacheUsers } = await supabase
     .from("pubg_player_cache")
     .select("nickname, platform, search_count, last_seen_at, updated_at")
     .gte("search_count", 3)
     .gt("last_seen_at", thirtyDaysAgoIso)
     .lt("updated_at", tenDaysAgoIso)
     .order("updated_at", { ascending: true })
     .limit(remainingLimit);
 
   if (cacheUsers) {
     const existingNicknames = new Set(candidates.map((c) => normalizeName(c.nickname)));
     for (const c of cacheUsers) {
       if (c.nickname && !existingNicknames.has(normalizeName(c.nickname))) {
         candidates.push({
           nickname: c.nickname,
           platform: c.platform || "steam",
           priority: 2,
         });
       }
     }
   }
 
   return candidates.slice(0, limit);
 }
