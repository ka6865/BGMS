import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchLinkedPlayerSyncCandidates,
  type LinkedPlayerSyncCandidateRow,
} from "./linkedPlayerSync.server";

export interface SyncCandidateUser {
  nickname: string;
  platform: string;
  priority: 1 | 2;
  normalizedNickname: string;
  displayNickname: string;
  lastActiveAt: string;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
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
  const linkedCandidates = await fetchLinkedPlayerSyncCandidates({
    supabaseAdmin: supabase,
    limit,
  });

  const seen = new Set<string>();
  return linkedCandidates.flatMap((candidate: LinkedPlayerSyncCandidateRow) => {
    const identity = `${candidate.platform}:${candidate.normalizedNickname}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      nickname: candidate.displayNickname,
      platform: candidate.platform,
      priority: 1 as const,
      normalizedNickname: candidate.normalizedNickname,
      displayNickname: candidate.displayNickname,
      lastActiveAt: candidate.lastActiveAt,
      lastSuccessAt: candidate.lastSuccessAt,
      consecutiveFailures: candidate.consecutiveFailures,
    }];
  });
}
