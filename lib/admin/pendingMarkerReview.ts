/**
 * 관리자 제보 심사 화면에서 사용하는 순수 표시/경로 헬퍼입니다.
 * UUID 자체는 화면에 노출하지 않고, 프로필이 없는 오래된 행도 숨기지 않습니다.
 */
export function buildPendingMarkerReviewUrl(id: string | number): string {
  return `/admin/review?id=${encodeURIComponent(String(id))}`;
}

export function formatContributorNames(
  contributorIds: readonly string[] | null | undefined,
  nicknames: ReadonlyMap<string, string>,
): string {
  const ids = contributorIds ?? [];
  if (ids.length === 0) return "알 수 없음";

  return ids
    .map((id) => nicknames.get(id)?.trim() || "알 수 없음")
    .join(", ");
}
