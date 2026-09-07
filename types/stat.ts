/**
 * @fileoverview 전적 검색 결과 및 개별 매치 내 플레이어의 통계를 나타내는 타입들을 정의합니다.
 */
import { TimelineEvent } from "../lib/pubg-analysis/types";

export interface MatchStats {
  winPlace: number;
  kills: number;
  assists: number;
  damageDealt: number;
  processedDamageDealt?: number;
  timeSurvived: number;
  DBNOs: number;
  headshotKills: number;
  longestKill: number;
  heals: number;
  boosts: number;
  deathType: string;
  walkDistance: number;
  rideDistance: number;
  swimDistance: number;
  revives: number;
  name: string;
  playerId: string;
  leadShotKills?: number;
  leadShotKnocks?: number;
  ridingShotKills?: number;
  ridingShotKnocks?: number;
  roadKills?: number;
  roadKnocks?: number;
}

export interface MatchTeamMember {
  name: string;
  kills: number;
  assists: number;
  damageDealt: number;
  DBNOs: number;
  revives: number;
  deathType?: string;
  deaths?: number;
}

/** 텔레메트리 기반 킬 상세 정보 */
export interface KillDetail {
  type: "킬" | "기절";
  weapon: string;       // 한글 무기명
  weaponRaw: string;    // 원본 무기 코드 (디버그용)
  distanceM: number;    // 교전 거리 (m 단위)
  isHeadshot?: boolean; // 헤드샷 여부 (킬 이벤트)
  reason?: string;      // 피해 이유
  victimName: string;   // 피해자 닉네임
}

