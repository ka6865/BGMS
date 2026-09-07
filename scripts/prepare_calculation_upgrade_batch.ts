import { calculateUpgradeFromOfficialRaw } from "./calculation_upgrade_raw";
/**
 * Read-only calculation-upgrade discovery.
 *
 * It selects recent existing analysis samples, but only prepares rows backed by
 * an explicitly catalogued local official match + raw telemetry pair. R2 map
 * projections are recorded as retention evidence and are never used as input.
 */
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { getValidFullResultForMatch, hasCurrentCalculation } from "../lib/pubg-analysis/cacheIdentity";
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from "../lib/pubg-analysis/constants";
import { buildBenchmarkRow, type AnalysisSource } from "../lib/pubg-analysis/persistMatchAnalysis";
import { normalizeName } from "../lib/pubg-analysis/utils";
import {
  buildCalculationUpgradeManifest,
  normalizeCalculationUpgradeLimits,
  type CalculationUpgradeDecision,
  type CalculationUpgradeIdentity,
  type CalculationUpgradeLimits,
  type CalculationUpgradeCounters,
  summarizeCalculationUpgradeDecisions,
} from "./calculation_upgrade_batch";

type Platform = "steam" | "kakao";
type RawCatalogEntry = {
  kind: "local_official_raw";
  matchId: string;
  platform: Platform;
  matchFile: string;
  telemetryFile: string;
};
type RawCatalog = { version: 1; sources: RawCatalogEntry[] };
type RawSource = { match: any; telemetry: any[]; matchFile: string; telemetryFile: string; uniqueBytes: number };
type Upgrade = {
  p_match_id: string;
  p_platform: Platform;
  p_player_id: string;
  p_expected_data: unknown;
  p_expected_benchmark: unknown;
  p_full_result: unknown;
  p_benchmark: unknown;
};

const { values } = parseArgs({ options: {
  catalog: { type: "string" }, output: { type: "string", default: "tmp/calculation-upgrade-prepared.json" },
  "batch-size": { type: "string", default: "10" }, "scan-limit": { type: "string", default: "100" },
  "max-source-bytes": { type: "string", default: String(32 * 1024 * 1024) },
  "max-total-source-bytes": { type: "string", default: String(160 * 1024 * 1024) },
  "max-requests": { type: "string", default: "50" }, "max-run-ms": { type: "string", default: "120000" },
  "player-id": { type: "string" }, platform: { type: "string" }, "match-id": { type: "string", multiple: true }, "pending-only": { type: "boolean", default: false },
  cursor: { type: "string", default: "0" },
} });

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid_${name}`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid_${name}`);
  return parsed;
}

const limits: CalculationUpgradeLimits = normalizeCalculationUpgradeLimits({
  maxBatch: positiveInteger(values["batch-size"], "batch_size"),
  maxScan: positiveInteger(values["scan-limit"], "scan_limit"),
  maxSourceBytes: positiveInteger(values["max-source-bytes"], "max_source_bytes"),
  maxTotalSourceBytes: positiveInteger(values["max-total-source-bytes"], "max_total_source_bytes"),
  maxRequests: positiveInteger(values["max-requests"], "max_requests"),
  maxRunMs: positiveInteger(values["max-run-ms"], "max_run_ms"),
});
const cursor = nonNegativeInteger(values.cursor, "cursor");
const playerIdFilter = values["player-id"] ? normalizeName(values["player-id"]!) : undefined;
const pendingOnly = values["pending-only"] === true;
if (values.platform && !["steam", "kakao"].includes(values.platform)) throw new Error("invalid_platform");
const matchIdFilters = (values["match-id"] ?? []).map((value) => String(value).trim().toLowerCase());
if (matchIdFilters.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(matchIdFilters).size !== matchIdFilters.length) throw new Error("invalid_match_id");
if (values["player-id"] !== undefined && !playerIdFilter) throw new Error("invalid_player_id");

