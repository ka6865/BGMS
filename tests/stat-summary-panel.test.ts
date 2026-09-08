// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StatSummaryPanel, type StatSummaryPanelProps } from "@/components/stat/StatSummaryPanel";
import { buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";
import { buildRecentMatchOverview } from "@/lib/stats/recentMatchOverview";

function fixture(count = 20): StatSummaryPanelProps {
  const matchIds = Array.from({ length: count }, (_, i) => `match-${i}`);
  return {
    matchIds,
    summaryStatus: "ready",
    summaries: Object.fromEntries(matchIds.map((id, i) => {
      const match = buildBasicMatchSummary({ match_id: id, player_id: "player", platform: "steam", game_mode: "duo", match_type: "competitive", kills: i, damage: 100 + i, win_place: i + 1 });
      match.summarySource = "processed_match_telemetry";
      match.stats.assists = 1;
      match.stats.DBNOs = 2;
      return [id, match];
    })),
  };
}

describe("최근 20경기 요약", () => {
  afterEach(cleanup);

  it("최신 20개의 합계·평균을 집계하며 21번째 기록과 AI 요약을 표시하지 않는다", () => {
    render(createElement(StatSummaryPanel, fixture(21)));
    expect(screen.getByRole("heading", { name: "최근 20경기 요약" })).toBeInTheDocument();
    expect(screen.getByText(/20경기 집계/)).toBeInTheDocument();
    for (const [id, value] of Object.entries({ kills: "190", assists: "20", dbnos: "40", "average-rank": "10.5", "average-damage": "110", wins: "1", "win-rate": "5.0%", "top10-rate": "50.0%" })) {
      expect(screen.getByTestId(id)).toHaveTextContent(value);
    }
    expect(screen.queryByText("AI 한줄 요약")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /더보기/ })).not.toBeInTheDocument();
  });

  it("20경기 미만과 중복 ID는 실제 경기 수로 표시한다", () => {
    const input = fixture(4);
    input.matchIds = [...input.matchIds, input.matchIds[0]];
    render(createElement(StatSummaryPanel, input));
    expect(screen.getByText(/4경기 집계/)).toBeInTheDocument();
    expect(screen.getByTestId("kills")).toHaveTextContent("6");
  });

  it("일부 경기 누락은 조회 범위를 밝히며 누락 경기를 0으로 합산하지 않는다", () => {
    const input = fixture(20);
    delete input.summaries["match-0"];
    render(createElement(StatSummaryPanel, input));
    expect(screen.getByText(/19경기 집계/)).toBeInTheDocument();
    expect(screen.getByText(/20경기 중 19경기 조회됨 · 1경기 미확인/)).toBeInTheDocument();
    expect(screen.getByTestId("average-rank")).toHaveTextContent("11.0");
  });

  it('includes observed basic knocks in the recent twenty without inventing assists', () => {
    const input = fixture(2);
    input.summaries['match-0'] = buildBasicMatchSummary({ match_id: 'match-0', player_id: 'player', platform: 'steam', game_mode: 'duo', match_type: 'competitive', knocks: 3 });
    expect(buildRecentMatchOverview(input)).toMatchObject({ dbnos: 5, assists: null });
    input.summaries['match-0'].basicStats!.DBNOs = null;
    expect(buildRecentMatchOverview(input).dbnos).toBeNull();
  });

  it("기본 전적의 어시스트·기절 자리표시자 0은 관측값으로 쓰지 않는다", () => {
    const input = fixture(4);
    input.summaries["match-0"].summarySource = "pubg_player_matches";
    render(createElement(StatSummaryPanel, input));
    expect(screen.getByTestId("assists")).toHaveTextContent("—");
    expect(screen.getByTestId("dbnos")).toHaveTextContent("—");
    expect(screen.getByTestId("kills")).toHaveTextContent("6");
  });

  it("데스매치와 유형 미확인은 제외하고 기본 전적의 유형 보정은 반영한다", () => {
    const input = fixture(4);
    input.summaries["match-0"].gameMode = "tdm";
    input.summaries["match-1"].matchType = "unknown";
    input.matchModeMeta = { "match-2": { matchType: "official", gameMode: undefined } };
    const result = buildRecentMatchOverview(input);
    expect(result).toMatchObject({ matchCount: 2, excludedCount: 2, kills: 5, counts: { ranked: 1, normal: 1, casual: 0 } });
  });

  it("숫자가 잘못되거나 순위가 0이면 평균을 만들어내지 않는다", () => {
    const input = fixture(2);
    input.summaries["match-0"].stats.winPlace = 0;
    input.summaries["match-1"].stats.damageDealt = Number.NaN;
    expect(buildRecentMatchOverview(input)).toMatchObject({ wins: null, averageRank: null, top10Rate: null, averageDamage: null });
  });

  it.each(["loading", "error", "ready"] as const)("%s 상태에서 경기 정보가 없으면 숫자를 표시하지 않는다", (summaryStatus) => {
    render(createElement(StatSummaryPanel, { matchIds: ["missing"], summaries: {}, summaryStatus }));
    expect(screen.queryByTestId("kills")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(summaryStatus === "loading" ? "불러오는 중" : summaryStatus === "error" ? "불러오지 못했습니다" : "집계 가능한 배틀로얄 기록이 없습니다");
  });

  it("최근 경기 자체가 없을 때 빈 상태를 표시한다", () => {
    render(createElement(StatSummaryPanel, fixture(0)));
    expect(screen.getByText("최근 경기 기록이 없습니다.")).toBeInTheDocument();
  });
});
