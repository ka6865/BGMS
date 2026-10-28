import type { TeamRoleEvidence } from "./summaryAggregate";
import { WEAPON_NAMES, IGNORE_WEAPONS } from "./constants";
import { referencePercentile, roleScorePercentile, ROLE_SCORE_QUANTILES, type RoleMetricKey, type RoleReference } from "./roleReference";

/**
 * PUBG 전술 직업군 분류기 (Role Classifier)
 * 최근 상위 경기 집계를 지표별로 기준 분포(roleReference)의 백분위로 바꾸고,
 * 다른 플레이어보다 두드러지는 역할을 칭호로 정한다. 티어는 칭호에 넣지 않는다.
 */

export type RoleKey =
  | "pointMan" | "phantomOverwatch" | "executor" | "shield" | "avenger" | "zoneController" | "dropPredator"
  | "decoy" | "grenadier" | "brawler" | "mainGun" | "crossfire" | "fieldCommander";

// 역할별 백분위(0~100). 근거가 부족한 역할은 null이다.
export type RoleScore = Record<RoleKey, number | null>;

export interface RoleInfo {
  primaryRole: RoleKey | "balanced" | "pending" | "insufficient";
  secondaryRole: RoleKey | null;
  overallTier: string;
  title: string;
  roleLabel: string;
  description: string;
  evidence: string[];
  badges: string[];
  signatureWeapon: string;
  signatureWeaponStats?: {
    kills: number;
    dbnos: number;
    consistency?: number;
    isReliable?: boolean;
  };
  weakness: string | null;
  scores: RoleScore;
  status?: "confirmed" | "balanced" | "pending" | "insufficient";
  reason?: string;
  observedRoleCount?: number;
  presentation?: "role" | "observed" | "combined" | "insufficient";
  observedRoles?: RoleKey[];
}

interface RoleDefinition {
  label: string;
  title: string;
  description: string;
  metrics: RoleMetricKey[];
  teamOnly?: boolean;
}

const ROLE_DEFINITIONS: Record<Exclude<RoleKey, "fieldCommander">, RoleDefinition> = {
  pointMan: {
    label: "선봉대 (Point Man)", title: "교전의 선봉", metrics: ["initiative", "reactionSec"],
    description: "선제 타격 교전의 성공률과 피격 후 반격 기록이 두드러집니다.",
  },
  phantomOverwatch: {
    label: "저격 유령 (Phantom Overwatch)", title: "침묵의 감시자", metrics: ["longShare", "maxHitDist"],
    description: "200m 밖 원거리에서 넣는 피해 비중이 높고 먼 거리까지 명중시킵니다.",
  },
  executor: {
    label: "처형자 (Executor)", title: "결투의 제왕", metrics: ["duelWin", "reversal"],
    description: "1:1 교전을 끝까지 이겨 내고, 불리한 교전도 뒤집습니다.",
  },
  shield: {
    label: "구조대 (Shield)", title: "전우의 수호신", metrics: ["rescueRate"], teamOnly: true,
    description: "기절한 아군을 소생하거나 연막으로 구출하는 비율이 높습니다.",
  },
  avenger: {
    label: "복수자 (Avenger)", title: "복수의 추적자", metrics: ["tradeRate", "tradeSec"], teamOnly: true,
    description: "아군을 기절시킨 적을 빠르게 찾아 처치합니다.",
  },
  zoneController: {
    label: "전장 통제자 (Zone Controller)", title: "자기장의 주인", metrics: ["pressure", "placement", "edgePerMatch"],
    description: "자기장 가장자리를 타며 적을 압박하고 높은 순위까지 살아남습니다.",
  },
  dropPredator: {
    label: "핫드랍 약탈자 (Drop Predator)", title: "핫존의 포식자", metrics: ["earlyShare"],
    description: "경기 초반에 넣는 피해 비중이 높습니다.",
  },
  decoy: {
    label: "미끼 전술가 (Decoy)", title: "희생의 전략가", metrics: ["baitPerMatch", "supportPerMatch"], teamOnly: true,
    description: "적의 시선을 끌고, 팀원이 처치하도록 지원합니다.",
  },
  grenadier: {
    label: "투척 전문가 (Grenadier)", title: "폭발의 설계자", metrics: ["utilityHitsPerMatch", "lethalPerMatch"],
    description: "수류탄·화염병 같은 피해형 투척물을 자주 쓰고 적중시킵니다.",
  },
  brawler: {
    label: "근접 난전가 (Brawler)", title: "난전의 지배자", metrics: ["shortShare"],
    description: "50m 안쪽 근거리에서 넣는 피해 비중이 높습니다.",
  },
  mainGun: {
    label: "팀의 주포 (Main Gun)", title: "화력의 중심", metrics: ["teamDamageShare"], teamOnly: true,
    description: "팀 전체 피해 중 큰 몫을 직접 넣습니다.",
  },
  crossfire: {
    label: "협공 설계자 (Crossfire)", title: "십자포화의 지휘자", metrics: ["focusFirePerMatch", "assistShare"], teamOnly: true,
    description: "팀원과 같은 적을 동시에 공격해 함께 처치합니다.",
  },
};

const FIELD_COMMANDER = {
  label: "전장의 지휘관 (Field Commander)", title: "육각형 플레이어",
  description: "여러 역할에서 고르게 상위권입니다. 한 가지에 치우치지 않고 상황에 맞게 움직입니다.",
};
const BALANCED = {
  label: "균형형", title: "균형형 전술가",
  description: "특정 역할이 다른 플레이어보다 두드러지지 않습니다. 여러 상황을 고르게 경험하고 있습니다.",
};
const INSUFFICIENT = {
  label: "근거 수집 중", title: "전술 분석 중",
  description: "역할을 판정할 만큼 교전·팀 기록이 쌓이지 않았습니다.",
};
const PENDING = {
  label: "칭호 미확정", title: "역할 판정 보류",
  description: "판정 가능한 역할 근거는 있으나 확정 또는 균형형 기준을 충족하지 않았습니다.",
};

