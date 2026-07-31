// app/rankings/opengraph-image.tsx
// Next.js 16 내장 ImageResponse를 사용한 동적 랭킹 OG 이미지 생성
// 이번 주 최고 딜량, 최고 킬, 최고 티어 점수를 기록한 1등 플레이어 정보를 실시간으로 표출합니다.

import { ImageResponse } from "next/og";
import { getWeeklyTopDamage, getWeeklyTopKills, getTopTierRanking } from "@/actions/rankings";

export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const dynamic = "force-dynamic";

export default async function OgImage() {
  let topDamagePlayer = "데이터 없음";
  let topDamageValue = 0;
  let topDamageMode = "";

  let topKillsPlayer = "데이터 없음";
  let topKillsValue = 0;
  let topKillsMode = "";

  let topTierPlayer = "데이터 없음";
  let topTierValue = 0;
  let topTierGrade = "C";

  try {
    // 3가지 부문의 랭킹 목록을 가져옴
    const [damageResult, killsResult, tierResult] = await Promise.all([
      getWeeklyTopDamage("all", "all", "all"),
      getWeeklyTopKills("all", "all", "all"),
      getTopTierRanking("all", "all", "all"),
    ]);

    const damageList = damageResult.data;
    const killsList = killsResult.data;
    const tierList = tierResult.data;

    if (damageList.length > 0) {
      topDamagePlayer = damageList[0].nickname || damageList[0].player_id;
      topDamageValue = damageList[0].value;
      topDamageMode = damageList[0].game_mode;
    }

    if (killsList.length > 0) {
      topKillsPlayer = killsList[0].nickname || killsList[0].player_id;
      topKillsValue = killsList[0].value;
      topKillsMode = killsList[0].game_mode;
    }

    if (tierList.length > 0) {
      topTierPlayer = tierList[0].nickname || tierList[0].player_id;
      topTierValue = tierList[0].value;
      topTierGrade = tierList[0].tier || "C";
    }
  } catch (error) {
    console.error("Failed to load rankings for OG image:", error);
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          background: "linear-gradient(135deg, #06060c 0%, #0f172a 50%, #06060c 100%)",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
          fontFamily: "sans-serif",
        }}
      >
        {/* 배경 글로우 장식 */}
        <div style={{ position: "absolute", top: "-180px", left: "-80px", width: "600px", height: "600px", background: "radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 70%)", borderRadius: "50%" }} />
        <div style={{ position: "absolute", bottom: "-150px", right: "-50px", width: "500px", height: "500px", background: "radial-gradient(circle, rgba(245,158,11,0.1) 0%, transparent 70%)", borderRadius: "50%" }} />
        <div style={{ position: "absolute", top: "50px", right: "200px", width: "300px", height: "300px", background: "radial-gradient(circle, rgba(14,165,233,0.08) 0%, transparent 70%)", borderRadius: "50%" }} />

        {/* 상단 헤더 바 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "36px 60px 0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#f59e0b" }}>BGMS</div>
            <div style={{ fontSize: "14px", color: "#6b7280", fontWeight: "800", paddingLeft: "16px", borderLeft: "1px solid #334155", letterSpacing: "2px" }}>
              주간 랭킹 리포트
            </div>
          </div>
          <div style={{ fontSize: "13px", color: "#475569", fontWeight: "700", letterSpacing: "1px" }}>bgms.kr</div>
        </div>

        {/* 메인 콘텐츠 영역 */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            padding: "20px 60px 0",
            gap: "50px",
          }}
        >
          {/* 왼쪽: 타이틀 및 브랜딩 */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "22px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                alignSelf: "flex-start",
                background: "rgba(99, 102, 241, 0.15)",
                border: "1px solid rgba(99, 102, 241, 0.3)",
                borderRadius: "10px",
                padding: "8px 18px",
              }}
            >
              <span style={{ fontSize: "12px", color: "#818cf8", fontWeight: "900", letterSpacing: "3px" }}>
                WEEKLY TOP PLAYERS
              </span>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "56px",
                  fontWeight: "900",
                  color: "#ffffff",
                  letterSpacing: "-3px",
                  lineHeight: "1.1",
                }}
              >
                금주의 명예의 전당
              </div>
              <div
                style={{
                  fontSize: "16px",
                  color: "#94a3b8",
                  fontWeight: "500",
                  lineHeight: "1.5",
                  marginTop: "4px",
                }}
              >
                아시아 서버 분석 데이터 기준 분야별 최고 기록을 달성한 플레이어 순위입니다.
              </div>
            </div>

            {/* 기능 배지 그룹 */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "8px" }}>
              {[
                { label: "실시간 반영", bg: "rgba(255, 255, 255, 0.05)", border: "rgba(255, 255, 255, 0.1)", color: "#94a3b8" },
                { label: "딜량/킬/티어", bg: "rgba(242, 169, 0, 0.08)", border: "rgba(242, 169, 0, 0.25)", color: "#F2A900" },
                { label: "Top 30 집계", bg: "rgba(14, 165, 233, 0.08)", border: "rgba(14, 165, 233, 0.25)", color: "#0ea5e9" },
              ].map((b) => (
                <div
                  key={b.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    background: b.bg,
                    border: `1px solid ${b.border}`,
                    borderRadius: "18px",
                    padding: "6px 14px",
                  }}
                >
                  <span style={{ fontSize: "12px", color: b.color, fontWeight: "800" }}>{b.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 세로 구분선 */}
          <div style={{ width: "1px", height: "300px", background: "linear-gradient(180deg, transparent, #334155 30%, #334155 70%, transparent)" }} />

          {/* 오른쪽: 1등 플레이어 부문별 요약 카드 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: "420px" }}>
            <div style={{ fontSize: "11px", color: "#64748b", fontWeight: "800", letterSpacing: "3px", marginBottom: "2px", textTransform: "uppercase" }}>
              Category No.1 Leaders
            </div>

            {/* 1. 딜량 부문 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "rgba(239, 68, 68, 0.05)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                borderRadius: "14px",
                padding: "14px 20px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "12px", color: "#f87171", fontWeight: "800", letterSpacing: "1px" }}>최고 딜량 1위</span>
                <span style={{ fontSize: "16px", color: "#ffffff", fontWeight: "700" }}>{topDamagePlayer}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                <span style={{ fontSize: "22px", color: "#ef4444", fontWeight: "900" }}>
                  {topDamageValue > 0 ? `${topDamageValue.toLocaleString()}딜` : "—"}
                </span>
                {topDamageMode && <span style={{ fontSize: "10px", color: "#451c1c", background: "rgba(239, 68, 68, 0.2)", borderRadius: "4px", padding: "1px 4px", marginTop: "2px" }}>{topDamageMode}</span>}
              </div>
            </div>

            {/* 2. 킬 부문 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "rgba(234, 179, 8, 0.05)",
                border: "1px solid rgba(234, 179, 8, 0.25)",
                borderRadius: "14px",
                padding: "14px 20px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "12px", color: "#facc15", fontWeight: "800", letterSpacing: "1px" }}>최고 킬 1위</span>
                <span style={{ fontSize: "16px", color: "#ffffff", fontWeight: "700" }}>{topKillsPlayer}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                <span style={{ fontSize: "22px", color: "#eab308", fontWeight: "900" }}>
                  {topKillsValue > 0 ? `${topKillsValue}킬` : "—"}
                </span>
                {topKillsMode && <span style={{ fontSize: "10px", color: "#423207", background: "rgba(234, 179, 8, 0.2)", borderRadius: "4px", padding: "1px 4px", marginTop: "2px" }}>{topKillsMode}</span>}
              </div>
            </div>

            {/* 3. 티어 점수 부문 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "rgba(99, 102, 241, 0.05)",
                border: "1px solid rgba(99, 102, 241, 0.25)",
                borderRadius: "14px",
                padding: "14px 20px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "12px", color: "#818cf8", fontWeight: "800", letterSpacing: "1px" }}>BGMS 티어 1위</span>
                <span style={{ fontSize: "16px", color: "#ffffff", fontWeight: "700" }}>{topTierPlayer}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                  <span style={{ fontSize: "22px", color: "#6366f1", fontWeight: "900" }}>
                    {topTierValue > 0 ? `${topTierValue}점` : "—"}
                  </span>
                </div>
                <span style={{
                  display: "flex",
                  fontSize: "15px",
                  fontWeight: "900",
                  color: "#ffffff",
                  background: "#6366f1",
                  border: "1px solid #4f46e5",
                  borderRadius: "8px",
                  padding: "4px 10px",
                }}>
                  {topTierGrade}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 하단 푸터 바 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 60px 30px" }}>
          <div style={{ fontSize: "11px", color: "#334155", fontWeight: "700", letterSpacing: "3px" }}>
            BGMS · BATTLEGROUNDS GAMING MAP SERVICE · bgms.kr
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
