import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LolMatchCard from "@/components/lol/LolMatchCard";
import { matches } from "./fixtures/lol/browserScenario";
import type { LolRecentMatch } from "@/lib/lol/riotSearch.server";

const render = (match: (typeof matches)[number]) => renderToStaticMarkup(createElement(LolMatchCard, {
  match: match as LolRecentMatch, ownRiotId: "홍길동#KR1", expanded: false, onToggle: () => {}, onSearch: () => {},
}));

describe("전적 카드 결과 표시", () => {
  it("다시하기는 승패 대신 다시하기로 표시한다", () => {
    const html = render({ ...matches[0], win: false, remake: true });
    expect(html).toContain("다시하기");
    expect(html).not.toMatch(/>(승리|패배)</);
  });
  it("일반 경기는 승리·패배를 표시한다", () => {
    expect(render({ ...matches[0], win: true, remake: false })).toContain(">승리<");
    expect(render({ ...matches[0], win: false, remake: false })).toContain(">패배<");
  });
});