// 두 역할이 모두 강할 때만 쓰는 조합 칭호. 순서와 무관하게 찾는다.
const COMBO_TITLES: Array<[RoleKey, RoleKey, string]> = [
  ["executor", "pointMan", "선봉의 심판자"],
  ["executor", "zoneController", "전장의 사신"],
  ["executor", "phantomOverwatch", "그림자 처형자"],
  ["executor", "mainGun", "전장의 군주"],
  ["shield", "avenger", "최후의 방어선"],
  ["shield", "decoy", "희생의 수호자"],
  ["pointMan", "brawler", "교전의 선봉장"],
  ["phantomOverwatch", "zoneController", "외곽의 지배자"],
  ["grenadier", "brawler", "폭발의 난투꾼"],
  ["dropPredator", "brawler", "핫존 난투왕"],
  ["crossfire", "avenger", "연계 사냥꾼"],
  ["mainGun", "crossfire", "화력 연계의 축"],
];

const METRIC_LABELS: Record<RoleMetricKey, string> = {
  initiative: "선제 타격 성공률", reactionSec: "반격 소요 시간", duelWin: "1:1 승률", reversal: "역전 승률",
  longShare: "원거리 피해 비중", shortShare: "근거리 피해 비중", maxHitDist: "최대 명중 거리",
  rescueRate: "기절 아군 구조율", tradeRate: "복수 처치율", tradeSec: "복수 속도", pressure: "압박 지수",
  placement: "평균 순위", edgePerMatch: "자기장 가장자리 운영", earlyShare: "초반 피해 비중",
  baitPerMatch: "미끼 플레이", supportPerMatch: "처치 지원", utilityHitsPerMatch: "투척물 적중",
  lethalPerMatch: "피해형 투척", teamDamageShare: "팀 내 피해 비중", focusFirePerMatch: "협공 타격",
  assistShare: "협공 처치 비중",
};

// 값이 낮을수록 좋은 지표(초 단위 지연)는 백분위를 뒤집는다.
const LOWER_IS_BETTER = new Set<RoleMetricKey>(["reactionSec", "tradeSec"]);

// 역할 백분위 기준. 운영 표본(2026-10-17)에서 역할별 3~9%, 지휘관 약 2%, 균형형 약 25%가 되도록 정했다.
const PRIMARY_MIN_PERCENTILE = 85;
const SECONDARY_MIN_PERCENTILE = 85;
const COMMANDER_ROLE_PERCENTILE = 75;
const COMMANDER_MIN_ROLES = 6;
const COMMANDER_MAX_TOP = 95;
const WEAKNESS_MAX_PERCENTILE = 20;
const MIN_DISTANCE_DAMAGE = 300;


/**
 * 시그니처 무기 및 상세 스탯 추출
 */
function getSignatureWeapon(weaponStats: Record<string, any>, matchCountStats: Record<string, number> = {}, totalMatches: number = 1) {
  if (!weaponStats || Object.keys(weaponStats).length === 0) return { name: "주먹", stats: { kills: 0, dbnos: 0, consistency: 0, isReliable: false }, isSpecial: false };

  const sorted = Object.entries(weaponStats)
    .filter(([id]) => !IGNORE_WEAPONS.includes(id) && id !== "None")
    .sort((a, b) => {
      const scoreA = (a[1].kills || 0) * 2 + (a[1].dbnos || 0);
      const scoreB = (b[1].kills || 0) * 2 + (b[1].dbnos || 0);
      return scoreB - scoreA;
    });

  if (sorted.length === 0) return { name: "전술가", stats: { kills: 0, dbnos: 0, consistency: 0, isReliable: false }, isSpecial: false };
  
  const [bestId, stats] = sorted[0];
  const score = (stats.kills || 0) * 2 + (stats.dbnos || 0);
  
  // [V16.0] 매치 일관성 계산
  const matchUsed = matchCountStats[bestId] || 1;
  const consistency = Math.round((matchUsed / totalMatches) * 100);
  
  let name = WEAPON_NAMES[bestId] || bestId.replace(/Item_Weapon_|Weap|_C/g, "");
  let isSpecial = false;

  const lowerBestId = bestId.toLowerCase();
  const isVehicle = bestId.includes("BP_") || 
    lowerBestId.includes("vehicle") ||
    lowerBestId.includes("uaz") ||
    lowerBestId.includes("dacia") ||
    lowerBestId.includes("coupe") ||
    lowerBestId.includes("mirado") ||
    lowerBestId.includes("pony") ||
    lowerBestId.includes("porter") ||
    lowerBestId.includes("zima") ||
    lowerBestId.includes("brdm") ||
    lowerBestId.includes("motorcycle") ||
    lowerBestId.includes("motorbike") ||
    lowerBestId.includes("pickup") ||
    ["다시아", "uaz", "쿠페 rb", "오토바이", "지마", "포터", "포니 쿠페", "미라도", "툭툭", "로니", "픽업트럭", "brdm", "보급 트럭", "아쿠아레일", "보트", "차량"].includes(lowerBestId);

  if (isVehicle) {
    name = "고라니 사냥꾼";
    isSpecial = true;
  } else if (bestId.includes("Proj") || bestId.includes("Grenade") || bestId.includes("Molotov") || lowerBestId.includes("grenade") || lowerBestId.includes("molotov") || lowerBestId.includes("c4") || lowerBestId.includes("stickygrenade") || lowerBestId.includes("smokebomb") || lowerBestId.includes("flashbang")) {
    name = "폭파 전문가";
    isSpecial = true;
  } else if (bestId === "Unknown") {
    name = "어둠의 암살자";
    isSpecial = true;
  }

  return {
    name,
    stats: { 
      kills: stats.kills || 0, 
      dbnos: stats.dbnos || 0,
      consistency,
      isReliable: score >= 6 && consistency >= 50 // 절반 이상의 경기에서 사용 시 신뢰
    },
    isSpecial
  };
}

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? (100 * numerator) / denominator : null;

/**
 * ai-summary aggregateMatches 결과에서 역할 지표를 뽑는다. 기회가 부족한 지표는 null이다.
 * 기준 분포(roleReference)와 같은 정의와 최소 기회 수를 쓴다.
 */
