import { NextResponse } from "next/server";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { AI_SUMMARY_CACHE_VERSION, GEMINI_MODELS_TO_TRY, POPULATION_EVIDENCE_VERSION, RESULT_VERSION, WEAPON_NAMES } from "@/lib/pubg-analysis/constants";
import { estimateUserTier } from "@/lib/pubg-analysis/benchmarkScore";
import { classifyRole } from "@/lib/pubg-analysis/roleClassifier";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import {
  adaptObservedBenchmark,
  formatBenchmarkProvenance,
  type ObservedBenchmark,
} from "@/lib/pubg-analysis/benchmarkAdapter";
import { fetchTierBenchmarkStats } from "@/lib/pubg-analysis/benchmarkLookup";
import { getValidFullResultForMatch, isFullResultForPlayerPlatform, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { buildBackupCoachingContext } from "@/lib/pubg-analysis/backupCoaching";
import { withAuthGuard } from "@/utils/supabase/guard";
import { trackAiFailure, trackAiUsage } from "@/lib/pubg-analysis/aiUsageTracker";
import { sanitizeAiCoachingLanguageText } from "@/lib/pubg-analysis/aiCoachingQuality";
import {
  hasUnsupportedAiSummaryMode,
  normalizeAiSummaryDebatePayload,
  sanitizeAiSummaryDebateQuestion,
  sanitizeUnsupportedAiSummaryBenchmarkLanguage,
  type CanonicalDebateEvidenceMap,
} from "@/lib/pubg-analysis/aiSummaryDebate";
import { isAiSummaryEligibleMatch } from "@/lib/pubg-analysis/matchEligibility";
import {
  buildBestMatchSelectionKey,
  buildMatchScoreSelectionKey,
  buildMatchSelectionKey,
  normalizeMatchId,
  normalizeBenchmarkScore,
  RECENT_MATCH_SELECTION_VERSION,
  selectBestMatches,
  selectRecentMatches,
  type RecentMatchCandidate,
} from "@/lib/pubg-analysis/recentMatchSelection";
import crypto from "crypto";

export const maxDuration = 60;

// Keep one route-wide deadline below the 60-second platform limit and the
// browser's 55-second safety timer. This clock starts at the beginning of
// POST, so auth, canonical hydration, prompt construction, Gemini, streaming,
// and cache persistence all share the same headroom.
const AI_SUMMARY_ROUTE_TIMEOUT_MS = 50000;
const AI_SUMMARY_TOTAL_TIMEOUT_MS = 18000;
const AI_SUMMARY_MODEL_TIMEOUT_MS = 8000;
// Keep canonical fallback bounded so the route-wide deadline still has room
// for the Gemini stage after missing matches are resolved (or abandoned).
const AI_SUMMARY_FALLBACK_TOTAL_TIMEOUT_MS = 24000;
const AI_SUMMARY_FALLBACK_FETCH_TIMEOUT_MS = 8000;
const AI_SUMMARY_FALLBACK_CONCURRENCY = 2;
const AI_SUMMARY_PROVIDER_ERROR_MESSAGE = "AI summary provider is temporarily unavailable.";

type ComposedAbortSignal = {
  signal: AbortSignal;
  cleanup: () => void;
};

function composeAbortSignals(signals: readonly AbortSignal[]): ComposedAbortSignal {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) {
    return { signal: new AbortController().signal, cleanup: () => undefined };
  }
  if (activeSignals.length === 1) {
    return { signal: activeSignals[0], cleanup: () => undefined };
  }
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(activeSignals), cleanup: () => undefined };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  activeSignals.forEach((signal) => {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  return {
    signal: controller.signal,
    cleanup: () => activeSignals.forEach((signal) => signal.removeEventListener("abort", abort)),
  };
}

function createAbortPromise(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let onAbort: (() => void) | null = null;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => {
      const abortError = new Error("The operation was aborted.");
      abortError.name = "AbortError";
      reject(abortError);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

async function awaitWithAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const abortPromise = createAbortPromise(signal);
  try {
    return await Promise.race([Promise.resolve(promise), abortPromise.promise]);
  } finally {
    abortPromise.cleanup();
  }
}

function hasCurrentResultVersion(fullResult: any): boolean {
  return typeof fullResult?.v === "number"
    && Number.isFinite(fullResult.v)
    && fullResult.v === RESULT_VERSION;
}

type SummaryDependencyFailure = "unavailable" | "timeout";

function classifySummaryDependencyFailure(error: unknown): SummaryDependencyFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Record<string, unknown>;
  const status = Number(candidate.status ?? candidate.statusCode ?? candidate.httpStatus);
  const code = String(candidate.code ?? "").toUpperCase();
  const name = String(candidate.name ?? "");
  const message = String(candidate.message ?? candidate.details ?? "");

  if (name === "TimeoutError" || /timeout|timed out/i.test(message) || status === 504) {
    return "timeout";
  }
  if (status >= 500 || /^PGRST\d{3}$/.test(code) || /database|datastore|schema cache|connection|supabase|unavailable/i.test(message)) {
    return "unavailable";
  }
  return null;
}

function summaryDependencyResponse(kind: SummaryDependencyFailure) {
  return NextResponse.json({
    error: kind === "timeout"
      ? "AI summary data store request timed out."
      : "AI summary data store is temporarily unavailable.",
    errorCode: kind === "timeout" ? "PUBG_AI_DATABASE_TIMEOUT" : "PUBG_AI_DATABASE_UNAVAILABLE",
    retryable: true,
  }, { status: kind === "timeout" ? 504 : 503 });
}

type InternalMatchApiTarget = {
  origin: string;
  headers?: Record<string, string>;
};

function vercelDeploymentOrigin(): string | null {
  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (!deploymentHost || deploymentHost.length > 253) return null;

  const vercelHostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/i;
  if (!vercelHostPattern.test(deploymentHost)) return null;

  return `https://${deploymentHost.toLowerCase()}`;
}

function internalMatchApiTarget(): InternalMatchApiTarget {
  const isDevelopment = process.env.NODE_ENV === "development";
  const fallbackOrigin = isDevelopment ? "http://localhost:3000" : "https://bgms.kr";

  if (!isDevelopment) {
    const deploymentOrigin = vercelDeploymentOrigin();
    if (deploymentOrigin) {
      const protectionBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
      return {
        origin: deploymentOrigin,
        ...(protectionBypass
          ? { headers: { "x-vercel-protection-bypass": protectionBypass } }
          : {}),
      };
    }
  }

  const configuredOrigin = process.env.APP_URL?.trim()
    || (!isDevelopment ? process.env.NEXT_PUBLIC_SITE_URL?.trim() : "")
    || fallbackOrigin;

  try {
    const parsed = new URL(configuredOrigin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { origin: fallbackOrigin };
    }
    return { origin: parsed.origin };
  } catch {
    return { origin: fallbackOrigin };
  }
}

function normalizeWeaponName(weaponId: string): string {
  if (!weaponId) return "Unknown";
  let name = weaponId.toLowerCase();
  name = name.replace(/item_weapon_/, "").replace(/weap/, "").replace(/_c$/, "").replace(/proj/, "");
  const upperName = name.toUpperCase();
  const names = WEAPON_NAMES as any;
  return names[upperName] || names[weaponId] || name;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  "isBotMatch",
  "is_bot_match",
  "isBot",
  "is_bot",
  "isAiMatch",
  "is_ai_match",
  "isAI",
  "is_ai",
  "isAiroyale",
  "is_airoyale",
  "bot",
  "ai",
] as const;

const HUMANITY_EVIDENCE_KEYS = ["isHuman", "is_human", "human"] as const;

const DIRECT_EXCLUSION_EVIDENCE_KEYS = [
  ...EXCLUSION_EVIDENCE_KEYS,
  ...HUMANITY_EVIDENCE_KEYS,
] as const;

function evidenceFlagIsTrue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
}

function evidenceFlagIsFalse(value: unknown): boolean {
  if (value === false || value === 0) return true;
  return typeof value === "string" && ["false", "0", "no", "n"].includes(value.trim().toLowerCase());
}

function mergeExclusionEvidence(...records: Array<Record<string, unknown> | null>): Record<string, unknown> | null {
  const present = records.filter((record): record is Record<string, unknown> => Boolean(record));
  if (present.length === 0) return null;
  const merged = Object.assign({}, ...present);
  for (const key of EXCLUSION_EVIDENCE_KEYS) {
    const values = present.map((record) => record[key]).filter((value) => value !== undefined && value !== null);
    if (values.some(evidenceFlagIsTrue)) merged[key] = true;
    else if (values.length > 0) merged[key] = values[values.length - 1];
  }
  for (const key of HUMANITY_EVIDENCE_KEYS) {
    const values = present.map((record) => record[key]).filter((value) => value !== undefined && value !== null);
    if (values.some(evidenceFlagIsFalse)) merged[key] = false;
    else if (values.length > 0) merged[key] = values[values.length - 1];
  }
  return merged;
}

function pickDirectExclusionEvidence(record: unknown): Record<string, unknown> | null {
  const source = asRecord(record);
  if (!source) return null;
  const selected: Record<string, unknown> = {};
  for (const key of DIRECT_EXCLUSION_EVIDENCE_KEYS) {
    if (source[key] !== undefined && source[key] !== null) selected[key] = source[key];
  }
  return Object.keys(selected).length > 0 ? selected : null;
}

function mergeEvidenceCollection(...values: unknown[]): unknown {
  const present = values.filter((value) => value !== undefined && value !== null);
  if (present.length === 0) return undefined;
  const merged = present.flatMap((value) => Array.isArray(value) ? value : [value]);
  // Preserve every storage layer when telemetry is split between an object
  // and an event array; a lone object keeps the legacy shape.
  return present.length === 1 && !Array.isArray(present[0]) ? present[0] : merged;
}

/**
 * Rows written before the population evidence marker are not safe to use for
 * multi-match selection: RESULT_VERSION 73 alone cannot distinguish them
 * from pre-preservation rows that look official/squad-fpp. New canonical
 * route/engine results carry the marker; unmarked rows are rehydrated and
 * fail closed if that canonical source is unavailable.
 */
function hasCompatiblePopulationEvidence(
  fullResult: Record<string, unknown>,
): boolean {
  // The canonical fullResult is the only authority.  A processed/R2 wrapper
  // can be stale, copied, or populated by a newer ingestion layer and must
  // never bless an unmarked v73 result into the multi-match population.
  return Number(fullResult.populationEvidenceVersion) === POPULATION_EVIDENCE_VERSION;
}

function isCompetitiveMatch(match: any): boolean {
  const values = [
    match?.matchType,
    match?.match_type,
    match?.matchInfo?.matchType,
    match?.gameMode,
    match?.game_mode,
    match?.matchInfo?.mode,
  ];
  return values.some((value) => /(?:^|[-_\s])(competitive|ranked)(?:$|[-_\s])/i.test(String(value ?? "").trim()));
}

function normalizedMatchMode(match: any): string {
  const rawMode = match?.gameMode
    ?? match?.game_mode
    ?? match?.mode
    ?? match?.matchInfo?.mode;
  return String(rawMode ?? "").trim().toLowerCase();
}

function dominantRawMatchMode(matches: readonly any[], fallback: string): string {
  const counts = new Map<string, number>();
  matches.forEach((match) => {
    const mode = normalizedMatchMode(match);
    if (mode) counts.set(mode, (counts.get(mode) || 0) + 1);
  });
  const dominant = Array.from(counts.entries())
    .sort(([aMode, aCount], [bMode, bCount]) =>
      bCount - aCount || (aMode < bMode ? -1 : aMode > bMode ? 1 : 0))
    .at(0)?.[0];
  return dominant || fallback;
}

/**
 * Serialize the values that actually affect an AI summary without exposing
 * the underlying match payload. Object keys are sorted so equivalent
 * effective inputs produce the same cache identity regardless of insertion
 * order.
 */
function stableCacheSerialize(value: unknown, ancestors: WeakSet<object> = new WeakSet<object>()): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined": return "undefined";
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number": return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
    case "bigint": return `bigint:${value.toString()}`;
    case "symbol": return `symbol:${String(value)}`;
    case "function": return "function";
    default: break;
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) return "[Circular]";
  ancestors.add(objectValue);

  try {
    if (objectValue instanceof Date) {
      const timestamp = objectValue.getTime();
      return Number.isFinite(timestamp) ? JSON.stringify(objectValue.toISOString()) : "date:Invalid";
    }
    if (Array.isArray(objectValue)) {
      return `[${objectValue.map((entry) => stableCacheSerialize(entry, ancestors)).join(",")}]`;
    }

    const entries = Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableCacheSerialize((objectValue as Record<string, unknown>)[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}

function buildSummaryCacheHash(input: {
  selectionKey: string;
  bestSelectionKey: string;
  latestScoreSelectionKey: string;
  systemPrompt: string;
  userPrompt: string;
  precomputedVisuals: unknown;
}): string {
  const serializedInput = stableCacheSerialize(input);
  return crypto
    .createHash("sha256")
    .update(AI_SUMMARY_CACHE_VERSION)
    .update("\n")
    .update(serializedInput)
    .digest("hex");
}

function coerceFiniteNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string" && value.trim() === "") return 0;

  try {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, parsed));
  } catch {
    return 0;
  }
}

/** Return only an observed non-negative numeric measurement.  In particular,
 * null/undefined/blank values are not interchangeable with an observed zero;
 * isolation aggregation uses this boundary to keep missing position samples
 * out of both denominators and score-like visuals. */
function readIsolationMeasurement(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  try {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.min(Number.MAX_SAFE_INTEGER, parsed);
  } catch {
    return null;
  }
}

function readObservedNonNegative(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  try {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.min(Number.MAX_SAFE_INTEGER, parsed);
  } catch {
    return null;
  }
}

function coerceNonNegativeNumber(value: unknown): number {
  return Math.max(0, coerceFiniteNumber(value));
}

function calculateBoundedRate(numerator: unknown, denominator: unknown): number | null {
  // Missing numerator/denominator values are not an observed zero.  Keep an
  // explicit numeric 0, but do not manufacture a 0% rate from absent
  // telemetry (for example, a match with no duel opportunities).
  const safeNumerator = readObservedNonNegative(numerator);
  const safeDenominator = readObservedNonNegative(denominator);
  if (safeNumerator === null || safeDenominator === null || safeDenominator <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((safeNumerator / safeDenominator) * 100)));
}

function formatBoundedRate(numerator: unknown, denominator: unknown): string {
  const rate = calculateBoundedRate(numerator, denominator);
  return rate === null ? "측정 불가" : `${rate}%`;
}

function formatObservedPercent(value: unknown): string {
  const observed = readObservedNonNegative(value);
  if (observed === null) return "측정 불가";
  return `${Math.max(0, Math.min(100, observed))}%`;
}

function formatObservedMetric(value: unknown, suffix = ""): string {
  const observed = readObservedNonNegative(value);
  return observed === null ? "측정 불가" : `${observed}${suffix}`;
}

function formatObservedCount(value: unknown): string {
  const observed = readObservedNonNegative(value);
  return observed === null ? "측정 불가" : `${observed}회`;
}

function observedVisualValue(value: unknown, round = false): number | string {
  const observed = readObservedNonNegative(value);
  if (observed === null) return "측정 불가";
  return round ? Math.round(observed) : observed;
}

function firstObservedNonNegative(...values: unknown[]): number | null {
  for (const value of values) {
    const observed = readObservedNonNegative(value);
    if (observed !== null) return observed;
  }
  return null;
}

function addObservedTotal(total: number | null, value: unknown): number | null {
  const observed = readObservedNonNegative(value);
  return observed === null ? total : (total ?? 0) + observed;
}

