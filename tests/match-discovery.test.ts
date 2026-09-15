import { describe, expect, it, vi } from 'vitest';
import { normalizeDiscoveredMatchIds } from '@/lib/pubg/matchDiscovery';
import { recordDiscoveredMatches } from '@/lib/pubg/matchDiscovery.server';
import { normalizeRecentMatchIds } from '@/lib/pubg/recentMatches';

describe('full match discovery', () => {
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