const counters: CalculationUpgradeCounters = {
  databaseReads: 0, databaseWrites: 0, localSourceBytes: 0, providerCalls: 0, upstreamDownloads: 0, errors: 0,
};
const startedAt = Date.now();
const ensureTime = () => {
  if (Date.now() - startedAt > limits.maxRunMs) throw new Error("calculation_upgrade_discovery_time_cap");
};
const identityKey = (identity: CalculationUpgradeIdentity) => `${identity.platform}/${identity.matchId}/${identity.playerId}`;
const matchKey = (platform: string, matchId: string) => `${platform}/${matchId}`;

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readRawCatalog(path: string | undefined): Promise<Map<string, RawCatalogEntry>> {
  const defaultPath = resolve("tmp/calculation-upgrade-raw-catalog.json");
  const catalogPath = path ? resolve(path) : defaultPath;
  if (!await fileExists(catalogPath)) return new Map();
  const parsed = JSON.parse(await readFile(catalogPath, "utf8")) as RawCatalog;
  if (parsed?.version !== 1 || !Array.isArray(parsed.sources)) throw new Error("invalid_calculation_upgrade_raw_catalog");
  const sources = new Map<string, RawCatalogEntry>();
  for (const source of parsed.sources) {
    if (source?.kind !== "local_official_raw" || !["steam", "kakao"].includes(source.platform)
      || !source.matchId || !source.matchFile || !source.telemetryFile) throw new Error("invalid_calculation_upgrade_raw_catalog_source");
    const key = matchKey(source.platform, source.matchId);
    if (sources.has(key)) throw new Error("duplicate_calculation_upgrade_raw_catalog_source");
    sources.set(key, { ...source, matchFile: resolve(dirname(catalogPath), source.matchFile), telemetryFile: resolve(dirname(catalogPath), source.telemetryFile) });
  }
  return sources;
}

async function loadRawSource(source: RawCatalogEntry, cache: Map<string, RawSource>): Promise<RawSource> {
  const key = matchKey(source.platform, source.matchId);
  const existing = cache.get(key);
  if (existing) return existing;
  const [matchInfo, telemetryInfo] = await Promise.all([stat(source.matchFile), stat(source.telemetryFile)]);
  if (!matchInfo.isFile() || !telemetryInfo.isFile()) throw new Error("raw_source_not_regular_file");
  const uniqueBytes = matchInfo.size + telemetryInfo.size;
  if (uniqueBytes > limits.maxSourceBytes || counters.localSourceBytes + uniqueBytes > limits.maxTotalSourceBytes) {
    throw new Error("raw_source_byte_cap");
  }
  const [matchText, telemetryText] = await Promise.all([readFile(source.matchFile, "utf8"), readFile(source.telemetryFile, "utf8")]);
  const raw = { match: JSON.parse(matchText), telemetry: JSON.parse(telemetryText), matchFile: source.matchFile, telemetryFile: source.telemetryFile, uniqueBytes };
  if (!Array.isArray(raw.telemetry)) throw new Error("raw_telemetry_not_array");
  counters.localSourceBytes += uniqueBytes;
  cache.set(key, raw);
  return raw;
}

function registryEvidence(rows: any[], identity: CalculationUpgradeIdentity): CalculationUpgradeDecision["registry"] {
  const matching = rows.filter((row) => row.match_id === identity.matchId && row.platform === identity.platform);
  return {
    rows: matching.length,
    modes: [...new Set(matching.map((row) => String(row.mode)))].sort(),
    versions: [...new Set(matching.map((row) => Number(row.telemetry_version)).filter(Number.isFinite))].sort((left, right) => left - right),
    sourceEligible: false,
  };
}

