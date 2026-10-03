import { readPerformanceCache, readPerformanceStates } from "@/lib/pubg/performanceCache";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { getLegacyFullResultForHistory, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { buildMatchSummary, buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";
import { buildPlayerMatchRecordFromParticipant, fetchAndIngestBasicMatchSummaryOutcome } from "@/lib/pubg/playerMatchesIngest";
import { buildPlayerMatchIdentityFilter, hasObservedPlayerMatchValues, upsertPlayerMatches } from "@/lib/pubg/playerMatches";
import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";
import { normalizeRecentMatchIds } from "@/lib/pubg/recentMatches";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";
import { resolveCachedPlayerAccountId } from "@/lib/pubg/privatePlayerCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function isAccountId(value: unknown): value is string {
  return typeof value === "string" && /^account\.[A-Za-z0-9_-]+$/.test(value);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const matchIds = Array.isArray(body.matchIds)
      ? normalizeRecentMatchIds(body.matchIds)
      : [];
    const platform = normalizePlatform(body.platform || "steam");
    const playerId = normalizeName(body.nickname || body.playerId || "");

    if (!playerId || matchIds.length === 0) {
      return NextResponse.json({ summaries: {}, missingMatchIds: matchIds });
    }

    const cachedAccountId = await resolveCachedPlayerAccountId(platform, playerId);
    const accountId = isAccountId(cachedAccountId) ? cachedAccountId : undefined;
    const privateResponse = await blockPrivatePlayer(platform, playerId, accountId, { lookupUpstream: true });
    if (privateResponse) return privateResponse;
    const checkedAccounts = new Set<string>(accountId ? [accountId] : []);
    const checkCachePrivacy = async (cacheAccountId: string | undefined) => {
      if (!cacheAccountId || checkedAccounts.has(cacheAccountId)) return null;
      const response = await blockPrivatePlayer(platform, playerId, cacheAccountId);
      if (!response) checkedAccounts.add(cacheAccountId);
      return response;
    };

    // 1순위: processed_match_telemetry (3D/AI 풀 분석 완료 매치)
    const { data: telemetryData, error } = await supabase
      .from("processed_match_telemetry")
      .select("match_id, data")
      .eq("platform", platform)
      .eq("player_id", playerId)
      .in("match_id", matchIds);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const summaries: Record<string, any> = {};
    const cachedRecords = new Map<string, any>();
    const storedIds = new Set<string>();
    const existingMatchIds = new Set<string>();
    const ingestedMatchIds: string[] = [];
    for (const row of telemetryData || []) {
      const matchId = normalizeMatchId(row.match_id);
      if (!matchId || !matchIds.includes(matchId)) continue;
      const fullResult = getLegacyFullResultForHistory(row, playerId, platform);
      if (!fullResult || fullResult.v !== RESULT_VERSION) continue;
      const resultAccountId = isAccountId(fullResult.stats?.playerId) ? fullResult.stats.playerId : undefined;
      if (accountId && resultAccountId && resultAccountId !== accountId) continue;
      const cachePrivateResponse = await checkCachePrivacy(resultAccountId);
      if (cachePrivateResponse) return cachePrivateResponse;
      const embeddedId = fullResult.matchId || fullResult.match_id;
      if (embeddedId && normalizeMatchId(embeddedId) !== matchId) continue;

      const summary = buildMatchSummary(fullResult);
      if (summary) {
        // Legacy fullResult payloads may omit their embedded match ID. The
        // storage row was queried by the canonical ID, so retain it as the
        // authoritative navigation identity for history/detail consumers.
        summary.matchId = matchId;
        summaries[matchId] = summary;
        cachedRecords.set(matchId, {
          created_at: summary.createdAt, game_mode: summary.gameMode, map_name: summary.mapName,
          match_type: summary.matchType, kills: fullResult.stats?.kills, damage: fullResult.stats?.damageDealt,
          win_place: fullResult.stats?.winPlace, knocks: fullResult.stats?.DBNOs,
          survival_time: fullResult.stats?.timeSurvived, account_id: fullResult.stats?.playerId,
        });
      }
    }

    // 2순위: pubg_player_matches (기본 스탯 DB)
    {
      let query = supabase
        .from("pubg_player_matches")
        .select("match_id, player_id, platform, account_id, played_at, game_mode, map_name, kills, damage, win_place, match_type, knocks, survival_time")
        .eq("platform", platform);
      const identityFilter = buildPlayerMatchIdentityFilter(playerId, accountId);
      query = identityFilter ? query.or(identityFilter) : query.eq("player_id", playerId);
      const { data: playerMatchesData, error: playerMatchesError } = await query.in("match_id", matchIds);
      if (playerMatchesError) return NextResponse.json({ error: playerMatchesError.message }, { status: 503 });

      for (const row of playerMatchesData || []) {
        const matchId = normalizeMatchId(row.match_id);
        if (!matchId || !matchIds.includes(matchId)) continue;
        const rowAccountId = isAccountId(row.account_id) ? row.account_id : undefined;
        if (accountId && rowAccountId && rowAccountId !== accountId) continue;
        const cachePrivateResponse = await checkCachePrivacy(rowAccountId);
        if (cachePrivateResponse) return cachePrivateResponse;
        existingMatchIds.add(matchId);
        if (hasObservedPlayerMatchValues(row)) storedIds.add(matchId);
        if (!summaries[matchId]) summaries[matchId] = buildBasicMatchSummary({ ...row, match_id: matchId });
      }
    }

    // 3순위: match_stats_raw (전적 원본 스탯 DB)
    const stillMissingIds = matchIds.filter((id: string) => !summaries[id]);
    if (stillMissingIds.length > 0) {
      const { data: rawStatsData, error: rawStatsError } = await supabase
        .from("match_stats_raw")
        .select("match_id, player_id, platform, created_at, damage, kills, win_place, game_mode, map_name")
        .eq("platform", platform)
        .eq("player_id", playerId)
        .in("match_id", stillMissingIds);
      if (rawStatsError) return NextResponse.json({ error: rawStatsError.message }, { status: 503 });

      for (const row of rawStatsData || []) {
        const matchId = normalizeMatchId(row.match_id);
        if (!matchId || !matchIds.includes(matchId) || summaries[matchId]) continue;
        summaries[matchId] = buildBasicMatchSummary({ ...row, match_id: matchId });
        cachedRecords.set(matchId, row);
      }
    }

    // A summary cache hit does not imply that the paginated basic row exists.
    // Insert absent rows only. Existing incomplete rows remain pending for
    // official collection; ignoreDuplicates cannot repair or acknowledge them.
    const repairs = [...cachedRecords].flatMap(([matchId, row]) => {
      const createdAt = row.created_at;
      if (existingMatchIds.has(matchId) || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
        || ![row.kills, row.damage, row.win_place].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        || row.win_place < 1) return [];
      const record = buildPlayerMatchRecordFromParticipant({
        matchId, nickname: playerId, platform, createdAt,
        gameMode: row.game_mode || 'unknown', mapName: row.map_name || 'unknown',
        matchType: row.match_type || 'unknown', kills: row.kills, damage: row.damage,
        winPlace: row.win_place, knocks: row.knocks, survivalTime: row.survival_time,
      });
      if (!hasObservedPlayerMatchValues(record)) return [];
      return [{ ...record, ...(typeof row.account_id === 'string' && /^account\.[A-Za-z0-9_-]+$/.test(row.account_id) ? { account_id: row.account_id } : {}) }];
    });
    if (repairs.length) {
      if (!await upsertPlayerMatches(supabase, repairs, { ignoreDuplicates: true })) {
        return NextResponse.json({ error: '기본 전적을 저장하지 못했습니다.' }, { status: 503 });
      }
      // An ignored conflict is not proof of persistence: another request may
      // have inserted incomplete values or a different account under this key.
      const { data: repairedRows, error: repairReadError } = await supabase
        .from("pubg_player_matches")
        .select("match_id, player_id, platform, account_id, played_at, game_mode, map_name, kills, damage, win_place, match_type")
        .eq("platform", platform)
        .eq("player_id", playerId)
        .in("match_id", repairs.map(record => record.match_id));
      if (repairReadError) return NextResponse.json({ error: '기본 전적 저장 결과를 확인하지 못했습니다.' }, { status: 503 });
      for (const record of repairs) {
        const saved = (repairedRows || []).find(row => normalizeMatchId(row.match_id) === record.match_id
          && hasObservedPlayerMatchValues(row)
          && (!accountId || !isAccountId(row.account_id) || row.account_id === accountId)
          && (!record.account_id || row.account_id === record.account_id));
        if (saved) {
          const cachePrivateResponse = await checkCachePrivacy(isAccountId(saved.account_id) ? saved.account_id : undefined);
          if (cachePrivateResponse) return cachePrivateResponse;
          storedIds.add(record.match_id);
          ingestedMatchIds.push(record.match_id);
        }
      }
    }

    // Fetch at most five new matches per request; the client continues with
    // unattempted IDs so expired or failed matches cannot block later records.
    const uningestedIds = matchIds.filter((id: string) => !storedIds.has(id));
    let nextMatchIds: string[] = [];
    let collectionStopped = false;
    if (body.collect !== false && uningestedIds.length > 0) {
      const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
      if (apiKey) {
        const outcomes = await Promise.all(
          uningestedIds.slice(0, 5).map((id: string) =>
            fetchAndIngestBasicMatchSummaryOutcome(supabase, id, playerId, platform, apiKey, { signal: request.signal, ...(accountId ? { expectedAccountId: accountId } : {}) })
          )
        );

        for (const { record } of outcomes) {
          const matchId = normalizeMatchId(record?.match_id);
          if (record && matchId && matchIds.includes(matchId)) {
            storedIds.add(matchId);
            ingestedMatchIds.push(matchId);
            if (!summaries[matchId]) summaries[matchId] = buildBasicMatchSummary({ ...record, match_id: matchId });
          }
        }
        collectionStopped = outcomes.some((outcome) => outcome.status === "rate_limited" || outcome.httpStatus === 401 || outcome.httpStatus === 403)
          || outcomes.every((outcome) => outcome.status === "network_error" || outcome.status === "upstream_error");
        if (!request.signal.aborted && !collectionStopped) {
          nextMatchIds = uningestedIds.slice(5);
        }
      } else collectionStopped = true;
    }

    const performances = await readPerformanceCache(supabase, platform, playerId, matchIds, accountId);
    for (const [id, benchmark] of Object.entries(performances)) {
      if (summaries[id] && !summaries[id].benchmark) { summaries[id].benchmark = benchmark; summaries[id].performanceOnly = true; }
    }
    const performanceStates = await readPerformanceStates(supabase, platform, playerId, matchIds, accountId);
    for (const [id, state] of Object.entries(performanceStates)) if (summaries[id]) summaries[id].performanceState = state;
    return NextResponse.json({
      summaries,
      missingMatchIds: matchIds.filter((id: string) => !storedIds.has(id)),
      nextMatchIds,
      collectionStopped,
      ingestedMatchIds,
    }, {headers: {"Cache-Control": "no-store"}});
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "최근 매치 요약을 불러오지 못했습니다." },
      { status: 500 }
    );
  }
}
