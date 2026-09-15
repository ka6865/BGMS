// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import MatchPageClient from "@/app/stats/[platform]/[nickname]/matches/[matchId]/MatchPageClient";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => createElement("a", props, children),
}));

vi.mock("@/components/stat/MatchCard", () => ({
  MatchCard: ({ initialMatchData }: { initialMatchData: { benchmark?: { score: number }; performanceState?: string } }) => (
    createElement("div", { "data-testid": "match-card" },
      initialMatchData.benchmark ? `성과 ${initialMatchData.benchmark.score}` : "성과 없음",
      ` · ${initialMatchData.performanceState ?? "none"}`,
    )
  ),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const record = {
  match_id: "match-page-performance",
  player_id: "fixtureplayer",
  platform: "steam",
  played_at: "2026-09-12T00:00:00.000Z",
  game_mode: "squad-fpp",
  map_name: "Baltic_Main",
  kills: 2,
  damage: 300,
  win_place: 8,
  match_type: "official",
  knocks: 1,
  survival_time: 900,
};

describe("MatchPageClient performance refresh", () => {
  async function flushAsync() {
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refreshes a visible pending detail page until its server benchmark is available", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        matches: [record],
        performances: {},
        performanceStates: { [record.match_id]: "pending" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        matches: [record],
        performances: {
          [record.match_id]: {
            tier: "A",
            score: 72,
            breakdown: { combat: 30, tactical: 23, survival: 19 },
          },
        },
        performanceStates: { [record.match_id]: "done" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(MatchPageClient, {
      platform: "steam",
      nickname: "FixturePlayer",
      matchId: record.match_id,
    }));

    await flushAsync();
    expect(screen.getByTestId("match-card")).toHaveTextContent("성과 없음 · pending");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await flushAsync();
    expect(screen.getByTestId("match-card")).toHaveTextContent("성과 72 · done");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not request while the detail tab is hidden", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      matches: [record],
      performances: {},
      performanceStates: { [record.match_id]: "pending" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(MatchPageClient, {
      platform: "steam",
      nickname: "FixturePlayer",
      matchId: record.match_id,
    }));
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
