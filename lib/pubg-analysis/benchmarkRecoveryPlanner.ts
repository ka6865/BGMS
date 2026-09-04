/**
 * Pure planning helpers for a benchmark recovery canary.
 *
 * This module intentionally knows nothing about Supabase, PUBG HTTP calls, or
 * persistence.  Callers provide the three read-only row shapes and receive a
 * redacted decision for every benchmark row.  The planner only ever selects
 * legacy rows that can be proven to have a strict identity, recent match
 * history, and a canonical human BR population.
 */

import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "./constants";
import {
  getValidFullResultForMatch,
  normalizePlatform,
  type CanonicalMatchLookup,
} from "./cacheIdentity";
import {
  BENCHMARK_FILTER_VERSION,
  isCanonicalBenchmarkTier,
  isTrustedBenchmarkAggregate,
  type CanonicalBenchmarkTier,
} from "./benchmarkLookup";
import {
  evaluateMatchEligibility,
  type KnownBattleRoyaleMode,
  type MatchEligibilityReason,
} from "./matchEligibility";
import { normalizeMatchId } from "./recentMatchSelection";
import { normalizeName } from "./utils";
import type { RecoveryBenchmarkSnapshot } from "./benchmarkRecoverySnapshot";

export const BENCHMARK_RECOVERY_CANARY_SIZE = 5;
export const BENCHMARK_RECOVERY_DEFAULT_RECENT_DAYS = 14;

export const DEFAULT_BENCHMARK_RECOVERY_BUCKET: BenchmarkRecoveryBucket = {
  gameMode: "duo",
  matchType: "competitive",
  tier: "C",
};

export const BENCHMARK_RECOVERY_ALLOWED_PLATFORMS = ["steam", "kakao"] as const;
export type BenchmarkRecoveryPlatform = typeof BENCHMARK_RECOVERY_ALLOWED_PLATFORMS[number];
export const DEFAULT_BENCHMARK_RECOVERY_PLATFORM: BenchmarkRecoveryPlatform = "steam";

export type BenchmarkRecoveryBucket = {
  gameMode: string;
  matchType: "official" | "competitive" | string;
  tier: string;
};

export type BenchmarkRecoveryBenchmarkRow = {
  id?: unknown;
  match_id?: unknown;
  player_id?: unknown;
  platform?: unknown;
  game_mode?: unknown;
  match_type?: unknown;
  tier?: unknown;
  created_at?: unknown;
  filter_version?: unknown;
  population_evidence_version?: unknown;
  [key: string]: unknown;
};

/**
 * The exact legacy benchmark columns that the recovery finalizer compares
 * under its row lock. Keep this list in the read-only planner so a manifest
 * cannot authorize a route from a partial benchmark row.
 */
export const BENCHMARK_RECOVERY_SNAPSHOT_COLUMNS = [
  "damage",
  "kills",
  "win_place",
  "game_mode",
  "map_name",
  "counter_latency_ms",
  "initiative_rate",
  "revive_rate",
  "is_crossfire",
  "utility_count",
  "smoke_count",
  "frag_count",
  "pressure_index",
  "enemy_death_distance",
  "survival_time",
  "isolation_index",
  "min_dist",
  "height_diff",
  "smoke_rate",
  "trade_rate",
  "solo_kill_rate",
  "reversal_rate",
  "duel_win_rate",
  "trade_latency_ms",
  "lethal_throw_count",
  "tier",
  "score",
  "combat_score",
  "tactical_score",
  "survival_score",
  "supp_count",
  "team_wipes",
  "match_type",
  "death_phase",
  "filter_version",
  "population_evidence_version",
  "source",
] as const satisfies readonly (keyof RecoveryBenchmarkSnapshot)[];

export type BenchmarkRecoverySnapshot = RecoveryBenchmarkSnapshot;

export type BenchmarkRecoveryPlayerMatchRow = {
  match_id?: unknown;
  player_id?: unknown;
  platform?: unknown;
  played_at?: unknown;
  game_mode?: unknown;
  match_type?: unknown;
  map_name?: unknown;
  [key: string]: unknown;
};

