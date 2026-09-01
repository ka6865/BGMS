export interface MatchTierInput {
  rankPct: number;           // 딜량 순위 백분율 (낮을수록 좋음)
  survivalTime: number;      // 생존 시간 (초)
  initiativeRate: number;    // 선제공격률 (0~100)
  counterLatencyMs: number;  // 대응속도 ms (낮을수록 좋음)
  pressureIndex: number;     // 압박 지수
  smokeRate: number;         // 연막 커버율 (0~100)
  suppCount: number;         // 제압사격 횟수
  reviveRate: number;        // 부활률 (0~100)
  tradeRate: number;         // 트레이드 성공률 (0~100)
  teamWipes: number;         // 팀 전멸 기여
  reversalRate: number;      // 역전 승률 (0~100)
  deathPhase: number;        // 사망 페이즈 (0~9)
  suppRate: number;          // 지원사격 확률 (0~100)
  isolationIndex?: number;   // 고립 지수 (스쿼드 전용, 0~5)
  // [V69.0] 생존 점수 고도화 필드
  survivalRankPct: number;   // 생존 순위 비율 (0~1, winPlace / maxPlace)
  myKnockCount: number;      // 내가 기절당한 횟수 (myKnockEvents.length)
  myDeathCount: number;      // 내가 사망한 횟수 (0 또는 1)
  winPlace: number;          // 최종 순위 (1~100)
  kills?: number;            // 킬 수
  damageDealt?: number;      // 유효 딜량
  teamDamageShare?: number;  // 팀 내 딜량 비중 (0~100)
  safeRevivesWithoutSmoke?: number; // 연막 없이 안전하게 완료한 소생 추정 수
  teamMode?: "solo" | "duo" | "squad";
  tradeKills?: number;
  revives?: number;
  smokeRescues?: number;
}