function buildUpgrade(identity: CalculationUpgradeIdentity, processed: any, benchmark: any, source: RawSource): Upgrade | "benchmark_ineligible" {
  const { full, matchAttr } = calculateUpgradeFromOfficialRaw(identity, processed, source);
  // Preserve the source marker observed in the complete benchmark snapshot.
  // A missing/unknown marker is unsafe to overwrite because it would silently
  // change provenance while upgrading only the calculation payload.
  const benchmarkSource = benchmark?.source;
  if (benchmarkSource !== "user" && benchmarkSource !== "scraper") throw new Error("benchmark_source_invalid");
  const nextBenchmark = buildBenchmarkRow({ matchId: identity.matchId, platform: identity.platform, playerNickname: identity.playerId, source: benchmarkSource as AnalysisSource, forceBenchmark: false, finalResult: full, matchAttr });
  if (!nextBenchmark) return "benchmark_ineligible";
  return { p_match_id: identity.matchId, p_platform: identity.platform, p_player_id: identity.playerId, p_expected_data: processed.data, p_expected_benchmark: benchmark, p_full_result: full, p_benchmark: nextBenchmark };
}

dotenv.config({ path: ".env.local", quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Supabase server environment required");
if (limits.maxRequests < 5) throw new Error("calculation_upgrade_discovery_request_cap_below_5");
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const rawCatalog = await readRawCatalog(values.catalog);
const sourceCache = new Map<string, RawSource>();
let sampleQuery = pendingOnly
  ? db.from("global_benchmarks").select("match_id,platform,player_id,created_at").in("platform", ["steam", "kakao"]).or("calculation_version.is.null,calculation_version.lt.2").eq("filter_version", 8).eq("population_evidence_version", 1).in("match_type", ["official", "competitive"])
  : db.from("match_stats_raw").select("match_id,platform,player_id,created_at").in("platform", ["steam", "kakao"]).eq("is_analysis_sample", true);
if (values.platform) sampleQuery = sampleQuery.eq("platform", values.platform);
if (playerIdFilter) sampleQuery = sampleQuery.eq("player_id", playerIdFilter);
if (matchIdFilters.length > 0) sampleQuery = sampleQuery.in("match_id", matchIdFilters);
const sampleResult = await sampleQuery.order("created_at", { ascending: false }).order("match_id", { ascending: true }).order("platform", { ascending: true }).order("player_id", { ascending: true }).range(cursor, cursor + limits.maxScan - 1).abortSignal(AbortSignal.timeout(15_000));
counters.databaseReads += 1;
if (sampleResult.error) throw new Error(`match_stats_raw_read_failed:${sampleResult.error.code}`);
const samples = sampleResult.data ?? [];
const matchIds = [...new Set(samples.map((row: any) => String(row.match_id)))];
const [processedResult, benchmarkResult, masterResult, registryResult] = await Promise.all([
  db.from("processed_match_telemetry").select("match_id,platform,player_id,data,updated_at").in("match_id", matchIds).abortSignal(AbortSignal.timeout(15_000)),
  // The RPC compare-and-swap guard compares the complete benchmark row, so
  // retain every column in the prepared snapshot rather than only its key.
  db.from("global_benchmarks").select("*").in("match_id", matchIds).abortSignal(AbortSignal.timeout(15_000)),
  db.from("match_master_telemetry").select("match_id,telemetry_version,storage_path").in("match_id", matchIds).abortSignal(AbortSignal.timeout(15_000)),
  db.from("telemetry_map_cache_entries").select("match_id,platform,player_id,mode,telemetry_version,storage_path,status").in("match_id", matchIds).abortSignal(AbortSignal.timeout(15_000)),
]);
counters.databaseReads += 4;
for (const result of [processedResult, benchmarkResult, masterResult, registryResult]) if (result.error) throw new Error(`calculation_upgrade_metadata_read_failed:${result.error.code}`);
const processedByIdentity = new Map((processedResult.data ?? []).map((row: any) => [identityKey({ matchId: row.match_id, platform: row.platform, playerId: row.player_id }), row]));
const benchmarkByIdentity = new Map((benchmarkResult.data ?? []).map((row: any) => [identityKey({ matchId: row.match_id, platform: row.platform, playerId: row.player_id }), row]));
const decisions: CalculationUpgradeDecision[] = [];
const upgrades: Upgrade[] = [];
for (const row of samples) {
  ensureTime();
  const platform = row.platform as Platform;
  const identity = { matchId: String(row.match_id), platform, playerId: normalizeName(String(row.player_id)) };
  const processed = processedByIdentity.get(identityKey(identity));
  const benchmark = benchmarkByIdentity.get(identityKey(identity));
  const registry = registryEvidence(registryResult.data ?? [], identity);
  const old = getValidFullResultForMatch(processed, { matchId: identity.matchId, platform, playerId: identity.playerId, minResultVersion: RESULT_VERSION, requireExactResultVersion: true });
  if (!old) { decisions.push({ identity, status: "canonical_missing", reasons: ["canonical_full_result_missing_or_wrong_version"], registry }); continue; }
  if (!benchmark) { decisions.push({ identity, status: "benchmark_missing", reasons: ["benchmark_row_missing"], registry }); continue; }
  if (hasCurrentCalculation(old) && benchmark.calculation_version === ANALYSIS_CALCULATION_VERSION) { decisions.push({ identity, status: "already_current", reasons: ["calculation_version_current"], registry }); continue; }
  if (upgrades.length >= limits.maxBatch) { decisions.push({ identity, status: "deferred_batch_limit", reasons: ["deferred_batch_limit"], registry }); continue; }
  const catalogSource = rawCatalog.get(matchKey(platform, identity.matchId));
  if (!catalogSource) { decisions.push({ identity, status: "raw_unavailable", reasons: ["official_raw_catalog_entry_missing", "r2_map_projection_not_used_as_raw"], registry }); continue; }
  try {
    const source = await loadRawSource(catalogSource, sourceCache);
    const upgrade = buildUpgrade(identity, processed, benchmark, source);
    if (upgrade === "benchmark_ineligible") { decisions.push({ identity, status: "benchmark_ineligible", reasons: ["canonical_bucket_ineligible"], registry }); continue; }
    const upgradeIndex = upgrades.length;
    upgrades.push(upgrade);
    decisions.push({ identity, status: "prepared", reasons: ["official_raw_identity_and_full_calculation_fields_verified"], source: { kind: "local_official_raw", matchFile: source.matchFile, telemetryFile: source.telemetryFile, uniqueBytes: source.uniqueBytes }, registry, upgradeIndex });
  } catch (error) {
    const message = error instanceof Error ? error.message : "raw_source_invalid";
    const status = message === "raw_source_byte_cap" ? "source_byte_cap" : "raw_unavailable";
    decisions.push({ identity, status, reasons: [message], registry });
  }
}
const manifest = buildCalculationUpgradeManifest({
  generatedAt: new Date().toISOString(), project: new URL(url).hostname, calculationVersion: ANALYSIS_CALCULATION_VERSION,
  limits, counters, discovery: { cursor, ...(pendingOnly ? { pendingOnly: true } : {}), ...(playerIdFilter ? { playerId: playerIdFilter } : {}), ...(matchIdFilters.length > 0 ? { matchIds: matchIdFilters } : {}), ...(samples.length === limits.maxScan ? { nextCursor: cursor + samples.length } : {}), scanned: samples.length }, decisions, upgrades,
});
await writeFile(values.output!, JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify({
  dryRun: true, phase: manifest.phase, output: resolve(values.output!), scanned: samples.length, cursor: manifest.discovery,
  decisionCounts: summarizeCalculationUpgradeDecisions(decisions), counters, masterRows: masterResult.data?.length ?? 0,
  registryRows: registryResult.data?.length ?? 0, providerCalls: 0, upstreamDownloads: 0,
}, null, 2));
