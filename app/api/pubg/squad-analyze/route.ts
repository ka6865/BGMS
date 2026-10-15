import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { createClient as createSupabaseServerClient } from "@/utils/supabase/server";
import { getSquadAnalysisData } from "@/lib/pubg-analysis/squadAnalysis";
import { prefetchRecentTeamMatchDetails } from "@/lib/pubg-analysis/squadDetailPrefetch.server";
import { internalAppTarget } from "@/lib/server/internalAppOrigin";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";
import { isMatchDetailExpired } from "@/lib/pubg-analysis/matchRetention.server";

async function isLoggedIn(): Promise<boolean> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    return Boolean(data.user);
  } catch {
    return false;
  }
}

// 그룹 목록을 열 때 최근 팀 경기의 상세 분석을 먼저 채운다. 로그인 사용자만, 시간 예산 안에서 실행하고
// 실패해도 목록 응답은 그대로 진행한다.
async function prepareRecentTeamMatches(nickname: string, platform: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || !(await isLoggedIn())) return;
  const target = internalAppTarget();
  try {
    const result = await prefetchRecentTeamMatchDetails({
      supabase: createSupabaseAdminClient(url, serviceKey, { auth: { persistSession: false } }),
      nickname,
      platform,
      analyzeMatch: async (matchId, signal) => {
        const response = await fetch(
          `${target.origin}/api/pubg/match?matchId=${encodeURIComponent(matchId)}&nickname=${encodeURIComponent(nickname)}&platform=${encodeURIComponent(platform)}`,
          { cache: "no-store", signal, ...(target.headers ? { headers: target.headers } : {}) },
        );
        await response.arrayBuffer().catch(() => undefined);
        return response.ok;
      },
    });
    if (result.status === "done") console.info("[SQUAD-DETAIL-PREFETCH]", JSON.stringify(result));
  } catch (error) {
    console.warn("[SQUAD-DETAIL-PREFETCH] failed:", error instanceof Error ? error.message : error);
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nickname = searchParams.get("nickname");
  const platform = searchParams.get("platform") || "steam";
  const groupKey = searchParams.get("groupKey");

  if (!nickname) {
    return NextResponse.json({ error: "Nickname is required." }, { status: 400 });
  }
  if (platform !== "steam" && platform !== "kakao") {
    return NextResponse.json({ error: "지원하지 않는 플랫폼입니다." }, { status: 400 });
  }

  const privateResponse = await blockPrivatePlayer(platform, nickname, undefined, { lookupUpstream: true });
  if (privateResponse) return privateResponse;

  try {
    if (!groupKey) await prepareRecentTeamMatches(nickname, platform);
    const data = await getSquadAnalysisData(nickname, platform, groupKey);
    if ("errorCode" in data && data.errorCode === "PUBG_CALCULATION_UPGRADE_REQUIRED") {
      return NextResponse.json(data, { status: 409 });
    }
    if ("causeScenes" in data && Array.isArray(data.causeScenes) && Array.isArray(data.matchesSummary)) {
      const expiredMatchIds = new Set(data.matchesSummary
        .filter((match: any) => isMatchDetailExpired(match?.createdAt))
        .map((match: any) => match?.matchId));
      return NextResponse.json({
        ...data,
        causeScenes: data.causeScenes.filter((scene: any) => !expiredMatchIds.has(scene?.matchId)),
      });
    }
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("[SQUAD-ANALYZE-ERROR]", error);
    return NextResponse.json({ error: "스쿼드 분석을 완료하지 못했습니다." }, { status: 500 });
  }
}
