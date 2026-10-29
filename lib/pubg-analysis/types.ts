import type { FirstReplyEvidence } from "./firstReply";
import type { SquadObservation } from './squadObservations';
import type { SquadFocusFireObservation } from "./squadFocusFire";
import type { MatchReport } from "./matchReport";
/**
 * PUBG 전술 분석 엔진 공용 타입 정의
 */

import type { ObservedBenchmark } from "./benchmarkAdapter";

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
  hitCount: number | null;
  accuracyStatus?: "observed" | "missing" | "no_opportunity";
  damageEventCount?: number;
  throwCount: number;
  lethalThrowCount?: number;
  totalDamage: number | null;
  killCount: number;
  /** Null means no lethal-throw denominator was observed. */
  accuracy: number | null;
  accuracyRaw?: number | null;
  avgDamagePerThrow: number | null;

  fragHits?: number;
  molotovHits?: number;
}

export interface CombatPressure {
  pressureScore: number | null;
  /** Null means no player-action denominator was observed. */
  pressureIndex: number | null;
  utilityStats: UtilityStats;
  isClutched: boolean;
  utilityDamage?: number | null;
  utilityHits?: number;
  totalHits?: number;
  maxHitDist?: number;
  /** [계산 5 기록] 서 있는 적에게 준 유효 무기 피해만으로 잰 최대 명중 거리(m). */
  maxHitDistUpright?: number;
  uniqueVictims?: string[];
}

export interface IsolationData {
  /** Undefined means no valid position sample was observed; numeric zero is measured. */
  isolationIndex?: number;
  combatIsolation?: number;
  deathIsolation?: number;
  minDist?: number;
  heightDiff?: number;
  isCrossfire: boolean | null;
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
  /** Null means no observed trade-latency sample was available. */
  tradeLatencyMs: number | null;
  /** Null means no observed counter/reaction-latency sample was available. */
  counterLatencyMs: number | null;
  reactionLatencyMs: number | null;
  /** Percent (0–100); null means no observed cover attempts. */
  coverRate: number | null;
  coverRateSampleCount: number;
  /** 계산 5부터는 내 개인 기여(서 있는 적 피해·기절·처치·확킬·기절 유발)가 있는 적 roster 전멸 수다. */
  enemyTeamWipes: number;
  tradeRate?: number | null;
  suppRate?: number | null;
  /** Teammate-credited enemy kills: denominator of support contribution share. */
  teammateKills?: number;
  /** [계산 5 기록] 기존 규칙(팀원 타격 또는 내 마지막 처치)으로 센 전멸 roster 수. 점수에는 쓰지 않는다. */
  teamParticipationWipes?: number;
  /** [계산 5 기록] 내 기여로 인정된 전멸 roster마다 한 건. */
  wipeEvidence?: WipeEvidence[];
  /** [계산 5 기록] 팀원 기절 사건이 열린 동안 내가 한 번이라도 서 있던 사건 수(팀원 자가 소생 사건 제외). */
  rescueOpportunityCount?: number;
  /** [계산 5 기록] 구조 기회 중 소생으로 끝났고 소생자가 나이거나 내 연막이 붙은 사건 수. */
  rescueCount?: number;
  /** [계산 5 기록] 구조 기회 중 내가 소생했고 내 연막도 붙은 사건 수. */
  reviveWithOwnSmokeCount?: number;
  /** [계산 5 기록] 내가 나를 소생한 횟수. revCount에서 제외된다. */
  selfReviveCount?: number;
  /** [계산 5 기록] 팀원이 스스로 소생한 횟수. 연막 구출·구조 기회에서 제외된다. */
  teammateSelfReviveCount?: number;
}

export type WipeContributionKind = "damage" | "knock" | "kill" | "finisher" | "dbnoMaker";

