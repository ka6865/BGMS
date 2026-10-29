import "server-only";
import { recordLolOpsMetric } from "./ops.server";
import { createServiceRoleSupabase } from "@/lib/server/serviceRoleSupabase.server";
import type { LolRankedPoint, LolRankedHistory, LolPlayerMatchSummary, LolAccountDeletion } from "@/lib/lol/types";
import type { LolChallengeCatalog } from "./challengeProfile";
import type { LolRankedObservation } from "./lpChange";
export type { LolRankedPoint, LolRankedDailyPoint, LolRankedHistory } from "@/lib/lol/types";

export type LolRiotHost = "asia" | "kr";
export type LolPlatform = "kr" | "jp1" | "na1" | "br1" | "la1" | "la2" | "eun1" | "euw1" | "me1" | "tr1" | "ru" | "oc1" | "sg2" | "tw2" | "vn2";
export type LolRegionalRoute = "americas" | "asia" | "europe" | "sea";

export class LolPersistenceError extends Error {
  readonly kind = "persistence";
  constructor() { super("LoL persistence unavailable"); }
}

export class LolLeaseExpiredError extends Error {
  constructor() { super("LoL collection lease expired"); }
}

export class LolPermitError extends Error {
  constructor(readonly kind: "busy" | "rate_limited", readonly retryAfterSeconds: number) { super(kind); }
}

export function emptyLolRankedHistory(): LolRankedHistory {
  return {
    RANKED_SOLO_5x5: { points: [], highest: null, trackingSince: null },
    RANKED_FLEX_SR: { points: [], highest: null, trackingSince: null },
  };
}

export async function getLolRankedHistory(puuid: string): Promise<LolRankedHistory> {
  const history = await rpc<LolRankedHistory>("get_lol_ranked_history", { p_puuid: puuid, p_limit: 30 });
  const result = emptyLolRankedHistory();
  const point = ({ recordedAt, tier, rank, lp }: LolRankedPoint): LolRankedPoint => ({ recordedAt, tier, rank, lp });
  for (const queue of ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"] as const) {
    const entry = history[queue];
    result[queue] = {
      points: entry.points.map(({ date, wins, losses, isBaseline, ...value }) => ({
        ...point(value), date, wins, losses, isBaseline,
      })),
      highest: entry.highest ? point(entry.highest) : null,
      trackingSince: entry.trackingSince,
    };
  }
  return result;
}

type CacheKind = "search" | "match_details";
type Lease = { key: string; token: string };
type SearchSnapshot = {
  lease: Lease; cacheKey: string; cachePayload: unknown; platform: LolPlatform; route: LolRegionalRoute; version: string;
  account: { puuid: string; gameName: string; tagLine: string; profileIconId: number; summonerLevel: number };
  ranked: Array<{ queueType: string; tier: string; rank: string; leaguePoints: number; wins: number; losses: number }>;
  matches: Array<{ summary: unknown; raw: unknown }>;
};
type MatchSnapshot = {
  lease: Lease; cacheKey: string; cachePayload: unknown; platform: LolPlatform; route: LolRegionalRoute; version: string;
  raw: unknown; participants: unknown[]; teams: unknown[];
};

function db() { return createServiceRoleSupabase(); }

const LOL_DB_TIMEOUT_MS = 10_000;

function persistenceFailure(operation: string, error: unknown, signal: AbortSignal): never {
  if (["persist_lol_search_snapshot", "persist_lol_match_details"].includes(operation)
    && error && typeof error === "object" && "code" in error && error.code === "40001") throw new LolLeaseExpiredError();
  const cause = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : undefined;
  const timedOut = signal.aborted || cause?.name === "TimeoutError" || cause?.name === "AbortError"
    || (typeof cause?.message === "string" && /AbortError|TimeoutError|timed?\s*out/i.test(cause.message));
  recordLolOpsMetric(timedOut ? "db_timeout" : "db_error");
  console.error("[lol-persistence] request_failed", JSON.stringify({
    operation, stage: "database", reasonCode: timedOut ? "timeout" : "db_error",
  }));
  throw new LolPersistenceError();
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const signal = AbortSignal.timeout(LOL_DB_TIMEOUT_MS);
  try {
    const { data, error } = await db().rpc(name, args).abortSignal(signal);
    if (error) throw error;
    return data as T;
  } catch (error) {
    return persistenceFailure(name, error, signal);
  }
}

