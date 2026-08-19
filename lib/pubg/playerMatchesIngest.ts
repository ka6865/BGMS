import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { upsertPlayerMatches, type PlayerMatchRecord } from "./playerMatches";

export interface IngestParticipantInput {
  matchId: string;
  nickname: string;
  platform: string;
  createdAt: string;
  matchType?: string;
  gameMode: string;
  mapName: string;
  kills: number;
  damage: number;
  winPlace: number;
}

export function buildPlayerMatchRecordFromParticipant(input: IngestParticipantInput): PlayerMatchRecord {
  return {
    player_id: normalizeName(input.nickname),
    platform: normalizePlatform(input.platform),
    match_id: input.matchId,
    played_at: input.createdAt,
    game_mode: input.gameMode,
    map_name: input.mapName,
    kills: input.kills,
    damage: Math.floor(input.damage),
    win_place: input.winPlace,
    match_type: input.matchType || "unknown",
  };
}

export type BasicMatchIngestStatus =
  | "saved"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "network_error";

/** The rate-limit headers observed on one PUBG API response. */
export interface PubgRateLimitHeaderSnapshot {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  resetAt: string | null;
  retryAfter: number | null;
  retryAfterMs: number | null;
}

export interface BasicMatchIngestOutcome {
  status: BasicMatchIngestStatus;
  record: PlayerMatchRecord | null;
  httpStatus: number | null;
  rateLimitHeaders: PubgRateLimitHeaderSnapshot | null;
  error?: string;
}

export type PubgFetchImpl = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface BasicMatchIngestOptions {
  fetchImpl?: PubgFetchImpl;
  timeoutMs?: number;
  onResponseStatus?: (status: number) => void;
}

type BasicMatchIngestCallback = ((status: number) => void) | BasicMatchIngestOptions;

/**
 * Extracts the PUBG quota headers without coupling the worker to a database
 * tracker. The caller can persist this snapshot or pass the Headers object to
 * the existing tracker at its own boundary.
 */
export function readPubgRateLimitHeaders(headers: Headers | null | undefined): PubgRateLimitHeaderSnapshot | null {
  if (!headers) return null;

  const limit = parseHeaderNumber(headers, ["x-ratelimit-limit"]);
  const remaining = parseHeaderNumber(headers, ["x-ratelimit-remaining"]);
  const reset = parseHeaderNumber(headers, ["x-ratelimit-reset"]);
  const retryAfter = parseHeaderNumber(headers, ["retry-after"]);
  const resetAt = reset === null
    ? parseHeaderDate(headers, ["x-ratelimit-reset"])
    : new Date((reset > 10_000_000_000 ? reset : reset * 1_000)).toISOString();
  const retryAfterMs = retryAfter === null
    ? null
    : retryAfter > 10_000 ? retryAfter : retryAfter * 1_000;

  if (limit === null && remaining === null && reset === null && retryAfter === null && resetAt === null) {
    return null;
  }

  return { limit, remaining, reset, resetAt, retryAfter, retryAfterMs };
}

/**
 * Fetches one match and returns a machine-readable disposition. The
 * compatibility wrapper below intentionally keeps its historical nullable
 * record contract for API routes.
 */
export async function fetchAndIngestBasicMatchSummaryOutcome(
  supabase: SupabaseClient,
  matchId: string,
  nickname: string,
  platform: string,
  apiKey: string,
  callbackOrOptions?: BasicMatchIngestCallback,
): Promise<BasicMatchIngestOutcome> {
  const options = typeof callbackOrOptions === "function"
    ? { onResponseStatus: callbackOrOptions }
    : (callbackOrOptions || {});
  const fetchImpl = options.fetchImpl || fetch;
  const normPlatform = normalizePlatform(platform);
  const playerId = normalizeName(nickname);
  const timeoutMs = options.timeoutMs ?? 5_000;

  try {
    const res = await fetchImpl(
      `https://api.pubg.com/shards/${normPlatform}/matches/${encodeURIComponent(matchId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
      },
    );
    const rateLimitHeaders = readPubgRateLimitHeaders(res.headers);

    if (!res.ok) {
      options.onResponseStatus?.(res.status);
      return {
        status: res.status === 404
          ? "not_found"
          : res.status === 429
            ? "rate_limited"
            : "upstream_error",
        record: null,
        httpStatus: res.status,
        rateLimitHeaders,
      };
    }

    let data: any;
    try {
      data = await res.json();
    } catch (error) {
      return {
        status: "upstream_error",
        record: null,
        httpStatus: res.status,
        rateLimitHeaders,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const matchAttr = data.data?.attributes || {};
    const participants = (data.included || []).filter((it: any) => it.type === "participant");
    const myParticipant = participants.find(
      (p: any) => normalizeName(p.attributes?.stats?.name) === playerId,
    );
    if (!myParticipant?.attributes?.stats) {
      return { status: "not_found", record: null, httpStatus: res.status, rateLimitHeaders };
    }

    const stats = myParticipant.attributes.stats;
    const record: PlayerMatchRecord = {
      player_id: playerId,
      platform: normPlatform,
      match_id: matchId,
      played_at: matchAttr.createdAt || new Date().toISOString(),
      game_mode: matchAttr.gameMode || "unknown",
      map_name: matchAttr.mapName || "unknown",
      kills: stats.kills || 0,
      damage: Math.floor(stats.damageDealt || 0),
      win_place: stats.winPlace || 99,
      match_type: String(matchAttr.matchType || "unknown").toLowerCase(),
    };

    let persisted = false;
    try {
      persisted = await upsertPlayerMatches(supabase, [record]);
    } catch (error) {
      return {
        status: "upstream_error",
        record: null,
        httpStatus: res.status,
        rateLimitHeaders,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!persisted) {
      return {
        status: "upstream_error",
        record: null,
        httpStatus: res.status,
        rateLimitHeaders,
        error: "player-match-upsert-failed",
      };
    }

    return { status: "saved", record, httpStatus: res.status, rateLimitHeaders };
  } catch (error) {
    return {
      status: "network_error",
      record: null,
      httpStatus: null,
      rateLimitHeaders: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Keep descriptive aliases available to workers that prefer either naming
// convention while having one implementation and one result contract.
export const fetchAndIngestBasicMatchSummaryStructured = fetchAndIngestBasicMatchSummaryOutcome;
export const fetchAndIngestBasicMatchSummaryWithOutcome = fetchAndIngestBasicMatchSummaryOutcome;

export async function fetchAndIngestBasicMatchSummary(
  supabase: SupabaseClient,
  matchId: string,
  nickname: string,
  platform: string,
  apiKey: string,
  onResponseStatus?: (status: number) => void,
): Promise<PlayerMatchRecord | null> {
  const outcome = await fetchAndIngestBasicMatchSummaryOutcome(
    supabase,
    matchId,
    nickname,
    platform,
    apiKey,
    { onResponseStatus },
  );
  return outcome.status === "saved" ? outcome.record : null;
}

function parseHeaderNumber(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value === null || value.trim() === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseHeaderDate(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (!value || !Number.isFinite(Date.parse(value))) continue;
    return new Date(value).toISOString();
  }
  return null;
}
