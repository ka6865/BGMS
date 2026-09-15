import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeDiscoveredMatchIds, type DiscoveryInput, type DiscoveryJob, type HistoryIngest } from './matchDiscovery';

export function discoveryClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('match-discovery-credentials-missing');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
export async function recordDiscoveredMatches(input: DiscoveryInput, client?: SupabaseClient): Promise<void> {
  if (!['steam', 'kakao'].includes(input.platform) || !/^account\.[A-Za-z0-9_-]+$/.test(input.accountId)
    || !input.nickname.trim() || input.nickname.length > 64) throw new Error('match-discovery-invalid-identity');
  const ids = normalizeDiscoveredMatchIds(input.matchIds);
  if (!ids.length) return;
  const db = client ?? discoveryClient();
  for (let offset = 0; offset < ids.length; offset += 250) {
    const { error } = await db.rpc('record_pubg_match_discovery', {
      p_platform: input.platform, p_account_id: input.accountId, p_nickname: input.nickname,
      p_match_ids: ids.slice(offset, offset + 250),
    });
    if (error) throw new Error('match-discovery-write-failed');
  }
}
export async function claimDiscoveredMatches(db: SupabaseClient, limit = 3): Promise<DiscoveryJob[]> {
  const { data, error } = await db.rpc('claim_pubg_match_discovery', { p_limit: limit });
  if (error) throw new Error('match-discovery-claim-failed');
  return (data ?? []) as DiscoveryJob[];
}
export async function settleDiscoveredMatch(db: SupabaseClient, job: DiscoveryJob, outcome: {
  state: 'saved' | 'retry' | 'unavailable'; nextAttemptAt?: string; errorCode?: string;
}): Promise<void> {
  const { data, error } = await db.rpc('settle_pubg_match_discovery', {
    p_platform: job.platform, p_account_id: job.account_id, p_match_id: job.match_id,
    p_lease_token: job.lease_token, p_state: outcome.state,
    p_next_attempt_at: outcome.nextAttemptAt ?? null, p_error_code: outcome.errorCode ?? null,
  });
  if (error || data !== true) throw new Error('match-discovery-settle-rejected');
}
export async function readHistoryIngest(db: SupabaseClient, platform: string, accountId: string): Promise<HistoryIngest | null> {
  // Progress is keyed by the immutable PUBG account ID so a nickname rename
  // does not reset or hide the discovery backlog. Do not call the RPC with a
  // legacy nickname: a zero result would look like completed history.
  if (!/^account\.[A-Za-z0-9_-]+$/.test(accountId)) return null;
  const { data, error } = await db.rpc('pubg_match_discovery_progress', { p_platform: platform, p_account_id: accountId });
  // Rolling deployment: old schema is unknown, never falsely report zero pending.
  if (error) return null;
  return data as HistoryIngest | null;
}
