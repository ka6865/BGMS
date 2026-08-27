import { NextResponse } from "next/server";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { AI_CACHE_VERSION, GEMINI_MODELS_TO_TRY, WEAPON_NAMES } from "@/lib/pubg-analysis/constants";
import { estimateUserTier } from "@/lib/pubg-analysis/benchmarkScore";
import { classifyRole } from "@/lib/pubg-analysis/roleClassifier";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { adaptBenchmark } from "@/lib/pubg-analysis/benchmarkAdapter";
import { fetchTierBenchmarkStats } from "@/lib/pubg-analysis/benchmarkLookup";
import { getValidFullResult, isFullResultForPlayerPlatform, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { buildBackupCoachingContext } from "@/lib/pubg-analysis/backupCoaching";
import { jsonrepair } from "jsonrepair";
import { withAuthGuard } from "@/utils/supabase/guard";
import { trackAiFailure, trackAiUsage } from "@/lib/pubg-analysis/aiUsageTracker";
import { sanitizeAiCoachingLanguageText } from "@/lib/pubg-analysis/aiCoachingQuality";
import {
  buildMatchSelectionKey,
  normalizeMatchId,
  RECENT_MATCH_SELECTION_VERSION,
  selectRecentMatches,
  type RecentMatchCandidate,
} from "@/lib/pubg-analysis/recentMatchSelection";
import crypto from "crypto";

export const maxDuration = 60;

const AI_SUMMARY_TOTAL_TIMEOUT_MS = 22000;
const AI_SUMMARY_MODEL_TIMEOUT_MS = 8000;

function normalizeWeaponName(weaponId: string): string {
  if (!weaponId) return "Unknown";
  let name = weaponId.toLowerCase();
  name = name.replace(/item_weapon_/, "").replace(/weap/, "").replace(/_c$/, "").replace(/proj/, "");
  const upperName = name.toUpperCase();
  const names = WEAPON_NAMES as any;
  return names[upperName] || names[weaponId] || name;
}

// [V42.0] jsonrepair 라이브러리를 활용한 강력한 JSON 복구 로직
function extractValidJson(text: string): string {
  try {
    // 1. 기본적인 마크다운 펜스 제거
    const cleaned = text.trim().replace(/```json|```/g, "").trim();

    // 2. 첫 번째 중괄호 위치 찾기
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) return cleaned;

    const target = cleaned.substring(firstBrace);

    // 3. jsonrepair로 문법 오류(따옴표 누락, 끊긴 문자열 등) 복구
    return jsonrepair(target);
  } catch (err) {
    console.warn("[AI-SUMMARY] jsonrepair failed, falling back to manual extraction", err);

    // 4. 수동 복구 (기존 중괄호 밸런싱 로직)
    const firstBrace = text.indexOf('{');
    if (firstBrace === -1) return text;

    let braceCount = 0;
    let inString = false;

    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];
      if (char === '"' && (i === 0 || text[i - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (braceCount === 0) return text.substring(firstBrace, i + 1);
      }
    }
    return text;
  }
}


