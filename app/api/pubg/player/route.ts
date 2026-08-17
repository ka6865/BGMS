import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import { trackPubgRateLimit } from "@/lib/pubg-analysis/pubgApiTracker";
import { reportPubgApiError } from "@/lib/pubg/apiHelper";
import { mergeRecentMatchIds } from "@/lib/pubg/recentMatches";
import {
  normalizeSurvivalMasteryPayload,
  shouldRefreshSurvivalMastery,
} from "@/lib/pubg/survivalMastery";
import type { StatsSurvivalMastery } from "@/types/stats-page";
import {
  buildPlayerCacheKey,
  claimForceRefresh,
  readPubgCache,
  writePubgCache,
} from "@/lib/pubg/responseCache";

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

function pubgFetchInit(
  headers: HeadersInit,
  timeoutMs: number,
  revalidateSeconds: number,
  forceRefresh: boolean
): RequestInit & { next?: { revalidate: number } } {
  const base = {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  };

  if (forceRefresh) {
    return {
      ...base,
      cache: "no-store"
    };
  }

  return {
    ...base,
    next: { revalidate: revalidateSeconds }
  };
}

// [V12.1] 네트워크 불안정 대응을 위한 재시도 헬퍼 함수 (전체 대기 시간 누적 방지)
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 1000): Promise<T> {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isNetworkError = err.message?.includes('fetch') || err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message?.includes('timeout');
      if (!isNetworkError) throw err;
      await new Promise(res => setTimeout(res, delay));
      delay *= 2;
    }
  }
  throw lastError;
}

async function safeJsonParse(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    throw new Error(`PUBG API 응답이 JSON 형식이 아닙니다 (Content-Type: ${contentType}, Status: ${res.status}). API 호출 한도 초과 또는 일시적인 장애일 수 있습니다.`);
  }
  try {
    return await res.json();
  } catch (err: any) {
    throw new Error(`JSON 파싱 실패: ${err.message}`);
  }
}

