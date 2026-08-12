import { WEAPON_NAMES } from "./constants";
import { categorizeWeapon } from "./weaponMetaBurst";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName } from "./utils";

export type PubgPlatform = "steam" | "kakao";
export type AnalysisSource = "user" | "scraper";
export type PersistenceTaskName = "match_stats_raw" | "pubg_player_cache" | "global_benchmarks" | "pubg_player_matches";

type JsonObject = Record<string, unknown>;

export interface PersistedParticipantStats extends JsonObject {
  name: string;
  playerId?: string;
  damageDealt: number;
  kills: number;
  winPlace: number;
}

export interface PersistedRawParticipant extends JsonObject {
  id?: string;
  attributes: JsonObject & { stats: PersistedParticipantStats };
}

export interface PersistedMatchAttributes extends JsonObject {
  gameMode?: string;
  mapName?: string;
}

export interface PersistedFinalResult extends JsonObject {
  matchType: string;
  gameMode: string;
  isValidBenchmark: boolean;
  stats: JsonObject & {
    damageDealt?: number;
    kills?: number;
    winPlace?: number;
    timeSurvived?: number;
  };
  mapName?: string;
  tradeStats?: JsonObject & {
    teammateKnocks?: number;
    counterLatencyMs?: number;
    revCount?: number;
    smokeRescues?: number;
    tradeKills?: number;
    tradeLatencyMs?: number;
    suppCount?: number;
    enemyTeamWipes?: number;
  };
  killContribution?: JsonObject & {
    solo?: number;
    assist?: number;
    cleanup?: number;
  };
  initiative_rate?: number;
  isolationData?: JsonObject & {
    isCrossfire?: boolean;
    isolationIndex?: number;
    minDist?: number;
    heightDiff?: number;
  };
  combatPressure?: JsonObject & {
    pressureIndex?: number;
    utilityStats?: JsonObject & { throwCount?: number };
  };
  itemUseSummary?: JsonObject & { smokes?: number; frags?: number };
  deathDistance?: number;
  duelStats?: JsonObject & { reversalRate?: number; duelWinRate?: number };
  itemUseStats?: JsonObject & { lethalThrowCount?: number };
  benchmark?: JsonObject & {
    tier?: string | null;
    score?: number;
    breakdown?: JsonObject & {
      combat?: number;
      tactical?: number;
      survival?: number;
    };
  };
  deathPhase?: number;
}

export interface PersistMatchAnalysisInput {
  matchId: string;
  playerNickname: string;
  platform: PubgPlatform;
  finalResult: PersistedFinalResult;
  matchAttr?: PersistedMatchAttributes;
  rawParticipants?: PersistedRawParticipant[];
  source: AnalysisSource;
  forceBenchmark: boolean;
}

export interface PersistenceFailure {
  taskName: PersistenceTaskName;
  message: string;
}

export interface PersistMatchAnalysisResult {
  succeeded: PersistenceTaskName[];
  failures: PersistenceFailure[];
}