function aggregateMatches(matches: any[]) {
  const inputMatches = Array.isArray(matches) ? matches : [];
  let totalKills = 0, totalDamage = 0, totalDamageImpact = 0, totalTeamDamageShare = 0, totalTeamKillShare = 0;
  let damageImpactCount = 0, teamDamageShareCount = 0, teamKillShareCount = 0;
  let totalTeammateKnocks = 0, totalSuppCount = 0, totalTradeKills = 0, totalRescueSmokes = 0;
  let totalRevCount = 0, totalBaitCount = 0;
  let totalSmokes = 0;
  let totalSmokeRescues = 0;
  let totalCoverSuccess = 0, totalCoverAttempts = 0;
  let totalInitiativeSuccess = 0, totalInitiativeAttempts = 0;
  let totalCrossfireCount = 0, totalTeamWipes = 0, totalMaxHitDist: number | null = null;
  let totalDuelWins = 0, totalDuelLosses = 0, totalReversalWins = 0, totalReversalAttempts = 0;
  let totalUtilityThrows: number | null = null;
  let totalLethalThrows: number | null = null;
  let totalUtilityHits: number | null = null;
  let totalUtilityDamage: number | null = null;
  let totalUtilityKills: number | null = null;
  let totalDeathPhase = 0, totalBluezoneWaste: number | null = null;
  let deathPhaseCount = 0;
  let bluezoneWasteCount = 0;
  let totalPressureIndex = 0, pressureIndexCount = 0;
  let totalEdgePlay: number | null = null, totalFatalDelay: number | null = null;
  let totalFocusFireCount: number | null = null, totalCrossfireExposureCount: number | null = null;
  const totalDistanceDamage = { short: 0, mid: 0, long: 0 };
  let totalIsolationIndexFinal = 0, totalCombatIso = 0, totalDeathIso = 0;
  let totalMinDist = 0, totalHeightDiff = 0, totalTeammateCountFinal = 0;
  let isolationCountFinal = 0, combatIsolationCountFinal = 0, deathIsolationCountFinal = 0;
  let minDistCountFinal = 0, heightDiffCountFinal = 0, teammateCountFinal = 0;
  let rankedCount = 0, normalCount = 0;
  const weaponMatchCount: Record<string, number> = {};
  
  // [V58.4] 차량 고정밀 교전 지표 집계용 변수
  let totalLeadShotKills = 0, totalLeadShotKnocks = 0, totalRidingShotKills = 0, totalRidingShotKnocks = 0;
  let totalRoadKills = 0, totalRoadKnocks = 0;
  let vehicleCombatMatchCount = 0;

  const backupLatencies: number[] = [], reactionLatencies: number[] = [];
  const goldenTimeFinal = { early: 0, mid1: 0, mid2: 0, late: 0 };
  const killContribFinal = { solo: 0, cleanup: 0, assist: 0 }; // assist = 내 킬 중 팀원이 먼저 딜을 넣었던 킬 (KDA 어시스트와 무관)
  const weaponStatsFinal: Record<string, any> = {};
  const allBadges: any[] = [];

  inputMatches.forEach((rawMatch: any) => {
    const m = rawMatch && typeof rawMatch === "object" ? rawMatch : {};
    // [V41.0] Account ID 우선 매칭 (매칭 검증용)

    // 무기 통계 합산 (DB weaponStats 0 이슈 해결을 위해 타임라인 전수조사 병행)
    if (m.weaponStats) {
      Object.entries(m.weaponStats).forEach(([wId, wData]: [string, any]) => {
        const weaponName = normalizeWeaponName(wId);
        if (!weaponStatsFinal[weaponName]) weaponStatsFinal[weaponName] = { kills: 0, dbnos: 0, damage: 0 };
        weaponStatsFinal[weaponName].damage += coerceFiniteNumber(wData?.damage);
      });
    }
    // 타임라인에서 킬/기절 정보 추출하여 보정
    if (Array.isArray(m.timeline)) {
      m.timeline.forEach((event: any) => {
        if (event.type === 'KILL' || event.type === 'KNOCK' || event.type === 'DOWNED' || event.type === 'TEAM_KNOCK') {
          const weaponName = normalizeWeaponName(event.weapon || 'Unknown');
          if (!weaponStatsFinal[weaponName]) weaponStatsFinal[weaponName] = { kills: 0, dbnos: 0, damage: 0 };
          if (event.type === 'KILL') weaponStatsFinal[weaponName].kills++;
          else weaponStatsFinal[weaponName].dbnos++;
        }
      });
    }
    const isRanked = isCompetitiveMatch(m);
    if (isRanked) rankedCount++; else normalCount++;

    if (m.tradeStats) {
      const teammateKnocks = coerceNonNegativeNumber(m.tradeStats.teammateKnocks);
      const suppCount = coerceNonNegativeNumber(m.tradeStats.suppCount);
      const tradeKills = coerceNonNegativeNumber(m.tradeStats.tradeKills);
      const revCount = coerceNonNegativeNumber(m.tradeStats.revCount);
      const baitCount = coerceNonNegativeNumber(m.tradeStats.baitCount);
      const coverRateSampleCount = coerceNonNegativeNumber(m.tradeStats.coverRateSampleCount);
      const coverRate = coerceFiniteNumber(m.tradeStats.coverRate);
      totalTeammateKnocks += teammateKnocks;
      totalSuppCount += suppCount;
      totalTradeKills += tradeKills;
      totalRevCount += revCount;
      totalBaitCount += baitCount;
      if (coverRateSampleCount > 0 && coverRate >= 0 && coverRate <= 100) {
        totalCoverAttempts += coverRateSampleCount;
        totalCoverSuccess += (coverRate / 100) * coverRateSampleCount;
      }
      const tradeLatencyMs = readObservedNonNegative(m.tradeStats.tradeLatencyMs);
      const reactionLatencyMs = readObservedNonNegative(m.tradeStats.reactionLatencyMs);
      if (tradeLatencyMs !== null) backupLatencies.push(tradeLatencyMs);
      if (reactionLatencyMs !== null && reactionLatencyMs > 0) reactionLatencies.push(reactionLatencyMs);
    }

    totalRescueSmokes += coerceNonNegativeNumber(m.tradeStats?.smokeCount);
    // [V55.1 FIX] m.itemUseStats 대신 m.itemUseSummary.smokes를 참조하여 M79 포함 전체 연막 사용량 정확히 집계
    totalSmokes += coerceNonNegativeNumber(m.itemUseSummary?.smokes ?? m.tradeStats?.smokeCount);
    totalSmokeRescues += coerceNonNegativeNumber(m.tradeStats?.smokeRescues);

    const initiativeSampleCount = coerceNonNegativeNumber(m.initiativeSampleCount);
    if (initiativeSampleCount > 0) {
      totalInitiativeAttempts += initiativeSampleCount;
      totalInitiativeSuccess += Math.round((Math.min(100, coerceNonNegativeNumber(m.initiative_rate)) / 100) * initiativeSampleCount);
    }

    if (m.isolationData) {
      if (m.isolationData.isCrossfire) totalCrossfireCount++;
      const isolationIndex = readIsolationMeasurement(m.isolationData.isolationIndex);
      const combatIsolation = readIsolationMeasurement(m.isolationData.combatIsolation);
      const deathIsolation = readIsolationMeasurement(m.isolationData.deathIsolation);
      const minDist = readIsolationMeasurement(m.isolationData.minDist);
      const heightDiff = readIsolationMeasurement(m.isolationData.heightDiff);
      const teammateCount = readIsolationMeasurement(m.isolationData.teammateCount);
      if (isolationIndex !== null) {
        totalIsolationIndexFinal += isolationIndex;
        isolationCountFinal++;
      }
      if (combatIsolation !== null) {
        totalCombatIso += combatIsolation;
        combatIsolationCountFinal++;
      }
      if (deathIsolation !== null) {
        totalDeathIso += deathIsolation;
        deathIsolationCountFinal++;
      }
      if (minDist !== null) {
        totalMinDist += minDist;
        minDistCountFinal++;
      }
      if (heightDiff !== null) {
        totalHeightDiff += heightDiff;
        heightDiffCountFinal++;
      }
      if (teammateCount !== null) {
        totalTeammateCountFinal += teammateCount;
        teammateCountFinal++;
      }
    }

    if (m.duelStats) {
      const duelWins = readObservedNonNegative(m.duelStats.wins);
      const duelLosses = readObservedNonNegative(m.duelStats.losses);
      const reversals = readObservedNonNegative(m.duelStats.reversals);
      const reversalAttempts = readObservedNonNegative(m.duelStats.reversalAttempts);
      if (duelWins !== null) totalDuelWins += duelWins;
      if (duelLosses !== null) totalDuelLosses += duelLosses;
      if (reversals !== null) totalReversalWins += reversals;
      if (reversalAttempts !== null || reversals !== null) {
        totalReversalAttempts += Math.max(reversalAttempts ?? 0, reversals ?? 0);
      }
    }
    const utilityStats = m.combatPressure?.utilityStats;
    const fragCount = readObservedNonNegative(m.itemUseSummary?.frags);
    const molotovCount = readObservedNonNegative(m.itemUseSummary?.molotovs);
    const derivedLethalThrowCount = fragCount !== null || molotovCount !== null
      ? (fragCount ?? 0) + (molotovCount ?? 0)
      : null;
    const lethalThrowCount = firstObservedNonNegative(
      utilityStats?.lethalThrowCount,
      m.itemUseStats?.lethalThrowCount,
      derivedLethalThrowCount,
    );
    totalLethalThrows = addObservedTotal(totalLethalThrows, lethalThrowCount);

    const utilityThrowCount = firstObservedNonNegative(
      utilityStats?.throwCount,
      m.itemUseStats?.throwCount,
    );
    totalUtilityThrows = addObservedTotal(totalUtilityThrows, utilityThrowCount);

    const utilityHitCount = firstObservedNonNegative(
      utilityStats?.hitCount,
      m.combatPressure?.utilityHits,
    );
    if (utilityHitCount !== null) {
      totalUtilityHits = addObservedTotal(
        totalUtilityHits,
        lethalThrowCount === null ? utilityHitCount : Math.min(utilityHitCount, lethalThrowCount),
      );
    }
    totalUtilityDamage = addObservedTotal(
      totalUtilityDamage,
      firstObservedNonNegative(utilityStats?.totalDamage, m.combatPressure?.utilityDamage),
    );
    totalUtilityKills = addObservedTotal(totalUtilityKills, utilityStats?.killCount);

    const maxHitDistance = firstObservedNonNegative(
      m.combatPressure?.maxHitDistance,
      m.combatPressure?.maxHitDist,
    );
    if (maxHitDistance !== null) {
      totalMaxHitDist = totalMaxHitDist === null
        ? maxHitDistance
        : Math.max(totalMaxHitDist, maxHitDistance);
    }
    totalTeamWipes += coerceNonNegativeNumber(m.tradeStats?.enemyTeamWipes);

    if (m.goldenTimeDamage) {
      goldenTimeFinal.early += coerceFiniteNumber(m.goldenTimeDamage.early);
      goldenTimeFinal.mid1 += coerceFiniteNumber(m.goldenTimeDamage.mid1);
      goldenTimeFinal.mid2 += coerceFiniteNumber(m.goldenTimeDamage.mid2);
      goldenTimeFinal.late += coerceFiniteNumber(m.goldenTimeDamage.late);
    }

    if (m.killContribution) {
      killContribFinal.solo += coerceFiniteNumber(m.killContribution.solo);
      killContribFinal.cleanup += coerceFiniteNumber(m.killContribution.cleanup);
      killContribFinal.assist += coerceFiniteNumber(m.killContribution.assist); // [V66.0] 팀원 기여 킬 누산 추가
    }

    totalKills += coerceFiniteNumber(m.stats?.kills);
    totalDamage += coerceFiniteNumber(m.stats?.processedDamageDealt ?? m.stats?.damageDealt);
    const damageImpact = readObservedNonNegative(m.teamImpact?.damageImpact);
    if (damageImpact !== null) {
      totalDamageImpact += damageImpact;
      damageImpactCount++;
    }
    const teamDamageShare = readObservedNonNegative(m.teamImpact?.teamDamageShare);
    if (teamDamageShare !== null) {
      totalTeamDamageShare += teamDamageShare;
      teamDamageShareCount++;
    }
    const teamKillShare = readObservedNonNegative(m.teamImpact?.teamKillShare);
    if (teamKillShare !== null) {
      totalTeamKillShare += teamKillShare;
      teamKillShareCount++;
    }
    if (m.badges) allBadges.push(...m.badges);

    const observedDeathPhase = readObservedNonNegative(m.deathPhase);
    if (observedDeathPhase !== null) {
      totalDeathPhase += observedDeathPhase;
      deathPhaseCount++;
    }
    const bluezoneWaste = readObservedNonNegative(m.bluezoneWaste);
    if (bluezoneWaste !== null) {
      totalBluezoneWaste = addObservedTotal(totalBluezoneWaste, bluezoneWaste);
      bluezoneWasteCount++;
    }

    const observedPressureIndex = readObservedNonNegative(m.combatPressure?.pressureIndex);
    if (observedPressureIndex !== null) {
      totalPressureIndex += observedPressureIndex;
      pressureIndexCount++;
    }

    totalFocusFireCount = addObservedTotal(totalFocusFireCount, m.itemUseStats?.focusFireCount);
    totalCrossfireExposureCount = addObservedTotal(totalCrossfireExposureCount, m.itemUseStats?.crossfireExposureCount);
    if (m.itemUseStats?.distanceDamage) {
      totalDistanceDamage.short += coerceFiniteNumber(m.itemUseStats.distanceDamage.short);
      totalDistanceDamage.mid += coerceFiniteNumber(m.itemUseStats.distanceDamage.mid);
      totalDistanceDamage.long += coerceFiniteNumber(m.itemUseStats.distanceDamage.long);
    }

    // [V42.1] 자기장 지표 합산 로직 복구 (전장 통제자 칭호 정확도 향상)
    totalEdgePlay = addObservedTotal(
      totalEdgePlay,
      firstObservedNonNegative(m.edgePlay, m.zoneStrategy?.edgePlayCount),
    );
    totalFatalDelay = addObservedTotal(totalFatalDelay, m.zoneStrategy?.fatalDelayCount);

    // [V30.1] 신규 지표 합산 (탈것/자기장운 제외)
    if (Array.isArray(m.weaponMatchCount)) {
      m.weaponMatchCount.forEach((w: string) => {
        weaponMatchCount[w] = (weaponMatchCount[w] || 0) + 1;
      });
    }

    // [V58.4] 차량 교전 지표 누적 합산 (m.stats 또는 m 직계 필드에서 안전하게 추출)
    const lK = coerceFiniteNumber(m.stats?.leadShotKills ?? m.leadShotKills);
    const lKn = coerceFiniteNumber(m.stats?.leadShotKnocks ?? m.leadShotKnocks);
    const rK = coerceFiniteNumber(m.stats?.ridingShotKills ?? m.ridingShotKills);
    const rKn = coerceFiniteNumber(m.stats?.ridingShotKnocks ?? m.ridingShotKnocks);
    const rdK = coerceFiniteNumber(m.stats?.roadKills ?? m.roadKills);
    const rdKn = coerceFiniteNumber(m.stats?.roadKnocks ?? m.roadKnocks);

    totalLeadShotKills += lK;
    totalLeadShotKnocks += lKn;
    totalRidingShotKills += rK;
    totalRidingShotKnocks += rKn;
    totalRoadKills += rdK;
    totalRoadKnocks += rdKn;

    if ((lK + lKn + rK + rKn + rdK + rdKn) > 0) {
      vehicleCombatMatchCount++;
    }
  });

  const mLen = Math.max(1, inputMatches.length);
  const avgDamage = Math.floor(Math.max(0, totalDamage / mLen));
  const avgKills = Number(Math.max(0, totalKills / mLen).toFixed(1));
  const avgDamageImpact = damageImpactCount > 0
    ? Number(Math.max(0, totalDamageImpact / damageImpactCount).toFixed(1))
    : null;
  const avgTeamDamageShare = teamDamageShareCount > 0
    ? Number(Math.max(0, Math.min(100, totalTeamDamageShare / teamDamageShareCount)).toFixed(1))
    : null;
  const avgTeamKillShare = teamKillShareCount > 0
    ? Number(Math.max(0, Math.min(100, totalTeamKillShare / teamKillShareCount)).toFixed(1))
    : null;

  const badgeCounts: Record<string, number> = {};
  allBadges.forEach((b: any) => { if (b?.name) badgeCounts[b.name] = (badgeCounts[b.name] || 0) + 1; });
  const topBadges = Object.entries(badgeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name}(${count}회)`).join(", ");

  const userInitiativeRate = totalInitiativeAttempts > 0 ? Math.max(0, Math.min(100, Math.round((totalInitiativeSuccess / totalInitiativeAttempts) * 100))) : null;
  const userReversalRate = totalReversalAttempts > 0 ? Math.max(0, Math.min(100, Math.round((totalReversalWins / totalReversalAttempts) * 100))) : null;
  const avgBackupLatency = backupLatencies.length > 0 ? (backupLatencies.reduce((a, b) => a + b, 0) / backupLatencies.length / 1000).toFixed(2) + "s" : "측정 불가";
  const avgReactionLatency = reactionLatencies.length > 0 ? (reactionLatencies.reduce((a, b) => a + b, 0) / reactionLatencies.length / 1000).toFixed(2) + "s" : "측정 불가";
  const avgCoverRate = totalCoverAttempts > 0
    ? Math.max(0, Math.min(100, Math.round((totalCoverSuccess / totalCoverAttempts) * 100)))
    : null;
  const totalDuels = totalDuelWins + totalDuelLosses;
  const avgDuelWinRate = totalDuels > 0 ? Math.max(0, Math.min(100, Math.round((totalDuelWins / totalDuels) * 100))) : null;
  const avgDeathPhase = deathPhaseCount > 0 ? Math.max(0, Number((totalDeathPhase / deathPhaseCount).toFixed(1))) : null;
  const avgPressureIndex = pressureIndexCount > 0
    ? Math.max(0, Number((totalPressureIndex / pressureIndexCount).toFixed(2)))
    : null;
  const avgUtilityEfficiency = totalLethalThrows !== null
    && totalLethalThrows > 0
    && totalUtilityDamage !== null
    ? Math.max(0, Math.round(totalUtilityDamage / totalLethalThrows))
    : null;
  const avgBluezoneWaste = bluezoneWasteCount > 0 && totalBluezoneWaste !== null
    ? Math.round(totalBluezoneWaste / bluezoneWasteCount)
    : null;

  const avgMinDistStr = minDistCountFinal > 0 ? Math.max(0, totalMinDist / minDistCountFinal).toFixed(1) + "m" : "측정 불가";
  const avgHeightDiffStr = heightDiffCountFinal > 0 ? Math.max(0, totalHeightDiff / heightDiffCountFinal).toFixed(1) + "m" : "측정 불가";
  const avgIsolationStr = isolationCountFinal > 0 ? Math.max(0, totalIsolationIndexFinal / isolationCountFinal).toFixed(1) : "측정 불가";
  const avgCombatIsolationStr = combatIsolationCountFinal > 0
    ? Math.max(0, totalCombatIso / combatIsolationCountFinal).toFixed(2)
    : "측정 불가";
  const avgDeathIsolationStr = deathIsolationCountFinal > 0
    ? Math.max(0, totalDeathIso / deathIsolationCountFinal).toFixed(2)
    : "측정 불가";

  const goldenTimeAvg = {
    early: Math.max(0, Math.round(goldenTimeFinal.early / mLen)),
    mid1: Math.max(0, Math.round(goldenTimeFinal.mid1 / mLen)),
    mid2: Math.max(0, Math.round(goldenTimeFinal.mid2 / mLen)),
    late: Math.max(0, Math.round(goldenTimeFinal.late / mLen)),
  };

  // [V66.0] 분모에 assist(팀원 개입 킬) 포함 — ingest/route.ts의 solo_kill_rate 산출 방식과 동일하게 보정
  const totalKillContrib = killContribFinal.solo + killContribFinal.cleanup + killContribFinal.assist;
  const soloKillRate = totalKillContrib > 0 ? Math.max(0, Math.min(100, Math.round((killContribFinal.solo / totalKillContrib) * 100))) : null;

  const validMatchTimes = inputMatches
    .map((m: any) => m?.createdAt ?? m?.created_at ?? m?.matchInfo?.date ?? m?.date)
    .map((rawTime: unknown) => {
      if (rawTime instanceof Date) return rawTime.getTime();
      if (typeof rawTime !== "string" && typeof rawTime !== "number") return Number.NaN;
      const timestamp = new Date(rawTime).getTime();
      return Number.isFinite(timestamp) ? timestamp : Number.NaN;
    })
    .filter((timestamp: number) => Number.isFinite(timestamp));
  const latestMatchTime = validMatchTimes.length > 0
    ? new Date(Math.max(...validMatchTimes)).toISOString()
    : new Date(0).toISOString();

  return {
    mLen, avgDamage, avgKills, avgDamageImpact, avgTeamDamageShare, avgTeamKillShare, topBadges,
    userInitiativeRate, userReversalRate, avgBackupLatency, avgReactionLatency, avgCoverRate, avgDuelWinRate,
    totalDuelWins, totalDuelLosses, totalReversalWins, totalReversalAttempts, avgDeathPhase,
    avgPressureIndex, totalLethalThrows, totalUtilityThrows, avgUtilityEfficiency, avgMinDistStr, avgHeightDiffStr,
    avgIsolationStr, avgCombatIsolationStr, avgDeathIsolationStr, goldenTimeAvg, soloKillRate, latestMatchTime, killContribFinal,
    rankedCount, normalCount, totalTeammateKnocks, totalSuppCount, totalTradeKills, totalRevCount,
    totalBaitCount, totalSmokeCount: totalRescueSmokes, totalEdgePlay, totalFatalDelay,
    totalMaxHitDist, totalTeamWipes, isolationCountFinal, combatIsolationCountFinal, deathIsolationCountFinal,
    minDistCountFinal, heightDiffCountFinal, teammateCountFinal, totalIsolationIndexFinal, totalCombatIso,
    totalDeathIso, totalMinDist, totalHeightDiff, totalCrossfireCount, totalTeammateCountFinal,
    totalUtilityHits, totalUtilityDamage, totalUtilityKills, totalBluezoneWaste, avgBluezoneWaste,
    weaponStatsFinal, totalInitiativeAttempts, totalInitiativeSuccess, totalSmokeRescues,
    totalFocusFireCount, totalCrossfireExposureCount, totalDistanceDamage,
    avgDistanceDamage: {
      short: Math.max(0, Math.round(totalDistanceDamage.short / mLen)),
      mid: Math.max(0, Math.round(totalDistanceDamage.mid / mLen)),
      long: Math.max(0, Math.round(totalDistanceDamage.long / mLen)),
    },
    totalSmokes,
    itemUseSummary: { smokes: totalSmokes },
    weaponMatchCount,
    // [V58.4] 차량 고정밀 교전 지표 누적 반환
    totalLeadShotKills,
    totalLeadShotKnocks,
    totalRidingShotKills,
    totalRidingShotKnocks,
    totalRoadKills,
    totalRoadKnocks,
    vehicleCombatMatchCount
  };
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const routeDeadlineAt = startedAt + AI_SUMMARY_ROUTE_TIMEOUT_MS;
  // A Response body can be cancelled independently from request.signal.
  // Bridge that consumer lifecycle into the same route-wide abort graph so
  // Gemini iteration and cache persistence stop when nobody is reading.
  const streamAbortController = new AbortController();
  const routeDeadlineController = new AbortController();
  const routeDeadlineTimer = setTimeout(
    () => routeDeadlineController.abort(),
    AI_SUMMARY_ROUTE_TIMEOUT_MS,
  );
  const routeSignal = composeAbortSignals([
    request.signal,
    routeDeadlineController.signal,
    streamAbortController.signal,
  ]);
  let routeDeadlineCleaned = false;
  let streamOwnsRouteDeadline = false;
  const cleanupRouteDeadline = () => {
    if (routeDeadlineCleaned) return;
    routeDeadlineCleaned = true;
    clearTimeout(routeDeadlineTimer);
    routeSignal.cleanup();
  };
  const isRouteAborted = () => routeSignal.signal.aborted;
  const isStreamCancelled = () => streamAbortController.signal.aborted;
  const retryableAbortResponse = (input: {
    error: string;
    errorCode: string;
    status: number;
  }) => NextResponse.json({
    error: input.error,
    errorCode: input.errorCode,
    retryable: true,
  }, { status: input.status });
  const abortResponse = () => request.signal.aborted
    ? retryableAbortResponse({
      error: "canonical match analysis is not ready",
      errorCode: "PUBG_AI_CANONICAL_NOT_READY",
      status: 409,
    })
    : retryableAbortResponse({
      error: "AI summary request timed out",
      errorCode: "PUBG_AI_ROUTE_TIMEOUT",
      status: 504,
    });
  let authenticatedUserId: string | undefined;
  let requestedPlatform = "steam";
  try {
    if (isRouteAborted()) return abortResponse();

    // 🔒 [보안] JWT 인증 가드 — 로그인된 사용자만 AI 요약 실행 허용 (Gemini API 비용 방어)
    const auth = await awaitWithAbort(withAuthGuard(), routeSignal.signal);
    if (auth.error) return auth.error;
    if (isRouteAborted()) return abortResponse();
    const { supabaseAdmin: supabase } = auth;
    authenticatedUserId = auth.user?.id;

    const { matchIds, nickname, platform = "steam", force = false } = await awaitWithAbort(request.json(), routeSignal.signal);
    if (isRouteAborted()) return abortResponse();
    requestedPlatform = String(platform || "steam");
    const lowerNickname = normalizeName(nickname);
    const cachePlatform = normalizePlatform(platform);

    if (!Array.isArray(matchIds) || matchIds.length === 0) {
      trackAiFailure(authenticatedUserId, "summary", "No matches", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "No matches" }, { status: 400 });
    }
    if (!nickname) {
      trackAiFailure(authenticatedUserId, "summary", "Missing nickname", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing nickname" }, { status: 400 });
    }

    // [V45.3] 10개의 유효한 분석 데이터를 확보하기 위해 조회 범위를 25개로 확장 (이벤트/아케이드 필터링 대비)
    const targetMatchIds = matchIds
      .slice(0, 25)
      .map((id: unknown) => id === null || id === undefined ? "" : String(id).trim())
      .filter(Boolean);
    const normalizedTargetMatchIds = targetMatchIds
      .map((id: string) => normalizeMatchId(id))
      .filter((id): id is string => Boolean(id));
    const searchMatchIds = Array.from(new Set([...targetMatchIds, ...normalizedTargetMatchIds])).filter(Boolean);
    const requestedIndexByCanonicalId = new Map<string, number>();
    targetMatchIds.forEach((rawId: string, index: number) => {
      const canonicalId = normalizeMatchId(rawId);
      if (canonicalId && !requestedIndexByCanonicalId.has(canonicalId)) requestedIndexByCanonicalId.set(canonicalId, index);
    });

    let cachedMatches: any[] = [];
    let processedDependencyFailure: SummaryDependencyFailure | null = null;
    try {
      const processedResult = await awaitWithAbort(supabase.from("processed_match_telemetry")
        .select("match_id, player_id, platform, data")
        .in("match_id", searchMatchIds)
        .eq("platform", cachePlatform)
        .eq("player_id", lowerNickname)
        .abortSignal(routeSignal.signal)
        .limit(searchMatchIds.length || 1), routeSignal.signal);
      cachedMatches = processedResult.data || [];
      if (processedResult.error) {
        processedDependencyFailure = classifySummaryDependencyFailure(processedResult.error);
        console.warn("[AI-SUMMARY] Processed match lookup returned an error:", processedResult.error);
      }
    } catch (dbErr) {
      processedDependencyFailure = classifySummaryDependencyFailure(dbErr);
      console.warn("[AI-SUMMARY] Processed match lookup failed:", dbErr);
    }

    if (isRouteAborted()) {
      return request.signal.aborted
        ? retryableAbortResponse({
          error: "canonical match analysis is not ready",
          errorCode: "PUBG_AI_CANONICAL_NOT_READY",
          status: 409,
        })
        : retryableAbortResponse({
          error: "AI summary request timed out",
          errorCode: "PUBG_AI_ROUTE_TIMEOUT",
          status: 504,
        });
    }

    if (processedDependencyFailure) {
      return summaryDependencyResponse(processedDependencyFailure);
    }

    const cachedMap = new Map();
    const cachedResults: any[] = [];
    let staleMatchDetected = false;
    if (cachedMatches) {
      cachedMatches.forEach(m => {
        // Storage identity is authoritative. A row missing player/platform is
        // a cache miss even when the query predicates were expected to match;
        // never synthesize identity from request values at this boundary.
        const fullResult = getValidFullResultForMatch(m, {
          matchId: m?.match_id,
          playerId: lowerNickname,
          platform: cachePlatform,
          minResultVersion: 0,
        });
        if (fullResult) {
          const storageId = normalizeMatchId(m?.match_id);
          const embeddedId = normalizeMatchId(fullResult.matchId ?? fullResult.match_id ?? fullResult.id);
          if (storageId && embeddedId && storageId !== embeddedId) {
            console.warn(`[AI-SUMMARY] Ignored processed row with mismatched IDs: ${m?.match_id}/${embeddedId}`);
            return;
          }
          const pureId = storageId || embeddedId;
          if (!pureId) return;
          if (!hasCurrentResultVersion(fullResult)) {
            staleMatchDetected = true;
            console.warn(`[AI-SUMMARY] Ignored stale processed full result for ${pureId}`);
            return;
          }
          const rowData = m?.data && typeof m.data === "object"
            ? m.data as Record<string, unknown>
            : {};
          const directExclusionEvidence = mergeExclusionEvidence(
            pickDirectExclusionEvidence(m),
            pickDirectExclusionEvidence(rowData),
            pickDirectExclusionEvidence(fullResult),
          );
          const metadataEvidence = mergeEvidenceCollection(
            fullResult.metadataEvidence,
            rowData.metadataEvidence,
            directExclusionEvidence,
          );
          if (!hasCompatiblePopulationEvidence(fullResult)) {
            staleMatchDetected = true;
            console.warn(`[AI-SUMMARY] Ignored unmarked population evidence for ${pureId}`);
            return;
          }
          const fullMatchInfo = asRecord(fullResult.matchInfo);
          const rowMatchInfo = asRecord(rowData.matchInfo);
          const resultInfo = fullMatchInfo || {};
          const storageAttributes: Record<string, unknown> = {};
          // Some legacy processed rows expose match metadata in storage
          // columns rather than inside `data.fullResult`. Keep those values as
          // separate evidence so a conflicting AI/custom/event marker cannot
          // be hidden by a canonical-looking fallback field.
          for (const key of [
            "matchType",
            "match_type",
            "gameMode",
            "game_mode",
            "mapName",
            "map_name",
            "isCustomMatch",
            "is_custom_match",
            "isEventMode",
            "is_event_mode",
            "isCustomGame",
            "is_custom_game",
          ]) {
            if (m?.[key] !== undefined && m?.[key] !== null) storageAttributes[key] = m[key];
          }
          const fullAttributes = asRecord(fullResult.attributes);
          const rowAttributes = asRecord(rowData.attributes);
          const mergedAttributes = mergeExclusionEvidence(
            storageAttributes,
            rowAttributes,
            fullAttributes,
          );
          const normalizedData: Record<string, unknown> = {
            ...fullResult,
            matchId: pureId,
            __selectionRawId: m?.match_id || fullResult.matchId || pureId,
            createdAt: fullResult.createdAt || resultInfo.date || m.created_at || m.updated_at || rowData.createdAt || rowData.created_at,
            matchType: fullResult.matchType || resultInfo.matchType || m.match_type || rowData.matchType || rowData.match_type,
            gameMode: fullResult.gameMode || resultInfo.mode || m.game_mode || rowData.gameMode || rowData.game_mode,
            mapName: fullResult.mapName || resultInfo.mapId || resultInfo.map || m.map_name || rowData.mapName || rowData.map_name,
            ...(mergedAttributes && Object.keys(mergedAttributes).length > 0 ? { attributes: mergedAttributes } : {}),
            // Keep direct row/data exclusion flags as separate eligibility evidence. Do
            // not spread rowData here: fullResult is the validated authority
            // for identity, stats, and canonical payload fields.
            ...(metadataEvidence !== undefined ? { metadataEvidence } : {}),
          };
          // Processed rows from older ingestion versions can keep metadata
          // beside `fullResult`. Merge only the evidence fields required by
          // the shared eligibility boundary; never let row metadata replace
          // the validated canonical identity or statistics.
          const fullMatchAttributes = asRecord(fullResult.matchAttributes);
          const rowMatchAttributes = asRecord(rowData.matchAttributes);
          if (fullMatchAttributes || rowMatchAttributes) {
            normalizedData.matchAttributes = mergeExclusionEvidence(rowMatchAttributes, fullMatchAttributes);
          }
          if (fullMatchInfo || rowMatchInfo) {
            normalizedData.matchInfo = { ...(rowMatchInfo || {}), ...(fullMatchInfo || {}) };
            // A shallow object cannot represent two conflicting `mode` values;
            // retain every layer for the pure evaluator instead of allowing a
            // canonical-looking secondary alias to erase custom/event evidence.
            normalizedData.matchInfoEvidence = [
              ...(rowMatchInfo ? [rowMatchInfo] : []),
              ...(fullMatchInfo ? [fullMatchInfo] : []),
            ];
          }
          const fullTelemetryFlags = asRecord(fullResult.telemetryFlags);
          const rowTelemetryFlags = asRecord(rowData.telemetryFlags);
          if (fullTelemetryFlags || rowTelemetryFlags) {
            normalizedData.telemetryFlags = mergeExclusionEvidence(rowTelemetryFlags, fullTelemetryFlags);
          }
          const mergedTelemetry = mergeEvidenceCollection(
            fullResult.telemetry,
            fullResult.telemetryEvents,
            rowData.telemetry,
            rowData.telemetryEvents,
          );
          if (mergedTelemetry !== undefined) {
            normalizedData.telemetry = mergedTelemetry;
          }
          cachedResults.push(normalizedData);
          cachedMap.set(pureId, normalizedData);
        } else {
          console.warn(`[AI-SUMMARY] Ignored mismatched processed cache row: ${m?.match_id}/${cachePlatform}/${lowerNickname}`);
        }
      });
    }

    const firstRequestedIdByCanonicalId = new Map<string, string>();
    targetMatchIds.forEach((id: string) => {
      const canonicalId = normalizeMatchId(id);
      if (canonicalId && !firstRequestedIdByCanonicalId.has(canonicalId)) {
        firstRequestedIdByCanonicalId.set(canonicalId, id);
      }
    });
    const missingMatchIds = Array.from(firstRequestedIdByCanonicalId.entries())
      .filter(([canonicalId]) => !cachedMap.has(canonicalId))
      .map(([canonicalId]) => canonicalId);
    const newResultsMap = new Map();
    let fallbackTimedOut = false;
    let fallbackFetchTimedOut = false;
    const firstValue = (...values: unknown[]): unknown => values.find((value) => value !== undefined && value !== null && value !== "");
    const countEligibleCanonicalMatches = () => {
      const candidates: RecentMatchCandidate<any>[] = [...cachedResults, ...newResultsMap.values()]
        .map((match: any, sourceIndex: number) => {
          const rawId = firstValue(match.__selectionRawId, match.matchId, match.match_id, match.id);
          const canonicalId = normalizeMatchId(rawId);
          return {
            id: typeof rawId === "string" ? rawId : canonicalId,
            createdAt: firstValue(match.createdAt, match.created_at, match.date, match.matchInfo?.date)?.toString() || null,
            matchType: firstValue(match.matchType, match.match_type, match.matchInfo?.matchType)?.toString() || null,
            gameMode: firstValue(match.gameMode, match.game_mode, match.mode, match.matchInfo?.mode)?.toString() || null,
            mapName: firstValue(match.mapName, match.map_name, match.map, match.matchInfo?.mapId, match.matchInfo?.map)?.toString() || null,
            sourceIndex,
            value: match,
          };
        })
        .filter((candidate): candidate is RecentMatchCandidate<any> => Boolean(candidate.id));
      return selectRecentMatches(
        candidates.filter((candidate) => isAiSummaryEligibleMatch(candidate.value)),
        { limit: 10 },
      ).selected.length;
    };

    // The request order is the caller's latest-candidate window.  A complete
    // set of older cached rows must not suppress hydration of a missing ID in
    // that window: without the canonical payload we cannot know whether the
    // requested match belongs in the latest ten or carries a newer timestamp.
    const requestedLatestWindowIds = new Set(
      targetMatchIds
        .slice(0, 10)
        .map((id: string) => normalizeMatchId(id))
        .filter((id): id is string => Boolean(id)),
    );
    const missingRequestedWindow = missingMatchIds.some((id) => requestedLatestWindowIds.has(id));

    if (missingMatchIds.length > 0 && (countEligibleCanonicalMatches() < 10 || missingRequestedWindow)) {
      const internalMatchApi = internalMatchApiTarget();
      const fallbackDeadlineController = new AbortController();
      const fallbackStopController = new AbortController();
      const fallbackStartedAt = Date.now();
      const fallbackBudgetMs = Math.min(
        AI_SUMMARY_FALLBACK_TOTAL_TIMEOUT_MS,
        Math.max(0, routeDeadlineAt - fallbackStartedAt),
      );
      const fallbackDeadlineTimer = setTimeout(
        () => fallbackDeadlineController.abort(),
        fallbackBudgetMs,
      );
      const fallbackSignal = composeAbortSignals([
        routeSignal.signal,
        fallbackDeadlineController.signal,
        fallbackStopController.signal,
      ]);
      const fallbackDeadlineAt = fallbackStartedAt + fallbackBudgetMs;

      const runFallbackFetch = async (id: string): Promise<void> => {
        const remainingMs = fallbackDeadlineAt - Date.now();
        if (remainingMs <= 0 || fallbackSignal.signal.aborted) return;

        const fetchTimeoutController = new AbortController();
        const fetchTimeout = setTimeout(
          () => fetchTimeoutController.abort(),
          Math.min(AI_SUMMARY_FALLBACK_FETCH_TIMEOUT_MS, remainingMs),
        );
        const requestSignal = composeAbortSignals([
          fallbackSignal.signal,
          fetchTimeoutController.signal,
        ]);
        const abortPromise = createAbortPromise(requestSignal.signal);
        try {
          const fetchPromise = (async () => {
            const res = await fetch(
              `${internalMatchApi.origin}/api/pubg/match?matchId=${encodeURIComponent(id)}&nickname=${encodeURIComponent(String(nickname))}&platform=${encodeURIComponent(String(platform))}`,
              {
                cache: 'no-store',
                signal: requestSignal.signal,
                ...(internalMatchApi.headers ? { headers: internalMatchApi.headers } : {}),
              },
            );
            if (!res.ok) return null;
            return await res.json();
          })();
          const data = await Promise.race([fetchPromise, abortPromise.promise]);
          if (requestSignal.signal.aborted || !data) return;

          const fallbackValue = data?.data?.fullResult || data?.fullResult || data;
          const requestedCanonicalId = normalizeMatchId(id);
          const returnedCanonicalId = normalizeMatchId(
            fallbackValue?.matchId
              ?? fallbackValue?.match_id
              ?? fallbackValue?.id
              ?? data?.matchId
              ?? data?.match_id
              ?? data?.id,
          );
          if (!requestedCanonicalId || !returnedCanonicalId || returnedCanonicalId !== requestedCanonicalId) {
            console.warn(`[AI-SUMMARY] Ignored fallback with mismatched ID: requested=${requestedCanonicalId}, returned=${returnedCanonicalId}`);
            return;
          }
          const validatedFallback = getValidFullResultForMatch({
            match_id: requestedCanonicalId,
            player_id: lowerNickname,
            platform: cachePlatform,
            data: { fullResult: fallbackValue },
          }, {
            matchId: requestedCanonicalId,
            playerId: lowerNickname,
            platform: cachePlatform,
            minResultVersion: 0,
          });
          const normalizedData = validatedFallback
            ? { ...validatedFallback, __selectionRawId: id }
            : null;
          if (!normalizedData || !isFullResultForPlayerPlatform(normalizedData, lowerNickname, cachePlatform)) {
            console.warn(`[AI-SUMMARY] Ignored invalid fallback full result for ${requestedCanonicalId}`);
            return;
          }
          if (!hasCurrentResultVersion(normalizedData)) {
            staleMatchDetected = true;
            console.warn(`[AI-SUMMARY] Ignored stale fallback full result for ${requestedCanonicalId}`);
            return;
          }
          if (!hasCompatiblePopulationEvidence(normalizedData)) {
            staleMatchDetected = true;
            console.warn(`[AI-SUMMARY] Ignored unmarked fallback population evidence for ${requestedCanonicalId}`);
            return;
          }
          if (requestSignal.signal.aborted) return;
          newResultsMap.set(requestedCanonicalId, normalizedData);
        } catch (e) {
          if (fetchTimeoutController.signal.aborted) fallbackFetchTimedOut = true;
          if (!(e instanceof Error && e.name === "AbortError")) {
            console.error(`[AI-SUMMARY] Match fetch failed for ${id}:`, e);
          }
        } finally {
          clearTimeout(fetchTimeout);
          abortPromise.cleanup();
          requestSignal.cleanup();
        }
      };

      try {
        const requiredMissingIds = new Set(
          missingMatchIds.filter((id) => requestedLatestWindowIds.has(id)),
        );
        for (
          let i = 0;
          i < missingMatchIds.length && !fallbackSignal.signal.aborted;
          i += AI_SUMMARY_FALLBACK_CONCURRENCY
        ) {
          // A complete older cache must not suppress hydration of any missing
          // requested-window ID. Probe every required ID before allowing the
          // normal ten-match stop condition to bound optional older work.
          const pendingRequiredIds = missingMatchIds
            .slice(i)
            .some((id) => requiredMissingIds.has(id));
          if (countEligibleCanonicalMatches() >= 10 && !pendingRequiredIds) break;
          if (fallbackDeadlineAt - Date.now() <= 0) {
            fallbackDeadlineController.abort();
            break;
          }
          const batch = missingMatchIds.slice(i, i + AI_SUMMARY_FALLBACK_CONCURRENCY);
          await Promise.all(batch.map((id: string) => runFallbackFetch(id)));
        }
      } finally {
        fallbackTimedOut = fallbackDeadlineController.signal.aborted
          || routeDeadlineController.signal.aborted
          || request.signal.aborted;
        clearTimeout(fallbackDeadlineTimer);
        fallbackSignal.cleanup();
      }
    }

    // Parent cancellation and the route deadline are terminal even when a
    // partial canonical population is already usable. Never proceed into
    // benchmark reads, Gemini, or cache persistence after either signal.
    if (request.signal.aborted) {
      return retryableAbortResponse({
        error: "canonical match analysis is not ready",
        errorCode: "PUBG_AI_CANONICAL_NOT_READY",
        status: 409,
      });
    }
    if (routeDeadlineController.signal.aborted) {
      return retryableAbortResponse({
        error: "AI summary request timed out",
        errorCode: "PUBG_AI_ROUTE_TIMEOUT",
        status: 504,
      });
    }

    if (isRouteAborted()) return abortResponse();
    const allMatches = [...cachedResults, ...newResultsMap.values()];
    const rawMatches = allMatches;

    // AI/bot rows remain available to detail/replay and are never rejected at
    // ingest. This narrower summary boundary keeps latest10/best5 and their
    // benchmark prompt population human battle-royale only.
    const selectionCandidates: RecentMatchCandidate<any>[] = rawMatches
      .filter((match: any) => isAiSummaryEligibleMatch(match))
      .map((match: any, rawSourceIndex: number) => {
      const rawId = firstValue(match.__selectionRawId, match.matchId, match.match_id, match.id);
      const canonicalId = normalizeMatchId(rawId);
      const requestedIndex = canonicalId ? requestedIndexByCanonicalId.get(canonicalId) : undefined;
      const matchValue = { ...match };
      delete matchValue.__selectionRawId;
      return {
        id: typeof rawId === "string" ? rawId : canonicalId,
        createdAt: firstValue(match.createdAt, match.created_at, match.date, match.matchInfo?.date)?.toString() || null,
        matchType: firstValue(match.matchType, match.match_type, match.matchInfo?.matchType)?.toString() || null,
        gameMode: firstValue(match.gameMode, match.game_mode, match.mode, match.matchInfo?.mode)?.toString() || null,
        mapName: firstValue(match.mapName, match.map_name, match.map, match.matchInfo?.mapId, match.matchInfo?.map)?.toString() || null,
        sourceIndex: requestedIndex === undefined ? rawSourceIndex : requestedIndex,
        value: canonicalId ? { ...matchValue, matchId: canonicalId } : matchValue,
      };
      }).filter((candidate): candidate is RecentMatchCandidate<any> => Boolean(candidate.id));

    const selection = selectRecentMatches(selectionCandidates, {
      limit: 10,
      selectionVersion: RECENT_MATCH_SELECTION_VERSION,
    });

    // A stale canonical row is different from a genuine metadata-only miss:
    // callers must retry after the canonical match analysis reaches the
    // current result version, and no stale payload may reach Gemini. Perform
    // this check after filtering so a stale row plus only excluded current
    // rows cannot silently fall through to a metadata-only response.
    const hasUsableCanonicalSelection = selection.selected.some(({ value }) => (
      isFullResultForPlayerPlatform(value, lowerNickname, cachePlatform)
      && hasCurrentResultVersion(value)
    ));
    if (isRouteAborted()) return abortResponse();
    if ((staleMatchDetected || fallbackTimedOut || fallbackFetchTimedOut || request.signal.aborted) && !hasUsableCanonicalSelection) {
      return NextResponse.json({
        error: "canonical match analysis is not ready",
        errorCode: "PUBG_AI_CANONICAL_NOT_READY",
        retryable: true,
      }, { status: 409 });
    }

    // A score-aware cache identity cannot be reconstructed from request IDs
    // when the processed table and match endpoint are both unavailable. Do
    // not turn these IDs into score=0 placeholders: that would either miss a
    // valid cache or, if a legacy/partial hash happened to match, return a
    // summary for an unverified best-five population. The existing cache row
    // stores only its hash/result, so there is no safe alias lookup here.
    const metadataOnlySelection = selectionCandidates.length === 0
      && cachedResults.length === 0
      && newResultsMap.size === 0;
    if (metadataOnlySelection) {
      console.warn("[AI-SUMMARY] Match data unavailable; refusing metadata-only cache lookup because best-five score identity cannot be verified");
      if (missingMatchIds.length > 0) {
        return NextResponse.json({
          error: "canonical match analysis is not ready",
          errorCode: "PUBG_AI_CANONICAL_NOT_READY",
          retryable: true,
        }, { status: 409 });
      }
      return NextResponse.json({ error: "유효한 전술 분석 데이터가 없습니다. (매치 데이터를 불러오지 못했습니다.)" }, { status: 400 });
    }

    // `selection.selected` is the canonical latest-valid population. Keep it
    // intact for latest-match/mastery/trend/map/basic metrics, then derive the
    // AI/benchmark population from that set only through the shared pure
    // selector so score ties remain deterministic across all callers.
    const bestMatchCandidates = selectBestMatches(selection.selected);
    const selectedMatches = selection.selected.map(({ value }) => value);
    const bestMatches = bestMatchCandidates.map(({ value }) => value);
    const selectedFullResults = selectedMatches.filter((match: any) => (
      isFullResultForPlayerPlatform(match, lowerNickname, cachePlatform)
      && hasCurrentResultVersion(match)
    ));
    const selectionKey = buildMatchSelectionKey(
      selection.selected.map(({ id }) => id),
      selection.selectionVersion,
    );
    const bestSelectionKey = buildBestMatchSelectionKey(bestMatchCandidates);
    const latestScoreSelectionKey = buildMatchScoreSelectionKey(selection.selected);

    if (selectedMatches.length === 0) {
      return NextResponse.json({ error: "유효한 전술 분석 데이터가 없습니다. (이벤트/아케이드 모드 제외)" }, { status: 400 });
    }

    if (selectedFullResults.length === 0) {
      return NextResponse.json({ error: "유효한 전술 분석 데이터가 없습니다. (매치 결과가 없습니다.)" }, { status: 400 });
    }

    // Keep the two populations explicit: AI/upper-tier comparisons consume
    // only the deterministic best five, while mastery and latest-match/basic
    // visual context continue to aggregate the complete latest-valid ten.
    const summaryStats = aggregateMatches(bestMatches);
    const masteryStats = aggregateMatches(selectedMatches);

    const {
      latestMatchTime, avgBackupLatency, avgReactionLatency, userInitiativeRate, avgPressureIndex,
      totalReversalAttempts, totalReversalWins, avgDuelWinRate, totalDuelWins, totalDuelLosses,
      avgDamageImpact, topBadges, goldenTimeAvg, killContribFinal, avgDeathPhase,
      totalTeammateKnocks, totalSuppCount, totalTradeKills, totalRevCount,
      totalBaitCount,
      isolationCountFinal, combatIsolationCountFinal, deathIsolationCountFinal,
      minDistCountFinal, heightDiffCountFinal, teammateCountFinal,
      totalIsolationIndexFinal, totalCombatIso, totalDeathIso, totalMinDist, totalHeightDiff,
      totalCrossfireCount, totalTeammateCountFinal,
      rankedCount, normalCount,
      totalInitiativeAttempts, totalInitiativeSuccess, totalSmokeRescues,
      totalSmokes
    } = masteryStats;

    const groups: Record<string, any[]> = { solo: [], duo: [], squad: [], 'solo-duo': [], 'solo-squad': [] };
    bestMatches.forEach((m: any) => {
      if (!m.matchId && m.id) m.matchId = m.id;
      if (!m.matchId && m.match_id) m.matchId = m.match_id;

      const gm = normalizedMatchMode(m) || "squad";
      if (gm === 'solo-squad') groups['solo-squad'].push(m);
      else if (gm === 'solo-duo') groups['solo-duo'].push(m);
      else if (gm.includes('solo')) groups.solo.push(m);
      else if (gm.includes('duo')) groups.duo.push(m);
      else groups.squad.push(m);
    });
    const mainModeName = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length)[0];
    const mainModeCount = groups[mainModeName].length;
    // Best-match analysis has a hard ceiling of five games. Keep confidence
    // thresholds meaningful for that population instead of retaining the old
    // latest-ten `>= 7` threshold that could never be reached.
    const tierConfidence = mainModeCount >= 5 ? '높음' : mainModeCount >= 3 ? '보통' : '낮음 (데이터 부족)';
    // The AI persona follows the same best-match population as the benchmark
    // and role analysis; mastery/basic visual metrics and mode counts remain
    // all latest-valid ten.
    const isCompetitiveFocus = summaryStats.rankedCount >= summaryStats.normalCount;
    const isSoloSquadFocus = mainModeName.includes('solo-squad') || mainModeName.includes('solo-duo');

    const MAP_DISPLAY_NAMES: Record<string, string> = {
      Baltic_Main: '에란겔', Desert_Main: '미라마', Savage_Main: '사녹',
      Tiger_Main: '태이고', Neon_Main: '론도', Kiki_Main: '데스턴',
      Summerland_Main: '칼린도', Heaven_Main: '헤이븐'
    };
    const mapGroups: Record<string, any[]> = {};
    selectedMatches.forEach((m: any) => {
      const mapKey = m.mapName || 'Unknown';
      if (!mapGroups[mapKey]) mapGroups[mapKey] = [];
      mapGroups[mapKey].push(m);
    });
    const mapStatsList = Object.entries(mapGroups)
      .filter(([, matches]) => matches.length >= 2)
      .map(([mapName, matches]) => {
        const s = aggregateMatches(matches);
        return {
          mapName,
          displayName: MAP_DISPLAY_NAMES[mapName] || mapName,
          matchCount: matches.length,
          avgDamage: Number.isFinite(s.avgDamage) ? Math.round(s.avgDamage) : 0,
          avgKills: Number.isFinite(s.avgKills) ? Number(s.avgKills.toFixed(1)) : 0,
          avgDeathPhase: s.avgDeathPhase === null
            ? null
            : Number.isFinite(s.avgDeathPhase) ? Number(s.avgDeathPhase.toFixed(1)) : null,
        };
      })
      .sort((a, b) => b.avgDamage - a.avgDamage);
    const mapStatsResult = mapStatsList.length >= 2 ? {
      list: mapStatsList,
      bestMap: mapStatsList[0],
      worstMap: mapStatsList[mapStatsList.length - 1],
    } : null;

    const benchmarkPromptProvenance = formatBenchmarkProvenance();
    const promptLines = [
      `당신들은 PUBG [${isSoloSquadFocus ? '극한의 솔로 챌린저' : (isCompetitiveFocus ? '프로급 경쟁전' : '일반전 전술')}] 분석 데스크의 전문 코치입니다. 전달받은 경기 데이터와 '${benchmarkPromptProvenance}'을 바탕으로 끝장 토론을 진행하십시오.`,
      isSoloSquadFocus
        ? "1. KIND COACH: 혼자서 다수를 상대하는 유저의 용기와 교전 능력을 극찬하십시오. 팀플레이 지표가 낮은 것은 당연한 것이니 무시하고, '고독한 사냥꾼'으로서의 면모를 부각하십시오."
        : "1. KIND COACH: 유저의 강력한 화력 공헌(1선 격수로서의 교전 지표, 딜량 비중 등)을 적극 옹호하고, 팀플레이 지표나 백업 속도가 부족하더라도 '팀의 화력을 책임지는 1선 에이스로서 당연히 짊어져야 할 역할'이라며 강하게 쉴드치고 동기부여를 제공하십시오.",
      isSoloSquadFocus
        ? "2. SPICY BOMBER: 솔로 스쿼드라는 핑계 뒤에 숨은 피지컬의 한계를 지적하십시오. '혼자 들어갔으면 전멸을 시켰어야지', '기절만 시키고 확킬을 못 내는 것은 실력 부족'이라며 더 높은 화력을 요구하십시오."
        : `2. SPICY BOMBER: 유저의 지표가 ${benchmarkPromptProvenance}보다 미달하는 부분을 냉혹하게 찌르십시오. ${isCompetitiveFocus ? '[경쟁전 룰셋]을 고려해 보완 우선순위를 분명히 제시하십시오.' : '[일반전] 데이터임을 감안해도 개선해야 할 지표를 분명히 제시하십시오.'} 수치 격차를 강하게 말하되 팀원 의도, 팀원 수준, 유저의 심리나 오만은 단정하지 마십시오.`,
      `- [STRICT KOREAN] 모든 응답에서 'DUO', 'SQUAD', 'SOLO', 'Benchmark'와 같은 영문 용어를 절대 사용하지 마십시오. 반드시 '듀오', '스쿼드', '솔로', '${benchmarkPromptProvenance}'와 같은 한글 용어로 대체하여 출력하십시오.`,
      `- [INTELLIGENT ANALYSIS] 유저의 승률이나 딜량이 ${benchmarkPromptProvenance}을 압도한다면, SPICY BOMBER조차도 \"피지컬은 괴물이지만...\" 이라는 식으로 실력 자체는 인정하며 시작해야 합니다. 무조건적인 비난은 '멍청한 AI'처럼 보입니다.`,
      `- [ZERO HALLUCINATION] 데이터에 명시된 숫자를 1%의 오차도 없이 그대로 인용하십시오. ${benchmarkPromptProvenance}을 인용할 때는 반드시 정확한 소수점까지 포함하십시오.`,
      "- [UTILITY LOGIC] 투척물은 '연막/섬광 등 비피해형'과 '수류탄/화염병/C4 등 피해형'을 엄격히 구분하십시오. 총 투척 중 연막/비피해형 비중이 높다면 '피해형 투척 적중 0회'라고 뭉뚱그려 비난하지 말고, '투척물의 대부분(N회)을 연막 등 생존/엄폐용으로 적극 활용했으며 공격형 투척 시도는 적었다'고 분리해 설명하십시오.",
      `- [BENCHMARK COMPARISON GUARD] debateIssues의 userStats/benchmarkStats에는 실제로 제공된 ${benchmarkPromptProvenance}가 존재하는 지표만 대조하십시오. 비교 표본이 없거나 개별 지표가 NULL이면 해당 benchmarkStats 행과 비교 문장을 생략하고 값을 추정하지 마십시오. 'Benchmark N/A'나 'N/A'를 출력하는 것을 엄격히 금지합니다. 연막 지표는 분모가 같은 '아군 기절 대비 연막 구출률'과 '${benchmarkPromptProvenance} 기회 대비 평균 연막 구출률'만 1:1 대칭으로 구성하고, '연막 구출률'·'내 연막 구출 성공률'·'내 구출 연막 성공률'처럼 시도 횟수 분모인 라벨은 벤치마크와 비교하지 마십시오. 그 밖에는 1:1 승률, 대응 사격 속도, 백업 속도 등 실제 평균이 명시된 지표만 대조하십시오.`,
      "- [BACKUP OUTCOME LOGIC] 백업 속도는 시간 단독으로 평가하지 말고, 적 제압/팀 전멸 기여/소생/연막 구출 결과를 함께 판단하십시오. 결과가 성공한 긴 백업은 '느린 백업'으로 단정하지 말고 '교전 정리 후 복구 성공'과 '복구 시간 단축 과제'를 분리해 말하십시오.",
      "- [MATCH IMPACT LOGIC] 매치 임팩트가 '하드캐리' 또는 '레전드'인 경기는 단일 경기 하이라이트 성과로 인정하십시오. 낮은 세부 지표를 지적하더라도 판 전체를 실패로 단정하지 말고, 강한 성과와 보완점을 분리하십시오.",
      "- [WIN CONTRIBUTION LOGIC] 1등 자체는 생존 결과입니다. '1등 보너스'라고 표현하지 말고, 화력 캐리/복구 기여/결정적 마무리/승리 기여 근거처럼 행동 기반 근거만 사용하십시오.",
      "- [LOW ISOLATION LOGIC] 고립 지수가 2.0 미만이면 양호한 대열 유지로 해석하십시오. 이 경우 '너무 멀리', '독단적인 플레이', '고립될 위험', '고립 위험이 높다' 같은 표현은 부정문에서도 쓰지 마십시오.",
      "- [TEAM INTENT GUARD] 높은 딜량 비중은 '강한 교전 주도' 또는 '화력 분담 보완 필요'로 해석하십시오. 데이터에 명시된 미끼/방치/소생 실패 근거가 없으면 '팀원을 방패', '팀원을 들러리', '팀원을 방치', '혼자 다 해먹', '미끼' 같은 의도 단정 표현을 쓰지 마십시오.",
      "- [TEAM DISMISSAL GUARD] 팀원을 낮춰 부르는 표현은 금지입니다. '팀 지원 지표가 바닥', '나머지 팀원들의 화력 지원이 전무', '팀 전체가 휘청', '존재감이 희미' 대신 '팀 지원 지표 보완', '화력 분담 보완', '교전 기여를 더 선명하게 만들 필요'라고 표현하십시오.",
      "- [OUTPUT SELF CHECK] JSON을 작성한 뒤 signatureSub/finalVerdict/debateIssues/actionItems에 '혼자서 모든 것을 해결', '팀원들의 지원이 부족하다는 방증', '혼자 다 해먹', '팀 민폐', '오만' 같은 표현이 있으면 응답하기 전에 반드시 '강한 교전 주도와 화력 분담 보완 필요'로 고치십시오.",
      `- [DATA COMPARISON] 실제 비교 표본과 개별 평균이 제공된 피드백 항목에서만 (내 수치 vs ${benchmarkPromptProvenance}) 형식을 사용하여 유저가 객관적인 차이를 체감하게 하십시오. 비교 표본이 없으면 유저 수치와 코칭만 제시하십시오.`,
      "- debateIssues는 반드시 3개를 작성하고, 각 issue의 userStats/benchmarkStats는 항목명(label)과 값의 단위(%, 회, m 등)가 완벽히 대칭되어야 합니다.",
      "반드시 아래 구조의 JSON 객체로만 응답하세요.",
      "{",
      '  "signature": "칭호", "signatureSub": "이유",',
      '  "finalVerdict": "전술적 정체성과 취약점을 포함한 종합 판정 (2~3문장)",',
      '  "debateIssues": [',
      '    {',
      '      "topic": "주제",',
      '      "question": "질문",',
      '      "spicyOpinion": "매운맛 의견",',
      '      "kindOpinion": "순한맛 의견",',
      '      "winner": "승자 (반드시 \"spicy\" 또는 \"kind\" 중 하나만 선택)",',
      '      "reason": "근거",',
      '      "evaluation": "종합 평가",',
      '      "userStats": [ { "label": "항목", "value": "값" } ],',
      '      "benchmarkStats": [ { "label": "항목", "value": "값" } ]',
      '    }',
      '  ],',
      '  "actionItems": [ { "icon": "🎯", "title": "목표", "desc": "구체적인 실천 팁" } ]',
      "}"
    ];

    function getGoldenTimePattern(g: any): string {
      if (!g) return "데이터 부족";
      if (g.early > g.mid1 && g.early > g.mid2) return "핫드랍형 (초반 집중)";
      if (g.late > g.early && g.late > g.mid1) return "생존형 (후반 집중)";
      if (g.mid1 + g.mid2 > g.early + g.late) return "중반 교전형";
      return "균형형";
    }

    function selectDebateTopics(stats: any, bench: any): string[] {
      if (!stats) return ["화력", "교전 주도권", "포지셔닝"];

      const isObservedMetric = (value: unknown): value is number => (
        typeof value === "number" && Number.isFinite(value)
      );

      // These topics are always eligible because they are derived from the
      // user's own telemetry. They also ensure the prompt still has exactly
      // three focus areas when no comparison metric is observed.
      const userOnlyIssues = [
        { topic: "유틸리티 활용", gap: stats.totalUtilityThrows === null ? 0.05 : stats.totalUtilityThrows < 5 ? 0.4 : 0.1 },
        { topic: "포지셔닝", gap: parseFloat(stats.avgIsolationStr) > 3.5 ? 0.35 : 0.05 },
        { topic: "생존 운영", gap: typeof stats.avgDeathPhase === "number" && stats.avgDeathPhase > 7 ? 0.2 : 0.05 },
      ];

      if (!bench) {
        return userOnlyIssues.map(({ topic }) => topic);
      }

      const userTradeRate = calculateBoundedRate(stats.totalTradeKills, stats.totalTeammateKnocks);
      const tradeRateGap = isObservedMetric(bench.avgTradeRate) && userTradeRate !== null
        ? Math.abs(userTradeRate - bench.avgTradeRate) / 100
        : null;

      const userBackupLatency = parseFloat(String(stats.avgBackupLatency ?? ""));
      const backupContext = buildBackupCoachingContext({
        avgBackupLatency: stats.avgBackupLatency,
        totalTradeKills: stats.totalTradeKills,
        totalRevCount: stats.totalRevCount,
        totalSmokeRescues: stats.totalSmokeRescues,
        totalTeamWipes: stats.totalTeamWipes,
        totalTeammateKnocks: stats.totalTeammateKnocks,
        benchmarkTradeLatency: bench.avgTradeLatency,
      });
      const backupLatencyGap = isNaN(userBackupLatency) || backupContext.shouldAvoidSlowBackupBlame
        ? null
        : isObservedMetric(bench.avgTradeLatency)
          ? Math.min(1.0, Math.abs(userBackupLatency - bench.avgTradeLatency) / 20)
          : null;

      const comparisonIssues: Array<{ topic: string; gap: number }> = [];
      if (isObservedMetric(bench.avgDamage)) {
        comparisonIssues.push({
          topic: "화력",
          gap: Math.abs(stats.avgDamage - bench.avgDamage) / Math.max(bench.avgDamage, 1),
        });
      }
      if (isObservedMetric(bench.avgInitiativeRate)) {
        if (isObservedMetric(stats.userInitiativeRate)) {
          comparisonIssues.push({
            topic: "교전 주도권",
            gap: Math.abs(stats.userInitiativeRate - bench.avgInitiativeRate) / 100,
          });
        }
      }
      if (isObservedMetric(bench.avgDuelWinRate)) {
        if (isObservedMetric(stats.avgDuelWinRate)) {
          comparisonIssues.push({
            topic: "1:1 결정력",
            gap: Math.abs(stats.avgDuelWinRate - bench.avgDuelWinRate) / 100,
          });
        }
      }
      const tradeAndBackupGaps = [tradeRateGap, backupLatencyGap]
        .filter((gap): gap is number => gap !== null);
      if (tradeAndBackupGaps.length > 0) {
        comparisonIssues.push({
          topic: "복수 성공률 및 백업",
          gap: Math.max(...tradeAndBackupGaps),
        });
      }

      const issues = [...comparisonIssues, ...userOnlyIssues];
      return issues.sort((a, b) => b.gap - a.gap).slice(0, 3).map(i => i.topic);
    }

    let userPrompt = `- 분석 대상: 최근 유효 ${masteryStats.mLen}경기 (랭크 매치: ${masteryStats.rankedCount}판 포함)\n`;
    userPrompt += `- 비교/AI 토론 기준: 최근 유효 ${masteryStats.mLen}경기 중 benchmark.score 내림차순 상위 ${summaryStats.mLen}경기 (동점은 최신 날짜·원본 순서·ID 순)\n`;
    userPrompt += `- 분석 기준: 유저의 최고 기량(Peak Performance)을 바탕으로 잠재력 및 보완점 분석\n`;
    userPrompt += `- 주력 모드: ${mainModeName.toUpperCase()} (신뢰도: ${tierConfidence}, 기반: 상위 ${summaryStats.mLen}판)\n`;
    const impactHighlights = bestMatches
      .filter((match: any) => match.benchmark?.impactScore)
      .slice(0, 3);
    if (impactHighlights.length > 0) {
      userPrompt += `\n### [매치 임팩트 하이라이트]\n`;
      impactHighlights.forEach((match: any, index: number) => {
        const impactReasons = Array.isArray(match.benchmark?.impactReasons) && match.benchmark.impactReasons.length > 0
          ? match.benchmark.impactReasons.slice(0, 3).join(", ")
          : "근거 없음";
        const normalizedScore = normalizeBenchmarkScore(match.benchmark?.score);
        userPrompt += `- ${index + 1}. 전술 안정도 ${normalizedScore}/100, 매치 임팩트 ${match.benchmark.impactScore} (${match.benchmark.impactGrade || "NORMAL"}), 근거: ${impactReasons}\n`;
      });
    }

    // [V58.4] 차량 전투 종합 성과 공급
    const totalVehicleKnocks = (summaryStats.totalLeadShotKnocks || 0) + (summaryStats.totalRidingShotKnocks || 0) + (summaryStats.totalRoadKnocks || 0);
    const totalVehicleKills = (summaryStats.totalLeadShotKills || 0) + (summaryStats.totalRidingShotKills || 0) + (summaryStats.totalRoadKills || 0);
    if (totalVehicleKnocks > 0 || totalVehicleKills > 0) {
      userPrompt += `\n### [차량 전투 성과 (V58.4)] (고정밀 드라이브바이/무빙타겟 헌팅 및 로드킬)\n`;
      userPrompt += `- 리드샷 (무빙 차량 표적 사격): 기절 ${summaryStats.totalLeadShotKnocks || 0}회, 킬 ${summaryStats.totalLeadShotKills || 0}회\n`;
      userPrompt += `- 라이딩샷 (주행 차량 탑승 사격): 기절 ${summaryStats.totalRidingShotKnocks || 0}회, 킬 ${summaryStats.totalRidingShotKills || 0}회\n`;
      userPrompt += `- 로드킬 (차량 충돌): 기절 ${summaryStats.totalRoadKnocks || 0}회, 킬 ${summaryStats.totalRoadKills || 0}회\n`;
      userPrompt += `- 코칭 가이드라인: 이 플레이어는 고난도의 차량 전투 및 로드킬 지표가 뛰어난 플레이어입니다. SPICY BOMBER와 KIND COACH 모두 드라이브바이 사격 성공, 리드샷 결정력, 그리고 로드킬의 전술적 의미를 극찬하거나 보완점으로 강조하여 분석에 웅장하고 미려하게 녹여내야 합니다.\n`;
    }

    if (goldenTimeAvg) {
      const smokeRescueRate = formatBoundedRate(summaryStats.totalSmokeRescues, summaryStats.totalSmokeCount);
      const smokeOpportunityRate = formatBoundedRate(summaryStats.totalSmokeRescues, summaryStats.totalTeammateKnocks);
      userPrompt += `\n### [전술 지표 분석]\n`;
      userPrompt += `- 교전 타이밍(GoldenTime): ${getGoldenTimePattern(summaryStats.goldenTimeAvg)}\n`;
      userPrompt += `- 평균 백업 속도(Trade): ${summaryStats.avgBackupLatency} (아군 기절 시 적 제압 시간)\n`;
      userPrompt += `- 백업 결과 해석: ${buildBackupCoachingContext({
        avgBackupLatency: summaryStats.avgBackupLatency,
        totalTradeKills: summaryStats.totalTradeKills,
        totalRevCount: summaryStats.totalRevCount,
        totalSmokeRescues: summaryStats.totalSmokeRescues,
        totalTeamWipes: summaryStats.totalTeamWipes,
        totalTeammateKnocks: summaryStats.totalTeammateKnocks,
      }).promptLine}\n`;
      userPrompt += `- 대응 사격 속도(Reaction): ${summaryStats.avgReactionLatency} (피격 시 반격 시간)\n`;
      userPrompt += `- 유틸리티 활용: 총 투척 ${formatObservedCount(summaryStats.totalUtilityThrows)} (내 연막 ${summaryStats.totalSmokes}회 사용)\n`;
      userPrompt += `- 개인 전술 구출: 내 구출 연막 성공률 ${smokeRescueRate} (구출 연막 시도 ${summaryStats.totalSmokeCount}회, 성공 ${summaryStats.totalSmokeRescues}회), 아군 기절 대비 연막 구출률 ${smokeOpportunityRate}\n`;
    }

    let trendsData = null;
    const matchesForTrend = selectedMatches;
    // Keep the fixed "recent 5 vs previous 5" label truthful. With fewer
    // than ten latest-valid matches there is no full previous-five sample, so
    // omit the trend card rather than implying data that was not collected.
    if (matchesForTrend.length >= 10) {
      const recentMatches = matchesForTrend.slice(0, 5);
      const olderMatches = matchesForTrend.slice(5);
      const recentStats = aggregateMatches(recentMatches);
      const olderStats = aggregateMatches(olderMatches);
      if (recentStats && olderStats) {
        const dmgTrend = Math.round(recentStats.avgDamage - olderStats.avgDamage);
        const winTrend = recentStats.avgDuelWinRate !== null && olderStats.avgDuelWinRate !== null
          ? Number((recentStats.avgDuelWinRate - olderStats.avgDuelWinRate).toFixed(1))
          : null;
        const status = dmgTrend > 50 ? '📈 실력 상승세' : dmgTrend < -50 ? '📉 컨디션 하락세' : '➡️ 안정권 유지';

        trendsData = {
          dmgTrend,
          winTrend,
          status,
          recent: { damage: Math.floor(recentStats.avgDamage), winRate: recentStats.avgDuelWinRate },
          older: { damage: Math.floor(olderStats.avgDamage), winRate: olderStats.avgDuelWinRate }
        };

        userPrompt += `\n### [최근 트렌드 (최근 5판 vs 이전 5판)]\n`;
        userPrompt += `- 딜량 변화: ${Math.floor(olderStats.avgDamage)} → ${Math.floor(recentStats.avgDamage)} (${dmgTrend >= 0 ? '+' : ''}${dmgTrend})\n`;
        const recentWinRateText = formatObservedPercent(recentStats.avgDuelWinRate);
        const olderWinRateText = formatObservedPercent(olderStats.avgDuelWinRate);
        const winTrendText = winTrend === null
          ? "변화 측정 불가"
          : `${winTrend >= 0 ? '+' : ''}${winTrend}%`;
        userPrompt += `- 교전 승률: ${olderWinRateText} → ${recentWinRateText} (${winTrendText})\n`;
        userPrompt += `- 종합 추세: ${status}\n`;
      }
    }


    let maxMatches = 0;
    let mainUserTier = "C"; // dashboard potential tier from the best-match population
    let mainBench: ObservedBenchmark | null = null;
    let mainBenchContext: { gameMode: string; matchType: string; tier: string } | null = null;
    let finalTierBreakdown: any = null; // overall best-match breakdown for the tier card
    const overallGroupScores: any[] = [];

    for (const [mode, gMatches] of Object.entries(groups)) {
      if (gMatches.length === 0) continue;
      if (isRouteAborted()) return abortResponse();

      // `bestMatches` already contains the canonical telemetry payloads used
      // by selectBestMatches. Keep score and breakdowns on that same source so
      // the score-aware cache key and potential tier cannot diverge from the
      // values shown here. Numeric strings are accepted; zero is meaningful;
      // nullish/non-finite values normalize to the selector's explicit zero.
      const combinedScores = gMatches.map((matchData: any) => {
        const breakdown = matchData?.benchmark?.breakdown;
        return {
          combat: normalizeBenchmarkScore(breakdown?.combat),
          tactical: normalizeBenchmarkScore(breakdown?.tactical),
          survival: normalizeBenchmarkScore(breakdown?.survival),
          score: normalizeBenchmarkScore(matchData?.benchmark?.score),
        };
      });

      const groupScores = combinedScores;
      overallGroupScores.push(...groupScores);

      const validScores = groupScores.map((s) => normalizeBenchmarkScore(s.score));

      const avgScore = validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) / validScores.length : 0;

      const compCount = gMatches.filter(isCompetitiveMatch).length;
      const dominantMatchType = compCount >= gMatches.length / 2 ? "competitive" : "official";
      const benchmarkGameMode = dominantRawMatchMode(gMatches, mode);

      const userTier = estimateUserTier(avgScore);
      const rawTierStats = await awaitWithAbort(fetchTierBenchmarkStats(supabase, {
        gameMode: benchmarkGameMode,
        matchType: dominantMatchType,
        tier: userTier,
        signal: routeSignal.signal,
      }), routeSignal.signal);
      if (isRouteAborted()) return abortResponse();

      // Expose a benchmark to this route's comparison prompt/visuals only
      // when the row passed the observed sample-count and NULL-metric checks.
      const bench = adaptObservedBenchmark(rawTierStats);
      const benchmarkContext = {
        gameMode: benchmarkGameMode,
        matchType: dominantMatchType,
        tier: userTier,
      };
      const benchmarkProvenance = formatBenchmarkProvenance(bench?.sampleCount, benchmarkContext);
      const metricBenchmarkProvenance = (metric: keyof NonNullable<ObservedBenchmark["metricSampleCounts"]>) => (
        formatBenchmarkProvenance(bench?.sampleCount, {
          ...benchmarkContext,
          metricSampleCount: bench?.metricSampleCounts?.[metric],
        })
      );

      if (gMatches.length > maxMatches) {
        maxMatches = gMatches.length;
        mainBench = bench;
        mainBenchContext = benchmarkContext;
      }

      // Keep every mode section scoped to that mode's best-match sample. The
      // overall best-five aggregate is used for the shared potential summary,
      // not for per-mode user metrics or coaching topics.
      const gStats = aggregateMatches(gMatches);
      userPrompt += `### [${mode.toUpperCase()} 모드 분석] (최근 유효 ${selectedMatches.length}판 중 상위 ${bestMatches.length}판 분석; 상위 ${bestMatches.length}판 중 ${gMatches.length}판)\n`;
      userPrompt += `- 유저 티어: ${userTier}\n`;
      userPrompt += `- 비교 표본 출처: ${benchmarkProvenance}\n`;
      userPrompt += `- 평균 화력: ${gStats.avgDamage}${bench?.avgDamage !== undefined ? ` (${metricBenchmarkProvenance("avgDamage")}: 평균 화력 ${bench.avgDamage})` : ""}, 평균 ${gStats.avgKills}킬\n`;
      userPrompt += `- [선제 공격] 주도권 성공률: ${formatObservedPercent(gStats.userInitiativeRate)}${bench?.avgInitiativeRate !== undefined ? ` (${metricBenchmarkProvenance("avgInitiativeRate")}: 주도권 성공률 ${bench.avgInitiativeRate}%)` : ""}\n`;
      userPrompt += `- [교전 결정력] 1:1 교전 승률: ${formatObservedPercent(gStats.avgDuelWinRate)}${bench?.avgDuelWinRate !== undefined ? ` (${metricBenchmarkProvenance("avgDuelWinRate")}: 1:1 교전 승률 ${bench.avgDuelWinRate}%)` : ""}, 승리: ${gStats.totalDuelWins}회, 패배: ${gStats.totalDuelLosses}회, 역전승: ${gStats.totalReversalWins}회\n`;
      userPrompt += `- [교전 압박] 평균 압박 지수: ${formatObservedMetric(gStats.avgPressureIndex)}${bench?.avgPressureIndex !== undefined ? ` (${metricBenchmarkProvenance("avgPressureIndex")}: 압박 지수 ${bench.avgPressureIndex})` : ""}, 최대 교전 거리: ${formatObservedMetric(gStats.totalMaxHitDist, "m")}\n`;
      if (mode !== 'solo') {
        const smokeRescueSuccessRate = formatBoundedRate(gStats.totalSmokeRescues, gStats.totalSmokeCount);
        const smokeRescueOpportunityRate = formatBoundedRate(gStats.totalSmokeRescues, gStats.totalTeammateKnocks);
        const tradeRate = formatBoundedRate(gStats.totalTradeKills, gStats.totalTeammateKnocks);
        const suppRate = formatBoundedRate(gStats.totalSuppCount, gStats.totalTeammateKnocks);
        userPrompt += `- [팀 내 영향력(딜량/킬 비중)] 적 팀 전멸 기여: ${gStats.totalTeamWipes}회, 화력 집중(점사): ${formatObservedCount(gStats.totalFocusFireCount)}\n`;
        userPrompt += `- [개인 팀플레이 기여] 아군 기절 ${gStats.totalTeammateKnocks}회 → 내가 한 소생: ${gStats.totalRevCount}회, 내가 만든 복수(Trade): ${gStats.totalTradeKills}회 (복수 성공률: ${tradeRate}${bench?.avgTradeRate !== undefined ? ` vs ${metricBenchmarkProvenance("avgTradeRate")}: 복수 성공률 ${bench.avgTradeRate}%` : ""})\n`;
        userPrompt += `- [개인 전술 기여] 견제 지원율: ${suppRate}, 미끼: ${gStats.totalBaitCount}회, 내 연막 구출 시도/성공: ${gStats.totalSmokeCount}/${gStats.totalSmokeRescues}회, 내 연막 구출 성공률: ${smokeRescueSuccessRate}, 아군 기절 대비 연막 구출률: ${smokeRescueOpportunityRate}${bench?.avgSmokeRate !== undefined ? ` (${metricBenchmarkProvenance("avgSmokeRate")}: 기회 대비 평균 연막 구출률 ${bench.avgSmokeRate}%)` : ""}, 내 총 연막 사용: ${gStats.totalSmokes}회\n`;
      }
      const reactionStr = gStats.avgReactionLatency === "측정 불가"
        ? "측정 불가 (선제 공격 중심 플레이로 피격 후 반격 샘플 없음 — 이 항목을 언급하거나 추론하지 말 것)"
        : `${gStats.avgReactionLatency}${bench?.avgCounterLatency !== undefined ? ` (${metricBenchmarkProvenance("avgCounterLatency")}: 대응 사격 속도 ${bench.avgCounterLatency}s)` : ""}`;
      const backupStr = gStats.avgBackupLatency === "측정 불가"
        ? "측정 불가 (아군 기절 후 복수 교전 샘플 없음 — 이 항목을 언급하거나 추론하지 말 것)"
        : `${gStats.avgBackupLatency}${bench?.avgTradeLatency !== undefined ? ` (${metricBenchmarkProvenance("avgTradeLatency")}: 백업 속도 ${bench.avgTradeLatency}s)` : ""}`;
      const backupContext = buildBackupCoachingContext({
        avgBackupLatency: gStats.avgBackupLatency,
        totalTradeKills: gStats.totalTradeKills,
        totalRevCount: gStats.totalRevCount,
        totalSmokeRescues: gStats.totalSmokeRescues,
        totalTeamWipes: gStats.totalTeamWipes,
        totalTeammateKnocks: gStats.totalTeammateKnocks,
        benchmarkTradeLatency: bench?.avgTradeLatency,
      });
      const smokeOpportunityRate = formatBoundedRate(gStats.totalSmokeRescues, gStats.totalTeammateKnocks);
      const utilityDamageAverage = gStats.avgUtilityEfficiency === null
        ? "측정 불가"
        : String(gStats.avgUtilityEfficiency);
      const utilityLine = `- [유틸리티] 총 투척 ${formatObservedCount(gStats.totalUtilityThrows)}, 피해형 투척 ${formatObservedCount(gStats.totalLethalThrows)}, 피해 적중 ${formatObservedCount(gStats.totalUtilityHits)}, 피해형 투척 딜량 ${utilityDamageAverage} (평균), 연막 ${gStats.totalSmokes}회`;
      userPrompt += `- [반응 속도] 대응 사격 속도: ${reactionStr}, 반격 성공률: ${formatBoundedRate(gStats.totalReversalWins, gStats.totalReversalAttempts)}\n- [백업 속도] 아군 백업 속도: ${backupStr}\n- [백업 결과 해석] ${backupContext.promptLine}\n- [생존 환경] 고립 지수(운영/교전/사망): ${gStats.avgIsolationStr}/${gStats.avgCombatIsolationStr}/${gStats.avgDeathIsolationStr}, 양각 노출 상황: ${formatObservedCount(gStats.totalCrossfireExposureCount)}\n- [거리 관리] 팀원과의 평균 거리: ${gStats.avgMinDistStr}, 평균 고도차: ${gStats.avgHeightDiffStr}, 경기당 평균 거리별 데미지(근/중/원): ${gStats.avgDistanceDamage.short}/${gStats.avgDistanceDamage.mid}/${gStats.avgDistanceDamage.long}\n- [킬 분류] 솔로 킬: ${gStats.killContribFinal.solo}회, 클린업 킬: ${gStats.killContribFinal.cleanup}회 (솔로 비중: ${formatObservedPercent(gStats.soloKillRate)}${bench?.avgSoloKillRate !== undefined ? ` vs ${metricBenchmarkProvenance("avgSoloKillRate")}: 솔로 킬 비중 ${bench.avgSoloKillRate}%` : ""})\n${utilityLine}\n- [운영 패턴] 평균 사망 페이즈: ${formatObservedMetric(gStats.avgDeathPhase)}${bench?.avgDeathPhase !== undefined ? ` (${metricBenchmarkProvenance("avgDeathPhase")}: 사망 페이즈 ${bench.avgDeathPhase})` : ""}, 자기장 누적 피해: ${formatObservedMetric(gStats.avgBluezoneWaste, " HP")}, 엣지(Edge) 플레이: ${formatObservedCount(gStats.totalEdgePlay)}, 진입 지연: ${formatObservedCount(gStats.totalFatalDelay)}\n\n`;
      userPrompt = userPrompt.replace(utilityLine, `- [유틸리티] 총 투척 ${formatObservedCount(gStats.totalUtilityThrows)} (연막 ${gStats.totalSmokes}회, 피해형 ${formatObservedCount(gStats.totalLethalThrows)}, 피해 적중 ${formatObservedCount(gStats.totalUtilityHits)}), 아군 기절 대비 연막 구출률: ${smokeOpportunityRate}${bench?.avgSmokeRate !== undefined ? ` (${metricBenchmarkProvenance("avgSmokeRate")}: 기회 대비 평균 연막 구출률 ${bench.avgSmokeRate}%)` : ""}`);
    }

    // The UI labels this card as the potential tier of the top five matches.
    // Average all effective best-five benchmark scores/breakdowns here so a
    // minority mode cannot disappear from that single potential number. The
    // dominant mode still supplies `mainBench` for benchmark/role context.
    if (overallGroupScores.length > 0) {
      const validOverallCombat = overallGroupScores.map((s) => normalizeBenchmarkScore(s.combat));
      const validOverallTactical = overallGroupScores.map((s) => normalizeBenchmarkScore(s.tactical));
      const validOverallSurvival = overallGroupScores.map((s) => normalizeBenchmarkScore(s.survival));
      const validOverallScores = overallGroupScores.map((s) => normalizeBenchmarkScore(s.score));
      const overallAvgScore = validOverallScores.length > 0
        ? validOverallScores.reduce((a, b) => a + b, 0) / validOverallScores.length
        : 0;

      finalTierBreakdown = {
        combat: Number((validOverallCombat.reduce((a, b) => a + b, 0) / validOverallCombat.length).toFixed(1)),
        tactical: Number((validOverallTactical.reduce((a, b) => a + b, 0) / validOverallTactical.length).toFixed(1)),
        survival: Number((validOverallSurvival.reduce((a, b) => a + b, 0) / validOverallSurvival.length).toFixed(1)),
        total: Number(overallAvgScore.toFixed(1)),
      };
      mainUserTier = estimateUserTier(overallAvgScore);
    }

    const mainModeStats = aggregateMatches(groups[mainModeName] || []);
    const autoTopics = selectDebateTopics(mainModeStats, mainBench);
    userPrompt += `\n### [분석 집중 영역 (Debate Issues)]\n반드시 아래 3개 주제를 순서대로 다루어 주십시오:\n${autoTopics.map((t, i) => `${i + 1}. ${t}`).join(', ')}\n`;

    const canonicalDebateEvidence: Record<string, { user: { label: string; value: string }; benchmark: { label: string; value: string } }> = {};
    const addCanonicalEvidence = (
      key: string,
      userLabel: string,
      userValue: unknown,
      benchmarkLabel: string,
      benchmarkValue: unknown,
    ) => {
      if (!mainBench || benchmarkValue === undefined || benchmarkValue === null) return;
      if (typeof benchmarkValue === "number" && !Number.isFinite(benchmarkValue)) return;
      const benchmarkText = String(benchmarkValue).trim();
      if (!benchmarkText) return;
      const userText = String(userValue ?? "").trim();
      if (!userText) return;
      canonicalDebateEvidence[key] = {
        user: { label: userLabel, value: userText },
        benchmark: { label: benchmarkLabel, value: benchmarkText },
      };
    };
    const mainTradeRate = calculateBoundedRate(mainModeStats.totalTradeKills, mainModeStats.totalTeammateKnocks);
    const mainSmokeOpportunityRate = calculateBoundedRate(mainModeStats.totalSmokeRescues, mainModeStats.totalTeammateKnocks);
    addCanonicalEvidence("damage_average", "평균 화력", mainModeStats.avgDamage, "동일 티어 평균 화력", mainBench?.avgDamage);
    if (typeof mainModeStats.userInitiativeRate === "number" && Number.isFinite(mainModeStats.userInitiativeRate)) {
      addCanonicalEvidence("initiative_rate", "주도권 성공률", `${mainModeStats.userInitiativeRate}%`, "동일 티어 평균 주도권 성공률", mainBench?.avgInitiativeRate === undefined ? undefined : `${mainBench.avgInitiativeRate}%`);
    }
    if (typeof mainModeStats.avgDuelWinRate === "number" && Number.isFinite(mainModeStats.avgDuelWinRate)) {
      addCanonicalEvidence("duel_win_rate", "1:1 교전 승률", `${mainModeStats.avgDuelWinRate}%`, "동일 티어 평균 1:1 교전 승률", mainBench?.avgDuelWinRate === undefined ? undefined : `${mainBench.avgDuelWinRate}%`);
    }
    if (typeof mainModeStats.avgPressureIndex === "number" && Number.isFinite(mainModeStats.avgPressureIndex)) {
      addCanonicalEvidence("pressure_index", "평균 압박 지수", mainModeStats.avgPressureIndex, "동일 티어 평균 압박 지수", mainBench?.avgPressureIndex);
    }
    if (mainTradeRate !== null) {
      addCanonicalEvidence("trade_success_rate", "복수 성공률", `${mainTradeRate}%`, "동일 티어 평균 복수 성공률", mainBench?.avgTradeRate === undefined ? undefined : `${mainBench.avgTradeRate}%`);
    }
    if (mainSmokeOpportunityRate !== null) {
      addCanonicalEvidence("smoke_opportunity_rate", "아군 기절 대비 연막 구출률", `${mainSmokeOpportunityRate}%`, "동일 티어 기회 대비 평균 연막 구출률", mainBench?.avgSmokeRate === undefined ? undefined : `${mainBench.avgSmokeRate}%`);
    }
    if (mainModeStats.avgReactionLatency !== "측정 불가") {
      addCanonicalEvidence("reaction_latency", "대응 사격 속도", mainModeStats.avgReactionLatency, "동일 티어 평균 대응 사격 속도", mainBench?.avgCounterLatency === undefined ? undefined : `${mainBench.avgCounterLatency}s`);
    }
    if (mainModeStats.avgBackupLatency !== "측정 불가") {
      addCanonicalEvidence("backup_latency", "백업 속도", mainModeStats.avgBackupLatency, "동일 티어 평균 백업 속도", mainBench?.avgTradeLatency === undefined ? undefined : `${mainBench.avgTradeLatency}s`);
    }
    if (typeof mainModeStats.soloKillRate === "number" && Number.isFinite(mainModeStats.soloKillRate)) {
      addCanonicalEvidence("solo_kill_share", "솔로 킬 비중", `${mainModeStats.soloKillRate}%`, "동일 티어 평균 솔로 킬 비중", mainBench?.avgSoloKillRate === undefined ? undefined : `${mainBench.avgSoloKillRate}%`);
    }
    if (typeof mainModeStats.avgDeathPhase === "number" && Number.isFinite(mainModeStats.avgDeathPhase)) {
      addCanonicalEvidence("death_phase", "평균 사망 페이즈", mainModeStats.avgDeathPhase, "동일 티어 평균 사망 페이즈", mainBench?.avgDeathPhase);
    }
    const canonicalEvidence: CanonicalDebateEvidenceMap = canonicalDebateEvidence;
    // Role identity follows the same deterministic score-best-five aggregate
    // as the potential tier. Keep the dominant mode only as context for
    // solo/team role gating; do not discard minority-mode weapon or stat
    // evidence from the role score itself.
    const roleStatsWithDistribution = { ...summaryStats, modeDistribution: { main: mainModeName } };
    const roleInfo = classifyRole(roleStatsWithDistribution, mainBench, mainUserTier);
    userPrompt += `\n### [유저 전술적 정체성]\n- 부여된 칭호: ${roleInfo.title}\n- 전술 직업군: ${roleInfo.roleLabel}\n- 특징 요약: ${roleInfo.description}\n- 주요 취약점: ${roleInfo.weakness || "식별된 약점 없음 (완성형)"}\n- 시그니처 무기: ${roleInfo.signatureWeapon} (${roleInfo.signatureWeaponStats?.kills}킬, ${roleInfo.signatureWeaponStats?.dbnos}기절, 사용 일관성: ${roleInfo.signatureWeaponStats?.consistency}%)\n`;
    userPrompt += `\n[INSTRUCTION] 'finalVerdict' 필드에 위 '주요 취약점'에 대한 분석과 전체 토론 내용을 결합하여, 유저에게 깊은 인상을 남길 수 있는 최종 판결문을 작성하십시오.`;

    const reactionTier = (lat: string) => { const v = parseFloat(lat); return isNaN(v) ? "C" : v < 0.4 ? "S" : v < 0.6 ? "A" : v < 0.8 ? "B" : "C"; };
    const backupContextForVisuals = buildBackupCoachingContext({
      avgBackupLatency,
      totalTradeKills,
      totalRevCount,
      totalSmokeRescues,
      totalTeamWipes: masteryStats.totalTeamWipes,
      totalTeammateKnocks,
      benchmarkTradeLatency: mainBench?.avgTradeLatency,
    });

    const isolationVisual = (
      isolationCountFinal > 0
      || combatIsolationCountFinal > 0
      || deathIsolationCountFinal > 0
      || minDistCountFinal > 0
      || heightDiffCountFinal > 0
      || teammateCountFinal > 0
      || totalCrossfireCount > 0
    ) ? {
      ...(isolationCountFinal > 0 ? {
        isolationIndex: Number((totalIsolationIndexFinal / isolationCountFinal).toFixed(1)),
      } : {}),
      ...(combatIsolationCountFinal > 0 ? {
        combatIsolation: Number((totalCombatIso / combatIsolationCountFinal).toFixed(2)),
      } : {}),
      ...(deathIsolationCountFinal > 0 ? {
        deathIsolation: Number((totalDeathIso / deathIsolationCountFinal).toFixed(2)),
      } : {}),
      ...(minDistCountFinal > 0 ? {
        minDist: Math.round(totalMinDist / minDistCountFinal),
      } : {}),
      ...(heightDiffCountFinal > 0 ? {
        heightDiff: Math.round(totalHeightDiff / heightDiffCountFinal),
      } : {}),
      isCrossfire: totalCrossfireCount > 0,
      ...(teammateCountFinal > 0 ? {
        teammateCount: Math.round(totalTeammateCountFinal / teammateCountFinal),
      } : {}),
      userTier: mainUserTier,
      ...(mainBench?.avgIsolationIndex !== undefined ? { benchmarkIsolationIndex: mainBench.avgIsolationIndex } : {}),
      ...(mainBench?.avgMinDist !== undefined ? { benchmarkMinDist: mainBench.avgMinDist } : {}),
      ...(mainBench && mainBenchContext ? {
        benchmarkScope: {
          gameMode: mainBenchContext.gameMode,
          matchType: mainBenchContext.matchType,
          tier: mainBenchContext.tier,
          sampleCount: mainBench.sampleCount,
          ...(mainBench.metricSampleCounts ? { metricSampleCounts: mainBench.metricSampleCounts } : {}),
        },
      } : {}),
    } : null;

    const precomputedVisuals = {
      latestMatchTime, latestMatchCount: selectedMatches.length, bestMatchCount: bestMatches.length,
      counterLatency: avgBackupLatency, reactionLatency: avgReactionLatency,
      reactionTier: reactionTier(avgReactionLatency), backupTier: backupContextForVisuals.tier, overallTier: mainUserTier, roleInfo,
      ...(mainBench && mainBenchContext ? {
        benchmarkScope: {
          gameMode: mainBenchContext.gameMode,
          matchType: mainBenchContext.matchType,
          tier: mainBenchContext.tier,
          sampleCount: mainBench.sampleCount,
          ...(mainBench.metricSampleCounts ? { metricSampleCounts: mainBench.metricSampleCounts } : {}),
        },
      } : {}),
      tierBreakdown: finalTierBreakdown,
      initiativeSuccess: formatObservedPercent(userInitiativeRate), pressureIndex: avgPressureIndex,
      reversalRate: formatBoundedRate(totalReversalWins, totalReversalAttempts),
      duelStats: { winRate: formatObservedPercent(avgDuelWinRate), wins: totalDuelWins, losses: totalDuelLosses, reversals: totalReversalWins, reversalAttempts: totalReversalAttempts },
      teamImpact: { damageImpact: observedVisualValue(avgDamageImpact), topBadges },
      goldenTime: goldenTimeAvg, killContrib: killContribFinal, deathPhase: avgDeathPhase,
      bluezoneWaste: observedVisualValue(masteryStats.avgBluezoneWaste, true),
      maxHitDistance: observedVisualValue(masteryStats.totalMaxHitDist),
      focusFireCount: observedVisualValue(masteryStats.totalFocusFireCount),
      crossfireExposureCount: observedVisualValue(masteryStats.totalCrossfireExposureCount),
      edgePlay: observedVisualValue(masteryStats.totalEdgePlay),
      fatalDelay: observedVisualValue(masteryStats.totalFatalDelay),
      utility: {
        totalThrows: observedVisualValue(masteryStats.totalUtilityThrows),
        lethalThrows: observedVisualValue(masteryStats.totalLethalThrows),
        hits: observedVisualValue(masteryStats.totalUtilityHits),
        damage: observedVisualValue(masteryStats.totalUtilityDamage),
        kills: observedVisualValue(masteryStats.totalUtilityKills),
      },
      modeDistribution: { ranked: rankedCount, normal: normalCount, main: rankedCount >= normalCount ? "경쟁전" : "일반전" },
      tactical: {
        suppRate: formatBoundedRate(totalSuppCount, totalTeammateKnocks),
        tradeRate: formatBoundedRate(totalTradeKills, totalTeammateKnocks),
        smokeRate: formatBoundedRate(totalSmokeRescues, masteryStats.totalSmokeCount),
        reviveRate: formatBoundedRate(totalRevCount, totalTeammateKnocks),
        counts: {
          knocks: totalTeammateKnocks,
          smokes: totalSmokes,
          rescueSmokes: masteryStats.totalSmokeCount,
          smokeRescues: totalSmokeRescues,
          revives: totalRevCount,
          trades: totalTradeKills,
          supps: totalSuppCount,
          enemyTeamWipes: masteryStats.totalTeamWipes,
          initiative: { attempts: totalInitiativeAttempts, success: totalInitiativeSuccess }
        },
        baitCount: totalBaitCount, isolation: isolationVisual
      },
      mapStats: mapStatsResult,
      trends: trendsData
    };

    // Remove legacy fields before hashing so the identity matches exactly the
    // visuals that are emitted and persisted below.
    if (precomputedVisuals.roleInfo) {
      const ri = precomputedVisuals.roleInfo as any;
      delete ri.specialMetrics;
      delete ri.luckTrend;
      delete ri.circleLuck;
      delete ri.vehicleMastery;
    }

    const matchIdsHash = buildSummaryCacheHash({
      selectionKey,
      bestSelectionKey,
      latestScoreSelectionKey,
      systemPrompt: promptLines.join("\n"),
      userPrompt,
      precomputedVisuals,
    });

    // Parse model/cache output strictly before any language sanitizer runs.
    // The old extraction path used jsonrepair and could turn malformed model
    // output into a successful/cacheable response.  Debate evidence is
    // normalized first, then coaching prose is sanitized while stat label and
    // value fields remain byte-for-byte untouched. Benchmark language is
    // guarded per metric so a partial row cannot leak NULL comparisons while
    // an observed metric (for example, damage) remains usable.
    const sanitizeSummaryPayload = (value: unknown): unknown => {
      if (typeof value === "string") {
        const sanitized = sanitizeAiCoachingLanguageText(value);
        return sanitizeUnsupportedAiSummaryBenchmarkLanguage(sanitized, canonicalEvidence, { allowedMode: mainModeName });
      }
      if (Array.isArray(value)) return value.map((item) => sanitizeSummaryPayload(item));
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const sanitizedRecord = Object.fromEntries(
          Object.entries(record).map(([key, item]) => [
            key,
            key === "userStats" || key === "benchmarkStats"
              ? item
              : sanitizeSummaryPayload(item),
          ]),
        );
        if (Array.isArray(record.debateIssues)) {
          const neutralIssue = "검증된 경기 지표를 바탕으로 분석합니다.";
          sanitizedRecord.debateIssues = record.debateIssues.map((issue, issueIndex) => {
              if (!issue || typeof issue !== "object") return sanitizeSummaryPayload(issue);

              const issueRecord = issue as Record<string, unknown>;
              const sanitizedIssue = sanitizeSummaryPayload(issue) as Record<string, unknown>;
              const sanitizedTopic = typeof sanitizedIssue.topic === "string"
                ? sanitizedIssue.topic.trim()
                : "";
              const rawTopicHasForeignMode = typeof issueRecord.topic === "string"
                && hasUnsupportedAiSummaryMode(issueRecord.topic, mainModeName);
              const topic = sanitizedTopic
                && sanitizedTopic !== neutralIssue
                && !rawTopicHasForeignMode
                ? sanitizedTopic
                : autoTopics[issueIndex] || "분석 항목";
              const question = typeof issueRecord.question === "string"
                ? sanitizeAiCoachingLanguageText(issueRecord.question)
                : "";

              if (hasUnsupportedAiSummaryMode(issue, mainModeName)) {
                return {
                  ...sanitizedIssue,
                  topic,
                  question: sanitizeAiSummaryDebateQuestion("", topic),
                  kindOpinion: neutralIssue,
                  spicyOpinion: neutralIssue,
                  reason: neutralIssue,
                  evaluation: neutralIssue,
                  userStats: [],
                  benchmarkStats: [],
                };
              }
              const userStats = sanitizedIssue.userStats;
              const benchmarkStats = sanitizedIssue.benchmarkStats;
              sanitizedIssue.topic = topic;
              sanitizedIssue.question = sanitizeAiSummaryDebateQuestion(
                question,
                topic,
                canonicalEvidence,
                {
                  allowedMode: mainModeName,
                  userStats,
                  benchmarkStats,
                },
              );
              return sanitizedIssue;
            });
        }
        return sanitizedRecord;
      }
      return value;
    };

    const canonicalizeFinalJson = (raw: string): string | null => {
      const trimmed = raw.trim();
      if (!trimmed) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        return null;
      }

      const normalized = normalizeAiSummaryDebatePayload(parsed, {
        canonicalEvidence,
      });
      if (!normalized) return null;
      return JSON.stringify(sanitizeSummaryPayload(normalized));
    };

    // Cache lookup must happen after every effective prompt/visual/benchmark
    // input is computed, but before requiring a Gemini key or constructing a
    // model. This keeps cache hits usable during key outages.
    if (!force) {
      if (isRouteAborted()) return abortResponse();
      try {
        const { data: cached, error: cacheErr } = await awaitWithAbort(supabase
          .from("player_ai_summary_cache")
          .select("ai_result")
          .eq("player_id", lowerNickname)
          .eq("platform", cachePlatform)
          .eq("match_ids_hash", matchIdsHash)
          .eq("prompt_version", AI_SUMMARY_CACHE_VERSION)
          .abortSignal(routeSignal.signal)
          .maybeSingle(), routeSignal.signal);

        if (isRouteAborted()) return abortResponse();
        if (!cacheErr && cached && cached.ai_result) {
          const cachedData = cached.ai_result as any;
          const cachedFinalCandidate = typeof cachedData.final === "string"
            ? cachedData.final
            : JSON.stringify(cachedData.final ?? "");
          const canonicalCachedFinal = typeof cachedFinalCandidate === "string"
            ? canonicalizeFinalJson(cachedFinalCandidate)
            : null;
          if (canonicalCachedFinal) {
            trackAiUsage(authenticatedUserId, "gemini-cache", 0, 0, "summary", {
              durationMs: Date.now() - startedAt,
              requestId,
              platform: requestedPlatform,
            });
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              start(controller) {
                // The final debate text is cacheable, but visuals describe the
                // freshly recomputed match/benchmark inputs for this request.
                // Never replay stale cached visuals alongside a valid final.
                controller.enqueue(encoder.encode(JSON.stringify({ type: "visuals", data: precomputedVisuals }) + "\n"));
                controller.enqueue(encoder.encode(JSON.stringify({ type: "final", data: canonicalCachedFinal }) + "\n"));
                controller.enqueue(encoder.encode(JSON.stringify({ type: "done", valid: true }) + "\n"));
                controller.close();
              }
            });
            return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
          }
          // A cache row written with an empty/invalid final payload is not a
          // successful hit. Skip it so the normal Gemini/error path decides
          // what to return, and never expose or persist the malformed JSON.
          console.warn("[AI-SUMMARY] Ignoring malformed summary cache final");
        }
      } catch (dbErr) {
        console.warn("[AI-SUMMARY] Cache lookup failed:", dbErr);
      }
    }

    if (isRouteAborted()) return abortResponse();
    const geminiApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!geminiApiKey) {
      trackAiFailure(authenticatedUserId, "summary", "No API Key", { errorCode: "configuration", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "No API Key" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const modelsToTry = GEMINI_MODELS_TO_TRY;
    let streamResult: any = null;
    let selectedModelName = "";
    let selectedModelAttemptSignalCleanup: (() => void) | null = null;

    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
    ];

    const generationStartedAt = Date.now();
    const generationBudgetMs = Math.min(
      AI_SUMMARY_TOTAL_TIMEOUT_MS,
      Math.max(0, routeDeadlineAt - generationStartedAt),
    );
    if (generationBudgetMs <= 0 || isRouteAborted()) return abortResponse();

    const generationDeadlineAt = generationStartedAt + generationBudgetMs;
    const generationDeadlineController = new AbortController();
    const generationDeadlineTimer = setTimeout(
      () => generationDeadlineController.abort(),
      generationBudgetMs,
    );
    const generationSignal = composeAbortSignals([
      routeSignal.signal,
      generationDeadlineController.signal,
    ]);
    const overallSignal = generationSignal.signal;
    let generationSignalCleaned = false;
    const cleanupGeneration = () => {
      if (generationSignalCleaned) return;
      generationSignalCleaned = true;
      clearTimeout(generationDeadlineTimer);
      generationSignal.cleanup();
      selectedModelAttemptSignalCleanup?.();
      selectedModelAttemptSignalCleanup = null;
    };
    let generationTimedOut = false;
    let modelTimeoutObserved = false;
    for (const modelName of modelsToTry) {
      const remainingGenerationMs = generationDeadlineAt - Date.now();
      if (remainingGenerationMs <= 0 || overallSignal.aborted || request.signal.aborted) {
        generationTimedOut = true;
        break;
      }

      const modelAttemptController = new AbortController();
      const modelAttemptBudgetMs = Math.min(AI_SUMMARY_MODEL_TIMEOUT_MS, remainingGenerationMs);
      let modelAttemptTimedOut = false;
      const modelAttemptTimer = setTimeout(
        () => {
          modelAttemptTimedOut = true;
          modelTimeoutObserved = true;
          modelAttemptController.abort();
        },
        modelAttemptBudgetMs,
      );
      const modelAttemptSignal = composeAbortSignals([
        generationSignal.signal,
        modelAttemptController.signal,
      ]);
      const markModelAttemptTimeout = () => {
        modelAttemptTimedOut = true;
      };
      let preserveModelAttemptSignal = false;
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: promptLines.join("\n"),
          generationConfig: { responseMimeType: "application/json", temperature: 0.75, maxOutputTokens: 2500 },
          safetySettings
        });

        modelAttemptController.signal.addEventListener("abort", markModelAttemptTimeout, { once: true });
        streamResult = await awaitWithAbort(model.generateContentStream(userPrompt, {
          signal: modelAttemptSignal.signal,
        }), modelAttemptSignal.signal);

        if (overallSignal.aborted || request.signal.aborted) {
          generationTimedOut = true;
          streamResult = null;
          break;
        }
        if (modelAttemptTimedOut) {
          streamResult = null;
          console.warn(`[AI-SUMMARY] Model ${modelName} timed out; trying next...`);
          continue;
        }

        if (streamResult) {
          selectedModelName = modelName;
          preserveModelAttemptSignal = true;
          selectedModelAttemptSignalCleanup = modelAttemptSignal.cleanup;
          if (streamResult.response && typeof streamResult.response.then === "function") {
            streamResult.response.then((res: any) => {
              if (res?.usageMetadata && !isRouteAborted()) {
                trackAiUsage(
                  auth.user?.id,
                  selectedModelName,
                  res.usageMetadata.promptTokenCount,
                  res.usageMetadata.candidatesTokenCount,
                  "summary",
                  { durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform },
                );
              }
            }).catch((err: any) => console.error("[AI-SUMMARY] Usage fetch error:", err));
          }
          break;
        }
      } catch (err: any) {
        const errorMessage = String(err?.message || "");
        const providerTimedOut = err?.name === "TimeoutError"
          || /timeout|timed out/i.test(errorMessage);
        const providerAborted = err?.name === "AbortError"
          || /request aborted/i.test(errorMessage);
        if (overallSignal.aborted || request.signal.aborted) {
          generationTimedOut = true;
          streamResult = null;
          break;
        }
        if (modelAttemptTimedOut) {
          modelTimeoutObserved = true;
          streamResult = null;
          console.warn(`[AI-SUMMARY] Model ${modelName} timed out; trying next...`);
          continue;
        }
        if (providerTimedOut || providerAborted) {
          modelTimeoutObserved = true;
          streamResult = null;
          console.warn(`[AI-SUMMARY] Model ${modelName} provider timeout/abort; trying next...`);
          continue;
        }
        console.warn(`[AI-SUMMARY] Model ${modelName} failed (${errorMessage}), trying next...`);
      } finally {
        clearTimeout(modelAttemptTimer);
        modelAttemptController.signal.removeEventListener("abort", markModelAttemptTimeout);
        if (!preserveModelAttemptSignal) modelAttemptSignal.cleanup();
      }
    }

    if (generationTimedOut || isRouteAborted() || (modelTimeoutObserved && !streamResult)) {
      cleanupGeneration();
      return abortResponse();
    }
    if (!streamResult) cleanupGeneration();

    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      cancel(reason) {
        if (!streamAbortController.signal.aborted) streamAbortController.abort(reason);
      },
      async start(controller) {
        let aiResponseText = "";
        try {
          if (isRouteAborted() || generationSignal.signal.aborted) throw new Error("AI summary request was aborted");

          // [V45.0] 구형 필드 잔재 강제 제거 (Sanitization)
          if (precomputedVisuals.roleInfo) {
            const ri = precomputedVisuals.roleInfo as any;
            delete ri.specialMetrics;
            delete ri.luckTrend;
            delete ri.circleLuck;
            delete ri.vehicleMastery;
          }

          // 1. 비주얼 데이터 우선 전송
          controller.enqueue(encoder.encode(JSON.stringify({ type: "visuals", data: precomputedVisuals }) + "\n"));

          // 4. Gemini 스트리밍 결과 처리
          if (streamResult) {
            const iterator = streamResult.stream[Symbol.asyncIterator]();
            try {
              while (true) {
                if (isRouteAborted() || generationSignal.signal.aborted) throw new Error("AI summary request was aborted");
                const nextPromise = iterator.next();
                // If the route signal wins the race, retain a rejection handler
                // on the SDK iterator so a later provider rejection is observed.
                nextPromise.catch(() => undefined);
                const abortPromise = createAbortPromise(generationSignal.signal);
                let nextResult: IteratorResult<any>;
                try {
                  nextResult = await Promise.race([nextPromise, abortPromise.promise]) as IteratorResult<any>;
                } finally {
                  abortPromise.cleanup();
                }
                if (generationSignal.signal.aborted || isRouteAborted()) {
                  throw new Error("AI summary request was aborted");
                }
                if (nextResult.done) break;
                const chunkText = nextResult.value?.text?.();
                if (typeof chunkText === "string") aiResponseText += chunkText;
              }
            } finally {
              if (generationSignal.signal.aborted || isRouteAborted()) {
                try {
                  const returnPromise = iterator.return?.();
                  returnPromise?.catch(() => undefined);
                } catch {
                  // Iterator cleanup is best effort after cancellation.
                }
              }
            }

          }

          if (isRouteAborted() || generationSignal.signal.aborted) throw new Error("AI summary request was aborted");

          // [V54.4] 최종 데이터 정제 및 단일 chunk 전송
          // An empty provider stream is an invalid generation. Let the error
          // path emit the neutral provider-error contract and skip persistence.
          const finalResult = aiResponseText;
          const validJsonString = canonicalizeFinalJson(finalResult);

          if (validJsonString) {
            if (isRouteAborted() || generationSignal.signal.aborted) throw new Error("AI summary request was aborted");
            // [V54.3] 'chunk' 대신 'final' 타입을 사용하여 데이터 중복 방지
            controller.enqueue(encoder.encode(JSON.stringify({
              type: "final",
              data: validJsonString
            }) + "\n"));

            // 3. Write to DB Cache
            if (isRouteAborted() || generationSignal.signal.aborted) throw new Error("AI summary request was aborted");
            const persistenceSignal = streamResult ? generationSignal.signal : routeSignal.signal;
            try {
              const savePromise = supabase
                .from("player_ai_summary_cache")
                .upsert({
                    player_id: lowerNickname,
                    platform: cachePlatform,
                    match_ids_hash: matchIdsHash,
                    prompt_version: AI_SUMMARY_CACHE_VERSION,
                    ai_result: {
                      visuals: precomputedVisuals,
                      final: validJsonString
                    },
                    updated_at: new Date().toISOString()
                  }, { onConflict: "player_id,platform,match_ids_hash,prompt_version" })
                .abortSignal(persistenceSignal);
              const saveAbort = createAbortPromise(persistenceSignal);
              let saveResult: { error?: any };
              try {
                saveResult = await Promise.race([savePromise, saveAbort.promise]) as { error?: any };
              } finally {
                saveAbort.cleanup();
              }
              if (isRouteAborted() || persistenceSignal.aborted) throw new Error("AI summary request was aborted");
              const saveErr = saveResult?.error;
              if (saveErr) throw saveErr;
            } catch (saveErr: any) {
              if (isRouteAborted() || persistenceSignal.aborted) throw new Error("AI summary request was aborted");
              console.warn("[AI-SUMMARY] Failed to write cache to DB:", saveErr.message || saveErr);
            }

            // 3. 완료 신호
            if (isRouteAborted() || generationSignal.signal.aborted) throw new Error("AI summary request was aborted");
            controller.enqueue(encoder.encode(JSON.stringify({ type: "done", valid: true }) + "\n"));
          } else {
            throw new Error("No valid JSON extracted from AI response");
          }
        } catch (e: any) {
          // Consumer cancellation already closes the Web Stream. It is normal
          // lifecycle cleanup, not an AI failure and not a place to emit a
          // terminal record into the now-closed controller.
          if (isStreamCancelled()) return;
          try {
            console.error("[AI-SUMMARY-STREAM-ERROR] Critical failure during stream generation:", e?.message || e);
          } catch {
            // Logging is best effort and must never prevent the terminal record.
          }
          try {
            trackAiFailure(authenticatedUserId, "summary", e, {
              durationMs: Date.now() - startedAt,
              requestId,
              platform: requestedPlatform,
            });
          } catch (trackingError) {
            try {
              console.error("[AI-SUMMARY-STREAM-ERROR] Failure tracking failed:", trackingError);
            } catch {
              // Tracking/logging failures must not prevent the terminal record.
            }
          }

          const isAbortFailure = isRouteAborted() || generationSignal.signal.aborted || e?.name === "AbortError";
          const errorCode = isAbortFailure
            ? request.signal.aborted
              ? "PUBG_AI_CANONICAL_NOT_READY"
              : "PUBG_AI_ROUTE_TIMEOUT"
            : "PUBG_AI_PROVIDER_ERROR";
          const errorMessage = isAbortFailure
            ? request.signal.aborted
              ? "canonical match analysis is not ready"
              : "AI summary request timed out"
            : AI_SUMMARY_PROVIDER_ERROR_MESSAGE;
          const errorRecord = {
            type: "error",
            error: errorMessage,
            errorCode,
            retryable: true,
          };
          const doneRecord = {
            type: "done",
            valid: false,
            error: errorMessage,
            errorCode,
            retryable: true,
          };
          const enqueueRecord = (record: Record<string, unknown>) => {
            try {
              controller.enqueue(encoder.encode(JSON.stringify(record) + "\n"));
            } catch (enqueueError) {
              try {
                console.error("[AI-SUMMARY-STREAM-ERROR] Failed to emit terminal record:", enqueueError);
              } catch {
                // The consumer may already have closed the stream.
              }
            }
          };

          // Always attempt the terminal done record, even if emitting the
          // preceding error record throws or another error handler fails.
          try {
            enqueueRecord(errorRecord);
          } finally {
            enqueueRecord(doneRecord);
          }
        } finally {
          cleanupGeneration();
          cleanupRouteDeadline();
          if (!isStreamCancelled()) {
            try {
              controller.close();
            } catch {
              // The consumer may close the body between the final guard and
              // close(). All producer work is already cleaned up above.
            }
          }
        }
      }
    }), {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Content-Type-Options": "nosniff"
      }
    });
    streamOwnsRouteDeadline = true;
    return response;
  } catch (error: any) {
    if (isRouteAborted()) return abortResponse();
    const dependencyFailure = classifySummaryDependencyFailure(error);
    if (dependencyFailure) return summaryDependencyResponse(dependencyFailure);
    console.error("[AI-SUMMARY] CRITICAL ERROR:", error.message || error);
    trackAiFailure(authenticatedUserId, "summary", error, {
      durationMs: Date.now() - startedAt,
      requestId,
      platform: requestedPlatform,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    if (!streamOwnsRouteDeadline) cleanupRouteDeadline();
  }
}
