// app/api/og/squad/route.tsx
// 스쿼드 AI 분석 OG 이미지 — Satori 완전 호환 버전

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { getSquadAnalysisData } from "@/lib/pubg-analysis/squadAnalysis";
import { SQUAD_GRADE_MIN_AXES } from "@/lib/pubg-analysis/squadScore";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";

export const runtime = "nodejs";

const PRETENDARD_REGULAR_URL =
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/web/static/woff/Pretendard-Regular.woff";
const PRETENDARD_BOLD_URL =
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/web/static/woff/Pretendard-Bold.woff";

async function loadOgFont(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch OG font: ${response.status}`);
  return response.arrayBuffer();
}

const SCORE_KEYS = ["survivalCare", "backupSpeed", "smokeRescue", "damageBalance", "placement"] as const;
type ScoreKey = (typeof SCORE_KEYS)[number];

function finiteScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const nickname = searchParams.get("nickname") || "Player";
  const platform = searchParams.get("platform") || "steam";
  const groupKey = searchParams.get("groupKey") || "";

  let squadGrade: string | null = null;
  let matchCount = 0;
  let recordedTotal = 0;
  let measuredAxes = 0;
  let totalAxes: number = SCORE_KEYS.length;
  let membersCount = 4;
  let tradeLatencyMs: number | null = null;
  let revives: number | null = null;
  let knocks: number | null = null;
  let scores: Record<ScoreKey, number | null> = {
    survivalCare: null,
    backupSpeed: null,
    smokeRescue: null,
    damageBalance: null,
    placement: null,
  };
  let hasData = false;

  // 실시간 스쿼드 분석 데이터 조회 (Self-Fetch 우회 로컬 쿼리 실행)
  if (nickname && groupKey) {
    try {
      const privateResponse = await blockPrivatePlayer(platform, nickname, undefined, { lookupUpstream: true });
      if (privateResponse) return privateResponse;
      const data = await getSquadAnalysisData(nickname, platform, groupKey);
      if (data && !("error" in data) && !("message" in data)) {
        // 등급은 서버가 측정된 항목으로 계산한 값만 쓴다. 항목이 모자라면 준비 중 상태로 둔다.
        const candidateGrade = typeof data.squadGrade === "string" ? data.squadGrade.trim() : "";
        const basis = data.gradeBasis;
        if (/^[SABCD][+-]?$/.test(candidateGrade) && basis && basis.measuredAxes >= SQUAD_GRADE_MIN_AXES) {
          squadGrade = candidateGrade;
          measuredAxes = basis.measuredAxes;
          totalAxes = basis.totalAxes;
          matchCount = data.matchCount || 0;
          recordedTotal = data.recordedSummary?.total ?? 0;
          scores = Object.fromEntries(SCORE_KEYS.map((key) => [key, finiteScore(data.scores?.[key])])) as Record<ScoreKey, number | null>;
          tradeLatencyMs = typeof data.stats?.avgTradeLatency === "number" ? data.stats.avgTradeLatency : null;
          revives = typeof data.stats?.totalRevives === "number" ? data.stats.totalRevives : null;
          knocks = typeof data.stats?.totalTeammateKnocks === "number" ? data.stats.totalTeammateKnocks : null;
          if (data.roleProfiles) {
            membersCount = data.roleProfiles.length;
          }
          hasData = true;
        }
      }
    } catch (err) {
      console.error("[OG-SQUAD-FETCH-ERROR]", err);
    }
  }

  // 등급 메달의 색상 테마 설정
  const getGradeStyle = (grade: string | null) => {
    const g = grade?.toUpperCase().trim() || "";
    if (g.startsWith("S")) return { border: "#f59e0b", color: "#fbbf24", bg: "rgba(245, 158, 11, 0.15)" };
    if (g.startsWith("A")) return { border: "#a855f7", color: "#c084fc", bg: "rgba(168, 85, 247, 0.15)" };
    if (g.startsWith("B")) return { border: "#10b981", color: "#34d399", bg: "rgba(16, 185, 129, 0.15)" };
    if (g.startsWith("C")) return { border: "#3b82f6", color: "#60a5fa", bg: "rgba(59, 130, 246, 0.15)" };
    return { border: "#6b7280", color: "#9ca3af", bg: "rgba(107, 114, 128, 0.15)" };
  };

  const gradeStyle = getGradeStyle(squadGrade);
  const decodedNickname = decodeURIComponent(nickname);

  // 폰트 바이너리 로드 완료 대기
  let regularFontBuffer: ArrayBuffer;
  let boldFontBuffer: ArrayBuffer;
  try {
    [regularFontBuffer, boldFontBuffer] = await Promise.all([
      loadOgFont(PRETENDARD_REGULAR_URL),
      loadOgFont(PRETENDARD_BOLD_URL)
    ]);
  } catch (fontErr) {
    console.error("[OG-SQUAD-FONT-ERROR] Font loading failed, using fallback.", fontErr);
    regularFontBuffer = new ArrayBuffer(0);
    boldFontBuffer = new ArrayBuffer(0);
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          background: "linear-gradient(135deg, #0a0817, #06050b)",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
          fontFamily: "Pretendard, sans-serif",
        }}
      >
        {/* 네온 글로우 배경 (Satori 호환을 위해 radial-gradient 대신 rgba 단색 원형 레이어 사용) */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            top: "-150px",
            left: "-80px",
            width: "600px",
            height: "600px",
            background: "rgba(168, 85, 247, 0.08)",
            borderRadius: "50%",
          }}
        />
        <div
          style={{
            display: "flex",
            position: "absolute",
            bottom: "-100px",
            right: "-50px",
            width: "500px",
            height: "500px",
            background: "rgba(59, 130, 246, 0.06)",
            borderRadius: "50%",
          }}
        />

        {/* 상단 헤더 브랜드 바 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "36px 60px 0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div style={{ display: "flex", fontSize: "28px", fontWeight: "900", color: "#f59e0b" }}>BGMS</div>
            <div
              style={{
                display: "flex",
                fontSize: "14px",
                color: "#a855f7",
                fontWeight: "800",
                paddingLeft: "14px",
                borderLeft: "1px solid #374151",
                letterSpacing: "2px",
              }}
            >
              AI SQUAD REPORT
            </div>
          </div>
          <div style={{ display: "flex", fontSize: "14px", color: "#4b5563", fontWeight: "700", letterSpacing: "1px" }}>bgms.kr</div>
        </div>

        {/* 메인 내용 영역 */}
        <div
          style={{
            display: "flex",
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: "0%",
            alignItems: "center",
            padding: "20px 60px 0",
            gap: "50px",
          }}
        >
          {/* 왼쪽 컬럼: 등급 및 파티 기본 정보 */}
          <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: "0%", gap: "22px" }}>
            {/* 플랫폼 배지 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                alignSelf: "flex-start",
                background: "rgba(168, 85, 247, 0.08)",
                border: "1px solid rgba(168, 85, 247, 0.25)",
                borderRadius: "10px",
                padding: "6px 16px",
              }}
            >
              <span style={{ fontSize: "13px", color: "#c084fc", fontWeight: "800", letterSpacing: "2.5px" }}>
                {platform.toUpperCase()} · SQUAD
              </span>
            </div>

            {/* 유저 닉네임 */}
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <div
                style={{
                  display: "flex",
                  fontSize:
                    decodedNickname.length > 18 ? "42px" :
                    decodedNickname.length > 12 ? "52px" : "64px",
                  fontWeight: "900",
                  color: "#ffffff",
                  letterSpacing: "-2px",
                  lineHeight: "1.1",
                  maxWidth: "520px",
                }}
              >
                {decodedNickname}
              </div>
              <div style={{ display: "flex", fontSize: "18px", color: "#9ca3af", fontWeight: "700", marginTop: "4px" }}>
                님의 {membersCount}인 고정 파티 스쿼드 리포트
              </div>
              <div style={{ display: hasData ? "flex" : "none", fontSize: "13px", color: "#6b7280", fontWeight: "600", marginTop: "2px" }}>
                {recordedTotal > matchCount ? `최근 14일 ${recordedTotal}경기 중 상세 분석 가능한 ${matchCount}경기 기준` : `최근 14일 상세 분석 가능한 ${matchCount}경기 기준`}
              </div>
            </div>

            {/* 등급 메달 배지. 측정 항목이 부족하면 가짜 등급을 그리지 않고
                준비 중 상태를 보여준다. */}
            {hasData ? (
              <div style={{ display: "flex", alignItems: "center", gap: "20px", marginTop: "10px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "140px",
                    height: "140px",
                    borderRadius: "50%",
                    border: `6px solid ${gradeStyle.border}`,
                    background: gradeStyle.bg,
                  }}
                >
                  <span
                    style={{
                      fontSize: "72px",
                      fontWeight: "900",
                      color: gradeStyle.color,
                      lineHeight: "1",
                    }}
                  >
                    {squadGrade}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <span style={{ fontSize: "12px", color: "#6b7280", fontWeight: "800", letterSpacing: "2px" }}>COOPERATIVE GRADE</span>
                  <span style={{ fontSize: "20px", color: "#e4e4e7", fontWeight: "800" }}>협동 시너지 분석 등급</span>
                  <span style={{ fontSize: "13px", color: "#a1a1aa", fontWeight: "500", maxWidth: "280px", lineHeight: "1.4" }}>
                    소생·백업·연막·딜 균형·순위 성과를 고정 기준 점수로 평가한 협동 등급입니다. 측정 {measuredAxes}/{totalAxes} 항목 기준이며 다른 팀과의 순위가 아닙니다.
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
                <span style={{ fontSize: "24px", color: "#e4e4e7", fontWeight: "800" }}>분석 데이터 준비 중</span>
                <span style={{ fontSize: "14px", color: "#a1a1aa", fontWeight: "500" }}>상세 분석된 경기나 측정 항목이 아직 부족합니다. 전적 탭에서 경기를 펼쳐 분석을 쌓아 주세요.</span>
              </div>
            )}
          </div>

          {/* 세로 구분선 */}
          <div
            style={{
              display: "flex",
              width: "1px",
              height: "320px",
              background: "linear-gradient(180deg, transparent, rgba(55, 65, 81, 0.4) 30%, rgba(55, 65, 81, 0.4) 70%, transparent)",
            }}
          />

          {/* 오른쪽 컬럼: 5대 협동 지표 점수 시각화 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: "420px" }}>
            <div style={{ display: "flex", fontSize: "12px", color: "#6b7280", fontWeight: "800", letterSpacing: "3px", marginBottom: "4px" }}>
              TACTICAL COOPERATION SCORES
            </div>

            {/* 5가지 지표 그래프 목록 */}
            {[
              { label: "소생률 (Revive Rate)", score: scores.survivalCare, color: "#34d399", bg: "rgba(52, 211, 153, 0.15)" },
              { label: "백업 속도 (Backup Speed)", score: scores.backupSpeed, color: "#f43f5e", bg: "rgba(244, 63, 148, 0.15)" },
              { label: "연막 구출 (Smoke Rescue)", score: scores.smokeRescue, color: "#818cf8", bg: "rgba(99, 102, 241, 0.15)" },
              { label: "딜 균형 (Damage Balance)", score: scores.damageBalance, color: "#fbbf24", bg: "rgba(251, 191, 36, 0.15)" },
              { label: "순위 성과 (Placement)", score: scores.placement, color: "#c084fc", bg: "rgba(192, 132, 252, 0.15)" },
            ].map((metric) => (
              <div
                key={metric.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  background: "rgba(255, 255, 255, 0.02)",
                  border: "1px solid rgba(255, 255, 255, 0.05)",
                  borderRadius: "12px",
                  padding: "10px 16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "13px", color: "#d1d5db", fontWeight: "700" }}>{metric.label}</span>
                  <span style={{ fontSize: "15px", color: metric.color, fontWeight: "900" }}>{metric.score === null ? "미측정" : `${metric.score}점`}</span>
                </div>
                <div style={{ display: "flex", width: "100%", height: "8px", background: "rgba(255, 255, 255, 0.06)", borderRadius: "4px", overflow: "hidden" }}>
                  <div
                    style={{
                      display: "flex",
                      width: `${metric.score === null ? 0 : Math.max(0, Math.min(100, metric.score))}%`,
                      height: "100%",
                      background: metric.color,
                      borderRadius: "4px",
                    }}
                  />
                </div>
              </div>
            ))}

            {/* 대표 실데이터 추가 요약 */}
            <div style={{ display: hasData ? "flex" : "none", justifyContent: "space-between", marginTop: "6px", padding: "0 4px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "10px", color: "#6b7280", fontWeight: "800" }}>AVG TRADE LATENCY</span>
                <span style={{ display: "flex", fontSize: "14px", color: "#e4e4e7", fontWeight: "800" }}>
                  {tradeLatencyMs !== null && Number.isFinite(tradeLatencyMs) && tradeLatencyMs >= 0 ? `${(tradeLatencyMs / 1000).toFixed(2)}초` : "측정 불가"}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", alignItems: "flex-end" }}>
                <span style={{ fontSize: "10px", color: "#6b7280", fontWeight: "800" }}>REVIVES / KNOCKS</span>
                <span style={{ display: "flex", fontSize: "14px", color: "#e4e4e7", fontWeight: "800" }}>
                  {revives !== null && knocks !== null ? `${revives}회 / ${knocks}회` : "측정 불가"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 하단 브랜드 문구 바 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px 60px 30px",
          }}
        >
          <div style={{ display: "flex", fontSize: "11px", color: "#374151", fontWeight: "700", letterSpacing: "3px" }}>
            BGMS · BATTLEGROUNDS GAMING MAP SERVICE · bgms.kr
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        ...(regularFontBuffer && regularFontBuffer.byteLength > 0
          ? [
              {
                name: "Pretendard",
                data: regularFontBuffer,
                style: "normal" as const,
                weight: 400 as const,
              },
            ]
          : []),
        ...(boldFontBuffer && boldFontBuffer.byteLength > 0
          ? [
              {
                name: "Pretendard",
                data: boldFontBuffer,
                style: "normal" as const,
                weight: 700 as const,
              },
            ]
          : []),
      ],
    }
  );
}
