// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import BackpackClient from '@/app/backpack/BackpackClient';
import WeaponsClient from '@/app/weapons/WeaponsClient';
import SquadAnalysisPanel from '@/components/stat/SquadAnalysisPanel';

const mocks = vi.hoisted(() => ({
  failedTable: '',
}));

function createQueryResult(table: string) {
  const result = {
    data: [],
    error: table === mocks.failedTable ? new Error('database unavailable') : null,
  };
  const query = {
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    is: () => query,
    not: () => query,
    order: async () => result,
  };
  return query;
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/ads/AdfitBanner', () => ({ default: () => null }));
vi.mock('@/components/stat/SquadCauseScenes', () => ({ default: () => null }));
vi.mock('@/lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({ select: () => createQueryResult(table) }),
  },
}));

afterEach(() => {
  cleanup();
  mocks.failedTable = '';
  vi.unstubAllGlobals();
});

describe('클라이언트 데이터 조회 오류 UI', () => {
  it('가방 데이터 조회 실패를 빈 항목 화면 대신 재시도 안내로 표시한다', async () => {
    mocks.failedTable = 'ammo';

    render(createElement(BackpackClient));

    expect(await screen.findByText('일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.')).not.toBeNull();
    expect(screen.getByRole('button', { name: '다시 시도' })).not.toBeNull();
  });

  it('파츠 조회 실패를 빈 무기 목록 대신 재시도 안내로 표시한다', async () => {
    mocks.failedTable = 'attachments';

    render(createElement(WeaponsClient));

    expect(await screen.findByText('일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.')).not.toBeNull();
    expect(screen.getByRole('button', { name: '다시 시도' })).not.toBeNull();
  });

  it('스쿼드 목록 HTTP 실패를 분석 기록 없음 안내 대신 재시도 안내로 표시한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    render(createElement(SquadAnalysisPanel, {
      nickname: 'tester',
      platform: 'steam',
      groupKey: undefined,
      onGroupKeyChange: () => {},
    }));

    expect(await screen.findByText('일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.')).not.toBeNull();
    expect(screen.queryByText(/분석할 수 있는 스쿼드 모드 파티 게임 기록이 없습니다/)).toBeNull();
  });
});
