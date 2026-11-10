import { parse } from "node-html-parser";

// 패치노트 아수라장 섹션에서 증강 제시 조건을 바꾼 것으로 보이는 문장을 찾는다. 관리자가 확인하기 전까지는 후보일 뿐이다.
const OFFER_HINT = /등장 방식|제시되지 않|제시하지 않|등장하지 않|나오지 않|획득할 수 없|얻을 수 없|더 이상 (?:제시|등장|획득)|무작위 증강|전환:|판도라의 상자|나는 왕이다/;
export function extractMayhemOfferHints(html: string): string[] {
  const hints: string[] = [];
  let mayhem = false;
  for (const node of parse(html).querySelectorAll("h2,p,li")) {
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (node.tagName === "H2") { mayhem = /아수라장/.test(text); continue; }
    if (!mayhem || node.querySelector("li") || text.length < 6 || text.length > 1000) continue;
    if (OFFER_HINT.test(text)) hints.push(text);
  }
  return [...new Set(hints)].slice(0, 50);
}