type RoleEvidenceV1 = {
  version: 1; matchCount: number; validWeaponHits: number; distanceHitCount: number;
  distanceDamage: { short: number; mid: number; long: number }; maxHitDist: number | null; pressureIndex: number | null;
  teamMatchCount?: number;
  focusFireCount: number; rescueCount: number; rescueOpportunityCount: number; positionSampleCount: number; edgePlayCount: number;
  goldenTimeDamage: { early: number; mid1: number; mid2: number; late: number } | null;
  metricMatchCounts: Record<string, number>;
};

const COMPLETE_METRIC_COUNTS = ["initiative", "duelWin", "reversal", "tradeRate", "placement", "baitPerMatch", "supportPerMatch", "teamDamageShare", "assistShare"] as const;

function validRoleEvidenceV1(value: any, mLen: number): value is RoleEvidenceV1 {
  const finiteNonNegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const count = (v: unknown) => finiteNonNegative(v) && Number.isInteger(v);
  if (!Number.isInteger(mLen) || mLen < 1 || !value || value.version !== 1 || !count(value.matchCount) || value.matchCount !== mLen
    || !count(value.validWeaponHits) || !count(value.distanceHitCount) || value.distanceHitCount > value.validWeaponHits
    || !count(value.focusFireCount) || !count(value.rescueCount)
    || !count(value.rescueOpportunityCount) || value.rescueCount > value.rescueOpportunityCount
    || !count(value.positionSampleCount) || !count(value.edgePlayCount) || value.edgePlayCount > value.positionSampleCount
    || !(value.maxHitDist === null || finiteNonNegative(value.maxHitDist))
    || !(value.pressureIndex === null || finiteNonNegative(value.pressureIndex))
    || (value.distanceHitCount === 0 ? value.maxHitDist !== null : value.maxHitDist === null)
    || (value.validWeaponHits === 0 ? value.pressureIndex !== null : value.pressureIndex === null)) return false;
  if (!value.distanceDamage || !["short", "mid", "long"].every((key) => finiteNonNegative(value.distanceDamage[key]))) return false;
  if (!(value.goldenTimeDamage === null || (value.goldenTimeDamage && ["early", "mid1", "mid2", "late"].every((key) => finiteNonNegative(value.goldenTimeDamage[key]))))) return false;
  return COMPLETE_METRIC_COUNTS.every((key) => count(value.metricMatchCounts?.[key]) && value.metricMatchCounts[key] <= mLen);
}

type RoleEvidenceV2 = Omit<RoleEvidenceV1, "version"> & {version: 2; team: TeamRoleEvidence};

function validRoleEvidenceV2(value: any, mLen: number): value is RoleEvidenceV2 {
  if (value?.version !== 2 || !validRoleEvidenceV1({...value, version: 1}, mLen)) return false;
  const team = value.team;
  const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const count = (v: unknown): v is number => nonNegative(v) && Number.isInteger(v);
  if (!team || !count(team.matchCount) || team.matchCount > mLen) return false;
  if (!["teamDamageShareMatches", "tradeRateMatches", "tradeLatencyMatches", "supportMatches", "crossfireMatches"]
    .every(key => count(team[key]) && team[key] <= team.matchCount)) return false;
  if (!["rescueCount", "rescueOpportunityCount", "tradeKills", "teammateKnocks"].every(key => count(team[key]))
    || team.rescueCount > team.rescueOpportunityCount || team.tradeLatencyMatches > team.tradeRateMatches) return false;
  return ["teamDamageShare", "tradeLatencySec", "baitPerMatch", "supportPerMatch", "focusFirePerMatch", "assistShare"]
    .every(key => team[key] === null || nonNegative(team[key]))
    && (team.teamDamageShare === null || team.teamDamageShare <= 100)
    && (team.assistShare === null || team.assistShare <= 100);
}

function extractEvidenceV2Metrics(stats: any, evidence: RoleEvidenceV2): Record<RoleMetricKey, number | null> {
  const metrics = extractEvidenceV1Metrics(stats, {...evidence, version: 1});
  const team = evidence.team;
  const complete = (count: number) => team.matchCount > 0 && count === team.matchCount;
  const throws = finiteOrNull(stats.totalLethalThrows);
  const hits = finiteOrNull(stats.totalUtilityHits);
  const eligibleThrows = throws !== null && throws >= 3 && hits !== null && hits >= 1;
  return {...metrics,
    rescueRate: team.matchCount > 0 && team.rescueOpportunityCount >= 3 ? ratio(team.rescueCount, team.rescueOpportunityCount) : null,
    teamDamageShare: complete(team.teamDamageShareMatches) ? team.teamDamageShare : null,
    tradeRate: complete(team.tradeRateMatches) && team.teammateKnocks >= 3 ? ratio(team.tradeKills, team.teammateKnocks) : null,
    tradeSec: complete(team.tradeRateMatches) && team.tradeLatencyMatches > 0 ? team.tradeLatencySec : null,
    baitPerMatch: complete(team.supportMatches) ? team.baitPerMatch : null,
    supportPerMatch: complete(team.supportMatches) ? team.supportPerMatch : null,
    focusFirePerMatch: complete(team.crossfireMatches) ? team.focusFirePerMatch : null,
    assistShare: complete(team.crossfireMatches) ? team.assistShare : null,
    utilityHitsPerMatch: eligibleThrows ? hits! / stats.mLen : null,
    lethalPerMatch: eligibleThrows ? throws! / stats.mLen : null,
  };
}

