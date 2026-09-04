import { POPULATION_EVIDENCE_VERSION, WEAPON_NAMES } from "./constants";
import { BENCHMARK_FILTER_VERSION, isCanonicalBenchmarkTier } from "./benchmarkLookup";
import { categorizeWeapon } from "./weaponMetaBurst";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName } from "./utils";
import { evaluateMatchEligibility, type MatchMetadata } from "./matchEligibility";
import type { RecoveryBenchmarkSnapshot } from "./benchmarkRecoverySnapshot";

export type { RecoveryBenchmarkSnapshot } from "./benchmarkRecoverySnapshot";

export type PubgPlatform = "steam" | "kakao";
export type AnalysisSource = "user" | "scraper";
export type PersistenceTaskName = "match_stats_raw" | "pubg_player_cache" | "global_benchmarks" | "pubg_player_matches" | "weapon_meta_match_samples";

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
  gameMode?: unknown;
  game_mode?: unknown;
  matchType?: unknown;
  match_type?: unknown;
  mapName?: unknown;
  map_name?: unknown;
  isCustomMatch?: unknown;
  is_custom_match?: unknown;
  isEventMode?: unknown;
  is_event_mode?: unknown;
  isCustomGame?: unknown;
  is_custom_game?: unknown;
  telemetry?: unknown;
  createdAt?: unknown;
}

export interface PersistedFinalResult extends JsonObject {
  matchType?: string;
  gameMode?: string;
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
    counterLatencyMs?: number | null;
    revCount?: number;
    smokeRescues?: number;
    tradeKills?: number;
    tradeLatencyMs?: number | null;
    reactionLatencyMs?: number | null;
    suppCount?: number;
    enemyTeamWipes?: number;
    tradeRate?: number | null;
    suppRate?: number | null;
    coverRate?: number | null;
    coverRateSampleCount?: number;
  };
  killContribution?: JsonObject & {
    solo?: number;
    assist?: number;
    cleanup?: number;
  };
  initiative_rate?: number | null;
  isolationData?: JsonObject & {
    isCrossfire?: boolean | null;
    isolationIndex?: number | null;
    minDist?: number | null;
    heightDiff?: number | null;
  };
  combatPressure?: JsonObject & {
    pressureScore?: number | null;
    pressureIndex?: number | null;
    utilityStats?: JsonObject & {
      throwCount?: number;
      lethalThrowCount?: number | null;
      hitCount?: number | null;
      damageEventCount?: number | null;
      totalDamage?: number | null;
      accuracy?: number | null;
      accuracyRaw?: number | null;
      avgDamagePerThrow?: number | null;
    };
  };
  itemUseSummary?: JsonObject & { smokes?: number; frags?: number };
  deathDistance?: number | null;
  duelStats?: JsonObject & { reversalRate?: number | null; duelWinRate?: number | null };
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
  deathPhase?: number | null;
  createdAt?: string;
  weaponStats?: Record<string, {
    damage?: number;
    damageDealt?: number;
    kills?: number;
    dbnos?: number;
    dBNOs?: number;
    hits?: number;
    firstSecHits?: number;
    sustainedHits?: number;
    sustainedBurstCount?: number;
  }>;
  attributes?: JsonObject;
  matchAttributes?: JsonObject;
  telemetry?: unknown;
  telemetryEvents?: unknown;
  telemetryFlags?: JsonObject;
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
  /**
   * Recovery-only compare-and-swap binding for the legacy benchmark row.  A
   * normal request leaves this unset and retains the historical upsert path.
   * The marker values intentionally preserve null versus a concrete integer so
   * a concurrent writer cannot advance the row between the route preflight and
   * this persistence boundary.
   */
  recoveryBenchmarkGuard?: RecoveryBenchmarkGuard;
}

export interface RecoveryBenchmarkGuard {
  id?: number | string;
  matchId: string;
  playerId: string;
  platform: PubgPlatform;
  gameMode: string;
  matchType: "official" | "competitive";
  tier: string;
  filterVersion: number | null;
  populationEvidenceVersion: number | null;
  /** Exact legacy payload observed before the recovery lease was claimed. */
  snapshot?: RecoveryBenchmarkSnapshot;
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
  try {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  } catch {
    return fallback;
  }
}