export function isLolPersistenceEnabled(): boolean {
  return process.env.LOL_PERSISTENCE_ENABLED === "true";
}

export function lolSearchCacheKey(gameName: string, tagLine: string, platform: LolPlatform, route: LolRegionalRoute, version: string): string {
  return `search:v11:${platform}:${route}:${version}:${encodeURIComponent(gameName.toLocaleLowerCase())}:${encodeURIComponent(tagLine.toLocaleLowerCase())}`;
}

export async function getLolChallengeCatalogCache(): Promise<LolChallengeCatalog | undefined> {
  return (await rpc<LolChallengeCatalog | null>("get_lol_challenge_catalog_cache", {})) ?? undefined;
}

export async function putLolChallengeCatalogCache(payload: LolChallengeCatalog, lease: Lease): Promise<void> {
  await rpc("put_lol_challenge_catalog_cache", { p_payload: payload, p_lease_key: lease.key, p_token: lease.token });
}

export async function getLolAccountByRiotId(gameName: string, tagLine: string): Promise<{ puuid: string; gameName: string; tagLine: string; accountFetchedAt: string } | undefined> {
  const signal = AbortSignal.timeout(LOL_DB_TIMEOUT_MS);
  try {
    const escapePattern = (value: string) => value.replace(/[\\%_]/g, "\\$&");
    const { data, error } = await db().from("lol_accounts").select("puuid,game_name,tag_line,account_fetched_at")
      .eq("platform_id", "kr").eq("regional_route", "asia")
      .ilike("game_name", escapePattern(gameName)).ilike("tag_line", escapePattern(tagLine))
      .limit(10).abortSignal(signal);
    if (error) throw error;
    const row = data?.find((account: any) => account.game_name.toLocaleLowerCase() === gameName.toLocaleLowerCase()
      && account.tag_line.toLocaleLowerCase() === tagLine.toLocaleLowerCase());
    return row ? { puuid: row.puuid, gameName: row.game_name, tagLine: row.tag_line, accountFetchedAt: row.account_fetched_at } : undefined;
  } catch (error) {
    return persistenceFailure("get_lol_account_by_riot_id", error, signal);
  }
}

export type LolAccountName = { puuid: string; game_name: string; tag_line: string; account_fetched_at: string };

export async function getLolAccountNamesByPuuids(puuids: string[]): Promise<LolAccountName[]> {
  return rpc<LolAccountName[]>("get_lol_account_names_by_puuids", { p_puuids: puuids });
}

export function lolMatchCacheKey(matchId: string, platform: LolPlatform, route: LolRegionalRoute, version: string): string {
  return `match:v1:${platform}:${route}:${version}:${encodeURIComponent(matchId)}`;
}

export async function getLolApiCache<T>(kind: CacheKind, key: string, platform: LolPlatform, route: LolRegionalRoute, version: string): Promise<T | undefined> {
  const cached = await rpc<T | null>("get_lol_api_cache", {
    p_key: key, p_kind: kind, p_platform: platform, p_route: route, p_version: version,
  });
  const prefix = kind === "search" ? "search" : "detail";
  recordLolOpsMetric(cached == null ? `${prefix}_cache_miss` : `${prefix}_cache_hit`);
  return cached ?? undefined;
}

export async function getLolMatchRequestJson(matchId: string, platform: LolPlatform, route: LolRegionalRoute, includeExpired = false): Promise<unknown | undefined> {
  const raw = await rpc<unknown | null>(includeExpired ? "get_lol_benchmark_match_source" : "get_lol_match_request_json", {
    p_match_id: matchId, p_platform: platform, p_route: route,
  });
  if (raw != null) recordLolOpsMetric("raw_reuse");
  return raw ?? undefined;
}

