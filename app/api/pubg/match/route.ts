import { createHash, timingSafeEqual } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { revalidateTag, unstable_cache } from "next/cache"; // [ISR V1.0] Next.js 16 캐싱 API
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION, TELEMETRY_VERSION } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";
import { filterTelemetryEvents } from "@/lib/pubg-analysis/telemetryContract";
import { adaptBenchmark } from "@/lib/pubg-analysis/benchmarkAdapter";
import {
  BENCHMARK_FILTER_VERSION,
  fetchTierBenchmarkStats,
  isCanonicalBenchmarkTier,
} from "@/lib/pubg-analysis/benchmarkLookup";
import {
  buildProcessedTelemetryUpsert,
  getValidFullResultForMatch,
  normalizePlatform,
} from "@/lib/pubg-analysis/cacheIdentity";
import {
  downloadFromR2,
  deleteObjectsFromR2,
  getPresignedUrlFromR2,
  isR2Configured,
  uploadToR2,
} from "@/lib/pubg-analysis/r2Service";
import {
  claimOrWaitForTelemetryMapCache,
  claimTelemetryMapCacheRow,
  releaseTelemetryMapCacheRow,
  writeTelemetryMapCache,
  type TelemetryMapCacheRegistryRow,
} from "@/lib/pubg-analysis/telemetryMapCache";
import {
  claimTelemetryMapCacheReservation,
  claimTelemetryMapCacheRecoveryReservation,
  finalizeTelemetryMapCacheLifecycle,
  finalizeRecoveryAtomically,
  releaseTelemetryMapCacheReservation,
  TelemetryRegistryError,
} from "@/lib/pubg-analysis/telemetryRegistry.server";
import {
  createTelemetryIdentity,
  hasMatchingUpstreamMatchId,
  isCanonicalMatchId,
} from "@/lib/pubg-analysis/telemetryIdentity";
import {
  buildTelemetryCacheKey,
  buildTelemetryAnalyzeCacheKey,
  buildTelemetryPublicIdentity,
  createTelemetryAnalyzeCacheEnvelope,
  parseTelemetryAnalyzeCacheEnvelope,
  pseudonymizeTelemetryAccountIds,
  pseudonymizeTelemetryTeammates,
} from "@/lib/pubg-analysis/telemetryCacheKey.server";
import { createTelemetryPayload } from "@/lib/pubg-analysis/telemetryPayload";
import { trackPubgRateLimit } from "@/lib/pubg-analysis/pubgApiTracker";
import {
  buildBenchmarkRow,
  persistMatchAnalysis,
  type AnalysisSource,
  type PubgPlatform,
  type RecoveryBenchmarkGuard,
} from "@/lib/pubg-analysis/persistMatchAnalysis";
import type {
  RecoveryFinalizeRows,
  RecoveryBenchmarkGuard as RegistryRecoveryBenchmarkGuard,
  RecoveryProcessedGuard,
} from "@/lib/pubg-analysis/telemetryRegistry.server";
import {
  reportPubgApiError,
  type PubgApiErrorContext,
} from "@/lib/pubg/apiHelper";
import {
  classifyClientKind,
  classifyPubgMatchError,
  createPubgIdentifierFingerprint,
  type PubgAnalysisStep,
  type PubgErrorStage,
} from "@/lib/pubg/apiErrorContext";
import {
  isDatabaseCircuitOpen,
  isDatabaseUnavailableError,
  noteDatabaseAvailable,
  noteDatabaseUnavailable,
} from "@/lib/pubg/databaseCircuitBreaker";
import { evaluateMatchEligibility } from "@/lib/pubg-analysis/matchEligibility";

// [ISR V1.0] force-dynamic 유지: PUBG API 호출, R2 업로드, DB Upsert 등 부수효과 보호
// unstable_cache는 DB 읽기(캐시 조회) 전용 프록시로만 사용
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 45;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function safeJsonParse(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    throw new Error(`PUBG API 응답이 JSON 형식이 아닙니다 (Content-Type: ${contentType}, Status: ${res.status}). API 호출 한도 초과 또는 일시적인 장애일 수 있습니다.`);
  }
  try {
    return await res.json();
  } catch (err: any) {
    throw new Error(`JSON 파싱 실패: ${err.message}`);
  }
}

const MAP_NAMES: Record<string, string> = {
  "Baltic_Main": "에란겔", "Savage_Main": "사녹", "Desert_Main": "미라마",
  "Summerland_Main": "카라킨", "Chimera_Main": "파라모", "Tiger_Main": "태이고",
  "Kiki_Main": "데스턴", "Neon_Main": "론도", "DihorOtok_Main": "비켄디"
};

/**
 * [ISR V1.0] Supabase DB 조회를 Next.js 16 unstable_cache로 래핑
 * - Cache Hit 시: DB 커넥션 0건, 메모리/Edge 캐시에서 즉시 반환
 * - Cache Miss 시: DB 1회 조회 후 결과를 캐시에 자동 적재
 * - revalidateTag('match-analysis') 호출 시: 모든 캐시 엔트리 즉각 만료
 */
const getCachedMatchTelemetry = unstable_cache(
  async (matchId: string, lowerNickname: string, platform: string) => {
    const { data: cachedResult, error } = await supabase
      .from("processed_match_telemetry")
      .select("match_id, player_id, platform, data")
      .eq("match_id", matchId)
      .eq("platform", normalizePlatform(platform))
      .eq("player_id", lowerNickname)
      .retry(false)
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();

    if (error) {
      throw error;
    }
    return cachedResult || null;
  },
  ["match-telemetry"], // 캐시 네임스페이스 키
  {
    tags: ["match-analysis"], // revalidateTag('match-analysis')로 무효화
    revalidate: 604800 // 7일간 캐시 보존 (배포 시 revalidateTag로 즉시 소각)
  }
);

/**
 * Recovery is a privileged race-sensitive protocol.  Its initial
 * unstable_cache read is only a cheap gate; immediately before recovery
 * telemetry/R2 work we must re-read the canonical processed row from Supabase
 * so a cached v72 claim cannot survive a concurrent v73 update.
 */
async function readFreshRecoveryTelemetry(
  matchId: string,
  lowerNickname: string,
  platform: PubgPlatform,
): Promise<any | null> {
  const { data, error } = await supabase
    .from("processed_match_telemetry")
    .select("match_id, player_id, platform, data")
    .eq("match_id", matchId)
    .eq("platform", normalizePlatform(platform))
    .eq("player_id", lowerNickname)
    .retry(false)
    .abortSignal(AbortSignal.timeout(5_000))
    .maybeSingle();
  if (error) throw error;
  noteDatabaseAvailable();
  return data || null;
}

const RECOVERY_GLOBAL_BENCHMARK_COLUMNS = [
  "id",
  "match_id",
  "player_id",
  "platform",
  "game_mode",
  "match_type",
  "tier",
  "filter_version",
  "population_evidence_version",
].join(",");

type RecoveryBenchmarkBucket = Pick<RecoveryBenchmarkGuard, "gameMode" | "matchType" | "tier">;

function recoveryGlobalMarkerError(): BenchmarkRecoveryError {
  return new BenchmarkRecoveryError(
    "BENCHMARK_RECOVERY_GLOBAL_BENCHMARK_CHANGED",
    409,
    "benchmark recovery global benchmark marker changed",
  );
}

function recoveryGlobalReadError(): BenchmarkRecoveryError {
  return new BenchmarkRecoveryError(
    "BENCHMARK_RECOVERY_GLOBAL_BENCHMARK_UNAVAILABLE",
    503,
    "benchmark recovery global benchmark read failed",
  );
}

function recoveryGlobalBenchmarkBucket(
  matchAttr: unknown,
  fullResult: Record<string, unknown>,
): RecoveryBenchmarkBucket | null {
  const eligibilityInput = {
    ...(isRecord(matchAttr) ? matchAttr : {}),
    ...fullResult,
  };
  const eligibility = evaluateMatchEligibility(eligibilityInput, "benchmark");
  const benchmark = isRecord(fullResult.benchmark) ? fullResult.benchmark : null;
  const matchInfo = isRecord(fullResult.matchInfo) ? fullResult.matchInfo : null;
  const rawTier = benchmark?.tier ?? matchInfo?.tier;
  const tier = typeof rawTier === "string" ? rawTier.trim().toUpperCase() : null;
  if (!eligibility.eligible
    || !eligibility.mode
    || !eligibility.matchType
    || !tier
    || !isCanonicalBenchmarkTier(tier)) {
    return null;
  }
  return {
    gameMode: eligibility.mode,
    matchType: eligibility.matchType,
    tier,
  };
}

