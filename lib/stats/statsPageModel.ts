import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import type {
  PlayerStatsResponse,
  StatsBucket,
  StatsMatchFilter,
  StatsMatchClassification,
  StatsMatchModeMeta,
  StatsOverviewMetrics,
  StatsMode,
  StatsPartySize,
  StatsSeasonSummaryMetrics,
  StatsPlatform,
  StatsSectionTab,
} from "@/types/stats-page";
import { isAiOrBotMatch } from "@/lib/pubg-analysis/matchEligibility";

const PARTY_SIZES: readonly StatsPartySize[] = ["squad", "duo", "solo"];
const TDM_MAP_NAMES = new Set(["pillarcompound_main", "italy_tdm_main"]);

function normalizeMatchToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isCasualMatch(input: { matchType?: string; gameMode?: string }): boolean {
  return isAiOrBotMatch(input);
}

export function parseStatsPlatform(value?: string): StatsPlatform | null {
  return value === "steam" || value === "kakao" ? value : null;
}

export function parseStatsSectionTab(value?: string): StatsSectionTab {
  return value === "squad" ? "squad" : "overview";
}

export function normalizeStoredNames(values: readonly unknown[]): string[] {
  const names = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    names.add(value);
  }

  return [...names];
}

export function classifyMatchMode(input: StatsMatchModeMeta): StatsMatchClassification {
  const gameMode = normalizeMatchToken(input.gameMode);
  const matchType = normalizeMatchToken(input.matchType);
  const mapName = normalizeMatchToken(input.mapName);

  // AI/bot aliases take precedence over ranked/TDM markers (e.g. ranked-ai,
  // tdm-ai). Keep these rows available to ordinary detail/history views while
  // preventing them from being mislabeled as competitive or TDM.
  if (isCasualMatch(input)) return "casual";
  if (gameMode.includes("tdm") || TDM_MAP_NAMES.has(mapName)) return "tdm";
  if (
    gameMode.includes("competitive") ||
    gameMode.includes("ranked") ||
    matchType.includes("competitive") ||
    matchType.includes("ranked")
  ) {
    return "ranked";
  }
  if (!matchType || matchType === "unknown") return "unknown";
  if (matchType === "unavailable") return "unavailable";

  return "normal";
}

export function filterRenderableMatches(
  matches: readonly MatchSummaryData[],
  missingMatchIds: readonly string[] | ReadonlySet<string>,
  filter: StatsMatchFilter,
): MatchSummaryData[] {
  const missing = missingMatchIds instanceof Set ? missingMatchIds : new Set(missingMatchIds);

  return matches.filter((match) => {
    if (missing.has(match.matchId)) return false;
    if (filter === "all") return true;
    const mode = classifyMatchMode(match);
    if (filter === "normal") return mode === "normal" || mode === "casual";
    return mode === filter;
  });
}

export const buildStatsCompareUrl = (nickname: string, platform: StatsPlatform) =>
  `/stats/battle?nick1=${encodeURIComponent(nickname)}&platform1=${platform}`;

export const buildStatsWeaponsUrl = (nickname: string, platform: StatsPlatform) =>
  `/stats/${platform}/${encodeURIComponent(nickname)}/weapons`;

export function selectCanonicalRankBucket(stats: PlayerStatsResponse["stats"]): StatsBucket | null {
  return PARTY_SIZES
    .map((partySize) => stats.ranked?.[partySize])
    .find((bucket): bucket is StatsBucket => Boolean(bucket && bucket.roundsPlayed > 0)) ?? null;
}

function selectOverviewBucket(stats: PlayerStatsResponse["stats"]): {
  bucket: StatsBucket;
  partySize: StatsPartySize;
} | null {
  for (const partySize of PARTY_SIZES) {
    const bucket = stats.ranked?.[partySize];
    if (bucket && bucket.roundsPlayed > 0) return { bucket, partySize };
  }

  return null;
}

