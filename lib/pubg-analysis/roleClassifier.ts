import { WEAPON_NAMES, IGNORE_WEAPONS } from "./constants";
import {
  DEFAULT_ROLE_REFERENCE_TABLES,
  percentileFromQuantiles,
  type RoleMetricKey,
  type RoleReferenceTables,
} from "./roleReference";

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
  primaryRole: RoleKey | "balanced" | "insufficient";
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
  // 화면 설명용 판정 상태. 칭호·점수 판정을 바꾸지 않고, 요약 캐시 hash에도 넣지 않는다.
  verdict: RoleVerdict;
  // 확정 대표 역할의 횟수형 근거량(화면 설명용). 칭호·점수를 바꾸지 않고 hash에도 넣지 않는다.
  evidenceAmount: RoleEvidenceAmount | null;
}

export interface RoleEvidenceAmount {
  // thin: 대표 역할의 관측 지표가 모두 횟수형(파생 지표 제외)이고, 판정 경기 기록이 모두 있으며, 각 사건이 1회 이하
  // partial: 여러 지표로 정의된 역할에서 일부 지표만 관측돼 판정
  strength: "normal" | "thin" | "partial";
  // 예: "복수 처치 1회 / 아군 기절 3회 · 1경기에서 확인"
  lines: string[];
  // thin·partial일 때 덧붙이는 한 문장. normal이면 빈 문자열
  note: string;
}

export interface RoleVerdict {
  kind: "confirmed" | "below_threshold" | "insufficient";
  // 칭호 판정에 쓴 점수 상위 경기 수
  matchCount: number;
  judgedRoles: number;
  totalRoles: number;
  unjudged: { notEnoughRecords: number; referencePending: number; soloExcluded: number };
  topRole: { role: Exclude<RoleKey, "fieldCommander">; score: number } | null;
  headline: string;
  label: string;
  // 한 문장 요약(요약 헤더용)
  detail: string;
  // 판정하지 않은 역할과 이유(상세 카드용). 없으면 빈 문자열
  note: string;
  // 다른 플레이어 상위 25% 안에 든 기록. 칭호가 아닌 관측 성향이다.
  observations: string[];
}

export interface ClassifyRoleOptions {
  // 값이 있어도 비교 분포가 준비되지 않아 판정에 쓰지 않는 지표
  pendingReferenceMetrics?: readonly RoleMetricKey[];
  // 판정 경기 중 횟수형 지표의 사건이 있었던 경기 수와 기록 완전성(countRoleEvidenceMatches 결과)
  evidenceMatches?: Partial<Record<RoleMetricKey, RoleEvidenceMatchCount>>;
  // 기본값은 roleReference의 운영 기준표다. 재산출 스크립트와 회귀 비교가 다른 표로 같은 경로를 돌릴 때만 넣는다.
  referenceTables?: RoleReferenceTables;
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
    label: "핫드랍 약탈자 (Drop Predator)", title: "핫존의 포식자", metrics: ["earlyDamagePerMatch"],
    description: "경기 초반에 한 경기당 넣는 피해가 많습니다.",
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
    label: "근접 난전가 (Brawler)", title: "난전의 지배자", metrics: ["shortShare", "shortDamagePerMatch"],
    description: "50m 안쪽 근거리에서 넣는 피해 비중과 양이 많습니다.",
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

// 조합 칭호와 보조 역할을 막는 역할 쌍. 두 종류다.
// (1) 같은 측정 분모를 공유한 쌍: shield·avenger는 아군 기절 수(teammateKnocks)를 나눠 쓴다.
// (2) 기준 표본(2026-11-03 재산출, 계산 5, B' 가중, 판정 기준 점수 상위 집합)에서 동시 상위 빈도 lift가 2 이상이고
//     함께 상위인 플레이어가 5명 이상인 쌍. 같은 행동을 두 번 세는 쌍이라 조합 칭호로 따로 주지 않는다.
// 목록은 scripts/recalibrate_role_reference.ts로 기준 표를 다시 낸 뒤 같은 방식으로 갱신한다.
const COMBO_BLOCKED_PAIRS: ReadonlyArray<readonly [RoleKey, RoleKey]> = [
  ["shield", "avenger"],
  ["dropPredator", "brawler"],
  ["zoneController", "decoy"],
  ["zoneController", "grenadier"],
  ["executor", "zoneController"],
  ["decoy", "grenadier"],
  ["decoy", "crossfire"],
  ["executor", "grenadier"],
  ["dropPredator", "mainGun"],
  ["brawler", "mainGun"],
  ["phantomOverwatch", "crossfire"],
  ["shield", "grenadier"],
  ["shield", "zoneController"],
  ["decoy", "brawler"],
  ["phantomOverwatch", "grenadier"],
  ["executor", "avenger"],
  ["zoneController", "crossfire"],
];

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
  placement: "평균 순위", edgePerMatch: "자기장 가장자리 운영", earlyDamagePerMatch: "초반 피해량(경기당)", shortDamagePerMatch: "근거리 피해량(경기당)",
  baitPerMatch: "미끼 플레이", supportPerMatch: "처치 지원", utilityHitsPerMatch: "투척물 적중",
  lethalPerMatch: "피해형 투척", teamDamageShare: "팀 내 피해 기여(공정 분담 대비)", focusFirePerMatch: "협공 타격",
  assistShare: "협공 처치 비중",
};

