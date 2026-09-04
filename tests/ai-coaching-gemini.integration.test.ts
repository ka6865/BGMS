import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory, SchemaType } from "@google/generative-ai";
import { buildMatchAiCoachingPrompt } from "../lib/pubg-analysis/matchAiCoachingPrompt";
import { sanitizeBackupCoachingText } from "../lib/pubg-analysis/backupCoaching";
import { buildSquadAiCoachingPrompt } from "../lib/pubg-analysis/squadAiCoachingPrompt";
import {
  collectAiCoachingQualitySignals,
  hasBlockingAiCoachingQualityIssue,
  sanitizeAiCoachingLanguageText,
} from "../lib/pubg-analysis/aiCoachingQuality";
import { getAiCoachingBlockingSignalNames } from "../lib/pubg-analysis/aiCoachingReportCheck";

config({ path: ".env.local" });

const shouldRun = process.env.RUN_REAL_GEMINI === "true";
const describeRealGemini = shouldRun ? describe : describe.skip;
const reportItems: Array<Record<string, unknown>> = [];

async function writeGeminiReport() {
  if (!shouldRun || reportItems.length === 0) return;
  const outputPath = path.join(process.cwd(), "tmp", "ai-coaching-gemini-report.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: process.env.GEMINI_COACHING_TEST_MODEL || "gemini-3.1-flash-lite",
    cases: reportItems,
  }, null, 2));
}

afterAll(async () => {
  await writeGeminiReport();
});

