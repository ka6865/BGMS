// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CompactMatchRow, getMatchRowStatus } from "@/components/stat/matches/CompactMatchRow";
import { buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";

function summary(overrides: { place?: number; kills?: number; damage?: number; mode?: string; map?: string } = {}) {
  return buildBasicMatchSummary({
    match_id: "match-1", player_id: "player", platform: "steam", game_mode: overrides.mode ?? "squad",
    match_type: "official", map_name: overrides.map ?? "Baltic_Main", kills: overrides.kills ?? 2,
    damage: overrides.damage ?? 200, win_place: overrides.place,
  });
}

describe("전적 목록 행 강조 배경", () => {
  afterEach(cleanup);

  it("치킨·상위권·데스매치 승리 행만 옅은 강조 배경을 쓴다", () => {
    expect(getMatchRowStatus(summary({ place: 1 }))).toEqual({ label: "승리", border: "border-l-amber-400", background: "bg-[#242017]" });
    expect(getMatchRowStatus(summary({ place: 10 }))).toEqual({ label: "상위권", border: "border-l-teal-400", background: "bg-[#172120]" });
    expect(getMatchRowStatus(summary({ place: 1, mode: "tdm" })).background).toBe("bg-[#241b1d]");
    expect(getMatchRowStatus(summary({ place: 2, mode: "tdm" })).background).toBe("bg-[#161616]");
    expect(getMatchRowStatus(summary({ place: 11 })).background).toBe("bg-[#161616]");
    expect(getMatchRowStatus(summary({ place: 30, kills: 0, damage: 10 })).background).toBe("bg-[#161616]");
  });

  it("순위가 기록되지 않은 경기는 상위권으로 표시하지 않는다", () => {
    expect(getMatchRowStatus(summary({ place: undefined }))).toMatchObject({ label: "일반", background: "bg-[#161616]" });
  });

  it("펼침 상태에서도 강조 배경과 모서리 처리가 함께 적용된다", () => {
    const { container, rerender } = render(createElement(CompactMatchRow, { summary: summary({ place: 1 }), isExpanded: false, isMobile: false, onToggle: () => {} }));
    const article = () => container.querySelector("article")!;
    expect(article()).toHaveClass("bg-[#242017]", "border-l-amber-400", "rounded-2xl");
    expect(article()).not.toHaveClass("bg-[#161616]");
    rerender(createElement(CompactMatchRow, { summary: summary({ place: 1 }), isExpanded: true, isMobile: false, onToggle: () => {} }));
    expect(article()).toHaveClass("bg-[#242017]", "rounded-t-2xl", "border-b-0");
    expect(container).toHaveTextContent("에란겔");
  });
});
