import { NextResponse } from "next/server";
import { getSquadAnalysisData } from "@/lib/pubg-analysis/squadAnalysis";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nickname = searchParams.get("nickname");
  const platform = searchParams.get("platform") || "steam";
  const groupKey = searchParams.get("groupKey");

  if (!nickname) {
    return NextResponse.json({ error: "Nickname is required." }, { status: 400 });
  }

  try {
    const data = await getSquadAnalysisData(nickname, platform, groupKey);
    return NextResponse.json(data, { status: "errorCode" in data && data.errorCode === "PUBG_CALCULATION_UPGRADE_REQUIRED" ? 409 : 200 });
  } catch (error: any) {
    console.error("[SQUAD-ANALYZE-ERROR]", error);
    return NextResponse.json({ error: error.message || "Failed to analyze squad synergy." }, { status: 500 });
  }
}
