import { normalizeMatchId } from '@/lib/pubg-analysis/recentMatchSelection';

export type DiscoveryInput = {
  platform: 'steam' | 'kakao'; accountId: string; nickname: string; matchIds: readonly unknown[];
};
export type DiscoveryJob = {
  platform: 'steam' | 'kakao'; account_id: string; nickname_at_discovery: string;
  match_id: string; lease_token: string; attempts: number; not_found_count: number;
};
export type HistoryIngest = { pendingCount: number; unavailableCount: number; lastSavedAt: string | null };

/** Storage boundary only; presentation still uses normalizeRecentMatchIds (20). */
export function normalizeDiscoveredMatchIds(ids: readonly unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string').map(normalizeMatchId).filter((id): id is string => Boolean(id && /^[A-Za-z0-9_-]{1,128}$/.test(id))))];
}
