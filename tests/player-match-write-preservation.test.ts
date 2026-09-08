import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { upsertPlayerMatches, type PlayerMatchRecord } from '@/lib/pubg/playerMatches';

const record = (match_id: string, counters: Partial<PlayerMatchRecord> = {}): PlayerMatchRecord => ({
  player_id: 'fixture', platform: 'steam', match_id, played_at: '2026-09-08T00:00:00Z',
  game_mode: 'duo', map_name: 'Baltic_Main', kills: 1, damage: 100, win_place: 2,
  match_type: 'official', ...counters,
});

describe('basic counter conflict writes through the real Supabase client', () => {
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