function safeScore(value: unknown): number {
  return Math.max(0, Math.min(100, safeNumber(value)));
}

function safeInteger(value: unknown, fallback = 0): number {
  return Math.round(safeNumber(value, fallback));
}

/**
 * Benchmark columns are nullable observations.  Do not coerce an absent or
 * malformed value to a plausible-looking zero: an explicit numeric zero is a
 * real observation and must remain distinct from `null` (unmeasured).
 */
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  try {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  } catch {
    return null;
  }
}

function nullableInteger(value: unknown): number | null {
  const numeric = nullableNumber(value);
  return numeric === null ? null : Math.round(numeric);
}

function nullableNonNegativeNumber(value: unknown): number | null {
  const numeric = nullableNumber(value);
  return numeric === null || numeric < 0 ? null : numeric;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  const numeric = nullableNonNegativeNumber(value);
  return numeric === null ? null : Math.round(numeric);
}

function nullableNonNegativeFloor(value: unknown): number | null {
  const numeric = nullableNonNegativeNumber(value);
  return numeric === null ? null : Math.floor(numeric);
}

function nullableFloor(value: unknown): number | null {
  const numeric = nullableNumber(value);
  return numeric === null ? null : Math.floor(numeric);
}

function nullableNonNegativePercent(value: unknown): number | null {
  const numeric = nullableNumber(value);
  if (numeric === null || numeric < 0 || numeric > 100) return null;
  return Math.round(numeric);
}

function nullableRatioPercent(numerator: unknown, denominator: unknown): number | null {
  const numeratorValue = nullableNonNegativeNumber(numerator);
  const denominatorValue = nullableNonNegativeNumber(denominator);
  if (numeratorValue === null || denominatorValue === null || denominatorValue <= 0 || numeratorValue < 0) {
    return null;
  }
  return Math.round(Math.max(0, Math.min(100, (numeratorValue / denominatorValue) * 100)));
}

function nullableScore(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const numeric = nullableNumber(value);
  return numeric === null ? null : Math.max(0, Math.min(100, numeric));
}

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function observedCrossfire(isolationData: PersistedFinalResult["isolationData"]): boolean | null {
  if (!isolationData || typeof isolationData !== "object") return null;
  // AnalysisEngine keeps an empty isolation object for handler access.  A
  // false flag without any position evidence is therefore not an observed
  // "no crossfire" result; leave it unavailable until a sample exists.
  const hasPositionEvidence = [
    isolationData.isolationIndex,
    isolationData.minDist,
    isolationData.heightDiff,
  ].some((value) => nullableNumber(value) !== null);
  if (!hasPositionEvidence && isolationData.isCrossfire !== true) return null;
  return typeof isolationData.isCrossfire === "boolean" ? isolationData.isCrossfire : null;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

const EXCLUSION_EVIDENCE_KEYS = [
  "isCustomMatch",
  "is_custom_match",
  "customMatch",
  "custom_match",
  "isEventMode",
  "is_event_mode",
  "eventMode",
  "event_mode",
  "isCustomGame",
  "is_custom_game",
] as const;

function evidenceFlagIsTrue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
}

function evidenceFlagIsPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Merge persisted evidence without allowing a false secondary layer to hide a true flag. */
function mergeEvidenceRecords(...records: Array<JsonObject | undefined>): JsonObject | undefined {
  const present = records.filter((record): record is JsonObject => Boolean(record));
  if (present.length === 0) return undefined;

  const mergeRecord = (left: JsonObject, right: JsonObject): JsonObject => {
    const merged: JsonObject = { ...left };
    for (const [key, rightValue] of Object.entries(right)) {
      const leftValue = merged[key];
      if (EXCLUSION_EVIDENCE_KEYS.includes(key as (typeof EXCLUSION_EVIDENCE_KEYS)[number])) {
        const values = [leftValue, rightValue].filter(evidenceFlagIsPresent);
        if (values.some(evidenceFlagIsTrue)) merged[key] = true;
        else if (values.length > 0) merged[key] = values[values.length - 1];
        continue;
      }
      const leftObject = leftValue && typeof leftValue === "object" && !Array.isArray(leftValue)
        ? leftValue as JsonObject
        : undefined;
      const rightObject = rightValue && typeof rightValue === "object" && !Array.isArray(rightValue)
        ? rightValue as JsonObject
        : undefined;
      if (leftObject && rightObject) {
        merged[key] = mergeRecord(leftObject, rightObject);
      } else if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
        // Keep all nested telemetry/evidence records. Replacing an array here
        // can silently discard the only true custom/event marker.
        merged[key] = [...leftValue, ...rightValue];
      } else {
        merged[key] = rightValue;
      }
    }
    return merged;
  };

  return present.slice(1).reduce((merged, record) => mergeRecord(merged, record), { ...present[0] });
}

function mergeEvidenceCollections(...values: unknown[]): unknown {
  const present = values.filter((value) => value !== undefined && value !== null);
  if (present.length === 0) return undefined;
  const merged = present.flatMap((value) => Array.isArray(value) ? value : [value]);
  // Preserve the historical object shape for a lone layer, but never drop an
  // object merely because another evidence layer is represented as an array.
  return present.length === 1 && !Array.isArray(present[0]) ? present[0] : merged;
}

function benchmarkEligibilityInput(input: PersistMatchAnalysisInput): MatchMetadata {
  const finalResult = input.finalResult as unknown as MatchMetadata;
  const finalAttributes = finalResult.attributes && typeof finalResult.attributes === "object"
    && !Array.isArray(finalResult.attributes)
    ? finalResult.attributes as MatchMetadata
    : undefined;
  const inputAttributes = input.matchAttr as unknown as MatchMetadata | undefined;
  // Keep both canonical match attributes and evidence copied onto the final
  // result.  Route hydration stores custom/event flags in the latter, while
  // legacy callers provide the former; replacing one with the other would
  // make the shared population gate blind to persisted evidence.
  const attributes = mergeEvidenceRecords(inputAttributes, finalAttributes);
  const finalMatchAttributes = finalResult.matchAttributes && typeof finalResult.matchAttributes === "object"
    && !Array.isArray(finalResult.matchAttributes)
    ? finalResult.matchAttributes as MatchMetadata
    : undefined;
  const matchAttributes = mergeEvidenceRecords(attributes, finalMatchAttributes);
  const matchInfoEvidence = [
    inputAttributes?.matchInfo,
    finalResult.matchInfo,
    finalAttributes?.matchInfo,
    finalMatchAttributes?.matchInfo,
  ].flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is JsonObject => Boolean(value && typeof value === "object" && !Array.isArray(value)));
  const finalTelemetryFlags = finalResult.telemetryFlags && typeof finalResult.telemetryFlags === "object"
    && !Array.isArray(finalResult.telemetryFlags)
    ? finalResult.telemetryFlags as JsonObject
    : undefined;
  const inputTelemetryFlags = inputAttributes?.telemetryFlags && typeof inputAttributes.telemetryFlags === "object"
    && !Array.isArray(inputAttributes.telemetryFlags)
    ? inputAttributes.telemetryFlags as JsonObject
    : undefined;
  const telemetryFlags = mergeEvidenceRecords(inputTelemetryFlags, finalTelemetryFlags);
  const telemetry = mergeEvidenceCollections(
    finalResult.telemetry,
    finalResult.telemetryEvents,
    attributes?.telemetry,
    inputAttributes?.telemetry,
  );
  return {
    ...finalResult,
    attributes,
    matchAttributes,
    ...(matchInfoEvidence.length > 0 ? { matchInfoEvidence } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(telemetryFlags ? { telemetryFlags } : {}),
  };
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
      match_type: typeof input.finalResult.matchType === "string" && input.finalResult.matchType.trim()
        ? input.finalResult.matchType.trim().toLowerCase()
        : "unknown",
    }));

  if (rows.length === 0) return;
  const succeeded = await runPersistenceTask("pubg_player_matches", result, () => (
    supabase.from("pubg_player_matches").upsert(rows, {
      onConflict: "player_id,platform,match_id",
    })
  ));
  if (succeeded) result.succeeded.push("pubg_player_matches");
}

