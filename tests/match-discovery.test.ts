import { describe, expect, it, vi } from 'vitest';
import { normalizeDiscoveredMatchIds } from '@/lib/pubg/matchDiscovery';
import { claimDiscoveredMatches, readHistoryIngest, recordDiscoveredMatches } from '@/lib/pubg/matchDiscovery.server';
import { normalizeRecentMatchIds } from '@/lib/pubg/recentMatches';

describe('full match discovery', () => {
  it('passes an account scope to the existing claim RPC and rejects jobs from another account', async () => {
    const rpc = vi.fn().mockResolvedValue({data: [], error: null});
    const scope = {platform: 'steam' as const, accountId: 'account.a'};
    await claimDiscoveredMatches({rpc} as never, 3, scope);
    expect(rpc).toHaveBeenCalledWith('claim_scoped_pubg_match_discovery', {p_limit: 3, p_platform: 'steam', p_account_id: 'account.a'});
    rpc.mockResolvedValue({data: [{platform: 'steam', account_id: 'account.other'}], error: null});
    await expect(claimDiscoveredMatches({rpc} as never, 3, scope)).rejects.toThrow('match-discovery-scope-mismatch');
  });
  it('does not report completion when progress cannot be read', async () => {
    const rpc = vi.fn().mockResolvedValue({data: null, error: {code: 'PGRST202'}});
    expect(await readHistoryIngest({rpc} as never, 'steam', 'account.a')).toBeNull();
    expect(await readHistoryIngest({rpc} as never, 'steam', 'nickname')).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValue({data: {pendingCount: 2, unavailableCount: 1, lastSavedAt: null}, error: null});
    expect(await readHistoryIngest({rpc} as never, 'steam', 'account.a')).toEqual({pendingCount: 2, unavailableCount: 1, lastSavedAt: null});
  });
  it('retains all normalized ids without changing the 20-item UI boundary', () => {
    const ids = Array.from({ length: 130 }, (_, i) => `match-${i}`);
    expect(normalizeDiscoveredMatchIds(['shard:match-0', ...ids, null, ' ', 123, false, '../bad'])).toEqual(ids);
    expect(normalizeRecentMatchIds(ids)).toHaveLength(20);
  });
  it('chunks a validated account and propagates later chunk failures', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'failed' } });
    await expect(recordDiscoveredMatches({ platform: 'steam', accountId: 'account.test', nickname: 'Tester',
      matchIds: Array.from({ length: 251 }, (_, i) => `id-${i}`),
    }, { rpc } as never)).rejects.toThrow('match-discovery-write-failed');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_match_ids).toHaveLength(250);
  });
  it('rejects malformed identity before writing', async () => {
    const rpc = vi.fn();
    await expect(recordDiscoveredMatches({ platform: 'console' as never, accountId: 'account.test', nickname: 'Tester', matchIds: ['m'] }, {rpc} as never)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