function recoveryGlobalMarker(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function sameRecoveryBenchmarkGuard(
  left: RecoveryBenchmarkGuard,
  right: RecoveryBenchmarkGuard,
): boolean {
  return left.id === right.id
    && left.matchId === right.matchId
    && left.playerId === right.playerId
    && left.platform === right.platform
    && left.gameMode === right.gameMode
    && left.matchType === right.matchType
    && left.tier === right.tier
    && left.filterVersion === right.filterVersion
    && left.populationEvidenceVersion === right.populationEvidenceVersion;
}

/**
 * Bind recovery to the exact legacy benchmark row before reserving the
 * telemetry cache.  The marker values are returned for persistence's atomic
 * compare-and-swap; a read alone is intentionally not authorization.
 */
async function readFreshRecoveryBenchmarkGuard(
  matchId: string,
  lowerNickname: string,
  platform: PubgPlatform,
  matchAttr: unknown,
  fullResult: Record<string, unknown>,
): Promise<RecoveryBenchmarkGuard> {
  const { data, error } = await supabase
    .from("global_benchmarks")
    .select(RECOVERY_GLOBAL_BENCHMARK_COLUMNS)
    .eq("match_id", matchId)
    .eq("platform", normalizePlatform(platform))
    .eq("player_id", lowerNickname)
    .retry(false)
    .abortSignal(AbortSignal.timeout(5_000))
    .maybeSingle();
  if (error) throw recoveryGlobalReadError();
  noteDatabaseAvailable();

  const row = isRecord(data) ? data : null;
  const hasValidRowId = row !== null && (typeof row.id === "number"
    ? Number.isSafeInteger(row.id)
    : typeof row.id === "string" && /^\d+$/.test(row.id));
  if (!row
    || !hasValidRowId
    || normalizeMatchId(row.match_id) !== matchId
    || typeof row.player_id !== "string"
    || normalizeName(row.player_id) !== lowerNickname
    || typeof row.platform !== "string"
    || normalizePlatform(row.platform) !== platform) {
    throw recoveryGlobalMarkerError();
  }

  const bucket = recoveryGlobalBenchmarkBucket(matchAttr, fullResult);
  if (!bucket
    || row.game_mode !== bucket.gameMode
    || row.match_type !== bucket.matchType
    || row.tier !== bucket.tier) {
    throw recoveryGlobalMarkerError();
  }

  const filterVersion = recoveryGlobalMarker(row.filter_version);
  const populationEvidenceVersion = recoveryGlobalMarker(row.population_evidence_version);
  // Recovery may only upgrade the known legacy population.  A current marker
  // or any unknown/future non-null marker is never overwritten.
  if (filterVersion === undefined
    || populationEvidenceVersion === undefined
    || populationEvidenceVersion !== null
    || (filterVersion !== null && filterVersion > BENCHMARK_FILTER_VERSION)) {
    throw recoveryGlobalMarkerError();
  }

  return {
    id: row.id as number | string,
    matchId,
    playerId: lowerNickname,
    platform,
    gameMode: bucket.gameMode,
    matchType: bucket.matchType,
    tier: bucket.tier,
    filterVersion,
    populationEvidenceVersion,
  };
}

const MAP_IDS: Record<string, string> = {
  "Baltic_Main": "erangel", "Savage_Main": "sanhok", "Desert_Main": "miramar",
  "Summerland_Main": "karakin", "Chimera_Main": "paramo", "Tiger_Main": "taego",
  "Kiki_Main": "deston", "Neon_Main": "rondo", "DihorOtok_Main": "vikendi"
};

const MATCH_NOT_FOUND_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_MATCH_NOT_FOUND_CACHE_SIZE = 2_000;
const matchNotFoundCache = new Map<string, number>();

function matchNotFoundCacheKey(platform: string, matchId: string): string {
  return `${platform}:${matchId}`;
}

function isRecentlyNotFound(platform: string, matchId: string): boolean {
  const key = matchNotFoundCacheKey(platform, matchId);
  const expiresAt = matchNotFoundCache.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    matchNotFoundCache.delete(key);
    return false;
  }
  return true;
}

function rememberNotFound(platform: string, matchId: string): void {
  if (matchNotFoundCache.size >= MAX_MATCH_NOT_FOUND_CACHE_SIZE) {
    const oldestKey = matchNotFoundCache.keys().next().value;
    if (oldestKey) matchNotFoundCache.delete(oldestKey);
  }
  matchNotFoundCache.set(
    matchNotFoundCacheKey(platform, matchId),
    Date.now() + MATCH_NOT_FOUND_CACHE_TTL_MS,
  );
}

export function clearMatchNotFoundCache(): void {
  matchNotFoundCache.clear();
}

function matchNotFoundResponse() {
  return NextResponse.json(
    {
      error: "PUBG에서 해당 매치 데이터를 더 이상 제공하지 않습니다. 저장된 기본 전적은 계속 확인할 수 있습니다.",
      errorCode: "PUBG_MATCH_NOT_FOUND",
      retryable: false,
    },
    { status: 404, headers: { "Cache-Control": "private, max-age=21600" } },
  );
}

function getConfiguredToken(name: "PUBG_SCRAPER_INTERNAL_TOKEN" | "ADMIN_REVALIDATE_TOKEN") {
  const token = process.env[name];
  return token && token.trim().length > 0 ? token : null;
}

