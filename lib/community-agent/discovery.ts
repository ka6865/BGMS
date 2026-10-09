const GENERAL_TERMS = new Set([
  "배틀그라운드", "배그", "pubg", "battlegrounds", "이번", "신규", "새로운", "차량", "출시", "콜라보", "스킨",
  "판매기간", "질문", "언제", "기간", "일정", "패치", "업데이트", "이벤트", "정보", "한국", "공지", "특별",
  "보급", "안내", "게임", "구매", "판매", "기념", "신상", "무료", "가격", "자동차", "무기", "총기", "캐릭터",
  "의상", "후", "전", "나중에", "collaboration", "collab",
  "release", "skin", "skins", "new", "with", "the", "update",
]);
const SUBJECT = "([가-힣A-Za-z][가-힣A-Za-z0-9]{1,23})";
const ISSUE = "(?:출시|콜라보|스킨|collaboration|collab|release|skins?)";

export function extractIssueSearchTerms(titles: string[]): string[] {
  const terms = new Map<string, string>();
  // ponytail: 이슈에 인접한 단어만 찾는다. 복합 브랜드명이 필요해지면 제목 분석을 확장한다.
  for (const title of titles.slice(0, 120)) {
    if (/[$<>`\\]|https?:\/\//i.test(title)) continue;
    const text = title.slice(0, 500);
    for (const pattern of [
      new RegExp(`(?:^|[\\s()[\\]·:!?.,-])${SUBJECT}\\s*${ISSUE}`, "gi"),
      new RegExp(`^${ISSUE}\\s*[:x×]?\\s+${SUBJECT}`, "gi"),
      new RegExp(`(?:pubg|배틀그라운드|배그)\\s*[x×]\\s*${SUBJECT}`, "gi"),
    ]) {
      for (const match of text.matchAll(pattern)) {
        const term = match[1];
        const key = term.toLowerCase();
        if (GENERAL_TERMS.has(key) || !/^[가-힣A-Za-z][가-힣A-Za-z0-9]{1,23}$/.test(term)) continue;
        terms.set(key, term);
        if (terms.size === 2) return [...terms.values()];
      }
    }
  }
  return [...terms.values()];
}
