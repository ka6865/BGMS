/**
 * Read-only benchmark recovery canary planner.
 *
 * Usage:
 *   npx tsx scripts/plan_benchmark_recovery.ts
 *
 * The command reads benchmark/history/processed rows, writes a local JSON
 * manifest, and never invokes an analysis route or a data/storage mutator.
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_RECOVERY_CANARY_SIZE,
  BENCHMARK_RECOVERY_SNAPSHOT_COLUMNS,
  BENCHMARK_RECOVERY_DEFAULT_RECENT_DAYS,
  DEFAULT_BENCHMARK_RECOVERY_BUCKET,
  DEFAULT_BENCHMARK_RECOVERY_PLATFORM,
  buildBenchmarkRecoveryInput,
  planBenchmarkRecoveryCanary,
  toBenchmarkRecoveryManifestDecision,
  trustedMarkerSummary,
  type BenchmarkRecoveryBenchmarkRow,
  type BenchmarkRecoveryBucket,
  type BenchmarkRecoveryCandidateInput,
  type BenchmarkRecoveryPlan,
  type BenchmarkRecoveryPlayerMatchRow,
  type BenchmarkRecoveryProcessedRow,
  type BenchmarkRecoverySnapshot,
  type BenchmarkRecoveryPlatform,
} from "../lib/pubg-analysis/benchmarkRecoveryPlanner";
import { isCanonicalBenchmarkTier, isTrustedBenchmarkAggregate } from "../lib/pubg-analysis/benchmarkLookup";
import { evaluateMatchEligibility } from "../lib/pubg-analysis/matchEligibility";
import { normalizeMatchId } from "../lib/pubg-analysis/recentMatchSelection";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
dotenv.config({ quiet: true });

export const BENCHMARK_RECOVERY_DEFAULT_OUTPUT = "tmp/benchmark-recovery-canary-plan.json";
export const BENCHMARK_RECOVERY_DEFAULT_PAGE_SIZE = 1_000;
export const BENCHMARK_RECOVERY_DEFAULT_MAX_ROWS = 50_000;
// PostgREST deployments commonly cap a response page at 1,000 rows. Keep the
// client-side bound at that cap so a requested larger page cannot make the
// pagination loop stop early and silently omit rows.
export const BENCHMARK_RECOVERY_MAX_PAGE_SIZE = 1_000;
export const BENCHMARK_RECOVERY_MAX_ROWS = 100_000;
export const BENCHMARK_RECOVERY_MATCH_ID_CHUNK_SIZE = 200;

const GLOBAL_BENCHMARK_COLUMNS = [
  "id",
  "match_id",
  "player_id",
  "platform",
  "created_at",
  ...BENCHMARK_RECOVERY_SNAPSHOT_COLUMNS,
].join(", ");

const PLAYER_MATCH_COLUMNS = [
  "match_id",
  "player_id",
  "platform",
  "played_at",
  "game_mode",
  "match_type",
  "map_name",
].join(", ");

const PROCESSED_TELEMETRY_COLUMNS = ["match_id", "player_id", "platform", "data"].join(", ");

type ReadQueryResult = {
  data: unknown;
  error: unknown;
};

type ReadQuery = {
  select(columns: string): ReadQuery;
  order(column: string, options?: { ascending?: boolean }): ReadQuery;
  in(column: string, values: readonly string[]): ReadQuery;
  range(from: number, to: number): Promise<ReadQueryResult>;
};

export type ReadOnlySupabaseClient = {
  from(table: string): ReadQuery;
};

export type BenchmarkRecoveryPlannerArgs = {
  output: string;
  recentDays: number;
  pageSize: number;
  maxRows: number;
  preferredBucket: Partial<BenchmarkRecoveryBucket>;
  preferredPlatform: BenchmarkRecoveryPlatform;
  json: boolean;
};

export type BenchmarkRecoveryManifest = {
  schemaVersion: "benchmark-recovery-canary-v1";
  mode: "read-only-dry-run";
  generatedAt: string;
  criteria: {
    recentDays: number;
    recentSince: string;
    cohortSize: number;
    preferredBucket: BenchmarkRecoveryBucket;
    preferredPlatform: BenchmarkRecoveryPlatform;
    trustedMarkers: ReturnType<typeof trustedMarkerSummary>;
  };
  sources: {
    globalBenchmarkRows: number;
    playerMatchRows: number;
    processedTelemetryRows: number;
    truncated: boolean;
  };
  selectionStatus: "selected" | "insufficient_cohort";
  selectedBucket: BenchmarkRecoveryBucket | null;
  selectedPlatform: BenchmarkRecoveryPlatform | null;
  canaryCount: number;
  eligibleCount: number;
  ineligibleCount: number;
  reasonCounts: Record<string, number>;
  viableBuckets: Array<BenchmarkRecoveryBucket & {
    platform: BenchmarkRecoveryPlatform;
    eligibleCount: number;
  }>;
  canary: Array<Record<string, unknown>>;
  /**
   * The exact read facts used to select every canary identity.  This is kept
   * separate from the redacted canary projection so the executor can compare
   * the database again immediately before each route call.
   */
  readEvidence: Array<{
    benchmarkId: string | number;
    matchId: string;
    playerId: string;
    platform: BenchmarkRecoveryPlatform;
    gameMode: string;
    matchType: string;
    tier: string;
    playedAt: string;
    isValidBenchmark: true;
    snapshot: BenchmarkRecoverySnapshot;
  }>;
  databaseWritesAttempted: 0;
  storageWritesAttempted: 0;
  externalApiCalls: 0;
};

