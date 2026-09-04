import { normalizeName } from "./utils";
import { normalizeBenchmarkScore, normalizeMatchId } from "./recentMatchSelection";
import { POPULATION_EVIDENCE_VERSION } from "./constants";

export type CanonicalMatchLookup = {
  matchId: string;
  playerId: string;
  platform: string;
  minResultVersion: number;
  /** AI/benchmark callers must opt into the marked human-BR population. */
  requirePopulationEvidence?: boolean;
  /** The current AI contract is exact v73, not merely a future-compatible minimum. */
  requireExactResultVersion?: boolean;
  /** AI prompt callers require finite, non-negative canonical base stats. */
  requirePromptSafeStats?: boolean;
};

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedName(value: unknown): string | null {
  return typeof value === "string" ? normalizeName(value) || null : null;
}

function normalizedPlatform(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? normalizePlatform(value) : null;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasPromptSafeStats(stats: PlainRecord): boolean {
  const winPlace = stats.winPlace;
  if (!isFiniteNonNegativeNumber(winPlace) || !Number.isInteger(winPlace) || winPlace < 1) return false;

  for (const key of ["kills", "assists", "DBNOs", "timeSurvived"] as const) {
    if (!isFiniteNonNegativeNumber(stats[key])) return false;
  }

  // The prompt prefers processedDamageDealt, falling back to the official
  // damageDealt value only when the processed value is absent/null.
  return isFiniteNonNegativeNumber(stats.processedDamageDealt ?? stats.damageDealt);
}

/**
 * Return only a current, identity-matching canonical analysis row.
 *
 * The row is service-role data, but it still crosses an untrusted request
 * boundary. Keep the checks here deliberately structural and fail closed so
 * callers never accidentally hand a malformed or copied result to an AI
 * prompt.
 */
export function getValidFullResultForMatch(
  row: unknown,
  expected: CanonicalMatchLookup,
): Record<string, unknown> | null {
  if (!isRecord(row) || !isRecord(row.data) || !isRecord(row.data.fullResult)) return null;

  const expectedMatchId = normalizeMatchId(expected?.matchId);
  const expectedPlayerId = normalizedName(expected?.playerId);
  const expectedPlatform = normalizedPlatform(expected?.platform);
  const minResultVersion = expected?.minResultVersion;
  if (!expectedMatchId || !expectedPlayerId || !expectedPlatform ||
      typeof minResultVersion !== "number" || !Number.isFinite(minResultVersion)) {
    return null;
  }

  if (normalizeMatchId(row.match_id) !== expectedMatchId) return null;

  // The storage identity is authoritative too; do not accept a copied row
  // merely because the embedded stats happen to mention the requested player.
  if (normalizedName(row.player_id) !== expectedPlayerId) return null;
  if (normalizedPlatform(row.platform) !== expectedPlatform) return null;

  const fullResult = row.data.fullResult;
  const embeddedMatchIds = ["matchId", "match_id", "id"]
    .filter((key) => key in fullResult && fullResult[key] !== undefined && fullResult[key] !== null)
    .map((key) => normalizeMatchId(fullResult[key]));
  if (embeddedMatchIds.length === 0 || embeddedMatchIds.some((id) => !id || id !== expectedMatchId)) {
    return null;
  }

  if (!isRecord(fullResult.stats) || typeof fullResult.stats.name !== "string" || !fullResult.stats.name.trim()) {
    return null;
  }
  if (expected.requirePromptSafeStats === true && !hasPromptSafeStats(fullResult.stats)) return null;
  // Preserve the established player/name/platform validator semantics while
  // requiring explicit embedded identity fields for every canonical reader.
  if (!isFullResultForPlayerPlatform(fullResult, expectedPlayerId, expectedPlatform)) return null;

  const version = fullResult.v;
  if (typeof version !== "number" || !Number.isFinite(version) || version < minResultVersion) return null;
  if (expected.requireExactResultVersion === true && version !== minResultVersion) return null;

  if (expected.requirePopulationEvidence === true
    && fullResult.populationEvidenceVersion !== POPULATION_EVIDENCE_VERSION) {
    return null;
  }

  return fullResult;
}

export function normalizePlatform(platform?: string | null): string {
  return String(platform || "steam").trim().toLowerCase() || "steam";
}

export function isFullResultForPlayerPlatform(
  fullResult: any,
  expectedPlayerId: string,
  expectedPlatform: string
): boolean {
  if (!fullResult) return false;

  const playerId = normalizeName(expectedPlayerId);
  const platform = normalizedPlatform(expectedPlatform);
  if (!playerId || !platform) return false;
  const statsName = normalizeName(fullResult.stats?.name || "");
  if (!playerId || !statsName || statsName !== playerId) return false;

  // Never infer storage identity from the display name. A copied/legacy
  // fullResult without an explicit account binding is not safe for canonical
  // AI or benchmark consumers.
  if (typeof fullResult.player_id !== "string" || !fullResult.player_id.trim()) return false;
  const embeddedPlayerId = normalizeName(fullResult.player_id);
  if (!embeddedPlayerId || embeddedPlayerId !== playerId) return false;

  if (typeof fullResult.platform !== "string" || !fullResult.platform.trim()) return false;
  const resultPlatform = normalizePlatform(fullResult.platform);
  return resultPlatform === platform;
}

export function getValidFullResult(
  row: any,
  expectedPlayerId: string,
  expectedPlatform: string
): any | null {
  const fullResult = row?.data?.fullResult;
  return isFullResultForPlayerPlatform(fullResult, expectedPlayerId, expectedPlatform)
    ? fullResult
    : null;
}

/**
 * Legacy validator for ordinary history/detail summaries.
 *
 * Older processed rows may omit the embedded account/platform fields even
 * though the query itself is already scoped by storage identity. Keep this
 * compatibility behavior explicitly named and out of AI/benchmark readers,
 * which must use getValidFullResultForMatch instead.
 */
export function getLegacyFullResultForHistory(
  row: any,
  expectedPlayerId: string,
  expectedPlatform: string,
): any | null {
  const fullResult = row?.data?.fullResult;
  if (!fullResult || typeof fullResult !== "object" || Array.isArray(fullResult)) return null;

  const playerId = normalizeName(expectedPlayerId);
  const platform = normalizedPlatform(expectedPlatform);
  const statsName = normalizeName(fullResult.stats?.name || "");
  if (!playerId || !platform || !statsName || statsName !== playerId) return null;

  // Preserve the pre-strict ordinary-summary behavior: if an embedded field
  // exists it must agree, but absent legacy fields are tolerated because the
  // storage query is already bound to player_id/platform.
  if (fullResult.player_id !== undefined && fullResult.player_id !== null) {
    if (typeof fullResult.player_id !== "string" || !fullResult.player_id.trim()) return null;
    if (normalizeName(fullResult.player_id) !== playerId) return null;
  }
  if (fullResult.platform !== undefined && fullResult.platform !== null) {
    if (typeof fullResult.platform !== "string" || !fullResult.platform.trim()) return null;
    if (normalizePlatform(fullResult.platform) !== platform) return null;
  }

  return fullResult;
}

export function buildProcessedTelemetryUpsert(
  matchId: string,
  playerId: string,
  platform: string,
  fullResult: any
) {
  const normalizedPlayerId = normalizeName(playerId);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedFullResult: PlainRecord = {
    ...(isRecord(fullResult) ? fullResult : {}),
    player_id: normalizedPlayerId,
    platform: normalizedPlatform,
  };

  const benchmark = normalizedFullResult.benchmark;
  if (isRecord(benchmark)) {
    const normalizedBenchmark: PlainRecord = { ...benchmark };
    if ("score" in normalizedBenchmark) {
      normalizedBenchmark.score = normalizeBenchmarkScore(normalizedBenchmark.score);
    }

    const breakdown = normalizedBenchmark.breakdown;
    if (isRecord(breakdown)) {
      const normalizedBreakdown: PlainRecord = { ...breakdown };
      for (const key of ["combat", "tactical", "survival"] as const) {
        if (key in normalizedBreakdown) {
          normalizedBreakdown[key] = normalizeBenchmarkScore(normalizedBreakdown[key]);
        }
      }
      normalizedBenchmark.breakdown = normalizedBreakdown;
    }

    normalizedFullResult.benchmark = normalizedBenchmark;
  }

  return {
    match_id: matchId,
    platform: normalizedPlatform,
    player_id: normalizedPlayerId,
    data: {
      fullResult: normalizedFullResult
    },
    updated_at: new Date().toISOString()
  };
}
