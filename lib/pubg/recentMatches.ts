import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";

export const RECENT_MATCH_LIMIT = 20;

/**
 * Normalize the IDs used by the recent-match UI/cache boundary.
 *
 * PUBG identifiers are sometimes returned as `shard:<id>` and sometimes as
 * `<id>`.  The first occurrence wins so an upstream list's newest-first
 * ordering is preserved; the limit is applied after canonical de-duplication
 * so aliases cannot consume a slot in the 20-match window.
 */
export function normalizeRecentMatchIds(
  matchIds: readonly unknown[],
  limit: number = RECENT_MATCH_LIMIT,
): string[] {
  const requestedLimit = Number(limit);
  const safeLimit = Number.isFinite(requestedLimit) && requestedLimit >= 0
    ? Math.floor(requestedLimit)
    : RECENT_MATCH_LIMIT;
  if (safeLimit === 0) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawId of matchIds) {
    const canonicalId = normalizeMatchId(rawId);
    if (!canonicalId || seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    normalized.push(canonicalId);
    if (normalized.length >= safeLimit) break;
  }
  return normalized;
}

export function mergeRecentMatchIds(
  apiMatchIds: readonly string[],
  cachedMatchIds: unknown,
): string[] {
  const validCachedMatchIds = Array.isArray(cachedMatchIds) ? cachedMatchIds : [];

  // Set은 삽입 순서를 유지하므로 새 매치를 먼저 두면 최신 순서가 보존됩니다.
  // Canonical dedupe를 limit 전에 수행해 `shard:x`/`x`가 최신 20판을
  // 잠식하지 않도록 합니다.
  return normalizeRecentMatchIds(
    [...apiMatchIds, ...validCachedMatchIds],
    RECENT_MATCH_LIMIT,
  );
}
