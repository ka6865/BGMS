import { describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        gte: () => ({
          in: () => ({
            order: () => ({
              order: () => ({
                order: () => ({
                  limit: async () => ({ data: null, error: new Error('database unavailable') }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
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
