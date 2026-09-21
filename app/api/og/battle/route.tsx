// app/api/og/battle/route.tsx
// 전적비교배틀 OG 이미지 — Satori 완전 호환 버전

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const nick1 = searchParams.get("nick1") || "Player1";
  const nick2 = searchParams.get("nick2") || "Player2";
  const score1Raw = searchParams.get("score1");
  const score2Raw = searchParams.get("score2");
  const winner = searchParams.get("winner") || "";

  const requestedNicknames = [
    [searchParams.get("nick1"), searchParams.get("platform1")],
    [searchParams.get("nick2"), searchParams.get("platform2")],
  ] as const;
  for (const [requestedNickname, requestedPlatform] of requestedNicknames) {
    if (!requestedNickname) continue;
    const platforms = requestedPlatform ? [requestedPlatform] : ["steam", "kakao"];
    for (const platform of platforms) {
      const privateResponse = await blockPrivatePlayer(platform, requestedNickname, undefined, { lookupUpstream: true });
      if (privateResponse) return privateResponse;
    }
  }

  const hasScore = score1Raw !== null && score2Raw !== null;
  const s1 = hasScore ? Number(score1Raw) : 0;
  const s2 = hasScore ? Number(score2Raw) : 0;

  const maxLen = Math.max(nick1.length, nick2.length);
  const nickFontSize = maxLen > 14 ? "44px" : maxLen > 10 ? "56px" : "64px";

  const nick1Wins = hasScore && (winner ? winner === nick1 : s1 > s2);
  const nick2Wins = hasScore && (winner ? winner === nick2 : s2 > s1);

  // 승자/패자 색상 (ternary로만 처리)
  const nick1Color = nick1Wins ? "#c7d2fe" : "#ffffff";
  const nick2Color = nick2Wins ? "#fecdd3" : "#ffffff";
  const score1Color = nick1Wins ? "#818cf8" : "#374151";
  const score2Color = nick2Wins ? "#f43f5e" : "#374151";

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          background: "#080810",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
          fontFamily: "sans-serif",
        }}
      >
        {/* 배경 그라디언트 레이어들 */}
        <div style={{
          position: "absolute", top: "0px", left: "0px",
          width: "500px", height: "630px",
          background: "linear-gradient(135deg, rgba(79,70,229,0.19) 0%, transparent 60%)",
        }} />
        <div style={{
          position: "absolute", top: "0px", right: "0px",
          width: "500px", height: "630px",
          background: "linear-gradient(225deg, rgba(244,63,94,0.19) 0%, transparent 60%)",
        }} />
        <div style={{
          position: "absolute", top: "0px", left: "380px",
          width: "440px", height: "630px",
          background: "linear-gradient(90deg, transparent, rgba(8,8,16,0.95) 25%, rgba(8,8,16,0.95) 75%, transparent)",
        }} />

        {/* 브랜드 상단 */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          paddingTop: "26px", gap: "12px",
        }}>
          <div style={{ fontSize: "20px", fontWeight: "900", color: "#f59e0b" }}>BGMS</div>
          <div style={{ width: "1px", height: "16px", background: "#374151" }} />
          <div style={{ fontSize: "11px", color: "#6b7280", fontWeight: "800", letterSpacing: "2px" }}>VS BATTLE</div>
        </div>

        {/* 메인 플레이어 영역 */}
        <div style={{
          display: "flex", alignItems: "center",
          justifyContent: "space-between",
          flexGrow: 1,
          paddingLeft: "56px", paddingRight: "56px",
        }}>

          {/* 플레이어 1 */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", flexGrow: 1, gap: "10px" }}>
            <div style={{ fontSize: "11px", fontWeight: "900", color: "#818cf8", letterSpacing: "4px" }}>
              PLAYER 1
            </div>
            <div style={{
              display: "flex",
              background: nick1Wins ? "#f59e0b" : "transparent",
              color: "#000",
              fontSize: "11px", fontWeight: "900",
              padding: "3px 10px",
              borderRadius: "6px",
              letterSpacing: "2px",
              opacity: nick1Wins ? 1 : 0,
              width: "40px",
            }}>
              WIN
            </div>
            <div style={{ fontSize: nickFontSize, fontWeight: "900", color: nick1Color, letterSpacing: "-2px", lineHeight: "1.05" }}>
              {nick1}
            </div>
            <div style={{
              display: "flex",
              background: "rgba(99,102,241,0.09)",
              border: "1px solid rgba(99,102,241,0.25)",
              borderRadius: "8px", padding: "5px 14px",
              fontSize: "12px", color: "#818cf8", fontWeight: "700",
            }}>
              AI Analysis
            </div>
          </div>

          {/* 중앙 */}
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            gap: "6px", width: "160px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ fontSize: "80px", fontWeight: "900", color: score1Color, letterSpacing: "-4px", lineHeight: "1" }}>
                {hasScore ? String(s1) : "V"}
              </div>
              <div style={{ fontSize: "28px", fontWeight: "900", color: "#374151" }}>
                {hasScore ? ":" : "S"}
              </div>
              <div style={{ fontSize: "80px", fontWeight: "900", color: score2Color, letterSpacing: "-4px", lineHeight: "1" }}>
                {hasScore ? String(s2) : ""}
              </div>
            </div>
            <div style={{ fontSize: "10px", color: "#374151", fontWeight: "800", letterSpacing: "3px" }}>
              {hasScore ? "SCORE" : ""}
            </div>
          </div>

          {/* 플레이어 2 */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexGrow: 1, gap: "10px" }}>
            <div style={{ fontSize: "11px", fontWeight: "900", color: "#f43f5e", letterSpacing: "4px" }}>
              PLAYER 2
            </div>
            <div style={{
              display: "flex",
              background: nick2Wins ? "#f59e0b" : "transparent",
              color: "#000",
              fontSize: "11px", fontWeight: "900",
              padding: "3px 10px",
              borderRadius: "6px",
              letterSpacing: "2px",
              opacity: nick2Wins ? 1 : 0,
              width: "40px",
            }}>
              WIN
            </div>
            <div style={{ fontSize: nickFontSize, fontWeight: "900", color: nick2Color, letterSpacing: "-2px", lineHeight: "1.05", textAlign: "right" }}>
              {nick2}
            </div>
            <div style={{
              display: "flex",
              background: "rgba(244,63,94,0.09)",
              border: "1px solid rgba(244,63,94,0.25)",
              borderRadius: "8px", padding: "5px 14px",
              fontSize: "12px", color: "#f43f5e", fontWeight: "700",
            }}>
              AI Analysis
            </div>
          </div>
        </div>

        {/* 하단 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", paddingBottom: "22px", gap: "16px", paddingLeft: "48px", paddingRight: "48px" }}>
          <div style={{ flexGrow: 1, height: "1px", background: "#1f2937" }} />
          <div style={{ fontSize: "12px", color: "#4b5563", fontWeight: "700", letterSpacing: "1px" }}>bgms.kr</div>
          <div style={{ flexGrow: 1, height: "1px", background: "#1f2937" }} />
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
