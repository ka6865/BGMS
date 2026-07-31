// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import BoardListClient from '@/components/board/BoardListClient';
import RankingsClient from '@/app/rankings/RankingsClient';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: null, error: null }) }),
      }),
    }),
  },
}));

vi.mock('@/components/ads/AdfitBanner', () => ({ default: () => null }));
vi.mock('@/components/ads/AdSenseBanner', () => ({ default: () => null }));

afterEach(() => {
  cleanup();
});

describe('데이터 조회 오류 UI', () => {
  it('게시글 목록 조회 오류를 빈 게시글 안내 대신 재시도 안내로 표시한다', () => {
    render(createElement(BoardListClient, {
      posts: [],
      totalPosts: 0,
      currentPage: 1,
      currentFilter: '전체',
      hasError: true,
    }));

    expect(screen.getByText('일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.')).not.toBeNull();
    expect(screen.queryByText('등록된 게시글이 없습니다')).toBeNull();
    expect(screen.getByRole('button', { name: '다시 시도' })).not.toBeNull();
  });

  it('랭킹 초기 조회 오류를 빈 데이터 안내 대신 재시도 안내로 표시한다', () => {
    render(createElement(RankingsClient, {
      initialDamage: [],
      initialKills: [],
      initialTier: [],
      updatedAt: '2026-08-01T00:00:00.000Z',
      initialDamageHasError: true,
    }));

    expect(screen.getByText('일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.')).not.toBeNull();
    expect(screen.queryByText('이번 주 데이터가 없습니다')).toBeNull();
    expect(screen.getByRole('button', { name: '다시 시도' })).not.toBeNull();
  });
});
