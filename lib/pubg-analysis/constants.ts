/**
 * PUBG 전술 분석 엔진 상수 정의
 *
 * [ISR 캐시 아키텍처 V1.0]
 * - RESULT_VERSION: 분석 결과 DB 레코드에 기록되는 엔진 버전 식별자입니다.
 *   Next.js 16 unstable_cache + revalidateTag 기반 온디맨드 ISR 도입 이후,
 *   캐시 무효화는 revalidateTag('match-analysis')가 담당하므로
 *   수동 버전 범핑을 통한 잦은 캐시 소각은 더 이상 필요하지 않습니다.
 *   엔진 로직이 대규모로 변경될 때만 값을 증가시킵니다.
 *
 * - TELEMETRY_VERSION: R2 스토리지의 리플레이/슬림 텔레메트리 파일명에 포함되어
 *   파일 수준의 캐시 무효화를 수행합니다. (R2 파일명 기반, ISR 무관)
 */

export const RESULT_VERSION = 73.0; // [V73.0] PUBG AI 분석 정확도 감사 기준 결과 버전
export const TELEMETRY_VERSION = 61.0; // [V61.0] PUBG AI 분석 정확도 감사 기준 telemetry 버전
export const AI_CACHE_VERSION = "2026-09-02.pubg-ai-accuracy-v3"; // ai-analyze/ai-squad cache contract; v3 requires marked canonical population evidence
export const AI_SUMMARY_CACHE_VERSION = "2026-09-05.debate-solo-metric-v6"; // distinguish solo-kill telemetry wording from SOLO queue markers
// Evidence marker for canonical rows written after the human BR population
// boundary. This is deliberately independent of RESULT/telemetry/cache
// versions so old v73/R2 rows can fail closed without a broad cache bump.
export const POPULATION_EVIDENCE_VERSION = 1;

/**
 * 무료 티어 및 고효율 운영을 위한 Gemini 모델 폴백 우선순위
 * 1순위: gemini-3.5-flash-lite (초고속, 쿼터 절약)
 * 2순위: gemini-3.1-flash-lite (Lite 계열 안정적 보조)
 * 3순위: gemini-3.5-flash (표준 고성능)
 * 4순위: gemini-3.6-flash (최고 성능 폴백)
 */
export const GEMINI_MODELS_TO_TRY = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
] as const;

export const MAP_NAMES: Record<string, string> = {
  "Baltic_Main": "에란겔", 
  "Erangel_Main": "에란겔", // 🎯 에란겔 메인 맵 한글명 보완
  "Savage_Main": "사녹", 
  "Desert_Main": "미라마",
  "Summerland_Main": "카라킨", 
  "Chimera_Main": "파라모", 
  "Tiger_Main": "태이고",
  "Kiki_Main": "데스턴", 
  "Neon_Main": "론도",
  "DihorOtok_Main": "비켄디"
};

export const MAP_SIZES: Record<string, number> = {
  baltic: 819200, erangel: 819200,
  desert: 819200, miramar: 819200,
  tiger: 819200, taego: 819200,
  kiki: 819200, deston: 819200,
  neon: 819200, rondo: 819200,
  dihorotok: 819200, vikendi: 819200,
  savage: 409600, sanhok: 409600,
  chimera: 307200, paramo: 307200,
  summerland: 204800, karakin: 204800,
  haven: 102400
};

// 전술 지표 임계값
export const TACTICAL_THRESHOLDS = {
  ISOLATION_MAX_RATIO: 5,        // 고립 지수 최대값 클램핑
  STANDARD_ENGAGEMENT_DIST: 100, // 표준 교전 거리 (m)
  VERTICAL_ISOLATION_Z: 5,       // 수직 고립 판정 기준 (m)
  REACTION_WINDOW_MS: 5000,      // 반응 속도 측정 유효 시간
  TRADE_WINDOW_MS: 30000,        // 트레이드(복수) 유효 시간 (ID 매핑 실패 시 폴백용)
  EARLY_GAME_MIN: 5,             // 초반전 기준 (분)
  MID_GAME_1_MIN: 15,            // 중반전1 기준 (분)
  MID_GAME_2_MIN: 25,            // 중반전2 기준 (분)
  ASSIST_DAMAGE_THRESHOLD: 20.0, // 아군의 누적 딜 기여가 최소 20 이상일 때만 어시스트 인정
  ASSIST_TIME_LIMIT_MS: 120000,  // 아군의 마지막 타격으로부터 2분(120초) 이내여야 어시스트 인정
  REACTION_MAX_DISTANCE_METERS: 150, // 대응사격 측정 유효 거리제한 (150m)
};

