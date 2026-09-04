/**
 * Guarded benchmark-recovery canary executor.
 *
 * The default mode only validates a frozen planner manifest and prints a
 * deterministic confirmation token. Applying is deliberately opt-in, bound
 * to a loopback app, and uses the existing match route without manual flags.
 * This script has no database or storage mutator path.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  type BenchmarkRecoveryBucket,
  type BenchmarkRecoveryPlatform,
} from "../lib/pubg-analysis/benchmarkRecoveryPlanner";
import type { BenchmarkRecoveryManifest } from "./plan_benchmark_recovery";
import {
  BENCHMARK_FILTER_VERSION,
  isCanonicalBenchmarkTier,
  isTrustedBenchmarkAggregate,
} from "../lib/pubg-analysis/benchmarkLookup";
import { getValidFullResultForMatch, normalizePlatform } from "../lib/pubg-analysis/cacheIdentity";
import {
  POPULATION_EVIDENCE_VERSION,
  RESULT_VERSION,
  TELEMETRY_VERSION,
} from "../lib/pubg-analysis/constants";
import { evaluateMatchEligibility } from "../lib/pubg-analysis/matchEligibility";
import { normalizeMatchId } from "../lib/pubg-analysis/recentMatchSelection";
import { isCanonicalMatchId } from "../lib/pubg-analysis/telemetryIdentity";
import { normalizeName } from "../lib/pubg-analysis/utils";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
dotenv.config({ quiet: true });

export const BENCHMARK_RECOVERY_CANARY_SIZE = 5;
export const BENCHMARK_RECOVERY_DEFAULT_MANIFEST = "tmp/benchmark-recovery-canary-plan.json";
export const BENCHMARK_RECOVERY_DEFAULT_REPORT = "tmp/benchmark-recovery-canary-report.json";
export const BENCHMARK_RECOVERY_DEFAULT_BASE_URL = "http://localhost:3000";
export const BENCHMARK_RECOVERY_SNAPSHOT_SCHEMA = "benchmark-recovery-canary-snapshot-v1";
export const BENCHMARK_RECOVERY_REPORT_SCHEMA = "benchmark-recovery-canary-report-v1";
// A canary manifest is intentionally short-lived.  Replanning is cheap and
// prevents an old cohort from being applied against a changed cache contract.
export const BENCHMARK_RECOVERY_MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const BENCHMARK_RECOVERY_TOKEN_ENV = "BENCHMARK_RECOVERY_TOKEN";
export const BENCHMARK_RECOVERY_TOKEN_HEADER = "x-benchmark-recovery-token";
export const BENCHMARK_RECOVERY_SYNC_STALE_ENV = "BENCHMARK_RECOVERY_SYNC_STALE";

const SNAPSHOT_MATCH_TABLES = [
  "global_benchmarks",
  "processed_match_telemetry",
  "pubg_player_matches",
  "match_stats_raw",
  "weapon_meta_match_samples",
  "telemetry_map_cache_entries",
  "match_master_telemetry",
] as const;

type PlainRecord = Record<string, unknown>;

type ReadQueryResult = {
  data: unknown;
  error: unknown;
};

/** The Supabase builder is thenable at runtime; the narrow shape keeps tests injectable. */
type ReadQuery = {
  select(columns: string): ReadQuery;
  in(column: string, values: readonly string[]): ReadQuery;
  eq(column: string, value: string): ReadQuery;
};

export type ReadOnlySupabaseClient = {
  from(table: string): ReadQuery;
};

export type BenchmarkRecoveryCanaryArgs = {
  manifest: string;
  apply: boolean;
  confirm?: string;
  baseUrl: string;
  snapshot?: string;
  report: string;
  json: boolean;
  help?: boolean;
};

export type BenchmarkRecoveryCanaryReport = {
  schemaVersion: typeof BENCHMARK_RECOVERY_REPORT_SCHEMA;
  mode: "preflight" | "apply";
  status: "preflight" | "applied" | "failed";
  generatedAt: string;
  confirmationToken: string;
  canaryCount: number;
  selectedBucket: BenchmarkRecoveryBucket;
  selectedPlatform: BenchmarkRecoveryPlatform;
  routeCalls: number;
  snapshotPath: string | null;
  postconditionsVerified: boolean;
  /** True only after every completed identity passes the injected R2 proof. */
  r2PostconditionsVerified: boolean;
  completed: Array<{
    index: number;
    identity: {
      matchId: string;
      playerId: string;
      platform: BenchmarkRecoveryPlatform;
    };
    before: DatabaseState;
  }>;
  failure: {
    code: string;
    index?: number;
    httpStatus?: number;
  } | null;
  rollbackAttempted: false;
};

type RunDependencies = {
  manifest?: unknown;
  supabase?: ReadOnlySupabaseClient;
  fetchRoute?: typeof fetch;
  writeLocal?: (filePath: string, content: string) => Promise<void>;
  now?: () => number;
  verifyR2Postconditions?: BenchmarkRecoveryR2PostconditionVerifier;
};

type CanaryIdentity = {
  matchId: string;
  playerId: string;
  platform: BenchmarkRecoveryPlatform;
  bucket: BenchmarkRecoveryBucket;
  playedAt: string;
};

type ManifestValidationOptions = {
  /** Injectable clock for deterministic freshness tests. */
  now?: number | string | Date;
};

type DatabaseState = {
  global_benchmarks: PlainRecord[];
  processed_match_telemetry: PlainRecord[];
  pubg_player_matches: PlainRecord[];
  match_stats_raw: PlainRecord[];
  weapon_meta_match_samples: PlainRecord[];
  telemetry_map_cache_entries: PlainRecord[];
  match_master_telemetry: PlainRecord[];
  pubg_player_cache: PlainRecord[];
};

