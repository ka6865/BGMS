import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({private: vi.fn(), collect: vi.fn(), claim: vi.fn(), progress: vi.fn(), cache: vi.fn(), options: vi.fn()}));
vi.mock('@supabase/supabase-js', () => ({createClient: (_url: string, _key: string, options: unknown) => { mocks.options(options); return {from: () => {
  const query = {select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: mocks.cache};
  return query;
}}; }}));
vi.mock('@/lib/pubg/privatePlayers', () => ({isPlayerPrivate: mocks.private}));
vi.mock('@/lib/pubg/privatePlayerIdentity', () => ({resolvePrivatePlayerAccountId: vi.fn().mockResolvedValue(null)}));
vi.mock('@/lib/pubg/discoveryBatch.server', () => ({collectDiscoveredMatches: mocks.collect}));
vi.mock('@/lib/pubg/matchDiscovery.server', () => ({readHistoryIngest: mocks.progress}));
vi.mock('@/lib/pubg/responseCache', () => ({claimForceRefresh: mocks.claim}));
import { POST } from '@/app/api/pubg/player/matches/route';
const request = (body: unknown = {nickname: 'CurrentName', platform: 'steam'}) => new NextRequest('http://localhost/api/pubg/player/matches', {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture');
  vi.stubEnv('PUBG_API_KEY', 'fixture-pubg');
  mocks.private.mockResolvedValue(false);
  mocks.cache.mockResolvedValue({data: {id: 'account.a'}, error: null});
  mocks.claim.mockResolvedValue(true);
  mocks.collect.mockResolvedValue({claimed: 3, saved: 2, retry: 1, unavailable: 0, rateLimited: false, durationMs: 120});
  mocks.progress.mockResolvedValue({pendingCount: 1, unavailableCount: 0, lastSavedAt: null});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('explicit bounded account collection', () => {
  it('uses only the cached account identity, never a caller supplied account ID', async () => {
    const response = await POST(request({nickname: 'CurrentName', platform: 'steam', accountId: 'account.other'}));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.collect).toHaveBeenCalledWith(expect.anything(), {platform: 'steam', accountId: 'account.a'}, expect.any(AbortSignal));
    expect(await response.json()).toMatchObject({collection: {saved: 2, retry: 1}, historyIngest: {pendingCount: 1}});
  });
  it('blocks a private account before claiming collection work', async () => {
    mocks.private.mockImplementation(async (_platform, _nickname, accountId) => accountId === 'account.a');
    expect((await POST(request())).status).toBe(403);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('requires player lookup before collecting an unknown identity', async () => {
    mocks.cache.mockResolvedValue({data: null, error: null});
    expect((await POST(request())).status).toBe(409);
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it('enforces account cooldown without collecting another batch', async () => {
    mocks.claim.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('15');
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it('reports missing scoped RPC as retryable rather than successful collection', async () => {
    mocks.collect.mockRejectedValue(new Error('RPC unavailable'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({retryable: true});
  });
  it('rejects unsupported platforms before private or database reads', async () => {
    expect((await POST(request({nickname: 'A', platform: 'console'}))).status).toBe(400);
    expect(mocks.private).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON before any lookup or lease', async () => {
    const invalid = new NextRequest('http://localhost/api/pubg/player/matches', {method: 'POST', body: '{'});
    expect((await POST(invalid)).status).toBe(400);
    expect(mocks.private).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('reports database identity failure as retryable, rather than unknown player', async () => {
    mocks.cache.mockResolvedValue({data: null, error: {message: 'database unavailable'}});
    expect((await POST(request())).status).toBe(503);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it('does not claim jobs or a cooldown when the API key is missing', async () => {
    vi.stubEnv('PUBG_API_KEY', '');
    expect((await POST(request())).status).toBe(503);
    expect(mocks.cache).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it('aborts a stalled database request at the collection deadline', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const upstream = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {once: true});
    }));
    vi.stubGlobal('fetch', upstream);
    mocks.cache.mockImplementation(() => {
      const options = mocks.options.mock.calls.at(-1)?.[0];
      return options.global.fetch('https://fixture.supabase.co/rest/v1/pubg_player_cache');
    });
    const response = POST(request());
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    deadline.abort(new DOMException('Collection deadline reached', 'TimeoutError'));
    expect((await response).status).toBe(503);
    expect(upstream.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('includes the initial privacy registry read in the same deadline', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const upstream = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {once: true});
    }));
    vi.stubGlobal('fetch', upstream);
    mocks.private.mockImplementationOnce(() => mocks.options.mock.calls.at(-1)?.[0].global.fetch('https://fixture.supabase.co/rest/v1/system_settings'));
    const response = POST(request());
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    deadline.abort(new DOMException('Collection deadline reached', 'TimeoutError'));
    expect((await response).status).toBe(503);
    expect(mocks.cache).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
