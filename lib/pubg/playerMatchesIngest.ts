import { evaluateMatchEligibility } from "@/lib/pubg-analysis/matchEligibility";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { hasObservedPlayerMatchValues, normalizeBasicMatchStat, upsertPlayerMatches, type PlayerMatchRecord } from "./playerMatches";
import { getPrivatePlayersList, matchesPrivatePlayer, type PrivatePlayer } from "./privatePlayers";

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
  knocks?: unknown;
  survivalTime?: unknown;
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
    knocks: normalizeBasicMatchStat(input.knocks),
    survival_time: normalizeBasicMatchStat(input.survivalTime),
    match_type: input.matchType || "unknown",
  };
}

/** Official response observations only; ambiguous identities never become history. */
export function buildOfficialParticipantMatchRecords(input: {
  matchId: string; platform: string; matchAttr: Record<string, unknown>;
  participants: readonly unknown[]; privatePlayers: readonly PrivatePlayer[];
}): PlayerMatchRecord[] {
  const { matchId, platform, matchAttr, privatePlayers } = input;
  if (!matchId || !["steam", "kakao"].includes(platform)
    || (matchAttr.shardId !== undefined && matchAttr.shardId !== platform)) return [];
  const participants = input.participants.map(participant => {
    const stats = (participant as { attributes?: { stats?: Record<string, unknown> } } | null)?.attributes?.stats;
    return stats && typeof stats === "object" && !Array.isArray(stats) ? stats : null;
  });
  const names = new Map<string, number>();
  const accounts = new Map<string, number>();
  for (const stats of participants) {
    if (!stats) continue;
    if (typeof stats.name === "string" && normalizeName(stats.name)) {
      const name = normalizeName(stats.name);
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    if (typeof stats.playerId === "string" && /^account\.[A-Za-z0-9_-]+$/.test(stats.playerId)) {
      accounts.set(stats.playerId, (accounts.get(stats.playerId) ?? 0) + 1);
    }
  }
  const records: PlayerMatchRecord[] = [];
  for (const stats of participants) {
    if (!stats || typeof stats.name !== "string" || typeof stats.playerId !== "string"
      || !/^account\.[A-Za-z0-9_-]+$/.test(stats.playerId)) continue;
    const playerId = normalizeName(stats.name);
    if (!playerId || names.get(playerId) !== 1 || accounts.get(stats.playerId) !== 1
      || matchesPrivatePlayer(privatePlayers, platform, stats.name, stats.playerId)) continue;
    const record = {
      account_id: stats.playerId, retention_scope: "basic_only" as const,
      ranking_eligible: evaluateMatchEligibility({ ...matchAttr, stats }, "benchmark").eligible,
      player_id: playerId, platform, match_id: matchId, played_at: matchAttr.createdAt,
      game_mode: matchAttr.gameMode, map_name: matchAttr.mapName,
      kills: stats.kills, damage: stats.damageDealt, win_place: stats.winPlace,
      knocks: normalizeBasicMatchStat(stats.DBNOs), survival_time: normalizeBasicMatchStat(stats.timeSurvived),
      match_type: typeof matchAttr.matchType === "string" ? matchAttr.matchType.trim().toLowerCase() : "unknown",
    };
    const noPlacement = record.win_place === 0 && (record.match_type === "tutorialatoz" || record.game_mode === "tdm");
    if (!hasObservedPlayerMatchValues(record, { allowZeroPlacement: noPlacement })) continue;
    record.damage = Math.floor(record.damage);
    records.push(record);
  }
  return records;
}

export type BasicMatchIngestStatus =
  | "saved"
  | "not_found"
  | "unsupported_match"
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
  expectedAccountId?: string;
  fetchImpl?: PubgFetchImpl;
  signal?: AbortSignal;
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
  if (!["steam", "kakao"].includes(platform.trim().toLowerCase())) {
    return { status: "upstream_error", record: null, httpStatus: null, rateLimitHeaders: null, error: "match-identity-invalid" };
  }

  try {
    const res = await fetchImpl(
      `https://api.pubg.com/shards/${normPlatform}/matches/${encodeURIComponent(matchId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
    );
    const rateLimitHeaders = readPubgRateLimitHeaders(res.headers);

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
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

    const matchAttr = data?.data?.attributes || {};
    const responseMatchId = data?.data?.id;
    if (typeof responseMatchId !== "string" || responseMatchId.replace(/^shard:/, '') !== matchId
      || (matchAttr.shardId !== undefined && matchAttr.shardId !== normPlatform)) {
      return { status: 'upstream_error', record: null, httpStatus: res.status, rateLimitHeaders, error: 'match-identity-invalid' };
    }
    const participants = (Array.isArray(data.included) ? data.included : []).filter((it: any) => it?.type === "participant");
    const targets = participants.filter(
      (p: any) => options.expectedAccountId
        ? p.attributes?.stats?.playerId === options.expectedAccountId
        : typeof p.attributes?.stats?.name === "string" && normalizeName(p.attributes.stats.name) === playerId,
    );
    if (targets.length !== 1 || !targets[0]?.attributes?.stats) {
      return { status: options.expectedAccountId || targets.length > 1 ? "upstream_error" : "not_found", record: null, httpStatus: res.status, rateLimitHeaders };
    }

    const stats = targets[0].attributes.stats;
    if (options.expectedAccountId && (typeof stats.name !== 'string' || !stats.name.trim())) {
      return { status: 'upstream_error', record: null, httpStatus: res.status, rateLimitHeaders, error: 'participant-name-missing' };
    }
    let privatePlayers: PrivatePlayer[];
    try { privatePlayers = await getPrivatePlayersList(supabase); }
    catch { return { status: "upstream_error", record: null, httpStatus: res.status, rateLimitHeaders, error: "player-privacy-check-failed" }; }
    const records = buildOfficialParticipantMatchRecords({ matchId, platform: normPlatform, matchAttr, participants, privatePlayers });
    const record = records.find(row => row.account_id === stats.playerId && row.player_id === normalizeName(stats.name));
    if (!record) {
      return { status: "upstream_error", record: null, httpStatus: res.status, rateLimitHeaders, error: "match-basic-values-missing" };
    }
    // 다른 필수값까지 관측된 순위 없는 훈련·TDM만 영구 제외한다. DB 순위 계약은 유지한다.
    if (record.win_place === 0) {
      return { status: 'unsupported_match', record: null, httpStatus: res.status, rateLimitHeaders, error: 'match-placement-unavailable' };
    }
    let persisted = false;
    try {
      persisted = await upsertPlayerMatches(supabase, records.filter(row => row.win_place > 0));
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
