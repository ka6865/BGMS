const categoryAliases = new Map<string, readonly string[]>([
  ["free", ["free", "자유"]],
  ["자유", ["free", "자유"]],
  ["strategy", ["strategy", "공략"]],
  ["공략", ["strategy", "공략"]],
  ["question", ["question", "질문"]],
  ["질문", ["question", "질문"]],
  ["notice", ["notice", "공지"]],
  ["공지", ["notice", "공지"]],
  ["clan", ["clan", "클랜", "클랜홍보"]],
  ["클랜", ["clan", "클랜", "클랜홍보"]],
  ["클랜홍보", ["clan", "클랜", "클랜홍보"]],
]);

export const currentBoardCategories = new Set([
  "배그 소식",
  "자유",
  "듀오/스쿼드 모집",
  "클랜홍보",
  "제보/문의",
]);

/**
 * 목록은 과거 모바일 별칭을 같은 별칭 묶음으로만 함께 읽는다.
 * `공지`와 `배그 소식`처럼 의미가 다른 분류는 서버가 임의로 합치지 않는다.
 */
export function boardCategoryFilterValues(value: string): readonly string[] | null {
  const normalized = value.trim();
  if (!normalized || normalized === "all") return null;
  return categoryAliases.get(normalized) ?? (currentBoardCategories.has(normalized) ? [normalized] : null);
}

/** 새 회원 글은 웹과 같은 현재 분류만 저장한다. */
export function parseCurrentBoardCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return currentBoardCategories.has(normalized) ? normalized : null;
}
