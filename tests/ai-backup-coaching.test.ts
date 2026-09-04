import { describe, expect, it } from "vitest";
import {
  buildBackupCoachingContext,
  parseBackupLatencySeconds,
  sanitizeBackupCoachingText,
} from "../lib/pubg-analysis/backupCoaching";
import {
  collectAiCoachingQualitySignals,
  hasBlockingAiCoachingQualityIssue,
  sanitizeAiCoachingLanguage,
  sanitizeAiCoachingLanguageText,
} from "../lib/pubg-analysis/aiCoachingQuality";
import { buildMatchAiCoachingPrompt } from "../lib/pubg-analysis/matchAiCoachingPrompt";
import { buildSquadAiCoachingPrompt } from "../lib/pubg-analysis/squadAiCoachingPrompt";

describe("AI backup coaching context", () => {
  it("22초 백업이어도 적 제압과 소생이 성공했으면 느린 백업으로 단정하지 않는다", () => {
    const context = buildBackupCoachingContext({
      avgBackupLatency: "22.00s",
      totalTradeKills: 2,
      totalRevCount: 1,
      totalSmokeRescues: 0,
      totalTeamWipes: 1,
      totalTeammateKnocks: 1,
      benchmarkTradeLatency: 12,
    });

    expect(context.label).toBe("교전 정리 후 복구 성공");
    expect(context.latencySeconds).toBe(22);
    expect(context.shouldAvoidSlowBackupBlame).toBe(true);
    expect(context.tier).toBe("B");
    expect(context.promptLine).toContain("느린 백업이라고 단정하지 말 것");
    expect(context.promptLine).toContain("교전 정리 후 복구 성공");
  });

  it("성공 결과가 없는 22초 백업은 지연 위험으로 평가한다", () => {
    const context = buildBackupCoachingContext({
      avgBackupLatency: "22.00s",
      totalTradeKills: 0,
      totalRevCount: 0,
      totalSmokeRescues: 0,
      totalTeamWipes: 0,
      totalTeammateKnocks: 1,
      benchmarkTradeLatency: 12,
    });

    expect(context.label).toBe("백업 지연 위험");
    expect(context.latencySeconds).toBe(22);
    expect(context.shouldAvoidSlowBackupBlame).toBe(false);
    expect(context.tier).toBe("C");
  });

  it("백업 샘플이 없으면 추론 금지 문구를 반환한다", () => {
    const context = buildBackupCoachingContext({ avgBackupLatency: "측정 불가" });

    expect(context.measured).toBe(false);
    expect(context.latencySeconds).toBeNull();
    expect(context.shouldAvoidSlowBackupBlame).toBe(true);
    expect(context.promptLine).toContain("추론하지 말 것");
  });

  it("초 단위 문자열에서 숫자만 안정적으로 파싱한다", () => {
    expect(parseBackupLatencySeconds("9.50s")).toBe(9.5);
    expect(parseBackupLatencySeconds("측정 불가")).toBeNull();
  });

  it("성공 복구 맥락에서 AI가 생성한 백업 비난 표현을 보정한다", () => {
    const context = buildBackupCoachingContext({
      avgBackupLatency: "22.4s",
      totalTradeKills: 2,
      totalRevCount: 1,
      totalTeamWipes: 1,
      totalTeammateKnocks: 1,
      benchmarkTradeLatency: 12,
    });
    const text = [
      "22.4초의 백업 속도는 교전 정리 후 복구 성공이라기엔 너무나 느린 방관입니다.",
      "백업 효율 개선",
      "교전 종료 후 소생에 22.4초를 소비하는 것은 치명적이며, 상황 판단 속도를 높이십시오.",
    ].join("\n");

    const sanitized = sanitizeBackupCoachingText(text, context);

    expect(sanitized).toContain("성공 복구");
    expect(sanitized).toContain("복구 시간 단축");
    expect(sanitized).not.toContain("방관");
    expect(sanitized).not.toContain("느린 백업");
    expect(sanitized).not.toContain("치명적");
  });
});

