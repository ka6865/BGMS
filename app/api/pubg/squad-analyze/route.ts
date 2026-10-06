import { NextResponse } from "next/server";
import { getSquadAnalysisData } from "@/lib/pubg-analysis/squadAnalysis";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";
import { isMatchDetailExpired } from "@/lib/pubg-analysis/matchRetention.server";

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
    return NextResponse.json({ error: error.message || "Failed to analyze squad synergy." }, { status: 500 });
  }
}