function extractEvidenceV1Metrics(stats: any, evidence: RoleEvidenceV1): Record<RoleMetricKey, number | null> {
  const mLen = stats.mLen;
  const complete = (key: typeof COMPLETE_METRIC_COUNTS[number]) => evidence.metricMatchCounts[key] === mLen;
  const count = (key: typeof COMPLETE_METRIC_COUNTS[number], value: unknown) => complete(key) ? finiteOrNull(value) : null;
  const distance = evidence.distanceDamage;
  const distanceTotal = distance.short + distance.mid + distance.long;
  const golden = evidence.goldenTimeDamage;
  const goldenTotal = golden ? golden.early + golden.mid1 + golden.mid2 + golden.late : 0;
  const teammateKnocks = Math.max(0, finiteOrNull(stats?.totalTeammateKnocks) ?? 0);
  const contrib = stats?.killContribFinal ?? {};
  const assist = Math.max(0, finiteOrNull(contrib.assist) ?? 0);
  const killTotal = assist + Math.max(0, finiteOrNull(contrib.solo) ?? 0) + Math.max(0, finiteOrNull(contrib.cleanup) ?? 0);
  const utilityHits = finiteOrNull(stats?.totalUtilityHits);
  const lethal = finiteOrNull(stats?.totalLethalThrows);
  const hasThrowOpportunity = utilityHits !== null && lethal !== null && utilityHits + lethal > 0;

  return {
    initiative: (finiteOrNull(stats?.totalInitiativeAttempts) ?? 0) >= 3 ? count("initiative", stats?.userInitiativeRate) : null,
    reactionSec: finiteOrNull(stats?.avgMeasuredReactionLatency),
    duelWin: (Math.max(0, finiteOrNull(stats?.totalDuelWins) ?? 0) + Math.max(0, finiteOrNull(stats?.totalDuelLosses) ?? 0)) >= 3 ? count("duelWin", stats?.avgDuelWinRate) : null,
    reversal: (finiteOrNull(stats?.totalReversalAttempts) ?? 0) >= 2 ? count("reversal", stats?.userReversalRate) : null,
    longShare: distanceTotal >= MIN_DISTANCE_DAMAGE && evidence.distanceHitCount > 0 ? ratio(distance.long, distanceTotal) : null,
    shortShare: distanceTotal >= MIN_DISTANCE_DAMAGE && evidence.distanceHitCount > 0 ? ratio(distance.short, distanceTotal) : null,
    maxHitDist: evidence.distanceHitCount > 0 ? evidence.maxHitDist : null,
    rescueRate: evidence.rescueOpportunityCount >= 3 ? ratio(evidence.rescueCount, evidence.rescueOpportunityCount) : null,
    tradeRate: teammateKnocks >= 3 ? count("tradeRate", 100 * (Math.max(0, finiteOrNull(stats?.totalTradeKills) ?? 0) / teammateKnocks)) : null,
    tradeSec: finiteOrNull(stats?.avgBackupLatency),
    pressure: evidence.pressureIndex,
    placement: count("placement", stats?.avgPlacementPct),
    edgePerMatch: evidence.positionSampleCount > 0 ? ratio(evidence.edgePlayCount, evidence.positionSampleCount) : null,
    earlyShare: golden && goldenTotal >= MIN_DISTANCE_DAMAGE ? ratio(golden.early, goldenTotal) : null,
    baitPerMatch: count("baitPerMatch", finiteOrNull(stats?.totalBaitCount) === null ? null : stats.totalBaitCount / mLen),
    supportPerMatch: count("supportPerMatch", finiteOrNull(stats?.totalSuppCount) === null ? null : stats.totalSuppCount / mLen),
    utilityHitsPerMatch: hasThrowOpportunity ? utilityHits! / mLen : null,
    lethalPerMatch: hasThrowOpportunity ? lethal! / mLen : null,
    teamDamageShare: count("teamDamageShare", stats?.avgTeamDamageShare),
    focusFirePerMatch: evidence.focusFireCount / mLen,
    assistShare: killTotal >= 3 ? count("assistShare", ratio(assist, killTotal)) : null,
  };
}

export function extractRoleMetrics(stats: any, evidenceVersion?: 1 | 2): Record<RoleMetricKey, number | null> {
  const evidenceMatchCount = finiteOrNull(stats?.mLen);
  const evidence = stats?.roleEvidence;
  if (evidenceVersion === 1 || evidenceVersion === 2) {
    if (!Number.isInteger(evidenceMatchCount) || evidenceMatchCount! < 1 || !(evidenceVersion === 2 ? validRoleEvidenceV2(evidence, evidenceMatchCount!) : validRoleEvidenceV1(evidence, evidenceMatchCount!))) {
      return Object.fromEntries(Object.keys(METRIC_LABELS).map((key) => [key, null])) as Record<RoleMetricKey, number | null>;
    }
    return evidenceVersion === 2 ? extractEvidenceV2Metrics(stats, evidence) : extractEvidenceV1Metrics(stats, evidence);
  }
  const mLen = Math.max(1, finiteOrNull(stats?.mLen) ?? 1);
  const perMatch = (value: unknown) => {
    const total = finiteOrNull(value);
    return total === null ? null : total / mLen;
  };
  const distance = stats?.totalDistanceDamage ?? {};
  const short = Math.max(0, finiteOrNull(distance.short) ?? 0);
  const mid = Math.max(0, finiteOrNull(distance.mid) ?? 0);
  const long = Math.max(0, finiteOrNull(distance.long) ?? 0);
  const distanceTotal = short + mid + long;
  const golden = stats?.goldenTimeAvg ?? {};
  const goldenParts = ["early", "mid1", "mid2", "late"].map((key) => Math.max(0, finiteOrNull(golden[key]) ?? 0));
  const goldenTotal = goldenParts.reduce((sum, value) => sum + value, 0);
  const teammateKnocks = Math.max(0, finiteOrNull(stats?.totalTeammateKnocks) ?? 0);
  const duels = Math.max(0, finiteOrNull(stats?.totalDuelWins) ?? 0) + Math.max(0, finiteOrNull(stats?.totalDuelLosses) ?? 0);
  const contrib = stats?.killContribFinal ?? {};
  const assist = Math.max(0, finiteOrNull(contrib.assist) ?? 0);
  const killTotal = assist + Math.max(0, finiteOrNull(contrib.solo) ?? 0) + Math.max(0, finiteOrNull(contrib.cleanup) ?? 0);

  return {
    initiative: (finiteOrNull(stats?.totalInitiativeAttempts) ?? 0) >= 3 ? finiteOrNull(stats?.userInitiativeRate) : null,
    reactionSec: finiteOrNull(stats?.avgReactionLatency),
    duelWin: duels >= 3 ? finiteOrNull(stats?.avgDuelWinRate) : null,
    reversal: (finiteOrNull(stats?.totalReversalAttempts) ?? 0) >= 2 ? finiteOrNull(stats?.userReversalRate) : null,
    longShare: distanceTotal >= MIN_DISTANCE_DAMAGE ? ratio(long, distanceTotal) : null,
    shortShare: distanceTotal >= MIN_DISTANCE_DAMAGE ? ratio(short, distanceTotal) : null,
    maxHitDist: finiteOrNull(stats?.totalMaxHitDist),
    rescueRate: teammateKnocks >= 3
      ? ratio(Math.max(0, finiteOrNull(stats?.totalRevCount) ?? 0) + Math.max(0, finiteOrNull(stats?.totalSmokeRescues) ?? 0), teammateKnocks)
      : null,
    tradeRate: teammateKnocks >= 3 ? ratio(Math.max(0, finiteOrNull(stats?.totalTradeKills) ?? 0), teammateKnocks) : null,
    tradeSec: finiteOrNull(stats?.avgBackupLatency),
    pressure: finiteOrNull(stats?.avgPressureIndex),
    placement: finiteOrNull(stats?.avgPlacementPct),
    edgePerMatch: perMatch(stats?.totalEdgePlay),
    earlyShare: goldenTotal * mLen >= MIN_DISTANCE_DAMAGE ? ratio(goldenParts[0], goldenTotal) : null,
    baitPerMatch: perMatch(stats?.totalBaitCount),
    supportPerMatch: perMatch(stats?.totalSuppCount),
    utilityHitsPerMatch: perMatch(stats?.totalUtilityHits),
    lethalPerMatch: perMatch(stats?.totalLethalThrows),
    teamDamageShare: finiteOrNull(stats?.avgTeamDamageShare),
    focusFirePerMatch: perMatch(stats?.totalFocusFireCount),
    assistShare: killTotal >= 3 ? ratio(assist, killTotal) : null,
  };
}