/**
 * Build the canonical global benchmark row without performing I/O.
 *
 * Recovery uses this exact builder for the atomic finalize RPC; ordinary
 * persistence uses it for its historical upsert path. Keeping the mapping in
 * one pure function prevents the two paths from drifting in either metric or
 * provenance evidence.
 */
export function buildBenchmarkRow(
  input: PersistMatchAnalysisInput,
): Record<string, unknown> | null {
  const finalResult = input.finalResult;
  const eligibility = evaluateMatchEligibility(benchmarkEligibilityInput(input), "benchmark");

  if (!(finalResult.isValidBenchmark || input.forceBenchmark) || !eligibility.eligible) return null;

  const matchId = typeof input.matchId === "string" ? input.matchId.trim() : "";
  const playerId = normalizeName(input.playerNickname);
  const tier = finalResult.benchmark?.tier;
  // Identity and tier are the minimum evidence needed for a benchmark row.
  // Never invent a tier (or an empty identity) just to satisfy the DB shape.
  if (!matchId || !playerId || !isCanonicalBenchmarkTier(tier)) return null;

  const teammateKnocks = finalResult.tradeStats?.teammateKnocks;
  const soloKills = finalResult.killContribution?.solo;
  const assistKills = finalResult.killContribution?.assist;
  const cleanupKills = finalResult.killContribution?.cleanup;
  const totalKillContribution = [soloKills, assistKills, cleanupKills].every((value) => nullableNonNegativeNumber(value) !== null)
    ? (Number(soloKills) + Number(assistKills) + Number(cleanupKills))
    : null;
  const stats = finalResult.stats;
  const row = {
    match_id: matchId,
    platform: input.platform,
    player_id: playerId,
    damage: nullableNonNegativeFloor(stats.damageDealt),
    kills: nullableNonNegativeInteger(stats.kills),
    win_place: nullableNonNegativeInteger(stats.winPlace),
    game_mode: eligibility.mode,
    map_name: nullableText(finalResult.mapName),
    counter_latency_ms: nullableNonNegativeInteger(finalResult.tradeStats?.counterLatencyMs),
    initiative_rate: nullableNonNegativePercent(finalResult.initiative_rate),
    revive_rate: nullableRatioPercent(finalResult.tradeStats?.revCount, teammateKnocks),
    is_crossfire: observedCrossfire(finalResult.isolationData),
    utility_count: nullableNonNegativeInteger(finalResult.combatPressure?.utilityStats?.throwCount),
    smoke_count: nullableNonNegativeInteger(finalResult.itemUseSummary?.smokes),
    frag_count: nullableNonNegativeInteger(finalResult.itemUseSummary?.frags),
    pressure_index: nullableNonNegativeInteger(finalResult.combatPressure?.pressureIndex),
    enemy_death_distance: nullableNonNegativeInteger(finalResult.deathDistance),
    survival_time: nullableNonNegativeInteger(stats.timeSurvived),
    isolation_index: nullableNonNegativeInteger(finalResult.isolationData?.isolationIndex),
    min_dist: nullableNonNegativeInteger(finalResult.isolationData?.minDist),
    height_diff: nullableNonNegativeInteger(finalResult.isolationData?.heightDiff),
    smoke_rate: nullableRatioPercent(finalResult.tradeStats?.smokeRescues, teammateKnocks),
    trade_rate: nullableRatioPercent(
      (() => {
        const knocks = nullableNonNegativeNumber(teammateKnocks);
        const trades = nullableNonNegativeNumber(finalResult.tradeStats?.tradeKills);
        return knocks === null || trades === null ? null : Math.min(knocks, trades);
      })(),
      teammateKnocks,
    ),
    solo_kill_rate: nullableRatioPercent(soloKills, totalKillContribution),
    reversal_rate: nullableNonNegativePercent(finalResult.duelStats?.reversalRate),
    duel_win_rate: nullableNonNegativePercent(finalResult.duelStats?.duelWinRate),
    trade_latency_ms: nullableNonNegativeInteger(finalResult.tradeStats?.tradeLatencyMs),
    lethal_throw_count: nullableNonNegativeInteger(finalResult.itemUseStats?.lethalThrowCount),
    tier,
    score: nullableScore(finalResult.benchmark?.score),
    combat_score: nullableScore(finalResult.benchmark?.breakdown?.combat),
    tactical_score: nullableScore(finalResult.benchmark?.breakdown?.tactical),
    survival_score: nullableScore(finalResult.benchmark?.breakdown?.survival),
    supp_count: nullableNonNegativeInteger(finalResult.tradeStats?.suppCount),
    team_wipes: nullableNonNegativeInteger(finalResult.tradeStats?.enemyTeamWipes),
    match_type: eligibility.matchType,
    death_phase: nullableNonNegativeInteger(finalResult.deathPhase),
    filter_version: BENCHMARK_FILTER_VERSION,
    population_evidence_version: POPULATION_EVIDENCE_VERSION,
    source: input.source,
  };
  return row;
}