type BenchmarkRecoveryReadEvidence = {
  matchId: string;
  playerId: string;
  platform: BenchmarkRecoveryPlatform;
  bucket: BenchmarkRecoveryBucket;
  playedAt: string;
  isValidBenchmark: true;
};

/**
 * Read-only proof of the storage side effects produced by one route call.
 * Apply runs require this boundary; the real CLI intentionally does not
 * synthesize a verifier and therefore fails closed without one.
 */
export type BenchmarkRecoveryR2PostconditionEvidence = {
  /** A concrete object read-back, including immutable content identity. */
  object: {
    key: string;
    exists: true;
    etag: string;
    sha256: string;
    readBack: true;
  };
  /** The registry row read-back that binds the object to this identity. */
  registry: {
    matchId: string;
    playerId: string;
    platform: BenchmarkRecoveryPlatform;
    storagePath: string;
    status: "ready";
    telemetryVersion: number;
    etag: string;
    readBack: true;
  };
};

export type BenchmarkRecoveryR2PostconditionVerifier = (
  identity: CanaryIdentity,
  before: DatabaseState,
  after: DatabaseState,
) => Promise<BenchmarkRecoveryR2PostconditionEvidence> | BenchmarkRecoveryR2PostconditionEvidence;

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_${label}`);
  return value.trim();
}

function strictPlatform(value: unknown): BenchmarkRecoveryPlatform {
  const raw = requiredString(value, "platform").toLowerCase();
  if (raw !== "steam" && raw !== "kakao") throw new Error("invalid_platform");
  return raw;
}

/**
 * Keep the executor's manifest boundary identical to the planner's
 * benchmark population boundary.  In particular, event/custom/unknown
 * modes and noncanonical match-type aliases must never be laundered into a
 * five-row recovery cohort merely because all entries share the same string.
 */
function canonicalEligibleBucketParts(
  gameMode: unknown,
  matchType: unknown,
): { gameMode: string; matchType: "official" | "competitive" } | null {
  if (typeof gameMode !== "string" || !gameMode.trim()) return null;
  if (typeof matchType !== "string" || !matchType.trim()) return null;
  const normalizedGameMode = gameMode.trim().toLowerCase();
  const normalizedMatchType = matchType.trim().toLowerCase();
  const eligibility = evaluateMatchEligibility({
    gameMode: normalizedGameMode,
    matchType: normalizedMatchType,
  }, "benchmark");
  if (!eligibility.eligible
    || eligibility.mode !== normalizedGameMode
    || eligibility.matchType !== normalizedMatchType) {
    return null;
  }
  return {
    gameMode: eligibility.mode,
    matchType: eligibility.matchType,
  };
}

function exactBucket(value: unknown, label: string): BenchmarkRecoveryBucket {
  if (!isRecord(value)) throw new Error(`invalid_${label}`);
  const canonicalParts = canonicalEligibleBucketParts(value.gameMode, value.matchType);
  if (!canonicalParts) throw new Error(`invalid_${label}_population`);
  const rawTier = requiredString(value.tier, `${label}_tier`).toUpperCase();
  if (!isCanonicalBenchmarkTier(rawTier)) throw new Error(`invalid_${label}_tier`);
  return {
    gameMode: canonicalParts.gameMode,
    matchType: canonicalParts.matchType,
    tier: rawTier,
  };
}

function bucketKey(bucket: BenchmarkRecoveryBucket): string {
  return `${bucket.gameMode}|${bucket.matchType}|${bucket.tier}`;
}

function bucketFromRecord(value: PlainRecord): BenchmarkRecoveryBucket | null {
  const matchInfo = isRecord(value.matchInfo) ? value.matchInfo : null;
  const benchmark = isRecord(value.benchmark) ? value.benchmark : null;
  const gameMode = value.game_mode ?? value.gameMode ?? matchInfo?.mode ?? matchInfo?.gameMode;
  const matchType = value.match_type ?? value.matchType ?? matchInfo?.matchType;
  const tier = value.tier ?? benchmark?.tier ?? matchInfo?.tier;
  const canonicalParts = canonicalEligibleBucketParts(gameMode, matchType);
  if (!canonicalParts) return null;
  if (typeof tier !== "string" || !tier.trim()) return null;
  const normalizedTier = tier.trim().toUpperCase();
  if (!isCanonicalBenchmarkTier(normalizedTier)) return null;
  return {
    gameMode: canonicalParts.gameMode,
    matchType: canonicalParts.matchType,
    tier: normalizedTier,
  };
}

function assertBucketMatches(value: PlainRecord, expected: BenchmarkRecoveryBucket, label: string): void {
  const actual = bucketFromRecord(value);
  if (!actual || bucketKey(actual) !== bucketKey(expected)) throw new Error(`${label}_bucket_mismatch`);
}

function identityKey(identity: Pick<CanaryIdentity, "matchId" | "platform" | "playerId">): string {
  return `${identity.matchId}|${identity.platform}|${identity.playerId}`;
}

function canaryEntry(entry: unknown): CanaryIdentity {
  if (!isRecord(entry)) throw new Error("invalid_canary_entry");
  const matchId = normalizeMatchId(entry.matchId);
  const playerId = typeof entry.playerId === "string" ? normalizeName(entry.playerId) : "";
  if (!matchId || !isCanonicalMatchId(matchId)) throw new Error("invalid_canary_match_id");
  if (!playerId) throw new Error("invalid_canary_player_id");
  const platform = strictPlatform(entry.platform);
  const bucket = exactBucket({
    gameMode: entry.gameMode,
    matchType: entry.matchType,
    tier: entry.tier,
  }, "canary_bucket");
  const playedAtMs = dateTimestamp(entry.playedAt, "canary_played_at");
  if (entry.eligible !== true || entry.reason !== "eligible") throw new Error("canary_not_eligible");
  if (!Array.isArray(entry.reasons) || entry.reasons.length !== 0) throw new Error("canary_has_reasons");
  return { matchId, playerId, platform, bucket, playedAt: new Date(playedAtMs).toISOString() };
}

function readEvidenceEntry(entry: unknown): BenchmarkRecoveryReadEvidence {
  if (!isRecord(entry)) throw new Error("invalid_read_evidence_entry");
  const matchId = normalizeMatchId(entry.matchId);
  const playerId = typeof entry.playerId === "string" ? normalizeName(entry.playerId) : "";
  if (!matchId || !isCanonicalMatchId(matchId)) throw new Error("invalid_read_evidence_match_id");
  if (!playerId) throw new Error("invalid_read_evidence_player_id");
  const platform = strictPlatform(entry.platform);
  const bucket = exactBucket({
    gameMode: entry.gameMode,
    matchType: entry.matchType,
    tier: entry.tier,
  }, "read_evidence_bucket");
  if (entry.isValidBenchmark !== true) throw new Error("invalid_read_evidence_benchmark_validity");
  const playedAtMs = dateTimestamp(entry.playedAt, "read_evidence_played_at");
  return {
    matchId,
    playerId,
    platform,
    bucket,
    playedAt: new Date(playedAtMs).toISOString(),
    isValidBenchmark: true,
  };
}

function dateTimestamp(value: unknown, label: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`invalid_${label}`);
  return parsed;
}

function validationNow(value: ManifestValidationOptions["now"]): number {
  if (value === undefined) return Date.now();
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  } else {
    const timestamp = dateTimestamp(value, "validation_now");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  throw new Error("invalid_validation_now");
}

export function validateBenchmarkRecoveryManifest(value: unknown, options: ManifestValidationOptions = {}): {
  manifest: BenchmarkRecoveryManifest;
  canary: CanaryIdentity[];
  readEvidence: BenchmarkRecoveryReadEvidence[];
  bucket: BenchmarkRecoveryBucket;
  platform: BenchmarkRecoveryPlatform;
} {
  if (!isRecord(value)) throw new Error("invalid_manifest");
  if (value.schemaVersion !== "benchmark-recovery-canary-v1") throw new Error("invalid_manifest_schema");
  if (value.mode !== "read-only-dry-run") throw new Error("invalid_manifest_mode");
  if (value.selectionStatus !== "selected") throw new Error("manifest_not_selected");
  const generatedAtMs = dateTimestamp(value.generatedAt, "manifest_generated_at");
  const nowMs = validationNow(options.now);
  if (generatedAtMs > nowMs + 5 * 60 * 1_000) throw new Error("manifest_generated_at_in_future");
  if (nowMs - generatedAtMs > BENCHMARK_RECOVERY_MANIFEST_MAX_AGE_MS) throw new Error("manifest_stale");
  if (value.canaryCount !== BENCHMARK_RECOVERY_CANARY_SIZE) throw new Error("invalid_canary_count");
  if (!Array.isArray(value.canary) || value.canary.length !== BENCHMARK_RECOVERY_CANARY_SIZE) {
    throw new Error("invalid_canary_rows");
  }

  if (!isRecord(value.sources) || value.sources.truncated !== false) {
    throw new Error("manifest_sources_truncated");
  }
  if (!isRecord(value.criteria)) throw new Error("invalid_manifest_criteria");
  if (value.criteria.cohortSize !== BENCHMARK_RECOVERY_CANARY_SIZE) {
    throw new Error("invalid_manifest_criteria_cohort_size");
  }
  const recentDays = Number(value.criteria.recentDays);
  if (!Number.isFinite(recentDays) || recentDays <= 0) throw new Error("invalid_manifest_criteria_recent_days");
  const recentSinceMs = dateTimestamp(value.criteria.recentSince, "manifest_recent_since");
  const trustedMarkers = value.criteria.trustedMarkers;
  if (!isRecord(trustedMarkers)
    || Number(trustedMarkers.filterVersion) !== BENCHMARK_FILTER_VERSION
    || Number(trustedMarkers.populationEvidenceVersion) !== POPULATION_EVIDENCE_VERSION
    || Number(trustedMarkers.resultVersion) !== RESULT_VERSION) {
    throw new Error("manifest_trusted_marker_mismatch");
  }

  const canary = value.canary.map(canaryEntry);
  if (!Array.isArray(value.readEvidence) || value.readEvidence.length !== BENCHMARK_RECOVERY_CANARY_SIZE) {
    throw new Error("invalid_manifest_read_evidence");
  }
  const readEvidence = value.readEvidence.map(readEvidenceEntry);
  const evidenceByIdentity = new Map<string, BenchmarkRecoveryReadEvidence>();
  readEvidence.forEach((entry) => {
    const key = identityKey(entry);
    if (evidenceByIdentity.has(key)) throw new Error("duplicate_read_evidence_identity");
    evidenceByIdentity.set(key, entry);
  });
  if (evidenceByIdentity.size !== BENCHMARK_RECOVERY_CANARY_SIZE) {
    throw new Error("invalid_manifest_read_evidence_identities");
  }
  if (canary.some((entry) => {
    const playedAtMs = Date.parse(entry.playedAt);
    return playedAtMs < recentSinceMs || playedAtMs > nowMs + 5 * 60 * 1_000;
  })) {
    throw new Error("manifest_canary_freshness_invalid");
  }
  const unique = new Set(canary.map(identityKey));
  if (unique.size !== BENCHMARK_RECOVERY_CANARY_SIZE) throw new Error("duplicate_canary_identity");
  const platform = canary[0]?.platform;
  if (!platform || canary.some((entry) => entry.platform !== platform)) {
    throw new Error("mixed_canary_platform");
  }
  const selectedPlatform = strictPlatform(value.selectedPlatform);
  if (selectedPlatform !== platform) throw new Error("selected_platform_mismatch");
  const preferredPlatform = strictPlatform(value.criteria.preferredPlatform);
  if (preferredPlatform !== platform) throw new Error("preferred_platform_mismatch");
  const bucket = canary[0]?.bucket;
  if (!bucket || canary.some((entry) => bucketKey(entry.bucket) !== bucketKey(bucket))) {
    throw new Error("mixed_canary_bucket");
  }
  const selectedBucket = exactBucket(value.selectedBucket, "selected_bucket");
  if (bucketKey(selectedBucket) !== bucketKey(bucket)) throw new Error("selected_bucket_mismatch");
  const preferredBucket = exactBucket(value.criteria.preferredBucket, "preferred_bucket");
  if (bucketKey(preferredBucket) !== bucketKey(bucket)) throw new Error("preferred_bucket_mismatch");
  const orderedReadEvidence = canary.map((entry) => {
    const evidence = evidenceByIdentity.get(identityKey(entry));
    if (!evidence
      || evidence.platform !== entry.platform
      || bucketKey(evidence.bucket) !== bucketKey(entry.bucket)
      || evidence.playedAt !== entry.playedAt) {
      throw new Error("manifest_read_evidence_mismatch");
    }
    return evidence;
  });
  return {
    manifest: value as unknown as BenchmarkRecoveryManifest,
    canary,
    readEvidence: orderedReadEvidence,
    bucket,
    platform,
  };
}

export function benchmarkRecoveryConfirmationToken(
  manifest: BenchmarkRecoveryManifest,
  options: { now?: Date } = {},
): string {
  const validated = validateBenchmarkRecoveryManifest(manifest, options);
  const identities = [...validated.canary]
    .sort((left, right) => identityKey(left).localeCompare(identityKey(right)))
    .map(({ matchId, playerId, platform, bucket, playedAt }) => ({
      matchId,
      playerId,
      platform,
      bucket,
      playedAt,
    }));
  const readEvidence = [...validated.readEvidence]
    .sort((left, right) => identityKey(left).localeCompare(identityKey(right)))
    .map(({ matchId, playerId, platform, bucket, playedAt }) => ({
      matchId,
      playerId,
      platform,
      gameMode: bucket.gameMode,
      matchType: bucket.matchType,
      tier: bucket.tier,
      playedAt,
    }));
  const material = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt,
    criteria: manifest.criteria,
    sources: manifest.sources,
    selectedBucket: validated.bucket,
    selectedPlatform: validated.platform,
    canaryCount: manifest.canaryCount,
    eligibleCount: manifest.eligibleCount,
    reasonCounts: manifest.reasonCounts,
    identities,
    readEvidence,
  });
  return `RECOVER-${createHash("sha256").update(material).digest("hex")}`;
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export function parseBenchmarkRecoveryCanaryArgs(args: string[]): BenchmarkRecoveryCanaryArgs {
  const knownFlags = new Set([
    "--manifest", "--apply", "--confirm", "--base-url", "--snapshot", "--report", "--json", "--dry-run", "--help",
  ]);
  args.forEach((arg) => {
    if (!arg.startsWith("--") || knownFlags.has(arg)) return;
    throw new Error(`unknown_option_${arg}`);
  });
  const apply = args.includes("--apply");
  const confirm = valueAfter(args, "--confirm");
  if (confirm && !apply) throw new Error("confirmation_requires_apply");
  return {
    manifest: valueAfter(args, "--manifest") || BENCHMARK_RECOVERY_DEFAULT_MANIFEST,
    apply,
    ...(confirm ? { confirm } : {}),
    baseUrl: valueAfter(args, "--base-url") || process.env.APP_URL?.trim() || BENCHMARK_RECOVERY_DEFAULT_BASE_URL,
    snapshot: valueAfter(args, "--snapshot"),
    report: valueAfter(args, "--report") || BENCHMARK_RECOVERY_DEFAULT_REPORT,
    json: args.includes("--json"),
    help: args.includes("--help"),
  };
}

function asRows(value: unknown): PlainRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) return error.message;
  return "unknown_read_error";
}

async function executeRead(query: ReadQuery): Promise<ReadQueryResult> {
  return Promise.resolve(query as unknown as PromiseLike<ReadQueryResult>);
}

async function readByMatchIds(
  supabase: ReadOnlySupabaseClient,
  table: string,
  matchIds: readonly string[],
): Promise<PlainRecord[]> {
  const result = await executeRead(supabase.from(table).select("*").in("match_id", matchIds));
  if (result.error) throw new Error(`read_${table}_${readErrorMessage(result.error)}`);
  return asRows(result.data);
}

async function readByNicknames(
  supabase: ReadOnlySupabaseClient,
  lowerNicknames: readonly string[],
): Promise<PlainRecord[]> {
  const result = await executeRead(
    supabase.from("pubg_player_cache").select("*").in("lower_nickname", lowerNicknames),
  );
  if (result.error) throw new Error(`read_pubg_player_cache_${readErrorMessage(result.error)}`);
  return asRows(result.data);
}

function rowMatchesIdentity(row: PlainRecord, identity: CanaryIdentity): boolean {
  if (typeof row.match_id !== "string" && typeof row.match_id !== "number") return false;
  if (typeof row.player_id !== "string" || !row.player_id.trim()) return false;
  if (typeof row.platform !== "string" || !row.platform.trim()) return false;
  return normalizeMatchId(row.match_id) === identity.matchId
    && normalizeName(row.player_id) === identity.playerId
    && normalizePlatform(row.platform) === identity.platform;
}

function exactIdentityRows(rows: readonly PlainRecord[], identity: CanaryIdentity): PlainRecord[] {
  return rows.filter((row) => rowMatchesIdentity(row, identity));
}

async function readDatabaseState(
  supabase: ReadOnlySupabaseClient,
  canary: readonly CanaryIdentity[],
): Promise<DatabaseState> {
  const matchIds = Array.from(new Set(canary.map((entry) => entry.matchId))).sort();
  const lowerNicknames = Array.from(new Set(canary.map((entry) => entry.playerId))).sort();
  const byMatch = new Map<string, PlainRecord[]>();
  for (const table of SNAPSHOT_MATCH_TABLES) {
    byMatch.set(table, await readByMatchIds(supabase, table, matchIds));
  }
  const global = byMatch.get("global_benchmarks") || [];
  const processed = byMatch.get("processed_match_telemetry") || [];
  const playerMatches = byMatch.get("pubg_player_matches") || [];
  return {
    global_benchmarks: canary.flatMap((identity) => exactIdentityRows(global, identity)),
    processed_match_telemetry: canary.flatMap((identity) => exactIdentityRows(processed, identity)),
    pubg_player_matches: canary.flatMap((identity) => exactIdentityRows(playerMatches, identity)),
    match_stats_raw: byMatch.get("match_stats_raw") || [],
    weapon_meta_match_samples: byMatch.get("weapon_meta_match_samples") || [],
    telemetry_map_cache_entries: byMatch.get("telemetry_map_cache_entries") || [],
    match_master_telemetry: byMatch.get("match_master_telemetry") || [],
    pubg_player_cache: await readByNicknames(supabase, lowerNicknames),
  };
}

async function readIdentityState(
  supabase: ReadOnlySupabaseClient,
  identity: CanaryIdentity,
): Promise<DatabaseState> {
  return readDatabaseState(supabase, [identity]);
}

function exactRowOrFail(rows: readonly PlainRecord[], identity: CanaryIdentity, table: string): PlainRecord {
  const matches = exactIdentityRows(rows, identity);
  if (matches.length !== 1) throw new Error(`${table}_identity_count_${matches.length}`);
  return matches[0];
}

function assertRaceGuard(state: DatabaseState, canary: readonly CanaryIdentity[]): void {
  for (const identity of canary) {
    const benchmark = exactRowOrFail(state.global_benchmarks, identity, "global_benchmarks");
    if (isTrustedBenchmarkAggregate(benchmark)) throw new Error("race_benchmark_already_trusted");
    assertBucketMatches(benchmark, identity.bucket, "race_benchmark");
    const processed = exactRowOrFail(state.processed_match_telemetry, identity, "processed_match_telemetry");
    const fullResult = getValidFullResultForMatch(processed, {
      matchId: identity.matchId,
      playerId: identity.playerId,
      platform: identity.platform,
      minResultVersion: Math.max(1, RESULT_VERSION - 1),
      requireExactResultVersion: true,
    });
    if (!fullResult) throw new Error("race_processed_result_changed");
    if (fullResult.isValidBenchmark !== true) throw new Error("race_processed_benchmark_invalid");
    assertBucketMatches(fullResult, identity.bucket, "race_processed");
  }
}

class ReadEvidenceMismatchError extends Error {
  constructor(message = "read_evidence_changed") {
    super(message);
    this.name = "ReadEvidenceMismatchError";
  }
}

function canonicalDate(value: unknown): string | null {
  try {
    return new Date(dateTimestamp(value, "bound_date")).toISOString();
  } catch {
    return null;
  }
}

function assertPostconditionPlayedAt(
  value: unknown,
  expectedPlayedAt: string,
  missingCode: string,
  mismatchCode: string,
): void {
  const actual = canonicalDate(value);
  if (!actual) throw new Error(missingCode);
  if (actual !== expectedPlayedAt) throw new Error(mismatchCode);
}

function processedPlayedAtValues(fullResult: PlainRecord): unknown[] {
  return [
    fullResult.createdAt,
    fullResult.created_at,
    isRecord(fullResult.matchInfo) ? fullResult.matchInfo.date : undefined,
  ].filter((value) => value !== undefined && value !== null && value !== "");
}

/**
 * Compare the live rows with the exact facts frozen in the planner manifest.
 * The comparison is intentionally identity- and date-sensitive: a changed
 * player-match/cache row must stop the prefix before its route call.
 */
function assertBoundReadEvidence(
  state: DatabaseState,
  identity: CanaryIdentity,
  evidence: BenchmarkRecoveryReadEvidence,
): void {
  try {
    if (identityKey(identity) !== identityKey(evidence)
      || bucketKey(identity.bucket) !== bucketKey(evidence.bucket)
      || identity.playedAt !== evidence.playedAt
      || evidence.isValidBenchmark !== true) {
      throw new ReadEvidenceMismatchError();
    }

    const benchmark = exactRowOrFail(state.global_benchmarks, identity, "global_benchmarks");
    if (isTrustedBenchmarkAggregate(benchmark)) throw new ReadEvidenceMismatchError();
    assertBucketMatches(benchmark, evidence.bucket, "bound_benchmark");

    const processed = exactRowOrFail(state.processed_match_telemetry, identity, "processed_match_telemetry");
    const fullResult = getValidFullResultForMatch(processed, {
      matchId: identity.matchId,
      playerId: identity.playerId,
      platform: identity.platform,
      minResultVersion: Math.max(1, RESULT_VERSION - 1),
      requireExactResultVersion: true,
    });
    if (!fullResult) throw new ReadEvidenceMismatchError();
    if (fullResult.isValidBenchmark !== true) throw new ReadEvidenceMismatchError();
    assertBucketMatches(fullResult, evidence.bucket, "bound_processed");

    const playerMatch = exactRowOrFail(state.pubg_player_matches, identity, "pubg_player_matches");
    assertBucketMatches(playerMatch, evidence.bucket, "bound_player_match");
    if (canonicalDate(playerMatch.played_at) !== evidence.playedAt) {
      throw new ReadEvidenceMismatchError();
    }

    const processedDateValues = [
      fullResult.createdAt,
      fullResult.created_at,
      isRecord(fullResult.matchInfo) ? fullResult.matchInfo.date : undefined,
    ];
    for (const value of processedDateValues) {
      if (value === undefined || value === null || value === "") continue;
      if (canonicalDate(value) !== evidence.playedAt) throw new ReadEvidenceMismatchError();
    }

    const cacheMatches = state.pubg_player_cache.filter((row) => (
      typeof row.lower_nickname === "string"
      && normalizeName(row.lower_nickname) === evidence.playerId
      && typeof row.platform === "string"
      && normalizePlatform(row.platform) === evidence.platform
    ));
    if (cacheMatches.length !== 1) throw new ReadEvidenceMismatchError();
    const cacheRow = cacheMatches[0];
    if (typeof cacheRow.nickname !== "string" || normalizeName(cacheRow.nickname) !== evidence.playerId) {
      throw new ReadEvidenceMismatchError();
    }
  } catch (error) {
    if (error instanceof ReadEvidenceMismatchError) throw error;
    throw new ReadEvidenceMismatchError();
  }
}

function assertPostconditions(state: DatabaseState, canary: readonly CanaryIdentity[]): void {
  for (const identity of canary) {
    const benchmark = exactRowOrFail(state.global_benchmarks, identity, "global_benchmarks");
    if (!isTrustedBenchmarkAggregate(benchmark)
      || Number(benchmark.filter_version) !== BENCHMARK_FILTER_VERSION
      || Number(benchmark.population_evidence_version) !== POPULATION_EVIDENCE_VERSION) {
      throw new Error("postcondition_benchmark_marker_missing");
    }
    assertBucketMatches(benchmark, identity.bucket, "postcondition_benchmark");
    const processed = exactRowOrFail(state.processed_match_telemetry, identity, "processed_match_telemetry");
    const fullResult = getValidFullResultForMatch(processed, {
      matchId: identity.matchId,
      playerId: identity.playerId,
      platform: identity.platform,
      minResultVersion: RESULT_VERSION,
      requireExactResultVersion: true,
      requirePopulationEvidence: true,
    });
    if (!fullResult || fullResult.populationEvidenceVersion !== POPULATION_EVIDENCE_VERSION) {
      throw new Error("postcondition_processed_marker_missing");
    }
    if (fullResult.isValidBenchmark !== true) {
      throw new Error("postcondition_processed_benchmark_invalid");
    }
    assertBucketMatches(fullResult, identity.bucket, "postcondition_processed");

    const playerMatch = exactRowOrFail(state.pubg_player_matches, identity, "pubg_player_matches");
    assertBucketMatches(playerMatch, identity.bucket, "postcondition_player_match");
    assertPostconditionPlayedAt(
      playerMatch.played_at,
      identity.playedAt,
      "postcondition_player_match_played_at_missing",
      "postcondition_player_match_played_at_mismatch",
    );

    const processedDates = processedPlayedAtValues(fullResult);
    if (processedDates.length === 0) throw new Error("postcondition_processed_played_at_missing");
    for (const value of processedDates) {
      assertPostconditionPlayedAt(
        value,
        identity.playedAt,
        "postcondition_processed_played_at_missing",
        "postcondition_processed_played_at_mismatch",
      );
    }

    const cacheMatches = state.pubg_player_cache.filter((row) => (
      typeof row.lower_nickname === "string"
      && normalizeName(row.lower_nickname) === identity.playerId
      && typeof row.platform === "string"
      && normalizePlatform(row.platform) === identity.platform
    ));
    if (cacheMatches.length !== 1) throw new Error(`pubg_player_cache_identity_count_${cacheMatches.length}`);
    const cacheRow = cacheMatches[0];
    if (typeof cacheRow.nickname !== "string" || normalizeName(cacheRow.nickname) !== identity.playerId) {
      throw new Error("postcondition_player_cache_identity_mismatch");
    }
    // `pubg_player_cache` currently has no played_at column.  If a projected
    // cache row carries one, bind it to the same manifest evidence rather than
    // silently accepting a stale/mismatched timestamp.
    const cachePlayedAt = cacheRow.played_at ?? cacheRow.playedAt
      ?? cacheRow.last_played_at ?? cacheRow.lastPlayedAt;
    if (cachePlayedAt !== undefined && cachePlayedAt !== null && cachePlayedAt !== "") {
      assertPostconditionPlayedAt(
        cachePlayedAt,
        identity.playedAt,
        "postcondition_player_cache_played_at_missing",
        "postcondition_player_cache_played_at_mismatch",
      );
    }
  }
}

function nonEmptyEvidenceString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A boolean from a test fixture is not evidence.  Require the verifier to
 * return the object and registry read-back facts that a real R2 verifier would
 * obtain, and bind those facts to the canary identity before allowing the next
 * route call.
 */
function assertR2PostconditionEvidence(
  value: unknown,
  identity: CanaryIdentity,
): asserts value is BenchmarkRecoveryR2PostconditionEvidence {
  if (!isRecord(value) || !isRecord(value.object) || !isRecord(value.registry)) {
    throw new Error("r2_postcondition_evidence_missing");
  }
  const object = value.object;
  const registry = value.registry;
  if (object.exists !== true
    || object.readBack !== true
    || !nonEmptyEvidenceString(object.key)
    || !nonEmptyEvidenceString(object.etag)
    || typeof object.sha256 !== "string"
    || !/^[0-9a-f]{64}$/i.test(object.sha256)) {
    throw new Error("r2_object_readback_invalid");
  }
  if (registry.readBack !== true
    || registry.status !== "ready"
    || registry.matchId !== identity.matchId
    || registry.playerId !== identity.playerId
    || registry.platform !== identity.platform
    || !nonEmptyEvidenceString(registry.storagePath)
    || registry.storagePath !== object.key
    || typeof registry.telemetryVersion !== "number"
    || !Number.isFinite(registry.telemetryVersion)
    || registry.telemetryVersion !== TELEMETRY_VERSION
    || !nonEmptyEvidenceString(registry.etag)
    || registry.etag !== object.etag) {
    throw new Error("r2_registry_readback_invalid");
  }
}

function responseRecord(value: unknown): PlainRecord {
  if (!isRecord(value)) throw new Error("route_response_not_object");
  return value;
}

function assertRouteResponse(value: unknown, identity: CanaryIdentity): void {
  const response = responseRecord(value);
  if (normalizeMatchId(response.matchId ?? response.match_id) !== identity.matchId) {
    throw new Error("route_response_match_identity_mismatch");
  }
  if (typeof response.player_id !== "string" || normalizeName(response.player_id) !== identity.playerId) {
    throw new Error("route_response_player_identity_mismatch");
  }
  if (typeof response.platform !== "string" || normalizePlatform(response.platform) !== identity.platform) {
    throw new Error("route_response_platform_identity_mismatch");
  }
  if (typeof response.v !== "number" || !Number.isFinite(response.v) || response.v !== RESULT_VERSION) {
    throw new Error("route_response_version_invalid");
  }
  if (response.populationEvidenceVersion !== POPULATION_EVIDENCE_VERSION) {
    throw new Error("route_response_population_marker_missing");
  }
}

function loopbackBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_base_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid_base_url_protocol");
  if (parsed.username || parsed.password) throw new Error("invalid_base_url_credentials");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error("apply_requires_loopback_base_url");
  }
  return parsed.origin;
}

function assertRouteResponseUrl(response: Response, requestedUrl: string): void {
  let finalUrl: string;
  try {
    finalUrl = response.url;
  } catch {
    throw new Error("route_response_url_invalid");
  }
  if (!finalUrl) throw new Error("route_response_url_invalid");
  let parsed: URL;
  let requested: URL;
  try {
    parsed = new URL(finalUrl);
    requested = new URL(requestedUrl);
  } catch {
    throw new Error("route_response_url_invalid");
  }
  if (parsed.href !== requested.href) {
    throw new Error("route_response_url_invalid");
  }
}

function tmpPath(value: string, label: string): string {
  const tmpRoot = path.resolve(process.cwd(), "tmp");
  const resolved = path.resolve(process.cwd(), value);
  const relative = path.relative(tmpRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label}_must_be_under_tmp`);
  }
  return resolved;
}