function matchesToken(providedToken: string | null, expectedToken: string): boolean {
  if (!providedToken) return false;

  const providedDigest = createHash("sha256").update(providedToken).digest();
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

const BENCHMARK_RECOVERY_SYNC_STALE_ENV = "BENCHMARK_RECOVERY_SYNC_STALE";
const BENCHMARK_RECOVERY_TOKEN_ENV = "BENCHMARK_RECOVERY_TOKEN";
const BENCHMARK_RECOVERY_TOKEN_HEADER = "x-benchmark-recovery-token";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * The stale synchronous recovery path is a deliberately narrow local-only
 * escape hatch.  It is disabled unless both the feature flag and the exact
 * server-side token/header contract are present, so ordinary and deployed
 * requests retain the existing background/409 behavior.
 */
function allowsSynchronousStaleRecovery(request: NextRequest): boolean {
  if (process.env[BENCHMARK_RECOVERY_SYNC_STALE_ENV] !== "true") return false;
  if (!isLoopbackHostname(request.nextUrl.hostname)) return false;
  const expectedToken = process.env[BENCHMARK_RECOVERY_TOKEN_ENV]?.trim();
  if (!expectedToken) return false;
  return matchesToken(request.headers.get(BENCHMARK_RECOVERY_TOKEN_HEADER), expectedToken);
}

function unauthorizedBenchmarkRecoveryResponse() {
  return NextResponse.json({
    error: "Forbidden",
    errorCode: "BENCHMARK_RECOVERY_UNAUTHORIZED",
    retryable: false,
  }, { status: 403 });
}

function benchmarkRecoveryContractResponse() {
  return NextResponse.json({
    error: "benchmark recovery requires an immediately previous v72 result",
    errorCode: "BENCHMARK_RECOVERY_PREVIOUS_V72_REQUIRED",
    retryable: false,
  }, { status: 409 });
}

class BenchmarkRecoveryError extends Error {
  constructor(
    readonly errorCode: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkRecoveryError";
  }
}

const BENCHMARK_RECOVERY_TELEMETRY_HOST = "telemetry-cdn.pubg.com";

function recoveryTelemetryError(message = "benchmark recovery telemetry URL is invalid"): BenchmarkRecoveryError {
  return new BenchmarkRecoveryError("BENCHMARK_RECOVERY_TELEMETRY_INVALID", 412, message);
}

function parseRecoveryTelemetryUrl(value: unknown, expectedAssetId: string, expectedPlatform: PubgPlatform): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_TELEMETRY_REQUIRED",
      412,
      "benchmark recovery requires a telemetry asset",
    );
  }

  const raw = value.trim();
  // Inspect the original authority/path before WHATWG URL normalization so an
  // explicitly supplied default port or encoded path cannot be laundered into
  // an apparently safe URL.
  if (!/^https:\/\//i.test(raw) || raw.includes("\\")) throw recoveryTelemetryError();
  const authorityAndPath = raw.slice("https://".length);
  const authority = authorityAndPath.split(/[/?#]/, 1)[0] || "";
  const rawPath = authorityAndPath.slice(authority.length).split(/[?#]/, 1)[0] || "";
  if (!authority || authority.includes("@") || authority.includes(":")) throw recoveryTelemetryError();
  if (authorityAndPath.includes("?") || authorityAndPath.includes("#")) throw recoveryTelemetryError();
  if (!rawPath.startsWith("/") || rawPath.endsWith("/") || rawPath.includes("//")) {
    throw recoveryTelemetryError();
  }
  if (rawPath.includes("%")) throw recoveryTelemetryError();
  const rawPathSegments = rawPath.slice(1).split("/");
  if (rawPathSegments.some((segment) => segment === "." || segment === ".." || !segment)) {
    throw recoveryTelemetryError();
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw recoveryTelemetryError();
  }

  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const hasCanonicalFilename = (filename: string | undefined): boolean => (
    filename === `${expectedAssetId}-telemetry.json`
  );
  const isHour = (segment: string | undefined): boolean => /^(?:[01]\d|2[0-3])$/.test(segment || "");
  const isMinute = (segment: string | undefined): boolean => /^(?:[0-5]\d)$/.test(segment || "");
  const hasCurrentTelemetryShape = pathSegments.length === 8
    && pathSegments[0] === "bluehole-pubg"
    && pathSegments[1] === expectedPlatform
    && /^\d{4}$/.test(pathSegments[2] || "")
    && /^\d{2}$/.test(pathSegments[3] || "")
    && /^\d{2}$/.test(pathSegments[4] || "")
    && isHour(pathSegments[5])
    && isMinute(pathSegments[6])
    && hasCanonicalFilename(pathSegments[7]);
  const hasLegacyTelemetryShape = pathSegments.length === 7
    && pathSegments[0] === expectedPlatform
    && /^\d{4}$/.test(pathSegments[1] || "")
    && /^\d{2}$/.test(pathSegments[2] || "")
    && /^\d{2}$/.test(pathSegments[3] || "")
    && isHour(pathSegments[4])
    && isMinute(pathSegments[5])
    && hasCanonicalFilename(pathSegments[6]);
  const hasTelemetryShape = hasCurrentTelemetryShape || hasLegacyTelemetryShape;
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== BENCHMARK_RECOVERY_TELEMETRY_HOST
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || !hasTelemetryShape) {
    throw recoveryTelemetryError();
  }

  return parsed.href;
}

function assertRecoveryTelemetryResponseUrl(response: Response, requestedUrl: string): void {
  let finalUrl: string;
  try {
    finalUrl = response.url;
  } catch {
    throw recoveryTelemetryError();
  }
  // Compare the transport's raw final URL, not only WHATWG-normalized href:
  // normalization would erase an explicit :443, dot-segment, or other
  // authority/path ambiguity that must remain fail-closed at this boundary.
  if (!finalUrl || finalUrl !== requestedUrl) {
    throw recoveryTelemetryError();
  }
}

function recoveryTelemetryAsset(matchData: unknown): { asset: Record<string, unknown>; id: string } | null {
  if (!isRecord(matchData) || !isRecord(matchData.data)) return null;
  const relationships = isRecord(matchData.data.relationships) ? matchData.data.relationships : null;
  const assets = relationships && isRecord(relationships.assets) ? relationships.assets : null;
  const refs = assets && Array.isArray(assets.data) ? assets.data : [];
  if (refs.length !== 1 || !isRecord(refs[0]) || typeof refs[0].id !== "string" || refs[0].type !== "asset") return null;
  const assetId = refs[0].id.trim();
  if (!assetId) return null;
  const included = Array.isArray(matchData.included) ? matchData.included : [];
  const assetsById = included.filter((item): item is Record<string, unknown> => (
    isRecord(item) && item.type === "asset" && item.id === assetId
  ));
  return assetsById.length === 1 ? { asset: assetsById[0], id: assetId } : null;
}

function recoveryMatchDefinitionIds(
  rawTelemetry: unknown,
  expectedMatchId: string,
  expectedPlatform: PubgPlatform,
): Array<string | null> {
  if (!Array.isArray(rawTelemetry)) return [];
  const normalizedExpectedMatchId = normalizeMatchId(expectedMatchId);
  if (!normalizedExpectedMatchId) return [];
  const expectedSuffix = `.${normalizedExpectedMatchId}`;
  return rawTelemetry.flatMap((event) => {
    if (!isRecord(event) || event._T !== "LogMatchDefinition") return [];
    const value = event.MatchId ?? event.matchId ?? event.match_id;
    if (typeof value !== "string" || !value.trim()) return [null];
    const trimmed = value.trim();
    if (!trimmed.endsWith(expectedSuffix)) return [null];
    const prefix = trimmed.slice(0, -expectedSuffix.length);
    const match = /^match\.bro\.(?:official|competitive)\.pc-2018-\d{2}\.(steam|kakao)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.\d{4}\.\d{2}\.\d{2}\.\d{2}$/i.exec(prefix);
    if (!match || match[1].toLowerCase() !== expectedPlatform) return [null];
    return [normalizedExpectedMatchId];
  });
}

function benchmarkRecoveryFailureResponse(error: BenchmarkRecoveryError): NextResponse {
  return NextResponse.json({
    error: error.message,
    errorCode: error.errorCode,
    retryable: false,
  }, { status: error.status });
}

/**
 * An exact-key recovery delete is successful only when the guarded R2 helper
 * confirms that it planned and deleted precisely the one key we uploaded.
 * Treat a dry-run, blocked key, partial result, or malformed helper response
 * as compensation failure so the caller never reports a false rollback.
 */
function isSuccessfulRecoveryDeletion(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const confirmedDelete = result.plannedCount === 1 && result.deletedCount === 1;
  const confirmedNoop = result.plannedCount === 0 && result.deletedCount === 0;
  return result.dryRun === false
    && (confirmedDelete || confirmedNoop)
    && Array.isArray(result.blocked)
    && result.blocked.length === 0
    && Array.isArray(result.failed)
    && result.failed.length === 0;
}

function recoveryCompensationError(
  error: unknown,
  objectDeleted: boolean,
): BenchmarkRecoveryError {
  if (error instanceof TelemetryRegistryError
    && error.code === "RECOVERY_FINALIZE_RECONCILIATION_FAILED") {
    return new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_RECONCILIATION_FAILED",
      503,
      "benchmark recovery finalization state could not be confirmed",
    );
  }
  if (objectDeleted && error instanceof BenchmarkRecoveryError) return error;
  return new BenchmarkRecoveryError(
    objectDeleted
      ? "BENCHMARK_RECOVERY_PERSISTENCE_FAILED"
      : "BENCHMARK_RECOVERY_COMPENSATION_FAILED",
    503,
    objectDeleted
      ? "benchmark recovery persistence failed"
      : "benchmark recovery compensation failed",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsRecoveryIdentityEvidence(
  value: unknown,
  accountId: string,
  nickname: string,
): boolean {
  if (Array.isArray(value)) return value.some((item) => containsRecoveryIdentityEvidence(item, accountId, nickname));
  if (!isRecord(value)) return false;

  for (const [key, nested] of Object.entries(value)) {
    if (key === "accountId" || key === "playerId") {
      if (typeof nested === "string" && nested === accountId) return true;
    }
    if (key === "name" || key === "characterName") {
      if (typeof nested === "string" && normalizeName(nested) === normalizeName(nickname)) return true;
    }
    if (containsRecoveryIdentityEvidence(nested, accountId, nickname)) return true;
  }
  return false;
}

/** Recovery telemetry may mention a display name without proving which
 * account produced the event. Keep the existing nickname predicate for the
 * broader telemetry filter, but require this account-only predicate before a
 * recovery payload is authorized. */
function containsRecoveryAccountIdentityEvidence(value: unknown, accountId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsRecoveryAccountIdentityEvidence(item, accountId));
  if (!isRecord(value)) return false;

  for (const [key, nested] of Object.entries(value)) {
    if ((key === "accountId" || key === "playerId")
      && typeof nested === "string"
      && nested === accountId) {
      return true;
    }
    if (containsRecoveryAccountIdentityEvidence(nested, accountId)) return true;
  }
  return false;
}

async function loadAndValidateRecoveryTelemetry(
  telemetryAsset: unknown,
  accountId: string,
  nickname: string,
  matchId: string,
  platform: PubgPlatform,
  assetId: string,
): Promise<any[]> {
  if (!isRecord(telemetryAsset)
    || !isRecord(telemetryAsset.attributes)) {
    throw new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_TELEMETRY_REQUIRED",
      412,
      "benchmark recovery requires a telemetry asset",
    );
  }
  const telemetryUrl = parseRecoveryTelemetryUrl(telemetryAsset.attributes.URL, assetId, platform);

  let response: Response;
  try {
    response = await fetch(telemetryUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_TELEMETRY_UNAVAILABLE",
      412,
      "benchmark recovery telemetry is unavailable",
    );
  }
  assertRecoveryTelemetryResponseUrl(response, telemetryUrl);
  if (!response.ok) {
    throw new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_TELEMETRY_UNAVAILABLE",
      412,
      "benchmark recovery telemetry is unavailable",
    );
  }

  let rawTelemetry: unknown;
  try {
    rawTelemetry = await safeJsonParse(response);
  } catch {
    throw new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_TELEMETRY_INVALID",
      412,
      "benchmark recovery telemetry is invalid",
    );
  }
  if (!Array.isArray(rawTelemetry) || rawTelemetry.length === 0) {
    throw new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_TELEMETRY_INVALID",
      412,
      "benchmark recovery telemetry is invalid",
    );
  }
  const definitionIds = recoveryMatchDefinitionIds(rawTelemetry, matchId, platform);
  if (definitionIds.length !== 1 || definitionIds[0] !== normalizeMatchId(matchId)) {
    throw recoveryTelemetryError("benchmark recovery telemetry match identity is invalid");
  }

  const filtered = filterTelemetryEvents(rawTelemetry, {
    mode: "lite",
    teamNames: new Set([normalizeName(nickname)]),
    teamAccountIds: new Set([accountId]),
  });
  const hasOfficialEvent = filtered.some((event) => typeof event?._T === "string");
  const hasIdentityEvidence = filtered.some((event) => (
    containsRecoveryIdentityEvidence(event, accountId, nickname)
  ));
  const hasAccountIdentityEvidence = filtered.some((event) => (
    containsRecoveryAccountIdentityEvidence(event, accountId)
  ));
  if (!hasOfficialEvent || filtered.length === 0 || !hasIdentityEvidence || !hasAccountIdentityEvidence) {
    throw new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_TELEMETRY_INVALID",
      412,
      "benchmark recovery telemetry lacks canonical identity evidence",
    );
  }
  return filtered;
}

function getBearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length) || null;
}

async function reportBackgroundReanalysisFailure(): Promise<void> {
  try {
    await reportPubgApiError({
      route: "/api/pubg/match/revalidate",
      status: 500,
      message: "Background match reanalysis failed",
      detail: "Sanitized background error",
    });
  } catch {
    console.error("[MATCH] 백그라운드 오류 기록 실패");
  }
}

function createTacticalResponse(result: any) {
  const tacticalResult = { ...result };
  delete tacticalResult.mapData;
  return pseudonymizeTelemetryAccountIds(tacticalResult);
}

/**
 * Population provenance belongs to the canonical fullResult, not its storage
 * wrapper.  Keep this boundary separate from RESULT_VERSION so a current v73
 * row written before the marker is treated as a one-time cache miss.
 */
function hasPopulationEvidence(fullResult: unknown): boolean {
  return Boolean(
    fullResult
      && typeof fullResult === "object"
      && !Array.isArray(fullResult)
      && Number((fullResult as Record<string, unknown>).populationEvidenceVersion) === POPULATION_EVIDENCE_VERSION,
  );
}

function databaseUnavailableResponse() {
  return NextResponse.json(
    {
      error: "상세 분석 저장소가 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.",
      errorCode: "PUBG_MATCH_ANALYSIS_DATABASE_UNAVAILABLE",
      retryable: true,
    },
    { status: 503, headers: { "Retry-After": "30" } },
  );
}

function invalidMatchIdResponse() {
  return NextResponse.json({
    error: "유효한 matchId 파라미터가 필요합니다.",
    errorCode: "PUBG_MATCH_INVALID_ID",
    retryable: false,
  }, { status: 400 });
}

function upstreamIdentityMismatchResponse() {
  return NextResponse.json({
    error: "PUBG 응답 매치 식별자가 요청과 일치하지 않습니다.",
    errorCode: "PUBG_MATCH_UPSTREAM_IDENTITY_MISMATCH",
    retryable: false,
  }, { status: 400 });
}

function isDatabaseFailureContext(
  stage: PubgErrorStage,
  step: PubgAnalysisStep | null,
): boolean {
  return stage === "cache_lookup"
    || (stage === "analysis" && (
      step === "telemetry_cache_reserve"
      || step === "telemetry_cache_finalize"
      || step === "telemetry_cache_persistence"
      || step === "benchmark_lookup"
    ));
}

function serializeTelemetryCacheFailure(
  error: unknown,
  startedAt: number,
): string {
  const registryError = error instanceof TelemetryRegistryError ? error : null;
  return JSON.stringify({
    operation: registryError?.operation ?? "unknown",
    code: registryError?.code ?? null,
    status: registryError?.status ?? null,
    retryCount: registryError?.retryCount ?? 0,
    elapsedMs: Date.now() - startedAt,
  });
}

