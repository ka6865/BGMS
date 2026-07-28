// app/stats/[platform]/[nickname]/opengraph-image.tsx
// Next.js 16 내장 ImageResponse를 사용한 동적 OG 이미지 생성
// 배포 환경에서 실제 플레이어 전적 데이터를 조회하여 스탯 패널에 표시합니다.

import { ImageResponse } from "next/og";

export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

interface Props {
  params: Promise<{ platform: string; nickname: string }>;
}

const PLATFORM_LABEL: Record<string, string> = {
  steam: "Steam",
  kakao: "Kakao",
  psn: "PlayStation",
  xbox: "Xbox",
};

interface StatRow {
  label: string;
  value: string;
  color: string;
  border: string;
  bg: string;
}

export default async function OgImage({ params }: Props) {
  const { platform, nickname } = await params;
  const decodedNickname = decodeURIComponent(nickname);
  const platformLabel = PLATFORM_LABEL[platform] || platform;

  // 실제 플레이어 스탯 조회 (배포 환경에서 동작)
  let avgDamage = 0;
  let kda = 0;
  let avgSurvival = 0;
  let winRate = 0;
  let hasStats = false;
  let modeLabel = ""; // 선택된 게임 모드 레이블

  try {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://bgms.kr";
    const res = await fetch(
      `${baseUrl}/api/pubg/player?nickname=${encodeURIComponent(decodedNickname)}&platform=${platform}`,
      {
        next: { revalidate: 3600 }, // 1시간 캐시
        signal: AbortSignal.timeout(5000), // 5초 타임아웃
      }
    );

    if (res.ok) {
      const data = await res.json();

      // 6개 모드 중 roundsPlayed 가장 많은 모드를 자동 선택
      const candidates: { s: any; label: string }[] = [
        { s: data.stats?.ranked?.squad, label: "랭크 스쿼드" },
        { s: data.stats?.ranked?.duo,   label: "랭크 듀오" },
        { s: data.stats?.ranked?.solo,  label: "랭크 솔로" },
        { s: data.stats?.normal?.squad, label: "일반 스쿼드" },
        { s: data.stats?.normal?.duo,   label: "일반 듀오" },
        { s: data.stats?.normal?.solo,  label: "일반 솔로" },
      ].filter((c) => c.s?.roundsPlayed > 0);

      const best = candidates.reduce<{ s: any; label: string } | null>(
        (acc, cur) =>
          (cur.s?.roundsPlayed ?? 0) > (acc?.s?.roundsPlayed ?? 0) ? cur : acc,
        null
      );

      const s = best?.s ?? null;
      modeLabel = best?.label ?? "";

      if (s && s.roundsPlayed > 0) {
        const rounds = s.roundsPlayed;
        avgDamage = Math.round(s.damageDealt / rounds);

        // ranked: deaths 필드 / normal: losses 필드
        const deaths = Math.max(
          s.deaths ?? s.losses ?? (rounds - (s.wins ?? 0)),
          1
        );

        // PUBG ranked API의 kda 필드가 0을 반환하는 버그가 있어 직접 계산
        // (kills + assists×0.5) / deaths 공식 사용
        kda = parseFloat(
          ((s.kills + (s.assists || 0) * 0.5) / deaths).toFixed(2)
        );

        // TOP10률 — ranked: top10Ratio 직접 / normal: top10s / roundsPlayed
        const top10Rate = s.top10Ratio != null && s.top10Ratio > 0
          ? parseFloat((s.top10Ratio * 100).toFixed(1))
          : s.top10s != null
          ? parseFloat(((s.top10s / rounds) * 100).toFixed(1))
          : 0;

        winRate = parseFloat(((s.wins / rounds) * 100).toFixed(1));
        hasStats = true;

        avgSurvival = top10Rate;
      }
    }
  } catch {
    // 타임아웃 또는 오류 시 "—" 표시로 폴백
  }

  const statRows: StatRow[] = [
    {
      label: "평균 딜량",
      value: hasStats ? `${avgDamage.toLocaleString()} dmg` : "—",
      color: "#f87171",
      border: "#f8717140",
      bg: "#f8717110",
    },
    {
      label: "KDA",
      value: hasStats ? String(kda) : "—",
      color: "#60a5fa",
      border: "#60a5fa40",
      bg: "#60a5fa10",
    },
    {
      label: "TOP10률",
      value: hasStats && avgSurvival > 0 ? `${avgSurvival}%` : "—",
      color: "#34d399",
      border: "#34d39940",
      bg: "#34d39910",
    },
    {
      label: "승률",
      value: hasStats ? `${winRate}%` : "—",
      color: "#f59e0b",
      border: "#f59e0b40",
      bg: "#f59e0b10",
    },
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          background: "linear-gradient(135deg, #0a0a14 0%, #111827 50%, #0a0a14 100%)",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
          fontFamily: "sans-serif",
        }}
      >
        {/* 배경 글로우 */}
        <div style={{ position: "absolute", top: "-150px", left: "-80px", width: "550px", height: "550px", background: "radial-gradient(circle, #818cf820 0%, transparent 65%)", borderRadius: "50%" }} />
        <div style={{ position: "absolute", bottom: "-120px", right: "200px", width: "450px", height: "450px", background: "radial-gradient(circle, #f59e0b12 0%, transparent 65%)", borderRadius: "50%" }} />

        {/* 상단 브랜드 바 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "32px 52px 0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div style={{ fontSize: "28px", fontWeight: "900", color: "#f59e0b" }}>BGMS</div>
            <div style={{ fontSize: "13px", color: "#6b7280", fontWeight: "700", paddingLeft: "14px", borderLeft: "1px solid #374151", letterSpacing: "1px" }}>
              AI 전적 분석
            </div>
          </div>
          <div style={{ fontSize: "13px", color: "#4b5563", fontWeight: "700", letterSpacing: "1px" }}>bgms.kr</div>
        </div>

        {/* 메인 영역 */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            padding: "24px 52px 0",
            gap: "40px",
          }}
        >
          {/* 왼쪽: 닉네임 영역 */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "18px" }}>
            {/* 플랫폼 배지 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                alignSelf: "flex-start",
                background: "#1f2937",
                border: "1px solid #374151",
                borderRadius: "10px",
                padding: "7px 16px",
              }}
            >
              <span style={{ fontSize: "13px", color: "#9ca3af", fontWeight: "800", letterSpacing: "2px" }}>
                {platformLabel.toUpperCase()}
              </span>
            </div>

            {/* 닉네임 — 길이별 폰트 자동 조정 */}
            <div
              style={{
                fontSize:
                  decodedNickname.length > 20 ? "44px" :
                  decodedNickname.length > 16 ? "56px" :
                  decodedNickname.length > 10 ? "70px" : "80px",
                fontWeight: "900",
                color: "#ffffff",
                letterSpacing: "-2px",
                lineHeight: "1.0",
                maxWidth: "560px",
                overflow: "hidden",
              }}
            >
              {decodedNickname.length > 22
                ? decodedNickname.slice(0, 22) + "..."
                : decodedNickname}
            </div>

            {/* 기능 배지 3개 */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              {[
                { icon: "AI", label: "AI 전술 분석", bg: "#ffffff08", border: "#ffffff15", color: "#d1d5db" },
                { icon: "", label: "2D 리플레이", bg: "#f59e0b10", border: "#f59e0b30", color: "#f59e0b" },
                { icon: "", label: "티어 평가", bg: "#818cf810", border: "#818cf830", color: "#818cf8" },
              ].map((b) => (
                <div
                  key={b.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    background: b.bg,
                    border: `1px solid ${b.border}`,
                    borderRadius: "20px",
                    padding: "8px 16px",
                  }}
                >
                  <span style={{ fontSize: "14px" }}>{b.icon}</span>
                  <span style={{ fontSize: "14px", color: b.color, fontWeight: "700" }}>{b.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 구분선 */}
          <div style={{ width: "1px", height: "280px", background: "linear-gradient(180deg, transparent, #374151 30%, #374151 70%, transparent)" }} />

          {/* 오른쪽: 스탯 패널 — 폰트 크기 대폭 증가 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: "360px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "2px" }}>
              <div style={{ fontSize: "11px", color: "#4b5563", fontWeight: "800", letterSpacing: "3px" }}>
                AI 분석 지표
              </div>
              {modeLabel ? (
                <div style={{
                  display: "flex",
                  fontSize: "10px",
                  fontWeight: "900",
                  color: modeLabel.startsWith("랭크") ? "#818cf8" : "#9ca3af",
                  background: modeLabel.startsWith("랭크") ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.07)",
                  border: modeLabel.startsWith("랭크") ? "1px solid rgba(99,102,241,0.35)" : "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "6px",
                  padding: "2px 8px",
                  letterSpacing: "1px",
                }}>
                  {modeLabel}
                </div>
              ) : null}
            </div>
            {statRows.map((stat) => (
              <div
                key={stat.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: stat.bg,
                  border: `1px solid ${stat.border}`,
                  borderRadius: "14px",
                  padding: "16px 24px",
                }}
              >
                <span style={{ fontSize: "18px", color: "#9ca3af", fontWeight: "700" }}>{stat.label}</span>
                <span style={{ fontSize: stat.value === "—" ? "26px" : "28px", fontWeight: "900", color: stat.color }}>
                  {stat.value}
                </span>
              </div>
            ))}
            <div style={{ fontSize: "11px", color: "#374151", fontWeight: "600", marginTop: "2px", textAlign: "right" }}>
              bgms.kr에서 전체 분석 보기 →
            </div>
          </div>
        </div>

        {/* 하단 바 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 52px 26px" }}>
          <div style={{ fontSize: "11px", color: "#374151", fontWeight: "700", letterSpacing: "3px" }}>
            BGMS · BATTLEGROUNDS GAMING MAP SERVICE · bgms.kr
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