export async function acquireLolCollectionLease(key: string, ttlSeconds: number): Promise<Lease | null> {
  const rows = await rpc<Array<{ lease_token: string }>>("acquire_lol_collection_lease", { p_key: key, p_ttl_seconds: ttlSeconds });
  return rows?.[0]?.lease_token ? { key, token: rows[0].lease_token } : null;
}

export async function releaseLolCollectionLease(lease: Lease): Promise<void> {
  await rpc<boolean>("release_lol_collection_lease", { p_key: lease.key, p_token: lease.token });
}

// 백그라운드 수집기는 LOL_RIOT_PRIORITY=background로 실행해 사용자 검색보다 적은 몫만 쓴다.
export function lolRiotPriority(): "interactive" | "background" {
  return process.env.LOL_RIOT_PRIORITY === "background" ? "background" : "interactive";
}

export async function reserveLolRiotRequest(host: LolRiotHost): Promise<{ token: string; permitAt: number; started: boolean }> {
  const rows = await rpc<Array<{ granted: boolean; lease_token: string | null; permit_at: string | null; retry_after_seconds: number; reason: string; started?: boolean | null }>>(
    "reserve_lol_riot_request", { p_host: host, p_priority: lolRiotPriority() },
  );
  const result = rows?.[0];
  if (!result) throw new LolPersistenceError();
  if (!result.granted || !result.lease_token || !result.permit_at) {
    throw new LolPermitError(result.reason === "cooldown" || result.reason === "daily_budget" ? "rate_limited" : "busy", result.retry_after_seconds);
  }
  return { token: result.lease_token, permitAt: Date.parse(result.permit_at), started: result.started === true };
}

export async function startLolRiotRequest(token: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const rows = await rpc<Array<{ allowed: boolean; retry_after_seconds: number }>>("start_lol_riot_request", { p_token: token });
  if (!rows?.[0]) throw new LolPersistenceError();
  return { allowed: rows[0].allowed, retryAfterSeconds: rows[0].retry_after_seconds };
}

export async function releaseLolRiotRequest(token: string): Promise<void> {
  await rpc<boolean>("release_lol_riot_request", { p_token: token });
}

export async function blockLolRiotRequests(host: LolRiotHost, retryAfterSeconds: number): Promise<void> {
  await rpc<string>("block_lol_riot_requests", { p_host: host, p_retry_after_seconds: Math.min(604800, Math.max(1, retryAfterSeconds)) });
}

export async function recordLolRiotRateHeaders(host: LolRiotHost, headers: Headers): Promise<void> {
  const accepted = await rpc<boolean>("record_lol_riot_rate_headers", {
    p_host: host,
    p_app_limit: headers.get("X-App-Rate-Limit"),
    p_app_count: headers.get("X-App-Rate-Limit-Count"),
    p_method_limit: headers.get("X-Method-Rate-Limit"),
    p_method_count: headers.get("X-Method-Rate-Limit-Count"),
  });
  if (!accepted) throw new LolPermitError("rate_limited", 600);
}

// 응답 헤더 기록과 허가 해제를 한 번의 DB 왕복으로 처리한다.
export async function finishLolRiotRequest(token: string, host: LolRiotHost, headers: Headers): Promise<void> {
  const accepted = await rpc<boolean>("finish_lol_riot_request", {
    p_token: token,
    p_host: host,
    p_app_limit: headers.get("X-App-Rate-Limit"),
    p_app_count: headers.get("X-App-Rate-Limit-Count"),
    p_method_limit: headers.get("X-Method-Rate-Limit"),
    p_method_count: headers.get("X-Method-Rate-Limit-Count"),
  });
  if (!accepted) throw new LolPermitError("rate_limited", 600);
}

export async function persistLolSearchSnapshot(input: SearchSnapshot): Promise<void> {
  await rpc<boolean>("persist_lol_search_snapshot", {
    p_lease_key: input.lease.key, p_token: input.lease.token, p_cache_key: input.cacheKey, p_cache_payload: input.cachePayload,
    p_platform: input.platform, p_route: input.route, p_version: input.version,
    p_account: {
      puuid: input.account.puuid, game_name: input.account.gameName, tag_line: input.account.tagLine,
      profile_icon_id: input.account.profileIconId, summoner_level: input.account.summonerLevel,
    },
    p_ranked: input.ranked.map(({ queueType, tier, rank, leaguePoints, wins, losses }) => ({
      queue_type: queueType, tier, rank, league_points: leaguePoints, wins, losses,
    })),
    p_matches: input.matches.map(({ summary, raw }) => ({ summary, raw })),
  });
}

