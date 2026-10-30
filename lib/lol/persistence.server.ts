import "server-only";
import { recordLolOpsMetric } from "./ops.server";
import type { RankingStore } from "./ranking";
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

export class LolSeasonCursorStaleError extends Error {
  constructor() { super("LoL season cursor changed"); }
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
  if (operation === "commit_lol_season_progress" && error && typeof error === "object" && "code" in error && error.code === "40001") {
    throw new LolSeasonCursorStaleError();
  }
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

// 마지막 성공 검색 결과(7일 보관) 키. 검색 DTO 버전이 바뀌면 함께 바뀌도록 검색 키에서 만든다.
export function lolSearchSnapshotKey(gameName: string, tagLine: string, platform: LolPlatform, route: LolRegionalRoute, version: string): string {
  return lolSearchCacheKey(gameName, tagLine, platform, route, version).replace(/^search:/, "search-snapshot:");
}

// 2분 검색 캐시와 달리 캐시 적중 지표는 세지 않는다. 지표 이름은 DB 허용 목록이 정한다.
// 저장 계정이 지금도 이 Riot ID의 유일한 저장 계정일 때만 돌려준다(DB에서 확인, Riot 호출 없음).
export async function getLolSearchSnapshot<T>(key: string, platform: LolPlatform, route: LolRegionalRoute, version: string,
  riotId: { gameName: string; tagLine: string }): Promise<T | undefined> {
  const cached = await rpc<T | null>("get_lol_search_snapshot", {
    p_key: key, p_platform: platform, p_route: route, p_version: version, p_game_name: riotId.gameName, p_tag_line: riotId.tagLine,
  });
  return cached ?? undefined;
}

// 한 Riot ID의 2분 검색 캐시와 보관본을 모든 Data Dragon 버전에서 지운다. 이름 변경을 확인했거나 계정 조회가 404일 때 쓴다.
export async function deleteLolSearchCacheForName(gameName: string, tagLine: string, platform: LolPlatform, route: LolRegionalRoute): Promise<void> {
  const suffix = `:${encodeURIComponent(gameName.toLocaleLowerCase())}:${encodeURIComponent(tagLine.toLocaleLowerCase())}`;
  await rpc<number>("delete_lol_search_cache_for_name", { p_platform: platform, p_route: route, p_name_suffix: suffix });
}

export async function putLolSearchSnapshot(input: {
  key: string; platform: LolPlatform; route: LolRegionalRoute; version: string; puuid: string; payload: unknown;
}): Promise<boolean> {
  return rpc<boolean>("put_lol_search_snapshot", {
    p_cache_key: input.key, p_platform: input.platform, p_route: input.route, p_version: input.version,
    p_puuid: input.puuid, p_payload: input.payload,
  });
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
    const rows = (data ?? []).filter((account: any) => account.game_name.toLocaleLowerCase() === gameName.toLocaleLowerCase()
      && account.tag_line.toLocaleLowerCase() === tagLine.toLocaleLowerCase());
    // 같은 Riot ID 행이 여럿이면 어느 계정인지 알 수 없으므로 다른 사람 기록을 섞지 않도록 찾지 못한 것으로 본다.
    const row = rows.length === 1 ? rows[0] : undefined;
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

export async function reserveLolRiotRequest(host: LolRiotHost, maxWaitMs?: number): Promise<{ token: string; permitAt: number; started: boolean }> {
  const rows = await rpc<Array<{ granted: boolean; lease_token: string | null; permit_at: string | null; retry_after_seconds: number; reason: string; started?: boolean | null }>>(
    "reserve_lol_riot_request", { p_host: host, p_priority: lolRiotPriority(), ...(maxWaitMs === undefined ? {} : { p_max_wait_ms: maxWaitMs }) },
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

// Riot에 보내기 전에 포기한 예약은 허가와 함께 예약 기록도 지워 한도를 돌려준다. 보낸 요청에는 쓰지 않는다.
export async function cancelLolRiotRequest(token: string): Promise<void> {
  await rpc<boolean>("cancel_lol_riot_request", { p_token: token });
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

// 공개 상세를 열 수 있는 경기인지 확인한다. 원문(7일)이 정리돼도 저장된 경기 요약에 있으면 허용해 Riot에서 다시 받는다.
export async function hasLolKnownMatch(matchId: string): Promise<boolean> {
  const signal = AbortSignal.timeout(LOL_DB_TIMEOUT_MS);
  try {
    const { data: raw, error: rawError } = await db().from("lol_matches").select("match_id")
      .eq("match_id", matchId).eq("platform_id", "kr").eq("regional_route", "asia").abortSignal(signal).maybeSingle();
    if (rawError) throw rawError;
    if (raw) return true;
    const { data: summaries, error: summaryError } = await db().from("lol_player_match_summaries").select("match_id")
      .eq("match_id", matchId).eq("platform_id", "kr").limit(1).abortSignal(signal);
    if (summaryError) throw summaryError;
    return (summaries?.length ?? 0) > 0;
  } catch (error) { return persistenceFailure("has_lol_known_match", error, signal); }
}

// 랭킹·장인 게시본과 시즌 누적 작업 테이블. 공개 화면은 서버만 읽고, 수집기는 전체 입력이 유효할 때만 저장한다.
export async function getLolRankingPublication(): Promise<unknown | null> {
  return rpc<unknown | null>("get_lol_ranking_publication", {});
}

export async function getLolMasterPublication(): Promise<unknown | null> {
  return rpc<unknown | null>("get_lol_master_publication", {});
}

export function createLolRankingStore(): RankingStore {
  return {
    getAccountStates: async (seasonKey, accountHmacs) => {
      const rows = (await rpc<Array<Record<string, unknown>> | null>("get_lol_season_account_states",
        { p_season_key: seasonKey, p_account_hmacs: accountHmacs })) ?? [];
      return rows.map(row => ({
        accountHmac: String(row.accountHmac),
        riotId: String(row.riotId),
        riotIdHmac: String(row.riotIdHmac),
        resolvedAt: typeof row.resolvedAt === "string" ? row.resolvedAt : null,
        cursor: row.cursorMs === null || row.cursorMs === undefined ? null : { ms: Number(row.cursorMs), ids: Array.isArray(row.cursorIds) ? row.cursorIds.map(String) : [] },
        checkedAt: typeof row.checkedAt === "string" ? row.checkedAt : null,
      }));
    },
    upsertAccount: async input => {
      await rpc("upsert_lol_season_account", {
        p_season_key: input.seasonKey, p_account_hmac: input.accountHmac, p_riot_id_hmac: input.riotIdHmac, p_riot_id: input.riotId,
        p_tier: input.tier, p_league_points: input.leaguePoints, p_resolved_at: input.resolvedAt, p_listed_at: input.listedAt,
        p_season_end: input.seasonEnd,
      });
    },
    commitProgress: async input => {
      try {
        await rpc("commit_lol_season_progress", {
          p_season_key: input.seasonKey, p_account_hmac: input.accountHmac, p_expected_cursor_ms: input.expectedCursorMs,
          p_cursor_ms: input.cursor ? input.cursor.ms : null, p_cursor_ids: input.cursor ? input.cursor.ids : null,
          p_champions: input.deltas.map(delta => ({ champion_id: delta.championId, games: delta.games, wins: delta.wins })),
          p_checked_at: input.checkedAt,
        });
        return "ok";
      } catch (error) {
        if (error instanceof LolSeasonCursorStaleError) return "stale";
        throw error;
      }
    },
    listChampionCounts: async (seasonKey, accountHmacs) => {
      const rows = (await rpc<Array<Record<string, unknown>> | null>("list_lol_season_champion_counts",
        { p_season_key: seasonKey, p_account_hmacs: accountHmacs })) ?? [];
      return rows.map(row => ({ accountHmac: String(row.accountHmac), championId: Number(row.championId), games: Number(row.games), wins: Number(row.wins) }));
    },
    excludedKeys: () => listLolRankingExclusionKeys(),
    saveRankingPublication: async input => {
      await rpc("save_lol_ranking_publication", { p_rows: input.rows, p_player_count: input.playerCount, p_observed_at: input.observedAt });
    },
    saveMasterPublication: async input => {
      await rpc("save_lol_master_publication", {
        p_season_key: input.seasonKey, p_coverage: input.coverage, p_player_count: input.playerCount,
        p_champions: input.champions.map(champion => ({ champion_id: champion.champion_id, eligible_count: champion.eligible_count, rows: champion.rows })),
        p_observed_at: input.observedAt,
      });
    },
    purgeExpiredSeasons: async nowIso => rpc<number>("purge_lol_expired_season_accounts", { p_now: nowIso }),
  };
}

export async function listLolRankingExclusionKeys(): Promise<string[]> {
  return (await rpc<string[] | null>("list_lol_ranking_exclusion_keys", {})) ?? [];
}

export async function addLolRankingExclusion(riotIdHmac: string, riotId: string): Promise<number> {
  return rpc<number>("add_lol_ranking_exclusion", { p_hmac: riotIdHmac, p_riot_id: riotId });
}