async function defaultWriteLocal(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function reportWithFailure(
  base: Omit<BenchmarkRecoveryCanaryReport, "status" | "failure" | "rollbackAttempted">,
  failure: BenchmarkRecoveryCanaryReport["failure"],
): BenchmarkRecoveryCanaryReport {
  return {
    ...base,
    status: "failed",
    failure,
    rollbackAttempted: false,
  };
}

export async function runBenchmarkRecoveryCanary(
  args: BenchmarkRecoveryCanaryArgs = parseBenchmarkRecoveryCanaryArgs([]),
  dependencies: RunDependencies = {},
): Promise<BenchmarkRecoveryCanaryReport> {
  const rawManifest = dependencies.manifest ?? JSON.parse(await readFile(path.resolve(process.cwd(), args.manifest), "utf8"));
  const runNow = dependencies.now ? dependencies.now() : Date.now();
  const { manifest, canary, readEvidence, bucket, platform } = validateBenchmarkRecoveryManifest(rawManifest, { now: runNow });
  const token = benchmarkRecoveryConfirmationToken(manifest, { now: new Date(runNow) });
  const generatedAt = new Date(runNow).toISOString();
  const reportPath = tmpPath(args.report, "report");
  const writeLocal = dependencies.writeLocal || defaultWriteLocal;
  const baseReport = {
    schemaVersion: BENCHMARK_RECOVERY_REPORT_SCHEMA as typeof BENCHMARK_RECOVERY_REPORT_SCHEMA,
    mode: args.apply ? "apply" as const : "preflight" as const,
    generatedAt,
    confirmationToken: token,
    canaryCount: canary.length,
    selectedBucket: bucket,
    selectedPlatform: platform,
    routeCalls: 0,
    snapshotPath: null,
    postconditionsVerified: false,
    r2PostconditionsVerified: false,
    completed: [] as BenchmarkRecoveryCanaryReport["completed"],
  };

  const writeReport = async (report: BenchmarkRecoveryCanaryReport): Promise<BenchmarkRecoveryCanaryReport> => {
    await writeLocal(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  };

  if (!args.apply) {
    return writeReport({ ...baseReport, status: "preflight", failure: null, rollbackAttempted: false });
  }

  if (args.confirm !== token) throw new Error("confirmation_mismatch");
  if (process.env[BENCHMARK_RECOVERY_SYNC_STALE_ENV] !== "true") {
    throw new Error("benchmark_recovery_sync_stale_disabled");
  }
  const baseUrl = loopbackBaseUrl(args.baseUrl);
  const recoveryToken = process.env[BENCHMARK_RECOVERY_TOKEN_ENV]?.trim();
  if (!recoveryToken) throw new Error("missing_benchmark_recovery_token");
  const verifyR2Postconditions = dependencies.verifyR2Postconditions;
  if (process.env.NODE_ENV !== "test" || typeof verifyR2Postconditions !== "function") {
    // The standalone CLI has no safe way to prove the R2 object/registry
    // postconditions.  Refuse before constructing a client, reading a
    // snapshot, or making route 1 rather than inventing a successful proof.
    // Dependency injection is reserved for the explicit test boundary; a
    // production/CLI caller cannot establish R2 proof with an arbitrary bool.
    throw new Error("r2_postcondition_verifier_required");
  }
  const supabase = dependencies.supabase || await createSupabaseServiceClient();
  const before = await readDatabaseState(supabase, canary);
  assertRaceGuard(before, canary);

  const snapshotPath = tmpPath(
    args.snapshot || `tmp/benchmark-recovery-canary-snapshot-${token.slice(0, 16)}.json`,
    "snapshot",
  );
  const snapshot = {
    schemaVersion: BENCHMARK_RECOVERY_SNAPSHOT_SCHEMA,
    generatedAt,
    confirmationToken: token,
    selectedPlatform: platform,
    selected: canary.map(({ matchId, playerId, platform, bucket: selectedBucket, playedAt }) => ({
      matchId, playerId, platform, bucket: selectedBucket, playedAt,
    })),
    readEvidence: readEvidence.map(({ matchId, playerId, platform, bucket: selectedBucket, playedAt }) => ({
      matchId,
      playerId,
      platform,
      gameMode: selectedBucket.gameMode,
      matchType: selectedBucket.matchType,
      tier: selectedBucket.tier,
      playedAt,
      isValidBenchmark: true,
    })),
    rows: before,
  };
  await writeLocal(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const fetchRoute = dependencies.fetchRoute || fetch;
  let routeCalls = 0;
  let completed: BenchmarkRecoveryCanaryReport["completed"] = [];
  for (let index = 0; index < canary.length; index += 1) {
    const identity = canary[index];
    let beforeRow: DatabaseState;
    try {
      beforeRow = await readIdentityState(supabase, identity);
      assertBoundReadEvidence(beforeRow, identity, readEvidence[index]);
      assertRaceGuard(beforeRow, [identity]);
    } catch (error) {
      const report = reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, {
        code: error instanceof ReadEvidenceMismatchError
          ? "race_read_evidence_changed"
          : "race_guard_failed",
        index,
      });
      return writeReport(report);
    }
    const url = new URL("/api/pubg/match", baseUrl);
    url.searchParams.set("matchId", identity.matchId);
    url.searchParams.set("nickname", identity.playerId);
    url.searchParams.set("platform", identity.platform);
    let response: Response;
    try {
      response = await fetchRoute(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          [BENCHMARK_RECOVERY_TOKEN_HEADER]: recoveryToken,
        },
      });
    } catch {
      const report = reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, { code: "route_request_failed", index });
      return writeReport(report);
    }
    routeCalls += 1;
    try {
      assertRouteResponseUrl(response, url.href);
    } catch {
      const report = reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, {
        code: "route_response_url_invalid",
        index,
      });
      return writeReport(report);
    }
    if (response.status !== 200) {
      const report = reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, {
        code: "route_non_200",
        index,
        httpStatus: response.status,
      });
      return writeReport(report);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const report = reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, { code: "route_invalid_json", index });
      return writeReport(report);
    }
    try {
      assertRouteResponse(payload, identity);
    } catch {
      const report = reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, { code: "route_response_invalid", index });
      return writeReport(report);
    }

    let afterRow: DatabaseState;
    try {
      afterRow = await readIdentityState(supabase, identity);
      assertPostconditions(afterRow, [identity]);
    } catch {
      const report = reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, {
        code: "postcondition_failed",
        index,
      });
      return writeReport(report);
    }
    try {
      const r2Evidence = await verifyR2Postconditions(identity, beforeRow, afterRow);
      assertR2PostconditionEvidence(r2Evidence, identity);
    } catch {
      const report = reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, {
        code: "r2_postcondition_failed",
        index,
      });
      return writeReport(report);
    }
    completed = [...completed, {
      index,
      identity: { matchId: identity.matchId, playerId: identity.playerId, platform: identity.platform },
      before: beforeRow,
    }];
  }

  try {
    const after = await readDatabaseState(supabase, canary);
    assertPostconditions(after, canary);
    return writeReport({
      ...baseReport,
      routeCalls,
      snapshotPath,
      status: "applied",
      failure: null,
      postconditionsVerified: true,
      r2PostconditionsVerified: true,
      completed,
      rollbackAttempted: false,
    });
  } catch {
    return writeReport(reportWithFailure({ ...baseReport, routeCalls, snapshotPath, completed }, { code: "postcondition_failed" }));
  }
}