function metricPercentile(key: RoleMetricKey, value: number | null, reference?: RoleReference): number | null {
  if (value === null) return null;
  const percentile = referencePercentile(key, value, reference);
  if (percentile === null) return null;
  return LOWER_IS_BETTER.has(key) ? 100 - percentile : percentile;
}

function formatTopShare(percentile: number): string {
  return `상위 ${Math.max(1, Math.round(100 - percentile))}%`;
}

function comboTitle(first: RoleKey, second: RoleKey): string | null {
  const found = COMBO_TITLES.find(([a, b]) => (a === first && b === second) || (a === second && b === first));
  return found ? found[2] : null;
}

/**
 * 역할 판정. bench는 기존 호출 계약을 위해 받지만 쓰지 않는다(기준은 roleReference).
 */
export function calculateRoleRawScores(stats: any, reference?: RoleReference) {
  const isSoloMode = String(stats?.modeDistribution?.main ?? "").includes("solo");
  const metrics = extractRoleMetrics(stats, reference?.evidenceVersion);
  const metricPercentiles = Object.fromEntries(
    (Object.keys(metrics) as RoleMetricKey[]).map((key) => [key, metricPercentile(key, metrics[key], reference)]),
  ) as Record<RoleMetricKey, number | null>;

  const rawScores = {} as Record<Exclude<RoleKey, "fieldCommander">, number | null>;
  for (const [role, definition] of Object.entries(ROLE_DEFINITIONS) as Array<[Exclude<RoleKey, "fieldCommander">, RoleDefinition]>) {
    const observed = definition.metrics.map((key) => metricPercentiles[key]).filter((value): value is number => value !== null);
    // 선봉 복합 분포는 선제 성공률과 반격 시간이 함께 있을 때만 쓴다.
    const required = reference?.evidenceVersion !== undefined || role === "pointMan" ? definition.metrics.length : Math.ceil(definition.metrics.length / 2);
    const enough = observed.length >= required;
    // 지표 백분위의 평균을 다시 역할 점수 분포의 백분위로 바꾼다.
    rawScores[role] = (definition.teamOnly && (isSoloMode || (reference?.evidenceVersion === 1 && stats?.roleEvidence?.teamMatchCount !== stats?.mLen))) || !enough
      ? null
      : observed.reduce((sum, value) => sum + value, 0) / observed.length;
  }

  return { metricPercentiles, rawScores };
}

