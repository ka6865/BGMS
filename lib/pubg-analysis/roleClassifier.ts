import { WEAPON_NAMES, IGNORE_WEAPONS } from "./constants";

/**
 * PUBG 전술 직업군 분류기 (Role Classifier)
 * 유저의 10경기 집계 데이터와 벤치마크를 기반으로 8종의 직업군 및 무기 시그니처를 판정합니다.
 */

export interface RoleScore {
  pointMan: number;         // 선봉대
  phantomOverwatch: number; // 저격 유령
  executor: number;         // 처형자
  shield: number;           // 팀의 방패
  zoneController: number;   // 전장 통제자
  dropPredator: number;     // 핫드랍 약탈자
  decoy: number;            // 미끼 전술가
  fieldCommander: number;   // 전장의 지휘관
}

export interface RoleInfo {
  primaryRole: keyof RoleScore;
  secondaryRole: keyof RoleScore | null;
  overallTier: string;
  title: string;
  roleLabel: string;
  description: string;
  signatureWeapon: string;
  signatureWeaponStats?: { 
    kills: number; 
    dbnos: number;
    consistency?: number;
    isReliable?: boolean;
  };
  weakness: string | null;
  scores: RoleScore;
}

const ROLE_LABELS: Record<keyof RoleScore, string> = {
  pointMan: "선봉대 (Point Man)",
  phantomOverwatch: "저격 유령 (Phantom Overwatch)",
  executor: "처형자 (Executor)",
  shield: "팀의 방패 (Shield)",
  zoneController: "전장 통제자 (Zone Controller)",
  dropPredator: "핫드랍 약탈자 (Drop Predator)",
  decoy: "미끼 전술가 (Decoy)",
  fieldCommander: "전장의 지휘관 (Field Commander)"
};

const ROLE_DESCRIPTIONS: Record<keyof RoleScore, string> = {
  pointMan: "항상 팀의 가장 앞에 서서 첫 총성을 울립니다. 빠른 반응 속도와 두려움 없는 진입이 특징입니다.",
  phantomOverwatch: "팀원과 거리를 유지하며 외곽에서 적의 허를 찌릅니다. 보이지 않는 곳에서 전장을 감시하는 망령입니다.",
  executor: "압도적인 1:1 무력으로 교전을 종결시킵니다. 불리한 상황에서도 역전승을 만들어내는 심판자입니다.",
  shield: "아군이 기절했을 때 가장 먼저 연막을 뿌리고 달려갑니다. 팀의 생존을 책임지는 든든한 수호신입니다.",
  zoneController: "자기장 경계선을 타고 움직이며 구역을 장악합니다. 적의 진입을 차단하고 유리한 위치를 절대 놓치지 않습니다.",
  dropPredator: "초반 핫드랍 지역에서 가장 먼저 킬을 올립니다. 혼돈 속에서도 냉정하게 적을 사냥하는 약탈자입니다.",
  decoy: "자신을 미끼로 던져 적의 위치를 노출시키고 양각을 만듭니다. 팀의 승리를 위해 희생을 두려워하지 않는 전략가입니다.",
  fieldCommander: "모든 지표가 균형 있게 높으며 팀을 승리로 이끕니다. 전장의 흐름을 완벽하게 읽고 통제하는 지휘관입니다."
};

const TIER_PREFIX: Record<string, string> = {
  S: "전설의",
  A: "숙련된",
  B: "성장하는",
  C: "잠재된"
};

const ROLE_TITLES: Record<keyof RoleScore, string[]> = {
  pointMan:        ["총구의 시계추", "첫 총성의 화신", "돌격의 화신"],
  phantomOverwatch: ["전장의 망령",   "침묵의 감시자",  "보이지 않는 손"],
  executor:        ["심판자",        "결투의 제왕",    "역전의 귀재"],
  shield:          ["전우의 수호신", "마지막 방패",    "연막의 천사"],
  zoneController:  ["구역의 지배자", "자기장의 주인",  "압박의 화신"],
  dropPredator:    ["착지의 악마",   "핫존의 포식자",  "혼돈의 사냥꾼"],
  decoy:           ["고의적 피탄자", "희생의 전략가",  "미끼의 달인"],
  fieldCommander:  ["전장의 지휘관", "완전체",         "육각형 플레이어"]
};

// [V16.0] 복합 칭호 시스템
const COMBO_TITLES: Record<string, string> = {
  "zoneController+executor": "전장의 사신",
  "zoneController+pointMan": "돌격하는 지배자",
  "executor+pointMan": "선봉의 심판자",
  "shield+decoy": "고의적 수호신",
  "phantomOverwatch+executor": "그림자 처형자",
  "dropPredator+pointMan": "착지의 선봉대",
  "fieldCommander+executor": "전장의 군주"
};

