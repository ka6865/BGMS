// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import playerReady from "./fixtures/stats/player-ready.json";
import summaryReady from "./fixtures/stats/matches-summary-ready.json";
import { useStatsPageController } from "@/hooks/useStatsPageController";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function historyResponse(extra: Record<string, unknown> = {}) {
  return jsonResponse({
    matches: [],
    page: 1,
    pageSize: 20,
    totalCount: 0,
    totalPages: 0,
    ...extra,
  });
}

function playerResponse(nickname = "FixturePlayer") {
  return jsonResponse({ ...playerReady, nickname, recentMatches: [] });
}

describe("background result polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function flushAsync() {
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  }

  function installResponses(historyResponses: Record<string, unknown>[]) {
    let historyIndex = 0;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/player?")) return Promise.resolve(playerResponse());
      if (url === "/api/pubg/matches-summary") return Promise.resolve(jsonResponse(summaryReady));
      if (url.startsWith("/api/pubg/player/matches")) {
        const value = historyResponses[Math.min(historyIndex++, historyResponses.length - 1)];
        return Promise.resolve(historyResponse(value));
      }
      return Promise.resolve(jsonResponse({ error: "unexpected" }, 404));
    });
  }

  it("ignores internal discovery progress and does not poll for it", async () => {
    installResponses([{ historyIngest: { pendingCount: 2, unavailableCount: 0, lastSavedAt: null } }]);
    const hook = renderHook(() => useStatsPageController({
      initialNickname: "FixturePlayer",
      initialPlatform: "steam",
    }));
    await flushAsync();
    const historyRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith("/api/pubg/player/matches"));
    expect(historyRequests()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(historyRequests()).toHaveLength(1);
    expect("historyIngest" in hook.result.current).toBe(false);
  });

  it("polls performance-only pending rows and publishes the completed benchmark", async () => {
    const match = {
      match_id: "match-performance-pending",
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
    const performance = {
      tier: "A",
      score: 72,
      breakdown: { combat: 30, tactical: 23, survival: 19 },
    };
    const responses = [
      {
        matches: [match],
        page: 1,
        pageSize: 20,
        totalCount: 1,
        totalPages: 1,
        performanceStates: { [match.match_id]: "pending" },
      },
      {
        matches: [match],
        page: 1,
        pageSize: 20,
        totalCount: 1,
        totalPages: 1,
        performances: { [match.match_id]: performance },
        performanceStates: { [match.match_id]: "done" },
      },
    ];
    let historyIndex = 0;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/player?")) return Promise.resolve(playerResponse());
      if (url === "/api/pubg/matches-summary") return Promise.resolve(jsonResponse(summaryReady));
      if (url.startsWith("/api/pubg/player/matches")) {
        return Promise.resolve(jsonResponse(responses[Math.min(historyIndex++, responses.length - 1)]));
      }
      return Promise.resolve(jsonResponse({ error: "unexpected" }, 404));
    });

    const hook = renderHook(() => useStatsPageController({
      initialNickname: "FixturePlayer",
      initialPlatform: "steam",
    }));
    await flushAsync();
    const historyRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith("/api/pubg/player/matches"));
    expect(historyRequests()).toHaveLength(1);
    expect(hook.result.current.matchSummaries[match.match_id]?.performanceState).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await flushAsync();

    expect(historyRequests()).toHaveLength(2);
    expect(hook.result.current.matchSummaries[match.match_id]?.benchmark).toEqual(performance);
    expect(hook.result.current.matchSummaries[match.match_id]?.performanceState).toBe("done");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(historyRequests()).toHaveLength(2);
  });
});
