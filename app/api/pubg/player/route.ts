import { readPlayerBanStatus, recordPlayerBanObservation } from "@/lib/pubg/banWatch.server";
import { isBanAccountId, normalizeBanStatus } from "@/lib/pubg/banStatus";
import { recordDiscoveredMatches } from "@/lib/pubg/matchDiscovery.server";
import { normalizeDiscoveredMatchIds } from "@/lib/pubg/matchDiscovery";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";
import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import { reportPubgApiError } from "@/lib/pubg/apiHelper";
import { normalizeRecentMatchIds } from "@/lib/pubg/recentMatches";
import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";
import {
  normalizeSurvivalMasteryPayload,
  shouldRefreshSurvivalMastery,
} from "@/lib/pubg/survivalMastery";
import type { PlayerStatsResponse, StatsMode } from "@/types/stats-page";
import { createPlayerApiClient, PlayerApiError } from "@/lib/pubg/playerApiClient";
import {
  isRecord, isPlayerPayload, isSeasonList, isSeasonsPayload,
  isNormalPayload, isRankedPayload, selectPlayerModeBuckets, validatedCachedBuckets,
  type PlayerModeBuckets, type PubgNormalPayload, type PubgSeason,
} from "@/lib/pubg/playerPayload";

import {
  buildPlayerRefreshLockKey,
  claimForceRefresh,
} from "@/lib/pubg/responseCache";

export const maxDuration = 30;

// 앱이 refresh=auto를 명시했을 때만 이 나이보다 오래된 DB 전적을 갱신한다.
const AUTO_REFRESH_MAX_AGE_MS = 15 * 60 * 1000;
// `claimForceRefresh` has a 60-second shared lock. Successful lock holders
// report it so the client does not immediately make a manual request that 429s.
const PLAYER_REFRESH_LOCK_RETRY_SECONDS = 60;

/**
 * pubg_player_cache 쓰기 전용 service_role 클라이언트입니다.
 * 이 라우트의 기본 클라이언트는 anon 키를 사용하므로 서버 전용 테이블에 쓸 수 없습니다.
 */
function createServiceRoleClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function normalizeSeasonParam(value: string | null): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;
  return trimmed;
}

function normalizeMatchModes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, string> = {};
  for (const [rawId, mode] of Object.entries(value)) {
    if (typeof mode !== "string") continue;
    const matchId = normalizeMatchId(rawId);
    if (matchId && !normalized[matchId]) normalized[matchId] = mode;
  }
  return normalized;
}

function isAutoRefreshDue(updatedAt: unknown, nowMs = Date.now()): boolean {
  if (typeof updatedAt !== "string") return true;
  const updatedMs = Date.parse(updatedAt);
  return !Number.isFinite(updatedMs) || nowMs - updatedMs >= AUTO_REFRESH_MAX_AGE_MS;
}

/** A partial first write may have an `updated_at` of now. It is not fresh
 * until both current-season mode reads were durably saved as ready. */
function hasCompleteCachedStats(cacheData: any, reqSeason: string | null): boolean {
  const availableSeasons = Array.isArray(cacheData.seasons_list) ? cacheData.seasons_list : [];
  const currentSeason = availableSeasons.find(
    (season: any) => season?.attributes?.isCurrentSeason || season?.isCurrentSeason,
  ) || availableSeasons[0];
  const targetSeasonId = reqSeason
    || (isValidSeasonId(cacheData.last_season_id) ? cacheData.last_season_id : currentSeason?.id);
  const availability = targetSeasonId ? cacheData.season_stats_data?.[targetSeasonId]?.statsAvailability : null;
  return availability?.ranked?.status === "ready" && availability?.normal?.status === "ready";
}

function cachedSyncStatus(cacheData: any, reqSeason: string | null): "cached" | "partial" {
  return hasCompleteCachedStats(cacheData, reqSeason) ? "cached" : "partial";
}