export interface WipeEvidence {
  /** roster 참가자 수(봇 포함). */
  rosterSize: number;
  /** 마지막 구성원 사망 시각(경기 시작 기준 ms). */
  wipedAtMs: number;
  /** 그 전멸 회차에서 내 마지막 기여 시각(경기 시작 기준 ms). */
  lastMyContributionMs: number;
  kinds: WipeContributionKind[];
  /** roster 안의 봇(ai.) 참가자 수. */
  botMembers: number;
}

export interface TeamContext {
  /** 내 roster 참가자 수. roster를 찾지 못하면 null. */
  myRosterSize: number | null;
  /** 내 마지막 사망 순간 사망하지 않은(기절 포함) 팀원 수. 사망하지 않았으면 null. */
  aliveTeammatesAtMyDeath: number | null;
}

/** 팀원(또는 나) 기절 한 건. victim + 생명 번호 + 기절 사건으로 식별한다. */
export interface RescueEpisode {
  key: string;
  victimId: string;
  victimName: string;
  life: number;
  knockTs: number;
  /** 기절 피해자가 나 자신인 사건. 구조 지표에서는 제외하고 소생 중복 제거에만 쓴다. */
  isMine: boolean;
  outcome: "revived" | "died" | "closed" | null;
  revivedByMe: boolean;
  selfRevive: boolean;
  mySmoke: boolean;
  /** 사건이 열린 동안 내가 서 있던(살아 있고 기절 아님) 순간이 관측됐는지. */
  myStandingObserved: boolean;
}

export interface WipeRound {
  /** 기여 종류별 마지막 기여 시각(경기 시작 기준 ms). */
  kinds: Map<WipeContributionKind, number>;
  lastMyContributionMs: number | null;
  wipedAtMs: number | null;
}

export interface DuelStats {
  totalDuels: number;
  wins: number;
  losses: number;
  reversals: number;
  reversalAttempts: number;
  reversalRate: number | null;
  duelWinRate: number | null;
  /** [계산 5 기록] 적 선타 세션마다 첫 반격 1회만 보고, 첫 피격 후 3초 안에 반격한 세션 수. */
  firstReplyWithin3sCount?: number;
  /** [계산 5 기록] firstReplyWithin3sCount에 들어간 세션의 첫 피격→첫 반격 지연 합(ms). */
  firstReplyLatencySumMs?: number;
  firstReplyEvidence?: FirstReplyEvidence;
}

