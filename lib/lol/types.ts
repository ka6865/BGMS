import type { LolChallenges } from "./challenges";
import type { LolMatchInsights, LolRecentTrends } from "./insights";
import type { LolChallengeProfile } from "./challengeProfile";

export type LolParticipantIdentity = { playerKey?: string; ref?: string };

export type LolRankedPoint = { recordedAt: string; tier: string; rank: string; lp: number };
export type LolRankedDailyPoint = LolRankedPoint & {
  date: string; wins: number; losses: number; isBaseline: boolean;
};
export type LolRankedHistory = Record<"RANKED_SOLO_5x5" | "RANKED_FLEX_SR", {
  points: LolRankedDailyPoint[];
  highest: LolRankedPoint | null;
  trackingSince: string | null;
}>;


export type LolRecentMatch = {
  insights?: LolMatchInsights;
  dataDragonVersion?: string;
  matchId: string;
  queueId: number;
  gameMode: string;
  gameEndTimestamp: number;
  gameDuration: number | null;
  win: boolean | null;
  championName: string;
  championId: number;
  championImageId: string;
  championNameKo: string;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  cs: number | null;
  goldEarned: number | null;
  wardsPlaced: number | null;
  wardsKilled: number | null;
  detectorWardsPlaced: number | null;
  damageDealtToObjectives: number | null;
  damageDealtToTurrets: number | null;
  killParticipationPct: number | null;
  csPerMinute: number | null;
  goldPerMinute: number | null;
  teamPosition: "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | "미분류";
  details?: Omit<
    LolMatchDetails,
    "matchId" | "queueId" | "gameMode" | "gameDuration"
  >;
  teammates?: Array<LolParticipantIdentity & { riotId: string; win: boolean | null }>;
  remake: boolean;
};

export type LolMatchFailure = { matchId: string; kind: string; retryAfterSeconds?: number };

export type LolQueueSummary = {
  queue: "all" | "solo" | "flex" | "aram";
  sampleSize: number;
  validSampleSize: number;
  excludedCount: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  averageKills: number | null;
  averageDeaths: number | null;
  averageAssists: number | null;
  killsSampleSize: number;
  deathsSampleSize: number;
  assistsSampleSize: number;
  averageKillParticipationPct: number | null;
  killParticipationSampleSize: number;
  averageKda: number | null;
  perfect: boolean;
  perfectCount: number;
  positions: Record<LolRecentMatch["teamPosition"], number>;
  teammates: Array<LolParticipantIdentity & {
    riotId: string;
    games: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
  }>;
  champions: Array<{
    championId: number;
    championImageId: string;
    championName: string;
    games: number;
    wins: number;
    winRatePct: number | null;
    averageKda: number | null;
    perfect: boolean;
  }>;
};

export type LolMatchDetails = {
  dataDragonVersion?: string;
  matchId: string;
  queueId: number;
  gameMode: string;
  gameDuration: number | null;
  teams: Array<{
    teamId: number;
    win: boolean;
    totalKills: number | null;
    totalGold: number | null;
    objectives: Record<
      "tower" | "dragon" | "baron" | "riftHerald" | "horde" | "inhibitor",
      { kills: number | null; first: boolean | null }
    >;
    participants: Array<LolParticipantIdentity & {
      riotId: string;
      championId: number;
      championImageId: string;
      championName: string;
      championNameKo: string;
      win: boolean;
      championLevel: number | null;
      spells: Array<{ id: number; name: string; image: string } | null>;
      runes: {
        keystone: { id: number; name: string; image: string } | null;
        primaryStyle: { id: number; name: string; image: string } | null;
        subStyle: { id: number; name: string; image: string } | null;
      };
      kills: number | null;
      deaths: number | null;
      assists: number | null;
      items: Array<{ id: number; name: string }>;
      damageToChampions: number | null;
      damageTaken: number | null;
      cs: number | null;
      visionScore: number | null;
      goldEarned: number | null;
      wardsPlaced: number | null;
      wardsKilled: number | null;
      detectorWardsPlaced: number | null;
      damageDealtToObjectives: number | null;
      damageDealtToTurrets: number | null;
      killParticipationPct: number | null;
    }>;
  }>;
};

