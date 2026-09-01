/**
 * PUBG 전술 분석 엔진 공용 타입 정의
 */

export interface Location {
  x: number;
  y: number;
  z: number;
}

export interface TimelineEvent {
  ts: number;           // 경기 시작 후 경과 시간 (ms)
  type: 'KILL' | 'KNOCK' | 'FINISH' | 'REVIVE' | 'DIED' | 'DOWNED' | 'TEAM_KNOCK' | 'TEAM_KILL' | 'TEAM_REVIVE' | 'TEAM_DIED' | 'RECALL' | 'TEAM_RECALL' | 'REDEPLOY' | 'VICTORY' | 'DAMAGE_TAKEN' | 'ITEM_USE' | 'PHASE_START' | 'UTILITY_HIT';
  weapon?: string;      // 사용 무기
  victim?: string;      // 피해자
  attacker?: string;    // 가해자
  distance?: number;    // 거리 (m)
  isHeadshot?: boolean; // 헤드샷 여부
  phase?: number;       // 페이즈 번호
  isMe?: boolean;       // [V26.1] 본인 활동 여부 (UI 렌더링 최적화용)
  isRecall?: boolean;   // [V26.1] 블루칩 부활 여부
  isSelfRevive?: boolean; // [V26.1] 자가 부활 여부
  x?: number;           // 이벤트 발생 X 좌표
  y?: number;           // 이벤트 발생 Y 좌표
  attackerX?: number;   // [V43.0] 가해자 X 좌표
  attackerY?: number;   // [V43.0] 가해자 Y 좌표
  victimX?: number;     // [V43.0] 피해자 X 좌표
  victimY?: number;     // [V43.0] 피해자 Y 좌표
  playerName?: string;  // [V43.0] 마커 표시용 닉네임
}


export interface PlayerStats {
  name: string;
  kills: number;
  assists: number;
  damageDealt: number;
  processedDamageDealt?: number;
  winPlace: number;
  timeSurvived: number;
  DBNOs: number;
}

export interface UtilityStats {
  hitCount: number;
  damageEventCount?: number;
  throwCount: number;
  lethalThrowCount?: number;
  totalDamage: number;
  killCount: number;
  accuracy: number;
  accuracyRaw?: number;
  avgDamagePerThrow: number;

  fragHits?: number;
  molotovHits?: number;
}

export interface CombatPressure {
  pressureScore: number;
  pressureIndex: number;
  utilityStats: UtilityStats;
  isClutched: boolean;
  utilityDamage?: number;
  utilityHits?: number;
  totalHits?: number;
  maxHitDist?: number;
  uniqueVictims?: string[];
}

export interface IsolationData {
  /** Undefined means no valid position sample was observed; numeric zero is measured. */
  isolationIndex?: number;
  combatIsolation?: number;
  deathIsolation?: number;
  minDist?: number;
  heightDiff?: number;
  isCrossfire: boolean;
  teammateCount?: number;
}

export interface TradeStats {
  teammateKnocks: number;
  suppCount: number;
  tradeKills: number;
  smokeCount: number;
  smokeRescues: number;
  revCount: number;
  baitCount: number;
  tradeLatencyMs: number;
  counterLatencyMs: number;
  reactionLatencyMs: number;
  coverRate: number;
  coverRateSampleCount: number;
  enemyTeamWipes: number;
  tradeRate?: number;
  suppRate?: number;
}

export interface DuelStats {
  totalDuels: number;
  wins: number;
  losses: number;
  reversals: number;
  reversalAttempts: number;
  reversalRate: number;
  duelWinRate: number;
}