export const WEAPON_NAMES: Record<string, string> = {
  // AR
  "WeapM416_C": "M416", "WeapHK416_C": "M416", "HK416": "M416", "M416": "M416",
  "WeapSCAR-L_C": "SCAR-L", "SCAR-L": "SCAR-L", "WeapAKM_C": "AKM", "AKM": "AKM", "WeapAK47_C": "AKM", "AK47": "AKM", 
  "WeapBerylM762_C": "베릴 M762", "BerylM762": "베릴 M762", "Beryl": "베릴 M762",
  "WeapM16A4_C": "M16A4", "M16A4": "M16A4", "WeapMk47Mutant_C": "뮤턴트", "Mk47Mutant": "뮤턴트", "Mutant": "뮤턴트",
  "WeapG36C_C": "G36C", "G36C": "G36C", "WeapK2_C": "K2", "K2": "K2", "WeapACE32_C": "ACE32", "ACE32": "ACE32",
  "WeapAUG_C": "AUG", "AUG": "AUG", "WeapGroza_C": "그로자", "Groza": "그로자", "WeapFAMAS_C": "파마스", "FAMAS": "파마스",
  
  // SR
  "WeapKar98k_C": "Kar98k", "Kar98k": "Kar98k", "WeapM24_C": "M24", "M24": "M24", 
  "WeapMosinnagant_C": "모신나강", "Mosinnagant": "모신나강", "Mosin": "모신나강", 
  "WeapWin94_C": "Win94", "Win94": "Win94", "WeapAWM_C": "AWM", "AWM": "AWM",
  "WeapL6_C": "링스 AMR", "L6": "링스 AMR", "LynxAMR": "링스 AMR", "l6": "링스 AMR", "weapL6_C": "링스 AMR",
  
  // DMR
  "WeapSKS_C": "SKS", "SKS": "SKS", "WeapSLR_C": "SLR", "SLR": "SLR", "WeapFNFal_C": "SLR", "FNFal": "SLR", 
  "WeapMini14_C": "Mini14", "Mini14": "Mini14", "WeapMk14_C": "Mk14", "Mk14": "Mk14", 
  "WeapQBU88_C": "QBU", "QBU88": "QBU", "QBU": "QBU", "WeapVSS_C": "VSS", "VSS": "VSS", 
  "WeapDragunov_C": "드라구노프", "Dragunov": "드라구노프",
  
  // SMG
  "WeapUZI_C": "마이크로 UZI", "UZI": "마이크로 UZI", "MicroUZI": "마이크로 UZI", 
  "WeapUMP45_C": "UMP45", "UMP45": "UMP45", "UMP": "UMP45", 
  "WeapVector_C": "벡터", "Vector": "벡터", "WeapTommyGun_C": "토미건", "TommyGun": "토미건", 
  "WeapMP5K_C": "MP5K", "MP5K": "MP5K", "WeapP90_C": "P90", "P90": "P90", "WeapJS9_C": "JS9", "JS9": "JS9",
  
  // SG
  "WeapS12K_C": "S12K", "S12K": "S12K", "WeapS1897_C": "S1897", "S1897": "S1897", 
  "WeapS686_C": "S686", "S686": "S686", "WeapDBS_C": "DBS", "DBS": "DBS", 
  
  // LMG / Others
  "WeapM249_C": "M249", "M249": "M249", "WeapRPD_C": "RPD", "RPD": "RPD", "Item_Weapon_RPD_C": "RPD", "WeapDP28_C": "DP-28", "DP28": "DP-28", "DP-28": "DP-28",
  "WeapMG3_C": "MG3", "MG3": "MG3", "WeapOriginS12_C": "O12", "OriginS12": "O12", "O12": "O12",
  "WeapPanzerFaust100M_C": "판처파우스트", "PanzerFaust100M_Projectile_C": "판처파우스트", "PanzerFaust100M_Projectile": "판처파우스트", "Panzerfaust": "판처파우스트", "PANZERFAUST100M": "판처파우스트", "PANZERFAUST100M_C": "판처파우스트", "PANZERFAUST": "판처파우스트", "WeapMortar_C": "박격포", "WeapCrossbow_C": "석궁",

  // Pistols
  "WeapP18C_C": "P18C", "P18C": "P18C", "WeapG18_C": "P18C", "G18": "P18C", "G18C": "P18C", "P18C_C": "P18C",
  "WeapP92_C": "P92", "P92": "P92", "WeapP1911_C": "P1911", "P1911": "P1911", "WeapR45_C": "R45", "R45": "R45",
  "WeapR1895_C": "R1895", "R1895": "R1895", "WeapDesertEagle_C": "디글", "Deagle": "디글", "DEAGLE": "디글", "DesertEagle": "디글",
  
  // Damage Types
  "Damage_BlueZone": "자기장", "Damage_Falling": "낙사", "Damage_Drowning": "익사", "Damage_Groggy": "출혈(기절)", "Damage_Gunshot": "총기", "Damage_Explosion": "폭발",
  
  // Vehicles
  "Vehicle_Dacia_C": "다시아", "Vehicle_UAZ_C": "UAZ", "Vehicle_CoupeRB_C": "쿠페 RB", "BP_CoupeRB_C": "쿠페 RB", "CoupeRB": "쿠페 RB", "BPoupeRB": "쿠페 RB",
  "Vehicle_Motorbike_C": "오토바이", "Vehicle_Zima_C": "지마", "Vehicle_Porter_C": "포터", "Vehicle_PonyCoupe_C": "포니 쿠페", "BP_PonyCoupe_C": "포니 쿠페",
  "Vehicle_Mirado_C": "미라도", "BP_Mirado_A_01": "미라도", "BP_Mirado_A_02": "미라도", "BP_Mirado_A_03": "미라도", "BP_Mirado_A_03_Esports": "미라도", "Mirado": "미라도",
  "Vehicle_TukTuk_C": "툭툭", "Vehicle_Rony_C": "로니", "Vehicle_Pickup_C": "픽업트럭",
  "Vehicle_BRDM_C": "BRDM", "Vehicle_LootTruck_C": "보급 트럭", "Vehicle_AquaRail_C": "아쿠아레일", "Vehicle_PG117_C": "보트",
  "Vehicle": "차량",
  
  // Items
  "Item_Weapon_C4_C": "C4", "Item_Heal_FirstAid_C": "구급상자", "Item_Heal_MedKit_C": "의료용 키트",
  "Item_Heal_Bandage_C": "붕대", "Item_Boost_EnergyDrink_C": "에너지 드링크", "Item_Boost_PainKiller_C": "진통제",
  "Item_Boost_AdrenalineSyringe_C": "아드레날린 주사기",
  
  // Projectiles & Throwables
  "ProjGrenade_C": "수류탄", "ProjMolotov_C": "화염병", "ProjSmokeBomb_C": "연막탄", "ProjFlashBang_C": "섬광탄",
  "ProjBluezoneGrenade_C": "블루존 수류탄", "ProjStickyGrenade_C": "점착 폭탄", "ProjC4_C": "C4",
  "PROJGRENADE_C": "수류탄", "PROJGRENADE": "수류탄", "GRENADE": "수류탄", "GRENADE_C": "수류탄", "grenade": "수류탄", "grenade_c": "수류탄",
  "PROJMOLOTOV_C": "화염병", "PROJMOLOTOV": "화염병", "MOLOTOV": "화염병", "MOLOTOV_C": "화염병", "molotov": "화염병", "molotov_c": "화염병",
  "PROJSMOKEBOMB_C": "연막탄", "PROJSMOKEBOMB": "연막탄", "SMOKEBOMB": "연막탄", "SMOKEBOMB_C": "연막탄", "SMOKE": "연막탄", "smoke": "연막탄", "smokebomb": "연막탄",
  "PROJFLASHBANG_C": "섬광탄", "PROJFLASHBANG": "섬광탄", "FLASHBANG": "섬광탄", "FLASHBANG_C": "섬광탄", "FLASH": "섬광탄", "flash": "섬광탄", "flashbang": "섬광탄",
  "PROJSTICKYGRENADE_C": "점착 폭탄", "PROJSTICKYGRENADE": "점착 폭탄", "STICKYGRENADE": "점착 폭탄", "STICKYGRENADE_C": "점착 폭탄", "stickygrenade": "점착 폭탄",
  "PROJBLUEZONEGRENADE_C": "블루존 수류탄", "PROJBLUEZONEGRENADE": "블루존 수류탄", "BLUEZONEGRENADE": "블루존 수류탄", "BLUEZONEGRENADE_C": "블루존 수류탄", "bluezonegrenade": "블루존 수류탄",
  "PROJC4_C": "C4", "PROJC4": "C4", "C4": "C4", "C4_C": "C4", "c4": "C4",
  "Item_Weapon_Grenade_C": "수류탄", "item_weapon_grenade_c": "수류탄",
  "Item_Weapon_Molotov_C": "화염병", "item_weapon_molotov_c": "화염병",
  "Item_Weapon_SmokeBomb_C": "연막탄", "item_weapon_smokebomb_c": "연막탄",
  "Item_Weapon_FlashBang_C": "섬광탄", "item_weapon_flashbang_c": "섬광탄",
  "Item_Weapon_BluezoneGrenade_C": "블루존 수류탄", "item_weapon_bluezonegrenade_c": "블루존 수류탄",
  "Item_Weapon_StickyGrenade_C": "점착 폭탄", "item_weapon_stickygrenade_c": "점착 폭탄",
  "item_weapon_c4_c": "C4",
  
  // New Utilities
  "Item_Weapon_M79_C": "M79 연막탄", "item_weapon_m79_c": "M79 연막탄",
  "Item_Weapon_CoverStructDropHandFlare_C": "비상 엄폐물", "item_weapon_coverstructdrophandflare_c": "비상 엄폐물",
  "Item_Weapon_MountainBike_C": "접이식 자전거", "item_weapon_mountainbike_c": "접이식 자전거",
  
  "Melee": "근접 무기", "Punch": "주먹", "BlueZone": "자기장", "None": "없음"
};