async function persistBenchmark(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
  result: PersistMatchAnalysisResult,
): Promise<void> {
  const row = buildBenchmarkRow(input);
  if (!row) return;

  const recoveryGuard = input.recoveryBenchmarkGuard;
  const succeeded = await runPersistenceTask("global_benchmarks", result, async () => {
    if (!recoveryGuard) {
      return supabase.from("global_benchmarks").upsert(row, {
        onConflict: "match_id,platform,player_id",
      });
    }

    // Recovery is an upgrade of one known legacy row, never an insert or an
    // unconditional replacement.  Keep the expected identity/bucket in the
    // WHERE clause and compare the exact legacy markers so a concurrent
    // writer's current/future row produces zero affected rows instead of
    // being overwritten by this v73 result.
    const hasValidGuardId = recoveryGuard.id === undefined
      || (typeof recoveryGuard.id === "number" && Number.isSafeInteger(recoveryGuard.id))
      || (typeof recoveryGuard.id === "string" && /^\d+$/.test(recoveryGuard.id));
    if (!hasValidGuardId
      || (recoveryGuard.filterVersion !== null
      && (!Number.isInteger(recoveryGuard.filterVersion)
        || recoveryGuard.filterVersion < 0
        || recoveryGuard.filterVersion > BENCHMARK_FILTER_VERSION))
      || recoveryGuard.populationEvidenceVersion !== null
      || row.match_id !== recoveryGuard.matchId
      || row.platform !== recoveryGuard.platform
      || row.player_id !== recoveryGuard.playerId
      || row.game_mode !== recoveryGuard.gameMode
      || row.match_type !== recoveryGuard.matchType) {
      return { error: { message: "recovery benchmark marker changed" } };
    }

    let mutation = supabase.from("global_benchmarks").update(row);
    if (recoveryGuard.id !== undefined) mutation = mutation.eq("id", recoveryGuard.id);
    mutation = mutation
      .eq("match_id", recoveryGuard.matchId)
      .eq("platform", recoveryGuard.platform)
      .eq("player_id", recoveryGuard.playerId)
      .eq("game_mode", recoveryGuard.gameMode)
      .eq("match_type", recoveryGuard.matchType)
      .eq("tier", recoveryGuard.tier);
    mutation = recoveryGuard.filterVersion === null
      ? mutation.is("filter_version", null)
      : mutation.eq("filter_version", recoveryGuard.filterVersion);
    mutation = recoveryGuard.populationEvidenceVersion === null
      ? mutation.is("population_evidence_version", null)
      : mutation.eq("population_evidence_version", recoveryGuard.populationEvidenceVersion);

    const { data, error } = await mutation.select("id");
    if (error) return { error };
    if (!Array.isArray(data) || data.length !== 1) {
      return { error: { message: "recovery benchmark marker changed" } };
    }
    return { error: null };
  });
  if (succeeded) result.succeeded.push("global_benchmarks");
}

