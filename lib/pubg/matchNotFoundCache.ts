const MATCH_NOT_FOUND_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_MATCH_NOT_FOUND_CACHE_SIZE = 2_000;
const matchNotFoundCache = new Map<string, number>();

function matchNotFoundCacheKey(platform: string, matchId: string): string {
  return `${platform}:${matchId}`;
}

export function isRecentlyNotFound(platform: string, matchId: string): boolean {
  const key = matchNotFoundCacheKey(platform, matchId);
  const expiresAt = matchNotFoundCache.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    matchNotFoundCache.delete(key);
    return false;
  }
  return true;
}

export function rememberNotFound(platform: string, matchId: string): void {
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

export function forgetNotFound(platform: string, matchId: string): void {
  matchNotFoundCache.delete(matchNotFoundCacheKey(platform, matchId));
}