describe("AI coaching prompt utility metrics", () => {
  it("단일 경기 프롬프트는 연막을 제외하고 피해형 투척 적중률을 재계산한다", () => {
    const { playerReportSummary } = buildMatchAiCoachingPrompt({
      coachingStyle: "spicy",
      matchData: {
        mapName: "Erangel_Main",
        gameMode: "squad",
        stats: {
          winPlace: 1,
          kills: 3,
          assists: 1,
          DBNOs: 2,
          damageDealt: 410,
          processedDamageDealt: 410,
          timeSurvived: 1600,
        },
        combatPressure: {
          utilityDamage: 90,
          utilityStats: {
            throwCount: 12,
            lethalThrowCount: 3,
            hitCount: 1,
            totalDamage: 90,
            accuracy: 8.3,
            avgDamagePerThrow: 7.5,
          },
        },
        itemUseSummary: { frags: 2, molotovs: 1, smokes: 9 },
        tradeStats: {},
        teamImpact: {},
      },
    });

    expect(playerReportSummary).toContain("총 투척 12회 / 피해형 투척 3회 / 피해 적중 1회 / 피해형 투척 적중률 33.3%");
    expect(playerReportSummary).toContain("피해형 투척당 평균 딜 30");
    expect(playerReportSummary).not.toContain("피해형 투척 적중률 8.3%");
  });

  it("단일 경기 프롬프트는 다중 피해 이벤트로 적중률이 100%를 넘지 않게 보정한다", () => {
    const { playerReportSummary } = buildMatchAiCoachingPrompt({
      coachingStyle: "spicy",
      matchData: {
        mapName: "Erangel_Main",
        gameMode: "squad",
        stats: {
          winPlace: 1,
          kills: 7,
          assists: 0,
          DBNOs: 5,
          damageDealt: 812,
          processedDamageDealt: 812,
          timeSurvived: 1840,
        },
        combatPressure: {
          utilityDamage: 213,
          utilityStats: {
            throwCount: 13,
            lethalThrowCount: 6,
            hitCount: 10,
            totalDamage: 213,
            accuracy: 166.7,
            avgDamagePerThrow: 35.5,
          },
        },
        itemUseSummary: { frags: 4, molotovs: 2, smokes: 6 },
        tradeStats: {},
        teamImpact: {},
      },
    });

    expect(playerReportSummary).toContain("총 투척 13회 / 피해형 투척 6회 / 피해 적중 6회 / 피해형 투척 적중률 100%");
    expect(playerReportSummary).not.toContain("166.7%");
  });

  it("피해형 투척이 0회면 연막 활용과 적중률 평가를 분리해 설명한다", () => {
    const { playerReportSummary } = buildMatchAiCoachingPrompt({
      coachingStyle: "spicy",
      matchData: {
        mapName: "Erangel_Main",
        gameMode: "squad",
        stats: {
          winPlace: 9,
          kills: 1,
          assists: 0,
          DBNOs: 1,
          damageDealt: 180,
          processedDamageDealt: 180,
          timeSurvived: 920,
        },
        combatPressure: {
          utilityDamage: 0,
          utilityStats: {
            throwCount: 5,
            lethalThrowCount: 0,
            hitCount: 0,
            totalDamage: 0,
            accuracy: 0,
            avgDamagePerThrow: 0,
          },
        },
        itemUseSummary: { frags: 0, molotovs: 0, smokes: 5 },
        tradeStats: {},
        teamImpact: {},
      },
    });

    expect(playerReportSummary).toContain("피해형 투척 0회 / 피해 적중 0회 / 피해형 투척 적중률 측정 불가");
    expect(playerReportSummary).toContain("피해형 투척 0회이므로 적중률/폭파 칭호를 만들지 말고");
    expect(playerReportSummary).toContain("총 투척 5회는 연막 또는 비피해 투척 활용으로만 해석");
  });

  it("단일 경기 프롬프트는 낮은 고립과 높은 딜량 비중을 의도 단정으로 오판하지 않도록 지시한다", () => {
    const { fullPrompt } = buildMatchAiCoachingPrompt({
      coachingStyle: "spicy",
      matchData: {
        mapName: "Erangel_Main",
        gameMode: "squad",
        stats: {
          winPlace: 1,
          kills: 6,
          assists: 1,
          DBNOs: 4,
          damageDealt: 780,
          processedDamageDealt: 780,
          timeSurvived: 1842,
        },
        isolationData: { isolationIndex: 1.2, minDist: 18, heightDiff: 4, isCrossfire: false },
        teamImpact: { teamDamageShare: 84, teamKillShare: 75 },
        combatPressure: { utilityStats: { throwCount: 18, lethalThrowCount: 18, hitCount: 3, totalDamage: 95 } },
        tradeStats: { teammateKnocks: 1, tradeKills: 2, revCount: 1, tradeLatencyMs: 22400, enemyTeamWipes: 1 },
      },
    });

    expect(fullPrompt).toContain("의도, 인성, 팀원 이용 여부를 단정하는 표현을 금지");
    expect(fullPrompt).toContain("고립 지수가 2.0 미만이면 양호한 대열 유지");
    expect(fullPrompt).toContain("출력 전 자체 검수");
    expect(fullPrompt).toContain("강한 화력을 보여주지만 협업 지표 보완이 필요");
    expect(fullPrompt).toContain("'팀원을 방패'");
    expect(fullPrompt).toContain("'팀원을 들러리'");
    expect(fullPrompt).toContain("'혼자 다 해먹'");
  });

  it("스쿼드 프롬프트는 금지 표현을 예시로 권장하지 않고 안전한 대체 표현을 제시한다", () => {
    const { systemInstruction } = buildSquadAiCoachingPrompt({
      groupKey: "Alpha,Beta,Gamma",
      nickname: "KangHeeSung_",
      coachingStyle: "spicy",
      squadGrade: "A",
      matchCount: 6,
      stats: {
        avgIsolation: 1.4,
        avgTradeLatency: 8200,
        avgCoverRate: 0.62,
        totalSmokeRescues: 4,
        totalRevives: 5,
        totalTeamWipes: 3,
      },
      scores: { formation: 82, backupSpeed: 78, survivalCare: 84, focusFire: 76, teamWipe: 80 },
      roleProfiles: [
        { name: "KangHeeSung_", role: "Entry", roleDesc: "진입 화력", avgDamage: 410, avgKills: 3.2, avgAssists: 1.1, avgDbnos: 3.5, shares: { damage: 44, kill: 48, assist: 22, dbno: 46 } },
        { name: "Alpha", role: "Support", roleDesc: "백업", avgDamage: 260, avgKills: 1.4, avgAssists: 2.8, avgDbnos: 1.8, shares: { damage: 28, kill: 21, assist: 42, dbno: 24 } },
      ],
    });

    expect(systemInstruction).toContain("Current Average Isolation Index is 1.4");
    expect(systemInstruction).toContain("treat formation as good");
    expect(systemInstruction).toContain("대열 이탈이 커서 동시 교전 합이 흔들립니다.");
    expect(systemInstruction).not.toContain("혼자 정글북 찍으며 각개전투함");
    expect(systemInstruction).not.toContain("4인 스쿼드를 하는 게 아니라 1인 솔로 4개를 돌리는 오합지졸 상태입니다.");
  });

  it("공통 품질 신호는 코칭 차단 이슈를 판정한다", () => {
    const goodSignals = collectAiCoachingQualitySignals("교전 정리 후 복구 성공이며 복구 시간 단축이 과제입니다.");
    const badSignals = collectAiCoachingQualitySignals("22.4초는 느린 백업이며 팀원을 방패로 세운 방관입니다.");
    const dismissalSignals = collectAiCoachingQualitySignals("혼자 다 해먹는 화력이고 나머지 팀원들의 화력 지원이 전무합니다.");
    const summaryIntentSignals = collectAiCoachingQualitySignals("팀원들의 지원이 부족하다는 방증이며, 혼자서 모든 것을 해결하려는 부담이 큽니다.");
    const isolationSignals = collectAiCoachingQualitySignals("고립 지수 1.2의 위험한 독단 플레이입니다.");

    expect(hasBlockingAiCoachingQualityIssue(goodSignals)).toBe(false);
    expect(hasBlockingAiCoachingQualityIssue(badSignals)).toBe(true);
    expect(badSignals.hasUnsupportedBackupBlame).toBe(true);
    expect(badSignals.hasUnsupportedTeamIntent).toBe(true);
    expect(hasBlockingAiCoachingQualityIssue(dismissalSignals)).toBe(true);
    expect(dismissalSignals.hasUnsupportedTeamDismissal).toBe(true);
    expect(hasBlockingAiCoachingQualityIssue(summaryIntentSignals)).toBe(true);
    expect(summaryIntentSignals.hasUnsupportedTeamIntent).toBe(true);
    expect(hasBlockingAiCoachingQualityIssue(isolationSignals)).toBe(true);
    expect(isolationSignals.hasLowIsolationMisread).toBe(true);
  });

  it("일반 AI 코칭 순화기는 과한 팀 비난 표현을 안전한 피드백으로 바꾼다", () => {
    const sanitized = sanitizeAiCoachingLanguageText("혼자 다 해먹는 화력이고 팀 지원 지표가 바닥이며 고립 지수 1.2의 위험한 독단 플레이입니다.");

    expect(sanitized).toContain("강한 화력을 보여주는");
    expect(sanitized).toContain("팀 지원 지표 보완이 필요");
    expect(sanitized).toContain("팀 보조가 필요한 전진 플레이");
    expect(collectAiCoachingQualitySignals(sanitized).hasUnsupportedTeamIntent).toBe(false);
    expect(collectAiCoachingQualitySignals(sanitized).hasUnsupportedTeamDismissal).toBe(false);
    expect(collectAiCoachingQualitySignals(sanitized).hasLowIsolationMisread).toBe(false);
  });

  it("일반 AI 코칭 순화기는 요약 토론의 팀 의도 단정 표현도 안전하게 바꾼다", () => {
    const sanitized = sanitizeAiCoachingLanguageText("팀 딜량 비중 58%는 팀원들의 지원이 부족하다는 방증이며, 혼자서 모든 것을 해결하려는 부담이 큽니다.");
    const signals = collectAiCoachingQualitySignals(sanitized);

    expect(sanitized).toContain("화력 비중이 높아 교전 주도는 선명하지만");
    expect(sanitized).toContain("화력 분담을 더 고르게 만들 필요");
    expect(signals.hasUnsupportedTeamIntent).toBe(false);
    expect(hasBlockingAiCoachingQualityIssue(signals)).toBe(false);
  });

  it("일반 AI 코칭 순화기는 백업 비난 표현을 지연 위험 표현으로 바꾼다", () => {
    const sanitized = sanitizeAiCoachingLanguageText("22.4초는 느린 백업이며 교전 정리 후 복구 성공이라기엔 방관입니다.");
    const signals = collectAiCoachingQualitySignals(sanitized);

    expect(sanitized).toContain("백업 지연 위험");
    expect(sanitized).toContain("성공 복구였지만");
    expect(sanitized).toContain("후속 복구 부족");
    expect(signals.hasUnsupportedBackupBlame).toBe(false);
    expect(hasBlockingAiCoachingQualityIssue(signals)).toBe(false);
  });

  it("객체 형태의 스쿼드 코칭 결과도 재귀적으로 순화한다", () => {
    const sanitized = sanitizeAiCoachingLanguage({
      weakness: "나머지 팀원들의 화력 지원이 전무합니다.",
      memberFeedbacks: [
        { fault: "존재감이 희미합니다." },
      ],
    });
    const text = JSON.stringify(sanitized);

    expect(text).toContain("다른 팀원들의 화력 지원 보완이 필요");
    expect(text).toContain("교전 기여를 더 선명하게 만들 필요가 있습니다");
    expect(hasBlockingAiCoachingQualityIssue(collectAiCoachingQualitySignals(text))).toBe(false);
  });
});