type ReadRowsResult<T> = {
  rows: T[];
  truncated: boolean;
};

type RunDependencies = {
  supabase?: ReadOnlySupabaseClient;
  now?: () => number;
  writeLocal?: (filePath: string, content: string) => Promise<void>;
};

function parsePositiveNumber(
  args: string[],
  name: string,
  fallback: number,
  maximum: number,
): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(value, maximum);
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function parsePreferredBucket(args: string[]): Partial<BenchmarkRecoveryBucket> {
  const gameMode = valueAfter(args, "--game-mode");
  const matchType = valueAfter(args, "--match-type");
  const tier = valueAfter(args, "--tier");
  if (args.includes("--tier") && !tier) {
    throw new Error("invalid tier: expected one of S+, S, A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-");
  }
  if (tier && !isCanonicalBenchmarkTier(tier.trim().toUpperCase())) {
    throw new Error("invalid tier: expected one of S+, S, A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-");
  }
  const normalizedGameMode = gameMode?.trim().toLowerCase() || DEFAULT_BENCHMARK_RECOVERY_BUCKET.gameMode;
  const normalizedMatchType = matchType?.trim().toLowerCase() || DEFAULT_BENCHMARK_RECOVERY_BUCKET.matchType;
  const eligibility = evaluateMatchEligibility({
    gameMode: normalizedGameMode,
    matchType: normalizedMatchType,
  }, "benchmark");
  if (!eligibility.eligible
    || eligibility.mode !== normalizedGameMode
    || eligibility.matchType !== normalizedMatchType) {
    throw new Error("invalid preferred bucket: expected a canonical human battle-royale mode and official/competitive match type");
  }
  return {
    ...(gameMode ? { gameMode } : {}),
    ...(matchType ? { matchType } : {}),
    ...(tier ? { tier } : {}),
  };
}

function parsePreferredPlatform(args: string[]): BenchmarkRecoveryPlatform {
  const platform = valueAfter(args, "--platform");
  if (!args.includes("--platform")) return DEFAULT_BENCHMARK_RECOVERY_PLATFORM;
  if (!platform) throw new Error("invalid platform: expected steam or kakao");
  const normalized = platform.trim().toLowerCase();
  if (normalized !== "steam" && normalized !== "kakao") {
    throw new Error("invalid platform: expected steam or kakao");
  }
  return normalized;
}