function extractJson(text: string) {
  const cleaned = text.trim().replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`Gemini 응답에서 JSON 객체를 찾지 못했습니다.\n${text}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function getApiKey() {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("RUN_REAL_GEMINI=true 실행에는 GOOGLE_GEMINI_API_KEY가 필요합니다.");
  }
  return apiKey;
}

async function callGeminiJson(prompt: string, systemInstruction?: string, responseSchema?: any) {
  const genAI = new GoogleGenerativeAI(getApiKey());
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_COACHING_TEST_MODEL || "gemini-3.1-flash-lite",
    systemInstruction,
    generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.45 },
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
  });

  const result = await model.generateContent(prompt);
  return result.response.text();
}

function recordCase(name: string, rawText: string, finalText: string, parsed: any, extra: Record<string, unknown> = {}) {
  const joinedFinal = JSON.stringify(parsed);
  const qualitySignals = collectAiCoachingQualitySignals(joinedFinal);
  const rawQualitySignals = collectAiCoachingQualitySignals(rawText);
  reportItems.push({
    name,
    rawText,
    finalText,
    parsed,
    qualitySignals,
    hasBlockingQualityIssue: hasBlockingAiCoachingQualityIssue(qualitySignals),
    blockingSignalNames: getAiCoachingBlockingSignalNames(qualitySignals),
    rawQualitySignals,
    hasRawBlockingQualityIssue: hasBlockingAiCoachingQualityIssue(rawQualitySignals),
    rawBlockingSignalNames: getAiCoachingBlockingSignalNames(rawQualitySignals),
    ...extra,
  });
  return qualitySignals;
}

function createMatchMetricContext(matchData: any, backupContext: any) {
  const utility = matchData.combatPressure?.utilityStats || {};
  const lethalThrows = Number(utility.lethalThrowCount || 0);
  const utilityHits = lethalThrows > 0 ? Math.min(Number(utility.hitCount || 0), lethalThrows) : 0;
  return {
    backup: {
      label: backupContext.label,
      latencySeconds: backupContext.latencySeconds,
      shouldAvoidSlowBackupBlame: backupContext.shouldAvoidSlowBackupBlame,
      tradeKills: matchData.tradeStats?.tradeKills || 0,
      revives: matchData.tradeStats?.revCount || 0,
      smokeRescues: matchData.tradeStats?.smokeRescues || 0,
      teamWipes: matchData.tradeStats?.enemyTeamWipes || 0,
      teammateKnocks: matchData.tradeStats?.teammateKnocks || 0,
    },
    utility: {
      totalThrows: utility.throwCount || 0,
      lethalThrows,
      hits: utilityHits,
      accuracy: lethalThrows > 0 ? Number(((utilityHits / lethalThrows) * 100).toFixed(1)) : 0,
      smokes: matchData.itemUseSummary?.smokes || 0,
    },
    isolation: {
      index: matchData.isolationData?.isolationIndex,
    },
    teamImpact: {
      damageShare: matchData.teamImpact?.teamDamageShare,
    },
  };
}

const squadResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    squadGrade: { type: SchemaType.STRING },
    summary: { type: SchemaType.STRING },
    strength: { type: SchemaType.STRING },
    weakness: { type: SchemaType.STRING },
    coaching: { type: SchemaType.STRING },
    memberFeedbacks: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          praise: { type: SchemaType.STRING },
          fault: { type: SchemaType.STRING },
          advice: { type: SchemaType.STRING },
        },
        required: ["name", "praise", "fault", "advice"],
      },
    },
    overallOpinion: { type: SchemaType.STRING },
  },
  required: ["squadGrade", "summary", "strength", "weakness", "coaching", "memberFeedbacks", "overallOpinion"],
};

function createSuccessfulLongBackupMatch() {
  return {
    matchId: "gemini-coaching-successful-long-backup",
    mapName: "Erangel_Main",
    gameMode: "squad",
    stats: {
      name: "KangHeeSung_",
      kills: 6,
      assists: 1,
      DBNOs: 4,
      damageDealt: 780,
      processedDamageDealt: 780,
      winPlace: 1,
      timeSurvived: 1842,
    },
    badges: [
      { name: "슬레이어", desc: "높은 킬 기여" },
      { name: "생존왕", desc: "끝까지 살아남은 경기" },
    ],
    eliteBenchmark: {
      avgDuelWinRate: 55,
      avgTradeRate: 50,
      avgInitiativeRate: 55,
      avgCounterLatency: 0.5,
      avgTradeLatency: 12,
      avgSuppCount: 3,
      avgReviveRate: 80,
      avgSmokeRate: 60,
      avgIsolationIndex: 1,
      avgPressureIndex: 3,
      avgDeathPhase: 6,
    },
    killContribution: { solo: 4, cleanup: 2, assist: 0 },
    tradeStats: {
      teammateKnocks: 1,
      tradeKills: 2,
      tradeRate: 100,
      suppCount: 0,
      revCount: 1,
      smokeCount: 0,
      smokeRescues: 0,
      baitCount: 0,
      reactionLatencyMs: 580,
      tradeLatencyMs: 22400,
      enemyTeamWipes: 1,
    },
    combatPressure: {
      pressureIndex: 5.2,
      utilityDamage: 95,
      utilityStats: {
        throwCount: 18,
        lethalThrowCount: 18,
        hitCount: 3,
        totalDamage: 95,
        killCount: 0,
        accuracy: 16.7,
        avgDamagePerThrow: 5.3,
      },
    },
    isolationData: {
      isolationIndex: 1.2,
      minDist: 18,
      heightDiff: 4,
      isCrossfire: false,
      teammateCount: 3,
    },
    teamImpact: {
      damageImpact: 260,
      killImpact: 200,
      teamDamageShare: 84,
      teamKillShare: 75,
    },
    duelStats: { duelWinRate: 70 },
    initiative_rate: 62,
    deathPhase: 0,
    itemUseSummary: { frags: 12, molotovs: 6, smokes: 0 },
  };
}

function createFailedLongBackupSmokeOnlyMatch() {
  return {
    matchId: "gemini-coaching-failed-long-backup-smoke-only",
    mapName: "Erangel_Main",
    gameMode: "squad",
    stats: {
      name: "KangHeeSung_",
      kills: 1,
      assists: 0,
      DBNOs: 1,
      damageDealt: 180,
      processedDamageDealt: 180,
      winPlace: 9,
      timeSurvived: 920,
    },
    badges: [],
    eliteBenchmark: {
      avgDuelWinRate: 55,
      avgTradeRate: 50,
      avgInitiativeRate: 55,
      avgCounterLatency: 0.5,
      avgTradeLatency: 12,
      avgSuppCount: 3,
      avgReviveRate: 80,
      avgSmokeRate: 60,
      avgIsolationIndex: 1,
      avgPressureIndex: 3,
      avgDeathPhase: 6,
    },
    killContribution: { solo: 1, cleanup: 0, assist: 0 },
    tradeStats: {
      teammateKnocks: 2,
      tradeKills: 0,
      tradeRate: 0,
      suppCount: 0,
      revCount: 0,
      smokeCount: 5,
      smokeRescues: 0,
      baitCount: 0,
      reactionLatencyMs: 1400,
      tradeLatencyMs: 22400,
      enemyTeamWipes: 0,
    },
    combatPressure: {
      pressureIndex: 1.1,
      utilityDamage: 0,
      utilityStats: {
        throwCount: 5,
        lethalThrowCount: 0,
        hitCount: 0,
        totalDamage: 0,
        killCount: 0,
        accuracy: 0,
        avgDamagePerThrow: 0,
      },
    },
    isolationData: {
      isolationIndex: 2.8,
      minDist: 42,
      heightDiff: 9,
      isCrossfire: true,
      teammateCount: 2,
    },
    teamImpact: {
      damageImpact: 62,
      killImpact: 45,
      teamDamageShare: 18,
      teamKillShare: 20,
    },
    duelStats: { duelWinRate: 33 },
    initiative_rate: 28,
    deathPhase: 3,
    itemUseSummary: { frags: 0, molotovs: 0, smokes: 5 },
  };
}

describeRealGemini("실제 Gemini 단판 코칭 품질", () => {
  it("성공한 22초 백업을 방관이나 치명적 느린 백업으로 비난하지 않는다", async () => {
    const matchData = createSuccessfulLongBackupMatch();
    const { fullPrompt, backupContext } = buildMatchAiCoachingPrompt({
      matchData,
      coachingStyle: "spicy",
    });
    const rawText = await callGeminiJson(fullPrompt);
    const finalText = sanitizeBackupCoachingText(rawText, backupContext);
    const parsed = extractJson(finalText);
    const joinedFinal = JSON.stringify(parsed);
    const qualitySignals = recordCase("single-spicy-successful-long-backup", rawText, finalText, parsed, {
      expectedBackupContext: backupContext,
      metricContext: createMatchMetricContext(matchData, backupContext),
    });

    expect(hasBlockingAiCoachingQualityIssue(qualitySignals)).toBe(false);
    expect(rawText).not.toMatch(/느린 백업|느린 방관|방관|성공이라기엔|팀원을 방패|팀원을 들러리|팀원을 방치/);
    expect(rawText).not.toMatch(/(백업|소생|복구).{0,20}치명적|치명적.{0,20}(백업|소생|복구)/);
    expect(joinedFinal).toContain("복구 시간 단축");
    expect(joinedFinal).toMatch(/성공 복구|성공적인 복구|복구 성공|교전 정리 후 복구 성공/);
    expect(joinedFinal).not.toMatch(/느린 백업|느린 방관|방관|성공이라기엔|팀원을 방패|팀원을 들러리|팀원을 방치/);
    expect(joinedFinal).not.toMatch(/(백업|소생|복구).{0,20}치명적|치명적.{0,20}(백업|소생|복구)/);
    expect(parsed.briefFeedback).toHaveLength(3);
    expect(parsed.actionItems.length).toBeGreaterThan(0);
  }, 60000);

  it("착한맛 단판도 성공 복구를 긍정 맥락과 보완점으로 분리한다", async () => {
    const matchData = createSuccessfulLongBackupMatch();
    const { fullPrompt, backupContext } = buildMatchAiCoachingPrompt({
      matchData,
      coachingStyle: "mild",
    });
    const rawText = await callGeminiJson(fullPrompt);
    const finalText = sanitizeBackupCoachingText(rawText, backupContext);
    const parsed = extractJson(finalText);
    const joinedFinal = JSON.stringify(parsed);
    const qualitySignals = recordCase("single-mild-successful-long-backup", rawText, finalText, parsed, {
      expectedBackupContext: backupContext,
      metricContext: createMatchMetricContext(matchData, backupContext),
    });

    expect(hasBlockingAiCoachingQualityIssue(qualitySignals)).toBe(false);
    expect(parsed.coach).toBe("다정한 코치");
    expect(parsed.briefFeedback).toHaveLength(3);
    expect(joinedFinal).toMatch(/복구|소생|백업/);
    expect(joinedFinal).not.toMatch(/느린 백업|방관|성공이라기엔|팀원을 방패|팀원을 들러리|팀원을 방치/);
  }, 60000);

  it("성공 근거가 없는 긴 백업은 지연 위험으로 다루고 연막을 피해형 적중률로 오판하지 않는다", async () => {
    const matchData = createFailedLongBackupSmokeOnlyMatch();
    const { fullPrompt, backupContext } = buildMatchAiCoachingPrompt({
      matchData,
      coachingStyle: "spicy",
    });
    const rawText = await callGeminiJson(fullPrompt);
    const finalText = sanitizeBackupCoachingText(rawText, backupContext);
    const parsed = extractJson(finalText);
    const joinedFinal = JSON.stringify(parsed);
    const qualitySignals = recordCase("single-spicy-failed-long-backup-smoke-only", rawText, finalText, parsed, {
      expectedBackupContext: backupContext,
      metricContext: createMatchMetricContext(matchData, backupContext),
    });

    expect(hasBlockingAiCoachingQualityIssue(qualitySignals)).toBe(false);
    expect(backupContext.label).toBe("백업 지연 위험");
    expect(backupContext.shouldAvoidSlowBackupBlame).toBe(false);
    expect(parsed.briefFeedback).toHaveLength(3);
    expect(joinedFinal).toMatch(/백업 지연|복구|소생|백업|연막/);
    expect(joinedFinal).not.toMatch(/교전 정리 후 복구 성공|성공 복구|폭파 전문가|투척물 마스터|정밀 폭격기/);
    expect(joinedFinal).not.toMatch(/피해형 투척 적중률 [1-9]\d*(?:\.\d+)?%/);
  }, 60000);
});

function createSquadInput(coachingStyle: "mild" | "spicy") {
  return {
    groupKey: "KangHeeSung_,Alpha,Beta,Gamma",
    nickname: "KangHeeSung_",
    coachingStyle,
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
    scores: {
      formation: 82,
      backupSpeed: 78,
      survivalCare: 84,
      focusFire: 76,
      teamWipe: 80,
    },
    benchmarkStats: {
      tier: "A",
      avgIsolation: 2.1,
      avgTradeLatency: 12000,
      avgReviveRate: 62,
      avgSmokeRate: 45,
      avgTeamWipes: 0.32,
    },
    roleProfiles: [
      { name: "KangHeeSung_", role: "Entry", roleDesc: "진입 화력", avgDamage: 410, avgKills: 3.2, avgAssists: 1.1, avgDbnos: 3.5, shares: { damage: 44, kill: 48, assist: 22, dbno: 46 } },
      { name: "Alpha", role: "Support", roleDesc: "백업/구출", avgDamage: 260, avgKills: 1.4, avgAssists: 2.8, avgDbnos: 1.8, shares: { damage: 28, kill: 21, assist: 42, dbno: 24 } },
      { name: "Beta", role: "Anchor", roleDesc: "후방 안정화", avgDamage: 190, avgKills: 1.1, avgAssists: 1.6, avgDbnos: 1.2, shares: { damage: 18, kill: 18, assist: 24, dbno: 18 } },
      { name: "Gamma", role: "Scout", roleDesc: "시야/각 관리", avgDamage: 95, avgKills: 0.6, avgAssists: 0.9, avgDbnos: 0.8, shares: { damage: 10, kill: 13, assist: 12, dbno: 12 } },
    ],
  };
}

describeRealGemini("실제 Gemini 스쿼드 코칭 품질", () => {
  it.each(["mild", "spicy"] as const)("스쿼드 %s 분석은 등급과 팀원별 피드백을 보존한다", async (coachingStyle) => {
    const input = createSquadInput(coachingStyle);
    const { prompt, systemInstruction } = buildSquadAiCoachingPrompt(input);
    const rawText = await callGeminiJson(prompt, systemInstruction, squadResponseSchema);
    const parsed = extractJson(rawText);
    const joinedFinal = JSON.stringify(parsed);
    const qualitySignals = recordCase(`squad-${coachingStyle}`, rawText, rawText, parsed, {
      expectedSquadGrade: input.squadGrade,
      expectedMembers: input.roleProfiles.map((item) => item.name),
      metricContext: {
        isolation: { index: input.stats.avgIsolation },
        teamImpact: { topDamageShare: Math.max(...input.roleProfiles.map((item) => item.shares.damage)) },
      },
    });

    expect(hasBlockingAiCoachingQualityIssue(qualitySignals)).toBe(false);
    expect(parsed.squadGrade).toBe("A");
    expect(parsed.memberFeedbacks).toHaveLength(input.roleProfiles.length);
    expect(parsed.memberFeedbacks.map((item: any) => item.name).sort()).toEqual(input.roleProfiles.map((item) => item.name).sort());
    expect(joinedFinal).not.toMatch(/\d{4,}ms|undefined|NaN/);
    expect(qualitySignals.hasLowIsolationMisread).toBe(false);
    expect(joinedFinal).not.toMatch(/강희성|오합지졸|1인 솔로 4개|혼자 정글북/);
    if (coachingStyle === "spicy") {
      expect(joinedFinal).not.toMatch(/원맨쇼|혼자 다 해먹|나머지 팀원들의 뇌|미끼|무너지는 구조/);
    }
    expect(joinedFinal).toMatch(/8\.2초|8\.20초|백업|소생|연막/);
    expect(parsed.summary).toBeTruthy();
    expect(parsed.coaching).toBeTruthy();
  }, 60000);
});

function buildTenMatchSummaryQualityPrompt() {
  const systemInstruction = [
    "당신들은 PUBG 전술 분석 데스크입니다.",
    "KIND COACH와 SPICY BOMBER 관점을 모두 포함하되, 데이터 근거 없이 의도와 심리를 단정하지 마십시오.",
    "백업 속도는 시간 단독이 아니라 적 제압, 소생, 연막 구출 결과와 함께 해석하십시오.",
    "결과가 성공한 긴 백업은 느린 백업으로 단정하지 말고 교전 정리 후 복구 성공과 복구 시간 단축 과제를 분리하십시오.",
    "고립 지수 1.6은 양호한 대열 유지로 해석하십시오. '너무 멀리', '독단적인 플레이', '고립될 위험', '고립 위험이 높다' 같은 표현은 부정문에서도 절대 쓰지 마십시오.",
    "actionItems 중 하나의 title은 반드시 '복구 시간 단축'이어야 합니다.",
    "debateIssues는 반드시 정확히 3개를 작성하십시오. 2개 이하나 4개 이상은 실패입니다.",
    "반드시 순수 JSON만 출력하십시오.",
  ].join("\n");
  const prompt = `
[최근 10경기 요약 데이터]
- 분석 대상: KangHeeSung_ 최근 10경기 중 상위 5경기 중심, 전체 10경기 마스터리 참고
- 평균 딜량: 438 (동일 티어 평균 290)
- 평균 킬: 3.1
- 1:1 교전 승률: 68% (동일 티어 평균 52%)
- 팀 내 딜량 비중: 58%
- 아군 기절: 4회, 내가 만든 복수: 4회, 내가 한 소생: 3회, 적 팀 전멸 기여: 2회
- 평균 백업 속도: 21.80s
- 백업 결과 해석: 21.80s로 시간만 보면 느리지만, 적 제압 4회/전멸 기여 2회와 소생 3회가 함께 있으므로 느린 백업이라고 단정하지 말 것. 교전 정리 후 복구 성공으로 평가하되, 다음에는 복구 시간을 줄이는 보완점만 제시할 것
- 총 투척 24회, 피해형 투척 15회, 피해 적중 5회, 연막 9회
- 내 연막 구출 성공: 2회
- 고립 지수: 1.6, 팀원 평균 거리: 21m

[응답 JSON 스키마]
{
  "signature": "칭호",
  "signatureSub": "근거 1문장",
  "finalVerdict": "2문장 이내 종합 판정",
  "debateIssues": [
    {
      "topic": "주제",
      "spicyOpinion": "매운맛 의견",
      "kindOpinion": "착한맛 의견",
      "winner": "spicy 또는 kind",
      "reason": "데이터 근거",
      "userStats": [{ "label": "항목", "value": "값" }],
      "benchmarkStats": [{ "label": "항목", "value": "값" }]
    }
  ],
  "actionItems": [{ "title": "목표", "desc": "실천 팁" }]
}
  `.trim();

  return { systemInstruction, prompt };
}

describeRealGemini("실제 Gemini 10경기 요약 코칭 품질", () => {
  it("성공한 긴 백업을 요약 분석에서 오판하지 않고 토론형 JSON을 만든다", async () => {
    const { prompt, systemInstruction } = buildTenMatchSummaryQualityPrompt();
    const rawText = await callGeminiJson(prompt, systemInstruction);
    const finalText = sanitizeAiCoachingLanguageText(rawText);
    const parsed = extractJson(finalText);
    const joinedFinal = JSON.stringify(parsed);
    const qualitySignals = recordCase("summary-ten-match-successful-long-backup", rawText, finalText, parsed, {
      expectedDebateIssueCount: 3,
      expectedBackupDirection: "교전 정리 후 복구 성공 + 복구 시간 단축",
      metricContext: {
        backup: {
          label: "교전 정리 후 복구 성공",
          latencySeconds: 21.8,
          shouldAvoidSlowBackupBlame: true,
          tradeKills: 4,
          revives: 3,
          smokeRescues: 2,
          teamWipes: 2,
          teammateKnocks: 4,
        },
        utility: {
          totalThrows: 24,
          lethalThrows: 15,
          hits: 5,
          accuracy: 33.3,
          smokes: 9,
        },
        isolation: { index: 1.6 },
        teamImpact: { damageShare: 58 },
      },
    });

    expect(hasBlockingAiCoachingQualityIssue(qualitySignals)).toBe(false);
    expect(parsed.debateIssues).toHaveLength(3);
    expect(parsed.actionItems.length).toBeGreaterThan(0);
    expect(joinedFinal).toMatch(/복구 시간 단축|교전 정리 후 복구 성공|성공 복구|복구 성공/);
    expect(joinedFinal).not.toMatch(/느린 백업|방관|성공이라기엔|팀원을 방패|팀원을 들러리|팀원을 방치|undefined|NaN|\d{4,}ms/);
    expect(joinedFinal).not.toMatch(/너무 멀리|독단적인 플레이|고립될 위험|고립 위험이 높/);
  }, 60000);
});
