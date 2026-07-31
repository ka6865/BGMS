export const RECENT_MATCH_LIMIT = 20;

export function mergeRecentMatchIds(
  apiMatchIds: readonly string[],
  cachedMatchIds: unknown,
): string[] {
  const validCachedMatchIds = Array.isArray(cachedMatchIds)
    ? cachedMatchIds.filter(
        (matchId): matchId is string => typeof matchId === "string" && matchId.length > 0,
      )
    : [];

  // Set은 삽입 순서를 유지하므로 새 매치를 먼저 두면 최신 순서가 보존됩니다.
  return [...new Set([...apiMatchIds, ...validCachedMatchIds])].slice(0, RECENT_MATCH_LIMIT);
}