export type BenchmarkRecoveryProcessedRow = {
  match_id?: unknown;
  player_id?: unknown;
  platform?: unknown;
  data?: unknown;
  [key: string]: unknown;
};

export type BenchmarkRecoveryCandidateInput = {
  benchmark: BenchmarkRecoveryBenchmarkRow;
  playerMatchRows?: readonly BenchmarkRecoveryPlayerMatchRow[];
  processedRows?: readonly BenchmarkRecoveryProcessedRow[];
};

export type BenchmarkRecoveryReason =
  | "already_trusted"
  | "missing_match_id"
  | "missing_player_id"
  | "missing_platform"
  | "unsupported_platform"
  | "missing_bucket_mode"
  | "missing_bucket_match_type"
  | "missing_bucket_tier"
  | "invalid_bucket_tier"
  | "benchmark_population_ineligible"
  | "history_missing"
  | "history_ambiguous"
  | "history_identity_mismatch"
  | "history_date_missing"
  | "history_date_invalid"
  | "history_too_old"
  | "history_in_future"
  | "history_bucket_mismatch"
  | "processed_missing"
  | "processed_ambiguous"
  | "processed_identity_mismatch"
  | "processed_date_invalid"
  | "processed_bucket_mismatch"
  | "processed_tier_missing"
  | "processed_tier_mismatch"
  | "processed_not_valid_benchmark"
  | "duplicate_candidate_identity";

export type BenchmarkRecoveryCandidateDecision = {
  benchmarkId: string | number | null;
  benchmarkSnapshot: BenchmarkRecoverySnapshot | null;
  identity: {
    matchId: string | null;
    playerId: string | null;
    platform: BenchmarkRecoveryPlatform | null;
  };
  bucket: BenchmarkRecoveryBucket | null;
  playedAt: string | null;
  eligible: boolean;
  reason: "eligible" | BenchmarkRecoveryReason;
  reasons: BenchmarkRecoveryReason[];
};

export type BenchmarkRecoveryPlan = {
  decisions: BenchmarkRecoveryCandidateDecision[];
  selected: BenchmarkRecoveryCandidateDecision[];
  selectedBucket: BenchmarkRecoveryBucket | null;
  selectedPlatform: BenchmarkRecoveryPlatform | null;
  selectionStatus: "selected" | "insufficient_cohort";
  preferredBucket: BenchmarkRecoveryBucket;
  preferredPlatform: BenchmarkRecoveryPlatform;
  cohortSize: number;
  viableBuckets: Array<BenchmarkRecoveryBucket & {
    platform: BenchmarkRecoveryPlatform;
    eligibleCount: number;
  }>;
  reasonCounts: Record<string, number>;
};

export type BenchmarkRecoveryPlannerOptions = {
  /** Lower bound for the played_at value; omitted to disable date filtering. */
  recentSince?: string | number | Date | null;
  /** Clock used to reject obviously future rows. Defaults to Date.now(). */
  now?: string | number | Date;
  preferredBucket?: Partial<BenchmarkRecoveryBucket>;
  preferredPlatform?: BenchmarkRecoveryPlatform | string;
  cohortSize?: number;
};

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BENCHMARK_SNAPSHOT_STRING_COLUMNS = new Set([
  "game_mode",
  "map_name",
  "tier",
  "match_type",
  "source",
]);

const BENCHMARK_SNAPSHOT_BOOLEAN_COLUMNS = new Set(["is_crossfire"]);

