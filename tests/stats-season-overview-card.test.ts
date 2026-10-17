// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatsSeasonOverviewCard, seasonOverviewForResult } from "@/components/stat/overview/StatsSeasonOverviewCard";

afterEach(cleanup);

const stored = { nickname: "KangHeeSung_", seasonId: "division.bro.official.pc-2018-43", rounds: 126, wins: 5, avgDamage: 236, killsPerRound: 1.4 };
const seasons = [{ id: "division.bro.official.pc-2018-43", name: "Season 43" }];

describe("이번 시즌 전체 카드", () => {
  it("URL 플레이어와 같은 결과일 때만 시즌 이름을 붙여 쓴다", () => {
    expect(seasonOverviewForResult(stored, { nickname: "kangheesung_", seasons })).toEqual({ ...stored, seasonName: "Season 43" });
    expect(seasonOverviewForResult(stored, { nickname: "OtherPlayer", seasons })).toBeNull();
    expect(seasonOverviewForResult(undefined, { nickname: "KangHeeSung_", seasons })).toBeNull();
    expect(seasonOverviewForResult(stored, { nickname: "KangHeeSung_", seasons: [] })?.seasonName).toBeNull();
  });

  it("모든 모드 합계임을 밝히고 네 지표를 보여준다", () => {
    render(React.createElement(StatsSeasonOverviewCard, { season: { ...stored, seasonName: "Season 43" } }));
    expect(screen.getByRole("region", { name: "이번 시즌 전체" })).toBeTruthy();
    expect(screen.getByText(/Season 43의 경쟁전·일반전, 솔로·듀오·스쿼드를 모두 합친 기록/)).toBeTruthy();
    for (const value of ["126", "236", "1.4", "5"]) expect(screen.getByText(value)).toBeTruthy();
  });

  it("시즌 합계가 없으면 그리지 않는다", () => {
    const { container } = render(React.createElement(StatsSeasonOverviewCard, { season: null }));
    expect(container.innerHTML).toBe("");
  });
});
