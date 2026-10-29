import { WEAPON_NAMES } from "./constants";
import { evaluateMatchEligibility } from "./matchEligibility";
import { firstReplyLatencyMs, firstReplyFailureRate } from "./firstReply";

function normalizeWeaponName(weaponId: string): string {
  if (!weaponId) return "Unknown";
  let name = weaponId.toLowerCase();
  name = name.replace(/item_weapon_/, "").replace(/weap/, "").replace(/_c$/, "").replace(/proj/, "");
  const upperName = name.toUpperCase();
  const names = WEAPON_NAMES as any;
  return names[upperName] || names[weaponId] || name;
}

export function isCompetitiveMatch(match: any): boolean {
  const values = [
    match?.matchType,
    match?.match_type,
    match?.matchInfo?.matchType,
    match?.gameMode,
    match?.game_mode,
    match?.matchInfo?.mode,
  ];
  return values.some((value) => /(?:^|[-_\s])(competitive|ranked)(?:$|[-_\s])/i.test(String(value ?? "").trim()));
}

function coerceFiniteNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string" && value.trim() === "") return 0;

  try {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, parsed));
  } catch {
    return 0;
  }
}

/** Return only an observed non-negative numeric measurement.  In particular,
 * null/undefined/blank values are not interchangeable with an observed zero;
 * isolation aggregation uses this boundary to keep missing position samples
 * out of both denominators and score-like visuals. */
function readIsolationMeasurement(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  try {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.min(Number.MAX_SAFE_INTEGER, parsed);
  } catch {
    return null;
  }
}

function readObservedNonNegative(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  try {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.min(Number.MAX_SAFE_INTEGER, parsed);
  } catch {
    return null;
  }
}

function coerceNonNegativeNumber(value: unknown): number {
  return Math.max(0, coerceFiniteNumber(value));
}

export function calculateBoundedRate(numerator: unknown, denominator: unknown): number | null {
  // Missing numerator/denominator values are not an observed zero.  Keep an
  // explicit numeric 0, but do not manufacture a 0% rate from absent
  // telemetry (for example, a match with no duel opportunities).
  const safeNumerator = readObservedNonNegative(numerator);
  const safeDenominator = readObservedNonNegative(denominator);
  if (safeNumerator === null || safeDenominator === null || safeDenominator <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((safeNumerator / safeDenominator) * 100)));
}

export function formatBoundedRate(numerator: unknown, denominator: unknown): string {
  const rate = calculateBoundedRate(numerator, denominator);
  return rate === null ? "측정 불가" : `${rate}%`;
}

export function formatObservedPercent(value: unknown): string {
  const observed = readObservedNonNegative(value);
  if (observed === null) return "측정 불가";
  return `${Math.max(0, Math.min(100, observed))}%`;
}

export function formatObservedMetric(value: unknown, suffix = ""): string {
  const observed = readObservedNonNegative(value);
  return observed === null ? "측정 불가" : `${observed}${suffix}`;
}

export function formatObservedCount(value: unknown): string {
  const observed = readObservedNonNegative(value);
  return observed === null ? "측정 불가" : `${observed}회`;
}

export function observedVisualValue(value: unknown, round = false): number | string {
  const observed = readObservedNonNegative(value);
  if (observed === null) return "측정 불가";
  return round ? Math.round(observed) : observed;
}

export function firstObservedNonNegative(...values: unknown[]): number | null {
  for (const value of values) {
    const observed = readObservedNonNegative(value);
    if (observed !== null) return observed;
  }
  return null;
}

function addObservedTotal(total: number | null, value: unknown): number | null {
  const observed = readObservedNonNegative(value);
  return observed === null ? total : (total ?? 0) + observed;
}

function sumCompleteObservations(values: unknown[]): number | null {
  const observed = values.map(readObservedNonNegative);
  if (observed.length === 0 || observed.some((value) => value === null)) return null;
  return (observed as number[]).reduce((total, value) => total + value, 0);
}