function isBenchmarkSnapshotValue(column: string, value: unknown): boolean {
  if (value === null) return true;
  if (BENCHMARK_SNAPSHOT_STRING_COLUMNS.has(column)) return typeof value === "string";
  if (BENCHMARK_SNAPSHOT_BOOLEAN_COLUMNS.has(column)) return typeof value === "boolean";
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Preserve the exact nullable values returned by Supabase. Missing or
 * malformed fields are not converted to null, because doing so would weaken
 * the compare-and-swap guard at the database finalizer.
 */
export function readBenchmarkRecoverySnapshot(
  row: BenchmarkRecoveryBenchmarkRow,
): BenchmarkRecoverySnapshot | null {
  if (BENCHMARK_RECOVERY_SNAPSHOT_COLUMNS.some((column) => (
    !Object.prototype.hasOwnProperty.call(row, column)
      || !isBenchmarkSnapshotValue(column, row[column])
  ))) return null;
  return Object.fromEntries(
    BENCHMARK_RECOVERY_SNAPSHOT_COLUMNS.map((column) => [column, row[column]]),
  ) as unknown as BenchmarkRecoverySnapshot;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeText(value: unknown): string | null {
  const text = nonEmptyString(value);
  return text ? text.toLowerCase() : null;
}

function normalizeTier(value: unknown): CanonicalBenchmarkTier | null {
  const text = nonEmptyString(value);
  const normalized = text ? text.toUpperCase() : null;
  return isCanonicalBenchmarkTier(normalized) ? normalized : null;
}

function strictPlatform(value: unknown): BenchmarkRecoveryPlatform | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const platform = normalizePlatform(value);
  return (BENCHMARK_RECOVERY_ALLOWED_PLATFORMS as readonly string[]).includes(platform)
    ? platform as BenchmarkRecoveryPlatform
    : null;
}

function platformReason(value: unknown): BenchmarkRecoveryReason | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return "missing_platform";
  }
  return strictPlatform(value) ? null : "unsupported_platform";
}

function canonicalPlayerId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeName(value);
  return normalized || null;
}