export interface AnalysisResult {
  calculationVersion?: number;
  /** Same-target gun participation; never substitutes for calibrated cover scores. */
  squadFocusFire?: SquadFocusFireObservation;
  squadObservation?: SquadObservation;
  /** 경기 흐름·경기 전체 섹션 판정. 이 필드가 생기기 전 분석 결과에는 없다. */
  matchReport?: MatchReport;
  matchId: string;
  v: number;
  populationEvidenceVersion?: number;
  processedAt: string;
  createdAt: string;
  stats: PlayerStats;
  team: PlayerStats[];
  deathPhase: number | null;
  mapName: string;
  gameMode: string;
  matchType: string;
  /** Preserved PUBG metadata evidence used by population eligibility gates. */
  attributes?: Record<string, unknown>;
  telemetryFlags?: Record<string, unknown>;
  totalTeams: number;
  totalPlayers: number;
  /** 참가자 중 봇(AI) 수. 이 필드가 생기기 전 분석 결과에는 없다. */
  botCount?: number;
  teamImpact: {
    damageImpact: number | null;
    killImpact: number | null;
    teamDamageShare: number | null;
    teamKillShare: number | null;
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
    distanceDamage: { short: number, mid: number, long: number },
    /** [계산 5 기록] 서 있는 적에게 준 유효 무기 피해만 거리 구간별로 합산한다. */
    distanceDamageUpright?: { short: number, mid: number, long: number }
  };
  wasZoneMovingAtDeath: boolean; // [V11.8] 사망 시점 자기장 상태
  isolationData: IsolationData;
  tradeStats: TradeStats;
  /** [계산 5 기록] 내 팀 인원 맥락. 이 필드가 생기기 전 분석 결과에는 없다. */
  teamContext?: TeamContext;
  initiative_rate: number | null;
  initiativeSampleCount: number;
  duelStats: DuelStats;
  combatPressure: CombatPressure;
  eliteBenchmark: ObservedBenchmark | null;
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
  avgCircleLuck?: number | null;
  avgVehicleMastery?: number | null;
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
  utilityThrowEvidence: { throws: Set<string>; hits: Set<string>; missing: boolean };
  supportTeammateKills: number;
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
    /** [계산 5 기록] 서 있는 적 대상 유효 무기 피해만의 최대 거리(m). */
    maxHitDistanceUpright: number;
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
    distanceDamage: { short: number, mid: number, long: number },
    distanceDamageUpright: { short: number, mid: number, long: number }
  };
  phaseTimeline: any[];
  myDeathTime: number | null;
  deathDistance: number;
  recentTeammateDamageTaken: Map<string, number>; // [V11.7] 미끼 플레이 추적용
  // [V16.0] 신규 전술 지표 추적
  circleLuckSum: number;
  circleLuckCount: number;
  vehicleDistance: number;
  vehicleSampleCount: number;
  weaponMatchCount: Set<string>; // 이 매치에서 사용된 무기 목록
  lastMyLoc?: Location; // [V16.0] 이동 거리 계산용

  lastEdgeSampleTime?: number; // [V11.9.2] 끝선 플레이 샘플링 주기 관리
  timeline: TimelineEvent[];    // [V12.5] 전술 타임라인 이벤트 저장소
  isolationData?: IsolationData; // [V14] 현재 시점의 고립 데이터 (핸들러 참조용)

  // [V26.0] 리플레이 지도 데이터 저장을 위한 신규 필드
  mapEvents: any[];
  mapZoneEvents: any[];
  lastPosByPlayer: Map<string, { x: number, y: number }>;
  groggyMap: Map<string, { attackerAccountId: string, attackerName: string }>;
  positionEventCount: number;
  matchEndRelativeTime: number | null; // [V12.5] 승리 이벤트의 정확한 기록을 위한 매치 종료 상대 시간
  leadShotKills: number;
  leadShotKnocks: number;
  ridingShotKills: number;
  ridingShotKnocks: number;
  roadKills: number;
  roadKnocks: number;
  squadWeaponStats: Map<string, any>;

  // [계산 5] 생명 번호·구조 사건·전멸 기여 장부
  /** 정규화 이름 → accountId. 핸들러들이 같은 사람을 같은 키로 보도록 공유한다. */
  actorIdsByName: Map<string, string>;
  /** accountId → 정규화 이름. */
  actorNamesById: Map<string, string>;
  /** 사람 키(accountId 우선) → 생명 번호. 사망 뒤 재투입 완료마다 1 증가한다. */
  actorLives: Map<string, number>;
  rescueEpisodes: Map<string, RescueEpisode>;
  latestRescueEpisodeByVictim: Map<string, string>;
  /** 기절 사건 없이 들어온 소생의 중복 제거 키. */
  reviveFallbackKeys: Set<string>;
  selfReviveCount: number;
  teammateSelfReviveCount: number;
  rosterSizes: Map<string, number>;
  rosterBotCounts: Map<string, number>;
  /** 적 roster별 현재 전멸 회차의 내 기여. */
  wipeRounds: Map<string, WipeRound>;
  /** 전원 사망 상태인 roster. 이후 구성원이 복귀하면 새 회차로 본다. */
  wipedRostersAwaitingReturn: Set<string>;
  /** 기존 규칙(팀원 타격 또는 내 마지막 처치)으로 센 전멸 roster. 기록 전용. */
  teamParticipationWipes: Set<string>;
  wipeEvidence: WipeEvidence[];
  myRosterSize: number | null;
  aliveTeammatesAtMyDeath: number | null;
  firstReplyWithin3sCount: number;
  firstReplyLatencySumMs: number;
}