function classifyEvidenceCandidate(stats: any, overallTier: string, reference: RoleReference): RoleInfo {
  const isSoloMode = String(stats?.modeDistribution?.main ?? "").includes("solo");
  const evidence = stats?.roleEvidence;
  const mLen = finiteOrNull(stats?.mLen);
  const v2 = reference.evidenceVersion === 2;
  const valid = v2 ? validRoleEvidenceV2(evidence, mLen ?? 0) : validRoleEvidenceV1(evidence, mLen ?? 0);
  const metrics = extractRoleMetrics(stats, reference.evidenceVersion);
  const hasAction = valid && ((evidence.validWeaponHits > 0)
    || (metrics.rescueRate !== null) || (metrics.lethalPerMatch !== null)
    || (metrics.duelWin !== null) || (metrics.initiative !== null)
    || (metrics.teamDamageShare !== null && metrics.teamDamageShare > 0)
    || (metrics.supportPerMatch !== null && metrics.supportPerMatch > 0));
  const baseValid = Number.isInteger(mLen) && mLen! >= 3 && valid && (v2 ? hasAction : evidence.validWeaponHits >= 6);
  const { metricPercentiles, rawScores } = calculateRoleRawScores(stats, reference);
  const scores = { fieldCommander: null } as RoleScore;
  const preciseScores = {} as Record<Exclude<RoleKey, "fieldCommander">, number | null>;
  for (const [role, raw] of Object.entries(rawScores) as Array<[Exclude<RoleKey, "fieldCommander">, number | null]>) {
    const score = raw === null ? null : roleScorePercentile(role, raw, reference);
    preciseScores[role] = score;
    scores[role] = score === null ? null : Number(score.toFixed(1));
  }
  const ranked = (Object.entries(preciseScores) as Array<[Exclude<RoleKey, "fieldCommander">, number | null]>)
    .filter((entry): entry is [Exclude<RoleKey, "fieldCommander">, number] => entry[1] !== null)
    .sort((a, b) => b[1] - a[1]);
  const commanderRoles = ranked.filter(([role, value]) => {
    const metrics = ROLE_DEFINITIONS[role].metrics;
    return value >= COMMANDER_ROLE_PERCENTILE && metrics.every((key) => metricPercentiles[key] !== null);
  });
  const commanderRaw = commanderRoles.length >= COMMANDER_MIN_ROLES && ranked[0][1] < COMMANDER_MAX_TOP
    ? commanderRoles.slice(0, COMMANDER_MIN_ROLES).reduce((sum, [, value]) => sum + value, 0) / COMMANDER_MIN_ROLES
    : null;
  scores.fieldCommander = commanderRaw === null ? null : Number(commanderRaw.toFixed(1));

  let primaryRole: RoleInfo["primaryRole"];
  let status: NonNullable<RoleInfo["status"]>;
  let reason: string;
  let secondaryRole: RoleKey | null = null;
  if (!baseValid) {
    primaryRole = "insufficient"; status = "insufficient";
    reason = !valid
      ? "새 기준으로 확인된 경기 기록이 필요합니다."
      : "칭호를 판정할 만큼 교전 기록이 쌓이지 않았습니다.";
  } else if (ranked.length === 0) {
    primaryRole = "pending"; status = "pending";
    reason = "같은 조건의 비교 자료가 충분하지 않아 칭호 확정을 보류했습니다.";
  } else if (commanderRaw !== null) {
    primaryRole = "fieldCommander"; status = "confirmed"; reason = "필수 근거를 갖춘 역할 6개가 지휘관 기준을 충족했습니다.";
  } else if (ranked[0][1] >= PRIMARY_MIN_PERCENTILE) {
    primaryRole = ranked[0][0]; status = "confirmed"; reason = "역할별 필수 기록과 비교 기준을 충족했습니다.";
    if (ranked[1] && ranked[1][1] >= SECONDARY_MIN_PERCENTILE) secondaryRole = ranked[1][0];
  } else {
    const balanced = ranked.length >= 4 && evidence.validWeaponHits >= 6 && evidence.matchCount >= 3
      && ranked[0][1] - ranked[ranked.length - 1][1] <= 25;
    primaryRole = balanced ? "balanced" : "pending";
    status = balanced ? "balanced" : "pending";
    reason = balanced
      ? "관측된 여러 역할에서 점수가 고르게 나타납니다."
      : v2 ? "관측 가능한 역할은 있으나 특화 역할 또는 균형형 확정 기준을 충족하지 않았습니다."
        : "비교 범위 또는 역할 점수 분포가 균형형 기준을 충족하지 않아 보류했습니다.";
  }

  const candidateNames: Partial<Record<Exclude<RoleKey, "fieldCommander">, {label: string; title: string}>> = {
    decoy: {label: "대응 지원가", title: "전우의 지원군"},
    dropPredator: {label: "초반 교전가", title: "초반의 공격수"},
    zoneController: {label: "외곽 운영가", title: "외곽의 생존가"},
  };
  const display = primaryRole === "insufficient" ? INSUFFICIENT
    : primaryRole === "balanced" ? BALANCED
      : primaryRole === "pending" ? PENDING
        : primaryRole === "fieldCommander" ? FIELD_COMMANDER
          : {...ROLE_DEFINITIONS[primaryRole], ...candidateNames[primaryRole]};
  const combo = secondaryRole && primaryRole !== "fieldCommander" && primaryRole !== "balanced" && primaryRole !== "pending" && primaryRole !== "insufficient"
    && ![primaryRole, secondaryRole].some(role => role === "decoy" || role === "dropPredator")
    ? comboTitle(primaryRole, secondaryRole) : null;
  const roleLabel = secondaryRole
    ? `${display.label} · 보조: ${(candidateNames[secondaryRole as Exclude<RoleKey, "fieldCommander">]?.label ?? ROLE_DEFINITIONS[secondaryRole as Exclude<RoleKey, "fieldCommander">].label).split(" (")[0]}`
    : display.label;
  const evidenceKeys: RoleMetricKey[] = primaryRole === "fieldCommander"
    ? commanderRoles.slice(0, COMMANDER_MIN_ROLES).flatMap(([role]) => ROLE_DEFINITIONS[role].metrics)
    : primaryRole in ROLE_DEFINITIONS ? ROLE_DEFINITIONS[primaryRole as Exclude<RoleKey, "fieldCommander">].metrics : [];
  const candidateMetricLabels: Partial<Record<RoleMetricKey, string>> = {
    duelWin: "상대별 교전 승률", reversal: "적에게 먼저 피해를 입은 교전 승률",
    earlyShare: "초반 교전 피해 비중", baitPerMatch: "팀원 피격 후 대응",
    edgePerMatch: "경계 운영 관측 비율",
  };
  const candidateDescriptions: Partial<Record<Exclude<RoleKey, "fieldCommander">, string>> = {
    pointMan: "선제 타격 교전의 성공률과 적에게 먼저 피해를 입은 교전 후 반격 기록이 두드러집니다.",
    executor: "상대별 교전에서 승리하고, 적에게 먼저 피해를 입은 교전도 뒤집은 기록이 두드러집니다.",
    zoneController: "자기장 경계 운영 관측과 높은 순위 기록이 두드러집니다.",
    dropPredator: "경기 초반 교전에서 넣은 피해 비중이 높습니다.",
    decoy: "팀원 피격 후 대응과 처치 지원 기록이 두드러집니다.",
  };
  const roleDescription = primaryRole in candidateDescriptions
    ? candidateDescriptions[primaryRole as Exclude<RoleKey, "fieldCommander">]!
    : display.description;
  const evidenceText = evidenceKeys
    .filter((key, index, keys) => keys.indexOf(key) === index && metricPercentiles[key] !== null)
    .sort((a, b) => (metricPercentiles[b] ?? 0) - (metricPercentiles[a] ?? 0))
    .slice(0, 2)
    .map((key) => `${candidateMetricLabels[key] ?? METRIC_LABELS[key]} ${formatTopShare(metricPercentiles[key]!)}`);
  const teamOnlyMetrics = new Set(Object.values(ROLE_DEFINITIONS).filter((definition) => definition.teamOnly).flatMap((definition) => definition.metrics));
  const weakest = (Object.entries(metricPercentiles) as Array<[RoleMetricKey, number | null]>)
    .filter((entry): entry is [RoleMetricKey, number] => entry[1] !== null && !(isSoloMode && teamOnlyMetrics.has(entry[0])))
    .sort((a, b) => a[1] - b[1])[0];
  const weakness = weakest && weakest[1] <= WEAKNESS_MAX_PERCENTILE
    ? `${candidateMetricLabels[weakest[0]] ?? METRIC_LABELS[weakest[0]]}이(가) 다른 플레이어 대비 하위 ${Math.max(1, Math.round(weakest[1]))}%입니다.` : null;
  const weapon = getSignatureWeapon(stats?.weaponStatsFinal || {}, stats?.weaponMatchCount || {}, Math.max(1, mLen ?? 1));
  const badges: string[] = [];
  const vehicleCombatSum = ["totalRidingShotKnocks", "totalRidingShotKills", "totalLeadShotKnocks", "totalLeadShotKills"]
    .reduce((sum, key) => sum + Math.max(0, finiteOrNull(stats?.[key]) ?? 0), 0);
  if (vehicleCombatSum >= 3 && (finiteOrNull(stats?.vehicleCombatMatchCount) ?? 0) >= 2) badges.push("차량 교전");
  if (weapon.isSpecial && weapon.stats.isReliable) badges.push(weapon.name);
  else if (weapon.stats.isReliable) badges.push(`${weapon.name} 주력`);
  const result: RoleInfo = {
    primaryRole, secondaryRole, overallTier, title: combo ?? display.title, roleLabel,
    description: roleDescription, evidence: evidenceText, badges, signatureWeapon: weapon.name,
    signatureWeaponStats: { kills: weapon.stats.kills, dbnos: weapon.stats.dbnos, consistency: weapon.stats.consistency, isReliable: weapon.stats.isReliable },
    weakness, scores, status, reason, observedRoleCount: ranked.length,
  };
  return v2 ? withObservedRole(stats, {...result, presentation: status === "insufficient" ? "insufficient" : "role"}) : result;
}

