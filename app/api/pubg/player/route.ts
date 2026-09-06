import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";
import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import { reportPubgApiError } from "@/lib/pubg/apiHelper";
import { mergeRecentMatchIds } from "@/lib/pubg/recentMatches";
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
  buildPlayerCacheKey,
  buildPlayerRefreshLockKey,
  claimForceRefresh,
  readPubgCache,
  writePubgCache,
} from "@/lib/pubg/responseCache";

export const maxDuration = 30;

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

// ─────────────────────────────────────────────────────────────
// [CACHE] PUBG API 호출 절약을 위한 2단 캐시 (인메모리 L1 + DB L2, 3분 TTL)
// 인메모리 단독 캐시는 Vercel 서버리스에서 인스턴스별로 분리되어 히트율이 낮았고,
// 강제 갱신 쿨다운도 인스턴스마다 따로 계산되어 우회가 가능했다.
// 상세 구현은 lib/pubg/responseCache.ts 참고.
// ─────────────────────────────────────────────────────────────

function normalizeSeasonParam(value: string | null): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;
  return trimmed;
}

function isValidSeasonId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value !== "null" && value !== "undefined";
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nickname = searchParams.get("nickname")?.trim();
  const platform = (searchParams.get("platform") || "steam").trim().toLowerCase();
  const reqSeason = normalizeSeasonParam(searchParams.get("season"));
  // _t 타임스탬프 파라미터는 강제 갱신 조건에서 제외하여 단순 검색/로딩 시 캐시를 사용하도록 개편
  const forceRefresh = searchParams.get("refresh") === "true";

  if (!nickname)
    return NextResponse.json(
      { error: "닉네임을 입력해주세요." },
      { status: 400 }
    );

  if (platform !== "steam" && platform !== "kakao") {
    return NextResponse.json({ error: "지원하지 않는 플랫폼입니다." }, { status: 400 });
  }

  // [비공개 유저 검사] 비공개 등록된 플레이어는 PUBG 호출을 차단하고 403 반환
  if (await isPlayerPrivate(platform, nickname)) {
    return NextResponse.json(
      {
        error: `${nickname}의 프로필은 비공개입니다.`,
        code: "PLAYER_PRIVATE",
        nickname,
        platform,
      },
      {
        status: 403,
        headers: {
          "Cache-Control": "private, max-age=300",
        },
      }
    );
  }

  // 1. 분산 캐시 조회 (인메모리 L1 → DB L2, 3분 TTL)
  const cacheKey = buildPlayerCacheKey(platform, nickname, reqSeason);
  if (forceRefresh) {
    const claimed = await claimForceRefresh(buildPlayerRefreshLockKey(platform, nickname));
    if (!claimed) {
      return NextResponse.json(
        { error: "강제 갱신은 같은 전적에 대해 1분에 한 번만 요청할 수 있습니다." },
        { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
      );
    }
  } else {
    const cachedPayload = await readPubgCache(cacheKey);
    if (cachedPayload) {
      return NextResponse.json(cachedPayload);
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
  const cachedSurvivalMastery = normalizeSurvivalMasteryPayload({
    data: { attributes: cacheData?.survival_mastery_data },
  });

  if (cacheData) {
    targetNickname = cacheData.nickname;

    // [DB 캐시 우선 조회] 강제 갱신이 아니라면 외부 PUBG API 호출을 원천 차단하고 DB 캐시 즉시 반환
    if (!forceRefresh) {
      const availableSeasons = cacheData.seasons_list || [];
      const currentSeason = availableSeasons.find(
        (s: any) => s.attributes?.isCurrentSeason || s.isCurrentSeason
      ) || availableSeasons[0];

      // 요청 시즌이 없거나 빈 문자열("")이면 마지막 저장 시즌 적용
      const validLastSeasonId = isValidSeasonId(cacheData.last_season_id) ? cacheData.last_season_id : null;
      const targetSeasonId = reqSeason
        ? reqSeason
        : (validLastSeasonId || (currentSeason ? currentSeason.id : null));

      let selectedStatsSeasonId = targetSeasonId;
      let statsForSeason = cacheData.season_stats_data ? cacheData.season_stats_data[targetSeasonId] : null;

      // 자동 시즌 선택일 때만 기록 있는 시즌으로 fallback합니다.
      // 사용자가 드롭다운으로 명시 선택한 시즌은 선택값을 유지하고 빈 기록을 보여줍니다.
      if (!statsForSeason && !reqSeason && cacheData.season_stats_data) {
        const fallbackSeasonId = validLastSeasonId || Object.keys(cacheData.season_stats_data).find(isValidSeasonId);
        if (fallbackSeasonId) {
          statsForSeason = cacheData.season_stats_data[fallbackSeasonId];
          selectedStatsSeasonId = fallbackSeasonId;
        }
      }

      // Existing players are always served from the database on a non-force
      // search. An absent explicitly selected season intentionally remains an
      // empty bucket; stale optional mastery never escalates this request to
      // PUBG either.
      // 최근 매치들의 모드 정보를 match_master_telemetry에서 일괄 가져옴
      const recentMatches = cacheData.recent_match_ids || [];
      const { data: modeData } = await supabase
        .from("match_master_telemetry")
        .select("match_id, game_mode")
        .in("match_id", recentMatches);

      const matchModes = (modeData || []).reduce((acc: Record<string, string>, item: any) => {
        acc[item.match_id] = item.game_mode;
        return acc;
      }, {});

      const responseBody = {
        nickname: targetNickname,
        platform: cacheData.platform,
        seasonId: selectedStatsSeasonId,
        seasons: availableSeasons.map((s: any) => ({
          id: s.id,
          name: s.name || `Season ${s.id.split("-").pop()}`,
        })),
        stats: statsForSeason || { ranked: null, normal: null },
        recentMatches,
        matchModes,
        clan: cacheData.clan_data,
        survivalMastery: cachedSurvivalMastery,
        weaponMastery: cacheData.weapon_mastery_data || [],
        banType: cacheData.ban_type || "None",
        updatedAt: cacheData.updated_at
      };

      // 분산 캐시 업데이트 (L1 + L2)
      await writePubgCache(cacheKey, responseBody);

      return NextResponse.json(responseBody);
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
          platform, source: forceRefresh ? "player_refresh" : "player_search", requestId,
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
    const actualNickname = playerRecord.attributes.name;
    const sameCachedPlayer = cacheData?.id === accountId
      && cacheData?.platform === platform
      && typeof cacheData?.nickname === "string"
      && cacheData.nickname.toLowerCase() === actualNickname.toLowerCase();
    const previous = sameCachedPlayer ? cacheData : null;
    const apiRecentMatches = playerRecord.relationships.matches.data.map((match) => match.id);
    const recentMatches = mergeRecentMatchIds(apiRecentMatches, previous?.recent_match_ids);
    const banType = playerRecord.attributes.banType ?? "None";
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
        ? { status: "stale", ...(previous?.updated_at ? { updatedAt: previous.updated_at } : {}) }
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
    const matchModes = (modeData || []).reduce((acc: Record<string, string>, item: any) => {
      acc[item.match_id] = item.game_mode;
      return acc;
    }, {});
    const responseBody = {
      nickname: actualNickname, platform, seasonId: targetSeasonId,
      seasons: availableSeasons.map((season) => ({ id: season.id, name: season.name || `Season ${season.id.split("-").pop()}` })),
      stats: { ranked: rankedStats, normal: normalStats }, statsAvailability,
      recentMatches, matchModes, clan: clanResult.data,
      survivalMastery: mastery.data || previousMastery,
      weaponMastery: previous?.weapon_mastery_data || [], banType,
      ...(complete ? { updatedAt: nowIso } : previous?.updated_at ? { updatedAt: previous.updated_at } : {}),
      ...(!complete ? { retryAfterSeconds } : {}),
    };

    // A partial refresh must never replace a complete JSON season cache, even
    // when another request completes successfully while this one is in flight.
    if (complete && !api.signal.aborted) {
      const updatedSeasonStats = {
        ...(previous?.season_stats_data || {}),
        [targetSeasonId]: { ranked: rankedStats, normal: normalStats },
      };
      const cacheUpdateData: any = {
        id: accountId, platform, nickname: actualNickname, lower_nickname: actualNickname.toLowerCase(),
        search_count: (previous?.search_count ?? 0) + 1,
        updated_at: nowIso,
        last_seen_at: nowIso,
        ban_type: banType, season_stats_data: updatedSeasonStats, last_season_id: targetSeasonId,
        recent_match_ids: recentMatches, seasons_list: availableSeasons,
      };
      if (mastery.updated && mastery.data) {
        cacheUpdateData.survival_mastery_updated_at = nowIso;
        cacheUpdateData.survival_mastery_data = mastery.data;
      }
      if (clanResult.updated) {
        cacheUpdateData.clan_data = clanResult.data;
        cacheUpdateData.clan_updated_at = nowIso;
      }
      void Promise.resolve(createServiceRoleClient()
        .from('pubg_player_cache')
        .upsert(cacheUpdateData, { onConflict: 'id' }))
        .then(({ error: cacheWriteError }) => {
          if (cacheWriteError) console.error("[pubg-player] pubg_player_cache 갱신 실패:", cacheWriteError.message);
        }).catch(() => console.warn("[pubg-player] pubg_player_cache 갱신 실패", { requestId }));
      await writePubgCache(cacheKey, responseBody);
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