// Cache reads never create observations or borrow the profile update timestamp.
async function withCachedBanObservation(value: unknown, platform: "steam" | "kakao"): Promise<unknown> {
  if (!isRecord(value) || !isBanAccountId(value.accountId)) return value;
  try {
    const observation = await readPlayerBanStatus(platform, value.accountId);
    if (observation?.checkedAt) return {
      ...value,
      banStatus: observation.status,
      banType: observation.rawType ?? "Unknown",
      banCheckedAt: observation.checkedAt,
    };
  } catch {
    // Rolling migration or a store outage must not block existing stats.
  }
  return value;
}

function isValidSeasonId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value !== "null" && value !== "undefined";
}

async function buildCachedPlayerResponse(supabase: any, cacheData: any, reqSeason: string | null) {
  const availableSeasons = cacheData.seasons_list || [];
  const currentSeason = availableSeasons.find(
    (season: any) => season.attributes?.isCurrentSeason || season.isCurrentSeason,
  ) || availableSeasons[0];
  const validLastSeasonId = isValidSeasonId(cacheData.last_season_id) ? cacheData.last_season_id : null;
  const targetSeasonId = reqSeason
    ? reqSeason
    : (validLastSeasonId || (currentSeason ? currentSeason.id : null));

  let selectedStatsSeasonId = targetSeasonId;
  let statsForSeason = cacheData.season_stats_data ? cacheData.season_stats_data[targetSeasonId] : null;
  if (!statsForSeason && !reqSeason && cacheData.season_stats_data) {
    const fallbackSeasonId = validLastSeasonId || Object.keys(cacheData.season_stats_data).find(isValidSeasonId);
    if (fallbackSeasonId) {
      statsForSeason = cacheData.season_stats_data[fallbackSeasonId];
      selectedStatsSeasonId = fallbackSeasonId;
    }
  }

  const collectionMatchIds = normalizeDiscoveredMatchIds(cacheData.recent_match_ids || []);
  const recentMatches = normalizeRecentMatchIds(collectionMatchIds);
  const { data: modeData } = await supabase
    .from("match_master_telemetry")
    .select("match_id, game_mode")
    .in("match_id", recentMatches);

  return {
    accountId: cacheData.id,
    nickname: cacheData.nickname,
    platform: cacheData.platform,
    seasonId: selectedStatsSeasonId,
    seasons: availableSeasons.map((season: any) => ({
      id: season.id,
      name: season.name || `Season ${season.id.split("-").pop()}`,
    })),
    stats: { ranked: statsForSeason?.ranked ?? null, normal: statsForSeason?.normal ?? null },
    statsAvailability: statsForSeason?.statsAvailability,
    seasonStatsCached: Boolean(statsForSeason),
    recentMatches,
    collectionMatchIds,
    matchModes: normalizeMatchModes(Object.fromEntries(
      (modeData || []).map((item: any) => [item.match_id, item.game_mode]),
    )),
    clan: cacheData.clan_data,
    survivalMastery: normalizeSurvivalMasteryPayload({
      data: { attributes: cacheData.survival_mastery_data },
    }),
    weaponMastery: cacheData.weapon_mastery_data || [],
    banType: cacheData.ban_type || "None",
    updatedAt: cacheData.updated_at,
    syncStatus: cachedSyncStatus(cacheData, reqSeason),
    historyDiscoveryStatus: "unknown",
    ...(Number.isFinite(Date.parse(cacheData.last_seen_at)) && Date.parse(cacheData.last_seen_at) + 60_000 > Date.now()
      ? { retryAfterSeconds: Math.ceil((Date.parse(cacheData.last_seen_at) + 60_000 - Date.now()) / 1000) } : {}),
  };
}

async function getSimilarPlayerSuggestions(supabase: any, nickname: string, platform: string) {
  try {
    const { data } = await supabase.rpc("suggest_similar_players", {
      search_name: nickname,
      search_platform: platform,
      limit_val: 3
    });
    return data || [];
  } catch {
    return [];
  }
}

async function playerNotFoundResponse(supabase: any, nickname: string, platform: string) {
  const suggestions = await getSimilarPlayerSuggestions(supabase, nickname, platform);

  return NextResponse.json(
    {
      error: "닉네임을 찾을 수 없습니다. 대소문자와 플랫폼을 확인해 올바르게 검색해 주세요.",
      code: "PLAYER_NOT_FOUND",
      suggestions
    },
    {
      status: 404,
      headers: {
        "Cache-Control": "no-store, max-age=0, must-revalidate"
      }
    }
  );
}