export type LolSearchResult = {
  challengeProfile?: LolChallengeProfile;
  recentTrends?: LolRecentTrends;
  mastery?: LolMasteryComparison;
  dataDragonVersion?: string;
  account: { gameName: string; tagLine: string };
  profile: { profileIconId: number; summonerLevel: number };
  ranked: Array<{
    queueType: "RANKED_SOLO_5x5" | "RANKED_FLEX_SR";
    tier: string;
    rank: string;
    leaguePoints: number;
    wins: number;
    losses: number;
  }>;
  rankedHistory: LolRankedHistory;
  matches: LolRecentMatch[];
  matchIds: string[];
  loadedCount: number;
  hasMore: boolean;
  matchFailures: LolMatchFailure[];
  lastUpdatedAt: string;
  refreshRemainSeconds: number;
  summaries: Record<LolQueueSummary["queue"], LolQueueSummary>;
  matchStatus: "ready" | "empty" | "partial" | "failed";
};

export type LolRefreshCooldown = { status: "cooldown"; remainSeconds: number; lastUpdatedAt: string };

export type LolCleanupCounts = { cache_rows: number; match_rows: number; account_rows: number; lease_rows: number; public_rate_limit_rows?: number };
export type LolCleanupBatch = { deleted: LolCleanupCounts; remaining: LolCleanupCounts };
export type LolOpsStatus = {
  enabled: boolean;
  today: string;
  todayRiotCalls: number;
  cooldownActive: boolean;
  keyNeedsAttention: boolean;
  metrics: Array<{ day: string; metric: string; value: number }>;
  rateLimits: Array<{ host: string; budgetDay: string; usedCount: number; blockedUntil: string | null }>;
  tables: Array<{ table: string; rows: number; totalBytes: number }>;
  pending: LolCleanupCounts;
  benchmarks?: { processed: number; skipped: number };
};


export type LolPlayerMatchSummary = {
  challenges: LolChallenges;
  puuid: string; match_id: string; platform_id: string; queue_id: number; game_mode: string | null;
  played_at: string; duration_seconds: number | null; game_version: string | null;
  champion_id: number | null; champion_name: string | null; team_id: number | null; team_position: string | null;
  win: boolean | null; remake: boolean | null; kills: number | null; deaths: number | null; assists: number | null;
  cs: number | null; gold_earned: number | null; damage_to_champions: number | null; damage_taken: number | null;
  vision_score: number | null; wards_placed: number | null; wards_killed: number | null; detector_wards_placed: number | null;
  damage_to_objectives: number | null; damage_to_turrets: number | null; team_kills: number | null; champion_level: number | null;
  items: Array<number | null>; summoner_spells: Array<number | null>;
  perks: { keystone: number | null; primaryStyle: number | null; subStyle: number | null };
  teammates: Array<{ puuid?: string; riotId: string; win: boolean | null }>; created_at: string;
};
export type LolChampionMastery = {
  championId: number; championLevel: number; championPoints: number; lastPlayTime: number;
  championPointsUntilNextLevel: number | null; championSeasonMilestone: number | null;
};
export type LolChampionPerformance = {
  championId: number; championName: string; championImageId: string; games: number; wins: number;
  winRatePct: number; kda: number | null; perfect: boolean;
};
export type LolMasteryComparison = {
  status: "ready" | "failed";
  champions: Array<LolChampionMastery & { championName: string; championImageId: string }>;
  recent: { status: "ready" | "unavailable"; sampleSize: number; champions: LolChampionPerformance[] };
};
export type LolAccountDeletion = {
  account_rows: number; ranked_rows: number; history_rows: number; summary_rows: number;
  teammate_rows: number; participant_rows: number; match_rows: number; cache_rows: number; lease_rows: number;
};

export type LolCollectionResult = {
  requested: number; fetched: number; reused: number; failed: number; aggregated: number; skipped: number;
  processed: number; nextOffset: number; hasMore: boolean; durationMs: number; retryAfter?: number;
  stopped?: "rate_limited" | "busy" | "key_or_permission" | "unconfigured";
};
