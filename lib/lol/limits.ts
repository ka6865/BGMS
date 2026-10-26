// 전적 목록은 Riot 경기 ID 한 페이지(20개) 단위로 불러온다.
// 화면이 "경기 더 불러오기"로 보내는 남은 경기 ID 수와 서버가 받는 한도가 이 값 하나를 함께 쓴다.
export const LOL_MATCH_PAGE_SIZE = 20;

// "경기 더 불러오기"로 보낼 남은 경기 ID를 고른다.
// 공개 경로는 보낸 ID가 모두 offset이 속한 Riot 목록 페이지(20개 단위) 안에 있어야 받으므로,
// 그 페이지 끝까지만 보낸다. 다음 페이지의 남은 ID는 다음 요청에서 그 페이지 기준으로 보낸다.
export function nextPendingMatchIds(matchIds: string[] | undefined, loadedCount: number, loadedIds: ReadonlySet<string>): string[] {
  if (!matchIds?.length) return [];
  const pageEnd = (Math.floor(loadedCount / LOL_MATCH_PAGE_SIZE) + 1) * LOL_MATCH_PAGE_SIZE;
  return matchIds.slice(loadedCount, pageEnd).filter((id) => !loadedIds.has(id));
}
