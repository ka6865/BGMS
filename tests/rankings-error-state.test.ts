import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache',()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return {
      from: () => chain,
      rpc: async () => ({ data: null, error: new Error('database unavailable') }),
    };
  },
}));

describe('랭킹 조회 오류 상태', () => {
  it('딜량 랭킹 DB 조회 실패를 빈 데이터가 아닌 오류 상태로 반환한다', async () => {
    const { getWeeklyTopDamage } = await import('@/actions/rankings');

    await expect(getWeeklyTopDamage()).resolves.toEqual({
      data: [],
      hasError: true,
    });
  });
});