// [V16.0] 직업별 취약점 진단 로직
const ROLE_WEAKNESSES: Partial<Record<keyof RoleScore, (s: any) => string | null>> = {
  zoneController: (s) => 
    (s.avgDuelWinRate || 0) < 45 ? "외곽 운영은 탁월하지만 1:1 교전 결정력이 부족합니다." : null,
  
  executor: (s) => 
    s.totalTeammateKnocks > 0 && ((s.totalRevCount || 0) / s.totalTeammateKnocks) < 0.3 
      ? "개인 무력은 강하지만 팀원 케어가 부족합니다." : null,
  
  dropPredator: (s) => 
    (s.avgDeathPhase || 0) < 4 ? "초반 교전 후 생존 단계로의 전환이 다소 미흡합니다." : null,
  
  shield: (s) => 
    (s.avgDamage || 0) < 200 ? "팀 기여는 높지만 절대적인 화력이 부족하여 교전에서 밀릴 수 있습니다." : null,
  
  pointMan: (s) => 
    parseFloat(s.avgIsolationStr || "0") > 2.0 ? "돌격 시 팀원과 거리가 너무 벌어져 고립되는 경향이 있습니다." : null,
      
  phantomOverwatch: (s) =>
    s.totalTeammateKnocks > 0 && ((s.totalTradeKills || 0) / s.totalTeammateKnocks) < 0.2
      ? "외곽 지원 능력은 좋으나 팀원의 위기 시 백업 속도가 늦는 편입니다." : null,
};

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

/**
 * 안전한 반응 속도 파싱 (ms 단위 변환)
 */
const parseLatency = (val: string | null | undefined) => {
  if (!val || val === "N/A" || val === "측정 불가") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
};

// Route-owned aggregate fields may intentionally use the unavailable marker
// (for example, when no position samples were observed).  Role scores must
// stay finite without turning that missing measurement into an observed value.
const parseFiniteMetric = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * 8종 직업군 판정 로직
 */
