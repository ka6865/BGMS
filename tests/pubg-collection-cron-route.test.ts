import { beforeEach, describe, expect, it, vi } from 'vitest';

const batch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pubg/scheduledDiscovery.server', () => ({ runScheduledDiscoveryBatch: batch }));
import { POST } from '@/app/api/internal/pubg/collect/route';

beforeEach(() => {
  vi.stubEnv('PUBG_MATCH_COLLECTION_SECRET', 'a'.repeat(64));
  batch.mockReset();
});

describe('scheduled PUBG collection', () => {
  it('rejects an unauthenticated request before accessing the worker', async () => {
    const response = await POST(new Request('https://bgms.kr/api/internal/pubg/collect', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(batch).not.toHaveBeenCalled();
  });

  it('rejects a query token and a missing configured secret', async () => {
    const request = new Request('https://bgms.kr/api/internal/pubg/collect?token=' + 'a'.repeat(64), { method: 'POST' });
    expect((await POST(request)).status).toBe(401);
    vi.stubEnv('PUBG_MATCH_COLLECTION_SECRET', '');
    expect((await POST(new Request(request.url, { method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } }))).status).toBe(401);
    expect(batch).not.toHaveBeenCalled();
  });

  it('runs the fixed batch without accepting a caller limit or account scope', async () => {
    batch.mockResolvedValue({ claimed: 3, saved: 2, alreadyStored: 1, retry: 1, unavailable: 0, rateLimited: false });
    const response = await POST(new Request('https://bgms.kr/api/internal/pubg/collect?limit=100000', {
      method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(64) },
      body: JSON.stringify({ limit: 100000, accountId: 'account.attacker' }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(batch).toHaveBeenCalledExactlyOnceWith();
    expect(await response.json()).toMatchObject({ ok: true, claimed: 3, saved: 2 });
  });

  it('reports a failed batch without leaking upstream errors or marking it successful', async () => {
    batch.mockRejectedValue(new Error('secret: upstream credentials'));
    const response = await POST(new Request('https://bgms.kr/api/internal/pubg/collect', {
      method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(64) },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'pubg-collection-failed' });
  });
});