/** 미확정 칭호를 비교 순위가 아닌 실제 관측 사실로 설명한다. */
export function withObservedRole(stats: any, role: RoleInfo): RoleInfo {
  if (role.status !== "pending" || !validRoleEvidenceV2(stats?.roleEvidence, stats?.mLen) || stats.mLen < 3) return role;
  const evidence = stats.roleEvidence as RoleEvidenceV2;
  const distance = evidence.distanceDamage;
  const total = distance.short + distance.mid + distance.long;
  let title: string;
  let fact: string;
  let observedRoles: RoleKey[] = [];
  if (total >= MIN_DISTANCE_DAMAGE && evidence.distanceHitCount > 0) {
    const shares = [distance.short, distance.mid, distance.long].map(value => 100 * value / total);
    const dominant = shares.findIndex(value => value > 50);
    title = dominant < 0 ? "여러 거리 교전 관측" : ["근거리 교전 중심", "중거리 교전 중심", "원거리 교전 중심"][dominant];
    fact = `선정 ${stats.mLen}경기의 거리 확인 피해 ${total.toFixed(0)} 중 50m 미만 ${shares[0].toFixed(1)}%, 50m 이상 200m 미만 ${shares[1].toFixed(1)}%, 200m 이상 ${shares[2].toFixed(1)}%입니다.`;
    observedRoles = dominant === 0 ? ["brawler"] : dominant === 2 ? ["phantomOverwatch"] : [];
  } else if (evidence.team.matchCount > 0 && evidence.team.rescueOpportunityCount >= 3) {
    title = "아군 구조 기록 관측";
    fact = `선정 ${stats.mLen}경기 중 팀원과 함께한 ${evidence.team.matchCount}경기에서 구조 기회 ${evidence.team.rescueOpportunityCount}회 중 ${evidence.team.rescueCount}회 구조했습니다.`;
    observedRoles = ["shield"];
  } else if (evidence.metricMatchCounts.duelWin === stats.mLen && (finiteOrNull(stats.totalDuelWins) ?? 0) + (finiteOrNull(stats.totalDuelLosses) ?? 0) >= 3) {
    title = "상대별 교전 기록";
    fact = `선정 ${stats.mLen}경기의 상대별 교전에서 승리 ${stats.totalDuelWins}회, 패배 ${stats.totalDuelLosses}회가 관측됐습니다.`;
  } else if (evidence.team.matchCount > 0 && (evidence.team.supportPerMatch ?? 0) > 0) {
    title = "처치 지원 기록 관측";
    fact = `선정 ${stats.mLen}경기 중 팀원과 함께한 ${evidence.team.matchCount}경기의 유효 ${evidence.team.supportMatches}경기에서 경기당 처치 지원 ${evidence.team.supportPerMatch!.toFixed(1)}회가 관측됐습니다.`;
  } else if ((finiteOrNull(stats.totalLethalThrows) ?? 0) > 0) {
    title = "피해형 투척 사용 관측";
    fact = `선정 ${stats.mLen}경기에서 피해형 투척 ${stats.totalLethalThrows}회가 관측됐습니다.`;
  } else return {...role, evidence: [], weakness: null};
  return {...role, presentation: "observed", observedRoles, title, roleLabel: "관측된 플레이 성향",
    description: fact, evidence: [fact], weakness: null};
}

