/** Official participant records survive a tactical calculation upgrade.
 * Call only after validating the canonical match/player/platform and population.
 * An allowlist prevents old scores, processed damage, scenes or AI prose leaking
 * into a basic response, including through nested participant objects.
 */
export function buildCalculationPendingMatch(result: Record<string, any>) {
  const officialStats = (source: Record<string, any>) => {
    const stats: Record<string, unknown> = {};
    for (const key of ["name", "deathType"] as const) {
      if (typeof source[key] === "string") stats[key] = source[key];
    }
    for (const key of ["winPlace", "kills", "assists", "damageDealt", "timeSurvived",
      "DBNOs", "headshotKills", "longestKill", "heals", "boosts", "walkDistance",
      "rideDistance", "swimDistance", "revives"] as const) {
      const value = source[key];
      stats[key] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    }
    return stats;
  };
  const metadata: Record<string, unknown> = {};
  for (const key of ["matchId", "player_id", "platform", "mapName", "mapId", "createdAt", "gameMode", "matchType"] as const) {
    if (typeof result[key] === "string") metadata[key] = result[key];
  }
  return {
    ...metadata,
    analysisAvailability: "basic_only" as const,
    analysisUnavailableReason: "calculation_upgrade_required" as const,
    stats: officialStats(result.stats ?? {}),
    team: Array.isArray(result.team) ? result.team.filter((member: unknown) => member && typeof member === "object" && !Array.isArray(member)).map(officialStats) : [],
    // Deliberately omit schema/population/calculation markers: this is not a
    // canonical fullResult and must not become an AI-summary fallback input.
  };
}