export async function persistLolMatchDetails(input: MatchSnapshot): Promise<void> {
  await rpc<boolean>("persist_lol_match_details", {
    p_lease_key: input.lease.key, p_token: input.lease.token, p_cache_key: input.cacheKey, p_cache_payload: input.cachePayload,
    p_platform: input.platform, p_route: input.route, p_version: input.version, p_match: input.raw,
    p_participants: input.participants, p_teams: input.teams,
  });
}

export async function cleanupExpiredLolPersistence(): Promise<{ cache_rows: number; match_rows: number; account_rows: number; lease_rows: number }> {
  const rows = await rpc<Array<{ cache_rows: number; match_rows: number; account_rows: number; lease_rows: number }>>("cleanup_lol_expired_data", {});
  if (!rows?.[0]) throw new LolPersistenceError();
  return rows[0];
}

export async function getLolPlayerMatchSummaries(puuid: string, limit = 20, before: string | null = null): Promise<LolPlayerMatchSummary[]> {
  return rpc<LolPlayerMatchSummary[]>("get_lol_player_match_summaries", { p_puuid: puuid, p_limit: limit, p_before: before });
}

export async function deleteLolAccountData(puuid: string): Promise<LolAccountDeletion> {
  return rpc<LolAccountDeletion>("delete_lol_account_data", { p_puuid: puuid });
}

export async function aggregateLolMatchBenchmarks(matchId: string): Promise<{ aggregated: boolean; skipped: boolean; reason: string | null }> {
  return rpc("aggregate_lol_match_benchmarks", { p_match_id: matchId });
}

export async function hasLolBenchmarkProcessedMatch(matchId: string): Promise<boolean> {
  const signal = AbortSignal.timeout(LOL_DB_TIMEOUT_MS);
  try {
    const { data, error } = await db().from("lol_benchmark_processed_matches").select("match_id")
      .eq("match_id", matchId).abortSignal(signal).maybeSingle();
    if (error) throw error;
    return data !== null;
  } catch (error) { return persistenceFailure("get_lol_benchmark_processed_match", error, signal); }
}

// 경기별 LP 증감 계산용 원본 랭크 관측. 화면 그래프용 RPC는 하루 마지막 값만 주므로 테이블을 직접 읽는다.
export async function getLolRankedObservations(puuid: string, since: string, limit = 300): Promise<LolRankedObservation[]> {
  const signal = AbortSignal.timeout(LOL_DB_TIMEOUT_MS);
  try {
    const { data, error } = await db().from("lol_ranked_history")
      .select("queue_type,tier,rank,league_points,wins,losses,recorded_at")
      .eq("puuid", puuid).gte("recorded_at", since)
      .order("recorded_at", { ascending: true }).order("id", { ascending: true })
      .limit(limit).abortSignal(signal);
    if (error) throw error;
    return (data ?? []).map((row: any) => ({
      queueType: row.queue_type, tier: row.tier, rank: row.rank, lp: row.league_points,
      wins: row.wins, losses: row.losses, recordedAt: row.recorded_at,
    }));
  } catch (error) { return persistenceFailure("get_lol_ranked_observations", error, signal); }
}

export async function hasLolStoredMatch(matchId: string): Promise<boolean> {
  const signal = AbortSignal.timeout(LOL_DB_TIMEOUT_MS);
  try {
    const { data, error } = await db().from("lol_matches").select("match_id")
      .eq("match_id", matchId).eq("platform_id", "kr").eq("regional_route", "asia").abortSignal(signal).maybeSingle();
    if (error) throw error;
    return data !== null;
  } catch (error) { return persistenceFailure("has_lol_stored_match", error, signal); }
}
