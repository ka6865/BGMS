export type StatsPlatform = "steam" | "kakao";
export type StatsSectionTab = "overview" | "squad";
export type StatsMode = "ranked" | "normal";
export type StatsPartySize = "solo" | "duo" | "squad";
export type StatsMatchFilter = "all" | "normal" | "ranked" | "casual" | "tdm";
export type StatsMatchClassification = Exclude<StatsMatchFilter, "all"> | "unknown" | "unavailable";
export type StatsPageStatus = "idle" | "loading" | "ready" | "refreshing" | "partial" | "error";
export type StatsHistoryStatus = "idle" | "loading" | "ready" | "error";
export type StatsPartialReason =
  | "summary_batch_failed"
  | "summary_missing"
  | "detail_failed"
  | "analysis_failed"
  | "stats_stale"
  | "stats_unavailable";
export type StatsErrorType = "not_found" | "rate_limit" | "server" | "private";
export type StatsAvailabilityStatus = "ready" | "stale" | "unavailable";

export interface StatsModeAvailability {
  status: StatsAvailabilityStatus;
  updatedAt?: string;
}

export interface StatsMatchModeMeta {
  gameMode?: string;
  matchType?: string;
  mapName?: string;
}

export interface StatsBucket {
  roundsPlayed: number;
  kills: number;
  assists: number;
  deaths?: number;
  losses?: number;
  wins: number;
  avgRank?: number;
  bestTier?: { tier?: string; subTier?: string | number };
  bestRankPoint?: number;
  top10s?: number;
  top10Ratio?: number;
  damageDealt: number;
  dBNOs: number;
  timeSurvived?: number;
  avgSurvivalTime?: number;
  headshotKills?: number;
  headshotKillRatio?: number;
  roundMostKills?: number;
  currentTier?: { tier?: string; subTier?: string | number };
  currentRankPoint?: number;
}

export interface StatsSurvivalMastery {
  xp?: number;
  tier?: number;
  level: number;
  totalMatchesPlayed?: number;
}

export interface PlayerStatsResponse {
  nickname: string;
  platform: StatsPlatform;
  seasonId: string;
  seasons: readonly { id: string; name: string }[];
  stats: {
    ranked?: Partial<Record<StatsPartySize, StatsBucket | null>> | null;
    normal?: Partial<Record<StatsPartySize, StatsBucket | null>> | null;
  };
  recentMatches: readonly string[];
  matchModes?: Record<string, string>;
  clan?: { id: string; name: string; tag: string; level: number; memberCount: number } | null;
  survivalMastery?: StatsSurvivalMastery | null;
  weaponMastery?: readonly unknown[];
  banType?: string | null;
  updatedAt?: string;
  statsAvailability?: Partial<Record<StatsMode, StatsModeAvailability>>;
  retryAfterSeconds?: number;
}

export type StatsOverviewMetrics =
  | { kind: "empty"; label: "기록 없음"; availability?: StatsModeAvailability }
  | {
      kind: "unavailable";
      label: "조회 불가";
      message: string;
      availability: StatsModeAvailability;
    }
  | {
      kind: "ready";
      roundsPlayed: number;
      kda: string;
      averageDamage: string;
      top10Rate: string;
      kills: number;
      assists: number;
      dbnos: number;
      averageRank: string;
      preferredMode: StatsPartySize;
      availability?: StatsModeAvailability;
    };

export type StatsSeasonSummaryMetrics =
  | {
      kind: "empty";
      seasonId: string;
      seasonName: string;
      mode: StatsMode;
      partySize: StatsPartySize;
      label: "기록 없음";
      availability?: StatsModeAvailability;
    }
  | {
      kind: "unavailable";
      seasonId: string;
      seasonName: string;
      mode: StatsMode;
      partySize: StatsPartySize;
      label: "조회 불가";
      message: string;
      availability: StatsModeAvailability;
    }
  | {
      kind: "ready";
      seasonId: string;
      seasonName: string;
      mode: StatsMode;
      partySize: StatsPartySize;
      tier?: string;
      subTier?: string | number;
      rankPoint?: number;
      bestTier?: string;
      bestSubTier?: string | number;
      bestRankPoint?: number;
      roundsPlayed: number;
      wins: number;
      winRate: string;
      top10s: number;
      top10Rate: string;
      kda: string;
      averageDamage: string;
      averageSurvival: string;
      headshotRate: string;
      kills: number;
      assists: number;
      dbnos: number;
      averageRank: string;
      availability?: StatsModeAvailability;
    };
