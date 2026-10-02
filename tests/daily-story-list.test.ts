// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivedDailyStories, DailyModeCards } from "@/components/learn/DailyStoryList";
import type { DailyStorySummary } from "@/lib/learn/dailyStories";

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) =>
    React.createElement("a", { href, className }, children),
}));

afterEach(cleanup);

describe("DailyStoryList", () => {
  it("shows two current mode cards and keeps the published solo history link", () => {
    const day = "2026-09-30";
    const story = (mode: DailyStorySummary["mode"], headline: string): DailyStorySummary => ({
      dayKst: day, nickname: `${mode}-ranker`, mode, mapName: "Erangel", leaderboardRank: 1,
      publishedAt: `${day}T00:00:00.000Z`, kills: 4, damage: 1200, headline, conclusion: "기록된 경기 해설",
    });
    render(React.createElement(
      React.Fragment,
      null,
      React.createElement(DailyModeCards, {
        day,
        stories: [
          story("duo", "듀오 우승 경기"),
          story("squad", "스쿼드 우승 경기"),
          story("solo", "솔로 공개 경기"),
        ],
      }),
      React.createElement(ArchivedDailyStories, {
        stories: [story("solo", "솔로 공개 경기")],
        currentDay: day,
      }),
    ));

    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByText("듀오 · 2인 팀")).toBeTruthy();
    expect(screen.getByText("스쿼드 · 4인 팀")).toBeTruthy();
    expect(screen.queryByText("솔로 · 개인전")).toBeNull();
    expect(screen.getAllByText("착지부터 우승까지")).toHaveLength(2);
    const soloLink = document.querySelector<HTMLAnchorElement>(`a[href="/learn/daily/${day}/solo"]`);
    expect(soloLink?.textContent).toContain("솔로 공개 경기");
  });
});