// 값이 낮을수록 좋은 지표(초 단위 지연)는 백분위를 뒤집는다.
const LOWER_IS_BETTER = new Set<RoleMetricKey>(["reactionSec", "tradeSec"]);

// 대표 역할 기준 점수(83점). 2026-11-03 재산출에서 검색 사용자 확정 비율이 구 기준과 같고(71.8%), B' 가중 전체는 1.2%p 낮다.
// 뒤의 보조 역할 기준(85점)은 조합 칭호가 두 역할 모두 강할 때만 붙도록 더 높게 둔다.
// 점수는 역할별 기준 분포의 백분위라 "상위 17% 수준"이다. 12개 역할 중 하나라도 닿으면 확정되므로 희귀 칭호 기준이 아니다.
export const PRIMARY_MIN_PERCENTILE = 83;
const SECONDARY_MIN_PERCENTILE = 85;
const COMMANDER_ROLE_PERCENTILE = 75;
const COMMANDER_MIN_ROLES = 6;
const COMMANDER_MAX_TOP = 95;
const WEAKNESS_MAX_PERCENTILE = 20;
const MIN_DISTANCE_DAMAGE = 300;
// 선제 타격 성공률은 시도가 적으면 0%나 100%가 쉽게 나오므로 최소 시도 수 이상일 때만 쓴다. 기준 분포 산출과 같은 값이다.
const MIN_INITIATIVE_ATTEMPTS = 5;
const TEAM_ONLY_METRICS = new Set<RoleMetricKey>(
  Object.values(ROLE_DEFINITIONS).filter((definition) => definition.teamOnly).flatMap((definition) => definition.metrics),
);


/**
 * 시그니처 무기 및 상세 스탯 추출
 */