export function parseBenchmarkRecoveryArgs(args: string[]): BenchmarkRecoveryPlannerArgs {
  if (args.includes("--apply")) {
    throw new Error("This read-only planner does not accept --apply");
  }
  if (args.includes("--help")) {
    return {
      output: BENCHMARK_RECOVERY_DEFAULT_OUTPUT,
      recentDays: BENCHMARK_RECOVERY_DEFAULT_RECENT_DAYS,
      pageSize: BENCHMARK_RECOVERY_DEFAULT_PAGE_SIZE,
      maxRows: BENCHMARK_RECOVERY_DEFAULT_MAX_ROWS,
      preferredBucket: parsePreferredBucket(args),
      preferredPlatform: parsePreferredPlatform(args),
      json: args.includes("--json"),
    };
  }

  const knownFlags = new Set([
    "--output",
    "--recent-days",
    "--page-size",
    "--max-rows",
    "--game-mode",
    "--match-type",
    "--tier",
    "--platform",
    "--json",
    "--dry-run",
    "--help",
  ]);
  args.forEach((arg) => {
    if (!arg.startsWith("--") || knownFlags.has(arg)) return;
    throw new Error(`Unknown option: ${arg}`);
  });

  const output = valueAfter(args, "--output") || BENCHMARK_RECOVERY_DEFAULT_OUTPUT;
  return {
    output,
    recentDays: parsePositiveNumber(args, "--recent-days", BENCHMARK_RECOVERY_DEFAULT_RECENT_DAYS, 365),
    pageSize: parsePositiveNumber(args, "--page-size", BENCHMARK_RECOVERY_DEFAULT_PAGE_SIZE, BENCHMARK_RECOVERY_MAX_PAGE_SIZE),
    maxRows: parsePositiveNumber(args, "--max-rows", BENCHMARK_RECOVERY_DEFAULT_MAX_ROWS, BENCHMARK_RECOVERY_MAX_ROWS),
    preferredBucket: parsePreferredBucket(args),
    preferredPlatform: parsePreferredPlatform(args),
    json: args.includes("--json"),
  };
}

function asRows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "unknown read error";
}

async function readRows<T>(options: {
  supabase: ReadOnlySupabaseClient;
  table: string;
  columns: string;
  orderColumns: string[];
  pageSize: number;
  maxRows: number;
  filter?: (query: ReadQuery) => ReadQuery;
}): Promise<ReadRowsResult<T>> {
  if (!Number.isInteger(options.pageSize) || options.pageSize <= 0) {
    throw new Error("pageSize must be a positive integer");
  }
  if (!Number.isInteger(options.maxRows) || options.maxRows <= 0) {
    throw new Error("maxRows must be a positive integer");
  }
  const rows: T[] = [];
  let offset = 0;
  let truncated = false;
  while (rows.length < options.maxRows) {
    let query = options.supabase.from(options.table).select(options.columns);
    if (options.filter) query = options.filter(query);
    options.orderColumns.forEach((column) => {
      query = query.order(column, { ascending: true });
    });
    const result = await query.range(offset, offset + options.pageSize - 1);
    if (result.error) throw new Error(`read_${options.table}: ${errorMessage(result.error)}`);
    const page = asRows(result.data) as T[];
    rows.push(...page.slice(0, options.maxRows - rows.length));
    if (page.length < options.pageSize) break;
    offset += options.pageSize;
  }
  if (rows.length >= options.maxRows) truncated = true;
  return { rows, truncated };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size) as T[]);
  }
  return chunks;
}

function matchIdForRow(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeMatchId((value as { match_id?: unknown }).match_id);
}

function mapRowsByMatchId<T>(rows: readonly T[]): Map<string, T[]> {
  const byMatchId = new Map<string, T[]>();
  rows.forEach((row) => {
    const matchId = matchIdForRow(row);
    if (!matchId) return;
    const existing = byMatchId.get(matchId) || [];
    existing.push(row);
    byMatchId.set(matchId, existing);
  });
  return byMatchId;
}

function candidateMatchIds(rows: readonly BenchmarkRecoveryBenchmarkRow[]): string[] {
  const ids = new Set<string>();
  rows.forEach((row) => {
    if (isTrustedBenchmarkAggregate(row)) return;
    const matchId = normalizeMatchId(row.match_id);
    if (matchId) ids.add(matchId);
  });
  return Array.from(ids).sort();
}