// 새 칭호 후보는 같은 버전의 완전한 경기 창에서만 개인 관측을 비교한다.
function aggregateRoleEvidence(matches: any[]) {
  if (!matches.length) return null;
  const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const rows = matches.map((match) => match?.roleEvidence);
  const counts = ["validWeaponHits", "distanceHitCount", "focusFireCount", "rescueCount", "rescueOpportunityCount", "positionSampleCount", "edgePlayCount"];
  if (rows.some((row) => !row || row.version !== 1
    || counts.some((key) => !nonNegative(row[key]) || !Number.isInteger(row[key]))
    || row.rescueCount > row.rescueOpportunityCount || row.edgePlayCount > row.positionSampleCount
    || row.distanceHitCount > row.validWeaponHits
    || ["short", "mid", "long"].some((key) => !nonNegative(row.distanceDamage?.[key]))
    || (row.maxHitDist !== null && !nonNegative(row.maxHitDist))
    || (row.pressureIndex !== null && !nonNegative(row.pressureIndex))
    || (row.distanceHitCount === 0 ? row.maxHitDist !== null : row.maxHitDist === null)
    || (row.validWeaponHits === 0 ? row.pressureIndex !== null : row.pressureIndex === null))) return null;
  const sum = (key: string) => rows.reduce((total, row) => total + row[key], 0);
  const pressures = rows.map((row) => row.pressureIndex).filter(nonNegative);
  const distances = rows.map((row) => row.maxHitDist).filter(nonNegative);
  const golden = matches.map((match) => match?.goldenTimeDamage);
  const goldenComplete = golden.every((row) => row && ["early", "mid1", "mid2", "late"].every((key) => nonNegative(row[key])));
  const observed = (read: (match: any) => unknown) => matches.filter((match) => nonNegative(read(match))).length;
  const metricMatchCounts = {
    initiative: matches.filter((match) => nonNegative(match.initiativeSampleCount) && (match.initiativeSampleCount === 0 || (nonNegative(match.initiative_rate) && match.initiative_rate <= 100))).length,
    duelWin: matches.filter((match) => nonNegative(match.duelStats?.wins) && nonNegative(match.duelStats?.losses)).length,
    reversal: observed((match) => match.duelStats?.reversalAttempts),
    tradeRate: matches.filter((match) => nonNegative(match.tradeStats?.tradeKills) && nonNegative(match.tradeStats?.teammateKnocks)).length,
    placement: matches.filter((match) => nonNegative(match.stats?.winPlace) && match.stats.winPlace >= 1 && nonNegative(match.totalTeams) && match.totalTeams > 1).length,
    baitPerMatch: observed((match) => match.tradeStats?.baitCount),
    supportPerMatch: observed((match) => match.tradeStats?.suppCount),
    teamDamageShare: observed((match) => match.teamImpact?.teamDamageShare),
    assistShare: matches.filter((match) => ["solo", "cleanup", "assist"].every((key) => nonNegative(match.killContribution?.[key]))).length,
  };
  return {
    version: 1 as const, matchCount: matches.length,
    teamMatchCount: matches.filter(match => nonNegative(match.teamContext?.myRosterSize) && match.teamContext.myRosterSize > 1).length,
    validWeaponHits: sum("validWeaponHits"), distanceHitCount: sum("distanceHitCount"),
    distanceDamage: {short: rows.reduce((total, row) => total + row.distanceDamage.short, 0),
      mid: rows.reduce((total, row) => total + row.distanceDamage.mid, 0), long: rows.reduce((total, row) => total + row.distanceDamage.long, 0)},
    maxHitDist: distances.length ? Math.max(...distances) : null,
    pressureIndex: pressures.length ? pressures.reduce((a, b) => a + b, 0) / pressures.length : null,
    focusFireCount: sum("focusFireCount"), rescueCount: sum("rescueCount"), rescueOpportunityCount: sum("rescueOpportunityCount"),
    positionSampleCount: sum("positionSampleCount"), edgePlayCount: sum("edgePlayCount"), metricMatchCounts,
    goldenTimeDamage: goldenComplete ? {early: golden.reduce((total, row) => total + row.early, 0),
      mid1: golden.reduce((total, row) => total + row.mid1, 0), mid2: golden.reduce((total, row) => total + row.mid2, 0), late: golden.reduce((total, row) => total + row.late, 0)} : null,
  };
}

/**
 * 칭호 후보 기준 분포의 모집단 키: platform|raw gameMode|official/competitive.
 * 값이 기록되지 않은 경기는 null이다. 누락을 steam·official 같은 기본값으로 채우지 않는다.
 */
export function roleCohortOf(match: any): string | null {
  const platform = typeof match?.platform === "string" ? match.platform.trim().toLowerCase() : "";
  if (!["steam", "kakao"].includes(platform)) return null;
  // mode·matchType은 AI 요약 모집단 계약(일반 배틀로얄, official/competitive)을 그대로 따른다.
  // 미확인·사용자 지정·이벤트 유형은 cohort가 없다.
  const eligibility = evaluateMatchEligibility(match, "ai-summary");
  if (!eligibility.eligible || !eligibility.mode || !eligibility.matchType) return null;
  return `${platform}|${eligibility.mode}|${eligibility.matchType}`;
}

export type RoleCohortIssue = "missing" | "mixed" | "identity";

/** 같은 선정 경기에서 cohort를 다시 계산한다. 한 계정·중복 없는 경기·같은 cohort일 때만 값이 있다. */
function aggregateRoleCohort(matches: any[]): { cohort: string | null; cohortIssue: RoleCohortIssue | null } {
  const ids = matches.map((match) => match?.matchId);
  // 계정 식별은 모든 경기에 있어야 하고 같아야 한다. 누락을 한 계정의 증거로 보지 않는다.
  const players = matches.map((match) => match?.stats?.playerId ?? match?.player_id);
  if (!matches.length || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length
    || players.some((player) => typeof player !== "string" || !player) || new Set(players).size !== 1) return { cohort: null, cohortIssue: "identity" };
  const cohorts = matches.map(roleCohortOf);
  if (cohorts.some((cohort) => cohort === null)) return { cohort: null, cohortIssue: "missing" };
  if (new Set(cohorts).size !== 1) return { cohort: null, cohortIssue: "mixed" };
  return { cohort: cohorts[0], cohortIssue: null };
}

export interface TeamRoleEvidence {
  matchCount: number;
  rescueCount: number;
  rescueOpportunityCount: number;
  teamDamageShare: number | null;
  teamDamageShareMatches: number;
  tradeKills: number;
  teammateKnocks: number;
  tradeRateMatches: number;
  tradeLatencySec: number | null;
  tradeLatencyMatches: number;
  baitPerMatch: number | null;
  supportPerMatch: number | null;
  supportMatches: number;
  focusFirePerMatch: number | null;
  assistShare: number | null;
  crossfireMatches: number;
}