/**
 * 분석에서 제외할 무기 (투척물, 주먹 등)
 */
export const IGNORE_WEAPONS = [
  "WeapSmokeBomb_C", "WeapFlashBang_C", "WeapSpikeStrip_C", "WeapDecoyGrenade_C", "None"
];

/**
 * 분석에서 제외할 무기 이름 패턴 (부분 일치)
 */
export const IGNORE_WEAPON_PATTERNS = [
  "Smoke", "Flash", "PlayerFemale", "PlayerMale", "Flare"
];

/**
 * 무기 영문명을 한글로 번역합니다. 
 * WEAPON_NAMES에 매핑되지 않은 변형(예: Uaz_B_01_esports)도 처리합니다.
 */
export function getTranslatedWeaponName(wId: string): string {
  if (!wId) return "없음";
  if (WEAPON_NAMES[wId]) return WEAPON_NAMES[wId];
  
  const wUpper = wId.toUpperCase();
  if (WEAPON_NAMES[wUpper]) return WEAPON_NAMES[wUpper];
  
  const wLower = wId.toLowerCase();
  if (wLower.includes("uaz")) return "UAZ";
  if (wLower.includes("dacia")) return "다시아";
  if (wLower.includes("buggy")) return "버기";
  if (wLower.includes("motorcycle") || wLower.includes("motorbike")) return "오토바이";
  if (wLower.includes("pickup") || wLower.includes("pickuptruck")) return "픽업트럭";
  if (wLower.includes("mirado")) return "미라도";
  if (wLower.includes("ponycoupe") || wLower.includes("pony")) return "포니 쿠페";
  if (wLower.includes("couperb") || wLower.includes("coupe")) return "쿠페 RB";
  if (wLower.includes("zima")) return "지마";
  if (wLower.includes("porter")) return "포터";
  if (wLower.includes("brdm")) return "BRDM";
  if (wLower.includes("scooter")) return "스쿠터";
  if (wLower.includes("snowmobile")) return "스노우모빌";
  if (wLower.includes("snowbike")) return "스노우바이크";
  if (wLower.includes("tuktuk")) return "툭툭";
  if (wLower.includes("bicycle")) return "자전거";
  if (wLower.includes("dirtbike")) return "더트바이크";
  if (wLower.includes("boat") || wLower.includes("pg117")) return "보트";
  if (wLower.includes("aquarail")) return "아쿠아레일";
  if (wLower.includes("airboat")) return "에어보트";
  if (wLower.includes("ladaniva") || wLower.includes("niva")) return "라다 니바";
  if (wLower.includes("minibus") || wLower.includes("bus")) return "미니버스";
  if (wLower.includes("tractor")) return "트랙터";
  if (wLower.includes("blanc")) return "블랑";
  if (wLower.includes("pillar")) return "필라 차량";
  if (wLower.includes("vehicle")) return "차량";
  
  return wId;
}

/**
 * 로컬 스토리지 키 (최근 검색, 즐겨찾기)
 */
export const STORAGE_KEY_RECENT = "pubg_recent_searches_v2";
export const STORAGE_KEY_FAVORITES = "pubg_favorites_v2";

/**
 * 전술 분석 티어 순위 (높을수록 숙련도 높음)
 */
export const TIER_RANK = {
  'S+': 14,
  'S': 13,
  'A+': 12, 'A': 11, 'A-': 10,
  'B+': 9,  'B': 8,  'B-': 7,
  'C+': 6,  'C': 5,  'C-': 4,
  'D+': 3,  'D': 2,  'D-': 1
} as const;

export type Tier = keyof typeof TIER_RANK;