export function getStatsOverviewMetrics(player: PlayerStatsResponse): StatsOverviewMetrics {
  const selected = selectOverviewBucket(player.stats);
  if (!selected) return { kind: "empty", label: "기록 없음" };

  const { bucket, partySize } = selected;
  const deaths = bucket.deaths ?? bucket.losses ?? 0;
  const top10Rate = bucket.top10Ratio != null
    ? bucket.top10Ratio * 100
    : ((bucket.top10s ?? 0) / bucket.roundsPlayed) * 100;

  return {
    kind: "ready",
    roundsPlayed: bucket.roundsPlayed,
    kda: ((bucket.kills + bucket.assists) / (deaths || 1)).toFixed(2),
    averageDamage: (bucket.damageDealt / bucket.roundsPlayed).toFixed(0),
    top10Rate: `${top10Rate.toFixed(1)}%`,
    kills: bucket.kills,
    assists: bucket.assists,
    dbnos: bucket.dBNOs,
    averageRank: bucket.avgRank != null && bucket.avgRank > 0 ? bucket.avgRank.toFixed(1) : "—",
    preferredMode: partySize,
  };
}

function formatAverageSurvival(seconds: number | undefined, roundsPlayed: number): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0 || roundsPlayed <= 0) return "—";
  const totalSeconds = Math.max(0, Math.round(seconds / roundsPlayed));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function getCurrentSeasonSummary(
  player: PlayerStatsResponse,
  preferredPartySize?: StatsPartySize,
  preferredMode: StatsMode = "ranked",
): StatsSeasonSummaryMetrics {
  const seasonId = player.seasonId || "";
  const seasonName = player.seasons.find((season) => season.id === seasonId)?.name
    || seasonId
    || "현재 시즌";
  const selected = preferredPartySize
    ? (() => {
      const bucket = player.stats[preferredMode]?.[preferredPartySize];
      return bucket && bucket.roundsPlayed > 0
        ? { bucket, partySize: preferredPartySize }
        : null;
    })()
    : (() => {
      const buckets = player.stats[preferredMode];
      if (!buckets) return null;
      for (const partySize of PARTY_SIZES) {
        const bucket = buckets[partySize];
        if (bucket && bucket.roundsPlayed > 0) return { bucket, partySize };
      }
      return null;
    })();

  if (!selected) {
    return {
      kind: "empty",
      seasonId,
      seasonName,
      mode: preferredMode,
      partySize: preferredPartySize ?? "squad",
      label: "기록 없음",
    };
  }

  const { bucket, partySize } = selected;
  const roundsPlayed = bucket.roundsPlayed;
  const deaths = bucket.deaths ?? bucket.losses ?? 0;
  const top10s = bucket.top10s ?? Math.round((bucket.top10Ratio ?? 0) * roundsPlayed);
  const top10Rate = bucket.top10Ratio != null
    ? bucket.top10Ratio * 100
    : (top10s / roundsPlayed) * 100;
  const headshotRate = preferredMode === "ranked"
    && bucket.headshotKills === 0
    && (bucket.headshotKillRatio == null || bucket.headshotKillRatio === 0)
    ? null
    : bucket.kills > 0 && bucket.headshotKills != null
      ? (Number(bucket.headshotKills) / bucket.kills) * 100
      : bucket.headshotKillRatio != null && bucket.headshotKillRatio > 0
        ? bucket.headshotKillRatio * 100
        : null;

  return {
    kind: "ready",
    seasonId,
    seasonName,
    mode: preferredMode,
    partySize,
    tier: bucket.currentTier?.tier?.trim() || undefined,
    subTier: bucket.currentTier?.subTier,
    rankPoint: bucket.currentRankPoint,
    bestTier: bucket.bestTier?.tier?.trim() || undefined,
    bestSubTier: bucket.bestTier?.subTier,
    bestRankPoint: bucket.bestRankPoint,
    roundsPlayed,
    wins: bucket.wins,
    winRate: `${((bucket.wins / roundsPlayed) * 100).toFixed(1)}%`,
    top10s,
    top10Rate: `${top10Rate.toFixed(1)}%`,
    kda: ((bucket.kills + bucket.assists) / (deaths || 1)).toFixed(2),
    averageDamage: (bucket.damageDealt / roundsPlayed).toFixed(0),
    averageSurvival: formatAverageSurvival(
      bucket.timeSurvived != null && bucket.timeSurvived > 0
        ? bucket.timeSurvived
        : bucket.avgSurvivalTime != null && bucket.avgSurvivalTime > 0
          ? bucket.avgSurvivalTime * roundsPlayed
          : undefined,
      roundsPlayed,
    ),
    headshotRate: headshotRate == null ? "—" : `${headshotRate.toFixed(1)}%`,
    kills: bucket.kills,
    assists: bucket.assists,
    dbnos: bucket.dBNOs,
    averageRank: bucket.avgRank != null && bucket.avgRank > 0 ? bucket.avgRank.toFixed(1) : "—",
  };
}
