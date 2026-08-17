import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import type {
  PlayerStatsResponse,
  StatsBucket,
  StatsMatchFilter,
  StatsMatchClassification,
  StatsMatchModeMeta,
  StatsOverviewMetrics,
  StatsPartySize,
  StatsPlatform,
  StatsSectionTab,
} from "@/types/stats-page";

const PARTY_SIZES: readonly StatsPartySize[] = ["squad", "duo", "solo"];
const TDM_MAP_NAMES = new Set(["PillarCompound_Main", "Italy_TDM_Main"]);

export function isCasualMatch(input: { matchType?: string; gameMode?: string }): boolean {
  const matchType = (input.matchType || "").toLowerCase();
  const gameMode = (input.gameMode || "").toLowerCase();
  return (
    matchType.includes("airoyale") ||
    matchType.includes("ai-match") ||
    matchType.includes("aimatch") ||
    gameMode.includes("airoyale") ||
    gameMode.includes("ai-match") ||
    gameMode.includes("ai_match") ||
    gameMode.includes("-ai")
  );
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
  const gameMode = input.gameMode?.toLowerCase() ?? "";
  const matchType = input.matchType?.toLowerCase() ?? "";

  if (gameMode.includes("tdm") || TDM_MAP_NAMES.has(input.mapName ?? "")) return "tdm";
  if (
    gameMode.includes("competitive") ||
    gameMode.includes("ranked") ||
    matchType.includes("competitive") ||
    matchType.includes("ranked")
  ) {
    return "ranked";
  }
  if (isCasualMatch(input)) return "casual";
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
    preferredMode: partySize,
  };
}