async function guardPlayerPrivate(platform: string, nickname: string, accountId?: string) {
  const response = await blockPrivatePlayer(platform, nickname, accountId);
  if (!response || response.status !== 403) return response;
  return NextResponse.json(
    { error: `${nickname}의 프로필은 비공개입니다.`, code: "PLAYER_PRIVATE", nickname, platform },
    { status: 403, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nickname = searchParams.get("nickname")?.trim();
  const platform = (searchParams.get("platform") || "steam").trim().toLowerCase();
  const reqSeason = normalizeSeasonParam(searchParams.get("season"));
  const refreshMode = searchParams.get("refresh");
  const forceRefresh = refreshMode === "true";
  const autoRefresh = refreshMode === "auto";

  if (!nickname)
    return NextResponse.json(
      { error: "닉네임을 입력해주세요." },
      { status: 400 }
    );

  if (platform !== "steam" && platform !== "kakao") {
    return NextResponse.json({ error: "지원하지 않는 플랫폼입니다." }, { status: 400 });
  }

  // [비공개 유저 검사] 비공개 등록된 플레이어는 PUBG 호출을 차단하고
  // 레지스트리 장애는 공통 503 응답으로 fail-closed 처리한다.
  const initialPrivateResponse = await guardPlayerPrivate(platform, nickname);
  if (initialPrivateResponse) return initialPrivateResponse;

  // Reads below use the saved player row so default and explicit-season
  // requests cannot reuse a pre-refresh response from another instance.
  if (forceRefresh) {
    const claimed = await claimForceRefresh(buildPlayerRefreshLockKey(platform, nickname));
    if (!claimed) {
      return NextResponse.json(
        { error: "강제 갱신은 같은 전적에 대해 1분에 한 번만 요청할 수 있습니다." },
        { status: 429, headers: { "Retry-After": String(PLAYER_REFRESH_LOCK_RETRY_SECONDS), "Cache-Control": "no-store" } },
      );
    }
  }

  // 환경 변수에서 불필요한 공백 및 텍스트(예: "Rate Limit 10 RPM...")를 제거하고 진짜 토큰만 추출
  const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/vnd.api+json",
  };

  const supabase = await createClient();

  // 1. 캐시에서 정확한 닉네임 조회 시도 (소문자 기반)
  let targetNickname = nickname;
  const { data: cacheData } = await supabase
    .from('pubg_player_cache')
    .select('*')
    .eq('lower_nickname', nickname.toLowerCase())
    .eq('platform', platform)
    .maybeSingle();
  // A legacy privacy row may contain only the old nickname. Once the cache
  // resolves the immutable account ID, apply the same privacy decision to
  // renamed aliases before serving cached data or calling PUBG.
  if (cacheData?.id) {
    const privateResponse = await guardPlayerPrivate(platform, targetNickname, cacheData.id);
    if (privateResponse) return privateResponse;
  }
  if (cacheData) {
    targetNickname = cacheData.nickname;
    const cachedStatsComplete = hasCompleteCachedStats(cacheData, reqSeason);
    const shouldRefreshCachedPlayer = forceRefresh
      || (autoRefresh && (!cachedStatsComplete || isAutoRefreshDue(cacheData.updated_at)));
    if (!shouldRefreshCachedPlayer) {
      const responseBody = await buildCachedPlayerResponse(supabase, cacheData, reqSeason);
      return NextResponse.json(await withCachedBanObservation(responseBody, platform), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (autoRefresh) {
      const claimed = await claimForceRefresh(buildPlayerRefreshLockKey(platform, nickname));
      if (!claimed) {
        const responseBody = await buildCachedPlayerResponse(supabase, cacheData, reqSeason);
        return NextResponse.json(await withCachedBanObservation({
          ...responseBody,
          retryAfterSeconds: PLAYER_REFRESH_LOCK_RETRY_SECONDS,
        }, platform), {
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
  }

  const requestId = crypto.randomUUID();
  const api = createPlayerApiClient({ headers, signal: request.signal });
  const failures: unknown[] = [];
  const recordFailure = (error: unknown) => { failures.push(error); };
  const safeLogFailure = async (error: unknown, terminal = false) => {
    if (request.signal.aborted) return;
    const failure = error instanceof PlayerApiError ? error : null;
    try {
      await reportPubgApiError({
        route: "/api/pubg/player",
        status: failure?.upstreamStatus === 429 ? 429 : 503,
        message: failure?.message || "플레이어 전적 조회를 완료하지 못했습니다.",
        detail: JSON.stringify({ contentType: failure?.contentType ?? null, responseBytes: failure?.responseBytes ?? null }),
        context: {
          failureStage: failure?.stage ?? "player_route",
          errorCode: failure?.errorCode ?? "PLAYER_LOOKUP_FAILED",
          upstreamStatus: failure?.upstreamStatus ?? null,
          durationMs: failure?.durationMs ?? null,
          platform, source: forceRefresh ? "player_refresh" : autoRefresh ? "player_auto_refresh" : "player_search", requestId,
        },
        // Partial recovery is diagnostic only; keep alerts for complete failures.
        notify: terminal,
      });
    } catch {
      console.warn("[pubg-player] 전적 오류 진단 기록 실패", { requestId });
    }
  };

  try {
    const playerUrl = (name: string) => {
      const url = new URL(`https://api.pubg.com/shards/${platform}/players`);
      url.searchParams.set("filter[playerNames]", name);
      return url.toString();
    };
    let playerData;
    try {
      playerData = await api.read(playerUrl(targetNickname), { stage: "player", validate: isPlayerPayload });
    } catch (error) {
      if (error instanceof PlayerApiError && error.upstreamStatus === 404 && targetNickname !== nickname) {
        playerData = await api.read(playerUrl(nickname), { stage: "player", validate: isPlayerPayload });
      } else throw error;
    }
    const playerRecord = playerData.data.find((player) => player.attributes.name.toLowerCase() === nickname.toLowerCase());
    if (!playerRecord) {
      if (playerData.data.length === 0) return playerNotFoundResponse(supabase, nickname, platform);
      // A valid JSON response for a different player must never seed this cache.
      throw new Error("player identity mismatch");
    }
    const accountId = playerRecord.id;
    const privateResponse = await guardPlayerPrivate(platform, playerRecord.attributes.name, accountId);
    if (privateResponse) return privateResponse;
    const apiRecentMatches = playerRecord.relationships.matches.data.map((match) => match.id);
    let historyDiscoveryStatus: "queued" | "failed" | "unknown" = apiRecentMatches.length > 0
      ? "queued"
      : "unknown";
    if (apiRecentMatches.length > 0) {
      try {
        await recordDiscoveredMatches({ platform, accountId, nickname: playerRecord.attributes.name, matchIds: apiRecentMatches });
      } catch {
        historyDiscoveryStatus = "failed";
        console.warn('[pubg-player] match discovery persistence failed', { requestId });
      }
    }
    const actualNickname = playerRecord.attributes.name;
    const sameCachedPlayer = cacheData?.id === accountId
      && cacheData?.platform === platform
      && typeof cacheData?.nickname === "string"
      && cacheData.nickname.toLowerCase() === actualNickname.toLowerCase();
    const previous = sameCachedPlayer ? cacheData : null;
    const collectionMatchIds = normalizeDiscoveredMatchIds(apiRecentMatches);
    const recentMatches = normalizeRecentMatchIds(collectionMatchIds);
    const banType = playerRecord.attributes.banType ?? "Unknown";
    const banCheckedAt = new Date().toISOString();
    const banStatus = normalizeBanStatus(banType);
    try {
      await recordPlayerBanObservation({ platform, accountId, banType, checkedAt: banCheckedAt });
    } catch {
      console.warn('[pubg-player] ban observation persistence failed', { requestId });
    }
    const cachedSeasons: PubgSeason[] = isSeasonList(previous?.seasons_list) ? previous.seasons_list : [];
    let availableSeasons = cachedSeasons;
    let seasonsReady = false;
    try {
      const seasonData = await api.read(`https://api.pubg.com/shards/${platform}/seasons`, {
        stage: "seasons", validate: isSeasonsPayload,
      });
      availableSeasons = seasonData.data
        .filter((season) => season.id.includes("pc-") || season.id.includes("console-"))
        .sort((left, right) => right.id.localeCompare(left.id));
      seasonsReady = availableSeasons.length > 0;
      if (!seasonsReady) recordFailure(new Error("No supported season"));
    } catch (error) {
      recordFailure(error);
    }
    if (request.signal.aborted) throw request.signal.reason;
    const currentSeason = availableSeasons.find((season) => season.attributes?.isCurrentSeason || season.isCurrentSeason)
      || availableSeasons[0];
    let targetSeasonId = reqSeason || currentSeason?.id
      || (isValidSeasonId(previous?.last_season_id) ? previous.last_season_id : "");
    const seasonUrl = (season: string) => `https://api.pubg.com/shards/${platform}/players/${encodeURIComponent(accountId)}/seasons/${encodeURIComponent(season)}`;
    type NormalOutcome = { data: PubgNormalPayload; error?: never } | { data?: never; error: unknown };
    const readNormal = async (season: string): Promise<NormalOutcome> => {
      try {
        return { data: await api.read(seasonUrl(season), { stage: "normal", validate: isNormalPayload }) };
      } catch (error) { return { error }; }
    };
    let normalOutcome: NormalOutcome | undefined;
    if (!reqSeason && targetSeasonId) {
      normalOutcome = await readNormal(targetSeasonId);
      // Automatic season discovery only follows successful, genuinely empty
      // records. A failed lookup must not switch the user's comparison season.
      if (normalOutcome.data && !Object.values(normalOutcome.data.data.attributes.gameModeStats).some((mode) => mode && mode.roundsPlayed > 0)) {
        for (const season of availableSeasons.slice(1, 4)) {
          const candidate = await readNormal(season.id);
          if (!candidate.data) { recordFailure(candidate.error); break; }
          if (Object.values(candidate.data.data.attributes.gameModeStats).some((mode) => mode && mode.roundsPlayed > 0)) {
            targetSeasonId = season.id;
            normalOutcome = candidate;
            break;
          }
        }
      }
    }

    const nowIso = new Date().toISOString();
    const statsAvailability: NonNullable<PlayerStatsResponse["statsAvailability"]> = {};
    const previousSeason = previous?.season_stats_data?.[targetSeasonId];
    const fallbackMode = (mode: StatsMode): PlayerModeBuckets | null => {
      const buckets = validatedCachedBuckets(previousSeason?.[mode]);
      statsAvailability[mode] = buckets
        ? { status: "stale", ...((previousSeason?.statsAvailability?.[mode]?.updatedAt || previous?.updated_at)
          ? { updatedAt: previousSeason?.statsAvailability?.[mode]?.updatedAt || previous.updated_at } : {}) }
        : { status: "unavailable" };
      return buckets;
    };
    const modeResult = async (mode: StatsMode): Promise<PlayerModeBuckets | null> => {
      if (!targetSeasonId) return fallbackMode(mode);
      try {
        let buckets: PlayerModeBuckets;
        if (mode === "normal") {
          const result = normalOutcome ?? await readNormal(targetSeasonId);
          if (!result.data) throw result.error;
          buckets = selectPlayerModeBuckets(result.data.data.attributes.gameModeStats);
        } else {
          const result = await api.read(`${seasonUrl(targetSeasonId)}/ranked`, { stage: "ranked", validate: isRankedPayload });
          buckets = selectPlayerModeBuckets(result.data.attributes.rankedGameModeStats);
        }
        statsAvailability[mode] = { status: "ready", updatedAt: nowIso };
        return buckets;
      } catch (error) {
        recordFailure(error);
        return fallbackMode(mode);
      }
    };
    const previousMastery = normalizeSurvivalMasteryPayload({ data: { attributes: previous?.survival_mastery_data } });
    const shouldLoadMastery = forceRefresh || shouldRefreshSurvivalMastery(previous?.survival_mastery_updated_at);
    const masteryPromise = shouldLoadMastery
      ? api.read(`https://api.pubg.com/shards/${platform}/players/${encodeURIComponent(accountId)}/survival_mastery`, {
          stage: "survival_mastery", validate: isRecord,
        }).then((value) => ({ data: normalizeSurvivalMasteryPayload(value), updated: true }))
          .catch(() => ({ data: previousMastery, updated: false }))
      : Promise.resolve({ data: previousMastery, updated: false });
    const clanId = playerRecord.attributes.clanId;
    const clanCacheValid = previous?.clan_updated_at && Date.now() - Date.parse(previous.clan_updated_at) < 86_400_000;
    const clanPromise = !clanId || clanCacheValid
      ? Promise.resolve({ data: clanId ? previous?.clan_data ?? null : null, updated: !clanId })
      : api.read(`https://api.pubg.com/shards/${platform}/clans/${encodeURIComponent(clanId)}`, {
          stage: "clan", timeoutMs: 6_000, validate: (value): value is Record<string, unknown> => (
            isRecord(value) && isRecord(value.data) && isRecord(value.data.attributes)
          ),
        }).then((value) => {
          const attr = (value.data as { attributes: Record<string, unknown> }).attributes;
          return { data: { id: clanId, name: attr.clanName ?? "", tag: attr.clanTag ?? "", level: attr.clanLevel ?? 0, memberCount: attr.clanMemberCount ?? 0 }, updated: true };
        }).catch(() => ({ data: previous?.clan_data ?? null, updated: false }));
    const [rankedStats, normalStats, mastery, clanResult] = await Promise.all([
      modeResult("ranked"), modeResult("normal"), masteryPromise, clanPromise,
    ]);
    if (request.signal.aborted) throw request.signal.reason;
    const complete = seasonsReady && failures.length === 0
      && statsAvailability.ranked?.status === "ready" && statsAvailability.normal?.status === "ready";
    const retryAfterSeconds = Math.max(60, ...failures.map((error) => error instanceof PlayerApiError ? error.retryAfterSeconds ?? 0 : 0));
    const { data: modeData } = await supabase
      .from("match_master_telemetry")
      .select("match_id, game_mode")
      .in("match_id", recentMatches);
    if (request.signal.aborted) throw request.signal.reason;
    const matchModes = normalizeMatchModes(Object.fromEntries(
      (modeData || []).map((item: any) => [item.match_id, item.game_mode]),
    ));
    const baseResponse = {
      accountId, nickname: actualNickname, platform, seasonId: targetSeasonId,
      seasons: availableSeasons.map((season) => ({ id: season.id, name: season.name || `Season ${season.id.split("-").pop()}` })),
      stats: { ranked: rankedStats, normal: normalStats }, statsAvailability,
      recentMatches, collectionMatchIds, matchModes, clan: clanResult.data,
      survivalMastery: mastery.data || previousMastery,
      weaponMastery: previous?.weapon_mastery_data || [], banType, banStatus, banCheckedAt,
      ...(previous?.updated_at ? { updatedAt: previous.updated_at } : {}),
      historyDiscoveryStatus,
    };
    const playerRefreshRetryAfterSeconds = forceRefresh || autoRefresh
      ? PLAYER_REFRESH_LOCK_RETRY_SECONDS
      : null;
    // A partial response can carry a longer upstream Retry-After. Keep that
    // value while still covering the shared player-refresh lock.
    const responseRetryAfterSeconds = !complete
      ? Math.max(playerRefreshRetryAfterSeconds ?? 0, retryAfterSeconds)
      : playerRefreshRetryAfterSeconds;
    let responseBody: Record<string, unknown> = {
      ...baseResponse,
      syncStatus: complete ? "saved" : "partial",
      ...(responseRetryAfterSeconds !== null
        ? { retryAfterSeconds: responseRetryAfterSeconds }
        : {}),
    };

    if (!request.signal.aborted) {
      const updatedSeasonStats = {
        ...(previous?.season_stats_data || {}),
        ...(targetSeasonId && (previousSeason || statsAvailability.ranked?.status === 'ready' || statsAvailability.normal?.status === 'ready') ? {
          [targetSeasonId]: {
            ...(previousSeason || {}),
            ...(statsAvailability.ranked?.status === 'ready' ? { ranked: rankedStats } : {}),
            ...(statsAvailability.normal?.status === 'ready' ? { normal: normalStats } : {}),
            statsAvailability,
          },
        } : {}),
      };
      const cacheUpdateData: any = {
        id: accountId, platform, nickname: actualNickname, lower_nickname: actualNickname.toLowerCase(),
        search_count: (previous?.search_count ?? 0) + 1,
        // A first partial snapshot must not inherit the database default `now()`:
        // it is not a completed sync and remains eligible for refresh=auto.
        ...(complete ? { updated_at: nowIso } : !previous ? { updated_at: null } : {}),
        last_seen_at: nowIso,
        ban_type: banType, season_stats_data: updatedSeasonStats, last_season_id: targetSeasonId,
        recent_match_ids: collectionMatchIds, seasons_list: availableSeasons,
      };
      if (mastery.updated && mastery.data) {
        cacheUpdateData.survival_mastery_updated_at = nowIso;
        cacheUpdateData.survival_mastery_data = mastery.data;
      }
      if (clanResult.updated) {
        cacheUpdateData.clan_data = clanResult.data;
        cacheUpdateData.clan_updated_at = nowIso;
      }
      try {
        const table = createServiceRoleClient().from('pubg_player_cache');
        let cacheWriteError;
        if (complete) {
          ({ error: cacheWriteError } = await table.upsert(cacheUpdateData, { onConflict: 'id' }));
        } else {
          // Preserve failed modes, and never overwrite a concurrent refresh with
          // the JSON snapshot read at the beginning of this partial request.
          let write;
          if (previous) {
            write = table.update(cacheUpdateData).eq('id', accountId).eq('platform', platform);
            write = previous.updated_at ? write.eq('updated_at', previous.updated_at) : write.is('updated_at', null);
            write = previous.last_seen_at ? write.eq('last_seen_at', previous.last_seen_at) : write.is('last_seen_at', null);
          } else {
            write = table.upsert(cacheUpdateData, { onConflict: 'id', ignoreDuplicates: true });
          }
          const saved = await write.select('id');
          cacheWriteError = saved.error;
          if (!cacheWriteError && !saved.data?.length) throw new Error('player-cache-write-conflict');
        }
        if (cacheWriteError) throw cacheWriteError;
        if (complete) {
          responseBody = {
            ...baseResponse,
            updatedAt: nowIso,
            syncStatus: "saved",
            ...(playerRefreshRetryAfterSeconds !== null
              ? { retryAfterSeconds: playerRefreshRetryAfterSeconds }
              : {}),
          };
        }
      } catch {
        // DB write failure cannot advance the reported sync time or seed a new cache.
        console.error("[pubg-player] pubg_player_cache 갱신 실패", { requestId });
        responseBody = {
          ...baseResponse,
          syncStatus: "save_failed",
          ...(responseRetryAfterSeconds !== null
            ? { retryAfterSeconds: responseRetryAfterSeconds }
            : {}),
        };
      }
    }
    await Promise.all(failures.map((error) => safeLogFailure(error)));
    return NextResponse.json(responseBody, {
      headers: { "Cache-Control": "no-store", ...(!complete ? { "Retry-After": String(retryAfterSeconds) } : {}) },
    });
  } catch (error) {
    if (error instanceof PlayerApiError && error.stage === "player" && error.upstreamStatus === 404) {
      return playerNotFoundResponse(supabase, nickname, platform);
    }
    await safeLogFailure(error, true);
    const failure = error instanceof PlayerApiError ? error : null;
    const rateLimited = failure?.upstreamStatus === 429;
    const retryAfter = rateLimited ? failure.retryAfterSeconds ?? 60 : 30;
    return NextResponse.json({
      error: rateLimited
        ? "PUBG API 호출 한도가 일시적으로 초과되었습니다. 잠시 후 다시 시도해 주세요."
        : "전적 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
      code: request.signal.aborted ? "PLAYER_REQUEST_ABORTED" : rateLimited ? "PLAYER_RATE_LIMITED" : "PLAYER_UPSTREAM_UNAVAILABLE",
      retryable: !request.signal.aborted, requestId,
    }, { status: rateLimited ? 429 : 503, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) } });
  } finally {
    api.dispose();
  }
}