function aggregateTeamRoleEvidence(matches: any[]): TeamRoleEvidence {
  const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const teamRows = matches.map((match) => ({match, role: match?.roleEvidence}))
    .filter(({match}) => nonNegative(match?.teamContext?.myRosterSize) && match.teamContext.myRosterSize > 1);
  const shares = teamRows.map(({match}) => match?.teamImpact?.teamDamageShare)
    .filter((value): value is number => nonNegative(value) && value <= 100);
  const tradeRows = teamRows.map(({match}) => match).filter((match) =>
    nonNegative(match?.tradeStats?.tradeKills) && nonNegative(match?.tradeStats?.teammateKnocks));
  const latencyRows = tradeRows.filter((match) => match.tradeStats.tradeKills > 0 && nonNegative(match.tradeStats.tradeLatencyMs));
  const supportRows = teamRows.map(({match}) => match).filter((match) =>
    nonNegative(match?.tradeStats?.baitCount) && nonNegative(match?.tradeStats?.suppCount));
  const focusRows = teamRows.filter(({role, match}) => nonNegative(role?.focusFireCount)
    && nonNegative(match?.killContribution?.solo) && nonNegative(match?.killContribution?.cleanup) && nonNegative(match?.killContribution?.assist));
  const contribution = focusRows.reduce((sum, {match}) => {
    sum.solo += match.killContribution.solo;
    sum.cleanup += match.killContribution.cleanup;
    sum.assist += match.killContribution.assist;
    sum.focus += match.roleEvidence.focusFireCount;
    return sum;
  }, {solo: 0, cleanup: 0, assist: 0, focus: 0});
  return {
    matchCount: teamRows.length,
    rescueCount: teamRows.reduce((sum, {role}) => sum + role.rescueCount, 0),
    rescueOpportunityCount: teamRows.reduce((sum, {role}) => sum + role.rescueOpportunityCount, 0),
    teamDamageShare: shares.length ? shares.reduce((sum, value) => sum + value, 0) / shares.length : null,
    teamDamageShareMatches: shares.length,
    tradeKills: tradeRows.reduce((sum, match) => sum + match.tradeStats.tradeKills, 0),
    teammateKnocks: tradeRows.reduce((sum, match) => sum + match.tradeStats.teammateKnocks, 0),
    tradeRateMatches: tradeRows.length,
    tradeLatencySec: latencyRows.length ? latencyRows.reduce((sum, match) => sum + match.tradeStats.tradeLatencyMs, 0) / latencyRows.length / 1000 : null,
    tradeLatencyMatches: latencyRows.length,
    baitPerMatch: supportRows.length ? supportRows.reduce((sum, match) => sum + match.tradeStats.baitCount, 0) / supportRows.length : null,
    supportPerMatch: supportRows.length ? supportRows.reduce((sum, match) => sum + match.tradeStats.suppCount, 0) / supportRows.length : null,
    supportMatches: supportRows.length,
    focusFirePerMatch: focusRows.length ? contribution.focus / focusRows.length : null,
    assistShare: contribution.solo + contribution.cleanup + contribution.assist >= 3
      ? contribution.assist / (contribution.solo + contribution.cleanup + contribution.assist) * 100 : null,
    crossfireMatches: focusRows.length,
  };
}