export function classifyRole(stats: any, _bench: any, overallTier: string, reference?: RoleReference): RoleInfo {
  if (reference && Object.hasOwn(reference, "evidenceVersion") && reference.evidenceVersion !== undefined && reference.evidenceVersion !== 1 && reference.evidenceVersion !== 2) {
    const scores = Object.fromEntries(Object.keys(ROLE_SCORE_QUANTILES).map((role) => [role, null])) as RoleScore;
    scores.fieldCommander = null;
    return { primaryRole: "insufficient", secondaryRole: null, overallTier, title: INSUFFICIENT.title, roleLabel: INSUFFICIENT.label,
      description: INSUFFICIENT.description, evidence: [], badges: [], signatureWeapon: "주먹",
      signatureWeaponStats: { kills: 0, dbnos: 0, consistency: 0, isReliable: false }, weakness: null, scores,
      status: "insufficient", reason: "지원하지 않는 근거 버전입니다.", observedRoleCount: 0 };
  }
  if (reference?.evidenceVersion === 1 || reference?.evidenceVersion === 2) return classifyEvidenceCandidate(stats, overallTier, reference);
  const isSoloMode = String(stats?.modeDistribution?.main ?? "").includes("solo");
  const { metricPercentiles, rawScores } = calculateRoleRawScores(stats, reference);
  const scores = { fieldCommander: null } as RoleScore;
  for (const [role, raw] of Object.entries(rawScores) as Array<[Exclude<RoleKey, "fieldCommander">, number | null]>) {
    const score = raw === null ? null : roleScorePercentile(role, raw, reference);
    scores[role] = score === null ? null : Number(score.toFixed(1));
  }

  const ranked = (Object.entries(scores) as Array<[RoleKey, number | null]>)
    .filter((entry): entry is [RoleKey, number] => entry[1] !== null)
    .sort((a, b) => b[1] - a[1]);
  const strongRoles = ranked.filter(([, value]) => value >= COMMANDER_ROLE_PERCENTILE);
  if (strongRoles.length >= COMMANDER_MIN_ROLES && ranked[0][1] < COMMANDER_MAX_TOP) {
    scores.fieldCommander = Number((strongRoles.slice(0, COMMANDER_MIN_ROLES).reduce((sum, [, value]) => sum + value, 0) / COMMANDER_MIN_ROLES).toFixed(1));
  }

  let primaryRole: RoleInfo["primaryRole"];
  let secondaryRole: RoleKey | null = null;
  if (ranked.length === 0) primaryRole = "insufficient";
  else if (scores.fieldCommander !== null) primaryRole = "fieldCommander";
  else if (ranked[0][1] >= PRIMARY_MIN_PERCENTILE) {
    primaryRole = ranked[0][0];
    if (ranked[1] && ranked[1][1] >= SECONDARY_MIN_PERCENTILE) secondaryRole = ranked[1][0];
  } else primaryRole = "balanced";

  const display = primaryRole === "insufficient" ? INSUFFICIENT
    : primaryRole === "balanced" ? BALANCED
      : primaryRole === "fieldCommander" ? FIELD_COMMANDER
        : ROLE_DEFINITIONS[primaryRole];
  const combo = secondaryRole && primaryRole !== "fieldCommander" && primaryRole !== "balanced" && primaryRole !== "insufficient"
    ? comboTitle(primaryRole, secondaryRole) : null;
  const roleLabel = secondaryRole
    ? `${display.label} · 보조: ${ROLE_DEFINITIONS[secondaryRole as Exclude<RoleKey, "fieldCommander">].label.split(" (")[0]}`
    : display.label;

  // 근거: 대표 역할(지휘관이면 상위 역할들)의 지표 중 백분위가 높은 것 두 개.
  const evidenceKeys: RoleMetricKey[] = primaryRole === "fieldCommander"
    ? strongRoles.slice(0, COMMANDER_MIN_ROLES).flatMap(([role]) => ROLE_DEFINITIONS[role as Exclude<RoleKey, "fieldCommander">].metrics)
    : primaryRole in ROLE_DEFINITIONS ? ROLE_DEFINITIONS[primaryRole as Exclude<RoleKey, "fieldCommander">].metrics : [];
  const evidence = evidenceKeys
    .filter((key, index, keys) => keys.indexOf(key) === index && metricPercentiles[key] !== null)
    .sort((a, b) => (metricPercentiles[b] ?? 0) - (metricPercentiles[a] ?? 0))
    .slice(0, 2)
    .map((key) => `${METRIC_LABELS[key]} ${formatTopShare(metricPercentiles[key]!)}`);

  // 약점: 판정 가능한 지표 중 하위 20% 이하인 가장 낮은 것. 솔로에서는 팀 지표를 보지 않는다.
  const teamOnlyMetrics = new Set(Object.values(ROLE_DEFINITIONS).filter((definition) => definition.teamOnly).flatMap((definition) => definition.metrics));
  const weakest = (Object.entries(metricPercentiles) as Array<[RoleMetricKey, number | null]>)
    .filter((entry): entry is [RoleMetricKey, number] => entry[1] !== null && !(isSoloMode && teamOnlyMetrics.has(entry[0])))
    .sort((a, b) => a[1] - b[1])[0];
  const weakness = weakest && weakest[1] <= WEAKNESS_MAX_PERCENTILE
    ? `${METRIC_LABELS[weakest[0]]}이(가) 다른 플레이어 대비 하위 ${Math.max(1, Math.round(weakest[1]))}%입니다.`
    : null;

  const mLen = Math.max(1, finiteOrNull(stats?.mLen) ?? 1);
  const weapon = getSignatureWeapon(stats?.weaponStatsFinal || {}, stats?.weaponMatchCount || {}, mLen);
  const badges: string[] = [];
  const vehicleCombatSum = ["totalRidingShotKnocks", "totalRidingShotKills", "totalLeadShotKnocks", "totalLeadShotKills"]
    .reduce((sum, key) => sum + Math.max(0, finiteOrNull(stats?.[key]) ?? 0), 0);
  if (vehicleCombatSum >= 3 && (finiteOrNull(stats?.vehicleCombatMatchCount) ?? 0) >= 2) badges.push("차량 교전");
  if (weapon.isSpecial && weapon.stats.isReliable) badges.push(weapon.name);
  else if (weapon.stats.isReliable) badges.push(`${weapon.name} 주력`);

  return {
    primaryRole,
    secondaryRole,
    overallTier,
    title: combo ?? display.title,
    roleLabel,
    description: display.description,
    evidence,
    badges,
    signatureWeapon: weapon.name,
    signatureWeaponStats: {
      kills: weapon.stats.kills,
      dbnos: weapon.stats.dbnos,
      consistency: weapon.stats.consistency,
      isReliable: weapon.stats.isReliable,
    },
    weakness,
    scores,
  };
}