async function reportTelemetryCachePersistenceFailure(
  error: unknown,
  startedAt: number,
  requestContext: PubgApiErrorContext,
): Promise<void> {
  const analysisStep: PubgAnalysisStep = "telemetry_cache_persistence";
  const errorCode = "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE";
  try {
    await reportPubgApiError({
      route: "/api/pubg/match",
      status: 503,
      message: errorCode,
      detail: serializeTelemetryCacheFailure(error, startedAt),
      notify: true,
      context: {
        ...requestContext,
        failureStage: `analysis:${analysisStep}`,
        errorCode,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch {
    return;
  }
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  let failureStage: PubgErrorStage = "cache_lookup";
  let analysisStep: PubgAnalysisStep | null = null;
  let upstreamStatus: number | null = null;
  const { searchParams } = request.nextUrl;
  const matchId = searchParams.get("matchId");
  const nickname = searchParams.get("nickname");
  const platformValue = searchParams.get("platform");
  if (!isCanonicalMatchId(matchId)) {
    return invalidMatchIdResponse();
  }
  if (!platformValue) {
    return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
  }
  const platformParam = normalizePlatform(platformValue);
  const lowerNickname = normalizeName(nickname || "");
  const force = searchParams.get("force") === "true";
  const sourceParam = searchParams.get("source") || "user";

  if (platformParam !== "steam" && platformParam !== "kakao") {
    return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
  }
  const platform: PubgPlatform = platformParam;

  // A recovery header is a privileged protocol signal. Reject it before any
  // cache/read or PUBG request unless the complete local-only authorization
  // contract is satisfied. Header-free requests keep the ordinary stale
  // 409/background behavior below.
  const recoveryHeaderPresent = request.headers.get(BENCHMARK_RECOVERY_TOKEN_HEADER) !== null;
  const recoveryAuthorized = recoveryHeaderPresent && allowsSynchronousStaleRecovery(request);
  if (recoveryHeaderPresent && !recoveryAuthorized) {
    return unauthorizedBenchmarkRecoveryResponse();
  }

  if (sourceParam !== "user" && sourceParam !== "scraper") {
    return NextResponse.json({ error: "Invalid source" }, { status: 400 });
  }
  const source: AnalysisSource = sourceParam;
  const requestContext: PubgApiErrorContext = {
    platform,
    source,
    clientKind: classifyClientKind(request.headers.get("user-agent")),
    requestId: request.headers.get("x-vercel-id"),
    matchFingerprint: createPubgIdentifierFingerprint(matchId),
    nicknameFingerprint: createPubgIdentifierFingerprint(nickname),
  };

  if (source === "scraper") {
    const scraperToken = getConfiguredToken("PUBG_SCRAPER_INTERNAL_TOKEN");
    if (!scraperToken) {
      return NextResponse.json({ error: "Scraper authentication unavailable" }, { status: 503 });
    }
    if (!matchesToken(getBearerToken(request), scraperToken)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (force) {
    const adminToken = getConfiguredToken("ADMIN_REVALIDATE_TOKEN");
    if (!adminToken) {
      return NextResponse.json({ error: "Admin authentication unavailable" }, { status: 503 });
    }
    if (!matchesToken(request.headers.get("X-BGMS-Admin-Token"), adminToken)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // [MOCK] 로컬 DB 장애 및 시뮬레이션을 위한 골드 매치 모킹
  if (matchId === "match-gold-simulation-1234") {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const filePath = path.join(process.cwd(), "scratch", "mock_gold_match_data.json");
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        return NextResponse.json(JSON.parse(data));
      }
    } catch {
    }
  }

  if (!nickname) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
  }

  if (!force && isRecentlyNotFound(platform, matchId)) {
    return matchNotFoundResponse();
  }

  if (isDatabaseCircuitOpen()) {
    return databaseUnavailableResponse();
  }

  try {
    const shouldForce = force;
    let populationReanalysisRequired = false;
    let cachedFullResult: any = null;

    // A correctly authorized recovery request is deliberately narrower than
    // an ordinary match request: it may only upgrade the exact previous v72
    // cache row. Force/cache-miss/current/unmarked rows fail closed before
    // any PUBG fetch or background scheduling.
    if (recoveryAuthorized && shouldForce) {
      return benchmarkRecoveryContractResponse();
    }

    if (!shouldForce) {
      const cachedData = await getCachedMatchTelemetry(matchId, lowerNickname, platform) as any;
      noteDatabaseAvailable();
      cachedFullResult = getValidFullResultForMatch(cachedData, {
        matchId,
        playerId: lowerNickname,
        platform,
        minResultVersion: 0,
      });
      if (recoveryAuthorized
        && (!cachedFullResult || cachedFullResult.v !== Math.max(1, RESULT_VERSION - 1))) {
        return benchmarkRecoveryContractResponse();
      }
      if (recoveryAuthorized) {
        // Rebind the stale-cache claim to a fresh database row.  The cached
        // v72 value above may have been produced before another worker
        // finalized v73, so it is never sufficient evidence on its own.
        const freshRecoveryData = await readFreshRecoveryTelemetry(matchId, lowerNickname, platform);
        const freshRecoveryResult = getValidFullResultForMatch(freshRecoveryData, {
          matchId,
          playerId: lowerNickname,
          platform,
          minResultVersion: 0,
        });
        if (!freshRecoveryResult || freshRecoveryResult.v !== Math.max(1, RESULT_VERSION - 1)) {
          return benchmarkRecoveryContractResponse();
        }
        cachedFullResult = freshRecoveryResult;
      }
      if (cachedFullResult
        && typeof cachedFullResult.v === "number"
        && Number.isFinite(cachedFullResult.v)
        && cachedFullResult.v >= RESULT_VERSION) {
        if (hasPopulationEvidence(cachedFullResult)) {
          return NextResponse.json(createTacticalResponse(cachedFullResult));
        }
        // Current result versions written before population evidence was
        // preserved are ambiguous. Treat them as a cache miss and force the
        // analyzed-event R2 path to refresh once, without requiring the
        // caller's admin `force=true` authorization.
        populationReanalysisRequired = true;
        cachedFullResult = null;
      }
    }

    if (!isR2Configured()) {
      return NextResponse.json(
        { error: "텔레메트리 캐시 저장소를 사용할 수 없습니다." },
        { status: 503 },
      );
    }

    const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
    failureStage = "match_fetch";
    const res = await fetch(`https://api.pubg.com/shards/${platform}/matches/${matchId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });
    upstreamStatus = res.status;
    trackPubgRateLimit(res.headers);

    if (!res.ok) {
      throw new Error(`PUBG API Match Load Failed: ${res.status}`);
    }
    matchNotFoundCache.delete(matchNotFoundCacheKey(platform, matchId));
    failureStage = "match_parse";
    const matchData = await safeJsonParse(res);
    if (!hasMatchingUpstreamMatchId(matchData, matchId)) {
      return upstreamIdentityMismatchResponse();
    }
    const matchAttr = matchData.data.attributes;

    const participants = matchData.included.filter((it: any) => it.type === "participant");
    const rosters = matchData.included.filter((it: any) => it.type === "roster");

    failureStage = "participant_lookup";
    const myParticipant = participants.find((p: any) => normalizeName(p.attributes.stats.name) === lowerNickname);
    if (!myParticipant) throw new Error(`Player ${nickname} not found in match participants`);

    const myAccountId = myParticipant.attributes.stats.playerId || myParticipant.attributes.accountId;
    if (!myAccountId) {
      return NextResponse.json({ error: "Player account identifier is unavailable" }, { status: 404 });
    }
    const canonicalNickname = myParticipant.attributes.stats.name;

    const myRoster = rosters.find((r: any) => r.relationships.participants.data.some((p: any) => p.id === myParticipant.id));
    const myRosterId = myRoster?.id || "";

    const teamParticipants = myRoster
      ? myRoster.relationships.participants.data
        .map((pRef: any) => participants.find((p: any) => p.id === pRef.id))
        .filter(Boolean)
      : [myParticipant];
    const teamStats = teamParticipants
      .map((participant: any) => participant.attributes?.stats)
      .filter(Boolean);

    const teamNames = new Set<string>(teamStats
      .map((m: any) => normalizeName(m.name))
      .filter((name: string) => name.length > 0));
    const teamAccountIds = new Set<string>(teamParticipants
      .map((participant: any) => participant.attributes?.stats?.playerId
        || participant.attributes?.stats?.accountId
        || participant.attributes?.accountId)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0));

    const humanParticipants = participants.filter((p: any) => !p.attributes.accountId?.startsWith("ai."));
    const sortedByDamage = [...humanParticipants].map(p => p.attributes.stats).sort((a, b) => b.damageDealt - a.damageDealt);
    const myDamageRank = sortedByDamage.findIndex((s: any) => normalizeName(s.name) === lowerNickname) + 1;
    const rankPct = humanParticipants.length > 0 ? myDamageRank / humanParticipants.length : 1;

    if (!shouldForce && cachedFullResult) {
      const cachedVersion = cachedFullResult.v || 0;

      // [Stale-While-Revalidate] 캐시 데이터 버전이 낮으면 백그라운드 재분석 기동
      if (cachedVersion < RESULT_VERSION) {
        if (cachedVersion === Math.max(1, RESULT_VERSION - 1)
          && recoveryAuthorized) {
          // The guarded local canary needs the canonical v73 response before
          // it advances to the next identity. Keep the normal 409/background
          // behavior for every other caller or stale version.
          populationReanalysisRequired = true;
          cachedFullResult = null;
        } else {
          after(async () => {
            try {
              await reanalyzeAndSave(
                matchId, canonicalNickname, platform, lowerNickname, matchData, teamNames, teamAccountIds,
                myRosterId, myParticipant, myAccountId, teamStats, rankPct, matchAttr, rosters, participants,
                true, source, startedAt, requestContext,
              );
            } catch {
              await reportBackgroundReanalysisFailure();
            }
          });

          // A stale row is identity-bound and may be reanalyzed in the
          // background, but it must never be presented as a successful current
          // analysis. Ask the caller to retry after canonical refresh instead.
          return NextResponse.json({
            error: "canonical match analysis is not ready",
            errorCode: "PUBG_AI_CANONICAL_NOT_READY",
            retryable: true,
          }, { status: 409 });
        }
      }

      if (cachedFullResult) {
        // 샘플 참가자 추출 (기존 response 형식 호환)
        const allParticipantNames = participants
          .filter((p: any) => !p.attributes.stats.playerId?.startsWith("ai."))
          .map((p: any) => p.attributes.stats.name)
          .filter((name: string) => normalizeName(name) !== lowerNickname);
        const sampleParticipants = allParticipantNames
          .sort(() => 0.5 - Math.random())
          .slice(0, 5);

        return NextResponse.json({
          ...createTacticalResponse(cachedFullResult),
          sampleParticipants
        });
      }
    }

    // 캐시가 없거나 강제 업데이트가 필요한 경우 동기식 분석 실행
    failureStage = "analysis";
    const finalResponse = await reanalyzeAndSave(
      matchId, canonicalNickname, platform, lowerNickname, matchData, teamNames, teamAccountIds,
      myRosterId, myParticipant, myAccountId, teamStats, rankPct, matchAttr, rosters, participants,
      shouldForce || populationReanalysisRequired, source, startedAt, requestContext, (step) => {
        analysisStep = step;
      }, recoveryAuthorized,
    );

    return NextResponse.json(finalResponse);

  } catch (err: unknown) {
    if (err instanceof BenchmarkRecoveryError) {
      return benchmarkRecoveryFailureResponse(err);
    }
    if (isDatabaseFailureContext(failureStage, analysisStep) && isDatabaseUnavailableError(err)) {
      noteDatabaseUnavailable();
      console.error("[MATCH] Supabase unavailable; database circuit opened");
      return databaseUnavailableResponse();
    }

    const classification = classifyPubgMatchError({
      stage: failureStage,
      analysisStep,
      upstreamStatus,
      error: err,
    });
    const errorMsg = classification.responseStatus === 404
      ? classification.errorCode === "PUBG_MATCH_PARTICIPANT_NOT_FOUND"
        ? "해당 매치에서 플레이어 정보를 찾을 수 없습니다. 저장된 기본 전적은 확인할 수 있습니다."
        : "PUBG에서 해당 매치 데이터를 더 이상 제공하지 않습니다. 저장된 기본 전적은 계속 확인할 수 있습니다."
      : classification.responseStatus === 429
        ? "PUBG API 호출 한도가 일시적으로 초과되었습니다. 잠시 후 다시 시도해 주세요."
        : classification.errorCode === "PUBG_MATCH_ANALYSIS_IN_PROGRESS"
          ? "다른 요청에서 상세 분석을 진행 중입니다. 잠시 후 다시 시도해 주세요."
          : classification.responseStatus === 503
            ? "상세 분석 저장소가 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요."
            : "매치 데이터를 처리할 수 없습니다.";

    if (classification.errorCode === "PUBG_MATCH_NOT_FOUND") {
      rememberNotFound(platform, matchId);
    }

    await reportPubgApiError({
      route: "/api/pubg/match",
      status: classification.responseStatus,
      message: classification.errorCode,
      detail: "Sanitized route error",
      notify: classification.responseStatus >= 500 || classification.responseStatus === 429,
      context: {
        failureStage: analysisStep ? `analysis:${analysisStep}` : failureStage,
        errorCode: classification.errorCode,
        upstreamStatus,
        durationMs: Date.now() - startedAt,
        platform,
        source,
        clientKind: classifyClientKind(request.headers.get("user-agent")),
        requestId: request.headers.get("x-vercel-id"),
        matchFingerprint: createPubgIdentifierFingerprint(matchId),
        nicknameFingerprint: createPubgIdentifierFingerprint(nickname),
      },
    });

    return NextResponse.json({
      error: errorMsg,
      errorCode: classification.errorCode,
      retryable: classification.responseStatus === 409
        || classification.responseStatus === 429
        || classification.responseStatus >= 500,
    }, { status: classification.responseStatus });
  }
}

/**
 * 텔레메트리를 분석하고 분석 데이터를 R2 스토리지 및 DB에 저장하는 중추 로직
 */
async function reanalyzeAndSave(
  matchId: string,
  canonicalNickname: string,
  platform: PubgPlatform,
  lowerNickname: string,
  matchData: any,
  teamNames: Set<string>,
  teamAccountIds: Set<string>,
  myRosterId: string,
  myParticipant: any,
  myAccountId: string,
  teamStats: any[],
  rankPct: number,
  matchAttr: any,
  rosters: any[],
  participants: any[],
  force: boolean,
  source: AnalysisSource,
  startedAt: number,
  requestContext: PubgApiErrorContext,
  onAnalysisStep?: (step: PubgAnalysisStep) => void,
  recoveryAuthorized = false,
) {
  const markAnalysisStep = (step: PubgAnalysisStep) => onAnalysisStep?.(step);
  const telemetryAsset = Array.isArray(matchData?.included)
    ? matchData.included.find((item: unknown) => isRecord(item) && item.type === "asset")
    : undefined;
  const recoveryAsset = recoveryAuthorized ? recoveryTelemetryAsset(matchData) : null;
  if (recoveryAuthorized && !recoveryAsset) {
    throw new BenchmarkRecoveryError(
      "BENCHMARK_RECOVERY_TELEMETRY_REQUIRED",
      412,
      "benchmark recovery requires a canonical telemetry asset relationship",
    );
  }
  const recoveryResultVersion = Math.max(1, RESULT_VERSION - 1);
  let recoveryTelemetry: any[] | null = null;
  let recoveryBenchmarkGuard: RecoveryBenchmarkGuard | undefined;

  const assertFreshRecoveryPreviousV72 = async (): Promise<Record<string, unknown>> => {
    const freshData = await readFreshRecoveryTelemetry(matchId, lowerNickname, platform);
    const freshResult = getValidFullResultForMatch(freshData, {
      matchId,
      playerId: lowerNickname,
      platform,
      minResultVersion: recoveryResultVersion,
      requireExactResultVersion: true,
    });
    if (!freshResult || freshResult.v !== recoveryResultVersion) {
      throw new BenchmarkRecoveryError(
        "BENCHMARK_RECOVERY_PREVIOUS_V72_REQUIRED",
        409,
        "benchmark recovery requires an immediately previous v72 result",
      );
    }
    const stats = isRecord(freshResult.stats) ? freshResult.stats : null;
    const embeddedAccountId = stats?.playerId || stats?.accountId;
    if (typeof myAccountId !== "string"
      || !myAccountId
      || typeof embeddedAccountId !== "string"
      || !embeddedAccountId
      || embeddedAccountId !== myAccountId) {
      throw new BenchmarkRecoveryError(
        "BENCHMARK_RECOVERY_PREVIOUS_V72_REQUIRED",
        409,
        "benchmark recovery requires an immediately previous v72 result",
      );
    }
    return freshResult;
  };

  const assertFreshRecoveryAuthorization = async (): Promise<void> => {
    const freshPreviousV72 = await assertFreshRecoveryPreviousV72();
    const freshBenchmarkGuard = await readFreshRecoveryBenchmarkGuard(
      matchId,
      lowerNickname,
      platform,
      matchAttr,
      freshPreviousV72,
    );
    if (recoveryBenchmarkGuard && !sameRecoveryBenchmarkGuard(recoveryBenchmarkGuard, freshBenchmarkGuard)) {
      throw recoveryGlobalMarkerError();
    }
    recoveryBenchmarkGuard = freshBenchmarkGuard;
  };

  // Re-read before loading the external telemetry asset.  The unstable cache
  // is only a stale gate; it must never authorize telemetry/R2 work on a row
  // that has already advanced to v73 in the canonical database.
  if (recoveryAuthorized) await assertFreshRecoveryAuthorization();

  // Validate and fetch the canonical recovery asset before reserving the
  // telemetry-map row.  Invalid/missing assets therefore keep the historical
  // no-reservation failure boundary; the post-claim freshness check below
  // still runs immediately before engine/R2/database side effects.
  if (recoveryAuthorized && recoveryAsset) {
    recoveryTelemetry = await loadAndValidateRecoveryTelemetry(
      recoveryAsset.asset,
      myAccountId,
      canonicalNickname,
      matchId,
      platform,
      recoveryAsset.id,
    );
  }

  markAnalysisStep("telemetry_cache_reserve");
  const telemetryIdentity = createTelemetryIdentity({
    matchId,
    platform,
    playerId: myAccountId,
    mode: "lite",
    telemetryVersion: TELEMETRY_VERSION,
  });
  if (recoveryAuthorized) {
    // A previous attempt may have written the deterministic target before its
    // registry finalization. Never let recovery claim the same key and
    // overwrite that unknown side effect; reconciliation must inspect it.
    const recoveryTargetKey = buildTelemetryCacheKey(telemetryIdentity);
    const existingRecoveryTarget = await downloadFromR2(recoveryTargetKey);
    if (existingRecoveryTarget !== null) {
      throw new BenchmarkRecoveryError(
        "BENCHMARK_RECOVERY_TARGET_EXISTS",
        409,
        "benchmark recovery target already exists",
      );
    }
  }
  const cacheDeps = {
    isConfigured: isR2Configured,
    download: downloadFromR2,
    upload: uploadToR2,
    sign: getPresignedUrlFromR2,
    // Ordinary requests may reclaim an expired lease. Recovery is stricter:
    // the dedicated DB RPC uses ON CONFLICT DO NOTHING, so a ready/pending
    // v61 target can never be overwritten between preflight and claim.
    claim: (row: TelemetryMapCacheRegistryRow) => recoveryAuthorized
      ? claimTelemetryMapCacheRecoveryReservation(supabase, row)
      : claimTelemetryMapCacheReservation(supabase, row),
    release: (row: TelemetryMapCacheRegistryRow) => releaseTelemetryMapCacheReservation(supabase, row),
    finalize: (row: TelemetryMapCacheRegistryRow) => finalizeTelemetryMapCacheLifecycle(supabase, {
      row,
      mapName: matchAttr.mapName || matchAttr.mapId || "unknown",
      gameMode: matchAttr.gameMode || "unknown",
    }),
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
  };
  const cacheAccess = recoveryAuthorized
    ? await (async () => {
      const claimedRow = await claimTelemetryMapCacheRow(telemetryIdentity, cacheDeps);
      return claimedRow
        ? { kind: "claimed" as const, row: claimedRow }
        : { kind: "pending" as const };
    })()
    : await claimOrWaitForTelemetryMapCache(telemetryIdentity, cacheDeps);
  let reservedRow: TelemetryMapCacheRegistryRow | undefined;
  let reservationReleased = false;
  let reservationReleaseSucceeded = false;
  let recoveryUploadedKey: string | null = null;
  let recoveryFinalized = false;
  const releaseReservationOnce = async (): Promise<void> => {
    if (!reservedRow || reservationReleased) return;
    reservationReleased = true;
    try {
      await releaseTelemetryMapCacheRow(reservedRow, cacheDeps);
      reservationReleaseSucceeded = true;
    } catch {
      // Ordinary ingestion retains its historical best-effort release
      // behavior. Strict recovery uses releaseRecoveryReservationStrict below
      // so compensation can report an unresolved lease explicitly.
    }
  };
  const releaseRecoveryReservationStrict = async (): Promise<boolean> => {
    if (!reservedRow) return false;
    if (reservationReleased) return reservationReleaseSucceeded;
    reservationReleased = true;
    try {
      await releaseTelemetryMapCacheRow(reservedRow, cacheDeps);
      reservationReleaseSucceeded = true;
      return true;
    } catch {
      return false;
    }
  };

  if (cacheAccess.kind === "hit") {
    const freshData = recoveryAuthorized
      ? await readFreshRecoveryTelemetry(matchId, lowerNickname, platform)
      : await (async () => {
        const { data, error } = await supabase
          .from("processed_match_telemetry")
          .select("match_id, player_id, platform, data")
          .eq("match_id", matchId)
          .eq("platform", normalizePlatform(platform))
          .eq("player_id", lowerNickname)
          .retry(false)
          .abortSignal(AbortSignal.timeout(5_000))
          .maybeSingle();
        if (error) throw error;
        noteDatabaseAvailable();
        return data || null;
      })();
    const cachedFullResult = getValidFullResultForMatch(freshData, {
      matchId,
      playerId: lowerNickname,
      platform,
      minResultVersion: recoveryAuthorized ? recoveryResultVersion : RESULT_VERSION,
    });
    if (recoveryAuthorized
      && (!cachedFullResult || cachedFullResult.v !== recoveryResultVersion)) {
      throw new BenchmarkRecoveryError(
        "BENCHMARK_RECOVERY_PREVIOUS_V72_REQUIRED",
        409,
        "benchmark recovery requires an immediately previous v72 result",
      );
    }
    if (!recoveryAuthorized && !force && cachedFullResult
      && typeof cachedFullResult.v === "number"
      && Number.isFinite(cachedFullResult.v)
      && cachedFullResult.v >= RESULT_VERSION
      && hasPopulationEvidence(cachedFullResult)) {
      const sampleParticipants = participants
        .filter((p: any) => !p.attributes.stats.playerId?.startsWith("ai."))
        .map((p: any) => p.attributes.stats.name)
        .filter((name: string) => normalizeName(name) !== lowerNickname)
        .sort(() => 0.5 - Math.random())
        .slice(0, 5);
      return {
        ...createTacticalResponse(cachedFullResult),
        sampleParticipants,
      };
    }
    reservedRow = await claimTelemetryMapCacheRow(telemetryIdentity, cacheDeps) ?? undefined;
  } else if (cacheAccess.kind === "claimed") {
    reservedRow = cacheAccess.row;
  }

  if (!reservedRow) {
    throw new Error("telemetry-map-cache-write-in-progress");
  }

  if (recoveryAuthorized) {
    // The pre-claim read is a cheap guard. Recheck after owning the lease so a
    // prior attempt that left the deterministic target behind cannot be
    // overwritten by this request.
    const existingRecoveryTarget = await downloadFromR2(reservedRow.storage_path);
    if (existingRecoveryTarget !== null) {
      await releaseReservationOnce();
      throw new BenchmarkRecoveryError(
        "BENCHMARK_RECOVERY_TARGET_EXISTS",
        409,
        "benchmark recovery target already exists",
      );
    }
  }

  if (recoveryAuthorized) {
    // Re-check after the registry claim as well.  A concurrent worker can
    // advance the processed row between the route's initial fresh read and a
    // claimed reservation; never run the analysis engine or write R2/processed
    // data for that stale claim.
    try {
      await assertFreshRecoveryAuthorization();
    } catch (error) {
      await releaseReservationOnce();
      throw error;
    }
  }

  try {
  let telData: any[] = recoveryTelemetry || [];

  if (telemetryAsset && !recoveryTelemetry) {
    // The shared identity builder retains the private `*_analyze.json` suffix
    // while binding match/platform/account/mode/version into the path.
    const analyzePath = buildTelemetryAnalyzeCacheKey(telemetryIdentity);
    markAnalysisStep("telemetry_r2_read");
    const fileText = force ? null : await downloadFromR2(analyzePath);

    let needsProcessing = !fileText;
    if (fileText) {
      try {
        const parsed = parseTelemetryAnalyzeCacheEnvelope(JSON.parse(fileText), telemetryIdentity);
        const isHealthy = parsed && parsed.length > 0
          && parsed.some((ev: any) => ev.attacker?.accountId || ev.victim?.accountId);
        if (isHealthy && parsed) {
          telData = parsed;
        } else {
          needsProcessing = true;
        }
      } catch {
        // Malformed or legacy R2 content is an untrusted cache miss. Refetch
        // the canonical raw telemetry instead of allowing parse errors to
        // abort the match request.
        needsProcessing = true;
      }
    }

    if (needsProcessing) {
      let rawTel: any[] = [];
      let parseSuccess = false;
      let lastError: any = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          markAnalysisStep("telemetry_download");
          const telRes = await fetch(telemetryAsset.attributes.URL, {
            signal: AbortSignal.timeout(15_000),
          });
          markAnalysisStep("telemetry_parse");
          rawTel = await safeJsonParse(telRes);
          parseSuccess = true;
          break;
        } catch (err: any) {
          lastError = err;
          if (attempt === 1) {
            console.warn(`[MATCH] 텔레메트리 다운로드/파싱 1차 시도 실패 (${err?.message || err}). 500ms 후 재시도...`);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }

      if (!parseSuccess) {
        throw lastError || new Error("텔레메트리 파싱 실패");
      }

      markAnalysisStep("telemetry_filter");
      telData = filterTelemetryEvents(rawTel, {
        mode: "lite",
        teamNames,
        teamAccountIds,
      });

      markAnalysisStep("telemetry_r2_upload");
      await uploadToR2(analyzePath,
        JSON.stringify(createTelemetryAnalyzeCacheEnvelope(telemetryIdentity, telData)),
        'application/json',
      );
    }
  }

  const getMatchTier = (pct: number) => {
    if (pct <= 0.1) return 'S';
    if (pct <= 0.3) return 'A';
    if (pct <= 0.6) return 'B';
    return 'C';
  };
  const matchTier = getMatchTier(rankPct);

  markAnalysisStep("benchmark_lookup");
  const tierStats = await fetchTierBenchmarkStats(supabase, {
    gameMode: matchAttr.gameMode,
    matchType: matchAttr.matchType,
    tier: matchTier
  });

  // Benchmark lookup is the last awaited operation before the analysis
  // engine and the persistence/R2 side-effect boundary.  Recovery is a
  // race-sensitive v72 -> v73 upgrade: rebind the authorization one final
  // time after that await so a concurrent v73 finalization cannot cause the
  // stale route to run the engine or write any derived state.  Ordinary
  // requests retain their existing behavior and do not perform this read.
  if (recoveryAuthorized) await assertFreshRecoveryAuthorization();

  const bench = adaptBenchmark(tierStats);

  const engine = new AnalysisEngine(
    canonicalNickname, myAccountId, teamNames, teamAccountIds,
    new Set<string>(), new Set<string>(),
    myRosterId
  );

  markAnalysisStep("analysis_engine");
  const result = engine.run(
    telData,
    matchAttr,
    rosters,
    participants,
    myParticipant.attributes.stats,
    teamStats,
    bench
  );

  const defaultBenchmark = {
    avg_damage: 200,
    breakdown: { combat: 20, tactical: 20, survival: 20 }
  };

  const metadataEvidence: Record<string, unknown> = {};
  for (const key of [
    "isCustomMatch",
    "is_custom_match",
    "isEventMode",
    "is_event_mode",
    "isCustomGame",
    "is_custom_game",
  ]) {
    if (Object.prototype.hasOwnProperty.call(matchAttr, key) && matchAttr[key] !== undefined) {
      metadataEvidence[key] = matchAttr[key];
    }
  }
  const matchStartEvent = telData.find((event: any) => event?._T === "LogMatchStart");
  const telemetryFlags: Record<string, unknown> = {};
  for (const key of ["isCustomGame", "is_custom_game", "isEventMode", "is_event_mode"]) {
    if (matchStartEvent && Object.prototype.hasOwnProperty.call(matchStartEvent, key) && matchStartEvent[key] !== undefined) {
      telemetryFlags[key] = matchStartEvent[key];
    }
  }

  const fullResult = {
    ...result,
    v: RESULT_VERSION,
    populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
    matchId,
    player_id: lowerNickname,
    platform,
    ...(Object.keys(metadataEvidence).length > 0 ? { attributes: metadataEvidence } : {}),
    ...(Object.keys(telemetryFlags).length > 0 ? { telemetryFlags } : {}),
    matchInfo: {
      map: MAP_NAMES[matchAttr.mapId] || matchAttr.mapId,
      mapId: MAP_IDS[matchAttr.mapId] || 'erangel',
      date: matchAttr.createdAt,
      mode: matchAttr.gameMode,
      matchType: matchAttr.matchType,
      duration: matchAttr.duration,
      rankPct,
      tier: matchTier
    },
    benchmark: {
      ...defaultBenchmark,
      ...bench,
      ...(result.benchmark || {})
    }
  };

  const { mapData, ...tacticalResult } = fullResult;
  markAnalysisStep("telemetry_payload");
  const telemetryPayload = createTelemetryPayload({
    identity: buildTelemetryPublicIdentity(telemetryIdentity),
    startTime: matchAttr.createdAt,
    teammates: pseudonymizeTelemetryTeammates(mapData?.teammates || []),
    teamNames: mapData?.teamNames || [myParticipant.attributes.stats.name],
    events: pseudonymizeTelemetryAccountIds(mapData?.events || []),
    zoneEvents: pseudonymizeTelemetryAccountIds(mapData?.zoneEvents || []),
    mapName: result.mapName || matchAttr.mapName || matchAttr.mapId,
  });
  const processedTelemetryRecord = buildProcessedTelemetryUpsert(
    matchId,
    lowerNickname,
    platform,
    tacticalResult,
  );
  const persistenceInput = {
    matchId,
    playerNickname: lowerNickname,
    platform: platform === "kakao" ? "kakao" : "steam",
    finalResult: {
      ...tacticalResult,
      stats: { ...tacticalResult.stats },
      tradeStats: { ...tacticalResult.tradeStats },
      killContribution: { ...tacticalResult.killContribution },
      isolationData: { ...tacticalResult.isolationData },
      combatPressure: {
        ...tacticalResult.combatPressure,
        utilityStats: { ...tacticalResult.combatPressure.utilityStats },
      },
      itemUseSummary: { ...tacticalResult.itemUseSummary },
      duelStats: { ...tacticalResult.duelStats },
      itemUseStats: { ...tacticalResult.itemUseStats },
      benchmark: tacticalResult.benchmark
        ? {
            ...tacticalResult.benchmark,
            breakdown: { ...tacticalResult.benchmark.breakdown },
          }
        : undefined,
    },
    matchAttr,
    rawParticipants: participants,
    source: source === "scraper" ? "scraper" : "user",
    forceBenchmark: false,
  } as const;

  if (recoveryAuthorized) {
    // Strict recovery has one side-effect boundary: upload the deterministic
    // exact key first, then commit master + processed + benchmark + registry
    // together in the guarded RPC.  No signed URL is needed for this response.
    markAnalysisStep("telemetry_cache_finalize");
    // PutObject can commit remotely before its promise rejects.  Mark the
    // exact key before awaiting it so an ambiguous upload is compensated by
    // the same guarded delete/release path as a database failure.
    recoveryUploadedKey = reservedRow.storage_path;
    await uploadToR2(
      reservedRow.storage_path,
      JSON.stringify(telemetryPayload),
      "application/json",
    );

    if (!recoveryBenchmarkGuard) {
      throw new BenchmarkRecoveryError(
        "BENCHMARK_RECOVERY_GLOBAL_BENCHMARK_CHANGED",
        409,
        "benchmark recovery benchmark guard is unavailable",
      );
    }
    const benchmarkRow = buildBenchmarkRow(persistenceInput);
    if (!benchmarkRow) {
      throw new BenchmarkRecoveryError(
        "BENCHMARK_RECOVERY_GLOBAL_BENCHMARK_CHANGED",
        409,
        "benchmark recovery benchmark row is not eligible",
      );
    }
    const finalizeResult = await finalizeRecoveryAtomically(supabase, {
      lease: reservedRow,
      processedGuard: {
        matchId,
        playerId: lowerNickname,
        platform,
        resultVersion: recoveryResultVersion,
        accountId: myAccountId,
      },
      benchmarkGuard: recoveryBenchmarkGuard as RegistryRecoveryBenchmarkGuard,
      rows: {
        master: {
          match_id: matchId,
          map_name: result.mapName || matchAttr.mapName || matchAttr.mapId || "unknown",
          game_mode: matchAttr.gameMode || "unknown",
          telemetry_version: TELEMETRY_VERSION,
          storage_path: reservedRow.storage_path,
        },
        processed: {
          match_id: processedTelemetryRecord.match_id,
          platform: processedTelemetryRecord.platform,
          player_id: processedTelemetryRecord.player_id,
          data: processedTelemetryRecord.data,
          updated_at: processedTelemetryRecord.updated_at,
        },
        benchmark: benchmarkRow,
      },
    });
    if (!finalizeResult.ok) {
      throw new BenchmarkRecoveryError(
        "BENCHMARK_RECOVERY_PERSISTENCE_FAILED",
        503,
        finalizeResult.message || "benchmark recovery finalization was rejected",
      );
    }
    recoveryFinalized = true;
    try {
      revalidateTag("match-analysis", "max");
    } catch {
      // Ignore in non-Next execution contexts.
    }
  } else {
    let mayPersistDerivedStats = true;
    markAnalysisStep("telemetry_cache_finalize");
    try {
      await writeTelemetryMapCache(telemetryIdentity, telemetryPayload, {
        ...cacheDeps,
        finalize: (row) => finalizeTelemetryMapCacheLifecycle(supabase, {
          row,
          mapName: matchAttr.mapName || matchAttr.mapId || "unknown",
          gameMode: matchAttr.gameMode || "unknown",
          processed: {
            playerId: processedTelemetryRecord.player_id,
            platform: processedTelemetryRecord.platform,
            data: processedTelemetryRecord.data,
            updatedAt: processedTelemetryRecord.updated_at,
          },
        }),
      }, { reservedRow });
      try {
        revalidateTag("match-analysis", "max");
      } catch {
        // Ignore in non-Next execution contexts
      }
    } catch (error) {
      markAnalysisStep("telemetry_cache_persistence");
      if (isDatabaseUnavailableError(error)) {
        mayPersistDerivedStats = false;
        noteDatabaseUnavailable();
        console.error("[MATCH] Supabase unavailable during cache persistence; database circuit opened");
        await releaseReservationOnce();
      } else {
        await reportTelemetryCachePersistenceFailure(error, startedAt, requestContext);
        await releaseReservationOnce();
      }
    }

    if (mayPersistDerivedStats) {
      try {
        const persistenceResult = await persistMatchAnalysis(supabase, persistenceInput);

        if (persistenceResult.failures.length > 0) {
          console.error(
            "[MATCH] 파생 통계 저장 실패:",
            persistenceResult.failures.map(({ taskName }) => taskName),
          );
        }
      } catch {
        console.error("[MATCH] 파생 통계 저장 중 예외 발생");
      }
    }
  }

  const allParticipantNames = participants
    .filter((p: any) => !p.attributes.stats.playerId?.startsWith("ai."))
    .map((p: any) => p.attributes.stats.name)
    .filter((name: string) => normalizeName(name) !== lowerNickname);

  const sampleParticipants = allParticipantNames
    .sort(() => 0.5 - Math.random())
    .slice(0, 5);

  return {
    ...createTacticalResponse(tacticalResult),
    sampleParticipants
  };
  } catch (error) {
    try {
      revalidateTag("match-analysis", "max");
    } catch {}
    if (recoveryAuthorized && !recoveryFinalized) {
      const reconciliationUnknown = error instanceof TelemetryRegistryError
        && error.code === "RECOVERY_FINALIZE_RECONCILIATION_FAILED";
      if (reconciliationUnknown) {
        // The first RPC may have committed before its response was lost.  Do
        // not delete the object or release a lease while that state remains
        // ambiguous; a later reconciliation can safely observe the exact
        // committed rows and clear the registry lease if necessary.
        throw recoveryCompensationError(error, false);
      }
      let objectDeleted = recoveryUploadedKey === null;
      if (recoveryUploadedKey) {
        try {
          const deletion = await deleteObjectsFromR2([recoveryUploadedKey], { dryRun: false });
          objectDeleted = isSuccessfulRecoveryDeletion(deletion);
        } catch {
          objectDeleted = false;
        }
      }
      const leaseReleased = await releaseRecoveryReservationStrict();
      throw recoveryCompensationError(error, objectDeleted && leaseReleased);
    }
    if (reservedRow) {
      await releaseReservationOnce().catch((releaseErr) => {
        console.error("[MATCH] 텔레메트리 락 해제 실패:", releaseErr?.message || releaseErr);
      });
    }
    throw error;
  }
}