async function readProcessedTelemetry(
  supabase: ReadOnlySupabaseClient,
  matchIds: readonly string[],
  args: BenchmarkRecoveryPlannerArgs,
): Promise<ReadRowsResult<BenchmarkRecoveryProcessedRow>> {
  const rows: BenchmarkRecoveryProcessedRow[] = [];
  let truncated = false;
  for (const ids of chunk(matchIds, BENCHMARK_RECOVERY_MATCH_ID_CHUNK_SIZE)) {
    if (rows.length >= args.maxRows) {
      truncated = true;
      break;
    }
    const result = await readRows<BenchmarkRecoveryProcessedRow>({
      supabase,
      table: "processed_match_telemetry",
      columns: PROCESSED_TELEMETRY_COLUMNS,
      orderColumns: ["match_id", "platform", "player_id"],
      pageSize: args.pageSize,
      maxRows: args.maxRows - rows.length,
      filter: (query) => query.in("match_id", ids),
    });
    rows.push(...result.rows);
    truncated = truncated || result.truncated;
  }
  return { rows, truncated };
}

function identityMatchIdMap(
  rows: readonly BenchmarkRecoveryBenchmarkRow[],
  history: readonly BenchmarkRecoveryPlayerMatchRow[],
  processed: readonly BenchmarkRecoveryProcessedRow[],
): BenchmarkRecoveryCandidateInput[] {
  const historyByMatchId = mapRowsByMatchId(history);
  const processedByMatchId = mapRowsByMatchId(processed);
  return rows.map((benchmark) => {
    const matchId = normalizeMatchId(benchmark.match_id);
    return buildBenchmarkRecoveryInput(
      benchmark,
      matchId ? (historyByMatchId.get(matchId) || []) : [],
      matchId ? (processedByMatchId.get(matchId) || []) : [],
    );
  });
}

function recentSinceIso(now: number, recentDays: number): string {
  return new Date(now - recentDays * 24 * 60 * 60 * 1_000).toISOString();
}

export function buildBenchmarkRecoveryManifest(
  plan: BenchmarkRecoveryPlan,
  input: {
    generatedAt: string;
    recentDays: number;
    recentSince: string;
    preferredBucket?: Partial<BenchmarkRecoveryBucket>;
    globalBenchmarkRows: number;
    playerMatchRows: number;
    processedTelemetryRows: number;
    truncated: boolean;
  },
): BenchmarkRecoveryManifest {
  const canary = plan.selected.map(toBenchmarkRecoveryManifestDecision);
  const readEvidence = plan.selected.map((decision) => {
    const matchId = decision.identity.matchId;
    const playerId = decision.identity.playerId;
    const platform = decision.identity.platform;
    const bucket = decision.bucket;
    const playedAt = decision.playedAt;
    const benchmarkId = decision.benchmarkId;
    const snapshot = decision.benchmarkSnapshot;
    if (!matchId || !playerId || !platform || !bucket || !playedAt
      || (typeof benchmarkId !== "number" && typeof benchmarkId !== "string")
      || !snapshot) {
      throw new Error("selected_decision_read_evidence_incomplete");
    }
    return {
      benchmarkId,
      matchId,
      playerId,
      platform,
      gameMode: bucket.gameMode,
      matchType: bucket.matchType,
      tier: bucket.tier,
      playedAt,
      isValidBenchmark: true as const,
      snapshot,
    };
  });
  return {
    schemaVersion: "benchmark-recovery-canary-v1",
    mode: "read-only-dry-run",
    generatedAt: input.generatedAt,
    criteria: {
      recentDays: input.recentDays,
      recentSince: input.recentSince,
      cohortSize: plan.cohortSize,
      preferredBucket: plan.preferredBucket,
      preferredPlatform: plan.preferredPlatform,
      trustedMarkers: trustedMarkerSummary(),
    },
    sources: {
      globalBenchmarkRows: input.globalBenchmarkRows,
      playerMatchRows: input.playerMatchRows,
      processedTelemetryRows: input.processedTelemetryRows,
      truncated: input.truncated,
    },
    selectionStatus: plan.selectionStatus,
    selectedBucket: plan.selectedBucket,
    selectedPlatform: plan.selectedPlatform,
    canaryCount: plan.selected.length,
    eligibleCount: plan.decisions.filter((decision) => decision.eligible).length,
    ineligibleCount: plan.decisions.filter((decision) => !decision.eligible).length,
    reasonCounts: plan.reasonCounts,
    viableBuckets: plan.viableBuckets,
    canary,
    readEvidence,
    databaseWritesAttempted: 0,
    storageWritesAttempted: 0,
    externalApiCalls: 0,
  };
}

