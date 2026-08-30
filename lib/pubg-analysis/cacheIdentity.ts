import { normalizeName } from "./utils";
import { normalizeMatchId } from "./recentMatchSelection";

export type CanonicalMatchLookup = {
  matchId: string;
  playerId: string;
  platform: string;
  minResultVersion: number;
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
  if ("player_id" in fullResult &&
      (typeof fullResult.player_id !== "string" || !fullResult.player_id.trim())) {
    return null;
  }

  // Preserve the established player/name/platform validator semantics while
  // enforcing a non-default platform field for canonical rows above.
  if (!isFullResultForPlayerPlatform(fullResult, expectedPlayerId, expectedPlatform)) return null;
  if (normalizedPlatform(fullResult.platform) !== expectedPlatform) {
    return null;
  }

  const version = fullResult.v;
  if (typeof version !== "number" || !Number.isFinite(version) || version < minResultVersion) return null;

  return fullResult;
}

export function normalizePlatform(platform?: string | null): string {
  return String(platform || "steam").trim().toLowerCase() || "steam";
}

export function isFullResultForPlayerPlatform(
  fullResult: any,
  expectedPlayerId: string,
  expectedPlatform: string = "steam"
): boolean {
  if (!fullResult) return false;

  const playerId = normalizeName(expectedPlayerId);
  const statsName = normalizeName(fullResult.stats?.name || "");
  if (!playerId || !statsName || statsName !== playerId) return false;

  const embeddedPlayerId = normalizeName(fullResult.player_id || statsName);
  if (embeddedPlayerId && embeddedPlayerId !== playerId) return false;

  const resultPlatform = normalizePlatform(fullResult.platform);
  return resultPlatform === normalizePlatform(expectedPlatform);
}

export function getValidFullResult(
  row: any,
  expectedPlayerId: string,
  expectedPlatform: string = "steam"
): any | null {
  const fullResult = row?.data?.fullResult;
  return isFullResultForPlayerPlatform(fullResult, expectedPlayerId, expectedPlatform)
    ? fullResult
    : null;
}

export function buildProcessedTelemetryUpsert(
  matchId: string,
  playerId: string,
  platform: string,
  fullResult: any
) {
  const normalizedPlayerId = normalizeName(playerId);
  const normalizedPlatform = normalizePlatform(platform);

  return {
    match_id: matchId,
    platform: normalizedPlatform,
    player_id: normalizedPlayerId,
    data: {
      fullResult: {
        ...fullResult,
        player_id: normalizedPlayerId,
        platform: normalizedPlatform
      }
    },
    updated_at: new Date().toISOString()
  };
}
