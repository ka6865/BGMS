/**
 * Pure policy and identity helpers shared by linked-player sync workers and
 * the interactive player route.
 */

export type LinkedPlayerSyncStatus =
  | "idle"
  | "running"
  | "success"
  | "failed"
  | "invalid_nickname"
  | "rate_limited";

export type LinkedPlayerSyncPlatform = "steam" | "kakao";

export interface LinkedPlayerSyncCandidate {
  platform: string;
  normalizedNickname: string;
  displayNickname: string;
  lastActiveAt: string;
  lastSuccessAt: string | null;
  nextEligibleAt: string | null;
  consecutiveFailures: number;
  status?: LinkedPlayerSyncStatus;
}

export interface LinkedPlayerSyncOutcome {
  status: LinkedPlayerSyncStatus;
  consecutiveFailures?: number;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  nextEligibleAt?: string | null;
  lastErrorCode?: string | null;
  rateLimitResetAt?: string | number | null;
  rateLimitResetAtMs?: number | null;
  retryAfterMs?: number | null;
  newMatches?: number;
  [key: string]: unknown;
}

const HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const SUPPORTED_PLATFORMS = new Set<LinkedPlayerSyncPlatform>(["steam", "kakao"]);

/** Returns the transient-failure delay for the current consecutive count. */
export function getLinkedPlayerSyncBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return HOUR_MS;
  if (consecutiveFailures === 2) return SIX_HOURS_MS;
  return DAY_MS;
}

function addMs(nowMs: number, delayMs: number): string {
  return new Date(nowMs + delayMs).toISOString();
}

function parseRateLimitResetAt(outcome: LinkedPlayerSyncOutcome, nowMs: number): string | null {
  const resetAt = outcome.rateLimitResetAt;
  if (typeof resetAt === "string") {
    const resetAtMs = Date.parse(resetAt);
    if (Number.isFinite(resetAtMs) && resetAtMs > nowMs) {
      return new Date(resetAtMs).toISOString();
    }
  }

  if (typeof resetAt === "number" && resetAt > nowMs) {
    return new Date(resetAt).toISOString();
  }

  if (typeof outcome.rateLimitResetAtMs === "number" && outcome.rateLimitResetAtMs > nowMs) {
    return new Date(outcome.rateLimitResetAtMs).toISOString();
  }

  if (typeof outcome.retryAfterMs === "number" && outcome.retryAfterMs > 0) {
    return addMs(nowMs, outcome.retryAfterMs);
  }

  return null;
}

/** Calculates the next time a completed sync may be selected again. */
export function getLinkedPlayerSyncNextEligibleAt(
  outcome: LinkedPlayerSyncOutcome,
  nowMs: number,
): string {
  switch (outcome.status) {
    case "success":
      return addMs(nowMs, DAY_MS);
    case "invalid_nickname":
      return addMs(nowMs, WEEK_MS);
    case "rate_limited":
      return parseRateLimitResetAt(outcome, nowMs) ?? addMs(nowMs, HOUR_MS);
    case "failed":
      return addMs(nowMs, getLinkedPlayerSyncBackoffMs(outcome.consecutiveFailures ?? 1));
    case "idle":
    case "running":
      return outcome.nextEligibleAt ?? new Date(nowMs).toISOString();
  }
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase();
}

/** Canonical platform validation shared by the server RPC boundary. */
export function canonicalizeLinkedPlayerPlatform(value: string): LinkedPlayerSyncPlatform {
  const platform = normalizeIdentityPart(value);
  if (!SUPPORTED_PLATFORMS.has(platform as LinkedPlayerSyncPlatform)) {
    throw new Error("linked-player-sync-unsupported-platform");
  }
  return platform as LinkedPlayerSyncPlatform;
}

/** Canonical nickname validation shared by the server RPC boundary. */
export function canonicalizeLinkedPlayerNickname(value: string): string {
  const nickname = normalizeIdentityPart(value);
  if (!nickname || value.trim() !== value) {
    throw new Error("linked-player-sync-invalid-nickname");
  }
  return nickname;
}

/** Canonical identity helper shared by all linked-player state callers. */
export function canonicalizeLinkedPlayerIdentity(
  platform: string,
  nickname: string,
): { platform: LinkedPlayerSyncPlatform; normalizedNickname: string } {
  return {
    platform: canonicalizeLinkedPlayerPlatform(platform),
    normalizedNickname: canonicalizeLinkedPlayerNickname(nickname),
  };
}

/** Builds the season-independent lock shared by manual and automatic refreshes. */
export function buildPlayerRefreshLockKey(platform: string, nickname: string): string {
  return `refresh:${normalizeIdentityPart(platform)}:${normalizeIdentityPart(nickname)}`;
}