function getSignatureWeapon(weaponStats: Record<string, any>, matchCountStats: Record<string, number> = {}, totalMatches: number = 1) {
  if (!weaponStats || Object.keys(weaponStats).length === 0) return { name: "무기 기록 없음", stats: { kills: 0, dbnos: 0, consistency: 0, isReliable: false }, isSpecial: false };

  const sorted = Object.entries(weaponStats)
    .filter(([id]) => !IGNORE_WEAPONS.includes(id) && id !== "None")
    .sort((a, b) => {
      const scoreA = (a[1].kills || 0) * 2 + (a[1].dbnos || 0);
      const scoreB = (b[1].kills || 0) * 2 + (b[1].dbnos || 0);
      return scoreB - scoreA;
    });

  if (sorted.length === 0) return { name: "무기 기록 없음", stats: { kills: 0, dbnos: 0, consistency: 0, isReliable: false }, isSpecial: false };
  
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
export function extractRoleMetrics(stats: any): Record<RoleMetricKey, number | null> {
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
    initiative: (finiteOrNull(stats?.totalInitiativeAttempts) ?? 0) >= MIN_INITIATIVE_ATTEMPTS ? finiteOrNull(stats?.userInitiativeRate) : null,
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
    // 초반 피해 비중은 생존에 따라 기계적으로 바뀌어(일찍 죽으면 비중이 100%에 가깝다) 쓰지 않고, 경기당 초반 피해량을 쓴다.
    earlyDamagePerMatch: goldenTotal * mLen >= MIN_DISTANCE_DAMAGE ? goldenParts[0] : null,
    // 근거리 피해 비중만 보면 일찍 죽은 경기처럼 전체 피해가 작을 때 비중이 높게 나온다. 경기당 양을 함께 본다.
    shortDamagePerMatch: distanceTotal >= MIN_DISTANCE_DAMAGE ? short / mLen : null,
    baitPerMatch: perMatch(stats?.totalBaitCount),
    supportPerMatch: perMatch(stats?.totalSuppCount),
    utilityHitsPerMatch: perMatch(stats?.totalUtilityHits),
    lethalPerMatch: perMatch(stats?.totalLethalThrows),
    // 공정 분담(100 / 인원 수) 대비 배수로 바꾼 값(1.0 = 공정 분담). 솔로와 인원 불명 모드는 기록이 없다.
    teamDamageShare: finiteOrNull(stats?.avgTeamDamageShareFair),
    focusFirePerMatch: perMatch(stats?.totalFocusFireCount),
    assistShare: killTotal >= 3 ? ratio(assist, killTotal) : null,
  };
}

function metricPercentile(key: RoleMetricKey, value: number | null, tables: RoleReferenceTables): number | null {
  if (value === null) return null;
  const percentile = percentileFromQuantiles(tables.metrics[key], value, tables.levels);
  return LOWER_IS_BETTER.has(key) ? 100 - percentile : percentile;
}

/**
 * 지표 값을 기준 분포의 백분위(0~100)로 바꾼다. 값이 null이면 null이다(측정 불가·기회 부족·보류).
 * 재산출 스크립트가 같은 표로 역할 점수 분포를 만들 때도 이 함수를 쓴다.
 */
export function metricPercentilesFor(
  stats: any,
  pendingReferenceMetrics: readonly RoleMetricKey[] = [],
  tables: RoleReferenceTables = DEFAULT_ROLE_REFERENCE_TABLES,
): Record<RoleMetricKey, number | null> {
  const pending = new Set<RoleMetricKey>(pendingReferenceMetrics);
  const metrics = extractRoleMetrics(stats);
  return Object.fromEntries(
    (Object.keys(metrics) as RoleMetricKey[]).map((key) => [key, pending.has(key) ? null : metricPercentile(key, metrics[key], tables)]),
  ) as Record<RoleMetricKey, number | null>;
}

/**
 * 역할별 지표 백분위의 평균(역할 점수 분포의 입력). 판정에 필요한 지표가 부족하면 null이다.
 * 솔로 제외 같은 모드 규칙은 호출부가 적용한다.
 */
export function roleMeanPercentiles(
  metricPercentiles: Record<RoleMetricKey, number | null>,
): Record<Exclude<RoleKey, "fieldCommander">, number | null> {
  const result = {} as Record<Exclude<RoleKey, "fieldCommander">, number | null>;
  for (const [role, definition] of Object.entries(ROLE_DEFINITIONS) as Array<[Exclude<RoleKey, "fieldCommander">, RoleDefinition]>) {
    const observed = definition.metrics.map((key) => metricPercentiles[key]).filter((value): value is number => value !== null);
    // 선봉 복합 분포는 선제 성공률과 반격 시간이 함께 있을 때만 쓴다.
    const required = role === "pointMan" ? definition.metrics.length : Math.ceil(definition.metrics.length / 2);
    result[role] = observed.length < required
      ? null
      : observed.reduce((sum, value) => sum + value, 0) / observed.length;
  }
  return result;
}

function formatTopShare(percentile: number): string {
  return `상위 ${Math.max(1, Math.round(100 - percentile))}%`;
}

