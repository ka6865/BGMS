import { createClient } from '@supabase/supabase-js';
import { claimDiscoveredMatches, settleDiscoveredMatch } from './matchDiscovery.server';
import { isDiscoveredMatchStored } from './discoveryBatch.server';
import { runDiscoveryWorker } from './discoveryWorker';
import { fetchAndIngestBasicMatchSummaryOutcome } from './playerMatchesIngest';

export const SCHEDULED_DISCOVERY_LIMIT = 100;
export const SCHEDULED_DISCOVERY_DURATION_MS = 30_000;

export async function runScheduledDiscoveryBatch() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = (process.env.PUBG_API_KEY ?? '').split(' ')[0].trim();
  if (!url || !serviceKey || !apiKey) throw new Error('scheduled-discovery-credentials-missing');

  // Bound DB requests as well as PUBG fetches, leaving time to return before 60s.
  // An interrupted job keeps its existing lease and will be retried by the worker.
  const deadline = AbortSignal.timeout(38_000);
  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, {
      ...init,
      signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
  return runDiscoveryWorker({
    limit: SCHEDULED_DISCOVERY_LIMIT,
    maxDurationMs: SCHEDULED_DISCOVERY_DURATION_MS,
    claim: limit => claimDiscoveredMatches(db, limit),
    settle: (job, outcome) => settleDiscoveredMatch(db, job, outcome),
    alreadyStored: job => isDiscoveredMatchStored(db, job),
    ingest: job => fetchAndIngestBasicMatchSummaryOutcome(db, job.match_id,
      job.nickname_at_discovery, job.platform, apiKey,
      { expectedAccountId: job.account_id, timeoutMs: 8_000, signal: deadline }),
  });
}