function getPatchVersionForMatch(playedAt: string): string | null {
  const version = process.env.PUBG_META_PATCH_VERSION?.trim();
  const startedAt = process.env.PUBG_META_PATCH_STARTED_AT;
  if (!version || !startedAt) return null;

  const patchStart = Date.parse(startedAt);
  const matchTime = Date.parse(playedAt);
  if (!Number.isFinite(patchStart) || !Number.isFinite(matchTime)) return null;
  return matchTime >= patchStart ? version : `pre_${version}`;
}

export function buildWeaponMetaMatchSamples(input: PersistMatchAnalysisInput): Array<Record<string, unknown>> {
  const weaponStats = input.finalResult.weaponStats;
  if (!weaponStats || Object.keys(weaponStats).length === 0) return [];

  const playedAt = input.finalResult.createdAt || (input.matchAttr as any)?.createdAt;
  if (!playedAt) return [];
  const patchVersion = getPatchVersionForMatch(playedAt);
  if (!patchVersion) return [];
  const eligibility = evaluateMatchEligibility(benchmarkEligibilityInput(input), "benchmark");
  if (!eligibility.eligible || !eligibility.matchType) return [];
  const matchType = eligibility.matchType;

  const playerId = normalizeName(input.playerNickname);
  return Object.entries(weaponStats)
    .filter(([weaponId]) => categorizeWeapon(weaponId) !== "OTHERS")
    .map(([weaponId, stat]) => {
    const weaponName = WEAPON_NAMES[weaponId] || weaponId.replace(/Item_Weapon_|Weap|_C|_Projectile/gi, "");
    const damage = Math.floor(safeNumber(stat.damage ?? stat.damageDealt));
    return {
      match_id: input.matchId,
      platform: input.platform,
      player_id: playerId,
      played_at: playedAt,
      patch_version: patchVersion,
      filter_version: BENCHMARK_FILTER_VERSION,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
      match_type: matchType,
      weapon_category: categorizeWeapon(weaponId),
      weapon_name: weaponName,
      active_pick: damage > 0,
      total_kills: safeInteger(stat.kills),
      total_dbnos: safeInteger(stat.dbnos ?? stat.dBNOs),
      total_damage: damage,
      hit_count: safeInteger(stat.hits),
      first_sec_hits: stat.firstSecHits == null ? null : safeInteger(stat.firstSecHits),
      sustained_hits: stat.sustainedHits == null ? null : safeInteger(stat.sustainedHits),
      sustained_burst_count: stat.sustainedBurstCount == null ? null : safeInteger(stat.sustainedBurstCount),
    };
    });
}

async function persistWeaponMetaMatchSamples(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
  result: PersistMatchAnalysisResult,
): Promise<void> {
  const rows = buildWeaponMetaMatchSamples(input);
  if (rows.length === 0) return;

  const succeeded = await runPersistenceTask("weapon_meta_match_samples", result, () => (
    supabase.from("weapon_meta_match_samples").upsert(rows, {
      onConflict: "match_id,platform,player_id,weapon_name",
    })
  ));
  if (succeeded) result.succeeded.push("weapon_meta_match_samples");
}

export async function persistMatchAnalysis(
  supabase: SupabaseClient,
  input: PersistMatchAnalysisInput,
): Promise<PersistMatchAnalysisResult> {
  const result: PersistMatchAnalysisResult = { succeeded: [], failures: [] };

  await Promise.all([
    persistRawStats(supabase, input, result),
    persistPlayerCache(supabase, input, result),
    persistPlayerMatches(supabase, input, result),
    persistBenchmark(supabase, input, result),
    persistWeaponMetaMatchSamples(supabase, input, result),
  ]);
  return result;
}