function finiteOr(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nonNegativeOr(value: unknown, fallback = 0): number {
  return Math.max(0, finiteOr(value, fallback));
}

function normalizeRate(value: unknown, fallback: number): number {
  const numeric = finiteOr(value, -1);
  return numeric < 0 ? fallback : Math.min(100, numeric);
}

function normalizeScore(value: unknown): number {
  const numeric = finiteOr(value, 0);
  return Number(Math.max(0, Math.min(100, numeric)).toFixed(1));
}

/**
 * 전술 분석 총점 계산 (0~100점)
 */
export function calcBenchmarkScore(input: MatchTierInput, isSolo: boolean): number {
  const result = getBenchmarkTier(input, isSolo);
  return result.score;
}

export interface BenchmarkResult {
  tier: string | null;
  score: number;
  breakdown: {
    combat: number;
    tactical: number;
    survival: number;
  };
  impactScore: number;
  impactGrade: "NORMAL" | "GOOD" | "CARRY" | "HARD_CARRY" | "LEGEND";
  impactBonus: number;
  impactReasons: string[];
  contributionTypes: Array<"FIREPOWER" | "FINISHER" | "RECOVERY" | "CLUTCH" | "SUPPORT" | "SURVIVAL_CONTROL">;
}

function getImpactGrade(score: number): BenchmarkResult["impactGrade"] {
  if (score >= 130) return "LEGEND";
  if (score >= 110) return "HARD_CARRY";
  if (score >= 95) return "CARRY";
  if (score >= 75) return "GOOD";
  return "NORMAL";
}

function getTeamDamageThresholds(input: MatchTierInput, isSolo: boolean) {
  if (isSolo || input.teamMode === "solo") return null;
  if (input.teamMode === "duo") return { core: 55, hard: 65 };
  return { core: 35, hard: 45 };
}

function getImpactAnalysis(input: MatchTierInput, isSolo: boolean, score: number): Omit<BenchmarkResult, "tier" | "score" | "breakdown"> {
  if (input.survivalTime < 300) {
    return {
      impactScore: 0,
      impactGrade: "NORMAL",
      impactBonus: 0,
      impactReasons: [],
      contributionTypes: [],
    };
  }

  const reasons: string[] = [];
  const contributionTypes = new Set<BenchmarkResult["contributionTypes"][number]>();
  const kills = input.kills || 0;
  const damageDealt = input.damageDealt || 0;
  const teamDamageShare = input.teamDamageShare || 0;
  const isTopDamageOutlier = input.rankPct <= 0.03;
  const tradeKills = input.tradeKills || 0;
  const revives = input.revives || 0;
  const smokeRescues = input.smokeRescues || 0;
  const safeRevives = input.safeRevivesWithoutSmoke || 0;
  const teamDamageThresholds = getTeamDamageThresholds(input, isSolo);
  const hasTeamDamageCore = Boolean(teamDamageThresholds && teamDamageShare >= teamDamageThresholds.core);

  let firepowerBonus = 0;
  if (kills >= 10) {
    firepowerBonus += 8;
    reasons.push("10킬 이상 화력 캐리");
    contributionTypes.add("FIREPOWER");
  } else if (kills >= 7) {
    firepowerBonus += 5;
    reasons.push("7킬 이상 고화력");
    contributionTypes.add("FIREPOWER");
  } else if (kills >= 5) {
    firepowerBonus += 3;
    reasons.push("5킬 이상 교전 기여");
    contributionTypes.add("FIREPOWER");
  }

  if (damageDealt >= 1000) {
    firepowerBonus += 12;
    reasons.push("1000딜 이상 압도적 화력");
    contributionTypes.add("FIREPOWER");
  } else if (damageDealt >= 800) {
    firepowerBonus += 8;
    reasons.push("800딜 이상 강한 화력");
    contributionTypes.add("FIREPOWER");
  } else if (damageDealt >= 500) {
    firepowerBonus += 5;
    reasons.push("500딜 이상 승리 기여");
    contributionTypes.add("FIREPOWER");
  } else if (damageDealt >= 300) {
    firepowerBonus += 2;
    reasons.push("300딜 이상 교전 참여");
    contributionTypes.add("FIREPOWER");
  }

  if (isTopDamageOutlier) {
    firepowerBonus += 7;
    reasons.push("딜량 상위 3%");
    contributionTypes.add("FIREPOWER");
  } else if (input.rankPct <= 0.10) {
    firepowerBonus += 4;
    reasons.push("딜량 상위 10%");
    contributionTypes.add("FIREPOWER");
  }

  if (teamDamageThresholds && teamDamageShare >= teamDamageThresholds.hard) {
    firepowerBonus += 7;
    reasons.push(input.teamMode === "duo" ? "듀오 팀 딜 65% 이상" : "스쿼드 팀 딜 45% 이상");
    contributionTypes.add("FIREPOWER");
  } else if (teamDamageThresholds && teamDamageShare >= teamDamageThresholds.core) {
    firepowerBonus += 4;
    reasons.push(input.teamMode === "duo" ? "듀오 팀 딜 55% 이상" : "스쿼드 팀 딜 35% 이상");
    contributionTypes.add("FIREPOWER");
  }

  let roleBonus = 0;
  const hasFinisherSupport = damageDealt >= 500 || kills >= 5 || hasTeamDamageCore || tradeKills >= 1 || revives >= 1;
  if (!isSolo && input.teamWipes >= 2 && hasFinisherSupport) {
    roleBonus += input.teamWipes >= 4 ? 6 : 3;
    reasons.push(input.teamWipes >= 4 ? "적 팀 전멸 다수 결정 기여" : "적 팀 전멸 결정 기여");
    contributionTypes.add("FINISHER");
  } else if (!isSolo && input.teamWipes >= 2) {
    roleBonus += 1;
    reasons.push("전멸 마무리 기여");
    contributionTypes.add("FINISHER");
  }

  if (!isSolo && tradeKills >= 1) {
    roleBonus += 3;
    reasons.push("트레이드 성공");
    contributionTypes.add("SUPPORT");
  }
  if (!isSolo && revives >= 1) {
    roleBonus += 3;
    reasons.push("소생 성공");
    contributionTypes.add("RECOVERY");
  }
  if (!isSolo && smokeRescues >= 1) {
    roleBonus += 3;
    reasons.push("연막 구출 성공");
    contributionTypes.add("RECOVERY");
  }
  if (!isSolo && safeRevives > 0) {
    roleBonus += 3;
    reasons.push("연막 없이 안전 소생");
    contributionTypes.add("RECOVERY");
  }

  let actionEvidenceCount = 0;
  if (kills >= 5) actionEvidenceCount += 1;
  if (damageDealt >= 500) actionEvidenceCount += 1;
  if (input.rankPct <= 0.10) actionEvidenceCount += 1;
  if (hasTeamDamageCore) actionEvidenceCount += 1;
  if (!isSolo && input.teamWipes >= 2 && hasFinisherSupport) actionEvidenceCount += 1;
  if (!isSolo && tradeKills >= 1) actionEvidenceCount += 1;
  if (!isSolo && (revives >= 1 || smokeRescues >= 1 || safeRevives > 0)) actionEvidenceCount += 1;
  let riskManagementEvidenceCount = 0;
  if (input.myDeathCount === 0) riskManagementEvidenceCount += 1;
  if ((input.isolationIndex || 0) < 2) riskManagementEvidenceCount += 1;
  const winEvidenceCount = actionEvidenceCount > 0
    ? actionEvidenceCount + Math.min(1, riskManagementEvidenceCount)
    : 0;

  let winContributionBonus = 0;
  if (input.winPlace === 1 && winEvidenceCount >= 4) {
    winContributionBonus = 10;
    reasons.push("승리 기여 근거 4개 이상");
    contributionTypes.add("SURVIVAL_CONTROL");
  } else if (input.winPlace === 1 && winEvidenceCount >= 3) {
    winContributionBonus = 7;
    reasons.push("명확한 승리 기여");
    contributionTypes.add("SURVIVAL_CONTROL");
  } else if (input.winPlace === 1 && winEvidenceCount >= 2) {
    winContributionBonus = 4;
    reasons.push("승리 기여 근거 2개");
    contributionTypes.add("SURVIVAL_CONTROL");
  }

  if (input.reversalRate >= 80) {
    roleBonus += 3;
    reasons.push("불리한 교전 역전");
    contributionTypes.add("CLUTCH");
  }

  let riskPenalty = 0;
  if (input.survivalTime < 600 || (input.myDeathCount > 0 && input.deathPhase <= 3)) {
    riskPenalty += 8;
    reasons.push("조기 사망 리스크 감경");
  }
  if ((input.isolationIndex || 0) >= 4.5) {
    riskPenalty += 6;
    reasons.push("고립 리스크 감경");
  }

  const impactBonus = Number(Math.max(0, firepowerBonus + winContributionBonus + roleBonus - riskPenalty).toFixed(1));
  const impactScore = Number((score + impactBonus).toFixed(1));

  return {
    impactScore,
    impactGrade: getImpactGrade(impactScore),
    impactBonus,
    impactReasons: reasons,
    contributionTypes: Array.from(contributionTypes),
  };
}

export function calcBenchmarkScoreDetails(input: MatchTierInput, isSolo: boolean): BenchmarkResult["breakdown"] {
  const survivalTime = finiteOr(input.survivalTime, 0);
  const myDeathCount = nonNegativeOr(input.myDeathCount);
  const deathPhase = nonNegativeOr(input.deathPhase);
  const rankPct = finiteOr(input.rankPct, 1);
  const pressureIndex = finiteOr(input.pressureIndex, 0);
  const teamWipes = nonNegativeOr(input.teamWipes);
  const isolationIndex = nonNegativeOr(input.isolationIndex);
  const winPlace = finiteOr(input.winPlace, Number.MAX_SAFE_INTEGER);

  if (survivalTime < 300) return { combat: 0, tactical: 0, survival: 0 };

  // 조기 탈락 조건 판단 (10분 미만 생존 혹은 3페이즈 이하 사망)
  const isEarlyDeath = survivalTime < 600 || (myDeathCount > 0 && deathPhase <= 3);

  // 상황별 폴백 값 분기 대입
  const safeInitiative = normalizeRate(input.initiativeRate, 45);
  // [V68.0] 기회 없음(-1)인 경우, 조기 광탈은 30%만 인정하되 정상 탈락은 무결점 우대로 100% 만점 처리.
  const safeRevive = normalizeRate(input.reviveRate, isEarlyDeath ? 30 : 100);
  const safeTrade = normalizeRate(input.tradeRate, isEarlyDeath ? 30 : 100);
  const safeSmoke = normalizeRate(input.smokeRate, isEarlyDeath ? 30 : 100);
  const safeSuppRate = normalizeRate(input.suppRate, isEarlyDeath ? 30 : 100);
  const safeReversal = normalizeRate(
    input.reversalRate,
    isEarlyDeath ? 10 : myDeathCount === 0 && survivalTime >= 1200 ? 100 : 50,
  );

  const counterLatencyMs = finiteOr(input.counterLatencyMs, -1);
  const latencyScoreBase = counterLatencyMs < 0 ? 5 :
    (counterLatencyMs === 0 ? 0 : Math.max(0, Math.min(10, ((3000 - counterLatencyMs) / 2000) * 10)));

  let combatScore = 0;
  let tacticalScore = 0;
  let survivalScore = 0;

  if (isSolo) {
    const damageScore = rankPct <= 0.10 ? 25 : rankPct <= 0.25 ? 18 : rankPct <= 0.50 ? 12 : 5;
    const initiativeScore = Math.max(0, Math.min(15, (safeInitiative / 60) * 15)); // 70% -> 60% 완화
    combatScore = Number((damageScore + initiativeScore + latencyScoreBase).toFixed(1));

    const pressureScore = Math.max(0, Math.min(10, (pressureIndex / 5) * 10));
    const reversalScore = Math.max(0, Math.min(5, (safeReversal / 100) * 5));
    tacticalScore = Number((pressureScore + reversalScore).toFixed(1));

    // [V69.0] 솔로 생존 점수 개편 (사망페이즈/생존시간 중복 해소 및 맵 크기 왜곡 방지)
    const safeSurvivalRankPct = Math.max(0, Math.min(1, finiteOr(input.survivalRankPct, 1)));
    const rankScore = Math.max(0, Math.min(30, (1 - safeSurvivalRankPct) * 30));
    const top10Score = winPlace <= 10 ? 5 : 0;
    survivalScore = Number((rankScore + top10Score).toFixed(1));

  } else {
    const damageScore = rankPct <= 0.10 ? 20 : rankPct <= 0.25 ? 15 : rankPct <= 0.50 ? 10 : 5;
    const initiativeScore = Math.max(0, Math.min(10, (safeInitiative / 60) * 10)); // 70% -> 60% 완화
    combatScore = Number((damageScore + initiativeScore + latencyScoreBase).toFixed(1));

    const pressureScore = Math.max(0, Math.min(10, (pressureIndex / 5) * 10));
    const suppCount = nonNegativeOr(input.suppCount);
    const utilityScore = Math.max(0, Math.min(10, (safeSmoke / 100) * 5 + Math.min(5, suppCount / 1.2))); // 10회 -> 6회 완화
    const teamScore = Math.max(0, Math.min(10, (safeRevive / 100) * 3 + (safeTrade / 100) * 2 + (safeSuppRate / 100) * 2 + Math.min(3, teamWipes * 1.5)));
    const reversalScore = Math.max(0, Math.min(5, (safeReversal / 100) * 5));
    
    const rawTactical = pressureScore + utilityScore + teamScore + reversalScore;

    // [V68.0] 스쿼드 모드 고립 지수 페널티 차감 (솔로 제외)
    const isolationPenalty = isolationIndex >= 3.5
      ? Math.min(3, (isolationIndex - 3.5) * 2) : 0;
    
    tacticalScore = Number(Math.max(0, rawTactical - isolationPenalty).toFixed(1));

    // [V69.0] 스쿼드 생존 점수 개편 (생존 순위 비율 20점 + 기절 후 생존 관리력 5점)
    const safeSurvivalRankPct = Math.max(0, Math.min(1, finiteOr(input.survivalRankPct, 1)));
    const rankScore = Math.max(0, Math.min(20, (1 - safeSurvivalRankPct) * 20));
    let groggyScore = 5;
    const myKnockCount = nonNegativeOr(input.myKnockCount);
    if (myKnockCount > 0) {
      const knockSurvivalRate = 1 - (myDeathCount / myKnockCount);
      groggyScore = Math.max(0, Math.min(5, knockSurvivalRate * 5));
    } else if (myDeathCount === 1) {
      groggyScore = 0; // 한 번도 기절 없이 바로 즉사한 경우
    }
    survivalScore = Number((rankScore + groggyScore).toFixed(1));
  }

  return {
    combat: normalizeScore(combatScore),
    tactical: normalizeScore(tacticalScore),
    survival: normalizeScore(survivalScore),
  };
}

/**
 * 세분화된 13단계 티어 판정 (S ~ D-)
 */
export function getBenchmarkTier(input: MatchTierInput, isSolo: boolean): BenchmarkResult {
  if (input.survivalTime < 300) {
    return {
      tier: null,
      score: 0,
      breakdown: { combat: 0, tactical: 0, survival: 0 },
      impactScore: 0,
      impactGrade: "NORMAL",
      impactBonus: 0,
      impactReasons: [],
      contributionTypes: [],
    };
  }

  const breakdown = calcBenchmarkScoreDetails(input, isSolo);
  const totalScore = normalizeScore(breakdown.combat + breakdown.tactical + breakdown.survival);
  const impact = getImpactAnalysis(input, isSolo, totalScore);

  let tier = 'D-';
  if (totalScore >= 90) tier = 'S+';
  else if (totalScore >= 82) tier = 'S';
  else if (totalScore >= 75) tier = 'A+';
  else if (totalScore >= 68) tier = 'A';
  else if (totalScore >= 60) tier = 'A-';
  else if (totalScore >= 52) tier = 'B+';
  else if (totalScore >= 44) tier = 'B';
  else if (totalScore >= 36) tier = 'B-';
  else if (totalScore >= 28) tier = 'C+';
  else if (totalScore >= 20) tier = 'C';
  else if (totalScore >= 12) tier = 'C-';
  else if (totalScore >= 6) tier = 'D+';
  else if (totalScore >= 3) tier = 'D';

  return {
    tier,
    score: totalScore,
    breakdown,
    ...impact,
  };
}

/**
 * 세부 티어를 벤치마크 조회용 베이스 티어(S, A, B, C, D)로 변환
 */
export function getBaseTier(tier: string | null): string {
  if (!tier) return 'C';
  if (tier === 'S+' || tier === 'S') return 'S';
  if (tier.startsWith('A')) return 'A';
  if (tier.startsWith('B')) return 'B';
  if (tier.startsWith('C')) return 'C';
  if (tier.startsWith('D')) return 'D';
  return 'C';
}

/**
 * 평균 점수 기반 사용자 대표 티어 추정
 */
/**
 * 티어 점수 경계값 정의
 */
export const TIER_THRESHOLDS = [
  { tier: 'S+', min: 90 },
  { tier: 'S', min: 82 },
  { tier: 'A+', min: 75 },
  { tier: 'A', min: 68 },
  { tier: 'A-', min: 60 },
  { tier: 'B+', min: 52 },
  { tier: 'B', min: 44 },
  { tier: 'B-', min: 36 },
  { tier: 'C+', min: 28 },
  { tier: 'C', min: 20 },
  { tier: 'C-', min: 12 },
  { tier: 'D+', min: 6 },
  { tier: 'D', min: 3 },
  { tier: 'D-', min: 0 },
];

/**
 * 평균 점수 기반 사용자 대표 티어 추정
 */
export function estimateUserTier(avgScore: number): string {
  const found = TIER_THRESHOLDS.find(t => avgScore >= t.min);
  return found ? found.tier : 'D-';
}

/**
 * 다음 티어까지 필요한 점수 정보 조회
 */
export function getNextTierInfo(currentScore: number) {
  const currentTier = estimateUserTier(currentScore);
  if (currentTier === 'S+') return null;

  const currentIndex = TIER_THRESHOLDS.findIndex(t => t.tier === currentTier);
  if (currentIndex <= 0) return null;

  const nextTier = TIER_THRESHOLDS[currentIndex - 1];
  return {
    tier: nextTier.tier,
    needed: Number((nextTier.min - currentScore).toFixed(1))
  };
}
