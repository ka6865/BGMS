import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildCalculationPendingMatch } from '@/lib/pubg-analysis/calculationAvailability';

const { rows, filters, rankingCalls } = vi.hoisted(() => ({ rows: [] as any[], filters: [] as [string, unknown][], rankingCalls: [] as any[] }));
vi.mock('next/cache',()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock('@/lib/pubg/privatePlayers', () => ({ isPlayerPrivate: vi.fn().mockResolvedValue(false) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  rpc: (_name: string, args: any) => {
    rankingCalls.push(args);
    const data = args.p_tab === 'tier' ? rows.filter(row => row.calculation_version === 2) : rows;
    return Promise.resolve({ data: data.map(row => ({
      platform: row.platform, player_id: row.player_id, account_id: null,
      value: args.p_tab === 'damage' ? row.damage : args.p_tab === 'kills' ? row.kills : row.score,
      secondary: args.p_tab === 'damage' ? row.kills : row.damage,
      tier: row.calculation_version === 2 ? row.tier : null,
      game_mode: row.game_mode, map_name: row.map_name, played_at: row.created_at, match_count: 1,
    })), error: null });
  },
  from: (table: string) => {
    const predicates: ((row: any) => boolean)[] = [];
    const chain: any = {
      select: () => chain,
      eq: (key: string, value: unknown) => { filters.push([key, value]); predicates.push(row => row[key] === value); return chain; },
      in: (key: string, values: unknown[]) => { predicates.push(row => values.includes(row[key])); return chain; },
      gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({
        data: table === 'global_benchmarks' ? rows.filter(row => predicates.every(test => test(row))) : [], error: null,
      }),
    };
    return chain;
  },
}) }));

const row = (player: string, calculation: number | null) => ({
  player_id: player, platform: 'steam', calculation_version: calculation,
  filter_version: 8, population_evidence_version: 1, match_type: 'competitive', game_mode: 'squad',
  damage: 400, kills: 3, tier: 'S', score: 99, trade_rate: 100, counter_latency_ms: 0,
  created_at: new Date().toISOString(), map_name: 'Baltic_Main',
});

beforeEach(() => { rows.length = 0; filters.length = 0; rankingCalls.length = 0; });

describe('calculation rollout preserves official basic records', () => {
  it('does not copy processed damage, grades, prose or nested calculated fields', () => {
    const original = { matchId: 'match', stats: { name: 'Player', playerId: 'account.private', kills: 0, damageDealt: 45.5, processedDamageDealt: 999, winPlace: 2 },
      team: [{name: 'Friend', kills: 2, grade: 'S'}], benchmark: {score: 99}, analysis: 'old', v: 73, calculationVersion: 1 };
    const result = buildCalculationPendingMatch(original);
    expect(result.stats).toMatchObject({kills: 0, damageDealt: 45.5, assists: null});
    expect(result.stats).not.toHaveProperty('processedDamageDealt');
    expect(result.stats).not.toHaveProperty('playerId');
    expect(result.team[0]).not.toHaveProperty('grade');
    for (const key of ['benchmark', 'analysis', 'v', 'calculationVersion']) expect(result).not.toHaveProperty(key);
    expect(original.stats.processedDamageDealt).toBe(999);
  });

  it('retains old official damage and kill ranking entries but withholds their grade', async () => {
    rows.push(row('player', null));
    const { getWeeklyTopDamage, getWeeklyTopKills, getTopTierRanking } = await import('@/actions/rankings');
    expect((await getWeeklyTopDamage()).data[0]).toMatchObject({value: 400, tier: undefined});
    expect((await getWeeklyTopKills()).data[0]).toMatchObject({value: 3, tier: undefined});
    expect((await getTopTierRanking()).data).toEqual([]);
    expect(rankingCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ p_tab: 'damage', p_calculation: 2 }),
      expect.objectContaining({ p_tab: 'kills', p_calculation: 2 }),
      expect.objectContaining({ p_tab: 'tier', p_calculation: 2 }),
    ]));
  });

  it('compares basic records while unmeasured tactical results never become zero or draws', async () => {
    rows.push(row('one', null), {...row('two', 2), kills: 1});
    const { GET } = await import('@/app/api/pubg/battle/route');
    const response = await GET(new Request('http://localhost/api/pubg/battle?nick1=one&nick2=two&platform1=steam&platform2=steam'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({tier1: null, tier2: null, tacticalComparable: false, withheldCount: 8, score: {nick1: 1, nick2: 0, draw: 1}});
    expect(data.comparisons.find((metric: any) => metric.key === 'trade_rate')).toMatchObject({v1: null, v2: null, comparable: false});
    expect(data.comparisons.find((metric: any) => metric.key === 'kills')).toMatchObject({v1: 3, v2: 1, comparable: true});
  });

  it('keeps observed current tactical zero available for comparison', async () => {
    rows.push(row('one', 2), row('two', 2));
    const { GET } = await import('@/app/api/pubg/battle/route');
    const response = await GET(new Request('http://localhost/api/pubg/battle?nick1=one&nick2=two&platform1=steam&platform2=steam'));
    const data = await response.json();
    expect(data.tacticalComparable).toBe(true);
    expect(data.comparisons.find((metric: any) => metric.key === 'counter_latency_ms')).toMatchObject({v1: 0, v2: 0, comparable: true});
  });
});