async function fetchSurvivalMastery(
  platform: string,
  accountId: string,
  headers: HeadersInit,
): Promise<StatsSurvivalMastery | null> {
  const response = await fetch(
    `https://api.pubg.com/shards/${platform}/players/${accountId}/survival_mastery`,
    pubgFetchInit(headers, 8000, 43200, true),
  );
  trackPubgRateLimit(response.headers);
  if (!response.ok) return null;
  return normalizeSurvivalMasteryPayload(await safeJsonParse(response));
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
  const nickname = searchParams.get("nickname");
  const platform = searchParams.get("platform") || "steam";
  const reqSeason = normalizeSeasonParam(searchParams.get("season"));
  // _t 타임스탬프 파라미터는 강제 갱신 조건에서 제외하여 단순 검색/로딩 시 캐시를 사용하도록 개편
  const forceRefresh = searchParams.get("refresh") === "true";

  if (!nickname)
    return NextResponse.json(
      { error: "닉네임을 입력해주세요." },
      { status: 400 }
    );

  // 1. 분산 캐시 조회 (인메모리 L1 → DB L2, 3분 TTL)
  const cacheKey = buildPlayerCacheKey(platform, nickname, reqSeason);
  if (forceRefresh) {
    const claimed = await claimForceRefresh(cacheKey);
    if (!claimed) {
      return NextResponse.json(
        { error: "강제 갱신은 같은 전적에 대해 1분에 한 번만 요청할 수 있습니다." },
        { status: 429 },
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
  const shouldFetchSurvivalMastery = forceRefresh
    || shouldRefreshSurvivalMastery(cacheData?.survival_mastery_updated_at);

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
      const shouldFetchMissingRequestedSeason = !!reqSeason && !statsForSeason;

      // 자동 시즌 선택일 때만 기록 있는 시즌으로 fallback합니다.
      // 사용자가 드롭다운으로 명시 선택한 시즌은 선택값을 유지하고 빈 기록을 보여줍니다.
      if (!statsForSeason && !reqSeason && cacheData.season_stats_data) {
        const fallbackSeasonId = validLastSeasonId || Object.keys(cacheData.season_stats_data).find(isValidSeasonId);
        if (fallbackSeasonId) {
          statsForSeason = cacheData.season_stats_data[fallbackSeasonId];
          selectedStatsSeasonId = fallbackSeasonId;
        }
      }

      if (!shouldFetchMissingRequestedSeason && !shouldFetchSurvivalMastery) {
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
  }

  try {
    // 2. PUBG API 호출 (캐시된 닉네임 우선 사용, 개별 타임아웃 8초로 조정)
    let playerRes = await withRetry(() => fetch(
      `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${targetNickname}`,
      pubgFetchInit(headers, 8000, 60, forceRefresh)
    ));
    trackPubgRateLimit(playerRes.headers);

    // 3. 캐시된 이름으로 실패 시 원본 입력으로 재시도 (Fallback)
    if (!playerRes.ok && playerRes.status === 404 && targetNickname !== nickname) {
      playerRes = await withRetry(() => fetch(
        `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${nickname}`,
        pubgFetchInit(headers, 8000, 60, forceRefresh)
      ));
    }

    if (!playerRes.ok) {
      if (playerRes.status === 429) {
        return NextResponse.json(
          { error: "PUBG API 호출 한도가 일시적으로 초과되었습니다. 약 1분 후 다시 시도해 주세요." },
          { status: 429 }
        );
      }
      if (playerRes.status === 404) {
        return playerNotFoundResponse(supabase, nickname, platform);
      }
      throw new Error(`PUBG API 에러: ${playerRes.status}`);
    }
    const playerData = await safeJsonParse(playerRes);
    const playerRecord = playerData?.data?.[0];
    if (!playerRecord?.id) {
      return playerNotFoundResponse(supabase, nickname, platform);
    }
    const accountId = playerRecord.id;
    const actualNickname = playerRecord.attributes.name;
    const banType = playerRecord.attributes?.banType ?? "None";

    // (클랜/무기 데이터 갱신 여부를 포함하여 하단에서 통합 캐시 업데이트를 수행합니다.)

    const apiRecentMatches = (playerRecord.relationships?.matches?.data || []).map(
      (m: any) => m.id
    );
    const recentMatches = mergeRecentMatchIds(apiRecentMatches, cacheData?.recent_match_ids);

    const seasonRes = await withRetry(() => fetch(
      `https://api.pubg.com/shards/${platform}/seasons`,
      pubgFetchInit(headers, 8000, 43200, forceRefresh)
    ));
    trackPubgRateLimit(seasonRes.headers);
    const seasonData = await safeJsonParse(seasonRes);
    // [FIX] pc- 필터링을 완화하여 콘솔(Xbox, PSN) 시즌 데이터도 처리 가능하도록 수정
    const availableSeasons = seasonData.data
      .filter((s: any) => s.id.includes("pc-") || s.id.includes("console-"))
      .sort((a: any, b: any) => b.id.localeCompare(a.id));

    if (availableSeasons.length === 0) throw new Error("사용 가능한 시즌 데이터가 없습니다.");

    const currentSeason = availableSeasons.find(
      (s: any) => s.attributes.isCurrentSeason
    ) || availableSeasons[0];

    let targetSeasonId = reqSeason || currentSeason.id;

    // 현재 시즌 요청 시 데이터가 없으면 데이터가 있는 최근 시즌 탐색 (최대 3개 시즌)
    if (!reqSeason) {
      try {
        const checkRes = await withRetry(() => fetch(
          `https://api.pubg.com/shards/${platform}/players/${accountId}/seasons/${targetSeasonId}`,
          pubgFetchInit(headers, 8000, 60, forceRefresh)
        ));
        if (checkRes.ok) {
          const checkData = await safeJsonParse(checkRes);
          const stats = checkData.data.attributes.gameModeStats;
          const hasData = Object.values(stats).some((m: any) => m.roundsPlayed > 0);

          if (!hasData) {
            for (let i = 1; i < Math.min(availableSeasons.length, 4); i++) {
              const prevId = availableSeasons[i].id;
              const prevRes = await fetch(
                `https://api.pubg.com/shards/${platform}/players/${accountId}/seasons/${prevId}`,
                pubgFetchInit(headers, 8000, 60, forceRefresh)
              );
              if (prevRes.ok) {
                const prevData = await safeJsonParse(prevRes);
                if (Object.values(prevData.data.attributes.gameModeStats).some((m: any) => m.roundsPlayed > 0)) {
                  targetSeasonId = prevId;
                  break;
                }
              }
            }
          }
        }
      } catch {
      }
    }

    // Retrieve clanId from player attributes (NOT relationships — PUBG API spec)
    const clanId: string | null = playerRecord.attributes?.clanId ?? null;

    // 캐시 유효성 판단 (클랜 24시간)
    const CLAN_CACHE_TTL = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const isClanCacheValid = cacheData?.clan_updated_at && (now - new Date(cacheData.clan_updated_at).getTime() < CLAN_CACHE_TTL);

    let clanDataPromise: Promise<{ source: string; data: any; updated: boolean }>;
    if (isClanCacheValid && cacheData?.clan_data) {
      clanDataPromise = Promise.resolve({ source: 'cache', data: cacheData.clan_data, updated: false });
    } else {
      clanDataPromise = clanId
        ? fetch(`https://api.pubg.com/shards/${platform}/clans/${clanId}`, pubgFetchInit(headers, 6000, 86400, forceRefresh))
            .then(async (res) => {
              if (res.ok) {
                const clanJson = await res.json();
                const attr = clanJson.data?.attributes ?? {};
                const parsedClan = {
                  id: clanId,
                  name: attr.clanName ?? "",
                  tag: attr.clanTag ?? "",
                  level: attr.clanLevel ?? 0,
                  memberCount: attr.clanMemberCount ?? 0,
                };
                return { source: 'api', data: parsedClan, updated: true };
              }
              throw new Error(`Clan API Error: ${res.status}`);
            })
            .catch(() => {
              return { source: 'fallback', data: cacheData?.clan_data || null, updated: false };
            })
        : Promise.resolve({ source: 'api', data: null, updated: false });
    }

    const cachedWeaponMastery = cacheData?.weapon_mastery_data || [];
    const survivalMasteryPromise = shouldFetchSurvivalMastery
      ? fetchSurvivalMastery(platform, accountId, headers).catch((error) => {
        console.warn(
          "[pubg-player] Survival Mastery 조회 실패:",
          error instanceof Error ? error.message : error,
        );
        return null;
      })
      : Promise.resolve(cachedSurvivalMastery);

    // Parallel fetch: ranked, normal season stats + clan info + account mastery
    const [rankedRes, normalRes, clanResult, fetchedSurvivalMastery] = await Promise.all([
      withRetry(() => fetch(
        `https://api.pubg.com/shards/${platform}/players/${accountId}/seasons/${targetSeasonId}/ranked`,
        pubgFetchInit(headers, 8000, 60, forceRefresh)
      )),
      withRetry(() => fetch(
        `https://api.pubg.com/shards/${platform}/players/${accountId}/seasons/${targetSeasonId}`,
        pubgFetchInit(headers, 8000, 60, forceRefresh)
      )),
      clanDataPromise,
      survivalMasteryPromise,
    ]);
    trackPubgRateLimit(rankedRes.headers);
    trackPubgRateLimit(normalRes.headers);

    const rankedStats = { solo: null as any, duo: null as any, squad: null as any };
    if (rankedRes.ok) {
      const rankedData = await safeJsonParse(rankedRes);
      const allStats = rankedData.data.attributes.rankedGameModeStats;
      // ✅ roundsPlayed 기준으로 더 많이 플레이한 모드 선택 (FPP/TPP 혼용 유저 대응)
      const pickMode = (fpp: any, tpp: any) => {
        if (!fpp && !tpp) return null;
        if (!fpp) return tpp;
        if (!tpp) return fpp;
        return (fpp.roundsPlayed ?? 0) >= (tpp.roundsPlayed ?? 0) ? fpp : tpp;
      };
      rankedStats.solo = pickMode(allStats["solo-fpp"], allStats["solo"]);
      rankedStats.duo  = pickMode(allStats["duo-fpp"],  allStats["duo"]);
      rankedStats.squad = pickMode(allStats["squad-fpp"], allStats["squad"]);
    }

    const normalStats = { solo: null as any, duo: null as any, squad: null as any };
    if (normalRes.ok) {
      const normalData = await safeJsonParse(normalRes);
      const allStats = normalData.data.attributes.gameModeStats;
      // ✅ roundsPlayed 기준으로 더 많이 플레이한 모드 선택 (일반전도 동일 기준 적용)
      const pickMode = (fpp: any, tpp: any) => {
        if (!fpp && !tpp) return null;
        if (!fpp) return tpp;
        if (!tpp) return fpp;
        return (fpp.roundsPlayed ?? 0) >= (tpp.roundsPlayed ?? 0) ? fpp : tpp;
      };
      normalStats.solo  = pickMode(allStats["solo-fpp"],  allStats["solo"]);
      normalStats.duo   = pickMode(allStats["duo-fpp"],   allStats["duo"]);
      normalStats.squad = pickMode(allStats["squad-fpp"], allStats["squad"]);
    }

    const clan = clanResult.data;
    const survivalMastery = shouldFetchSurvivalMastery
      ? (fetchedSurvivalMastery || cachedSurvivalMastery)
      : cachedSurvivalMastery;
    const weaponMastery = cachedWeaponMastery;

    // 4. 캐시 업데이트 (클랜/무기 정보 통합 upsert 및 검색 횟수 누적)
    const currentSearchCount = cacheData?.search_count ?? 0;
    const nowIso = new Date().toISOString();

    // 기존 season_stats_data에 현재 시즌 통계를 병합하여 저장
    const existingSeasonStats = cacheData?.season_stats_data || {};
    const updatedSeasonStats = {
      ...existingSeasonStats,
      [targetSeasonId]: { ranked: rankedStats, normal: normalStats },
    };

    const cacheUpdateData: any = {
      id: accountId,
      platform,
      nickname: actualNickname,
      lower_nickname: actualNickname.toLowerCase(),
      search_count: currentSearchCount + 1,
      updated_at: nowIso,
      // 사용자가 실제로 조회한 시점. 매치 분석의 대량 upsert 는 이 값을 쓰지 않아
      // 보존 정책(compact_pubg_player_cache)이 자동 수집 행과 실사용 행을 구분한다.
      last_seen_at: nowIso,
      ban_type: banType,
      // 시즌/매치 데이터를 항상 갱신하여 DB와 응답이 동기화되도록 보장
      season_stats_data: updatedSeasonStats,
      last_season_id: targetSeasonId,
      recent_match_ids: recentMatches,
      seasons_list: availableSeasons,
    };

    // 동시 조회 중 한 요청의 optional mastery 실패(null)가 다른 요청의
    // 성공 데이터를 덮어쓰지 않도록 값이 있을 때만 data 컬럼을 upsert한다.
    if (shouldFetchSurvivalMastery) {
      cacheUpdateData.survival_mastery_updated_at = nowIso;
      if (survivalMastery) cacheUpdateData.survival_mastery_data = survivalMastery;
    } else if (cacheData?.survival_mastery_updated_at) {
      cacheUpdateData.survival_mastery_updated_at = cacheData.survival_mastery_updated_at;
    }

    const isNewUser = !cacheData;
    if (clanResult.updated || isNewUser) {
      cacheUpdateData.clan_data = clanResult.data;
      cacheUpdateData.clan_updated_at = nowIso;
    }

    // pubg_player_cache 쓰기는 service_role 로만 수행한다.
    // 이 라우트의 supabase 는 utils/supabase/server 의 anon 키 클라이언트이며,
    // 20260730203000 마이그레이션이 anon/authenticated 쓰기 권한을 회수했다.
    // fire-and-forget 이라 실패해도 조용히 넘어가므로 오류를 명시적으로 로깅한다.
    createServiceRoleClient()
      .from('pubg_player_cache')
      .upsert(cacheUpdateData, { onConflict: 'id' })
      .then(({ error: cacheWriteError }) => {
        if (cacheWriteError) {
          console.error("[pubg-player] pubg_player_cache 갱신 실패:", cacheWriteError.message);
        }
      });

    // 최근 매치들의 모드 정보를 match_master_telemetry에서 일괄 가져옴
    const { data: modeData } = await supabase
      .from("match_master_telemetry")
      .select("match_id, game_mode")
      .in("match_id", recentMatches);

    const matchModes = (modeData || []).reduce((acc: Record<string, string>, item: any) => {
      acc[item.match_id] = item.game_mode;
      return acc;
    }, {});

    const responseBody = {
      nickname: actualNickname,
      platform,
      seasonId: targetSeasonId,
      seasons: availableSeasons.map((s: any) => ({
        id: s.id,
        name: `Season ${s.id.split("-").pop()}`,
      })),
      stats: { ranked: rankedStats, normal: normalStats },
      recentMatches,
      matchModes,
      clan,
      survivalMastery,
      weaponMastery,
      banType,
      // PUBG API 직접 호출 경로에서도 updatedAt을 포함하여 클라이언트가 올바른 시각을 표시하도록 보장
      updatedAt: nowIso,
    };

    // 분산 캐시 업데이트 (L1 + L2)
    await writePubgCache(cacheKey, responseBody);

    return NextResponse.json(responseBody);
  } catch (error: any) {
    const isRateLimit = error.message?.includes("429") || error.status === 429;
    const status = isRateLimit ? 429 : 500;
    const errorMsg = isRateLimit
      ? "PUBG API 호출 한도가 일시적으로 초과되었습니다. 약 1분 후 다시 시도해 주세요."
      : (error.message || "오류가 발생했습니다.");

    // [MONITORING] PUBG API 에러 감지 및 기록
    await reportPubgApiError({
      route: "/api/pubg/player",
      status,
      message: errorMsg,
      detail: error.stack || error.message,
    });

    return NextResponse.json(
      { error: errorMsg },
      { status }
    );
  }
}
