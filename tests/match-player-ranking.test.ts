// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { MatchReport } from "@/lib/pubg-analysis/matchReport";
import { MatchPlayerRankingContent, playerRankSummary } from "@/components/stat/matches/MatchReportSections";

afterEach(cleanup);

const player = (name: string, kills: number, damage: number, knocks: number, longestDown: number, isBot = false) =>
  ({ name, kills, damage, knocks, longestDown, isBot });

const report = {
  teams: [
    { teamId: 1, rank: 1, kills: 0, damage: 0, isMine: true, players: [player("Me", 1, 300, 2, 40), player("Mate", 3, 250, 1, 180)] },
    { teamId: 2, rank: 2, kills: 0, damage: 0, isMine: false, players: [
      player("A", 6, 900, 5, 320), player("B", 5, 700, 4, 90), player("C", 4, 600, 6, 60), player("D", 2, 100, 0, 30),
      player("Bot_1", 9, 999, 9, 999, true),
    ] },
  ],
} as unknown as MatchReport;

describe("개인 성적", () => {
  it("탭마다 봇을 뺀 상위 5명과 5위 밖의 내 줄을 보여 준다", () => {
    render(createElement(MatchPlayerRankingContent, { report, nickname: "me" }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["킬", "기절", "피해량", "최장 기절·킬"]);
    expect(screen.queryByText("Bot_1")).not.toBeInTheDocument();
    expect(screen.getByText("봇 제외 6명 중 6위 · 상위 100%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "최장 기절·킬" }));
    const list = screen.getByRole("list", { name: "최장 기절·킬 순위" });
    expect(within(list).getByText("320m")).toBeInTheDocument();
    expect(within(list).getByText("Me").closest("li")).toHaveTextContent("40m");
  });

  it("헤더 요약은 최장 기절·킬을 빼고 보여 준다", () => {
    expect(playerRankSummary(report, "Me")).toBe("킬 6위 · 기절 4위 · 피해량 4위");
  });
});
