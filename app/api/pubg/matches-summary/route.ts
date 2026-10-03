import { readPerformanceCache, readPerformanceStates } from "@/lib/pubg/performanceCache";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { getLegacyFullResultForHistory, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { buildMatchSummary, buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";
import { fetchAndIngestBasicMatchSummaryOutcome } from "@/lib/pubg/playerMatchesIngest";
import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";
import { normalizeRecentMatchIds } from "@/lib/pubg/recentMatches";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

    const privateResponse = await blockPrivatePlayer(platform, playerId, undefined, { lookupUpstream: true });
    if (privateResponse) return privateResponse;

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
    for (const row of telemetryData || []) {
      const matchId = normalizeMatchId(row.match_id);
      if (!matchId || !matchIds.includes(matchId)) continue;
      const fullResult = getLegacyFullResultForHistory(row, playerId, platform);
      if (!fullResult || fullResult.v !== RESULT_VERSION) continue;

      const summary = buildMatchSummary(fullResult);
      if (summary) {
        // Legacy fullResult payloads may omit their embedded match ID. The
        // storage row was queried by the canonical ID, so retain it as the
        // authoritative navigation identity for history/detail consumers.
        summary.matchId = matchId;
        summaries[matchId] = summary;
      }
    }

    // 2순위: pubg_player_matches (기본 스탯 DB)
    const missingIds = matchIds.filter((id: string) => !summaries[id]);
    if (missingIds.length > 0) {
      const { data: playerMatchesData, error: playerMatchesError } = await supabase
        .from("pubg_player_matches")
        .select("match_id, player_id, platform, played_at, game_mode, map_name, kills, damage, win_place, match_type, knocks, survival_time")
        .eq("platform", platform)
        .eq("player_id", playerId)
        .in("match_id", missingIds);
      if (playerMatchesError) return NextResponse.json({ error: playerMatchesError.message }, { status: 503 });

      for (const row of playerMatchesData || []) {
        const matchId = normalizeMatchId(row.match_id);
        if (!matchId || !matchIds.includes(matchId) || summaries[matchId]) continue;
        summaries[matchId] = buildBasicMatchSummary({ ...row, match_id: matchId });
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
      }
    }

    // Fetch at most five new matches per request; the client continues with
    // unattempted IDs so expired or failed matches cannot block later records.
    const uningestedIds = matchIds.filter((id: string) => !summaries[id]);
    let nextMatchIds: string[] = [];
    let collectionStopped = false;
    if (uningestedIds.length > 0) {
      const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
      if (apiKey) {
        const outcomes = await Promise.all(
          uningestedIds.slice(0, 5).map((id: string) =>
            fetchAndIngestBasicMatchSummaryOutcome(supabase, id, playerId, platform, apiKey, { signal: request.signal })
          )
        );

        for (const { record } of outcomes) {
          const matchId = normalizeMatchId(record?.match_id);
          if (record && matchId && matchIds.includes(matchId) && !summaries[matchId]) {
            summaries[matchId] = buildBasicMatchSummary({ ...record, match_id: matchId });
          }
        }
        collectionStopped = outcomes.some((outcome) => outcome.status === "rate_limited" || outcome.httpStatus === 401 || outcome.httpStatus === 403)
          || outcomes.every((outcome) => outcome.status === "network_error" || outcome.status === "upstream_error");
        if (!request.signal.aborted && !collectionStopped) {
          nextMatchIds = uningestedIds.slice(5);
        }
      } else collectionStopped = true;
    }

    const performances = await readPerformanceCache(supabase, platform, playerId, matchIds);
    for (const [id, benchmark] of Object.entries(performances)) {
      if (summaries[id] && !summaries[id].benchmark) { summaries[id].benchmark = benchmark; summaries[id].performanceOnly = true; }
    }
    const performanceStates = await readPerformanceStates(supabase, platform, playerId, matchIds);
    for (const [id, state] of Object.entries(performanceStates)) if (summaries[id]) summaries[id].performanceState = state;
    return NextResponse.json({
      summaries,
      missingMatchIds: matchIds.filter((id: string) => !summaries[id]),
      nextMatchIds,
      collectionStopped,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "최근 매치 요약을 불러오지 못했습니다." },
      { status: 500 }
    );
  }
}