export interface MatchData {
  analysisAvailability?: "basic_only";
  analysisUnavailableReason?: "calculation_upgrade_required";
  matchId: string;
  stats: MatchStats;
  mapName: string;
  mapId: string;
  createdAt: string;
  gameMode: string;
  matchType?: string;
  totalTeams?: number;
  totalPlayers?: number;
  team: MatchTeamMember[];
  totalTeamKills: number;
  totalTeamDamage: number;
  /** 텔레메트리 기반 킬 상세 (무기, 거리, 헤드샷 여부) */
  killDetails: KillDetail[];
  /** 텔레메트리 기반 기절 상세 */
  dbnoDetails: KillDetail[];
  /** [V6.5] 팀 기여도 지표 */
  teamImpact?: {
    damageImpact: number;
    killImpact: number;
    teamDamageShare: number;
    teamKillShare: number;
    totalTeamDamage: number;
    totalTeamKills: number;
  };
  /** [V6.5] 획득 배지 리스트 */
  badges?: Array<{
    id: string;
    name: string;
    desc: string;
  }>;
  /** [V3] 플레이어 순위 정보 (딜량 순위, 백분위, 킬 순위) */
  myRank?: {
    damageRank: number;
    damagePercentile: number;
    killRank: number;
    totalTeams?: number;
    totalPlayers?: number;
  };
  /** [V31] 전술적 몰살 여부 */
  teamWipeOccurred?: boolean;
  /** [V3] 교전 압박 지표 */
  combatPressure?: {
    totalHits: number;
    uniqueVictims: string[];
    maxHitDistance: number;
    utilityDamage: number;
    utilityHits: number;
    pressureIndex?: number;
    utilityStats?: {
      throwCount?: number;
      lethalThrowCount?: number;
      hitCount?: number;
      damageEventCount?: number;
      totalDamage?: number;
      killCount?: number;
      accuracy?: number;
    };
  };
  /** [V3.0] 전술 지표 (견제, 세이브, 복수 등) */
  tradeStats?: {
    teammateKnocks: number;
    dangerousKnocks?: number;
    smokeOpps?: number;
    suppCount: number;
    tradeKills?: number;
    smokeCount: number;
    smokeRescues?: number;
    teamSmokeCovered?: number;
    revCount: number;
    baitCount: number;
    tradeLatencyMs?: number;
    counterLatencyMs: number;
    reactionLatencyMs: number;
    coverRate: number;
    coverRateSampleCount?: number;
    enemyTeamWipes?: number;
    tradeRate?: number;
    suppRate?: number;
  };
  /** [V8.1] 공간 지능 지표 (고립 지수, 아군 거리 등) */
  isolationData?: {
    isolationIndex: number;
    minDist: number;
    heightDiff: number;
    isCrossfire: boolean;
    teammateCount: number;
  };
  /** [V31] 선제 타격 지표 */
  initiativeStats?: {
    total: number;
    success: number;
    rate: number;
  };
  /** [V31] 벤치마크 데이터 */
  eliteBenchmark?: {
    avgDamage: number;
    avgKills: number;
    realTradeLatency: number;
    realInitiativeSuccess: number;
    realDeathDistance: number;
    realReviveRate: number;
    realSmokeRate: number;
    realSuppCount?: number;
    realTeamWipes?: number;
    realUtilityCount?: number;
    realSurvivalTime?: number;
    realSoloKillRate?: number;
    realBurstDamage?: number;
    avgDeathPhase?: number;
  };
  /** [V3.0] 상세 전술 타임라인 */
  tacticalTimeline?: Array<{
    victim: string;
    distUserToTeammate: number;
    distUserToEnemy: number;
    heightDiff: number;
    hasSuppression: boolean;
    hasSmoke: boolean;
    hasRevive: boolean;
  }>;
  /** [V3] 골든타임 딜량 */
  goldenTimeDamage?: {
    early: number;
    mid1: number;
    mid2: number;
    late: number;
  };
  /** [V8.1] 선제 타격 성공률 (직접 필드) */
  initiative_rate?: number;
  initiativeSampleCount?: number;
  /** [V11.1] 사망 시 자기장 페이즈 */
  deathPhase?: number;
  edgePlay?: number;
  bluezoneWaste?: number;
  v: number;
  /** [V11.9.5] 티어 벤치마크 상세 데이터 */
  benchmark?: {
    tier: string;
    score: number;
    breakdown: {
      combat: number;
      tactical: number;
      survival: number;
    };
    impactScore?: number;
    impactGrade?: "NORMAL" | "GOOD" | "CARRY" | "HARD_CARRY" | "LEGEND";
    impactBonus?: number;
    impactReasons?: string[];
    contributionTypes?: Array<"FIREPOWER" | "FINISHER" | "RECOVERY" | "CLUTCH" | "SUPPORT" | "SURVIVAL_CONTROL">;
  };
  isValidBenchmark?: boolean;
  matchInfo?: {
    map?: string;
    mapId?: string;
    date?: string;
    mode?: string;
    duration?: number;
    rankPct?: number;
    tier?: string;
  };
  itemUseSummary?: {
    smokes?: number;
    frags?: number;
    molotovs?: number;
    others?: number;
  };
  itemUseStats?: {
    heals?: number;
    boosts?: number;
    throwCount?: number;
    lethalThrowCount?: number;
    focusFireCount?: number;
    crossfireExposureCount?: number;
  };
  /** [V12.5] 1:1 교전 통계 */
  duelStats?: {
    totalDuels: number;
    wins: number;
    losses: number;
    reversals?: number;
    reversalAttempts?: number;
    reversalRate: number;
    duelWinRate: number;
  };
  /** [V12.5] 상세 경기 타임라인 */
  timeline?: TimelineEvent[];
  leadShotKills?: number;
  leadShotKnocks?: number;
  ridingShotKills?: number;
  ridingShotKnocks?: number;
  roadKills?: number;
  roadKnocks?: number;
  weaponStats?: Record<string, {
    kills: number;
    dbnos: number;
    damage: number;
    hits: number;
    shots?: number;
    accuracy?: number;
    holdingTime?: number;
    dBNODamage?: number;
    dBNOHits?: number;
    hitDetails?: Array<{
      bodyPart: string;
      kills: number;
      dBNOs: number;
      hits: number;
      dBNOHits: number;
      damage: number;
      dBNODamage: number;
    }>;
  }>;
  squadWeaponStats?: Record<string, Array<{
    weapon: string;
    damage: number;
    dBNODamage: number;
    shots: number;
    hits: number;
    dBNOHits: number;
    holdingTime: number;
    accuracy: number;
    hitDetails?: Array<{
      bodyPart: string;
      kills: number;
      dBNOs: number;
      hits: number;
      dBNOHits: number;
      damage: number;
      dBNODamage: number;
    }>;
  }>>;
}
