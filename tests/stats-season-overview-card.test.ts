// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlayerStatsResponse } from "@/types/stats-page";
import { StatsSeasonOverviewCard, seasonOverviewForResult } from "@/components/stat/overview/StatsSeasonOverviewCard";

afterEach(cleanup);

const stored = { nickname: "KangHeeSung_", seasonId: "division.bro.official.pc-2018-43", rounds: 126, wins: 5, avgDamage: 236, killsPerRound: 1.4 };
const result = { seasonId: stored.seasonId, stats: {} };
const seasons = [{ id: "division.bro.official.pc-2018-43", name: "Season 43" }];

describe("이번 시즌 전체 카드", () => {
  it("URL 플레이어와 같은 결과일 때만 시즌 이름을 붙여 쓴다", () => {
    expect(seasonOverviewForResult(stored, { ...result, nickname: "kangheesung_", seasons })).toEqual({ ...stored, seasonName: "Season 43" });
    expect(seasonOverviewForResult(stored, { ...result, nickname: "OtherPlayer", seasons })).toBeNull();
    expect(seasonOverviewForResult(undefined, { ...result, nickname: "KangHeeSung_", seasons })).toBeNull();
    expect(seasonOverviewForResult(stored, { ...result, nickname: "KangHeeSung_", seasons: [] })?.seasonName).toBeNull();
  });

  it("갱신 결과 시즌 44의 모든 모드를 합산해 표시하고 기존 43 값을 교체한다", () => {
    const seasonId = "division.bro.official.pc-2018-44";
    const bucket = { roundsPlayed: 10, wins: 1, kills: 12, damageDealt: 2500, assists: 0, dBNOs: 0 };
    const refreshed: PlayerStatsResponse = {
      ...result, nickname: stored.nickname, platform: "steam", seasonId, recentMatches: [],
      seasons: [...seasons, { id: seasonId, name: "Season 44" }],
      stats: { ranked: { solo: bucket, duo: bucket, squad: bucket }, normal: { solo: bucket, duo: bucket, squad: bucket } },
      statsAvailability: { ranked: { status: "ready" }, normal: { status: "ready" } },
    };
    const overview = seasonOverviewForResult(stored, refreshed);
    expect(overview).toEqual({ nickname: stored.nickname, seasonId, seasonName: "Season 44", rounds: 60, wins: 6, avgDamage: 250, killsPerRound: 1.2 });
    render(React.createElement(StatsSeasonOverviewCard, { season: overview }));
    expect(screen.getByText(/Season 44의/)).toBeTruthy();
    expect(screen.queryByText(/Season 43의/)).toBeNull();
    expect(seasonOverviewForResult(stored, { ...refreshed, nickname: "OtherPlayer" })).toBeNull();
    expect(seasonOverviewForResult(stored, { ...refreshed, seasonId: stored.seasonId })?.rounds).toBe(60);
    expect(seasonOverviewForResult(stored, { ...refreshed, stats: { ranked: {}, normal: {} } })).toBeNull();
  });

  it("새 시즌 응답의 모드가 불완전하면 이전 시즌 카드를 숨긴다", () => {
    const incomplete = { ...result, nickname: stored.nickname, seasons, seasonId: "division.bro.official.pc-2018-44" };
    const { container } = render(React.createElement(StatsSeasonOverviewCard, { season: seasonOverviewForResult(stored, incomplete) }));
    expect(container.innerHTML).toBe("");
    expect(seasonOverviewForResult(stored, { ...incomplete, statsAvailability: { ranked: { status: "ready" }, normal: { status: "stale" } } })).toBeNull();
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
