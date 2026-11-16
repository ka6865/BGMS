// 통계 관측과 공식 활성 상태는 별개다. 근거를 확인한 패치에만 적용하고 이후 패치에는 재검토한다.
export const MAYHEM_AVAILABILITY_SOURCE = 'https://mayhemmeta.com/articles/augments-silently-disabled-26-21';
const interrupted = new Set([2032, 2034, 2043, 2080, 2083, 2091, 2104, 2107, 2115, 2127, 2134, 2137]);

export function getMayhemAvailabilityOverride(patch: string, platformId: number) {
  return patch === '16.22' && interrupted.has(platformId) ? {
    status: 'unverified' as const,
    reason: '등장 중단 추정: 최근 선택 통계에서 관측되지 않습니다. 공식 삭제는 확인되지 않았습니다.',
    sourceUrl: MAYHEM_AVAILABILITY_SOURCE,
  } : null;
}
