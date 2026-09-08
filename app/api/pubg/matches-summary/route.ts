import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { getLegacyFullResultForHistory, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { buildMatchSummary, buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";
import { fetchAndIngestBasicMatchSummary } from "@/lib/pubg/playerMatchesIngest";
import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";
import { normalizeRecentMatchIds } from "@/lib/pubg/recentMatches";

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
      const { data: playerMatchesData } = await supabase
        .from("pubg_player_matches")
        .select("match_id, player_id, platform, played_at, game_mode, map_name, kills, damage, win_place, match_type, knocks, survival_time")
        .eq("platform", platform)
        .eq("player_id", playerId)
        .in("match_id", missingIds);

      for (const row of playerMatchesData || []) {
        const matchId = normalizeMatchId(row.match_id);
        if (!matchId || !matchIds.includes(matchId) || summaries[matchId]) continue;
        summaries[matchId] = buildBasicMatchSummary({ ...row, match_id: matchId });
      }
    }

    // 3순위: match_stats_raw (전적 원본 스탯 DB)
    const stillMissingIds = matchIds.filter((id: string) => !summaries[id]);
    if (stillMissingIds.length > 0) {
      const { data: rawStatsData } = await supabase
        .from("match_stats_raw")
        .select("match_id, player_id, platform, created_at, damage, kills, win_place, game_mode, map_name")
        .eq("platform", platform)
        .eq("player_id", playerId)
        .in("match_id", stillMissingIds);

      for (const row of rawStatsData || []) {
        const matchId = normalizeMatchId(row.match_id);
        if (!matchId || !matchIds.includes(matchId) || summaries[matchId]) continue;
        summaries[matchId] = buildBasicMatchSummary({ ...row, match_id: matchId });
      }
    }

    // 4순위: PUBG API 실시간 경량 스탯 조회 & pubg_player_matches DB 저장 (상한 5건)
    const uningestedIds = matchIds.filter((id: string) => !summaries[id]).slice(0, 5);
    if (uningestedIds.length > 0) {
      const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
      if (apiKey) {
        const fetchedRecords = await Promise.all(
          uningestedIds.map((id: string) =>
            fetchAndIngestBasicMatchSummary(supabase, id, playerId, platform, apiKey)
          )
        );

        for (const record of fetchedRecords) {
          const matchId = normalizeMatchId(record?.match_id);
          if (record && matchId && matchIds.includes(matchId) && !summaries[matchId]) {
            summaries[matchId] = buildBasicMatchSummary({ ...record, match_id: matchId });
          }
        }
      }
    }

    return NextResponse.json({
      summaries,
      missingMatchIds: matchIds.filter((id: string) => !summaries[id])
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "최근 매치 요약을 불러오지 못했습니다." },
      { status: 500 }
    );
  }
}
