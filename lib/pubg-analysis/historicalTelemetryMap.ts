import { getLegacyFullResultForHistory } from "./cacheIdentity";
import { buildTelemetryCacheKey } from "./telemetryCacheKey.server";
import type { TelemetryIdentity, TelemetryMode, TelemetryPlatform } from "./telemetryIdentity";

const ACCOUNT_ID = /^account\.[A-Za-z0-9_-]+$/;

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function accountId(value: unknown): string | null {
  return typeof value === "string" && ACCOUNT_ID.test(value.trim()) ? value.trim() : null;
}

export function resolveHistoricalAccountId(input: {
  matchId: string; platform: TelemetryPlatform; playerId: string;
  playerMatchRows: unknown; processedRows: unknown;
}): { status: "resolved"; accountId: string } | { status: "absent" | "conflict" } {
  const normalizedPlayerId = input.playerId.trim().toLowerCase();
  const candidates = new Set<string>();
  for (const value of Array.isArray(input.playerMatchRows) ? input.playerMatchRows : []) {
    const row = record(value);
    if (!row || row.match_id !== input.matchId || row.platform !== input.platform
      || typeof row.player_id !== "string" || row.player_id.trim().toLowerCase() !== normalizedPlayerId) continue;
    const id = accountId(row.account_id);
    if (id) candidates.add(id);
  }
  let conflictingEvidence = false;
  for (const value of Array.isArray(input.processedRows) ? input.processedRows : []) {
    const row = record(value);
    if (!row || row.match_id !== input.matchId || row.platform !== input.platform
      || typeof row.player_id !== "string" || row.player_id.trim().toLowerCase() !== normalizedPlayerId) continue;
    const fullResult = getLegacyFullResultForHistory(row, normalizedPlayerId, input.platform);
    const stats = record(fullResult?.stats);
    if (!stats || typeof stats.name !== "string" || stats.name.trim().toLowerCase() !== normalizedPlayerId) continue;
    const embeddedMatchId = fullResult.matchId ?? fullResult.match_id;
    if (embeddedMatchId !== undefined && embeddedMatchId !== input.matchId) {
      conflictingEvidence = true;
      continue;
    }
    const ids = [accountId(stats.playerId), accountId(stats.accountId), accountId(fullResult.playerId), accountId(fullResult.accountId)]
      .filter((id): id is string => Boolean(id));
    if (new Set(ids).size > 1) {
      conflictingEvidence = true;
      continue;
    }
    if (ids[0]) candidates.add(ids[0]);
  }
  if (conflictingEvidence || candidates.size > 1) return { status: "conflict" };
  if (candidates.size === 1) return { status: "resolved", accountId: [...candidates][0] };
  return { status: "absent" };
}

export type HistoricalMapCacheRow = {
  match_id: string; platform: string; player_id: string; mode: string;
  telemetry_version: number; storage_path: string; status: string;
};

export function selectHistoricalMapCacheCandidates(
  rows: unknown,
  identity: Omit<TelemetryIdentity, "telemetryVersion">,
  currentVersion: number,
  limit = 8,
): Array<{ identity: TelemetryIdentity; storagePath: string }> {
  const candidates: Array<{ identity: TelemetryIdentity; storagePath: string }> = [];
  for (const value of Array.isArray(rows) ? rows : []) {
    const row = record(value) as HistoricalMapCacheRow | null;
    if (!row || row.status !== "ready" || row.match_id !== identity.matchId
      || row.platform !== identity.platform || row.player_id !== identity.playerId
      || row.mode !== identity.mode || typeof row.telemetry_version !== "number"
      || !Number.isFinite(row.telemetry_version) || row.telemetry_version <= 0
      || row.telemetry_version > currentVersion || typeof row.storage_path !== "string") continue;
    const cacheIdentity: TelemetryIdentity = { ...identity, telemetryVersion: row.telemetry_version };
    const canonicalPath = buildTelemetryCacheKey(cacheIdentity);
    if (row.storage_path === canonicalPath) candidates.push({ identity: cacheIdentity, storagePath: canonicalPath });
  }
  return candidates.sort((a, b) => b.identity.telemetryVersion - a.identity.telemetryVersion)
    .slice(0, Math.max(0, limit));
}

export function historicalMapIdentity(
  matchId: string, platform: TelemetryPlatform, playerId: string, mode: TelemetryMode,
): Omit<TelemetryIdentity, "telemetryVersion"> {
  return { matchId, platform, playerId, mode };
}
