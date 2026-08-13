import type { MatchData } from "@/types/stat";

const EMPTY_STATS = {
  winPlace: 0,
  kills: 0,
  assists: 0,
  damageDealt: 0,
  timeSurvived: 0,
  DBNOs: 0,
  headshotKills: 0,
  longestKill: 0,
  heals: 0,
  boosts: 0,
  deathType: "",
  walkDistance: 0,
  rideDistance: 0,
  swimDistance: 0,
  revives: 0,
  name: "",
  playerId: ""
};

export type MatchSummaryData = MatchData & {
  isSummary?: boolean;
  summarySource?: "processed_match_telemetry" | "pubg_player_matches";
};


export function buildBasicMatchSummary(row: {
  match_id: string;
  player_id: string;
  platform: string;
  played_at?: string | null;
  created_at?: string | null;
  game_mode?: string;
  map_name?: string;
  kills?: number;
  damage?: number;
  win_place?: number;
  match_type?: string;
}): MatchSummaryData {
  const kills = row.kills ?? 0;
  const damage = Math.floor(row.damage ?? 0);
  const winPlace = row.win_place ?? 99;

  return {
    matchId: row.match_id,
    stats: {
      ...EMPTY_STATS,
      winPlace,
      kills,
      damageDealt: damage,
      playerId: row.player_id,
    },
    mapName: row.map_name || "Baltic_Main",
    mapId: row.map_name || "Baltic_Main",
    createdAt: row.played_at ?? row.created_at ?? new Date().toISOString(),
    gameMode: row.game_mode || "squad",
    matchType: row.match_type || "unknown",
    totalTeams: 0,
    totalPlayers: 0,
    team: [],
    totalTeamKills: kills,
    totalTeamDamage: damage,
    killDetails: [],
    dbnoDetails: [],
    badges: [],
    tacticalTimeline: [],
    v: 1,
    isSummary: true,
    summarySource: "pubg_player_matches",
  };
}

export function buildMatchSummary(fullResult: any): MatchSummaryData | null {
  if (!fullResult) return null;

  const stats = {
    ...EMPTY_STATS,
    ...(fullResult.stats || {})
  };

  return {
    matchId: fullResult.matchId || fullResult.match_id || "",
    stats,
    mapName: fullResult.mapName || fullResult.matchInfo?.mapId || fullResult.matchInfo?.map || "",
    mapId: fullResult.mapId || fullResult.matchInfo?.mapId || "",
    createdAt: fullResult.createdAt || fullResult.matchInfo?.date || "",
    gameMode: fullResult.gameMode || fullResult.matchInfo?.mode || "",
    matchType: fullResult.matchType || fullResult.matchInfo?.matchType,
    totalTeams: fullResult.totalTeams,
    totalPlayers: fullResult.totalPlayers,
    team: fullResult.team || [],
    totalTeamKills: fullResult.totalTeamKills || 0,
    totalTeamDamage: fullResult.totalTeamDamage || 0,
    killDetails: [],
    dbnoDetails: [],
    teamImpact: fullResult.teamImpact,
    badges: fullResult.badges || [],
    myRank: fullResult.myRank,
    teamWipeOccurred: fullResult.teamWipeOccurred,
    combatPressure: fullResult.combatPressure,
    tradeStats: fullResult.tradeStats,
    isolationData: fullResult.isolationData,
    initiativeStats: fullResult.initiativeStats,
    eliteBenchmark: fullResult.eliteBenchmark,
    tacticalTimeline: [],
    goldenTimeDamage: fullResult.goldenTimeDamage,
    initiative_rate: fullResult.initiative_rate,
    initiativeSampleCount: fullResult.initiativeSampleCount,
    deathPhase: fullResult.deathPhase,
    edgePlay: fullResult.edgePlay,
    bluezoneWaste: fullResult.bluezoneWaste,
    v: fullResult.v || 0,
    benchmark: fullResult.benchmark,
    isValidBenchmark: fullResult.isValidBenchmark,
    matchInfo: fullResult.matchInfo,
    itemUseSummary: fullResult.itemUseSummary,
    itemUseStats: fullResult.itemUseStats,
    duelStats: fullResult.duelStats,
    leadShotKills: fullResult.leadShotKills,
    leadShotKnocks: fullResult.leadShotKnocks,
    ridingShotKills: fullResult.ridingShotKills,
    ridingShotKnocks: fullResult.ridingShotKnocks,
    roadKills: fullResult.roadKills,
    roadKnocks: fullResult.roadKnocks,
    isSummary: true,
    summarySource: "processed_match_telemetry"
  };
}
