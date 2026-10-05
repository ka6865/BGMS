import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: vi.fn(), claim: vi.fn(), settle: vi.fn(), stored: vi.fn(), ingest: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.client }));
vi.mock('@/lib/pubg/matchDiscovery.server', () => ({ claimDiscoveredMatches: mocks.claim, settleDiscoveredMatch: mocks.settle }));
vi.mock('@/lib/pubg/discoveryBatch.server', () => ({ isDiscoveredMatchStored: mocks.stored }));
vi.mock('@/lib/pubg/playerMatchesIngest', () => ({ fetchAndIngestBasicMatchSummaryOutcome: mocks.ingest }));
import { runScheduledDiscoveryBatch } from '@/lib/pubg/scheduledDiscovery.server';
import { parseCollectionCronArgs, resolveCollectionCronSecret } from '../scripts/configure_pubg_collection_cron';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service');
  vi.stubEnv('PUBG_API_KEY', 'fixture-pubg');
  mocks.client.mockReturnValue({});
  mocks.stored.mockResolvedValue(false);
  mocks.settle.mockResolvedValue(undefined);
  mocks.ingest.mockResolvedValue({ status: 'saved', record: {}, httpStatus: 200, rateLimitHeaders: null });
});

describe('scheduled discovery uses the existing durable worker', () => {
  it('bounds each invocation to 100 jobs and verifies the immutable account on ingestion', async () => {
    let claimed = 0;
    mocks.claim.mockImplementation(async (_db, limit: number) => {
      const jobs = Array.from({ length: limit }, (_, offset) => ({
        account_id: 'account.fixture', platform: 'steam', nickname_at_discovery: 'Fixture',
        match_id: 'match-' + (claimed + offset), attempts: 1, not_found_count: 0,
      }));
      claimed += limit;
      return jobs;
    });
    expect(await runScheduledDiscoveryBatch()).toMatchObject({ claimed: 100, saved: 100, retry: 0 });
    expect(mocks.ingest).toHaveBeenCalledTimes(100);
    expect(mocks.ingest.mock.calls[0][5]).toMatchObject({ expectedAccountId: 'account.fixture', timeoutMs: 8000 });
    expect(mocks.ingest.mock.calls[0][5].signal).toBeInstanceOf(AbortSignal);
    expect(mocks.claim.mock.calls.at(-1)?.[1]).toBe(1);
  });

  it('keeps an upstream failure retryable and stops the batch on 429', async () => {
    mocks.claim.mockResolvedValue([{ account_id: 'account.fixture', platform: 'steam', nickname_at_discovery: 'Fixture', match_id: 'fixture', attempts: 1 }]);
    mocks.ingest.mockResolvedValue({ status: 'rate_limited', record: null, httpStatus: 429, rateLimitHeaders: { retryAfterMs: 600000 } });
    const result = await runScheduledDiscoveryBatch();
    expect(result).toMatchObject({ claimed: 1, retry: 1, rateLimited: true, saved: 0 });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.settle.mock.calls[0][2]).toMatchObject({ state: 'retry', errorCode: 'rate_limited' });
    expect(Date.parse(mocks.settle.mock.calls[0][2].nextAttemptAt)).toBeGreaterThan(Date.now() + 599000);
  });

  it('does not begin collection without server credentials', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    await expect(runScheduledDiscoveryBatch()).rejects.toThrow('scheduled-discovery-credentials-missing');
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});

describe('collection clock CLI', () => {
  it('uses the explicitly selected secret file during rotation', () => {
    expect(resolveCollectionCronSecret('old', 'new')).toBe('new');
    expect(resolveCollectionCronSecret('old')).toBe('old');
  });
  it('is read-only by default and requires one explicit mutation mode', () => {
    expect(parseCollectionCronArgs([])).toBe('status');
    expect(parseCollectionCronArgs(['--apply'])).toBe('enable');
    expect(parseCollectionCronArgs(['--disable'])).toBe('disable');
    expect(() => parseCollectionCronArgs(['--apply', '--disable'])).toThrow('collection-cron-invalid-options');
    expect(() => parseCollectionCronArgs(['--limit', '9999'])).toThrow('collection-cron-invalid-options');
  });
});