export function aggregateMatches(matches: any[], options?: { roleEvidenceVersion?: 2 }) {
  const inputMatches = Array.isArray(matches) ? matches : [];
  let totalKills = 0, totalDamage = 0, totalDamageImpact = 0, totalTeamDamageShare = 0, totalTeamKillShare = 0;
  let damageImpactCount = 0, teamDamageShareCount = 0, teamKillShareCount = 0;
  let totalPlacementPct = 0, placementCount = 0;
  let totalTeammateKnocks = 0, totalSuppCount = 0, totalTradeKills = 0, totalRescueSmokes = 0;
  let totalRevCount = 0, totalBaitCount = 0;
  let totalSmokes = 0;
  let totalSmokeRescues = 0;
  let totalCoverSuccess = 0, totalCoverAttempts = 0;
  let totalInitiativeSuccess = 0, totalInitiativeAttempts = 0;
  let totalCrossfireCount = 0, totalTeamWipes = 0, totalMaxHitDist: number | null = null;
  let totalDuelWins = 0, totalDuelLosses = 0, totalReversalWins = 0, totalReversalAttempts = 0;
  const metricMatchCounts: Record<string, number> = { initiative_rate: 0, duel_win_rate: 0, solo_kill_share: 0 };
  const observedUtilityThrows: Array<number | null> = [];
  const observedLethalThrows: Array<number | null> = [];
  const observedUtilityHits: Array<number | null> = [];
  const observedUtilityDamage: Array<number | null> = [];
  const observedUtilityKills: Array<number | null> = [];
  let totalDeathPhase = 0, totalBluezoneWaste: number | null = null;
  let deathPhaseCount = 0;
  let bluezoneWasteCount = 0;
  let totalPressureIndex = 0, pressureIndexCount = 0;
  let totalEdgePlay: number | null = null, totalFatalDelay: number | null = null;
  let totalFocusFireCount: number | null = null, totalCrossfireExposureCount: number | null = null;
  const totalDistanceDamage = { short: 0, mid: 0, long: 0 };
  let totalIsolationIndexFinal = 0, totalCombatIso = 0, totalDeathIso = 0;
  let totalMinDist = 0, totalHeightDiff = 0, totalTeammateCountFinal = 0;
  let isolationCountFinal = 0, combatIsolationCountFinal = 0, deathIsolationCountFinal = 0;
  let minDistCountFinal = 0, heightDiffCountFinal = 0, teammateCountFinal = 0;
  let rankedCount = 0, normalCount = 0;
  const weaponMatchCount: Record<string, number> = {};

  // [V58.4] 차량 고정밀 교전 지표 집계용 변수
  let totalLeadShotKills = 0, totalLeadShotKnocks = 0, totalRidingShotKills = 0, totalRidingShotKnocks = 0;
  let totalRoadKills = 0, totalRoadKnocks = 0;
  let vehicleCombatMatchCount = 0;

  const backupLatencies: number[] = [], reactionLatencies: number[] = [];
  let counterObservedMatches = 0, counterFailureMatches = 0, firstReplySumMs = 0, firstReplyCount = 0, firstReplyMatches = 0;
  const goldenTimeFinal = { early: 0, mid1: 0, mid2: 0, late: 0 };
  const killContribFinal = { solo: 0, cleanup: 0, assist: 0 }; // assist = 내 킬 중 팀원이 먼저 딜을 넣었던 킬 (KDA 어시스트와 무관)
  const weaponStatsFinal: Record<string, any> = {};
  const allBadges: any[] = [];

  inputMatches.forEach((rawMatch: any) => {
    const m = rawMatch && typeof rawMatch === "object" ? rawMatch : {};
    // [V41.0] Account ID 우선 매칭 (매칭 검증용)

    // 무기 통계 합산 (DB weaponStats 0 이슈 해결을 위해 타임라인 전수조사 병행)
    if (m.weaponStats) {
      Object.entries(m.weaponStats).forEach(([wId, wData]: [string, any]) => {
        const weaponName = normalizeWeaponName(wId);
        if (!weaponStatsFinal[weaponName]) weaponStatsFinal[weaponName] = { kills: 0, dbnos: 0, damage: 0 };
        weaponStatsFinal[weaponName].damage += coerceFiniteNumber(wData?.damage);
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
    const isRanked = isCompetitiveMatch(m);
    if (isRanked) rankedCount++; else normalCount++;

    if (m.tradeStats) {
      const teammateKnocks = coerceNonNegativeNumber(m.tradeStats.teammateKnocks);
      const suppCount = coerceNonNegativeNumber(m.tradeStats.suppCount);
      const tradeKills = coerceNonNegativeNumber(m.tradeStats.tradeKills);
      const revCount = coerceNonNegativeNumber(m.tradeStats.revCount);
      const baitCount = coerceNonNegativeNumber(m.tradeStats.baitCount);
      const coverRateSampleCount = coerceNonNegativeNumber(m.tradeStats.coverRateSampleCount);
      const coverRate = coerceFiniteNumber(m.tradeStats.coverRate);
      totalTeammateKnocks += teammateKnocks;
      totalSuppCount += suppCount;
      totalTradeKills += tradeKills;
      totalRevCount += revCount;
      totalBaitCount += baitCount;
      if (coverRateSampleCount > 0 && coverRate >= 0 && coverRate <= 100) {
        totalCoverAttempts += coverRateSampleCount;
        totalCoverSuccess += (coverRate / 100) * coverRateSampleCount;
      }
      const tradeLatencyMs = readObservedNonNegative(m.tradeStats.tradeLatencyMs);
      const reactionLatencyMs = readObservedNonNegative(m.tradeStats.reactionLatencyMs);
      if (tradeLatencyMs !== null) backupLatencies.push(tradeLatencyMs);
      if (reactionLatencyMs !== null && reactionLatencyMs > 0) {
        reactionLatencies.push(reactionLatencyMs);
        // 3초 안에 대응하지 못한 경기는 엔진이 패널티 값을 넣는다. 실패 경기로 따로 센다.

      }
      const failure = firstReplyFailureRate(m);
      if (failure !== null) { counterObservedMatches++; if (failure === 100) counterFailureMatches++; }
      // 피격 전 사격이 구분된 관측만 코칭 평균과 실패 분모에 넣는다.
      if (firstReplyLatencyMs(m) !== null) {
        // 비교 view가 player-match 평균이므로 경기별 평균에 같은 가중치를 준다.
        firstReplySumMs += firstReplyLatencyMs(m)!;
        firstReplyCount++;
        firstReplyMatches++;
      }
    }

    totalRescueSmokes += coerceNonNegativeNumber(m.tradeStats?.smokeCount);
    // [V55.1 FIX] m.itemUseStats 대신 m.itemUseSummary.smokes를 참조하여 M79 포함 전체 연막 사용량 정확히 집계
    totalSmokes += coerceNonNegativeNumber(m.itemUseSummary?.smokes ?? m.tradeStats?.smokeCount);
    totalSmokeRescues += coerceNonNegativeNumber(m.tradeStats?.smokeRescues);

    const initiativeSampleCount = readObservedNonNegative(m.initiativeSampleCount);
    const initiativeRate = readObservedNonNegative(m.initiative_rate);
    // A missing outcome cannot be counted as a failed attempt. Keep each
    // numerator and denominator on the same observed match population.
    if (initiativeSampleCount === 0 || (initiativeSampleCount !== null && initiativeRate !== null && initiativeRate <= 100)) {
      metricMatchCounts.initiative_rate++;
      totalInitiativeAttempts += initiativeSampleCount;
      totalInitiativeSuccess += Math.round(((initiativeRate ?? 0) / 100) * initiativeSampleCount);
    }

    if (m.isolationData) {
      if (m.isolationData.isCrossfire) totalCrossfireCount++;
      const isolationIndex = readIsolationMeasurement(m.isolationData.isolationIndex);
      const combatIsolation = readIsolationMeasurement(m.isolationData.combatIsolation);
      const deathIsolation = readIsolationMeasurement(m.isolationData.deathIsolation);
      const minDist = readIsolationMeasurement(m.isolationData.minDist);
      const heightDiff = readIsolationMeasurement(m.isolationData.heightDiff);
      const teammateCount = readIsolationMeasurement(m.isolationData.teammateCount);
      if (isolationIndex !== null) {
        totalIsolationIndexFinal += isolationIndex;
        isolationCountFinal++;
      }
      if (combatIsolation !== null) {
        totalCombatIso += combatIsolation;
        combatIsolationCountFinal++;
      }
      if (deathIsolation !== null) {
        totalDeathIso += deathIsolation;
        deathIsolationCountFinal++;
      }
      if (minDist !== null) {
        totalMinDist += minDist;
        minDistCountFinal++;
      }
      if (heightDiff !== null) {
        totalHeightDiff += heightDiff;
        heightDiffCountFinal++;
      }
      if (teammateCount !== null) {
        totalTeammateCountFinal += teammateCount;
        teammateCountFinal++;
      }
    }

    if (m.duelStats) {
      const duelWins = readObservedNonNegative(m.duelStats.wins);
      const duelLosses = readObservedNonNegative(m.duelStats.losses);
      const reversals = readObservedNonNegative(m.duelStats.reversals);
      const reversalAttempts = readObservedNonNegative(m.duelStats.reversalAttempts);
      if (duelWins !== null && duelLosses !== null) {
        totalDuelWins += duelWins;
        totalDuelLosses += duelLosses;
        metricMatchCounts.duel_win_rate++;
      }
      if (reversals !== null) totalReversalWins += reversals;
      if (reversalAttempts !== null || reversals !== null) {
        totalReversalAttempts += Math.max(reversalAttempts ?? 0, reversals ?? 0);
      }
    }
    const utilityStats = m.combatPressure?.utilityStats;
    const fragCount = readObservedNonNegative(m.itemUseSummary?.frags);
    const molotovCount = readObservedNonNegative(m.itemUseSummary?.molotovs);
    const derivedLethalThrowCount = fragCount !== null && molotovCount !== null
      ? (fragCount ?? 0) + (molotovCount ?? 0)
      : null;
    const lethalThrowCount = firstObservedNonNegative(
      utilityStats?.lethalThrowCount,
      m.itemUseStats?.lethalThrowCount,
      derivedLethalThrowCount,
    );
    observedLethalThrows.push(lethalThrowCount);

    const utilityThrowCount = firstObservedNonNegative(
      utilityStats?.throwCount,
      m.itemUseStats?.throwCount,
    );
    observedUtilityThrows.push(utilityThrowCount);

    const utilityHitCount = utilityStats?.accuracyStatus === "missing" ? null : firstObservedNonNegative(
      utilityStats?.hitCount,
      m.combatPressure?.utilityHits,
    );
    observedUtilityHits.push(utilityHitCount === null ? null
      : lethalThrowCount === null ? utilityHitCount : Math.min(utilityHitCount, lethalThrowCount));
    observedUtilityDamage.push(firstObservedNonNegative(utilityStats?.totalDamage, m.combatPressure?.utilityDamage));
    observedUtilityKills.push(readObservedNonNegative(utilityStats?.killCount));

    const maxHitDistance = firstObservedNonNegative(
      m.combatPressure?.maxHitDistance,
      m.combatPressure?.maxHitDist,
    );
    if (maxHitDistance !== null) {
      totalMaxHitDist = totalMaxHitDist === null
        ? maxHitDistance
        : Math.max(totalMaxHitDist, maxHitDistance);
    }
    totalTeamWipes += coerceNonNegativeNumber(m.tradeStats?.enemyTeamWipes);

    if (m.goldenTimeDamage) {
      goldenTimeFinal.early += coerceFiniteNumber(m.goldenTimeDamage.early);
      goldenTimeFinal.mid1 += coerceFiniteNumber(m.goldenTimeDamage.mid1);
      goldenTimeFinal.mid2 += coerceFiniteNumber(m.goldenTimeDamage.mid2);
      goldenTimeFinal.late += coerceFiniteNumber(m.goldenTimeDamage.late);
    }

    const contributions = [m.killContribution?.solo, m.killContribution?.cleanup, m.killContribution?.assist].map(readObservedNonNegative);
    if (contributions.every((value): value is number => value !== null)) {
      killContribFinal.solo += contributions[0];
      killContribFinal.cleanup += contributions[1];
      killContribFinal.assist += contributions[2];
      metricMatchCounts.solo_kill_share++;
    }

    totalKills += coerceFiniteNumber(m.stats?.kills);
    totalDamage += coerceFiniteNumber(m.stats?.processedDamageDealt ?? m.stats?.damageDealt);
    const damageImpact = readObservedNonNegative(m.teamImpact?.damageImpact);
    if (damageImpact !== null) {
      totalDamageImpact += damageImpact;
      damageImpactCount++;
    }
    const teamDamageShare = readObservedNonNegative(m.teamImpact?.teamDamageShare);
    if (teamDamageShare !== null) {
      totalTeamDamageShare += teamDamageShare;
      teamDamageShareCount++;
    }
    const teamKillShare = readObservedNonNegative(m.teamImpact?.teamKillShare);
    if (teamKillShare !== null) {
      totalTeamKillShare += teamKillShare;
      teamKillShareCount++;
    }
    if (m.badges) allBadges.push(...m.badges);

    // 순위를 참가 팀 수 대비 백분위로 바꾼다(1위 100, 꼴찌 0). 칭호의 전장 통제자 판정에 쓴다.
    const winPlace = readObservedNonNegative(m.stats?.winPlace);
    const totalTeams = readObservedNonNegative(m.totalTeams);
    if (winPlace !== null && winPlace >= 1 && totalTeams !== null && totalTeams > 1) {
      totalPlacementPct += 100 * (1 - Math.min(1, (winPlace - 1) / (totalTeams - 1)));
      placementCount++;
    }

    const observedDeathPhase = readObservedNonNegative(m.deathPhase);
    if (observedDeathPhase !== null) {
      totalDeathPhase += observedDeathPhase;
      deathPhaseCount++;
    }
    const bluezoneWaste = readObservedNonNegative(m.bluezoneWaste);
    if (bluezoneWaste !== null) {
      totalBluezoneWaste = addObservedTotal(totalBluezoneWaste, bluezoneWaste);
      bluezoneWasteCount++;
    }

    const observedPressureIndex = readObservedNonNegative(m.combatPressure?.pressureIndex);
    if (observedPressureIndex !== null) {
      totalPressureIndex += observedPressureIndex;
      pressureIndexCount++;
    }

    totalFocusFireCount = addObservedTotal(totalFocusFireCount, m.itemUseStats?.focusFireCount);
    totalCrossfireExposureCount = addObservedTotal(totalCrossfireExposureCount, m.itemUseStats?.crossfireExposureCount);
    if (m.itemUseStats?.distanceDamage) {
      totalDistanceDamage.short += coerceFiniteNumber(m.itemUseStats.distanceDamage.short);
      totalDistanceDamage.mid += coerceFiniteNumber(m.itemUseStats.distanceDamage.mid);
      totalDistanceDamage.long += coerceFiniteNumber(m.itemUseStats.distanceDamage.long);
    }

    // [V42.1] 자기장 지표 합산 로직 복구 (전장 통제자 칭호 정확도 향상)
    totalEdgePlay = addObservedTotal(
      totalEdgePlay,
      firstObservedNonNegative(m.edgePlay, m.zoneStrategy?.edgePlayCount),
    );
    totalFatalDelay = addObservedTotal(totalFatalDelay, m.zoneStrategy?.fatalDelayCount);

    // 무기별 사용 경기 수. 저장된 weaponMatchCount는 위치 로그에 무기 필드가 없어 비어 있으므로
    // 이 경기에서 피해·기절·처치를 낸 무기를 weaponStatsFinal과 같은 이름 키로 센다.
    const matchWeapons = new Set<string>();
    if (m.weaponStats && typeof m.weaponStats === "object") {
      Object.keys(m.weaponStats).forEach((wId) => matchWeapons.add(normalizeWeaponName(wId)));
    }
    if (Array.isArray(m.timeline)) {
      m.timeline.forEach((event: any) => {
        if (event.type === 'KILL' || event.type === 'KNOCK' || event.type === 'DOWNED' || event.type === 'TEAM_KNOCK') {
          matchWeapons.add(normalizeWeaponName(event.weapon || 'Unknown'));
        }
      });
    }
    if (Array.isArray(m.weaponMatchCount)) {
      m.weaponMatchCount.forEach((w: unknown) => {
        if (typeof w === "string" && w) matchWeapons.add(normalizeWeaponName(w));
      });
    }
    matchWeapons.forEach((w) => {
      weaponMatchCount[w] = (weaponMatchCount[w] || 0) + 1;
    });

    // [V58.4] 차량 교전 지표 누적 합산 (m.stats 또는 m 직계 필드에서 안전하게 추출)
    const lK = coerceFiniteNumber(m.stats?.leadShotKills ?? m.leadShotKills);
    const lKn = coerceFiniteNumber(m.stats?.leadShotKnocks ?? m.leadShotKnocks);
    const rK = coerceFiniteNumber(m.stats?.ridingShotKills ?? m.ridingShotKills);
    const rKn = coerceFiniteNumber(m.stats?.ridingShotKnocks ?? m.ridingShotKnocks);
    const rdK = coerceFiniteNumber(m.stats?.roadKills ?? m.roadKills);
    const rdKn = coerceFiniteNumber(m.stats?.roadKnocks ?? m.roadKnocks);

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

  const mLen = Math.max(1, inputMatches.length);
  const avgDamage = Math.floor(Math.max(0, totalDamage / mLen));
  const avgKills = Number(Math.max(0, totalKills / mLen).toFixed(1));
  const avgDamageImpact = damageImpactCount > 0
    ? Number(Math.max(0, totalDamageImpact / damageImpactCount).toFixed(1))
    : null;
  const avgPlacementPct = placementCount > 0 ? Number((totalPlacementPct / placementCount).toFixed(1)) : null;
  const avgTeamDamageShare = teamDamageShareCount > 0
    ? Number(Math.max(0, Math.min(100, totalTeamDamageShare / teamDamageShareCount)).toFixed(1))
    : null;
  const avgTeamKillShare = teamKillShareCount > 0
    ? Number(Math.max(0, Math.min(100, totalTeamKillShare / teamKillShareCount)).toFixed(1))
    : null;

  const badgeCounts: Record<string, number> = {};
  allBadges.forEach((b: any) => { if (b?.name) badgeCounts[b.name] = (badgeCounts[b.name] || 0) + 1; });
  const topBadges = Object.entries(badgeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name}(${count}회)`).join(", ");

  const userInitiativeRate = totalInitiativeAttempts > 0 ? Math.max(0, Math.min(100, Math.round((totalInitiativeSuccess / totalInitiativeAttempts) * 100))) : null;
  const userReversalRate = totalReversalAttempts > 0 ? Math.max(0, Math.min(100, Math.round((totalReversalWins / totalReversalAttempts) * 100))) : null;
  const avgBackupLatency = backupLatencies.length > 0 ? (backupLatencies.reduce((a, b) => a + b, 0) / backupLatencies.length / 1000).toFixed(2) + "s" : "측정 불가";
  const avgReactionLatency = reactionLatencies.length > 0 ? (reactionLatencies.reduce((a, b) => a + b, 0) / reactionLatencies.length / 1000).toFixed(2) + "s" : "측정 불가";
  // 기존 평균은 점수 호환 기록이다. 신규 명중 간격을 구 분포의 역할·등급에 대입하지 않는다.
  const measuredReactionLatencySec = firstReplyCount > 0 ? firstReplySumMs / firstReplyCount / 1000 : null;
  const avgMeasuredReactionLatency = measuredReactionLatencySec === null ? "측정 불가" : measuredReactionLatencySec.toFixed(2) + "s";
  const counterFailureRate = counterObservedMatches > 0 ? Math.round((counterFailureMatches / counterObservedMatches) * 100) : null;
  const avgCoverRate = totalCoverAttempts > 0
    ? Math.max(0, Math.min(100, Math.round((totalCoverSuccess / totalCoverAttempts) * 100)))
    : null;
  const totalDuels = totalDuelWins + totalDuelLosses;
  const avgDuelWinRate = totalDuels > 0 ? Math.max(0, Math.min(100, Math.round((totalDuelWins / totalDuels) * 100))) : null;
  const avgDeathPhase = deathPhaseCount > 0 ? Math.max(0, Number((totalDeathPhase / deathPhaseCount).toFixed(1))) : null;
  const avgPressureIndex = pressureIndexCount > 0
    ? Math.max(0, Number((totalPressureIndex / pressureIndexCount).toFixed(2)))
    : null;
  const totalUtilityThrows = sumCompleteObservations(observedUtilityThrows);
  const totalLethalThrows = sumCompleteObservations(observedLethalThrows);
  const totalUtilityHits = sumCompleteObservations(observedUtilityHits);
  const totalUtilityDamage = sumCompleteObservations(observedUtilityDamage);
  const totalUtilityKills = sumCompleteObservations(observedUtilityKills);
  const avgUtilityEfficiency = totalLethalThrows !== null
    && totalLethalThrows > 0
    && totalUtilityDamage !== null
    ? Math.max(0, Math.round(totalUtilityDamage / totalLethalThrows))
    : null;
  const avgBluezoneWaste = bluezoneWasteCount > 0 && totalBluezoneWaste !== null
    ? Math.round(totalBluezoneWaste / bluezoneWasteCount)
    : null;

  const avgMinDistStr = minDistCountFinal > 0 ? Math.max(0, totalMinDist / minDistCountFinal).toFixed(1) + "m" : "측정 불가";
  const avgHeightDiffStr = heightDiffCountFinal > 0 ? Math.max(0, totalHeightDiff / heightDiffCountFinal).toFixed(1) + "m" : "측정 불가";
  const avgIsolationStr = isolationCountFinal > 0 ? Math.max(0, totalIsolationIndexFinal / isolationCountFinal).toFixed(1) : "측정 불가";
  const avgCombatIsolationStr = combatIsolationCountFinal > 0
    ? Math.max(0, totalCombatIso / combatIsolationCountFinal).toFixed(2)
    : "측정 불가";
  const avgDeathIsolationStr = deathIsolationCountFinal > 0
    ? Math.max(0, totalDeathIso / deathIsolationCountFinal).toFixed(2)
    : "측정 불가";

  const goldenTimeAvg = {
    early: Math.max(0, Math.round(goldenTimeFinal.early / mLen)),
    mid1: Math.max(0, Math.round(goldenTimeFinal.mid1 / mLen)),
    mid2: Math.max(0, Math.round(goldenTimeFinal.mid2 / mLen)),
    late: Math.max(0, Math.round(goldenTimeFinal.late / mLen)),
  };

  // [V66.0] 분모에 assist(팀원 개입 킬) 포함 — ingest/route.ts의 solo_kill_rate 산출 방식과 동일하게 보정
  const totalKillContrib = killContribFinal.solo + killContribFinal.cleanup + killContribFinal.assist;
  const soloKillRate = totalKillContrib > 0 ? Math.max(0, Math.min(100, Math.round((killContribFinal.solo / totalKillContrib) * 100))) : null;

  const validMatchTimes = inputMatches
    .map((m: any) => m?.createdAt ?? m?.created_at ?? m?.matchInfo?.date ?? m?.date)
    .map((rawTime: unknown) => {
      if (rawTime instanceof Date) return rawTime.getTime();
      if (typeof rawTime !== "string" && typeof rawTime !== "number") return Number.NaN;
      const timestamp = new Date(rawTime).getTime();
      return Number.isFinite(timestamp) ? timestamp : Number.NaN;
    })
    .filter((timestamp: number) => Number.isFinite(timestamp));
  const latestMatchTime = validMatchTimes.length > 0
    ? new Date(Math.max(...validMatchTimes)).toISOString()
    : new Date(0).toISOString();

  const observedCount = (values: unknown[]) => values.filter((value) => readObservedNonNegative(value) !== null).length;
  Object.assign(metricMatchCounts, {
    damage_average: observedCount(inputMatches.map((m) => firstObservedNonNegative(m.stats?.processedDamageDealt, m.stats?.damageDealt))),
    pressure_index: pressureIndexCount,
    reaction_latency: firstReplyMatches,
    counter_failure_rate: counterObservedMatches,
    backup_latency: backupLatencies.length,
    trade_success_rate: inputMatches.filter((m) => [m.tradeStats?.tradeKills, m.tradeStats?.teammateKnocks].every((value) => readObservedNonNegative(value) !== null)).length,
    smoke_opportunity_rate: inputMatches.filter((m) => [m.tradeStats?.smokeRescues, m.tradeStats?.teammateKnocks].every((value) => readObservedNonNegative(value) !== null)).length,
    utility_throws: observedCount(observedUtilityThrows),
    utility_smokes: observedCount(inputMatches.map((m) => m.itemUseSummary?.smokes)),
    utility_lethal_throws: observedCount(observedLethalThrows),
    smoke_rescue_attempts: observedCount(inputMatches.map((m) => m.tradeStats?.smokeCount)),
    isolation_average: isolationCountFinal,
    death_phase: deathPhaseCount,
  });

  const roleEvidenceV1 = aggregateRoleEvidence(inputMatches);
  const roleEvidence = options?.roleEvidenceVersion === 2 && roleEvidenceV1
    ? {...roleEvidenceV1, version: 2 as const, team: aggregateTeamRoleEvidence(inputMatches), ...aggregateRoleCohort(inputMatches)}
    : roleEvidenceV1;
  return {
    metricMatchCounts,
    roleEvidence,
    rawMetricValues: {
      pressure_index: pressureIndexCount > 0 ? totalPressureIndex / pressureIndexCount : null,
      reaction_latency: measuredReactionLatencySec,
      backup_latency: backupLatencies.length > 0 ? backupLatencies.reduce((a, b) => a + b, 0) / backupLatencies.length / 1000 : null,
      death_phase: deathPhaseCount > 0 ? totalDeathPhase / deathPhaseCount : null,
      isolation_average: isolationCountFinal > 0 ? totalIsolationIndexFinal / isolationCountFinal : null,
    },
    mLen, avgDamage, avgKills, avgDamageImpact, avgTeamDamageShare, avgTeamKillShare, avgPlacementPct, topBadges,
    userInitiativeRate, userReversalRate, avgBackupLatency, avgReactionLatency, avgMeasuredReactionLatency, counterFailureMatches, counterObservedMatches, counterFailureRate, avgCoverRate, avgDuelWinRate,
    totalDuelWins, totalDuelLosses, totalReversalWins, totalReversalAttempts, avgDeathPhase,
    avgPressureIndex, totalLethalThrows, totalUtilityThrows, avgUtilityEfficiency, avgMinDistStr, avgHeightDiffStr,
    avgIsolationStr, avgCombatIsolationStr, avgDeathIsolationStr, goldenTimeAvg, soloKillRate, latestMatchTime, killContribFinal,
    rankedCount, normalCount, totalTeammateKnocks, totalSuppCount, totalTradeKills, totalRevCount,
    totalBaitCount, totalSmokeCount: totalRescueSmokes, totalEdgePlay, totalFatalDelay,
    totalMaxHitDist, totalTeamWipes, isolationCountFinal, combatIsolationCountFinal, deathIsolationCountFinal,
    minDistCountFinal, heightDiffCountFinal, teammateCountFinal, totalIsolationIndexFinal, totalCombatIso,
    totalDeathIso, totalMinDist, totalHeightDiff, totalCrossfireCount, totalTeammateCountFinal,
    totalUtilityHits, totalUtilityDamage, totalUtilityKills, totalBluezoneWaste, avgBluezoneWaste,
    weaponStatsFinal, totalInitiativeAttempts, totalInitiativeSuccess, totalSmokeRescues,
    totalFocusFireCount, totalCrossfireExposureCount, totalDistanceDamage,
    avgDistanceDamage: {
      short: Math.max(0, Math.round(totalDistanceDamage.short / mLen)),
      mid: Math.max(0, Math.round(totalDistanceDamage.mid / mLen)),
      long: Math.max(0, Math.round(totalDistanceDamage.long / mLen)),
    },
    totalSmokes,
    // Missing observations must not become zero or a partial total labeled
    // as the entire selected population. Rescue attempts are not total use.
    totalObservedSmokes: sumCompleteObservations(inputMatches.map((m) => m.itemUseSummary?.smokes)),
    totalObservedRescueSmokes: sumCompleteObservations(inputMatches.map((m) => m.tradeStats?.smokeCount)),
    totalObservedSmokeRescues: sumCompleteObservations(inputMatches.map((m) => m.tradeStats?.smokeRescues)),
    totalObservedTeammateKnocks: sumCompleteObservations(inputMatches.map((m) => m.tradeStats?.teammateKnocks)),
    totalObservedSupportKills: sumCompleteObservations(inputMatches.map((m) => m.tradeStats?.suppCount)),
    totalObservedTeammateKills: sumCompleteObservations(inputMatches.map((m) => m.tradeStats?.teammateKills)),
    totalObservedTradeKills: sumCompleteObservations(inputMatches.map((m) => m.tradeStats?.tradeKills)),
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
