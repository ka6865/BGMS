import type { SupabaseClient } from '@supabase/supabase-js';
import { claimDiscoveredMatches, settleDiscoveredMatch, type DiscoveryScope } from './matchDiscovery.server';
import { runDiscoveryWorker } from './discoveryWorker';
import { fetchAndIngestBasicMatchSummaryOutcome } from './playerMatchesIngest';
import { hasObservedPlayerMatchValues } from './playerMatches';
import type { DiscoveryJob } from './matchDiscovery';

export async function isDiscoveredMatchStored(db: SupabaseClient, job: DiscoveryJob): Promise<boolean> {
  const { data, error } = await db.from('pubg_player_matches')
    .select('player_id, account_id, match_id, played_at, game_mode, map_name, kills, damage, win_place, match_type')
    .eq('platform', job.platform).eq('match_id', job.match_id)
    .eq('account_id', job.account_id).limit(1);
  if (error) throw new Error('discovery-existing-match-read-failed');
  // A legacy nickname row is not proof of account identity. Only an official
  // participant lookup may bind it to the account before queue acknowledgement.
  return (data ?? []).some(row => row.account_id === job.account_id && hasObservedPlayerMatchValues(row));
}


/** One account, one bounded batch. The ordinary worker retains its full limit. */
export async function collectDiscoveredMatches(db: SupabaseClient, scope: DiscoveryScope, signal?: AbortSignal) {
  const apiKey = (process.env.PUBG_API_KEY ?? '').split(' ')[0].trim();
  if (!apiKey) throw new Error('discovery-worker-api-key-missing');
  return runDiscoveryWorker({
    limit: 3, maxDurationMs: 12_000,
    claim: limit => claimDiscoveredMatches(db, limit, scope),
    settle: (job, outcome) => settleDiscoveredMatch(db, job, outcome),
    alreadyStored: job => isDiscoveredMatchStored(db, job),
    ingest: job => fetchAndIngestBasicMatchSummaryOutcome(db, job.match_id, job.nickname_at_discovery,
      job.platform, apiKey, {expectedAccountId: job.account_id, timeoutMs: 8_000, signal}),
  });
}