function safeNumber(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function safeInteger(value: unknown, fallback = 0): number {
  return Math.round(safeNumber(value, fallback));
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

async function runPersistenceTask(
  taskName: PersistenceTaskName,
  result: PersistMatchAnalysisResult,
  task: () => PromiseLike<{ error: unknown }>,
): Promise<boolean> {
  try {
    const { error } = await task();
    if (error) {
      result.failures.push({ taskName, message: errorMessage(error) });
      return false;
    }
    return true;
  } catch (error) {
    result.failures.push({ taskName, message: errorMessage(error) });
    return false;
  }
}

async function persistRawStats(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
  result: PersistMatchAnalysisResult,
): Promise<void> {
  const participants = input.rawParticipants;
  if (!participants || participants.length === 0 || !input.matchAttr) return;

  const analysisPlayerId = normalizeName(input.playerNickname);
  const rows = participants
    .filter((participant) => !participant.attributes.stats.playerId?.startsWith("ai."))
    .map((participant) => ({
      participant,
      playerId: normalizeName(participant.attributes.stats.name),
    }))
    .filter(({ participant, playerId }) => (
      playerId === analysisPlayerId || participant.attributes.stats.winPlace === 1
    ))
    .map(({ participant, playerId }) => ({
      match_id: input.matchId,
      platform: input.platform,
      player_id: playerId,
      damage: Math.floor(participant.attributes.stats.damageDealt),
      kills: participant.attributes.stats.kills,
      win_place: participant.attributes.stats.winPlace,
      game_mode: input.matchAttr?.gameMode,
      map_name: input.matchAttr?.mapName,
      is_analysis_sample: playerId === analysisPlayerId,
    }));
  if (rows.length === 0) return;
  const succeeded = await runPersistenceTask("match_stats_raw", result, () => (
    supabase.from("match_stats_raw").upsert(rows, {
      onConflict: "match_id,platform,player_id",
    })
  ));
  if (succeeded) result.succeeded.push("match_stats_raw");
}

async function persistPlayerCache(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
  result: PersistMatchAnalysisResult,
): Promise<void> {
  const participants = input.rawParticipants;
  if (!participants || participants.length === 0 || !input.matchAttr) return;

  const analysisPlayerId = normalizeName(input.playerNickname);
  const rows = participants
    .filter((participant) => (
      !participant.attributes.stats.playerId?.startsWith("ai.")
      && normalizeName(participant.attributes.stats.name) === analysisPlayerId
    ))
    .slice(0, 1)
    .map((participant) => ({
      id: participant.attributes.stats.playerId || participant.id,
      platform: input.platform,
      nickname: participant.attributes.stats.name,
      lower_nickname: normalizeName(participant.attributes.stats.name),
      updated_at: new Date().toISOString(),
    }))
    .filter((row): row is typeof row & { id: string } => Boolean(row.id));

  if (rows.length === 0) return;
  const succeeded = await runPersistenceTask("pubg_player_cache", result, () => (
    supabase.from("pubg_player_cache").upsert(rows, { onConflict: "id" })
  ));
  if (succeeded) result.succeeded.push("pubg_player_cache");
}


async function persistPlayerMatches(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
  result: PersistMatchAnalysisResult,
): Promise<void> {
  const participants = input.rawParticipants;
  if (!participants || participants.length === 0 || !input.matchAttr) return;

  const analysisPlayerId = normalizeName(input.playerNickname);
  const rows = participants
    .filter((participant) => (
      !participant.attributes.stats.playerId?.startsWith("ai.")
      && normalizeName(participant.attributes.stats.name) === analysisPlayerId
    ))
    .slice(0, 1)
    .map((participant) => ({
      player_id: analysisPlayerId,
      platform: input.platform,
      match_id: input.matchId,
      played_at: (input.finalResult as any).matchInfo?.date || new Date().toISOString(),
      game_mode: input.matchAttr?.gameMode || "unknown",
      map_name: input.matchAttr?.mapName || "unknown",
      kills: participant.attributes.stats.kills || 0,
      damage: Math.floor(participant.attributes.stats.damageDealt || 0),
      win_place: participant.attributes.stats.winPlace || 99,
    }));

  if (rows.length === 0) return;
  const succeeded = await runPersistenceTask("pubg_player_matches", result, () => (
    supabase.from("pubg_player_matches").upsert(rows, {
      onConflict: "player_id,platform,match_id",
    })
  ));
  if (succeeded) result.succeeded.push("pubg_player_matches");
}

async function persistBenchmark(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
  result: PersistMatchAnalysisResult,
): Promise<void> {
  const finalResult = input.finalResult;
  const matchType = finalResult.matchType.toLowerCase();
  const gameMode = finalResult.gameMode.toLowerCase();
  const isCasual = matchType.includes("airoyale") || matchType.includes("ai-match") || matchType.includes("ai_match") || gameMode.includes("airoyale") || gameMode.includes("ai-match");
  const isStandardBattleRoyale = (matchType === "official" || matchType === "competitive")
    && !isCasual
    && gameMode !== "tdm"
    && gameMode !== "trainingroom";

  if (!(finalResult.isValidBenchmark || input.forceBenchmark) || !isStandardBattleRoyale) return;

  const teammateKnocks = Math.max(1, finalResult.tradeStats?.teammateKnocks || 0);
  const totalKillContribution = Math.max(
    1,
    (finalResult.killContribution?.solo || 0)
      + (finalResult.killContribution?.assist || 0)
      + (finalResult.killContribution?.cleanup || 0),
  );
  const stats = finalResult.stats;
  const row = {
    match_id: input.matchId,
    platform: input.platform,
    player_id: normalizeName(input.playerNickname),
    damage: Math.floor(safeNumber(stats.damageDealt)),
    kills: safeInteger(stats.kills),
    win_place: safeInteger(stats.winPlace, 100),
    game_mode: finalResult.gameMode,
    map_name: finalResult.mapName,
    counter_latency_ms: safeInteger(finalResult.tradeStats?.counterLatencyMs),
    initiative_rate: safeInteger(finalResult.initiative_rate),
    revive_rate: Math.round(((finalResult.tradeStats?.revCount || 0) / teammateKnocks) * 100),
    is_crossfire: finalResult.isolationData?.isCrossfire || false,
    utility_count: safeInteger(finalResult.combatPressure?.utilityStats?.throwCount),
    smoke_count: safeInteger(finalResult.itemUseSummary?.smokes),
    frag_count: safeInteger(finalResult.itemUseSummary?.frags),
    pressure_index: safeInteger(finalResult.combatPressure?.pressureIndex),
    enemy_death_distance: safeInteger(finalResult.deathDistance),
    survival_time: safeInteger(stats.timeSurvived),
    isolation_index: safeInteger(finalResult.isolationData?.isolationIndex),
    min_dist: safeInteger(finalResult.isolationData?.minDist),
    height_diff: safeInteger(finalResult.isolationData?.heightDiff),
    smoke_rate: Math.round(((finalResult.tradeStats?.smokeRescues || 0) / teammateKnocks) * 100),
    trade_rate: Math.round((Math.min(
      finalResult.tradeStats?.teammateKnocks || 0,
      finalResult.tradeStats?.tradeKills || 0,
    ) / teammateKnocks) * 100),
    solo_kill_rate: Math.round(((finalResult.killContribution?.solo || 0) / totalKillContribution) * 100),
    reversal_rate: Math.round(finalResult.duelStats?.reversalRate || 0),
    duel_win_rate: Math.round(finalResult.duelStats?.duelWinRate || 0),
    trade_latency_ms: safeInteger(finalResult.tradeStats?.tradeLatencyMs),
    lethal_throw_count: safeInteger(finalResult.itemUseStats?.lethalThrowCount),
    tier: finalResult.benchmark?.tier || "C",
    score: safeNumber(finalResult.benchmark?.score),
    combat_score: safeNumber(finalResult.benchmark?.breakdown?.combat),
    tactical_score: safeNumber(finalResult.benchmark?.breakdown?.tactical),
    survival_score: safeNumber(finalResult.benchmark?.breakdown?.survival),
    supp_count: safeInteger(finalResult.tradeStats?.suppCount),
    team_wipes: safeInteger(finalResult.tradeStats?.enemyTeamWipes),
    match_type: matchType,
    death_phase: safeInteger(finalResult.deathPhase),
    filter_version: 8,
    source: input.source,
  };
  const succeeded = await runPersistenceTask("global_benchmarks", result, () => (
    supabase.from("global_benchmarks").upsert(row, {
      onConflict: "match_id,platform,player_id",
    })
  ));
  if (succeeded) result.succeeded.push("global_benchmarks");
}

export async function persistMatchAnalysis(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
): Promise<PersistMatchAnalysisResult> {
  const result: PersistMatchAnalysisResult = { succeeded: [], failures: [] };

async function persistWeaponMetaSnapshots(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
  result: PersistMatchAnalysisResult,
): Promise<void> {
  const weaponStats = (input.finalResult as any)?.weaponStats;
  if (!weaponStats || typeof weaponStats !== "object" || Object.keys(weaponStats).length === 0) return;

  const today = new Date().toISOString().split("T")[0];
  const patchVersion = "31.2";

  const rows = Object.entries(weaponStats).map(([wId, wData]: [string, any]) => {
    const cleanName = WEAPON_NAMES[wId] || wId.replace(/Item_Weapon_|Weap|_C|_Projectile/gi, "");
    const category = categorizeWeapon(wId);
    const damage = Math.floor(safeNumber(wData.damage || wData.damageDealt));
    const kills = safeInteger(wData.kills);
    const dbnos = safeInteger(wData.dbnos);
    return {
      patch_version: patchVersion,
      snapshot_date: today,
      weapon_category: category,
      weapon_name: cleanName,
      match_count: 1,
      active_pick_count: damage > 0 ? 1 : 0,
      total_kills: kills,
      total_dbnos: dbnos,
      total_damage: damage,
      first_sec_hits: safeInteger(wData.firstSecHits),
      sustained_hits: safeInteger(wData.sustainedHits),
      sustained_burst_count: safeInteger(wData.sustainedBurstCount),
    };
  });

  if (rows.length === 0) return;

  await runPersistenceTask("match_stats_raw", result, () => (
    supabase.from("weapon_meta_snapshots").upsert(rows, {
      onConflict: "patch_version,snapshot_date,weapon_name",
    })
  ));
}

  await Promise.all([
    persistRawStats(supabase, input, result),
    persistPlayerCache(supabase, input, result),
    persistPlayerMatches(supabase, input, result),
    persistBenchmark(supabase, input, result),
    persistWeaponMetaSnapshots(supabase, input, result),
  ]);
  return result;
}
