import { describe, expect, it } from 'vitest';
import { shouldUseSingleTileFallback } from '@/lib/replay/tile-load';

describe('shouldUseSingleTileFallback', () => {
  it('고해상도 타일 중 하나라도 누락되면 단일 타일 폴백을 사용한다', () => {
    expect(shouldUseSingleTileFallback(15, 16)).toBe(true);
  });

  it('모든 고해상도 타일이 로드되면 폴백을 사용하지 않는다', () => {
    expect(shouldUseSingleTileFallback(16, 16)).toBe(false);
  });
});