export function classifyRole(stats: any, bench: any, overallTier: string): RoleInfo {
  const scores: RoleScore = {
    pointMan: 0,
    phantomOverwatch: 0,
    executor: 0,
    shield: 0,
    zoneController: 0,
    dropPredator: 0,
    decoy: 0,
    fieldCommander: 0
  };

  const mLen = stats.mLen || 1;
  const isSoloMode = stats.modeDistribution?.main === 'solo';

  // 1. 선봉대 (Point Man)
  const reactionMs = parseLatency(stats.avgReactionLatency);
  const reactionScore = reactionMs !== null ? Math.max(0, 40 - reactionMs * 20) : 0;
  const isCloseRange = parseFloat(stats.avgMinDistStr || "999") < 20;
  
  scores.pointMan = (stats.userInitiativeRate || 0) * 0.5 
    + reactionScore 
    + (parseFloat(stats.avgMinDistStr) < 15 ? 10 : 5)
    + (isCloseRange ? 15 : 0)
    + (stats.totalRidingShotKnocks || 0) * 8; // [V58.4] 라이딩샷 기절 가중치

  // 2. 저격 유령 (Phantom Overwatch)
  const isolationIndex = parseFiniteMetric(stats.avgIsolationStr);
  scores.phantomOverwatch = Math.max(0, 
    Math.min(40, (stats.totalMaxHitDist / 10)) + 
    (stats.userInitiativeRate || 0) * 0.3 + 
    Math.min(30, isolationIndex * 10) +
    (isCloseRange ? -10 : 10) +
    (stats.totalLeadShotKnocks || 0) * 8 // [V58.4] 리드샷 기절 가중치
  );

  // 3. 처형자 (Executor)
  scores.executor = (stats.avgDuelWinRate || 0) * 0.7 + 
                    Math.min(30, (stats.totalReversalWins / mLen) * 15) + 
                    Math.min(20, (stats.totalTeamWipes / mLen) * 15) +
                    (stats.totalRidingShotKills || 0) * 5; // [V58.4] 라이딩샷 킬 가중치

  // 4. 팀의 방패 (Shield)
  const knockBase = Math.max(stats.totalTeammateKnocks, 3 * mLen);
  const smokeRescueScore = ((stats.totalSmokeRescues || 0) / knockBase) * 40;
  const smokeAttemptSupport = ((stats.totalSmokeCount || 0) / knockBase) * 10;
  const rescueRate = ((stats.totalRevCount + stats.totalTradeKills) / knockBase) * 50;
  
  scores.shield = isSoloMode ? 0 
    : Math.min(50, rescueRate) + Math.min(50, smokeRescueScore + smokeAttemptSupport);

  // 5. 전장 통제자 (Zone Controller)
  const edgePlayPerMatch = stats.totalEdgePlay / mLen;
  scores.zoneController = Math.min(35, edgePlayPerMatch * 8) + 
                         Math.min(10, (100 - Math.min(100, stats.totalBluezoneWaste / mLen)) * 0.1) + 
                         Math.min(40, stats.avgPressureIndex * 8) +
                         Math.min(15, (stats.avgDeathPhase / 9) * 15) +
                         (stats.totalLeadShotKills || 0) * 5; // [V58.4] 리드샷 킬 가중치

  // 6. 핫드랍 약탈자 (Drop Predator)
  const totalGoldenTime = (stats.goldenTimeAvg?.early || 0) + 
                         (stats.goldenTimeAvg?.mid1 || 0) + 
                         (stats.goldenTimeAvg?.mid2 || 0) + 
                         (stats.goldenTimeAvg?.late || 0);
  const earlyRatio = totalGoldenTime > 0 ? (stats.goldenTimeAvg?.early || 0) / totalGoldenTime : 0;
  scores.dropPredator = Math.min(100, earlyRatio * 150);

  // 7. 미끼 전술가 (Decoy)
  scores.decoy = Math.min(70, (stats.totalBaitCount / mLen) * 35) + 
                 Math.min(30, (stats.totalSuppCount / mLen) * 6);

  // 8. 전장의 지휘관 (Field Commander)
  const activeRoles = (Object.entries(scores) as [keyof RoleScore, number][])
    .filter(([k]) => k !== 'fieldCommander')
    .filter(([, v]) => v >= 30).length;

  scores.fieldCommander = activeRoles >= 5
    ? (Object.entries(scores) as [keyof RoleScore, number][])
        .filter(([k]) => k !== 'fieldCommander')
        .reduce((acc, [, v]) => acc + v, 0) / 7
    : 0;

  // 최고 점수 직업 선정
  const sortedRoles = (Object.entries(scores) as [keyof RoleScore, number][])
    .sort((a, b) => b[1] - a[1]);

  const primaryRole = sortedRoles[0][0];
  const secondaryRole = (sortedRoles[1] && sortedRoles[1][1] >= (sortedRoles[0][1] * 0.65)) ? sortedRoles[1][0] : null;

  // [V16.0] 시그니처 무기 추출 (사용 일관성 반영)
  const weapon = getSignatureWeapon(stats.weaponStatsFinal || {}, stats.weaponMatchCount || {}, mLen);

  // [V16.0] 칭호 생성 로직 고도화
  const tierIndex = overallTier === 'S' ? 0 : overallTier === 'A' ? 1 : 2;
  const roleTitle = ROLE_TITLES[primaryRole][tierIndex];
  const prefix = TIER_PREFIX[overallTier] || "잠재된";

  let title = "";
  const comboKey = secondaryRole ? `${primaryRole}+${secondaryRole}` : null;
  const comboTitle = comboKey ? COMBO_TITLES[comboKey] : null;

  // [V58.4] 차량 전투 스페셜 전설 칭호 우선 판정
  const ridingShotSum = (stats.totalRidingShotKnocks || 0) + (stats.totalRidingShotKills || 0);
  const leadShotSum = (stats.totalLeadShotKnocks || 0) + (stats.totalLeadShotKills || 0);
  const vehicleCombatSum = ridingShotSum + leadShotSum;
  const vehicleCombatMatchCount = stats.vehicleCombatMatchCount || 0;
  
  if (vehicleCombatMatchCount >= 5) {
    title = `${prefix} 차량 전술 교전 마스터`;
  } else if (vehicleCombatSum >= 3) {
    title = `${prefix} 아스팔트의 지배자`;
  } else if (ridingShotSum >= 2) {
    title = `${prefix} 도로 위의 저승사자`;
  } else if (leadShotSum >= 2) {
    title = `${prefix} 고속도로 저격수`;
  } else if (comboTitle) {
    title = `${prefix} ${comboTitle}`;
  } else if (weapon.isSpecial) {
    title = `${weapon.name}, ${roleTitle}`;
  } else if (weapon.stats.isReliable) {
    title = `${prefix} ${roleTitle} (${weapon.name})`;
  } else {
    title = `${prefix} ${roleTitle}`;
  }

  // [V16.0] 취약점 진단
  const weakness = ROLE_WEAKNESSES[primaryRole]?.(stats) || null;

  return {
    primaryRole,
    secondaryRole,
    overallTier,
    title,
    roleLabel: ROLE_LABELS[primaryRole],
    description: ROLE_DESCRIPTIONS[primaryRole],
    signatureWeapon: weapon.name,
    signatureWeaponStats: {
      kills: weapon.stats.kills,
      dbnos: weapon.stats.dbnos,
      consistency: weapon.stats.consistency,
      isReliable: weapon.stats.isReliable
    },
    weakness,
    scores
  };
}