export interface AnalysisResult {
  matchId: string;
  v: number;
  populationEvidenceVersion?: number;
  processedAt: string;
  createdAt: string;
  stats: PlayerStats;
  team: PlayerStats[];
  deathPhase: number;
  mapName: string;
  gameMode: string;
  matchType: string;
  /** Preserved PUBG metadata evidence used by population eligibility gates. */
  attributes?: Record<string, unknown>;
  telemetryFlags?: Record<string, unknown>;
  totalTeams: number;
  totalPlayers: number;
  teamImpact: {
    damageImpact: number;
    killImpact: number;
    teamDamageShare: number;
    teamKillShare: number;
    totalTeamDamage: number;
    totalTeamKills: number;
  };
  badges: any[];
  weaponStats: Record<string, any>;
  zoneStrategy: {
    edgePlayCount: number;
    fatalDelayCount: number;
  };
  goldenTimeDamage: {
    early: number;
    mid1: number;
    mid2: number;
    late: number;
  };
  killContribution: {
    solo: number;
    cleanup: number;
    assist: number;
  };
  itemUseStats: {
    heals: number,
    boosts: number,
    throwCount: number,
    lethalThrowCount: number,
    focusFireCount: number,
    crossfireExposureCount: number,
    distanceDamage: { short: number, mid: number, long: number }
  };
  wasZoneMovingAtDeath: boolean; // [V11.8] 사망 시점 자기장 상태
  isolationData: IsolationData;
  tradeStats: TradeStats;
  initiative_rate: number;
  initiativeSampleCount: number;
  duelStats: DuelStats;
  combatPressure: CombatPressure;
  eliteBenchmark: any;
  itemUseSummary: any;
  deathDistance: number;
  edgePlay?: number;
  bluezoneWaste?: number;
  benchmark?: {
    tier: string | null;
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
  isValidBenchmark: boolean; // [V26.0] 벤치마크 유효성 여부 (300초 이상 생존)
  timeline: TimelineEvent[]; // [V12.5] 경기 타임라인 데이터
  mapData?: { // [V26.0] 지도 리플레이용 데이터
    events: any[];
    zoneEvents: any[];
    teammates: string[];
    teamNames: string[];
    mapName?: string;
  };
  // [V16.0] 신규 엔터테인먼트 지표
  avgCircleLuck?: number;
  avgVehicleMastery?: number;
  weaponMatchCount?: string[];
  leadShotKills: number;
  leadShotKnocks: number;
  ridingShotKills: number;
  ridingShotKnocks: number;
  roadKills: number;
  roadKnocks: number;
  squadWeaponStats?: Record<string, any>;
}

// 텔레메트리 이벤트 처리를 위한 내부 상태 타입
export interface AnalysisState {
  lowerNickname: string;
  canonicalNickname: string; // [V55.0] UI 출력용 정식 닉네임 (DB 캐시 기반)
  myAccountId: string; // [V41.0] 고유 ID 매칭 도입
  teamNames: Set<string>;
  teamAccountIds: Set<string>; // [V41.0] 팀원 고유 ID 매칭
  eliteNames: Set<string>;
  eliteAccountIds: Set<string>; // [V41.0] 엘리트 고유 ID 매칭
  myRosterId: string;
  mode: string; // [V26.0] 텔레메트리 모드 (lite/full)
  matchStartTime: number;
  gameMode: string; // [V16] 솔로 모드 판정용
  mapName: string;   // [V26.0] 지도 리플레이용 맵 이름
  mapSize: number;   // [V26.0] 지도 스케일링용 맵 크기

  // 상황별 데이터 추적
  playerCombatData: Map<string, any>;
  victimDamage: Map<string, any>;
  myVictimDamage: Map<string, number>; // [V55.2] 내가 각 유저에게 입힌 누적 데미지
  weaponStats: Map<string, any>;
  playerLocations: Map<string, Location>;
  playerAliveStatus: Map<string, string | boolean>;
  teamMapping: Map<string, string>;
  teamAliveMembers: Map<string, Set<string>>;

  // 이벤트 큐/셋
  myAttackEvents: Set<number>;
  myDamageEvents: any[];
  totalReviveEvents: any[];
  teammateKnockEvents: number[];
  myActionTimestamps: number[];

  // 지표용 누적 변수
  totalIsolationSum: number;
  isolationSampleCount: number;
  totalMinDistSum: number;
  totalHeightDiffSum: number;
  totalNearbyTeammatesSum: number;
  lastIsolationSampleTime: number;
  dbnoIsolationSamples: number[];
  deathIsolation?: number;
  totalCombatIsolationSum: number;
  combatIsolationCount: number;
  hasLanded: boolean;
  currentPhase: number;
  deathPhaseSnapshot: number; // [BUG-FIX] 사망 순간의 페이즈를 고정 저장 (사망 후에도 currentPhase가 덮어써지는 버그 방지)

