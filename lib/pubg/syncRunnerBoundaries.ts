import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FetchRecentMatchIdsResult,
  SyncQuotaStatus,
  SyncRunSummary,
  SyncRunnerDependencies,
} from "../../scripts/sync_user_matches";
import {
  readPubgRateLimitHeaders,
  type PubgFetchImpl,
  type PubgRateLimitHeaderSnapshot,
} from "./playerMatchesIngest";
import type { SyncCandidateUser } from "./userSyncHelper";

export async function fetchRecentMatchIds(
  candidate: SyncCandidateUser,
  apiKey: string,
  fetchImpl: PubgFetchImpl,
  timeoutMs: number,
): Promise<FetchRecentMatchIdsResult> {
  try {
    const response = await fetchImpl(
      `https://api.pubg.com/shards/${candidate.platform}/players?filter[playerNames]=${encodeURIComponent(candidate.displayNickname)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
      },
    );
    const rateLimitHeaders = readPubgRateLimitHeaders(response.headers);
    if (!response.ok) return { status: response.status, matchIds: [], rateLimitHeaders };

    let data: any;
    try {
      data = await response.json();
    } catch (error) {
      return {
        status: 500,
        matchIds: [],
        rateLimitHeaders,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const player = data?.data?.[0];
    if (!player) return { status: 404, matchIds: [], rateLimitHeaders };
    const matchIds = (player.relationships?.matches?.data || [])
      .map((match: any) => String(match.id || ""))
      .filter(Boolean);
    return { status: 200, matchIds, rateLimitHeaders };
  } catch (error) {
    return {
      status: 0,
      matchIds: [],
      rateLimitHeaders: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readExistingMatchIds(
  supabase: SupabaseClient,
  candidate: SyncCandidateUser,
  matchIds: string[],
): Promise<string[]> {
  if (matchIds.length === 0) return [];
  const { data, error } = await supabase
    .from("pubg_player_matches")
    .select("match_id")
    .eq("player_id", candidate.normalizedNickname)
    .eq("platform", candidate.platform)
    .in("match_id", matchIds);
  if (error) throw error;
  return (data || [])
    .map((row: { match_id?: unknown }) => String(row.match_id || ""))
    .filter(Boolean);
}

export async function readLatestQuota(supabase: SupabaseClient): Promise<SyncQuotaStatus | null> {
  const { data, error } = await supabase
    .from("pubg_api_status")
    .select("remaining, reset_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const remaining = Number(data.remaining);
  if (!Number.isFinite(remaining)) return null;
  return {
    remaining,
    resetAt: typeof data.reset_at === "string" ? data.reset_at : null,
  };
}

export async function recordRateLimit(
  summary: SyncRunSummary,
  headers: PubgRateLimitHeaderSnapshot | null,
  source: "player" | "match",
  tracker?: SyncRunnerDependencies["trackRateLimit"],
): Promise<void> {
  if (!headers) return;
  if (source === "player") summary.playerRateLimitHeaders.push(headers);
  else summary.matchRateLimitHeaders.push(headers);
  if (!tracker) return;
  try {
    await tracker(headers, source);
  } catch {
    summary.rateLimitTrackingErrors += 1;
  }
}

export async function persistRateLimitSnapshot(
  supabase: SupabaseClient,
  headers: PubgRateLimitHeaderSnapshot,
): Promise<void> {
  if (headers.limit === null || headers.remaining === null || headers.resetAt === null) return;
  const { error } = await supabase.from("pubg_api_status").insert({
    api_limit: headers.limit,
    remaining: headers.remaining,
    reset_at: headers.resetAt,
  });
  if (error) throw error;
}

export function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