/** 두 역할이 조합 칭호와 보조 역할 표시에서 막힌 쌍인지(순서 무관). */
export function isComboBlocked(first: RoleKey, second: RoleKey): boolean {
  return COMBO_BLOCKED_PAIRS.some(([a, b]) => (a === first && b === second) || (a === second && b === first));
}

function comboTitle(first: RoleKey, second: RoleKey): string | null {
  const found = COMBO_TITLES.find(([a, b]) => (a === first && b === second) || (a === second && b === first));
  return found ? found[2] : null;
}

/**
 * 역할 판정. bench는 기존 호출 계약을 위해 받지만 쓰지 않는다(기준은 roleReference).
 */
export function classifyRole(stats: any, _bench: any, overallTier: string, options: ClassifyRoleOptions = {}): RoleInfo {
  const isSoloMode = String(stats?.modeDistribution?.main ?? "").includes("solo");
  const pendingReference = new Set<RoleMetricKey>(options.pendingReferenceMetrics ?? []);
  const tables = options.referenceTables ?? DEFAULT_ROLE_REFERENCE_TABLES;
  const metricPercentiles = metricPercentilesFor(stats, options.pendingReferenceMetrics ?? [], tables);

  // 판정은 반올림 전 점수로 한다. scores에는 기존처럼 소수 첫째 자리까지 담는다.
  const rawScores = {} as Record<Exclude<RoleKey, "fieldCommander">, number | null>;
  // 동점 정렬용 원점수: 지표 백분위 평균(역할 점수 분포로 바꾸기 전)과 관측 지표 수
  const rawMeans = {} as Record<Exclude<RoleKey, "fieldCommander">, number | null>;
  const observedCounts = {} as Record<Exclude<RoleKey, "fieldCommander">, number>;
  const unjudged = { notEnoughRecords: 0, referencePending: 0, soloExcluded: 0 };
  const scores = { fieldCommander: null } as RoleScore;
  const means = roleMeanPercentiles(metricPercentiles);
  for (const [role, definition] of Object.entries(ROLE_DEFINITIONS) as Array<[Exclude<RoleKey, "fieldCommander">, RoleDefinition]>) {
    const observed = definition.metrics.map((key) => metricPercentiles[key]).filter((value): value is number => value !== null);
    observedCounts[role] = observed.length;
    // 선봉 복합 분포는 선제 성공률과 반격 시간이 함께 있을 때만 쓴다(roleMeanPercentiles가 기회 수로 거른다).
    const enough = means[role] !== null;
    const soloExcluded = Boolean(definition.teamOnly && isSoloMode);
    // 지표 백분위의 평균을 다시 역할 점수 분포의 백분위로 바꾼다.
    rawMeans[role] = soloExcluded ? null : means[role];
    rawScores[role] = rawMeans[role] === null
      ? null
      : percentileFromQuantiles(tables.scores[role], rawMeans[role]!, tables.levels);
    scores[role] = rawScores[role] === null ? null : Number(rawScores[role]!.toFixed(1));
    if (soloExcluded) unjudged.soloExcluded++;
    else if (!enough) {
      // 비교 기준이 준비되지 않은 지표만 빠져서 판정하지 못한 경우와, 다른 기록도 부족한 경우를 나눈다.
      const required = role === "pointMan" ? definition.metrics.length : Math.ceil(definition.metrics.length / 2);
      const pendingCount = definition.metrics.filter((key) => pendingReference.has(key)).length;
      if (pendingCount > 0 && observed.length + pendingCount >= required) unjudged.referencePending++;
      else unjudged.notEnoughRecords++;
    }
  }

  // 동점은 정의 순서가 아니라 원점수로 깬다: 역할 점수 → 지표 백분위 평균 → 관측 지표 수 → 역할 키(사전순).
  // 완전히 같은 경우에도 결과가 항상 같고 정의 순서에 기대지 않는다.
  const ranked = (Object.entries(rawScores) as Array<[Exclude<RoleKey, "fieldCommander">, number | null]>)
    .filter((entry): entry is [Exclude<RoleKey, "fieldCommander">, number] => entry[1] !== null)
    .sort((a, b) => (b[1] - a[1])
      || ((rawMeans[b[0]] ?? 0) - (rawMeans[a[0]] ?? 0))
      || (observedCounts[b[0]] - observedCounts[a[0]])
      || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const strongRoles = ranked.filter(([, value]) => value >= COMMANDER_ROLE_PERCENTILE);
  if (strongRoles.length >= COMMANDER_MIN_ROLES && ranked[0][1] < COMMANDER_MAX_TOP) {
    // 지휘관 판정은 원점수로 하고, 표시 점수는 기존처럼 표시용 역할 점수의 평균이다.
    scores.fieldCommander = Number((strongRoles.slice(0, COMMANDER_MIN_ROLES).reduce((sum, [role]) => sum + scores[role]!, 0) / COMMANDER_MIN_ROLES).toFixed(1));
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
  // 막힌 조합 쌍이면 보조 역할도 주지 않는다(조합 칭호와 보조 역할 표시를 함께 막는다).
  if (secondaryRole && primaryRole !== "fieldCommander" && primaryRole !== "balanced" && primaryRole !== "insufficient"
    && isComboBlocked(primaryRole, secondaryRole)) secondaryRole = null;
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
  const weakest = (Object.entries(metricPercentiles) as Array<[RoleMetricKey, number | null]>)
    .filter((entry): entry is [RoleMetricKey, number] => entry[1] !== null && !(isSoloMode && TEAM_ONLY_METRICS.has(entry[0])))
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
  // 우승은 선택된 전체 경기 기준이고, 전멸 기여는 계산 5 경기에서 내 기여로 귀속된 수다(2회 이상일 때만 표시).
  const wins = Math.max(0, finiteOrNull(stats?.totalWins) ?? 0);
  if (wins >= 1) badges.push(`우승 ${wins}회`);
  const wipes = Math.max(0, finiteOrNull(stats?.totalTeamWipesCalc5) ?? 0);
  if (wipes >= 2) badges.push(`전멸 기여 ${wipes}회`);

  const verdict = buildVerdict({ primaryRole, ranked, unjudged, metricPercentiles, isSoloMode, matchCount: mLen, rawMeans });
  const evidenceAmount = primaryRole in ROLE_DEFINITIONS
    ? buildEvidenceAmount(primaryRole as Exclude<RoleKey, "fieldCommander">, secondaryRole as Exclude<RoleKey, "fieldCommander"> | null, stats, metricPercentiles, options.evidenceMatches ?? {})
    : null;

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
    verdict,
    evidenceAmount,
  };
}

// 횟수형 지표의 사건 수(분자)와 기회 수(분모). 값은 aggregate 합계를 그대로 쓴다.
const COUNT_EVIDENCE: Partial<Record<RoleMetricKey, (stats: any) => { events: number; opportunities: number; text: string }>> = {
  tradeRate: (s) => {
    const events = count(s?.totalTradeKills); const opportunities = count(s?.totalTeammateKnocks);
    return { events, opportunities, text: `복수 처치 ${events}회 / 아군 기절 ${opportunities}회` };
  },
  rescueRate: (s) => {
    const events = count(s?.totalRevCount) + count(s?.totalSmokeRescues); const opportunities = count(s?.totalTeammateKnocks);
    return { events, opportunities, text: `소생·연막 구출 ${events}회 / 아군 기절 ${opportunities}회` };
  },
  duelWin: (s) => {
    const events = count(s?.totalDuelWins); const opportunities = events + count(s?.totalDuelLosses);
    return { events, opportunities, text: `1:1 교전 ${events}승 / ${opportunities}회` };
  },
  reversal: (s) => {
    const events = count(s?.totalReversalWins); const opportunities = count(s?.totalReversalAttempts);
    return { events, opportunities, text: `역전 ${events}회 / 시도 ${opportunities}회` };
  },
  initiative: (s) => {
    const events = count(s?.totalInitiativeSuccess); const opportunities = count(s?.totalInitiativeAttempts);
    return { events, opportunities, text: `선제 타격 성공 ${events}회 / ${opportunities}회` };
  },
  assistShare: (s) => {
    const contrib = s?.killContribFinal ?? {};
    const events = count(contrib.assist); const opportunities = events + count(contrib.solo) + count(contrib.cleanup);
    return { events, opportunities, text: `협공 처치 ${events}회 / 처치 ${opportunities}회` };
  },
};
// 같은 사건(복수 처치)에서 나온 파생 지표. 사건 수가 아니므로 근거량 판단에서 빼고, 단독이면 근거 적음으로 보지 않는다.
const DERIVED_FROM_EVENTS = new Set<RoleMetricKey>(["tradeSec"]);

function count(value: unknown): number {
  return Math.max(0, Math.round(finiteOrNull(value) ?? 0));
}

export interface RoleEvidenceMatchCount {
  // 판정 경기 중 사건이 있었던 경기 수
  matches: number;
  // 판정 경기 모두에 해당 필드 기록이 있었는지. false면 합계의 0이 실제 0인지 누락인지 단정하지 않는다.
  complete: boolean;
}

function roleEvidenceLines(
  role: Exclude<RoleKey, "fieldCommander">,
  stats: any,
  metricPercentiles: Record<RoleMetricKey, number | null>,
  evidenceMatches: Partial<Record<RoleMetricKey, RoleEvidenceMatchCount>>,
) {
  const definition = ROLE_DEFINITIONS[role];
  const observed = definition.metrics.filter((key) => metricPercentiles[key] !== null);
  const counted = observed.filter((key) => !DERIVED_FROM_EVENTS.has(key))
    .map((key) => ({ key, evidence: COUNT_EVIDENCE[key]?.(stats) ?? null, record: evidenceMatches[key] }));
  const lines = counted.filter(({ evidence }) => evidence !== null).map(({ evidence, record }) => {
    if (!record) return evidence!.text;
    return record.complete ? `${evidence!.text} · ${record.matches}경기에서 확인` : `${evidence!.text} · 일부 경기 기록 없음`;
  });
  if (observed.includes("tradeSec") && !observed.includes("tradeRate") && evidenceMatches.tradeSec) {
    lines.push(`복수 처치 시간 ${evidenceMatches.tradeSec.matches}경기에서 관측`);
  }
  // 관측 지표가 모두 횟수형(파생 지표 제외)이고, 모든 경기 기록이 확인되며, 사건이 각각 1회 이하일 때만 근거 적음이다.
  const thin = counted.length > 0 && counted.every(({ evidence, record }) => evidence !== null && record?.complete === true && evidence.events <= 1);
  const missing = definition.metrics.filter((key) => metricPercentiles[key] === null);
  return { definition, observed, lines, thin, missing };
}

function buildEvidenceAmount(
  primary: Exclude<RoleKey, "fieldCommander">,
  secondary: Exclude<RoleKey, "fieldCommander"> | null,
  stats: any,
  metricPercentiles: Record<RoleMetricKey, number | null>,
  evidenceMatches: Partial<Record<RoleMetricKey, RoleEvidenceMatchCount>>,
): RoleEvidenceAmount {
  const main = roleEvidenceLines(primary, stats, metricPercentiles, evidenceMatches);
  const lines = [...main.lines];
  // 보조 역할 근거가 한 번뿐이면 보조 칭호에도 같은 사실을 붙인다. 판정은 바꾸지 않는다.
  if (secondary) {
    const sub = roleEvidenceLines(secondary, stats, metricPercentiles, evidenceMatches);
    const shared = sub.lines.filter((line) => !lines.includes(line));
    if (sub.thin && shared.length > 0) lines.push(`보조 ${shortRoleLabel(secondary)}: ${shared.join(", ")} (근거 적음)`);
  }
  if (main.thin) {
    return { strength: "thin", lines, note: "판정에 쓰인 행동 기록이 지표마다 1회 이하라 관측 성향으로 봅니다. 경기가 쌓이면 바뀔 수 있습니다." };
  }
  if (main.definition.metrics.length > 1 && main.missing.length > 0) {
    return {
      strength: "partial",
      lines,
      note: `${main.missing.map((key) => METRIC_LABELS[key]).join("·")} 기록 없이 ${main.observed.map((key) => METRIC_LABELS[key]).join("·")}만으로 판정했습니다.`,
    };
  }
  return { strength: "normal", lines, note: "" };
}

/**
 * 판정 경기마다 횟수형 지표의 사건이 있었는지 세어 classifyRole의 evidenceMatches로 넘긴다.
 * aggregate와 같은 필드를 읽는다. 필드가 없는 경기가 하나라도 있으면 complete=false로 표시한다.
 */
export function countRoleEvidenceMatches(matches: any[]): Partial<Record<RoleMetricKey, RoleEvidenceMatchCount>> {
  const keys: RoleMetricKey[] = ["tradeRate", "tradeSec", "rescueRate", "duelWin", "reversal", "initiative", "assistShare"];
  const result = Object.fromEntries(keys.map((key) => [key, { matches: 0, complete: true }])) as Record<RoleMetricKey, RoleEvidenceMatchCount>;
  // aggregate reader처럼 0 이상의 유한한 숫자만 관측된 기록으로 본다(-1 같은 누락 표시는 기록 없음).
  const has = (...values: unknown[]) => values.every((value) => { const number = finiteOrNull(value); return number !== null && number >= 0; });
  const mark = (key: RoleMetricKey, recorded: boolean, hit: boolean) => {
    if (!recorded) result[key].complete = false;
    else if (hit) result[key].matches++;
  };
  for (const match of matches ?? []) {
    const trade = match?.tradeStats ?? {};
    const duel = match?.duelStats ?? {};
    const contrib = match?.killContribution ?? {};
    mark("tradeRate", has(trade.tradeKills, trade.teammateKnocks), count(trade.tradeKills) > 0);
    // 지연 시간은 복수가 없으면 기록되지 않으므로 누락으로 보지 않고 관측된 경기만 센다.
    mark("tradeSec", true, has(trade.tradeLatencyMs));
    mark("rescueRate", has(trade.revCount, trade.smokeRescues, trade.teammateKnocks), count(trade.revCount) + count(trade.smokeRescues) > 0);
    mark("duelWin", has(duel.wins, duel.losses), count(duel.wins) > 0);
    // aggregate는 시도 수가 없으면 역전 승수로 분모를 보정한다. 그 경우 분모가 관측값이 아니므로 기록 불완전으로 둔다.
    mark("reversal", has(duel.reversals, duel.reversalAttempts), count(duel.reversals) > 0);
    const sample = finiteOrNull(match?.initiativeSampleCount);
    const rate = finiteOrNull(match?.initiative_rate);
    mark("initiative", has(sample) && (sample === 0 || has(rate)), has(sample, rate) && Math.round((rate! / 100) * sample!) > 0);
    mark("assistShare", has(contrib.solo, contrib.cleanup, contrib.assist), count(contrib.assist) > 0);
  }
  return result;
}

const TOTAL_ROLES = Object.keys(ROLE_DEFINITIONS).length;
const shortRoleLabel = (role: Exclude<RoleKey, "fieldCommander">) => ROLE_DEFINITIONS[role].label.split(" (")[0];

// 기준 바로 아래 점수가 반올림으로 기준 값처럼 보이지 않게 한다(84.96은 85.0이 아니라 84.96).
function formatRoleScore(raw: number, threshold: number): string {
  const rounded = Number(raw.toFixed(1));
  if (raw < threshold && rounded >= threshold) return (Math.floor(raw * 100) / 100).toFixed(2);
  return rounded.toFixed(1);
}

function unjudgedSentence(unjudged: RoleVerdict["unjudged"], isSoloMode: boolean): string {
  const parts: string[] = [];
  if (unjudged.notEnoughRecords > 0) parts.push(`판정에 필요한 기록이 부족하거나 없는 역할 ${unjudged.notEnoughRecords}개`);
  if (unjudged.referencePending > 0) parts.push(`비교 기준이 아직 준비되지 않은 역할 ${unjudged.referencePending}개`);
  if (unjudged.soloExcluded > 0 && isSoloMode) parts.push(`솔로 경기 위주라 제외한 팀 역할 ${unjudged.soloExcluded}개`);
  return parts.length > 0 ? `${parts.join(", ")}는 판정하지 않았습니다.` : "";
}

function buildVerdict(input: {
  primaryRole: RoleInfo["primaryRole"];
  ranked: Array<[Exclude<RoleKey, "fieldCommander">, number]>;
  unjudged: RoleVerdict["unjudged"];
  metricPercentiles: Record<RoleMetricKey, number | null>;
  isSoloMode: boolean;
  matchCount: number;
  rawMeans: Record<Exclude<RoleKey, "fieldCommander">, number | null>;
}): RoleVerdict {
  const { primaryRole, ranked, unjudged, metricPercentiles, isSoloMode, matchCount, rawMeans } = input;
  const scope = `점수 상위 ${matchCount}판`;
  const base = { matchCount, judgedRoles: ranked.length, totalRoles: TOTAL_ROLES, unjudged };
  const unjudgedText = unjudgedSentence(unjudged, isSoloMode);

  if (primaryRole !== "balanced" && primaryRole !== "insufficient") {
    const top = ranked[0];
    return {
      ...base,
      kind: "confirmed",
      topRole: top ? { role: top[0], score: Number(top[1].toFixed(2)) } : null,
      headline: "",
      label: "",
      detail: "",
      note: "",
      observations: [],
    };
  }

  if (primaryRole === "insufficient") {
    return {
      ...base,
      kind: "insufficient",
      topRole: null,
      headline: "판정할 기록 부족",
      label: `근거 수집 중 · 판정 역할 0/${TOTAL_ROLES}`,
      detail: `${scope}에서 칭호를 판정할 만큼 기록이 쌓인 역할이 없습니다.`,
      note: unjudgedText,
      observations: [],
    };
  }

  const [topRole, topScore] = ranked[0];
  // 동점은 원점수(역할 점수·지표 평균)까지 같은 경우만 센다. 정렬 규칙으로 깨진 동점은 세지 않는다.
  const tiedTop = ranked.filter(([role, value]) => value === topScore && rawMeans[role] === rawMeans[topRole]).length;
  const topText = tiedTop > 1
    ? `${tiedTop}개 역할 동점 ${formatRoleScore(topScore, PRIMARY_MIN_PERCENTILE)}`
    : `${shortRoleLabel(topRole)} ${formatRoleScore(topScore, PRIMARY_MIN_PERCENTILE)}`;
  // 관측 성향: 판정에 쓴 지표 중 다른 플레이어 상위 25% 안에 든 기록. 칭호 판정과 별개다.
  const observations = (Object.entries(metricPercentiles) as Array<[RoleMetricKey, number | null]>)
    .filter((entry): entry is [RoleMetricKey, number] => entry[1] !== null && entry[1] >= COMMANDER_ROLE_PERCENTILE
      && !(isSoloMode && TEAM_ONLY_METRICS.has(entry[0])))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    // 칭호 기준(역할별 상위 수준)과 헷갈리지 않게 올림해 실제보다 높게 표시하지 않는다.
    .map(([key, value]) => `${METRIC_LABELS[key]} 상위 ${Math.max(1, Math.ceil(100 - value))}%`);
  return {
    ...base,
    kind: "below_threshold",
    topRole: { role: topRole, score: Number(topScore.toFixed(2)) },
    headline: "뚜렷한 대표 역할 없음",
    label: `칭호 기준 미달 · 판정 역할 ${ranked.length}/${TOTAL_ROLES}`,
    detail: `${scope}에서 ${ranked.length === 1 ? "판정한 역할 1개도" : `판정한 역할 ${ranked.length}개 모두`} 역할별 칭호 기준 ${PRIMARY_MIN_PERCENTILE}점(기준 표본에서 역할 하나가 상위 ${100 - PRIMARY_MIN_PERCENTILE}% 수준)에 못 미쳤습니다(최고: ${topText}).`,
    note: unjudgedText,
    observations,
  };
}
