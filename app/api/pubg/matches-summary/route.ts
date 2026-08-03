import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { getValidFullResult, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { buildMatchSummary, buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";

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
      ? body.matchIds.map(String).filter(Boolean).slice(0, 20)
      : [];
    const platform = normalizePlatform(body.platform || "steam");
    const playerId = normalizeName(body.nickname || body.playerId || "");

    if (!playerId || matchIds.length === 0) {
      return NextResponse.json({ summaries: {}, missingMatchIds: matchIds });
    }

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
      const fullResult = getValidFullResult(row, playerId, platform);
      if (!fullResult || (fullResult.v || 0) < RESULT_VERSION) continue;

      const summary = buildMatchSummary(fullResult);
      if (summary) summaries[row.match_id] = summary;
    }

    const missingIds = matchIds.filter((id: string) => !summaries[id]);

    if (missingIds.length > 0) {
      const { data: playerMatchesData } = await supabase
        .from("pubg_player_matches")
        .select("match_id, player_id, platform, played_at, game_mode, map_name, kills, damage, win_place")
        .eq("platform", platform)
        .eq("player_id", playerId)
        .in("match_id", missingIds);

      for (const row of playerMatchesData || []) {
        if (!summaries[row.match_id]) {
          summaries[row.match_id] = buildBasicMatchSummary(row);
        }
      }
    }

    const stillMissingIds = matchIds.filter((id: string) => !summaries[id]);
    if (stillMissingIds.length > 0) {
      const { data: rawStatsData } = await supabase
        .from("match_stats_raw")
        .select("match_id, player_id, platform, damage, kills, win_place, game_mode, map_name")
        .eq("platform", platform)
        .eq("player_id", playerId)
        .in("match_id", stillMissingIds);

      for (const row of rawStatsData || []) {
        if (!summaries[row.match_id]) {
          summaries[row.match_id] = buildBasicMatchSummary(row);
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
