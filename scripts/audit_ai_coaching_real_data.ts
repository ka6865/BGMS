import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory, SchemaType } from "@google/generative-ai";
import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMatchAiCoachingPrompt } from "../lib/pubg-analysis/matchAiCoachingPrompt";
import { buildSquadAiCoachingPrompt } from "../lib/pubg-analysis/squadAiCoachingPrompt";
import { buildBackupCoachingContext, sanitizeBackupCoachingText } from "../lib/pubg-analysis/backupCoaching";
import { getValidFullResult, normalizePlatform } from "../lib/pubg-analysis/cacheIdentity";
import { normalizeName } from "../lib/pubg-analysis/utils";
import {
  collectAiCoachingQualitySignals,
  hasBlockingAiCoachingQualityIssue,
  sanitizeAiCoachingLanguageText,
} from "../lib/pubg-analysis/aiCoachingQuality";
import { getAiCoachingBlockingSignalNames } from "../lib/pubg-analysis/aiCoachingReportCheck";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

type CoachingStyle = "mild" | "spicy";

interface LoadedMatch {
  matchId: string;
  updatedAt: string;
  fullResult: any;
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

function getArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function getNumberArg(name: string, fallback: number): number {
  const value = Number(getArg(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function getBlockingSignalNames(qualitySignals: ReturnType<typeof collectAiCoachingQualitySignals>): string[] {
  return getAiCoachingBlockingSignalNames(qualitySignals);
}

function createSupabaseServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function extractJson(text: string): any {
  const cleaned = text.trim().replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`Gemini 응답에서 JSON 객체를 찾지 못했습니다.\n${text}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callGeminiJson(prompt: string, systemInstruction?: string, responseSchema?: any): Promise<{ text: string; modelName: string }> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_GEMINI_API_KEY가 없습니다.");

  const genAI = new GoogleGenerativeAI(apiKey);
  const models = [
    process.env.GEMINI_COACHING_TEST_MODEL || "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
  ];
  let lastError: unknown = null;

  for (const modelName of Array.from(new Set(models))) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.45 },
          safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
          ],
        });
        const result = await model.generateContent(prompt);
        return { text: result.response.text(), modelName };
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.status || 0);
        if (status && status !== 429 && status !== 500 && status !== 503) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Gemini 호출 실패"));
}

async function loadMatches(nickname: string, platform: string, limit: number): Promise<LoadedMatch[]> {
  const supabase = createSupabaseServiceClient();
  const playerId = normalizeName(nickname);
  const cachePlatform = normalizePlatform(platform);
  const { data, error } = await supabase
    .from("processed_match_telemetry")
    .select("match_id, data, updated_at")
    .eq("platform", cachePlatform)
    .eq("player_id", playerId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`processed_match_telemetry 조회 실패: ${error.message}`);

  return (data || [])
    .map((row: any) => {
      const fullResult = getValidFullResult(row, playerId, cachePlatform);
      if (!fullResult) return null;
      return {
        matchId: row.match_id,
        updatedAt: row.updated_at,
        fullResult: { ...fullResult, matchId: row.match_id },
      };
    })
    .filter(Boolean) as LoadedMatch[];
}

function isValidTacticalMatch(fullResult: any): boolean {
  const mode = fullResult.gameMode || "";
  const map = fullResult.mapName || "";
  if (mode.includes("event") || mode.includes("arcade") || mode.includes("custom") || mode.includes("training")) return false;
  if (map.includes("SafeHouse") || map.includes("Range_Main") || map.includes("Training")) return false;
  return true;
}

function selectSingleMatch(matches: LoadedMatch[]): LoadedMatch {
  const candidates = matches.filter((match) => isValidTacticalMatch(match.fullResult));
  const wins = candidates.filter((match) => Number(match.fullResult.stats?.winPlace) === 1);
  const pool = wins.length > 0 ? wins : candidates;
  const selected = [...pool].sort((a, b) => {
    const bScore = Number(b.fullResult.benchmark?.score || 0);
    const aScore = Number(a.fullResult.benchmark?.score || 0);
    if (bScore !== aScore) return bScore - aScore;
    const bDamage = Number(b.fullResult.stats?.processedDamageDealt ?? b.fullResult.stats?.damageDealt ?? 0);
    const aDamage = Number(a.fullResult.stats?.processedDamageDealt ?? a.fullResult.stats?.damageDealt ?? 0);
    return bDamage - aDamage;
  })[0];
  if (!selected) throw new Error("AI 감사에 사용할 유효한 단일 경기 데이터가 없습니다.");
  return selected;
}

function aggregateSummary(matches: LoadedMatch[]) {
  const pool = matches.filter((match) => isValidTacticalMatch(match.fullResult)).slice(0, 10);
  if (pool.length === 0) throw new Error("AI 요약 감사에 사용할 유효한 최근 경기 데이터가 없습니다.");
  const best = [...pool].sort((a, b) => Number(b.fullResult.benchmark?.score || 0) - Number(a.fullResult.benchmark?.score || 0)).slice(0, 5);
  const source = best.length > 0 ? best : pool;
  const sum = source.reduce((acc, match) => {
    const m = match.fullResult;
    const stats = m.stats || {};
    const trade = m.tradeStats || {};
    const utility = m.combatPressure?.utilityStats || {};
    const isolation = m.isolationData || {};
    acc.damage += Number(stats.processedDamageDealt ?? stats.damageDealt ?? 0);
    acc.kills += Number(stats.kills || 0);
    acc.duelWins += Number(m.duelStats?.wins || 0);
    acc.duelLosses += Number(m.duelStats?.losses || 0);
    acc.teamDamageShare += Number(m.teamImpact?.teamDamageShare || 0);
    acc.teammateKnocks += Number(trade.teammateKnocks || 0);
    acc.tradeKills += Number(trade.tradeKills || 0);
    acc.revives += Number(trade.revCount || 0);
    acc.smokeRescues += Number(trade.smokeRescues || 0);
    acc.teamWipes += Number(trade.enemyTeamWipes || 0);
    if (trade.tradeLatencyMs > 0) {
      acc.tradeLatency += Number(trade.tradeLatencyMs);
      acc.tradeLatencyCount += 1;
    }
    acc.throws += Number(utility.throwCount || 0);
    const inferredLethalThrows = Number(m.itemUseSummary?.frags || 0) + Number(m.itemUseSummary?.molotovs || 0);
    acc.lethalThrows += Number((utility.lethalThrowCount ?? m.itemUseStats?.lethalThrowCount ?? inferredLethalThrows) || 0);
    acc.utilityHits += Math.min(Number(utility.hitCount || 0), Number((utility.lethalThrowCount ?? m.itemUseStats?.lethalThrowCount ?? inferredLethalThrows) || 0));
    acc.smokes += Number(m.itemUseSummary?.smokes || trade.smokeCount || 0);
    acc.isolation += Number(isolation.isolationIndex || 0);
    acc.isolationCount += isolation.isolationIndex !== undefined ? 1 : 0;
    return acc;
  }, {
    damage: 0,
    kills: 0,
    duelWins: 0,
    duelLosses: 0,
    teamDamageShare: 0,
    teammateKnocks: 0,
    tradeKills: 0,
    revives: 0,
    smokeRescues: 0,
    teamWipes: 0,
    tradeLatency: 0,
    tradeLatencyCount: 0,
    throws: 0,
    lethalThrows: 0,
    utilityHits: 0,
    smokes: 0,
    isolation: 0,
    isolationCount: 0,
  });

  const avgBackupLatency = sum.tradeLatencyCount > 0
    ? `${(sum.tradeLatency / sum.tradeLatencyCount / 1000).toFixed(2)}s`
    : "측정 불가";
  const backupContext = buildBackupCoachingContext({
    avgBackupLatency,
    totalTradeKills: sum.tradeKills,
    totalRevCount: sum.revives,
    totalSmokeRescues: sum.smokeRescues,
    totalTeamWipes: sum.teamWipes,
    totalTeammateKnocks: sum.teammateKnocks,
    benchmarkTradeLatency: 12,
  });

  return {
    matchCount: source.length,
    matchIds: source.map((match) => match.matchId),
    avgDamage: Math.round(sum.damage / source.length),
    avgKills: Number((sum.kills / source.length).toFixed(1)),
    duelWinRate: sum.duelWins + sum.duelLosses > 0 ? Math.round((sum.duelWins / (sum.duelWins + sum.duelLosses)) * 100) : 0,
    avgTeamDamageShare: Number((sum.teamDamageShare / source.length).toFixed(1)),
    totalTeammateKnocks: sum.teammateKnocks,
    avgBackupLatency,
    backupContext,
    avgIsolation: sum.isolationCount > 0 ? Number((sum.isolation / sum.isolationCount).toFixed(2)) : 0,
    totalTradeKills: sum.tradeKills,
    totalRevives: sum.revives,
    totalSmokeRescues: sum.smokeRescues,
    totalTeamWipes: sum.teamWipes,
    totalThrows: sum.throws,
    totalLethalThrows: sum.lethalThrows,
    totalUtilityHits: sum.utilityHits,
    totalSmokes: sum.smokes,
  };
}

function buildRealSummaryPrompt(summary: ReturnType<typeof aggregateSummary>, nickname: string) {
  const systemInstruction = [
    "당신들은 PUBG 전술 분석 데스크입니다.",
    "KIND COACH와 SPICY BOMBER 관점을 모두 포함하되, 데이터 근거 없이 의도와 심리를 단정하지 마십시오.",
    "백업 속도는 시간 단독이 아니라 적 제압, 소생, 연막 구출 결과와 함께 해석하십시오.",
    "결과가 성공한 긴 백업은 느린 백업으로 단정하지 말고 교전 정리 후 복구 성공과 복구 시간 단축 과제를 분리하십시오.",
    "고립 지수가 2.0 미만이면 양호한 대열 유지로 해석하십시오. '너무 멀리', '독단적인 플레이', '고립될 위험', '고립 위험이 높다' 같은 표현은 부정문에서도 절대 쓰지 마십시오.",
    "높은 딜량 비중은 강한 교전 주도 또는 화력 분담 보완 필요로 해석하십시오. 근거 없이 '팀원을 방패', '팀원을 들러리', '팀원을 방치', '혼자 다 해먹', '혼자서 모든 것을 해결', '미끼' 같은 의도 단정 표현을 쓰지 마십시오.",
    "팀원을 낮춰 부르는 표현은 금지입니다. '팀 지원 지표가 바닥', '나머지 팀원들의 화력 지원이 전무', '팀 전체가 휘청', '존재감이 희미', '팀 민폐', '오만' 대신 '팀 지원 지표 보완', '화력 분담 보완', '교전 기여를 더 선명하게 만들 필요'라고 표현하십시오.",
    "JSON을 작성한 뒤 signatureSub/finalVerdict/debateIssues/actionItems에 금지 표현이 있으면 응답하기 전에 반드시 안전한 수치 기반 피드백으로 고치십시오.",
    "actionItems 중 하나의 title은 반드시 '복구 시간 단축'이어야 합니다.",
    "debateIssues는 반드시 정확히 3개를 작성하십시오.",
    "반드시 순수 JSON만 출력하십시오.",
  ].join("\n");
  const prompt = `
[실제 최근 경기 요약 데이터]
- 분석 대상: ${nickname}
- 분석 매치 수: ${summary.matchCount}
- 사용 매치 ID: ${summary.matchIds.join(", ")}
- 평균 딜량: ${summary.avgDamage}
- 평균 킬: ${summary.avgKills}
- 1:1 교전 승률: ${summary.duelWinRate}%
- 팀 내 평균 딜량 비중: ${summary.avgTeamDamageShare}%
- 평균 백업 속도: ${summary.avgBackupLatency}
- 백업 결과 해석: ${summary.backupContext.promptLine}
- 복수 킬/소생/연막 구출/전멸 기여: ${summary.totalTradeKills}/${summary.totalRevives}/${summary.totalSmokeRescues}/${summary.totalTeamWipes}
- 총 투척/피해형 투척/피해 적중/연막: ${summary.totalThrows}/${summary.totalLethalThrows}/${summary.totalUtilityHits}/${summary.totalSmokes}
- 평균 고립 지수: ${summary.avgIsolation}

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

function createMatchMetricContext(fullResult: any, backupContext: ReturnType<typeof buildBackupCoachingContext>) {
  const trade = fullResult.tradeStats || {};
  const utility = fullResult.combatPressure?.utilityStats || {};
  const inferredLethalThrows = (fullResult.itemUseSummary?.frags || 0) + (fullResult.itemUseSummary?.molotovs || 0);
  const lethalThrows = Number((utility.lethalThrowCount ?? fullResult.itemUseStats?.lethalThrowCount ?? inferredLethalThrows) || 0);
  const hits = lethalThrows > 0 ? Math.min(Number(utility.hitCount || 0), lethalThrows) : 0;

  return {
    backup: {
      label: backupContext.label,
      latencySeconds: backupContext.latencySeconds,
      shouldAvoidSlowBackupBlame: backupContext.shouldAvoidSlowBackupBlame,
      tradeKills: Number(trade.tradeKills || 0),
      revives: Number(trade.revCount || 0),
      smokeRescues: Number(trade.smokeRescues || 0),
      teamWipes: Number(trade.enemyTeamWipes || 0),
      teammateKnocks: Number(trade.teammateKnocks || 0),
    },
    utility: {
      totalThrows: Number(utility.throwCount || 0),
      lethalThrows,
      hits,
      accuracy: lethalThrows > 0 ? Number(((hits / lethalThrows) * 100).toFixed(1)) : 0,
      smokes: Number(fullResult.itemUseSummary?.smokes || trade.smokeCount || 0),
    },
    isolation: {
      index: fullResult.isolationData?.isolationIndex,
    },
    teamImpact: {
      damageShare: fullResult.teamImpact?.teamDamageShare,
    },
  };
}

function createSummaryMetricContext(summary: ReturnType<typeof aggregateSummary>) {
  return {
    backup: {
      label: summary.backupContext.label,
      latencySeconds: summary.backupContext.latencySeconds,
      shouldAvoidSlowBackupBlame: summary.backupContext.shouldAvoidSlowBackupBlame,
      tradeKills: summary.totalTradeKills,
      revives: summary.totalRevives,
      smokeRescues: summary.totalSmokeRescues,
      teamWipes: summary.totalTeamWipes,
      teammateKnocks: summary.totalTeammateKnocks,
    },
    utility: {
      totalThrows: summary.totalThrows,
      lethalThrows: summary.totalLethalThrows,
      hits: summary.totalUtilityHits,
      accuracy: summary.totalLethalThrows > 0 ? Number(((summary.totalUtilityHits / summary.totalLethalThrows) * 100).toFixed(1)) : 0,
      smokes: summary.totalSmokes,
    },
    isolation: {
      index: summary.avgIsolation,
    },
    teamImpact: {
      damageShare: summary.avgTeamDamageShare,
    },
  };
}

function buildSquadInput(matches: LoadedMatch[], nickname: string, style: CoachingStyle) {
  const playerId = normalizeName(nickname);
  const squadMatches = matches.filter((match) => {
    const team = Array.isArray(match.fullResult.team) ? match.fullResult.team : [];
    return team.some((member: any) => {
      const displayName = String(member?.name || "").trim();
      const key = normalizeName(displayName);
      return displayName && key && key !== playerId;
    });
  });
  const groupCounts = new Map<string, { matchIds: Set<string>; names: Map<string, string> }>();

  squadMatches.forEach((match) => {
    const names = new Map<string, string>();
    (match.fullResult.team || []).forEach((member: any) => {
      const displayName = String(member?.name || "").trim();
      const key = normalizeName(displayName);
      if (!displayName || !key || key === playerId) return;
      if (!names.has(key)) names.set(key, displayName);
    });
    if (names.size === 0) return;
    const groupKey = Array.from(names.keys()).sort().join(",");
    const group = groupCounts.get(groupKey) || { matchIds: new Set<string>(), names: new Map<string, string>() };
    group.matchIds.add(match.matchId);
    names.forEach((name, key) => group.names.set(key, name));
    groupCounts.set(groupKey, group);
  });

  const selectedGroup = Array.from(groupCounts.entries())
    .sort((a, b) => b[1].matchIds.size - a[1].matchIds.size)[0];
  if (!selectedGroup) return null;

  const [, group] = selectedGroup;
  const groupMatchIds = group.matchIds;
  const targetMatches = squadMatches.filter((match) => groupMatchIds.has(match.matchId));
  const memberNames = new Map<string, string>([[playerId, nickname], ...group.names.entries()]);
  const accum: Record<string, { damage: number; kills: number; assists: number; dbnos: number }> = {};
  memberNames.forEach((name, key) => {
    accum[key] = { damage: 0, kills: 0, assists: 0, dbnos: 0 };
  });

  let isolationSum = 0;
  let isolationCount = 0;
  let tradeLatencySum = 0;
  let tradeLatencyCount = 0;
  let coverRateSum = 0;
  let smokeRescues = 0;
  let revives = 0;
  let teamWipes = 0;

  targetMatches.forEach((match) => {
    const full = match.fullResult;
    const trade = full.tradeStats || {};
    const iso = full.isolationData || {};
    if (iso.isolationIndex !== undefined) {
      isolationSum += Number(iso.isolationIndex);
      isolationCount += 1;
    }
    if (trade.tradeLatencyMs > 0) {
      tradeLatencySum += Number(trade.tradeLatencyMs);
      tradeLatencyCount += 1;
    }
    coverRateSum += Number(trade.coverRate || 0.3);
    smokeRescues += Number(trade.smokeRescues || 0);
    revives += Number(trade.revCount || 0);
    teamWipes += Number(trade.enemyTeamWipes || 0);
    (full.team || []).forEach((member: any) => {
      const key = normalizeName(member?.name || "");
      if (!accum[key]) return;
      accum[key].damage += Number(member.damageDealt || 0);
      accum[key].kills += Number(member.kills || 0);
      accum[key].assists += Number(member.assists || 0);
      accum[key].dbnos += Number(member.DBNOs || 0);
    });
  });

  const totals = Object.values(accum).reduce((acc, item) => {
    acc.damage += item.damage;
    acc.kills += item.kills;
    acc.assists += item.assists;
    acc.dbnos += item.dbnos;
    return acc;
  }, { damage: 0, kills: 0, assists: 0, dbnos: 0 });
  const matchCount = Math.max(1, targetMatches.length);
  const roleProfiles = Array.from(memberNames.entries()).map(([key, name]) => {
    const item = accum[key];
    return {
      name,
      role: key === playerId ? "Entry" : "Squad",
      roleDesc: key === playerId ? "주요 진입 화력" : "팀 전술 지원",
      avgDamage: Math.round(item.damage / matchCount),
      avgKills: Number((item.kills / matchCount).toFixed(1)),
      avgAssists: Number((item.assists / matchCount).toFixed(1)),
      avgDbnos: Number((item.dbnos / matchCount).toFixed(1)),
      shares: {
        damage: totals.damage > 0 ? Math.round((item.damage / totals.damage) * 100) : 0,
        kill: totals.kills > 0 ? Math.round((item.kills / totals.kills) * 100) : 0,
        assist: totals.assists > 0 ? Math.round((item.assists / totals.assists) * 100) : 0,
        dbno: totals.dbnos > 0 ? Math.round((item.dbnos / totals.dbnos) * 100) : 0,
      },
    };
  });
  const avgIsolation = isolationCount > 0 ? Number((isolationSum / isolationCount).toFixed(2)) : 1.5;
  const avgTradeLatency = tradeLatencyCount > 0 ? Math.round(tradeLatencySum / tradeLatencyCount) : 12000;
  const avgCoverRate = coverRateSum / matchCount;
  const formation = Math.max(10, Math.min(100, Math.round(92 - Math.max(0, avgIsolation - 1) * 18)));
  const backupSpeed = Math.max(10, Math.min(100, Math.round(70 + (12000 - avgTradeLatency) / 150)));
  const survivalCare = Math.max(10, Math.min(100, Math.round(60 + (revives + smokeRescues) * 3)));
  const focusFire = Math.max(10, Math.min(100, Math.round(avgCoverRate * 100)));
  const teamWipe = Math.max(10, Math.min(100, Math.round(60 + teamWipes * 4)));
  const overall = Math.round((formation + backupSpeed + survivalCare + focusFire + teamWipe) / 5);
  const squadGrade = overall >= 90 ? "S" : overall >= 83 ? "A" : overall >= 73 ? "B" : overall >= 60 ? "C" : "D";

  return {
    groupKey: Array.from(group.names.values()).join(", "),
    nickname,
    coachingStyle: style,
    squadGrade,
    matchCount,
    stats: {
      avgIsolation,
      avgTradeLatency,
      avgCoverRate,
      totalSmokeRescues: smokeRescues,
      totalRevives: revives,
      totalTeamWipes: teamWipes,
    },
    scores: { formation, backupSpeed, survivalCare, focusFire, teamWipe },
    benchmarkStats: {
      tier: squadGrade,
      avgIsolation: 2.0,
      avgTradeLatency: 12000,
      avgReviveRate: 15,
      avgSmokeRate: 3,
      avgTeamWipes: 2,
    },
    roleProfiles,
    matchIds: Array.from(groupMatchIds),
  };
}

async function runCase(name: string, rawText: string, finalText: string, extra: Record<string, unknown> = {}) {
  const parsed = extractJson(finalText);
  const joined = JSON.stringify(parsed);
  const qualitySignals = collectAiCoachingQualitySignals(joined);
  const blockingSignalNames = getBlockingSignalNames(qualitySignals);
  const rawQualitySignals = collectAiCoachingQualitySignals(rawText);
  const rawBlockingSignalNames = getBlockingSignalNames(rawQualitySignals);
  return {
    name,
    rawText,
    finalText,
    parsed,
    qualitySignals,
    hasBlockingQualityIssue: hasBlockingAiCoachingQualityIssue(qualitySignals),
    blockingSignalNames,
    rawQualitySignals,
    hasRawBlockingQualityIssue: hasBlockingAiCoachingQualityIssue(rawQualitySignals),
    rawBlockingSignalNames,
    ...extra,
  };
}

async function main() {
  const nickname = getArg("--nickname", "KangHeeSung_");
  const platform = getArg("--platform", "steam");
  const limit = getNumberArg("--limit", 20);
  const output = getArg("--output", "tmp/ai-coaching-real-data-report.json");
  const allowExternalAi = hasFlag("--allow-external-ai");
  const allowQualityIssues = hasFlag("--allow-quality-issues");
  if (!allowExternalAi) {
    throw new Error(
      [
        "실제 processed_match_telemetry 데이터를 Gemini로 전송하려면 --allow-external-ai 플래그가 필요합니다.",
        "이 명령은 실제 경기 분석 데이터를 외부 AI 서비스에 보낼 수 있으므로, 사용자가 데이터 이전 리스크를 승인한 경우에만 실행하십시오.",
        "예: npm run test:ai:real-data -- --nickname KangHeeSung_ --platform steam --limit 20 --allow-external-ai",
      ].join("\n")
    );
  }
  const matches = await loadMatches(nickname, platform, limit);
  if (matches.length === 0) {
    throw new Error(`${platform}/${nickname} processed_match_telemetry 유효 데이터가 없습니다.`);
  }

  const cases: any[] = [];
  const selectedSingle = selectSingleMatch(matches);
  for (const style of ["spicy", "mild"] as CoachingStyle[]) {
    const { fullPrompt, backupContext } = buildMatchAiCoachingPrompt({
      matchData: selectedSingle.fullResult,
      coachingStyle: style,
    });
    const { text: rawText, modelName } = await callGeminiJson(fullPrompt);
    const finalText = sanitizeBackupCoachingText(rawText, backupContext);
    cases.push(await runCase(`real-single-${style}`, rawText, finalText, {
      model: modelName,
      matchId: selectedSingle.matchId,
      winPlace: selectedSingle.fullResult.stats?.winPlace,
      backupContext,
      metricContext: createMatchMetricContext(selectedSingle.fullResult, backupContext),
    }));
  }

  const summary = aggregateSummary(matches);
  const { prompt: summaryPrompt, systemInstruction: summarySystem } = buildRealSummaryPrompt(summary, nickname);
  const { text: summaryRaw, modelName: summaryModelName } = await callGeminiJson(summaryPrompt, summarySystem);
  const summaryFinal = sanitizeAiCoachingLanguageText(summaryRaw);
  cases.push(await runCase("real-summary-ten-match", summaryRaw, summaryFinal, {
    model: summaryModelName,
    summary,
    metricContext: createSummaryMetricContext(summary),
  }));

  for (const style of ["mild", "spicy"] as CoachingStyle[]) {
    const squadInput = buildSquadInput(matches, nickname, style);
    if (!squadInput) continue;
    const { prompt, systemInstruction } = buildSquadAiCoachingPrompt(squadInput);
    const { text: rawText, modelName } = await callGeminiJson(prompt, systemInstruction, squadResponseSchema);
    const finalText = sanitizeAiCoachingLanguageText(rawText);
    cases.push(await runCase(`real-squad-${style}`, rawText, finalText, {
      model: modelName,
      squad: {
        groupKey: squadInput.groupKey,
        squadGrade: squadInput.squadGrade,
        matchCount: squadInput.matchCount,
        matchIds: squadInput.matchIds,
        stats: squadInput.stats,
        scores: squadInput.scores,
      },
      metricContext: {
        isolation: { index: squadInput.stats.avgIsolation },
        teamImpact: { topDamageShare: Math.max(...squadInput.roleProfiles.map((item: any) => Number(item.shares?.damage || 0))) },
      },
    }));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    nickname,
    platform,
    loadedMatchCount: matches.length,
    model: Array.from(new Set(cases.map((item) => item.model))).join(", "),
    passedQualityGate: cases.every((item) => !item.hasBlockingQualityIssue),
    blockingCases: cases
      .filter((item) => item.hasBlockingQualityIssue)
      .map((item) => ({ name: item.name, blockingSignalNames: item.blockingSignalNames })),
    cases,
  };
  const outputPath = path.resolve(process.cwd(), output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.info(JSON.stringify({
    output: outputPath,
    loadedMatchCount: matches.length,
    passedQualityGate: report.passedQualityGate,
    blockingCases: report.blockingCases,
    cases: cases.map((item) => ({
      name: item.name,
      qualitySignals: item.qualitySignals,
      hasBlockingQualityIssue: item.hasBlockingQualityIssue,
      blockingSignalNames: item.blockingSignalNames,
      keys: Object.keys(item.parsed || {}),
    })),
  }, null, 2));

  if (!report.passedQualityGate && !allowQualityIssues) {
    throw new Error(`AI 실데이터 감사 품질 게이트 실패: ${report.blockingCases.map((item) => `${item.name}(${item.blockingSignalNames.join(",")})`).join(", ")}`);
  }
}

main().catch((error) => {
  console.error("[AI real data audit] 실패:", error);
  process.exitCode = 1;
});