async function createSupabaseServiceClient(): Promise<ReadOnlySupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("missing_supabase_credentials");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as ReadOnlySupabaseClient;
}

export async function runBenchmarkRecoveryDryRun(
  args: BenchmarkRecoveryPlannerArgs = parseBenchmarkRecoveryArgs([]),
  dependencies: RunDependencies = {},
): Promise<BenchmarkRecoveryManifest> {
  const supabase = dependencies.supabase || await createSupabaseServiceClient();
  const now = dependencies.now ? dependencies.now() : Date.now();
  const recentSince = recentSinceIso(now, args.recentDays);

  const global = await readRows<BenchmarkRecoveryBenchmarkRow>({
    supabase,
    table: "global_benchmarks",
    columns: GLOBAL_BENCHMARK_COLUMNS,
    orderColumns: ["id"],
    pageSize: args.pageSize,
    maxRows: args.maxRows,
  });
  const history = await readRows<BenchmarkRecoveryPlayerMatchRow>({
    supabase,
    table: "pubg_player_matches",
    columns: PLAYER_MATCH_COLUMNS,
    orderColumns: ["played_at", "match_id", "platform", "player_id"],
    pageSize: args.pageSize,
    maxRows: args.maxRows,
  });
  const processed = await readProcessedTelemetry(
    supabase,
    candidateMatchIds(global.rows),
    args,
  );

  const inputs = identityMatchIdMap(global.rows, history.rows, processed.rows);
  const plan = planBenchmarkRecoveryCanary(inputs, {
    recentSince,
    now,
    preferredBucket: args.preferredBucket,
    preferredPlatform: args.preferredPlatform,
    cohortSize: BENCHMARK_RECOVERY_CANARY_SIZE,
  });
  const manifest = buildBenchmarkRecoveryManifest(plan, {
    generatedAt: new Date(now).toISOString(),
    recentDays: args.recentDays,
    recentSince,
    preferredBucket: args.preferredBucket,
    globalBenchmarkRows: global.rows.length,
    playerMatchRows: history.rows.length,
    processedTelemetryRows: processed.rows.length,
    truncated: global.truncated || history.truncated || processed.truncated,
  });

  const outputPath = path.resolve(process.cwd(), args.output);
  const writeLocal = dependencies.writeLocal || (async (filePath: string, content: string) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  });
  await writeLocal(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return manifest;
}

function printSummary(manifest: BenchmarkRecoveryManifest, output: string, json: boolean): void {
  if (json) {
    console.info(JSON.stringify(manifest, null, 2));
    return;
  }
  console.info(JSON.stringify({
    mode: manifest.mode,
    output,
    globalBenchmarkRows: manifest.sources.globalBenchmarkRows,
    recentPlayerMatchRows: manifest.sources.playerMatchRows,
    processedTelemetryRows: manifest.sources.processedTelemetryRows,
    eligible: manifest.eligibleCount,
    ineligible: manifest.ineligibleCount,
    selectionStatus: manifest.selectionStatus,
    selectedBucket: manifest.selectedBucket,
    selectedPlatform: manifest.selectedPlatform,
    canaryCount: manifest.canaryCount,
    reasonCounts: manifest.reasonCounts,
    databaseWritesAttempted: manifest.databaseWritesAttempted,
    storageWritesAttempted: manifest.storageWritesAttempted,
    externalApiCalls: manifest.externalApiCalls,
  }, null, 2));
}

const isDirectRun = process.argv[1]?.includes("plan_benchmark_recovery") === true;
if (isDirectRun) {
  const args = parseBenchmarkRecoveryArgs(process.argv.slice(2));
  if (process.argv.includes("--help")) {
    console.info("Read-only benchmark canary planner. Options: --recent-days N --game-mode MODE --match-type TYPE --tier TIER --platform steam|kakao --output PATH --json");
  } else {
    runBenchmarkRecoveryDryRun(args)
      .then((manifest) => printSummary(manifest, path.resolve(process.cwd(), args.output), args.json))
      .catch(() => {
        console.error("[benchmark recovery planner] failed (read-only query or local manifest)");
        process.exitCode = 1;
      });
  }
}
