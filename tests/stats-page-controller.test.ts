// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import playerReadyFixture from "./fixtures/stats/player-ready.json";
import summaryReadyFixture from "./fixtures/stats/matches-summary-ready.json";
import type { PlayerStatsResponse } from "@/types/stats-page";

const { trackEventMock } = vi.hoisted(() => ({
  trackEventMock: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: trackEventMock,
}));

import { useStatsPageController } from "@/hooks/useStatsPageController";

const playerReady = playerReadyFixture as PlayerStatsResponse;
const summaryReady = summaryReadyFixture as unknown as {
  summaries: Record<string, unknown>;
  missingMatchIds: string[];
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function deferredResponse(body: PlayerStatsResponse) {
  let resolve!: () => void;
  let signal: AbortSignal | undefined;
  const promise = new Promise<Response>((done) => {
    resolve = () => done(jsonResponse(body));
  });

  return {
    fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal | undefined;
      return promise;
    },
    resolve,
    get signal() {
      return signal;
    },
  };
}

function playerRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).startsWith("/api/pubg/player?"),
  );
}

describe("useStatsPageController", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    trackEventMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("route identity가 바뀌면 이전 요청을 abort하고 늦은 응답을 무시한다", async () => {
    const playerA = { ...playerReady, nickname: "A", recentMatches: [] };
    const playerB = { ...playerReady, nickname: "B", recentMatches: [] };
    const first = deferredResponse(playerA);
    const second = deferredResponse(playerB);
    fetchMock
      .mockImplementationOnce(first.fetch)
      .mockImplementationOnce(second.fetch);

    const controller = renderHook(
      ({ initialNickname, initialPlatform }) => useStatsPageController({
        initialNickname,
        initialPlatform,
      }),
      { initialProps: { initialNickname: "A", initialPlatform: "steam" } },
    );
    await waitFor(() => expect(playerRequests(fetchMock)).toHaveLength(1));

    controller.rerender({ initialNickname: "B", initialPlatform: "steam" });
    await waitFor(() => expect(playerRequests(fetchMock)).toHaveLength(2));
    expect(first.signal?.aborted).toBe(true);

    await act(async () => second.resolve());
    await waitFor(() => expect(controller.result.current.result?.nickname).toBe("B"));
    await act(async () => first.resolve());

    expect(controller.result.current.result?.nickname).toBe("B");
    expect(trackEventMock).toHaveBeenCalledTimes(1);
  });

  it("StrictMode effect replay는 중단된 초기 route 요청을 안전하게 교체해 완료한다", async () => {
    const first = deferredResponse({ ...playerReady, recentMatches: [] });
    const second = deferredResponse({ ...playerReady, recentMatches: [] });
    fetchMock
      .mockImplementationOnce(first.fetch)
      .mockImplementationOnce(second.fetch);

    const { result } = renderHook(() => useStatsPageController({
      initialNickname: "FixturePlayer",
      initialPlatform: "steam",
    }), {
      reactStrictMode: true,
    });

    await waitFor(() => expect(playerRequests(fetchMock)).toHaveLength(2));
    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);

    await act(async () => second.resolve());
    await waitFor(() => expect(result.current.result?.nickname).toBe("FixturePlayer"));
    expect(result.current.status).toBe("ready");
    expect(trackEventMock).toHaveBeenCalledTimes(1);
  });

  it("갱신 실패는 기존 결과와 탭을 유지한다", async () => {
    const stalePlayer = { ...playerReady, updatedAt: "2026-08-08T00:00:00.000Z" };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      if (playerRequests(fetchMock).length === 1) {
        return Promise.resolve(jsonResponse(stalePlayer));
      }
      return Promise.resolve(jsonResponse({ error: "fail" }, 500));
    });
    const { result } = renderHook(() => useStatsPageController({
      initialNickname: "FixturePlayer",
      initialPlatform: "steam",
      initialTab: "squad",
    }));
    await waitFor(() => expect(result.current.result?.nickname).toBe("FixturePlayer"));
    expect(result.current.sectionTab).toBe("squad");

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.result?.nickname).toBe("FixturePlayer");
    expect(result.current.sectionTab).toBe("squad");
    expect(result.current.error?.type).toBe("server");
  });

  it("summary batch 실패는 프로필을 유지하고 재시도 가능한 partial로 둔다", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse({ error: "summary fail" }, 500));
      }
      return Promise.resolve(jsonResponse(playerReady));
    });
    const { result } = renderHook(() => useStatsPageController({
      initialNickname: "FixturePlayer",
      initialPlatform: "steam",
    }));

    await waitFor(() => expect(result.current.status).toBe("partial"));
    expect(result.current.partialReasons).toContain("summary_batch_failed");
    expect(result.current.summaryStatus).toBe("error");
    expect(result.current.result?.nickname).toBe("FixturePlayer");
  });

  it("summary retry는 batch partial을 지우고 매치 요약을 복구한다", async () => {
    let summaryAttempts = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        summaryAttempts += 1;
        return Promise.resolve(summaryAttempts === 1
          ? jsonResponse({ error: "summary fail" }, 500)
          : jsonResponse(summaryReady));
      }
      return Promise.resolve(jsonResponse(playerReady));
    });
    const { result } = renderHook(() => useStatsPageController({
      initialNickname: "FixturePlayer",
      initialPlatform: "steam",
    }));
    await waitFor(() => expect(result.current.summaryStatus).toBe("error"));

    await act(async () => {
      await result.current.retrySummaries();
    });

    expect(result.current.summaryStatus).toBe("ready");
    expect(result.current.partialReasons).not.toContain("summary_batch_failed");
    expect(result.current.matchSummaries["match-fixture-1"]?.matchId).toBe("match-fixture-1");
  });

  it("summary missing을 partial과 source-aware mode metadata로 보존한다", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse({
          summaries: summaryReady.summaries,
          missingMatchIds: ["match-missing"],
        }));
      }
      return Promise.resolve(jsonResponse({
        ...playerReady,
        recentMatches: ["match-fixture-1", "match-missing"],
      }));
    });
    const { result } = renderHook(() => useStatsPageController({
      initialNickname: "FixturePlayer",
      initialPlatform: "steam",
    }));

    await waitFor(() => expect(result.current.summaryStatus).toBe("ready"));
    expect(result.current.missingMatchIds).toEqual(new Set(["match-missing"]));
    expect(result.current.partialReasons).toContain("summary_missing");
    expect(result.current.matchModeMeta["match-fixture-1"]).toMatchObject({
      gameMode: "squad-fpp",
      matchType: "official",
      mapName: "Baltic_Main",
    });
  });

  it("loads all cached player matches page by page without another player API request", async () => {
    let historyCalls = 0;
    const historyRecord = (matchId: string, playedAt: string) => ({
      player_id: "fixtureplayer",
      platform: "steam",
      match_id: matchId,
      played_at: playedAt,
      game_mode: "squad-fpp",
      map_name: "Baltic_Main",
      kills: 2,
      damage: 240,
      win_place: 4,
      match_type: "competitive",
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/pubg/player/matches")) {
        historyCalls += 1;
        return Promise.resolve(jsonResponse({
          matches: [historyRecord(`history-${historyCalls}`, `2026-08-1${8 - historyCalls}T00:00:00Z`)],
          nextCursor: historyCalls === 1 ? "cursor-1" : null,
        }));
      }
      if (url.startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      return Promise.resolve(jsonResponse({ ...playerReady, recentMatches: [] }));
    });

    const { result } = renderHook(() => useStatsPageController({
      initialNickname: "FixturePlayer",
      initialPlatform: "steam",
    }));

    await waitFor(() => expect(result.current.result?.nickname).toBe("FixturePlayer"));
    await act(async () => {
      await result.current.loadMoreHistory();
    });
    await waitFor(() => expect(result.current.hasMoreHistory).toBe(true));
    expect(result.current.matchIds).toContain("history-1");
    expect(result.current.matchSummaries["history-1"]?.isSummary).toBe(true);

    await act(async () => {
      await result.current.loadMoreHistory();
    });

    await waitFor(() => expect(result.current.hasMoreHistory).toBe(false));
    expect(result.current.matchIds).toContain("history-2");
    expect(historyCalls).toBe(2);
  });

  it("404 추천과 반환 platform을 별도 상태로 보존한다", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      error: "not found",
      code: "PLAYER_NOT_FOUND",
      suggestions: [{ nickname: "FixtureAlt", platform: "kakao" }],
    }, 404));
    const { result } = renderHook(() => useStatsPageController({
      initialNickname: "MissingPlayer",
      initialPlatform: "steam",
    }));

    await waitFor(() => expect(result.current.error?.type).toBe("not_found"));
    expect(result.current.suggestedPlayers).toEqual([
      { nickname: "FixtureAlt", platform: "kakao" },
    ]);
  });

  it("429 Retry-After 동안 같은 identity만 재요청을 차단한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "slow down" }, 429, { "Retry-After": "30" }))
      .mockResolvedValueOnce(jsonResponse({ ...playerReady, nickname: "Other", recentMatches: [] }));
    const { result } = renderHook(() => useStatsPageController({}));

    await act(async () => {
      await result.current.search({ nickname: "FixturePlayer", platform: "steam" });
    });
    expect(result.current.error).toMatchObject({
      type: "rate_limit",
      retryAt: Date.parse("2026-08-10T00:00:30.000Z"),
    });

    await act(async () => {
      await result.current.search({ nickname: "FixturePlayer", platform: "steam" });
    });
    expect(playerRequests(fetchMock)).toHaveLength(1);

    await act(async () => {
      await result.current.search({ nickname: "Other", platform: "steam" });
    });
    expect(playerRequests(fetchMock)).toHaveLength(2);
    expect(result.current.result?.nickname).toBe("Other");
  });

  it("A 429 뒤 B 성공 후 retryAt 전에 A route로 돌아가면 B 상태를 비우고 A 요청만 막는다", async () => {
    const playerB = {
      ...playerReady,
      nickname: "PlayerB",
      updatedAt: new Date().toISOString(),
    };
    let playerAttempt = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      playerAttempt += 1;
      return Promise.resolve(playerAttempt === 1
        ? jsonResponse({ error: "slow down" }, 429, { "Retry-After": "60" })
        : jsonResponse(playerB));
    });

    const controller = renderHook(
      ({ initialNickname }) => useStatsPageController({
        initialNickname,
        initialPlatform: "steam",
      }),
      { initialProps: { initialNickname: "PlayerA" } },
    );
    await waitFor(() => expect(controller.result.current.error?.type).toBe("rate_limit"));

    controller.rerender({ initialNickname: "PlayerB" });
    await waitFor(() => expect(controller.result.current.summaryStatus).toBe("ready"));
    expect(controller.result.current.result?.nickname).toBe("PlayerB");
    expect(controller.result.current.matchSummaries["match-fixture-1"]).toBeDefined();
    expect(controller.result.current.isRefreshCoolingDown).toBe(true);

    controller.rerender({ initialNickname: "PlayerA" });
    await waitFor(() => expect(controller.result.current.error?.type).toBe("rate_limit"));

    expect(playerRequests(fetchMock)).toHaveLength(2);
    expect(controller.result.current.result).toBeNull();
    expect(controller.result.current.matchSummaries).toEqual({});
    expect(controller.result.current.missingMatchIds).toEqual(new Set());
    expect(controller.result.current.summaryStatus).toBe("idle");
    expect(controller.result.current.refreshAvailableAt).toBeUndefined();
    expect(controller.result.current.isRefreshCoolingDown).toBe(false);
    expect(controller.result.current.seasonId).toBe("");

    await act(async () => {
      await controller.result.current.search({ nickname: "PlayerA", platform: "steam" });
    });
    expect(playerRequests(fetchMock)).toHaveLength(2);
    expect(controller.result.current.error?.type).toBe("rate_limit");
  });

  it("한 행의 복구가 다른 행의 같은 partial reason을 지우지 않는다", () => {
    const { result } = renderHook(() => useStatsPageController({}));

    act(() => {
      result.current.reportPartial("detail_failed", "match:a");
      result.current.reportPartial("detail_failed", "match:b");
    });
    act(() => result.current.clearPartial("detail_failed", "match:a"));

    expect(result.current.partialReasons).toContain("detail_failed");
    act(() => result.current.clearPartial("detail_failed", "match:b"));
    expect(result.current.partialReasons).not.toContain("detail_failed");
  });

  it("성공 후 60초 동안 같은 player의 강제갱신을 막는다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    fetchMock.mockResolvedValue(jsonResponse({ ...playerReady, recentMatches: [] }));
    const { result } = renderHook(() => useStatsPageController({}));

    await act(async () => {
      await result.current.search({ nickname: "FixturePlayer", platform: "steam" });
    });
    expect(result.current.isRefreshCoolingDown).toBe(true);

    await act(async () => {
      await result.current.refresh();
    });
    expect(playerRequests(fetchMock).filter(([input]) => String(input).includes("refresh=true"))).toHaveLength(0);

    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.isRefreshCoolingDown).toBe(false);
  });

  it("같은 진행 중 요청은 동일 Promise를 반환하고 빈 nickname은 요청하지 않는다", async () => {
    const pending = deferredResponse({ ...playerReady, recentMatches: [] });
    fetchMock.mockImplementation(pending.fetch);
    const { result } = renderHook(() => useStatsPageController({}));
    let first!: Promise<PlayerStatsResponse | null>;
    let second!: Promise<PlayerStatsResponse | null>;

    act(() => {
      first = result.current.search({ nickname: "FixturePlayer", platform: "steam" });
      second = result.current.search({ nickname: "FixturePlayer", platform: "steam" });
    });
    expect(first).toBe(second);
    expect(playerRequests(fetchMock)).toHaveLength(1);

    await act(async () => pending.resolve());
    await act(async () => {
      await result.current.search({ nickname: "   ", platform: "steam" });
    });
    expect(playerRequests(fetchMock)).toHaveLength(1);
  });

  it("로딩 중 사용자 검색은 다른 요청으로 교체하지 않는다", async () => {
    const pending = deferredResponse({ ...playerReady, recentMatches: [] });
    fetchMock.mockImplementation(pending.fetch);
    const { result } = renderHook(() => useStatsPageController({}));
    let first!: Promise<PlayerStatsResponse | null>;
    let blocked!: Promise<PlayerStatsResponse | null>;

    act(() => {
      first = result.current.search({ nickname: "FixturePlayer", platform: "steam" });
      blocked = result.current.search({ nickname: "OtherPlayer", platform: "steam" });
    });

    expect(playerRequests(fetchMock)).toHaveLength(1);
    expect(pending.signal?.aborted).toBe(false);
    await expect(blocked).resolves.toBeNull();
    await act(async () => pending.resolve());
    await expect(first).resolves.toMatchObject({ nickname: "FixturePlayer" });
  });
});