function valueAt(record: unknown, ...keys: string[]): unknown {
  let value: unknown = record;
  for (const key of keys) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

function asTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function canonicalIso(value: unknown): string | null {
  const timestamp = asTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function firstValidDate(...values: unknown[]): { raw: unknown; timestamp: number } | null {
  for (const value of values) {
    const timestamp = asTimestamp(value);
    if (timestamp !== null) return { raw: value, timestamp };
  }
  return null;
}

function asBenchmarkId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function canonicalEligibilityReason(reason: MatchEligibilityReason): BenchmarkRecoveryReason {
  // Keep the report vocabulary intentionally finite.  The detailed shared
  // eligibility reason is still available to callers via the row metadata,
  // but never needs to expose arbitrary upstream strings.
  if (reason === "missing_mode") return "missing_bucket_mode";
  if (reason === "match_type_not_canonical") return "missing_bucket_match_type";
  return "benchmark_population_ineligible";
}

function bucketFromBenchmark(row: BenchmarkRecoveryBenchmarkRow): BenchmarkRecoveryBucket | null {
  const gameMode = normalizeText(row.game_mode);
  const matchType = normalizeText(row.match_type);
  const tier = normalizeTier(row.tier);
  if (!gameMode || !matchType || !tier) return null;
  return { gameMode, matchType, tier };
}

function bucketKey(bucket: BenchmarkRecoveryBucket | null): string | null {
  if (!bucket) return null;
  return `${bucket.gameMode}|${bucket.matchType}|${bucket.tier}`;
}

function normalizePreferredBucket(value?: Partial<BenchmarkRecoveryBucket>): BenchmarkRecoveryBucket {
  const gameMode = normalizeText(value?.gameMode) || DEFAULT_BENCHMARK_RECOVERY_BUCKET.gameMode;
  const matchType = normalizeText(value?.matchType) || DEFAULT_BENCHMARK_RECOVERY_BUCKET.matchType;
  const eligibility = matchTypeAndModeEligibility(gameMode, matchType);
  if (!eligibility.eligible || eligibility.mode !== gameMode || eligibility.matchType !== matchType) {
    throw new Error("invalid_preferred_bucket_population");
  }
  const suppliedTier = nonEmptyString(value?.tier);
  if (suppliedTier && !isCanonicalBenchmarkTier(suppliedTier.toUpperCase())) {
    throw new Error("invalid_preferred_tier");
  }
  return {
    gameMode,
    matchType,
    tier: normalizeTier(value?.tier) || DEFAULT_BENCHMARK_RECOVERY_BUCKET.tier,
  };
}

function normalizePreferredPlatform(value?: BenchmarkRecoveryPlatform | string): BenchmarkRecoveryPlatform {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if ((BENCHMARK_RECOVERY_ALLOWED_PLATFORMS as readonly string[]).includes(normalized)) {
      return normalized as BenchmarkRecoveryPlatform;
    }
  }
  return DEFAULT_BENCHMARK_RECOVERY_PLATFORM;
}

function normalizeClock(value: string | number | Date | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : Date.now();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Date.now();
}

function exactIdentityFromRow(row: {
  match_id?: unknown;
  player_id?: unknown;
  platform?: unknown;
}): {
  matchId: string | null;
  playerId: string | null;
  platform: BenchmarkRecoveryPlatform | null;
} {
  return {
    matchId: normalizeMatchId(row.match_id),
    playerId: canonicalPlayerId(row.player_id),
    platform: strictPlatform(row.platform),
  };
}

function rowMatchesIdentity(
  row: { match_id?: unknown; player_id?: unknown; platform?: unknown },
  identity: {
    matchId: string;
    playerId: string;
    platform: BenchmarkRecoveryPlatform;
  },
): boolean {
  const candidate = exactIdentityFromRow(row);
  return candidate.matchId === identity.matchId
    && candidate.playerId === identity.playerId
    && candidate.platform === identity.platform;
}

function addReason(reasons: BenchmarkRecoveryReason[], reason: BenchmarkRecoveryReason | null): void {
  if (reason && !reasons.includes(reason)) reasons.push(reason);
}

function matchTypeAndModeEligibility(
  gameMode: unknown,
  matchType: unknown,
  mapName?: unknown,
): { eligible: boolean; mode: KnownBattleRoyaleMode | null; matchType: "official" | "competitive" | null; reason: MatchEligibilityReason } {
  return evaluateMatchEligibility({
    game_mode: gameMode,
    match_type: matchType,
    map_name: mapName,
  }, "benchmark");
}

function processedFullResult(
  row: BenchmarkRecoveryProcessedRow,
  identity: {
    matchId: string;
    playerId: string;
    platform: BenchmarkRecoveryPlatform;
  },
): PlainRecord | null {
  const lookup: CanonicalMatchLookup = {
    matchId: identity.matchId,
    playerId: identity.playerId,
    platform: identity.platform,
    // Recovery candidates may only reuse the immediately previous stale
    // contract. Current/future rows are handled by a separate trust marker
    // boundary and must not enter this recovery cohort.
    minResultVersion: Math.max(1, RESULT_VERSION - 1),
    requireExactResultVersion: true,
  };
  return getValidFullResultForMatch(row, lookup);
}

function assessCandidate(
  input: BenchmarkRecoveryCandidateInput,
  options: BenchmarkRecoveryPlannerOptions,
): BenchmarkRecoveryCandidateDecision {
  const benchmark = input.benchmark;
  const identity = exactIdentityFromRow(benchmark);
  const reasons: BenchmarkRecoveryReason[] = [];
  const benchmarkId = asBenchmarkId(benchmark.id);
  const benchmarkSnapshot = readBenchmarkRecoverySnapshot(benchmark);
  const bucket = bucketFromBenchmark(benchmark);

  if (isTrustedBenchmarkAggregate(benchmark)) addReason(reasons, "already_trusted");
  if (!identity.matchId) addReason(reasons, "missing_match_id");
  if (!identity.playerId) addReason(reasons, "missing_player_id");
  addReason(reasons, platformReason(benchmark.platform));

  if (!bucket) {
    if (!normalizeText(benchmark.game_mode)) addReason(reasons, "missing_bucket_mode");
    if (!normalizeText(benchmark.match_type)) addReason(reasons, "missing_bucket_match_type");
    const rawTier = nonEmptyString(benchmark.tier);
    if (!rawTier) addReason(reasons, "missing_bucket_tier");
    else addReason(reasons, "invalid_bucket_tier");
  }

  let playedAt: string | null = null;
  const now = normalizeClock(options.now);
  let recentSince: number | null = null;
  if (options.recentSince !== undefined && options.recentSince !== null) {
    recentSince = normalizeClock(options.recentSince instanceof Date || typeof options.recentSince === "number"
      ? options.recentSince
      : String(options.recentSince));
  }

  const eligibility = matchTypeAndModeEligibility(benchmark.game_mode, benchmark.match_type);
  if (!eligibility.eligible) addReason(reasons, canonicalEligibilityReason(eligibility.reason));
  if (bucket && eligibility.eligible && (
    bucket.gameMode !== eligibility.mode
      || bucket.matchType !== eligibility.matchType
  )) {
    addReason(reasons, "benchmark_population_ineligible");
  }

  const validIdentity = identity.matchId && identity.playerId && identity.platform
    ? { matchId: identity.matchId, playerId: identity.playerId, platform: identity.platform }
    : null;

  const matchingHistory = validIdentity
    ? (input.playerMatchRows || []).filter((row) => rowMatchesIdentity(row, validIdentity))
    : [];
  if (!validIdentity || matchingHistory.length === 0) {
    addReason(reasons, "history_missing");
  } else if (matchingHistory.length > 1) {
    addReason(reasons, "history_ambiguous");
  }

  const history = matchingHistory[0];
  if (history) {
    if (validIdentity && !rowMatchesIdentity(history, validIdentity)) addReason(reasons, "history_identity_mismatch");
    const historyEligibility = matchTypeAndModeEligibility(
      history.game_mode,
      history.match_type,
      history.map_name,
    );
    if (!historyEligibility.eligible
      || !bucket
      || historyEligibility.mode !== bucket.gameMode
      || historyEligibility.matchType !== bucket.matchType) {
      addReason(reasons, "history_bucket_mismatch");
    }
  }

  const matchingProcessed = validIdentity
    ? (input.processedRows || []).filter((row) => rowMatchesIdentity(row, validIdentity))
    : [];
  if (!validIdentity || matchingProcessed.length === 0) {
    addReason(reasons, "processed_missing");
  } else if (matchingProcessed.length > 1) {
    addReason(reasons, "processed_ambiguous");
  }

  const processed = matchingProcessed[0];
  const fullResult = processed && validIdentity
    ? processedFullResult(processed, validIdentity)
    : null;
  if (processed && !fullResult) addReason(reasons, "processed_identity_mismatch");
  if (fullResult) {
    const processedEligibility = matchTypeAndModeEligibility(
      fullResult.gameMode ?? fullResult.game_mode,
      fullResult.matchType ?? fullResult.match_type,
      fullResult.mapName ?? valueAt(fullResult, "matchInfo", "mapId"),
    );
    if (!processedEligibility.eligible
      || !bucket
      || processedEligibility.mode !== bucket.gameMode
      || processedEligibility.matchType !== bucket.matchType) {
      addReason(reasons, "processed_bucket_mismatch");
    }

    const processedTier = normalizeTier(valueAt(fullResult, "benchmark", "tier"));
    const expectedTier = bucket?.tier || null;
    if (!processedTier) addReason(reasons, "processed_tier_missing");
    else if (expectedTier && processedTier !== expectedTier) addReason(reasons, "processed_tier_mismatch");
    if (fullResult.isValidBenchmark !== true) addReason(reasons, "processed_not_valid_benchmark");
  }

  // Match age is based on the exact processed result timestamp first.  The
  // lightweight player-match row is the API-availability/date fallback only
  // when a processed result carries no usable timestamp.
  const processedDateValues = fullResult
    ? [fullResult.createdAt, fullResult.created_at, valueAt(fullResult, "matchInfo", "date")]
    : [];
  const processedDatePresent = processedDateValues.some((value) => value !== undefined && value !== null && value !== "");
  const processedDate = firstValidDate(...processedDateValues);
  const historyDate = history ? firstValidDate(history.played_at) : null;
  const selectedDate = processedDate || historyDate;
  playedAt = selectedDate ? canonicalIso(selectedDate.raw) : null;
  if (!selectedDate) {
    if (processedDatePresent) addReason(reasons, "processed_date_invalid");
    if (!history) addReason(reasons, "history_date_missing");
    else if (history.played_at === undefined || history.played_at === null || (typeof history.played_at === "string" && !history.played_at.trim())) {
      addReason(reasons, "history_date_missing");
    } else {
      addReason(reasons, "history_date_invalid");
    }
  } else {
    if (recentSince !== null && selectedDate.timestamp < recentSince) addReason(reasons, "history_too_old");
    if (selectedDate.timestamp > now + 5 * 60 * 1_000) addReason(reasons, "history_in_future");
  }

  const eligible = reasons.length === 0;
  return {
    benchmarkId,
    benchmarkSnapshot,
    identity,
    bucket,
    playedAt,
    eligible,
    reason: eligible ? "eligible" : reasons[0],
    reasons,
  };
}

function compareCandidates(
  left: BenchmarkRecoveryCandidateDecision,
  right: BenchmarkRecoveryCandidateDecision,
): number {
  const leftTime = asTimestamp(left.playedAt) ?? -1;
  const rightTime = asTimestamp(right.playedAt) ?? -1;
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftKey = [left.identity.matchId, left.identity.platform, left.identity.playerId].join("|");
  const rightKey = [right.identity.matchId, right.identity.platform, right.identity.playerId].join("|");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function assessBenchmarkRecoveryCandidate(
  input: BenchmarkRecoveryCandidateInput,
  options: BenchmarkRecoveryPlannerOptions = {},
): BenchmarkRecoveryCandidateDecision {
  return assessCandidate(input, options);
}

export function selectBenchmarkRecoveryCanary(
  decisions: readonly BenchmarkRecoveryCandidateDecision[],
  options: Pick<BenchmarkRecoveryPlannerOptions, "preferredBucket" | "preferredPlatform" | "cohortSize"> = {},
): {
  selected: BenchmarkRecoveryCandidateDecision[];
  selectedBucket: BenchmarkRecoveryBucket | null;
  selectedPlatform: BenchmarkRecoveryPlatform | null;
  selectionStatus: "selected" | "insufficient_cohort";
  preferredBucket: BenchmarkRecoveryBucket;
  preferredPlatform: BenchmarkRecoveryPlatform;
  cohortSize: number;
  viableBuckets: Array<BenchmarkRecoveryBucket & {
    platform: BenchmarkRecoveryPlatform;
    eligibleCount: number;
  }>;
} {
  const cohortSize = Number.isInteger(options.cohortSize) && Number(options.cohortSize) > 0
    ? Number(options.cohortSize)
    : BENCHMARK_RECOVERY_CANARY_SIZE;
  const preferredBucket = normalizePreferredBucket(options.preferredBucket);
  const preferredPlatform = normalizePreferredPlatform(options.preferredPlatform);
  const preferredKey = bucketKey(preferredBucket);
  const groups = new Map<string, {
    bucket: BenchmarkRecoveryBucket;
    platform: BenchmarkRecoveryPlatform;
    members: BenchmarkRecoveryCandidateDecision[];
  }>();

  decisions.filter((decision) => decision.eligible
    && decision.bucket
    && isCanonicalBenchmarkTier(decision.bucket.tier)).forEach((decision) => {
    const key = bucketKey(decision.bucket);
    const platform = decision.identity.platform;
    if (!key || !decision.bucket || !platform) return;
    const cohortKey = `${platform}|${key}`;
    const group = groups.get(cohortKey) || { bucket: decision.bucket, platform, members: [] };
    group.members.push(decision);
    groups.set(cohortKey, group);
  });

  const viable = Array.from(groups.values())
    .filter((group) => group.members.length >= cohortSize)
    .map((group) => ({
      ...group,
      members: [...group.members].sort(compareCandidates),
    }));
  viable.sort((left, right) => {
    if (left.platform !== right.platform) return left.platform < right.platform ? -1 : 1;
    const leftKey = bucketKey(left.bucket) || "";
    const rightKey = bucketKey(right.bucket) || "";
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  // A canary is intentionally fail-closed: if the requested exact bucket has
  // fewer than five eligible rows, do not silently substitute another bucket
  // with a different mode/type/tier contract.
  const selectedGroup = viable.find((group) => group.platform === preferredPlatform
    && bucketKey(group.bucket) === preferredKey);
  return {
    selected: selectedGroup ? selectedGroup.members.slice(0, cohortSize) : [],
    selectedBucket: selectedGroup?.bucket || null,
    selectedPlatform: selectedGroup?.platform || null,
    selectionStatus: selectedGroup ? "selected" : "insufficient_cohort",
    preferredBucket,
    preferredPlatform,
    cohortSize,
    viableBuckets: viable.map((group) => ({
      ...group.bucket,
      platform: group.platform,
      eligibleCount: group.members.length,
    })),
  };
}

export function planBenchmarkRecoveryCanary(
  inputs: readonly BenchmarkRecoveryCandidateInput[],
  options: BenchmarkRecoveryPlannerOptions = {},
): BenchmarkRecoveryPlan {
  const assessed = inputs.map((input) => assessCandidate(input, options));
  const identityCounts = new Map<string, number>();
  assessed.forEach((decision) => {
    const key = decision.identity.matchId && decision.identity.playerId && decision.identity.platform
      ? `${decision.identity.matchId}|${decision.identity.platform}|${decision.identity.playerId}`
      : null;
    if (key) identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
  });
  const decisions: BenchmarkRecoveryCandidateDecision[] = assessed.map((decision): BenchmarkRecoveryCandidateDecision => {
    const key = decision.identity.matchId && decision.identity.playerId && decision.identity.platform
      ? `${decision.identity.matchId}|${decision.identity.platform}|${decision.identity.playerId}`
      : null;
    if (!key || (identityCounts.get(key) || 0) < 2) return decision;
    const reasons: BenchmarkRecoveryReason[] = decision.reasons.includes("duplicate_candidate_identity")
      ? decision.reasons
      : [...decision.reasons, "duplicate_candidate_identity"];
    return {
      ...decision,
      eligible: false,
      reason: reasons[0] || "duplicate_candidate_identity",
      reasons,
    };
  });
  const selection = selectBenchmarkRecoveryCanary(decisions, options);
  const reasonCounts: Record<string, number> = {};
  decisions.forEach((decision) => {
    decision.reasons.forEach((reason) => {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    });
  });
  return {
    decisions,
    ...selection,
    reasonCounts,
  };
}

/**
 * A compact local-manifest projection.  It deliberately omits raw telemetry,
 * benchmark metrics, account IDs, and every environment variable.
 */
export function toBenchmarkRecoveryManifestDecision(
  decision: BenchmarkRecoveryCandidateDecision,
): Record<string, unknown> {
  return {
    benchmarkId: decision.benchmarkId,
    matchId: decision.identity.matchId,
    playerId: decision.identity.playerId,
    platform: decision.identity.platform,
    gameMode: decision.bucket?.gameMode || null,
    matchType: decision.bucket?.matchType || null,
    tier: decision.bucket?.tier || null,
    playedAt: decision.playedAt,
    eligible: decision.eligible,
    reason: decision.reason,
    reasons: decision.reasons,
  };
}

export function buildBenchmarkRecoveryInput(
  benchmark: BenchmarkRecoveryBenchmarkRow,
  playerMatchRows: readonly BenchmarkRecoveryPlayerMatchRow[],
  processedRows: readonly BenchmarkRecoveryProcessedRow[],
): BenchmarkRecoveryCandidateInput {
  return { benchmark, playerMatchRows, processedRows };
}

export function trustedMarkerSummary(): {
  filterVersion: number;
  populationEvidenceVersion: number;
  resultVersion: number;
} {
  return {
    filterVersion: BENCHMARK_FILTER_VERSION,
    populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
    resultVersion: RESULT_VERSION,
  };
}
