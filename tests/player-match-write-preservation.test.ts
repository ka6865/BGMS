import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { fetchPlayerMatchesPaginated, upsertPlayerMatches, type PlayerMatchRecord } from '@/lib/pubg/playerMatches';

const record = (match_id: string, counters: Partial<PlayerMatchRecord> = {}): PlayerMatchRecord => ({
  player_id: 'fixture', platform: 'steam', match_id, played_at: '2026-09-08T00:00:00Z',
  game_mode: 'duo', map_name: 'Baltic_Main', kills: 1, damage: 100, win_place: 2,
  match_type: 'official', ...counters,
});

describe('basic counter conflict writes through the real Supabase client', () => {
  it('rejects conflicting stable accounts across optional-column batches before any write', async () => {
    const upsert = vi.fn().mockResolvedValue({error: null});
    expect(await upsertPlayerMatches({from: () => ({upsert})} as never, [
      record('same', {account_id: 'account.first', retention_scope: 'detail'}),
      record('same', {account_id: 'account.second', retention_scope: 'basic_only', knocks: 0}),
    ])).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps unspecified legacy writes separate from explicit participant scopes', async () => {
    const upsert = vi.fn().mockResolvedValue({error: null});
    expect(await upsertPlayerMatches({from: () => ({upsert})} as never, [
      record('repair'), record('peer', {account_id: 'account.peer', retention_scope: 'basic_only'}),
      record('target', {account_id: 'account.target', retention_scope: 'detail'}),
    ])).toBe(true);
    expect(upsert.mock.calls[0][0][0]).not.toHaveProperty('retention_scope');
    expect(upsert.mock.calls[1][0].map((row: PlayerMatchRecord) => row.retention_scope)).toEqual(['basic_only', 'detail']);
  });

  it('returns the stored scope in paginated history without deriving it from a nickname', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('select')).toContain('retention_scope');
      return new Response(JSON.stringify([{...record('peer'), account_id: 'account.peer', retention_scope: 'basic_only'}]),
        {status: 200, headers: {'content-type': 'application/json', 'content-range': '0-0/1'}});
    });
    const client = createClient('https://fixture.supabase.co', 'fixture-key', {global: {fetch}});
    expect((await fetchPlayerMatchesPaginated(client, 'fixture', 'steam')).matches[0].retention_scope).toBe('basic_only');
  });
  it('does not send duplicate conflict keys in the same PostgREST batch', async () => {
    const upsert = vi.fn().mockResolvedValue({error: null});
    expect(await upsertPlayerMatches({from: () => ({upsert})} as never, [record('same'), record('same', {kills: 3})])).toBe(true);
    expect(upsert).toHaveBeenCalledWith([expect.objectContaining({match_id: 'same', kills: 3})], expect.anything());
  });
  it('preserves previous observations for missing fields even in a mixed restoration batch', async () => {
    const stored = new Map<string, Record<string, unknown>>([
      ['missing', { knocks: 3, survival_time: 700 }],
      ['knocks-only', { knocks: 3, survival_time: 700 }],
      ['survival-only', { knocks: 3, survival_time: 700 }],
    ]);
    const requests: Array<{ columns: string[]; rows: PlayerMatchRecord[] }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const columns = (url.searchParams.get('columns') ?? '').replaceAll('"', '').split(',');
      const rows = JSON.parse(String(init?.body)) as PlayerMatchRecord[];
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('prefer')).toContain('resolution=merge-duplicates');
      expect(url.searchParams.get('on_conflict')).toBe('player_id,platform,match_id');
      requests.push({ columns, rows });
      // PostgREST updates every column in the bulk request; absent JSON keys
      // inside that column set become NULL, which must not erase known values.
      for (const row of rows) {
        const prior = stored.get(row.match_id) ?? { knocks: null, survival_time: null };
        stored.set(row.match_id, { ...prior, ...Object.fromEntries(columns.map(key => [key, (row as unknown as Record<string, unknown>)[key] ?? null])) });
      }
      return new Response(null, { status: 201 });
    });
    const client = createClient('https://fixture.supabase.co', 'fixture-key', { global: { fetch } });
    const input = [
      record('missing', { knocks: null, survival_time: null }),
      record('knocks-only', { knocks: 0, survival_time: null }),
      record('survival-only', { knocks: null, survival_time: 0 }),
      record('new-missing'),
      record('new-observed', { knocks: 0, survival_time: 724.7 }),
    ];
    const original = structuredClone(input);
    expect(await upsertPlayerMatches(client, input)).toBe(true);
    expect(stored.get('missing')).toMatchObject({ knocks: 3, survival_time: 700 });
    expect(stored.get('knocks-only')).toMatchObject({ knocks: 0, survival_time: 700 });
    expect(stored.get('survival-only')).toMatchObject({ knocks: 3, survival_time: 0 });
    expect(stored.get('new-missing')).toMatchObject({ knocks: null, survival_time: null });
    expect(stored.get('new-observed')).toMatchObject({ knocks: 0, survival_time: 724 });
    expect(requests).toHaveLength(4);
    expect(input).toEqual(original);
  });

  it('keeps a complete ordinary batch to one write and reports a failed write', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = { from: vi.fn(() => ({ upsert })) } as never;
    const records = [record('a', { knocks: 0, survival_time: 300 }), record('b', { knocks: 2, survival_time: 400 })];
    expect(await upsertPlayerMatches(client, records)).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    upsert.mockResolvedValue({ error: { message: 'write failed' } });
    expect(await upsertPlayerMatches(client, records)).toBe(false);
  });
});