function aggregateMatches(matches: any[]) {
  let totalKills = 0, totalDamage = 0, totalDamageImpact = 0, totalTeamDamageShare = 0, totalTeamKillShare = 0;
  let totalTeammateKnocks = 0, totalSuppCount = 0, totalTradeKills = 0, totalRescueSmokes = 0;
  let totalRevCount = 0, totalBaitCount = 0;
  let totalSmokes = 0;
  let totalSmokeRescues = 0;
  let totalCoverSuccess = 0, totalCoverAttempts = 0;
  let totalInitiativeSuccess = 0, totalInitiativeAttempts = 0;
  let totalCrossfireCount = 0, totalTeamWipes = 0, totalMaxHitDist = 0;
  let totalDuelWins = 0, totalDuelLosses = 0, totalReversalWins = 0, totalReversalAttempts = 0;
  let totalUtilityThrows = 0, totalUtilityHits = 0, totalUtilityDamage = 0, totalUtilityKills = 0;
  let totalDeathPhase = 0, totalBluezoneWaste = 0;
  let totalEdgePlay = 0, totalFatalDelay = 0;
  let totalFocusFireCount = 0, totalCrossfireExposureCount = 0;
  const totalDistanceDamage = { short: 0, mid: 0, long: 0 };
  let totalIsolationIndexFinal = 0, totalCombatIso = 0, totalDeathIso = 0;
  let totalMinDist = 0, totalHeightDiff = 0, totalTeammateCountFinal = 0, isolationCountFinal = 0;
  let rankedCount = 0, normalCount = 0;
  const weaponMatchCount: Record<string, number> = {};
  
  // [V58.4] 차량 고정밀 교전 지표 집계용 변수
  let totalLeadShotKills = 0, totalLeadShotKnocks = 0, totalRidingShotKills = 0, totalRidingShotKnocks = 0;
  let totalRoadKills = 0, totalRoadKnocks = 0;
  let vehicleCombatMatchCount = 0;

  const backupLatencies: number[] = [], reactionLatencies: number[] = [];
  const goldenTimeFinal = { early: 0, mid1: 0, mid2: 0, late: 0 };
  const killContribFinal = { solo: 0, cleanup: 0, assist: 0 }; // assist = 내 킬 중 팀원이 먼저 딜을 넣었던 킬 (KDA 어시스트와 무관)
  const weaponStatsFinal: Record<string, any> = {};
  const allBadges: any[] = [];

  matches.forEach((m: any) => {
    // [V41.0] Account ID 우선 매칭 (매칭 검증용)

    // 무기 통계 합산 (DB weaponStats 0 이슈 해결을 위해 타임라인 전수조사 병행)
    if (m.weaponStats) {
      Object.entries(m.weaponStats).forEach(([wId, wData]: [string, any]) => {
        const weaponName = normalizeWeaponName(wId);
        if (!weaponStatsFinal[weaponName]) weaponStatsFinal[weaponName] = { kills: 0, dbnos: 0, damage: 0 };
        weaponStatsFinal[weaponName].damage += (wData.damage || 0);
      });
    }
    // 타임라인에서 킬/기절 정보 추출하여 보정
    if (Array.isArray(m.timeline)) {
      m.timeline.forEach((event: any) => {
        if (event.type === 'KILL' || event.type === 'KNOCK' || event.type === 'DOWNED' || event.type === 'TEAM_KNOCK') {
          const weaponName = normalizeWeaponName(event.weapon || 'Unknown');
          if (!weaponStatsFinal[weaponName]) weaponStatsFinal[weaponName] = { kills: 0, dbnos: 0, damage: 0 };
          if (event.type === 'KILL') weaponStatsFinal[weaponName].kills++;
          else weaponStatsFinal[weaponName].dbnos++;
        }
      });
    }
    const isRanked = m.matchType === 'competitive' || (m.gameMode || "").includes("competitive");
    if (isRanked) rankedCount++; else normalCount++;

    if (m.tradeStats) {
      totalTeammateKnocks += m.tradeStats.teammateKnocks || 0;
      totalSuppCount += m.tradeStats.suppCount || 0;
      totalTradeKills += m.tradeStats.tradeKills || 0;
      totalRevCount += m.tradeStats.revCount || 0;
      totalBaitCount += m.tradeStats.baitCount || 0;
      totalCoverAttempts += m.tradeStats.coverRateSampleCount || 0;
      totalCoverSuccess += (m.tradeStats.coverRate > 0 ? Math.round((m.tradeStats.coverRate / 100) * (m.tradeStats.coverRateSampleCount || 1)) : 0);
      if (m.tradeStats.tradeLatencyMs > 0) backupLatencies.push(m.tradeStats.tradeLatencyMs);
      if (m.tradeStats.reactionLatencyMs > 0) reactionLatencies.push(m.tradeStats.reactionLatencyMs);
    }

    totalRescueSmokes += m.tradeStats?.smokeCount || 0;
    // [V55.1 FIX] m.itemUseStats 대신 m.itemUseSummary.smokes를 참조하여 M79 포함 전체 연막 사용량 정확히 집계
    totalSmokes += (m.itemUseSummary?.smokes || m.tradeStats?.smokeCount || 0);
    totalSmokeRescues += m.tradeStats?.smokeRescues || 0;

    if (m.initiativeSampleCount !== undefined) {
      totalInitiativeAttempts += m.initiativeSampleCount;
      totalInitiativeSuccess += Math.round(((m.initiative_rate || 0) / 100) * m.initiativeSampleCount);
    }

    if (m.isolationData) {
      if (m.isolationData.isCrossfire) totalCrossfireCount++;
      totalIsolationIndexFinal += (m.isolationData.isolationIndex || 0);
      totalCombatIso += (m.isolationData.combatIsolation || 0);
      totalDeathIso += (m.isolationData.deathIsolation || 0);
      totalMinDist += (m.isolationData.minDist || 0);
      totalHeightDiff += (m.isolationData.heightDiff || 0);
      totalTeammateCountFinal += (m.isolationData.teammateCount || 1);
      isolationCountFinal++;
    }

    if (m.duelStats) {
      totalDuelWins += m.duelStats.wins || 0;
      totalDuelLosses += m.duelStats.losses || 0;
      totalReversalWins += m.duelStats.reversals || 0;
      totalReversalAttempts += Math.max(m.duelStats.reversalAttempts || 0, m.duelStats.reversals || 0);
    }
    if (m.combatPressure?.utilityStats) {
      const u = m.combatPressure.utilityStats;
      const lethalThrowCount = u.lethalThrowCount
        ?? m.itemUseStats?.lethalThrowCount
        ?? ((m.itemUseSummary?.frags || 0) + (m.itemUseSummary?.molotovs || 0));
      totalUtilityThrows += u.throwCount || 0;
      totalUtilityHits += Math.min(Number(u.hitCount || 0), Number(lethalThrowCount || 0));
      totalUtilityDamage += u.totalDamage || 0;
      totalUtilityKills += u.killCount || 0;
    }
    totalMaxHitDist = Math.max(totalMaxHitDist, m.combatPressure?.maxHitDistance || 0);
    totalTeamWipes += m.tradeStats?.enemyTeamWipes || 0;

    if (m.goldenTimeDamage) {
      goldenTimeFinal.early += (m.goldenTimeDamage.early || 0);
      goldenTimeFinal.mid1 += (m.goldenTimeDamage.mid1 || 0);
      goldenTimeFinal.mid2 += (m.goldenTimeDamage.mid2 || 0);
      goldenTimeFinal.late += (m.goldenTimeDamage.late || 0);
    }

    if (m.killContribution) {
      killContribFinal.solo += (m.killContribution.solo || 0);
      killContribFinal.cleanup += (m.killContribution.cleanup || 0);
      killContribFinal.assist += (m.killContribution.assist || 0); // [V66.0] 팀원 기여 킬 누산 추가
    }

    totalKills += (m.stats?.kills || 0);
    totalDamage += (m.stats?.processedDamageDealt ?? m.stats?.damageDealt ?? 0);
    totalDamageImpact += (m.teamImpact?.damageImpact || 0);
    totalTeamDamageShare += (m.teamImpact?.teamDamageShare || 0);
    totalTeamKillShare += (m.teamImpact?.teamKillShare || 0);
    if (m.badges) allBadges.push(...m.badges);

    totalDeathPhase += (m.deathPhase || 0);
    totalBluezoneWaste += (m.bluezoneWaste || 0);

    totalFocusFireCount += (m.itemUseStats?.focusFireCount || 0);
    totalCrossfireExposureCount += (m.itemUseStats?.crossfireExposureCount || 0);
    if (m.itemUseStats?.distanceDamage) {
      totalDistanceDamage.short += (m.itemUseStats.distanceDamage.short || 0);
      totalDistanceDamage.mid += (m.itemUseStats.distanceDamage.mid || 0);
      totalDistanceDamage.long += (m.itemUseStats.distanceDamage.long || 0);
    }

    // [V42.1] 자기장 지표 합산 로직 복구 (전장 통제자 칭호 정확도 향상)
    totalEdgePlay += (m.edgePlay || m.zoneStrategy?.edgePlayCount || 0);
    totalFatalDelay += (m.zoneStrategy?.fatalDelayCount || 0);

    // [V30.1] 신규 지표 합산 (탈것/자기장운 제외)
    if (Array.isArray(m.weaponMatchCount)) {
      m.weaponMatchCount.forEach((w: string) => {
        weaponMatchCount[w] = (weaponMatchCount[w] || 0) + 1;
      });
    }

    // [V58.4] 차량 교전 지표 누적 합산 (m.stats 또는 m 직계 필드에서 안전하게 추출)
    const lK = Number(m.stats?.leadShotKills || m.leadShotKills || 0);
    const lKn = Number(m.stats?.leadShotKnocks || m.leadShotKnocks || 0);
    const rK = Number(m.stats?.ridingShotKills || m.ridingShotKills || 0);
    const rKn = Number(m.stats?.ridingShotKnocks || m.ridingShotKnocks || 0);
    const rdK = Number(m.stats?.roadKills || m.roadKills || 0);
    const rdKn = Number(m.stats?.roadKnocks || m.roadKnocks || 0);

    totalLeadShotKills += lK;
    totalLeadShotKnocks += lKn;
    totalRidingShotKills += rK;
    totalRidingShotKnocks += rKn;
    totalRoadKills += rdK;
    totalRoadKnocks += rdKn;

    if ((lK + lKn + rK + rKn + rdK + rdKn) > 0) {
      vehicleCombatMatchCount++;
    }
  });

  const mLen = Math.max(1, matches.length);
  const avgDamage = Math.floor(totalDamage / mLen);
  const avgKills = Number((totalKills / mLen).toFixed(1));
  const avgDamageImpact = Number((totalDamageImpact / mLen).toFixed(1));
  const avgTeamDamageShare = Number((totalTeamDamageShare / mLen).toFixed(1));
  const avgTeamKillShare = Number((totalTeamKillShare / mLen).toFixed(1));

  const badgeCounts: Record<string, number> = {};
  allBadges.forEach((b: any) => { if (b?.name) badgeCounts[b.name] = (badgeCounts[b.name] || 0) + 1; });
  const topBadges = Object.entries(badgeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name}(${count}회)`).join(", ");

  const userInitiativeRate = totalInitiativeAttempts > 0 ? Math.round((totalInitiativeSuccess / totalInitiativeAttempts) * 100) : -1;
  const userReversalRate = totalReversalAttempts > 0 ? Math.round((totalReversalWins / totalReversalAttempts) * 100) : -1;
  const avgBackupLatency = backupLatencies.length > 0 ? (backupLatencies.reduce((a, b) => a + b, 0) / backupLatencies.length / 1000).toFixed(2) + "s" : "측정 불가";
  const avgReactionLatency = reactionLatencies.length > 0 ? (reactionLatencies.reduce((a, b) => a + b, 0) / reactionLatencies.length / 1000).toFixed(2) + "s" : "측정 불가";
  const avgCoverRate = totalCoverAttempts > 0 ? Math.round((totalCoverSuccess / totalCoverAttempts) * 100) : 0;
  const totalDuels = totalDuelWins + totalDuelLosses;
  const avgDuelWinRate = totalDuels > 0 ? Math.round((totalDuelWins / totalDuels) * 100) : 0;
  const avgDeathPhase = mLen > 0 ? Number((totalDeathPhase / mLen).toFixed(1)) : 0;
  const avgPressureIndex = Number((matches.reduce((acc: number, m: any) => acc + (m.combatPressure?.pressureIndex || 0), 0) / mLen).toFixed(2));
  const totalLethalThrows = matches.reduce((acc: number, m: any) => {
    const lethalThrowCount = m.combatPressure?.utilityStats?.lethalThrowCount
      ?? m.itemUseStats?.lethalThrowCount
      ?? ((m.itemUseSummary?.frags || 0) + (m.itemUseSummary?.molotovs || 0));
    return acc + Number(lethalThrowCount || 0);
  }, 0);
  const avgUtilityEfficiency = totalLethalThrows > 0 ? Math.round(totalUtilityDamage / totalLethalThrows) : 0;

  const avgMinDistStr = isolationCountFinal > 0 ? (totalMinDist / isolationCountFinal).toFixed(1) + "m" : "N/A";
  const avgHeightDiffStr = isolationCountFinal > 0 ? (totalHeightDiff / isolationCountFinal).toFixed(1) + "m" : "N/A";
  const avgIsolationStr = isolationCountFinal > 0 ? (totalIsolationIndexFinal / isolationCountFinal).toFixed(1) : "0.0";

  const goldenTimeAvg = {
    early: Math.round(goldenTimeFinal.early / mLen),
    mid1: Math.round(goldenTimeFinal.mid1 / mLen),
    mid2: Math.round(goldenTimeFinal.mid2 / mLen),
    late: Math.round(goldenTimeFinal.late / mLen),
  };

  // [V66.0] 분모에 assist(팀원 개입 킬) 포함 — ingest/route.ts의 solo_kill_rate 산출 방식과 동일하게 보정
  const totalKillContrib = killContribFinal.solo + killContribFinal.cleanup + killContribFinal.assist;
  const soloKillRate = totalKillContrib > 0 ? Math.round((killContribFinal.solo / totalKillContrib) * 100) : 0;

  const matchTimes = matches.map((m: any) => {
    const d = new Date(m.createdAt || Date.now());
    return isNaN(d.getTime()) ? Date.now() : d.getTime();
  });
  const latestMatchTime = matchTimes.length > 0 ? new Date(Math.max(...matchTimes)).toISOString() : new Date().toISOString();

  return {
    mLen, avgDamage, avgKills, avgDamageImpact, avgTeamDamageShare, avgTeamKillShare, topBadges,
    userInitiativeRate, userReversalRate, avgBackupLatency, avgReactionLatency, avgCoverRate, avgDuelWinRate,
    totalDuelWins, totalDuelLosses, totalReversalWins, totalReversalAttempts, avgDeathPhase,
    avgPressureIndex, totalLethalThrows, totalUtilityThrows, avgUtilityEfficiency, avgMinDistStr, avgHeightDiffStr,
    avgIsolationStr, goldenTimeAvg, soloKillRate, latestMatchTime, killContribFinal,
    rankedCount, normalCount, totalTeammateKnocks, totalSuppCount, totalTradeKills, totalRevCount,
    totalBaitCount, totalSmokeCount: totalRescueSmokes, totalEdgePlay, totalFatalDelay,
    totalMaxHitDist, totalTeamWipes, isolationCountFinal, totalIsolationIndexFinal, totalCombatIso,
    totalDeathIso, totalMinDist, totalHeightDiff, totalCrossfireCount, totalTeammateCountFinal,
    totalUtilityHits, totalUtilityDamage, totalUtilityKills, totalBluezoneWaste,
    weaponStatsFinal, totalInitiativeAttempts, totalInitiativeSuccess, totalSmokeRescues,
    totalFocusFireCount, totalCrossfireExposureCount, totalDistanceDamage,
    avgDistanceDamage: {
      short: Math.round(totalDistanceDamage.short / mLen),
      mid: Math.round(totalDistanceDamage.mid / mLen),
      long: Math.round(totalDistanceDamage.long / mLen),
    },
    totalSmokes,
    itemUseSummary: { smokes: totalSmokes },
    weaponMatchCount,
    // [V58.4] 차량 고정밀 교전 지표 누적 반환
    totalLeadShotKills,
    totalLeadShotKnocks,
    totalRidingShotKills,
    totalRidingShotKnocks,
    totalRoadKills,
    totalRoadKnocks,
    vehicleCombatMatchCount
  };
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let authenticatedUserId: string | undefined;
  let requestedPlatform = "steam";
  try {
    // 🔒 [보안] JWT 인증 가드 — 로그인된 사용자만 AI 요약 실행 허용 (Gemini API 비용 방어)
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { supabaseAdmin: supabase } = auth;
    authenticatedUserId = auth.user?.id;

    const { matchIds, nickname, platform = "steam", force = false } = await request.json();
    requestedPlatform = String(platform || "steam");
    const lowerNickname = normalizeName(nickname);
    const cachePlatform = normalizePlatform(platform);

    if (!Array.isArray(matchIds) || matchIds.length === 0) {
      trackAiFailure(authenticatedUserId, "summary", "No matches", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "No matches" }, { status: 400 });
    }
    if (!nickname) {
      trackAiFailure(authenticatedUserId, "summary", "Missing nickname", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing nickname" }, { status: 400 });
    }

    // [V45.3] 10개의 유효한 분석 데이터를 확보하기 위해 조회 범위를 25개로 확장 (이벤트/아케이드 필터링 대비)
    const targetMatchIds = matchIds
      .slice(0, 25)
      .map((id: unknown) => id === null || id === undefined ? "" : String(id).trim())
      .filter(Boolean);
    const normalizedTargetMatchIds = targetMatchIds
      .map((id: string) => normalizeMatchId(id))
      .filter((id): id is string => Boolean(id));
    const searchMatchIds = Array.from(new Set([...targetMatchIds, ...normalizedTargetMatchIds])).filter(Boolean);
    const requestedIndexByCanonicalId = new Map<string, number>();
    targetMatchIds.forEach((rawId: string, index: number) => {
      const canonicalId = normalizeMatchId(rawId);
      if (canonicalId && !requestedIndexByCanonicalId.has(canonicalId)) requestedIndexByCanonicalId.set(canonicalId, index);
    });

    let cachedMatches: any[] = [];
    try {
      const processedResult = await supabase.from("processed_match_telemetry")
        .select("match_id, data")
        .in("match_id", searchMatchIds)
        .eq("platform", cachePlatform)
        .eq("player_id", lowerNickname)
        .limit(searchMatchIds.length || 1);
      cachedMatches = processedResult.data || [];
      if (processedResult.error) {
        console.warn("[AI-SUMMARY] Processed match lookup returned an error:", processedResult.error);
      }
    } catch (dbErr) {
      console.warn("[AI-SUMMARY] Processed match lookup failed:", dbErr);
    }

    const cachedMap = new Map();
    const cachedResults: any[] = [];
    if (cachedMatches) {
      cachedMatches.forEach(m => {
        const fullResult = getValidFullResult(m, lowerNickname, cachePlatform)
          || getValidFullResult({ data: { fullResult: m?.data } }, lowerNickname, cachePlatform);
        // [ISR V1.0] RESULT_VERSION 비교 로직 소각 — 캐시 무효화는 revalidateTag가 전담
        // 완료된 매치는 결과가 고정이므로 새로고침(force) 시에도 DB 캐시를 100% 재사용
        if (fullResult) {
          const storageId = normalizeMatchId(m?.match_id);
          const embeddedId = normalizeMatchId(fullResult.matchId ?? fullResult.match_id ?? fullResult.id);
          if (storageId && embeddedId && storageId !== embeddedId) {
            console.warn(`[AI-SUMMARY] Ignored processed row with mismatched IDs: ${m?.match_id}/${embeddedId}`);
            return;
          }
          const pureId = storageId || embeddedId;
          if (!pureId) return;
          const normalizedData = {
            ...fullResult,
            matchId: pureId,
            createdAt: fullResult.createdAt || fullResult.matchInfo?.date || m.created_at || m.updated_at || m.data?.createdAt || m.data?.created_at,
            matchType: fullResult.matchType || fullResult.matchInfo?.matchType || m.match_type || m.data?.matchType || m.data?.match_type,
            gameMode: fullResult.gameMode || fullResult.matchInfo?.mode || m.game_mode || m.data?.gameMode || m.data?.game_mode,
            mapName: fullResult.mapName || fullResult.matchInfo?.mapId || fullResult.matchInfo?.map || m.map_name || m.data?.mapName || m.data?.map_name,
          };
          cachedResults.push(normalizedData);
          cachedMap.set(pureId, normalizedData);
        } else {
          console.warn(`[AI-SUMMARY] Ignored mismatched processed cache row: ${m?.match_id}/${cachePlatform}/${lowerNickname}`);
        }
      });
    }

    const missingMatchIds = targetMatchIds.filter((id: string) => {
      const canonicalId = normalizeMatchId(id);
      return !canonicalId || !cachedMap.has(canonicalId);
    });
    const newResultsMap = new Map();

    if (missingMatchIds.length > 0) {
      const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
      const host = request.headers.get('host') || 'localhost:3000';
      const baseUrl = `${protocol}://${host}`;
      for (let i = 0; i < missingMatchIds.length; i += 2) {
        const batch = missingMatchIds.slice(i, i + 2);
        await Promise.all(batch.map(async (id: string) => {
          try {
            const res = await fetch(`${baseUrl}/api/pubg/match?matchId=${encodeURIComponent(id)}&nickname=${encodeURIComponent(String(nickname))}&platform=${encodeURIComponent(String(platform))}`, { cache: 'no-store' });
            if (res.ok) {
              const data = await res.json();
              const fallbackValue = data?.data?.fullResult || data?.fullResult || data;
              const requestedCanonicalId = normalizeMatchId(id);
              const returnedCanonicalId = normalizeMatchId(
                fallbackValue?.matchId
                  ?? fallbackValue?.match_id
                  ?? fallbackValue?.id
                  ?? data?.matchId
                  ?? data?.match_id
                  ?? data?.id,
              );
              if (!requestedCanonicalId || (returnedCanonicalId && returnedCanonicalId !== requestedCanonicalId)) {
                console.warn(`[AI-SUMMARY] Ignored fallback with mismatched ID: requested=${requestedCanonicalId}, returned=${returnedCanonicalId}`);
                return;
              }
              const normalizedData = fallbackValue && typeof fallbackValue === "object"
                ? { ...fallbackValue, matchId: requestedCanonicalId }
                : null;
              if (!normalizedData || !isFullResultForPlayerPlatform(normalizedData, lowerNickname, cachePlatform)) {
                console.warn(`[AI-SUMMARY] Ignored invalid fallback full result for ${requestedCanonicalId}`);
                return;
              }
              newResultsMap.set(requestedCanonicalId, normalizedData);
            }
          } catch (e) { console.error(`[AI-SUMMARY] Match fetch failed for ${id}:`, e); }
        }));
      }
    }

    const allMatches = [...cachedResults, ...newResultsMap.values()];
    const rawMatches = allMatches;

    const firstValue = (...values: unknown[]): unknown => values.find((value) => value !== undefined && value !== null && value !== "");
    const selectionCandidates: RecentMatchCandidate<any>[] = rawMatches.map((match: any, rawSourceIndex: number) => {
      const rawId = firstValue(match.matchId, match.match_id, match.id);
      const canonicalId = normalizeMatchId(rawId);
      const requestedIndex = canonicalId ? requestedIndexByCanonicalId.get(canonicalId) : undefined;
      return {
        id: typeof rawId === "string" ? rawId : canonicalId,
        createdAt: firstValue(match.createdAt, match.created_at, match.date, match.matchInfo?.date)?.toString() || null,
        matchType: firstValue(match.matchType, match.match_type, match.matchInfo?.matchType)?.toString() || null,
        gameMode: firstValue(match.gameMode, match.game_mode, match.mode, match.matchInfo?.mode)?.toString() || null,
        mapName: firstValue(match.mapName, match.map_name, match.map, match.matchInfo?.mapId, match.matchInfo?.map)?.toString() || null,
        sourceIndex: requestedIndex === undefined ? rawSourceIndex : requestedIndex,
        value: canonicalId ? { ...match, matchId: canonicalId } : match,
      };
    }).filter((candidate): candidate is RecentMatchCandidate<any> => Boolean(candidate.id));

    // A request can still have a reusable summary-cache entry even when the
    // processed table is empty/unavailable and every fallback fetch misses.
    // Keep request IDs as metadata-only candidates for that lookup, but never
    // let those placeholders reach Gemini (the full-result gate below blocks
    // generation/upsert on a cache miss).
    const metadataOnlySelection = selectionCandidates.length === 0
      && cachedResults.length === 0
      && newResultsMap.size === 0;
    if (metadataOnlySelection) {
      targetMatchIds.forEach((id: string, sourceIndex: number) => {
        if (!normalizeMatchId(id)) return;
        selectionCandidates.push({
          id,
          createdAt: null,
          matchType: null,
          gameMode: null,
          mapName: null,
          sourceIndex,
          value: { matchId: normalizeMatchId(id) },
        });
      });
    }

    const selection = selectRecentMatches(selectionCandidates, {
      limit: 10,
      selectionVersion: RECENT_MATCH_SELECTION_VERSION,
    });
    const selectedMatches = selection.selected.map(({ value }) => value);
    const selectedFullResults = selectedMatches.filter((match: any) => (
      isFullResultForPlayerPlatform(match, lowerNickname, cachePlatform)
    ));
    const selectionKey = buildMatchSelectionKey(
      selection.selected.map(({ id }) => id),
      selection.selectionVersion,
    );
    const matchIdsHash = crypto
      .createHash("sha256")
      .update(AI_CACHE_VERSION + "\n" + selectionKey)
      .digest("hex");

    if (selectedMatches.length === 0) {
      return NextResponse.json({ error: "유효한 전술 분석 데이터가 없습니다. (이벤트/아케이드 모드 제외)" }, { status: 400 });
    }

    // Hash/cache lookup is deliberately after selection. `force` skips this
    // read only; it does not alter fallback fetching or selection semantics.
    if (!force) {
      try {
        const { data: cached, error: cacheErr } = await supabase
          .from("player_ai_summary_cache")
          .select("ai_result")
          .eq("player_id", lowerNickname)
          .eq("platform", cachePlatform)
          .eq("match_ids_hash", matchIdsHash)
          .eq("prompt_version", AI_CACHE_VERSION)
          .maybeSingle();

        if (!cacheErr && cached && cached.ai_result) {
          trackAiUsage(authenticatedUserId, "gemini-cache", 0, 0, "summary", {
            durationMs: Date.now() - startedAt,
            requestId,
            platform: requestedPlatform,
          });
          const cachedData = cached.ai_result as any;
          const sanitizedFinal = sanitizeAiCoachingLanguageText(String(cachedData.final || ""));
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ type: "visuals", data: cachedData.visuals }) + "\n"));
              controller.enqueue(encoder.encode(JSON.stringify({ type: "final", data: sanitizedFinal }) + "\n"));
              controller.enqueue(encoder.encode(JSON.stringify({ type: "done", valid: true }) + "\n"));
              controller.close();
            }
          });
          return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
        }
      } catch (dbErr) {
        console.warn("[AI-SUMMARY] Cache lookup failed:", dbErr);
      }
    }

    // Do not invoke Gemini when no match payload was available. The
    // metadata-only branch above exists solely to preserve cache-only reads.
    if (metadataOnlySelection) {
      return NextResponse.json({ error: "유효한 전술 분석 데이터가 없습니다. (매치 데이터를 불러오지 못했습니다.)" }, { status: 400 });
    }

    if (selectedFullResults.length === 0) {
      return NextResponse.json({ error: "유효한 전술 분석 데이터가 없습니다. (매치 결과가 없습니다.)" }, { status: 400 });
    }

    const geminiApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!geminiApiKey) {
      trackAiFailure(authenticatedUserId, "summary", "No API Key", { errorCode: "configuration", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "No API Key" }, { status: 500 });
    }

    const { data: userBenchmarks } = await supabase
      .from("global_benchmarks")
      .select("*")
      .eq("platform", cachePlatform)
      .ilike("player_id", lowerNickname)
      .order("created_at", { ascending: false })
      .limit(50);

    const summaryStats = aggregateMatches(selectedMatches);
    const masteryStats = aggregateMatches(selectedMatches);

    const {
      latestMatchTime, avgBackupLatency, avgReactionLatency, userInitiativeRate, avgPressureIndex,
      totalReversalAttempts, totalReversalWins, avgDuelWinRate, totalDuelWins, totalDuelLosses,
      avgDamageImpact, topBadges, goldenTimeAvg, killContribFinal, avgDeathPhase, totalBluezoneWaste, mLen,
      totalTeammateKnocks, totalSuppCount, totalTradeKills, totalRevCount,
      totalBaitCount,
      isolationCountFinal, totalIsolationIndexFinal, totalMinDist, totalHeightDiff, totalCrossfireCount, totalTeammateCountFinal,
      rankedCount, normalCount,
      totalInitiativeAttempts, totalInitiativeSuccess, totalSmokeRescues,
      totalSmokes
    } = masteryStats;

    const groups: Record<string, any[]> = { solo: [], duo: [], squad: [], 'solo-duo': [], 'solo-squad': [] };
    selectedMatches.forEach((m: any) => {
      if (!m.matchId && m.id) m.matchId = m.id;
      if (!m.matchId && m.match_id) m.matchId = m.match_id;

      const gm = m.gameMode || "squad";
      if (gm === 'solo-squad') groups['solo-squad'].push(m);
      else if (gm === 'solo-duo') groups['solo-duo'].push(m);
      else if (gm.includes('solo')) groups.solo.push(m);
      else if (gm.includes('duo')) groups.duo.push(m);
      else groups.squad.push(m);
    });
    const mainModeName = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length)[0];
    const mainModeCount = groups[mainModeName].length;
    const tierConfidence = mainModeCount >= 7 ? '높음' : mainModeCount >= 3 ? '보통' : '낮음 (데이터 부족)';
    const isCompetitiveFocus = rankedCount >= normalCount;
    const isSoloSquadFocus = mainModeName.includes('solo-squad') || mainModeName.includes('solo-duo');

    const MAP_DISPLAY_NAMES: Record<string, string> = {
      Baltic_Main: '에란겔', Desert_Main: '미라마', Savage_Main: '사녹',
      Tiger_Main: '태이고', Neon_Main: '론도', Kiki_Main: '데스턴',
      Summerland_Main: '칼린도', Heaven_Main: '헤이븐'
    };
    const mapGroups: Record<string, any[]> = {};
    selectedMatches.forEach((m: any) => {
      const mapKey = m.mapName || 'Unknown';
      if (!mapGroups[mapKey]) mapGroups[mapKey] = [];
      mapGroups[mapKey].push(m);
    });
    const mapStatsList = Object.entries(mapGroups)
      .filter(([, matches]) => matches.length >= 2)
      .map(([mapName, matches]) => {
        const s = aggregateMatches(matches);
        return {
          mapName,
          displayName: MAP_DISPLAY_NAMES[mapName] || mapName,
          matchCount: matches.length,
          avgDamage: Math.round(s.avgDamage),
          avgKills: Number(s.avgKills.toFixed(1)),
          avgDeathPhase: Number(s.avgDeathPhase.toFixed(1)),
        };
      })
      .sort((a, b) => b.avgDamage - a.avgDamage);
    const mapStatsResult = mapStatsList.length >= 2 ? {
      list: mapStatsList,
      bestMap: mapStatsList[0],
      worstMap: mapStatsList[mapStatsList.length - 1],
    } : null;

    const promptLines = [
      `당신들은 PUBG [${isSoloSquadFocus ? '극한의 솔로 챌린저' : (isCompetitiveFocus ? '프로급 경쟁전' : '일반전 전술')}] 분석 데스크의 전문 코치입니다. 전달받은 경기 데이터와 'Benchmark(엘리트 지표)'를 바탕으로 끝장 토론을 진행하십시오.`,
      isSoloSquadFocus
        ? "1. KIND COACH: 혼자서 다수를 상대하는 유저의 용기와 교전 능력을 극찬하십시오. 팀플레이 지표가 낮은 것은 당연한 것이니 무시하고, '고독한 사냥꾼'으로서의 면모를 부각하십시오."
        : "1. KIND COACH: 유저의 강력한 화력 공헌(1선 격수로서의 교전 지표, 딜량 비중 등)을 적극 옹호하고, 팀플레이 지표나 백업 속도가 부족하더라도 '팀의 화력을 책임지는 1선 에이스로서 당연히 짊어져야 할 역할'이라며 강하게 쉴드치고 동기부여를 제공하십시오.",
      isSoloSquadFocus
        ? "2. SPICY BOMBER: 솔로 스쿼드라는 핑계 뒤에 숨은 피지컬의 한계를 지적하십시오. '혼자 들어갔으면 전멸을 시켰어야지', '기절만 시키고 확킬을 못 내는 것은 실력 부족'이라며 더 높은 화력을 요구하십시오."
        : `2. SPICY BOMBER: 유저의 지표가 상위권(엘리트) 지표보다 미달하는 부분을 냉혹하게 찌르십시오. ${isCompetitiveFocus ? '[경쟁전 룰셋]을 고려해 보완 우선순위를 분명히 제시하십시오.' : '[일반전] 데이터임을 감안해도 개선해야 할 지표를 분명히 제시하십시오.'} 수치 격차를 강하게 말하되 팀원 의도, 팀원 수준, 유저의 심리나 오만은 단정하지 마십시오.`,
      "- [STRICT KOREAN] 모든 응답에서 'DUO', 'SQUAD', 'SOLO', 'Benchmark'와 같은 영문 용어를 절대 사용하지 마십시오. 반드시 '듀오', '스쿼드', '솔로', '상위권 지표' 또는 '벤치마크'와 같은 한글 용어로 대체하여 출력하십시오.",
      "- [INTELLIGENT ANALYSIS] 유저의 승률이나 딜량이 상위권 지표를 압도한다면, SPICY BOMBER조차도 \"피지컬은 괴물이지만...\" 이라는 식으로 실력 자체는 인정하며 시작해야 합니다. 무조건적인 비난은 '멍청한 AI'처럼 보입니다.",
      "- [ZERO HALLUCINATION] 데이터에 명시된 숫자를 1%의 오차도 없이 그대로 인용하십시오. 상위권 지표를 인용할 때는 반드시 정확한 소수점까지 포함하십시오.",
      "- [UTILITY LOGIC] 투척물은 '연막/섬광 등 비피해형'과 '수류탄/화염병/C4 등 피해형'을 엄격히 구분하십시오. 총 투척 중 연막/비피해형 비중이 높다면 '피해형 투척 적중 0회'라고 뭉뚱그려 비난하지 말고, '투척물의 대부분(N회)을 연막 등 생존/엄폐용으로 적극 활용했으며 공격형 투척 시도는 적었다'고 분리해 설명하십시오.",
      "- [BENCHMARK COMPARISON GUARD] debateIssues의 userStats/benchmarkStats에는 프롬프트에 명시된 상위권 벤치마크 수치가 존재하는 지표만 대조하십시오. 'Benchmark N/A'나 'N/A'를 출력하는 것을 엄격히 금지합니다. 연막 구출률, 1:1 승률, 대응 사격 속도, 백업 속도 등 상위권 평균이 존재하는 지표로만 1:1 대칭을 구성하십시오.",
      "- [BACKUP OUTCOME LOGIC] 백업 속도는 시간 단독으로 평가하지 말고, 적 제압/팀 전멸 기여/소생/연막 구출 결과를 함께 판단하십시오. 결과가 성공한 긴 백업은 '느린 백업'으로 단정하지 말고 '교전 정리 후 복구 성공'과 '복구 시간 단축 과제'를 분리해 말하십시오.",
      "- [MATCH IMPACT LOGIC] 매치 임팩트가 '하드캐리' 또는 '레전드'인 경기는 단일 경기 하이라이트 성과로 인정하십시오. 낮은 세부 지표를 지적하더라도 판 전체를 실패로 단정하지 말고, 강한 성과와 보완점을 분리하십시오.",
      "- [WIN CONTRIBUTION LOGIC] 1등 자체는 생존 결과입니다. '1등 보너스'라고 표현하지 말고, 화력 캐리/복구 기여/결정적 마무리/승리 기여 근거처럼 행동 기반 근거만 사용하십시오.",
      "- [LOW ISOLATION LOGIC] 고립 지수가 2.0 미만이면 양호한 대열 유지로 해석하십시오. 이 경우 '너무 멀리', '독단적인 플레이', '고립될 위험', '고립 위험이 높다' 같은 표현은 부정문에서도 쓰지 마십시오.",
      "- [TEAM INTENT GUARD] 높은 딜량 비중은 '강한 교전 주도' 또는 '화력 분담 보완 필요'로 해석하십시오. 데이터에 명시된 미끼/방치/소생 실패 근거가 없으면 '팀원을 방패', '팀원을 들러리', '팀원을 방치', '혼자 다 해먹', '미끼' 같은 의도 단정 표현을 쓰지 마십시오.",
      "- [TEAM DISMISSAL GUARD] 팀원을 낮춰 부르는 표현은 금지입니다. '팀 지원 지표가 바닥', '나머지 팀원들의 화력 지원이 전무', '팀 전체가 휘청', '존재감이 희미' 대신 '팀 지원 지표 보완', '화력 분담 보완', '교전 기여를 더 선명하게 만들 필요'라고 표현하십시오.",
      "- [OUTPUT SELF CHECK] JSON을 작성한 뒤 signatureSub/finalVerdict/debateIssues/actionItems에 '혼자서 모든 것을 해결', '팀원들의 지원이 부족하다는 방증', '혼자 다 해먹', '팀 민폐', '오만' 같은 표현이 있으면 응답하기 전에 반드시 '강한 교전 주도와 화력 분담 보완 필요'로 고치십시오.",
      "- [DATA COMPARISON] 모든 피드백 항목에서 (내 수치 vs 상위권 수치) 형식을 사용하여 유저가 객관적인 실력 차이를 체감하게 하십시오.",
      "- debateIssues는 반드시 3개를 작성하고, 각 issue의 userStats/benchmarkStats는 항목명(label)과 값의 단위(%, 회, m 등)가 완벽히 대칭되어야 합니다.",
      "반드시 아래 구조의 JSON 객체로만 응답하세요.",
      "{",
      '  "signature": "칭호", "signatureSub": "이유",',
      '  "finalVerdict": "전술적 정체성과 취약점을 포함한 종합 판정 (2~3문장)",',
      '  "debateIssues": [',
      '    {',
      '      "topic": "주제",',
      '      "question": "질문",',
      '      "spicyOpinion": "매운맛 의견",',
      '      "kindOpinion": "순한맛 의견",',
      '      "winner": "승자 (반드시 \"spicy\" 또는 \"kind\" 중 하나만 선택)",',
      '      "reason": "근거",',
      '      "evaluation": "종합 평가",',
      '      "userStats": [ { "label": "항목", "value": "값" } ],',
      '      "benchmarkStats": [ { "label": "항목", "value": "값" } ]',
      '    }',
      '  ],',
      '  "actionItems": [ { "icon": "🎯", "title": "목표", "desc": "구체적인 실천 팁" } ]',
      "}"
    ];

    function getGoldenTimePattern(g: any): string {
      if (!g) return "데이터 부족";
      if (g.early > g.mid1 && g.early > g.mid2) return "핫드랍형 (초반 집중)";
      if (g.late > g.early && g.late > g.mid1) return "생존형 (후반 집중)";
      if (g.mid1 + g.mid2 > g.early + g.late) return "중반 교전형";
      return "균형형";
    }

    function selectDebateTopics(stats: any, bench: any): string[] {
      if (!stats || !bench) return ["화력", "교전 주도권", "포지셔닝"];
      
      const userTradeRate = stats.totalTeammateKnocks > 0 ? (stats.totalTradeKills / stats.totalTeammateKnocks) * 100 : 0;
      const tradeRateGap = Math.abs(userTradeRate - (bench.avgTradeRate || 30)) / 100;
      
      const userBackupLatency = parseFloat(stats.avgBackupLatency || "15");
      const backupContext = buildBackupCoachingContext({
        avgBackupLatency: stats.avgBackupLatency,
        totalTradeKills: stats.totalTradeKills,
        totalRevCount: stats.totalRevCount,
        totalSmokeRescues: stats.totalSmokeRescues,
        totalTeamWipes: stats.totalTeamWipes,
        totalTeammateKnocks: stats.totalTeammateKnocks,
        benchmarkTradeLatency: bench.avgTradeLatency,
      });
      const backupLatencyGap = isNaN(userBackupLatency) || backupContext.shouldAvoidSlowBackupBlame
        ? 0
        : Math.min(1.0, Math.abs(userBackupLatency - (bench.avgTradeLatency || 12)) / 20);
      
      const tradeAndBackupGap = Math.max(tradeRateGap, backupLatencyGap);

      const issues = [
        { topic: "화력", gap: Math.abs(stats.avgDamage - (bench.avgDamage || 200)) / Math.max(bench.avgDamage || 200, 1) },
        { topic: "교전 주도권", gap: Math.abs(stats.userInitiativeRate - (bench.avgInitiativeRate || 40)) / 100 },
        { topic: "1:1 결정력", gap: Math.abs(stats.avgDuelWinRate - (bench.avgDuelWinRate || 50)) / 100 },
        { topic: "유틸리티 활용", gap: stats.totalUtilityThrows < 5 ? 0.4 : 0.1 },
        { topic: "포지셔닝", gap: parseFloat(stats.avgIsolationStr) > 3.5 ? 0.35 : 0.05 },
        { topic: "복수 성공률 및 백업", gap: tradeAndBackupGap }
      ];
      return issues.sort((a, b) => b.gap - a.gap).slice(0, 3).map(i => i.topic);
    }

    let userPrompt = `- 분석 대상: 최근 유효 ${summaryStats.mLen}경기 (랭크 매치: ${summaryStats.rankedCount}판 포함)\n`;
    userPrompt += `- 분석 기준: 선택된 유효 경기 전체를 바탕으로 잠재력 및 보완점 분석\n`;
    userPrompt += `- 주력 모드: ${mainModeName.toUpperCase()} (신뢰도: ${tierConfidence}, 기반: ${summaryStats.mLen}판)\n`;
    const impactHighlights = selectedMatches
      .filter((match: any) => match.benchmark?.impactScore)
      .slice(0, 3);
    if (impactHighlights.length > 0) {
      userPrompt += `\n### [매치 임팩트 하이라이트]\n`;
      impactHighlights.forEach((match: any, index: number) => {
        const impactReasons = Array.isArray(match.benchmark?.impactReasons) && match.benchmark.impactReasons.length > 0
          ? match.benchmark.impactReasons.slice(0, 3).join(", ")
          : "근거 없음";
        userPrompt += `- ${index + 1}. 전술 안정도 ${match.benchmark.score}/100, 매치 임팩트 ${match.benchmark.impactScore} (${match.benchmark.impactGrade || "NORMAL"}), 근거: ${impactReasons}\n`;
      });
    }

    // [V58.4] 차량 전투 종합 성과 공급
    const totalVehicleKnocks = (summaryStats.totalLeadShotKnocks || 0) + (summaryStats.totalRidingShotKnocks || 0) + (summaryStats.totalRoadKnocks || 0);
    const totalVehicleKills = (summaryStats.totalLeadShotKills || 0) + (summaryStats.totalRidingShotKills || 0) + (summaryStats.totalRoadKills || 0);
    if (totalVehicleKnocks > 0 || totalVehicleKills > 0) {
      userPrompt += `\n### [차량 전투 성과 (V58.4)] (고정밀 드라이브바이/무빙타겟 헌팅 및 로드킬)\n`;
      userPrompt += `- 리드샷 (무빙 차량 표적 사격): 기절 ${summaryStats.totalLeadShotKnocks || 0}회, 킬 ${summaryStats.totalLeadShotKills || 0}회\n`;
      userPrompt += `- 라이딩샷 (주행 차량 탑승 사격): 기절 ${summaryStats.totalRidingShotKnocks || 0}회, 킬 ${summaryStats.totalRidingShotKills || 0}회\n`;
      userPrompt += `- 로드킬 (차량 충돌): 기절 ${summaryStats.totalRoadKnocks || 0}회, 킬 ${summaryStats.totalRoadKills || 0}회\n`;
      userPrompt += `- 코칭 가이드라인: 이 플레이어는 고난도의 차량 전투 및 로드킬 지표가 뛰어난 플레이어입니다. SPICY BOMBER와 KIND COACH 모두 드라이브바이 사격 성공, 리드샷 결정력, 그리고 로드킬의 전술적 의미를 극찬하거나 보완점으로 강조하여 분석에 웅장하고 미려하게 녹여내야 합니다.\n`;
    }

    if (goldenTimeAvg) {
      const smokeRescueRate = summaryStats.totalSmokeCount > 0 ? Math.round((summaryStats.totalSmokeRescues / summaryStats.totalSmokeCount) * 100) : 0;
      const smokeOpportunityRate = summaryStats.totalTeammateKnocks > 0 ? Math.round((summaryStats.totalSmokeRescues / summaryStats.totalTeammateKnocks) * 100) : 0;
      userPrompt += `\n### [전술 지표 분석]\n`;
      userPrompt += `- 교전 타이밍(GoldenTime): ${getGoldenTimePattern(summaryStats.goldenTimeAvg)}\n`;
      userPrompt += `- 평균 백업 속도(Trade): ${summaryStats.avgBackupLatency} (아군 기절 시 적 제압 시간)\n`;
      userPrompt += `- 백업 결과 해석: ${buildBackupCoachingContext({
        avgBackupLatency: summaryStats.avgBackupLatency,
        totalTradeKills: summaryStats.totalTradeKills,
        totalRevCount: summaryStats.totalRevCount,
        totalSmokeRescues: summaryStats.totalSmokeRescues,
        totalTeamWipes: summaryStats.totalTeamWipes,
        totalTeammateKnocks: summaryStats.totalTeammateKnocks,
      }).promptLine}\n`;
      userPrompt += `- 대응 사격 속도(Reaction): ${summaryStats.avgReactionLatency} (피격 시 반격 시간)\n`;
      userPrompt += `- 유틸리티 활용: 총 투척 ${summaryStats.totalUtilityThrows}회 (내 연막 ${summaryStats.totalSmokes}회 사용)\n`;
      userPrompt += `- 개인 전술 구출: 내 구출 연막 성공률 ${smokeRescueRate}% (구출 연막 시도 ${summaryStats.totalSmokeCount}회, 성공 ${summaryStats.totalSmokeRescues}회), 아군 기절 대비 연막 구출률 ${smokeOpportunityRate}%\n`;
    }

    let trendsData = null;
    const matchesForTrend = selectedMatches;
    if (matchesForTrend.length >= 6) {
      const recentMatches = matchesForTrend.slice(0, 5);
      const olderMatches = matchesForTrend.slice(5);
      const recentStats = aggregateMatches(recentMatches);
      const olderStats = aggregateMatches(olderMatches);
      if (recentStats && olderStats) {
        const dmgTrend = Math.round(recentStats.avgDamage - olderStats.avgDamage);
        const winTrend = Number((recentStats.avgDuelWinRate - olderStats.avgDuelWinRate).toFixed(1));
        const status = dmgTrend > 50 ? '📈 실력 상승세' : dmgTrend < -50 ? '📉 컨디션 하락세' : '➡️ 안정권 유지';

        trendsData = {
          dmgTrend,
          winTrend,
          status,
          recent: { damage: Math.floor(recentStats.avgDamage), winRate: recentStats.avgDuelWinRate },
          older: { damage: Math.floor(olderStats.avgDamage), winRate: olderStats.avgDuelWinRate }
        };

        userPrompt += `\n### [최근 트렌드 (최근 5판 vs 이전 5판)]\n`;
        userPrompt += `- 딜량 변화: ${Math.floor(olderStats.avgDamage)} → ${Math.floor(recentStats.avgDamage)} (${dmgTrend >= 0 ? '+' : ''}${dmgTrend})\n`;
        userPrompt += `- 교전 승률: ${olderStats.avgDuelWinRate}% → ${recentStats.avgDuelWinRate}% (${winTrend >= 0 ? '+' : ''}${winTrend}%)\n`;
        userPrompt += `- 종합 추세: ${status}\n`;
      }
    }


    let maxMatches = 0;
    let mainUserTier = "C";
    let mainBench: any = null;
    let finalTierBreakdown: any = null;

    for (const [mode, gMatches] of Object.entries(groups)) {
      if (gMatches.length === 0) continue;

      const gMatchIds = gMatches.map((m: any) => m.matchId || m.match_id || m.id).filter(Boolean);

      const combinedScores = gMatchIds.map((id) => {
        if (!id || typeof id !== 'string') return null;
        const normalizedId = id.includes(':') ? id.split(':').pop() : id;

        // 1. DB 벤치마크 매칭
        const dbBench = userBenchmarks?.find(b =>
          b.match_id === id || b.match_id === normalizedId
        );

        // 2. 실시간 분석 데이터 매칭 (Fallback 포함)
        const matchData = selectedMatches.find((m: any) => {
          // [V40.0] 매치 객체 내부 ID 또는 Map에 저장할 때 썼던 ID 모두 체크
          const mId = (m.matchId || m.match_id || m.id);
          const normalizedMId = mId?.includes(':') ? mId.split(':').pop() : mId;
          return mId === id || normalizedMId === normalizedId || normalizedMId === id || mId === normalizedId;
        });

        return {
          combat: (dbBench?.combat_score || matchData?.benchmark?.breakdown?.combat || 0),
          tactical: (dbBench?.tactical_score || matchData?.benchmark?.breakdown?.tactical || 0),
          survival: (dbBench?.survival_score || matchData?.benchmark?.breakdown?.survival || 0),
          score: (dbBench?.score || matchData?.benchmark?.score || 55)
        };
      }).filter(Boolean) as any[];

      const groupScores = combinedScores;

      const validCombat = groupScores.map(s => s.combat).filter(s => s > 0);
      const validTactical = groupScores.map(s => s.tactical).filter(s => s > 0);
      const validSurvival = groupScores.map(s => s.survival).filter(s => s > 0);
      const validScores = groupScores.map(s => s.score);

      const avgScore = validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) / validScores.length : 55;

      const avgBreakdown = {
        combat: validCombat.length > 0 ? Number((validCombat.reduce((a: any, b: any) => a + b, 0) / validCombat.length).toFixed(1)) : 0,
        tactical: validTactical.length > 0 ? Number((validTactical.reduce((a: any, b: any) => a + b, 0) / validTactical.length).toFixed(1)) : 0,
        survival: validSurvival.length > 0 ? Number((validSurvival.reduce((a: any, b: any) => a + b, 0) / validSurvival.length).toFixed(1)) : 0,
        total: Number(avgScore.toFixed(1))
      };

      const groupMatchTypes = gMatches.map(m => (m.matchType || m.match_type || "official").toLowerCase());
      const compCount = groupMatchTypes.filter(t => t.includes("competitive")).length;
      const dominantMatchType = compCount >= gMatches.length / 2 ? "competitive" : "official";

      const userTier = estimateUserTier(avgScore);
      const rawTierStats = await fetchTierBenchmarkStats(supabase, {
        gameMode: mode,
        matchType: dominantMatchType,
        tier: userTier
      });

      const bench = adaptBenchmark(rawTierStats);

      if (gMatches.length > maxMatches) {
        maxMatches = gMatches.length;
        mainUserTier = userTier;
        mainBench = bench;
        finalTierBreakdown = avgBreakdown;
      }

      const gStats = summaryStats;
      userPrompt += `### [${mode.toUpperCase()} 모드 분석] (선택된 최근 ${selectedMatches.length}판 분석)\n`;
      userPrompt += `- 유저 티어: ${userTier}\n- 평균 화력: ${gStats.avgDamage} (동일 티어 Benchmark: ${bench.avgDamage}), 평균 ${gStats.avgKills}킬\n- [선제 공격] 주도권 성공률: ${gStats.userInitiativeRate}% (Benchmark: ${bench.avgInitiativeRate}%)\n`;
      const benchDuelWinRate = bench.avgDuelWinRate;
      userPrompt += `- [교전 결정력] 1:1 교전 승률: ${gStats.avgDuelWinRate}% (Benchmark: ${benchDuelWinRate}%, 승리: ${gStats.totalDuelWins}회, 패배: ${gStats.totalDuelLosses}회, 역전승: ${gStats.totalReversalWins}회)\n- [교전 압박] 평균 압박 지수: ${gStats.avgPressureIndex} (Benchmark: ${bench.avgPressureIndex}), 최대 교전 거리: ${gStats.totalMaxHitDist}m\n`;
      if (mode !== 'solo') {
        const smokeRescueSuccessRate = gStats.totalSmokeCount > 0 ? Math.round((gStats.totalSmokeRescues / gStats.totalSmokeCount) * 100) : 0;
        const smokeRescueOpportunityRate = gStats.totalTeammateKnocks > 0 ? Math.round((gStats.totalSmokeRescues / gStats.totalTeammateKnocks) * 100) : 0;
        userPrompt += `- [팀 내 영향력(딜량/킬 비중)] 적 팀 전멸 기여: ${gStats.totalTeamWipes}회, 화력 집중(점사): ${gStats.totalFocusFireCount}회\n- [개인 팀플레이 기여] 아군 기절 ${gStats.totalTeammateKnocks}회 → 내가 한 소생: ${gStats.totalRevCount}회, 내가 만든 복수(Trade): ${gStats.totalTradeKills}회 (복수 성공률: ${gStats.totalTeammateKnocks > 0 ? Math.round((gStats.totalTradeKills / gStats.totalTeammateKnocks) * 100) : 0}% vs 상위권: ${bench.avgTradeRate}%)\n- [개인 전술 기여] 견제 지원율: ${gStats.totalTeammateKnocks > 0 ? Math.round((gStats.totalSuppCount / gStats.totalTeammateKnocks) * 100) : 0}%, 미끼: ${gStats.totalBaitCount}회, 내 연막 구출 시도/성공: ${gStats.totalSmokeCount}/${gStats.totalSmokeRescues}회, 내 연막 구출 성공률: ${smokeRescueSuccessRate}%, 아군 기절 대비 연막 구출률: ${smokeRescueOpportunityRate}% (상위권 기회 대비 평균: ${bench.avgSmokeRate}%, 내 총 연막 사용: ${gStats.totalSmokes}회)\n`;
      }
      const reactionStr = gStats.avgReactionLatency === "측정 불가"
        ? "측정 불가 (선제 공격 중심 플레이로 피격 후 반격 샘플 없음 — 이 항목을 언급하거나 추론하지 말 것)"
        : `${gStats.avgReactionLatency} (Benchmark: ${bench.avgCounterLatency}s)`;
      const backupStr = gStats.avgBackupLatency === "측정 불가"
        ? "측정 불가 (아군 기절 후 복수 교전 샘플 없음 — 이 항목을 언급하거나 추론하지 말 것)"
        : `${gStats.avgBackupLatency} (Benchmark: ${bench.avgTradeLatency}s)`;
      const backupContext = buildBackupCoachingContext({
        avgBackupLatency: gStats.avgBackupLatency,
        totalTradeKills: gStats.totalTradeKills,
        totalRevCount: gStats.totalRevCount,
        totalSmokeRescues: gStats.totalSmokeRescues,
        totalTeamWipes: gStats.totalTeamWipes,
        totalTeammateKnocks: gStats.totalTeammateKnocks,
        benchmarkTradeLatency: bench.avgTradeLatency,
      });
      userPrompt += `- [반응 속도] 대응 사격 속도: ${reactionStr}, 반격 성공률: ${gStats.totalReversalAttempts > 0 ? Math.round((gStats.totalReversalWins / gStats.totalReversalAttempts) * 100) : 0}%\n- [백업 속도] 아군 백업 속도: ${backupStr}\n- [백업 결과 해석] ${backupContext.promptLine}\n- [생존 환경] 고립 지수(운영/교전/사망): ${gStats.avgIsolationStr}/${gStats.isolationCountFinal > 0 ? (gStats.totalCombatIso / gStats.isolationCountFinal).toFixed(2) : "0"}/${gStats.isolationCountFinal > 0 ? (gStats.totalDeathIso / gStats.isolationCountFinal).toFixed(2) : "0"}, 양각 노출 상황: ${gStats.totalCrossfireExposureCount}회\n- [거리 관리] 팀원과의 평균 거리: ${gStats.avgMinDistStr}, 평균 고도차: ${gStats.avgHeightDiffStr}, 경기당 평균 거리별 데미지(근/중/원): ${gStats.avgDistanceDamage.short}/${gStats.avgDistanceDamage.mid}/${gStats.avgDistanceDamage.long}\n- [킬 분류] 솔로 킬: ${gStats.killContribFinal.solo}회, 클린업 킬: ${gStats.killContribFinal.cleanup}회 (솔로 비중: ${gStats.soloKillRate}% vs Benchmark: ${bench.avgSoloKillRate}%)\n- [유틸리티] 총 투척 ${gStats.totalUtilityThrows}회, 피해형 투척 ${gStats.totalLethalThrows}회, 피해 적중 ${gStats.totalUtilityHits}회, 피해형 투척 딜량 ${Math.round(gStats.totalUtilityDamage / gStats.mLen)} (평균), 연막 ${gStats.totalSmokes}회\n- [운영 패턴] 평균 사망 페이즈: ${gStats.avgDeathPhase} (Benchmark: ${bench.avgDeathPhase}), 자기장 누적 피해: ${Math.round(gStats.totalBluezoneWaste / gStats.mLen)} HP, 엣지(Edge) 플레이: ${gStats.totalEdgePlay}회, 진입 지연: ${gStats.totalFatalDelay}회\n\n`;
      const smokeOpportunityRate = gStats.totalTeammateKnocks > 0 ? Math.round((gStats.totalSmokeRescues / gStats.totalTeammateKnocks) * 100) : 0;
      userPrompt = userPrompt.replace(`- [유틸리티] 총 투척 ${gStats.totalUtilityThrows}회, 피해형 투척 ${gStats.totalLethalThrows}회, 피해 적중 ${gStats.totalUtilityHits}회, 피해형 투척 딜량 ${Math.round(gStats.totalUtilityDamage / gStats.mLen)} (평균), 연막 ${gStats.totalSmokes}회`, `- [유틸리티] 총 투척 ${gStats.totalUtilityThrows}회 (연막 ${gStats.totalSmokes}회, 피해형 ${gStats.totalLethalThrows}회, 피해 적중 ${gStats.totalUtilityHits}회), 아군 기절 대비 연막 구출률: ${smokeOpportunityRate}% (Benchmark: ${bench.avgSmokeRate}%)`);
    }

    if (mainBench) {
      const mainModeStats = aggregateMatches(groups[mainModeName] || []);
      const autoTopics = selectDebateTopics(mainModeStats, mainBench);
      userPrompt += `\n### [분석 집중 영역 (Debate Issues)]\n반드시 아래 3개 주제를 순서대로 다루어 주십시오:\n${autoTopics.map((t, i) => `${i + 1}. ${t}`).join(', ')}\n`;
    }

    const mainModeStats = { ...aggregateMatches(groups[mainModeName] || []), modeDistribution: { main: mainModeName } };
    const roleInfo = classifyRole(mainModeStats, mainBench, mainUserTier);
    userPrompt += `\n### [유저 전술적 정체성]\n- 부여된 칭호: ${roleInfo.title}\n- 전술 직업군: ${roleInfo.roleLabel}\n- 특징 요약: ${roleInfo.description}\n- 주요 취약점: ${roleInfo.weakness || "식별된 약점 없음 (완성형)"}\n- 시그니처 무기: ${roleInfo.signatureWeapon} (${roleInfo.signatureWeaponStats?.kills}킬, ${roleInfo.signatureWeaponStats?.dbnos}기절, 사용 일관성: ${roleInfo.signatureWeaponStats?.consistency}%)\n`;
    userPrompt += `\n[INSTRUCTION] 'finalVerdict' 필드에 위 '주요 취약점'에 대한 분석과 전체 토론 내용을 결합하여, 유저에게 깊은 인상을 남길 수 있는 최종 판결문을 작성하십시오.`;

    // [V43.0] AI 실패 시 사용할 시스템 템플릿 요약 (UX 보험)
    const generateFallbackContent = () => {
      const { duelStats } = precomputedVisuals;
      return JSON.stringify({
        signature: roleInfo.title || "미확인 전술가",
        signatureSub: roleInfo.roleLabel || "분석 대기 중",
        debateIssues: [
          {
            topic: "전투력",
            question: "교전 승률과 결정력이 충분한가?",
            spicyOpinion: `승률 ${duelStats.winRate}은 나쁘지 않지만, 반응 속도 ${avgReactionLatency}는 개선이 필요합니다.`,
            kindOpinion: `상위권 평균을 상회하는 ${duelStats.winRate}의 승률은 매우 안정적인 전투력을 증명합니다.`,
            winner: parseInt(duelStats.winRate) > 50 ? "kind" : "spicy",
            reason: "데이터 기반 자동 판정 결과입니다.",
            evaluation: parseInt(duelStats.winRate) > 50 ? "전투력은 합격점입니다." : "교전 정교함이 더 필요합니다.",
            userStats: [{ label: "교전 승률", value: duelStats.winRate }],
            benchmarkStats: [{ label: "상위권 평균", value: (mainBench?.avgDuelWinRate || 50) + "%" }]
          },
        ],
        finalVerdict: "구글 AI 서버 지연으로 인해 시스템 엔진이 지표를 바탕으로 자동 분석한 결과입니다. 교전 반응 속도 개선에 집중하신다면 더 높은 티어로 올라갈 수 있습니다.",
        actionItems: [
          { icon: "⚡", title: "반응성 개선", desc: "피격 시 즉각적인 대응 사격과 엄폐물 확보 훈련이 필요합니다." }
        ]
      });
    };

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const modelsToTry = GEMINI_MODELS_TO_TRY;
    let streamResult = null;
    let selectedModelName = "";

    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
    ];

    const generationStartedAt = Date.now();
    for (const modelName of modelsToTry) {
      try {
        const remainingMs = AI_SUMMARY_TOTAL_TIMEOUT_MS - (Date.now() - generationStartedAt);
        if (remainingMs <= 0) break;

        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: promptLines.join("\n"),
          generationConfig: { responseMimeType: "application/json", temperature: 0.75, maxOutputTokens: 2500 },
          safetySettings
        });

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), Math.min(AI_SUMMARY_MODEL_TIMEOUT_MS, remainingMs))
        );

        streamResult = await Promise.race([
          model.generateContentStream(userPrompt),
          timeoutPromise
        ]) as any;

        if (streamResult) {
          selectedModelName = modelName;
          break;
        }
      } catch (err: any) {
        console.warn(`[AI-SUMMARY] Model ${modelName} failed (${err.message}), trying next...`);
      }
    }

    const reactionTier = (lat: string) => { const v = parseFloat(lat); return isNaN(v) ? "C" : v < 0.4 ? "S" : v < 0.6 ? "A" : v < 0.8 ? "B" : "C"; };
    const backupContextForVisuals = buildBackupCoachingContext({
      avgBackupLatency,
      totalTradeKills,
      totalRevCount,
      totalSmokeRescues,
      totalTeamWipes: masteryStats.totalTeamWipes,
      totalTeammateKnocks,
      benchmarkTradeLatency: mainBench?.avgTradeLatency,
    });

    const precomputedVisuals = {
      latestMatchTime, counterLatency: avgBackupLatency, reactionLatency: avgReactionLatency,
      reactionTier: reactionTier(avgReactionLatency), backupTier: backupContextForVisuals.tier, overallTier: mainUserTier, roleInfo,
      tierBreakdown: finalTierBreakdown,
      initiativeSuccess: `${userInitiativeRate}%`, pressureIndex: avgPressureIndex,
      reversalRate: `${totalReversalAttempts > 0 ? Math.round((totalReversalWins / totalReversalAttempts) * 100) : 0}%`,
      duelStats: { winRate: `${avgDuelWinRate}%`, wins: totalDuelWins, losses: totalDuelLosses, reversals: totalReversalWins, reversalAttempts: totalReversalAttempts },
      teamImpact: { damageImpact: avgDamageImpact, topBadges },
      goldenTime: goldenTimeAvg, killContrib: killContribFinal, deathPhase: avgDeathPhase,
      bluezoneWaste: Math.round(totalBluezoneWaste / mLen),
      modeDistribution: { ranked: rankedCount, normal: normalCount, main: rankedCount >= normalCount ? "경쟁전" : "일반전" },
      tactical: {
        suppRate: totalTeammateKnocks > 0 ? Math.round((totalSuppCount / totalTeammateKnocks) * 100) + "%" : "0%",
        tradeRate: totalTeammateKnocks > 0 ? Math.round((totalTradeKills / totalTeammateKnocks) * 100) + "%" : "0%",
        smokeRate: masteryStats.totalSmokeCount > 0 ? Math.round((totalSmokeRescues / masteryStats.totalSmokeCount) * 100) + "%" : "0%",
        reviveRate: totalTeammateKnocks > 0 ? Math.round((totalRevCount / totalTeammateKnocks) * 100) + "%" : "0%",
        counts: {
          knocks: totalTeammateKnocks,
          smokes: totalSmokes,
          rescueSmokes: masteryStats.totalSmokeCount,
          smokeRescues: totalSmokeRescues,
          revives: totalRevCount,
          trades: totalTradeKills,
          supps: totalSuppCount,
          initiative: { attempts: totalInitiativeAttempts, success: totalInitiativeSuccess }
        },
        baitCount: totalBaitCount, isolation: isolationCountFinal > 0 ? {
          isolationIndex: Number((totalIsolationIndexFinal / isolationCountFinal).toFixed(1)),
          minDist: Math.round(totalMinDist / isolationCountFinal), heightDiff: Math.round(totalHeightDiff / isolationCountFinal),
          isCrossfire: totalCrossfireCount > 0, teammateCount: Math.round(totalTeammateCountFinal / isolationCountFinal),
          userTier: mainUserTier, benchmarkIsolationIndex: mainBench?.avgIsolationIndex || 2.5, benchmarkMinDist: mainBench?.avgMinDist || 15
        } : null
      },
      mapStats: mapStatsResult,
      trends: trendsData
    };


    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      async start(controller) {
        let aiResponseText = "";
        try {
          // [V45.0] 구형 필드 잔재 강제 제거 (Sanitization)
          if (precomputedVisuals.roleInfo) {
            const ri = precomputedVisuals.roleInfo as any;
            delete ri.specialMetrics;
            delete ri.luckTrend;
            delete ri.circleLuck;
            delete ri.vehicleMastery;
          }

          // 1. 비주얼 데이터 우선 전송
          controller.enqueue(encoder.encode(JSON.stringify({ type: "visuals", data: precomputedVisuals }) + "\n"));

          // 4. Gemini 스트리밍 결과 처리
          if (streamResult) {
            for await (const chunk of streamResult.stream) {
              // [V54.2] 클라이언트가 연결을 끊었는지 체크 (토큰 낭비 방지 핵심)
              if (request.signal.aborted) {
                break;
              }

              const chunkText = chunk.text();
              aiResponseText += chunkText;
            }

            // 비동기로 사용량 메타데이터 획득 후 로깅
            streamResult.response.then((res: any) => {
              if (res.usageMetadata) {
                trackAiUsage(
                  auth.user?.id,
                  selectedModelName,
                  res.usageMetadata.promptTokenCount,
                  res.usageMetadata.candidatesTokenCount,
                  "summary",
                  { durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform },
                );
              }
            }).catch((err: any) => console.error("[AI-SUMMARY] Usage fetch error:", err));

          } else {
            aiResponseText = generateFallbackContent();
          }

          // [V54.4] 최종 데이터 정제 및 단일 chunk 전송
          const finalResult = aiResponseText || generateFallbackContent();
          const validJsonString = sanitizeAiCoachingLanguageText(extractValidJson(finalResult));

          if (validJsonString) {
            // [V54.3] 'chunk' 대신 'final' 타입을 사용하여 데이터 중복 방지
            controller.enqueue(encoder.encode(JSON.stringify({
              type: "final",
              data: validJsonString
            }) + "\n"));

            // 3. Write to DB Cache
            try {
              const { error: saveErr } = await supabase
                .from("player_ai_summary_cache")
                .upsert({
                  player_id: lowerNickname,
                  platform: cachePlatform,
                  match_ids_hash: matchIdsHash,
                  prompt_version: AI_CACHE_VERSION,
                  ai_result: {
                    visuals: precomputedVisuals,
                    final: validJsonString
                  },
                  updated_at: new Date().toISOString()
                }, { onConflict: "player_id,platform,match_ids_hash,prompt_version" });
              if (saveErr) throw saveErr;
            } catch (saveErr: any) {
              console.warn("[AI-SUMMARY] Failed to write cache to DB:", saveErr.message || saveErr);
            }

            // 3. 완료 신호
            controller.enqueue(encoder.encode(JSON.stringify({ type: "done", valid: true }) + "\n"));
          } else {
            throw new Error("No valid JSON extracted from AI response");
          }
        } catch (e: any) {
          console.error("[AI-SUMMARY-STREAM-ERROR] Critical failure during stream generation:", e?.message || e);
          trackAiFailure(authenticatedUserId, "summary", e, {
            durationMs: Date.now() - startedAt,
            requestId,
            platform: requestedPlatform,
          });
          try {
            // 실패 시 Fallback 데이터를 전송하여 UI 무한 대기 방지
            const fallback = sanitizeAiCoachingLanguageText(generateFallbackContent());
            controller.enqueue(encoder.encode(JSON.stringify({ type: "final", data: fallback }) + "\n"));
            controller.enqueue(encoder.encode(JSON.stringify({ type: "done", valid: false, error: e?.message }) + "\n"));
          } catch (innerError) {
            console.error("[AI-SUMMARY-STREAM-ERROR] Critical failure even in fallback:", innerError);
          }
        } finally {
          controller.close();
        }
      }
    }), {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error: any) {
    console.error("[AI-SUMMARY] CRITICAL ERROR:", error.message || error);
    trackAiFailure(authenticatedUserId, "summary", error, {
      durationMs: Date.now() - startedAt,
      requestId,
      platform: requestedPlatform,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
