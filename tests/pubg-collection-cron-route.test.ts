import { beforeEach, describe, expect, it, vi } from 'vitest';

const batch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pubg/scheduledDiscovery.server', () => ({ runScheduledDiscoveryBatch: batch }));
import { POST } from '@/app/api/internal/pubg/collect/route';
import { signCollectionCronRequest } from '@/lib/pubg/collectionCronAuth';

function signedHeaders(ageSeconds = 0, secret = 'a'.repeat(64)) {
  const timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds);
  return { Authorization: 'Bearer ' + signCollectionCronRequest(secret, timestamp), 'X-BGMS-Collection-Time': timestamp };
}

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
    expect((await POST(new Request(request.url, { method: 'POST', headers: signedHeaders() }))).status).toBe(401);
    expect(batch).not.toHaveBeenCalled();
  });

  it('runs the fixed batch without accepting a caller limit or account scope', async () => {
    batch.mockResolvedValue({ claimed: 3, saved: 2, alreadyStored: 1, retry: 1, unavailable: 0, rateLimited: false });
    const response = await POST(new Request('https://bgms.kr/api/internal/pubg/collect?limit=100000', {
      method: 'POST', headers: signedHeaders(),
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
      method: 'POST', headers: signedHeaders(),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'pubg-collection-failed' });
  });

  it.each([121, -10])('rejects stale or future signatures (%s seconds) before collecting', async age => {
    const response = await POST(new Request('https://bgms.kr/api/internal/pubg/collect', { method: 'POST', headers: signedHeaders(age) }));
    expect(response.status).toBe(401);
    expect(batch).not.toHaveBeenCalled();
  });

  it('rejects signatures made with another key and the permanent key itself', async () => {
    for (const headers of [signedHeaders(0, 'b'.repeat(64)), { ...signedHeaders(), Authorization: 'Bearer ' + 'a'.repeat(64) }]) {
      expect((await POST(new Request('https://bgms.kr/api/internal/pubg/collect', { method: 'POST', headers }))).status).toBe(401);
    }
    expect(batch).not.toHaveBeenCalled();
  });
});