async function createSupabaseServiceClient(): Promise<ReadOnlySupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("missing_supabase_credentials");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as ReadOnlySupabaseClient;
}

function printSummary(report: BenchmarkRecoveryCanaryReport, reportPath: string): void {
  console.info(JSON.stringify({
    mode: report.mode,
    status: report.status,
    confirmationToken: report.confirmationToken,
    canaryCount: report.canaryCount,
    selectedBucket: report.selectedBucket,
    selectedPlatform: report.selectedPlatform,
    routeCalls: report.routeCalls,
    snapshotPath: report.snapshotPath,
    postconditionsVerified: report.postconditionsVerified,
    failure: report.failure,
    reportPath,
  }, null, 2));
}

const isDirectRun = process.argv[1]?.includes("run_benchmark_recovery_canary") === true;
if (isDirectRun) {
  const args = parseBenchmarkRecoveryCanaryArgs(process.argv.slice(2));
  if (args.help) {
    console.info("Guarded benchmark canary. Default is preflight; apply requires --apply --confirm TOKEN and a loopback --base-url.");
  } else {
    runBenchmarkRecoveryCanary(args)
      .then((report) => {
        printSummary(report, path.resolve(process.cwd(), args.report));
        if (report.status === "failed") process.exitCode = 1;
      })
      .catch((error: unknown) => {
        console.error(`[benchmark recovery canary] ${error instanceof Error ? error.message : "failed"}`);
        process.exitCode = 1;
      });
  }
}
