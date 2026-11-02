/**
 * 전적 요약의 최근 경기 집계(aggregateMatches)와 그 전용 관측값 헬퍼.
 *
 * AI 전적 요약 라우트와 칭호 기준 재산출 스크립트(scripts/recalibrate_role_reference.ts)가 같은 함수를 쓴다.
 * 라우트에서 옮긴 동작 불변 이동이며, 집계 규칙을 바꾸면 두 소비자가 함께 바뀐다.
 */
import { ANALYSIS_CALCULATION_VERSION, WEAPON_NAMES } from "./constants";
import { firstReplyFailureRate, firstReplyLatencyMs } from "./firstReply";

/** 경기의 모드 문자열(소문자, 공백 제거). 라우트의 모드 분류와 같은 필드 순서를 쓴다. */
export function normalizedMatchMode(match: any): string {
  const rawMode = match?.gameMode
    ?? match?.game_mode
    ?? match?.mode
    ?? match?.matchInfo?.mode;
  return String(rawMode ?? "").trim().toLowerCase();
}

/**
 * 모드 이름에서 팀 인원 수를 구한다. 듀오 2명, 스쿼드 4명이며 그 밖의 모드는 null이다(팀 비중 보정 대상 아님).
 * 공정 분담은 100 / 인원 수(듀오 50%, 스쿼드 25%)다.
 */
export function teamSizeOfMode(mode: unknown): number | null {
  const text = String(mode ?? "").toLowerCase();
  if (text.includes("solo")) return null;
  if (text.includes("duo")) return 2;
  if (text.includes("squad")) return 4;
  return null;
}

export function normalizeWeaponName(weaponId: string): string {
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

export function coerceFiniteNumber(value: unknown): number {
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
export function readIsolationMeasurement(value: unknown): number | null {
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

export function readObservedNonNegative(value: unknown): number | null {
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

export function coerceNonNegativeNumber(value: unknown): number {
  return Math.max(0, coerceFiniteNumber(value));
}

export function firstObservedNonNegative(...values: unknown[]): number | null {
  for (const value of values) {
    const observed = readObservedNonNegative(value);
    if (observed !== null) return observed;
  }
  return null;
}

export function addObservedTotal(total: number | null, value: unknown): number | null {
  const observed = readObservedNonNegative(value);
  return observed === null ? total : (total ?? 0) + observed;
}

export function sumCompleteObservations(values: unknown[]): number | null {
  const observed = values.map(readObservedNonNegative);
  if (observed.length === 0 || observed.some((value) => value === null)) return null;
  return (observed as number[]).reduce((total, value) => total + value, 0);
}

export function aggregateMatches(matches: any[]) {
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
  // 칭호 배지용: 선택된 경기의 우승 횟수와, 계산 5 경기에서 내 기여로 귀속된 팀 전멸 수
  let totalWins = 0, totalTeamWipesCalc5 = 0;
  // 팀 피해 비중을 공정 분담(100 / 인원 수) 대비 배수로 바꾼 값의 경기별 합
  let fairTeamDamageSum = 0, fairTeamDamageCount = 0;
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
        if (event.type === 'KILL' || event.type === 'KNOCK') {
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
    if (Number(m.stats?.winPlace) === 1) totalWins++;
    if (Number(m.calculationVersion) === ANALYSIS_CALCULATION_VERSION) {
      totalTeamWipesCalc5 += coerceNonNegativeNumber(m.tradeStats?.enemyTeamWipes);
    }

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
    // 듀오·스쿼드만 공정 분담 대비로 바꾼다(1.0 = 공정 분담). 솔로와 인원 불명 모드는 빼서 섞지 않는다.
    const teamSize = teamSizeOfMode(normalizedMatchMode(m));
    if (teamDamageShare !== null && teamSize !== null) {
      fairTeamDamageSum += (Math.min(100, teamDamageShare) * teamSize) / 100;
      fairTeamDamageCount++;
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
        if (event.type === 'KILL' || event.type === 'KNOCK') {
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
  const avgTeamDamageShareFair = fairTeamDamageCount > 0
    ? Number((fairTeamDamageSum / fairTeamDamageCount).toFixed(3))
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

  return {
    metricMatchCounts,
    rawMetricValues: {
      pressure_index: pressureIndexCount > 0 ? totalPressureIndex / pressureIndexCount : null,
      reaction_latency: measuredReactionLatencySec,
      backup_latency: backupLatencies.length > 0 ? backupLatencies.reduce((a, b) => a + b, 0) / backupLatencies.length / 1000 : null,
      death_phase: deathPhaseCount > 0 ? totalDeathPhase / deathPhaseCount : null,
      isolation_average: isolationCountFinal > 0 ? totalIsolationIndexFinal / isolationCountFinal : null,
    },
    mLen, avgDamage, avgKills, avgDamageImpact, avgTeamDamageShare, avgTeamDamageShareFair, avgTeamKillShare, avgPlacementPct, topBadges,
    totalWins, totalTeamWipesCalc5,
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