  totalTeammateKnocks: number;
  myReviveCount: number; // [V55.2] 유저 본인이 직접 부활시킨 횟수
  totalSuppCount: number;
  totalTradeKills: number;
  totalSmokeCount: number;
  totalSmokeRescues: number;
  totalBaitCount: number;
  baitCooldown: Map<string, number>; // [V16] 미끼 플레이 중복 방지용

  reactLatSum: number;
  reactCount: number;
  totalTimesHit: number;
  totalCrossfireCount: number;
  totalCoverAttempts: number;
  totalCoverSuccess: number;

  reactionLatencies: number[];
  tradeLatencies: number[];

  // [V11.2] 신규 트래커
  utilityTracker: Map<number, any>;
  utilitySummary: any;

  // [V11.3] 정밀 트레이드용 dBNO 매핑
  // key: dBNOId, value: { attackerName, victimName, ts }
  dbnoMap: Map<number, { attacker: string, victim: string, weaponId: string, ts: number, attackerName?: string, attackerAccountId?: string, time?: string }>;
  totalPressureSum: number;
  pressureSampleCount: number;
  combatPressure: {
    totalHits: number;
    uniqueVictims: Set<string>;
    maxHitDistance: number;
    utilityDamage: number;
    utilityHits: number;
    isClutched: boolean;
  };
  myDownedIntervals: Array<{ start: number, end: number | null }>;
  whiteZone: { x: number, y: number, radius: number }; // [V11.8] 공식 문서 기준 White Zone
  blueZone: { x: number, y: number, radius: number };  // [V11.8] 공식 문서 기준 Blue Zone
  isZoneMoving: boolean; // [V11.8] 가이드 2 기준 자기장 수축 여부
  wasZoneMovingAtDeath: boolean; // [V11.8] 사망 시점 자기장 상태
  zoneStrategy: { edgePlayCount: number, fatalDelayCount: number };
  bluezoneWaste: number;
  goldenTimeDamage: { early: number, mid1: number, mid2: number, late: number };
  killContribution: { 
    solo: number, 
    cleanup: number, // [설명] 타 적 스쿼드가 기절시킨 적을 내가 확킬하여 킬을 획득한 경우 (킬 스틸/어부지리) - 향후 세분화 확장용
    assist: number 
  };
  wipedTeamsByUserParticipation: Set<string>;
  teamsUserHit: Map<string, { totalDamage: number; lastHitTime: number }>;
  teamsRosterHit: Set<string>;
  myRecentDamageTaken: Map<string, number>;
  recentAttacksOnUser: any[];
  itemUseSummary: any;
  itemUseStats: {
    heals: number,
    boosts: number,
    throwCount: number,
    lethalThrowCount: number,
    focusFireCount: number,
    crossfireExposureCount: number,
    distanceDamage: { short: number, mid: number, long: number }
  };
  phaseTimeline: any[];
  myDeathTime: number | null;
  deathDistance: number;
  recentTeammateDamageTaken: Map<string, number>; // [V11.7] 미끼 플레이 추적용
  // [V16.0] 신규 전술 지표 추적
  circleLuckSum: number;
  circleLuckCount: number;
  vehicleDistance: number;
  weaponMatchCount: Set<string>; // 이 매치에서 사용된 무기 목록
  lastMyLoc?: Location; // [V16.0] 이동 거리 계산용

  lastEdgeSampleTime?: number; // [V11.9.2] 끝선 플레이 샘플링 주기 관리
  timeline: TimelineEvent[];    // [V12.5] 전술 타임라인 이벤트 저장소
  isolationData?: IsolationData; // [V14] 현재 시점의 고립 데이터 (핸들러 참조용)

  // [V26.0] 리플레이 지도 데이터 저장을 위한 신규 필드
  mapEvents: any[];
  mapZoneEvents: any[];
  lastPosByPlayer: Map<string, { x: number, y: number }>;
  lastRotByPlayer: Map<string, number>;
  groggyMap: Map<string, { attackerAccountId: string, attackerName: string }>;
  hasRealExplosions: boolean;
  positionEventCount: number;
  matchEndRelativeTime: number | null; // [V12.5] 승리 이벤트의 정확한 기록을 위한 매치 종료 상대 시간
  leadShotKills: number;
  leadShotKnocks: number;
  ridingShotKills: number;
  ridingShotKnocks: number;
  roadKills: number;
  roadKnocks: number;
  squadWeaponStats: Map<string, any>;
}
