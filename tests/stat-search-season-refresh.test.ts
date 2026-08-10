// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatSearch from "@/components/stat/StatSearch";
import playerReadyFixture from "./fixtures/stats/player-ready.json";
import summaryReady from "./fixtures/stats/matches-summary-ready.json";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
const storage = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => storage.set(key, String(value)),
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("@/components/AuthProvider", () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  },
}));

vi.mock("@/components/stat/MatchCard", () => ({ MatchCard: () => null }));
vi.mock("@/components/stat/StatSummaryPanel", () => ({ StatSummaryPanel: () => null }));
vi.mock("@/components/stat/RecentAISummary", () => ({ RecentAISummary: () => null }));
vi.mock("@/components/stat/SquadAnalysisPanel", () => ({
  default: () => createElement("div", null, "squad-panel"),
}));
vi.mock("@/components/ads/AdSenseBanner", () => ({ default: () => null }));
vi.mock("@/components/ads/AdfitBanner", () => ({ default: () => null }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("StatSearch season/refresh controller binding", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage.clear();
    window.history.replaceState(null, "", "/stats/steam/FixturePlayer");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", localStorageMock);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function playerRequests() {
    return fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/pubg/player?"),
    );
  }

  function stablePlayerParams(call: unknown[]) {
    const url = new URL(String(call[0]), "https://bgms.kr");
    url.searchParams.delete("_t");
    return url.searchParams;
  }

  function installReadyThen(nextPlayerResponse: Response) {
    let playerAttempt = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      playerAttempt += 1;
      return Promise.resolve(playerAttempt === 1
        ? jsonResponse({ ...playerReadyFixture, updatedAt: "2026-08-08T00:00:00.000Z" })
        : nextPlayerResponse);
    });
  }

  async function flushAsyncSearch() {
    await act(async () => {
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
  }

  it("deep-linked squad 초기 탭은 첫 route 검색 성공보다 우선한다", async () => {
    installReadyThen(jsonResponse(playerReadyFixture));

    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
      initialTab: "squad",
    }));

    await screen.findByText("FixturePlayer");
    expect(screen.getByRole("button", { name: "스쿼드 시너지" })).toHaveClass("border-purple-500");
    expect(playerRequests()).toHaveLength(1);
  });

  it("시즌 변경 실패는 기존 결과와 squad 탭을 유지한다", async () => {
    installReadyThen(jsonResponse({ error: "season fail" }, 500));
    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
    }));
    await screen.findByText("FixturePlayer");
    fireEvent.click(screen.getByRole("button", { name: "스쿼드 시너지" }));

    fireEvent.change(screen.getByRole("combobox", { name: "시즌 선택" }), {
      target: { value: "division.bro.official.pc-2026-07" },
    });

    await screen.findByText("season fail");
    expect(screen.getByText("FixturePlayer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "스쿼드 시너지" })).toHaveClass("border-purple-500");
    expect(playerRequests()).toHaveLength(2);
  });

  it("강제 갱신 성공은 overview로 돌아가고 실패는 squad와 기존 결과를 유지한다", async () => {
    installReadyThen(jsonResponse(playerReadyFixture));
    const firstView = render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
    }));
    await screen.findByText("FixturePlayer");
    fireEvent.click(screen.getByRole("button", { name: "스쿼드 시너지" }));
    fireEvent.click(screen.getByRole("button", { name: "전적 갱신" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "개인 분석 개요" })).toHaveClass("border-amber-500");
    });
    expect(playerRequests().filter(([input]) => String(input).includes("refresh=true"))).toHaveLength(1);
    firstView.unmount();

    installReadyThen(jsonResponse({ error: "refresh fail" }, 500));
    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
    }));
    await screen.findByText("FixturePlayer");
    fireEvent.click(screen.getByRole("button", { name: "스쿼드 시너지" }));
    fireEvent.click(screen.getByRole("button", { name: "전적 갱신" }));

    await screen.findByText("refresh fail");
    expect(screen.getByText("FixturePlayer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "스쿼드 시너지" })).toHaveClass("border-purple-500");
  });

  it("실패한 새 시즌 retry는 3초 전 0건, 이후 정확한 season URL 1건을 추가한다", async () => {
    let playerAttempt = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      playerAttempt += 1;
      return Promise.resolve(playerAttempt === 1
        ? jsonResponse({ ...playerReadyFixture, updatedAt: "2026-08-08T00:00:00.000Z" })
        : playerAttempt === 2
          ? jsonResponse({ error: "season exact fail" }, 500)
          : jsonResponse(playerReadyFixture));
    });
    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
    }));
    await screen.findByText("FixturePlayer");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));

    fireEvent.change(screen.getByRole("combobox", { name: "시즌 선택" }), {
      target: { value: "division.bro.official.pc-2026-07" },
    });
    await flushAsyncSearch();
    expect(screen.getByText("season exact fail")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "다시 시도" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(playerRequests()).toHaveLength(2);

    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeDisabled();
    expect(playerRequests()).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const enabledRetry = screen.getByRole("button", { name: "다시 시도" });
    expect(enabledRetry).toBeEnabled();
    fireEvent.click(enabledRetry);
    await flushAsyncSearch();
    expect(playerRequests()).toHaveLength(3);
    const failedParams = stablePlayerParams(playerRequests()[1]);
    const retriedParams = stablePlayerParams(playerRequests()[2]);
    expect(retriedParams.toString()).toBe(failedParams.toString());
    expect(Object.fromEntries(retriedParams)).toMatchObject({
      nickname: "FixturePlayer",
      platform: "steam",
      season: "division.bro.official.pc-2026-07",
    });
    expect(retriedParams.has("refresh")).toBe(false);
    expect(screen.queryByText("season exact fail")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "FixturePlayer" })).toBeInTheDocument();
    expect(screen.queryByText("전적을 새로고침하는 중")).not.toBeInTheDocument();
  });

  it("실패한 force refresh retry는 cooldown 이후 refresh=true URL을 정확히 재사용한다", async () => {
    let playerAttempt = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      playerAttempt += 1;
      return Promise.resolve(playerAttempt === 1
        ? jsonResponse({ ...playerReadyFixture, updatedAt: "2026-08-08T00:00:00.000Z" })
        : playerAttempt === 2
          ? jsonResponse({ error: "refresh exact fail" }, 500)
          : jsonResponse(playerReadyFixture));
    });
    render(createElement(StatSearch, {
      initialPlatform: "steam",
      initialNickname: "FixturePlayer",
    }));
    await screen.findByText("FixturePlayer");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));

    fireEvent.click(screen.getByRole("button", { name: "전적 갱신" }));
    await flushAsyncSearch();
    expect(screen.getByText("refresh exact fail")).toBeInTheDocument();
    expect(playerRequests().filter(([input]) => String(input).includes("refresh=true"))).toHaveLength(1);
    const retry = screen.getByRole("button", { name: "다시 시도" });
    fireEvent.click(retry);
    expect(playerRequests()).toHaveLength(2);

    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeDisabled();
    expect(playerRequests()).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const enabledRetry = screen.getByRole("button", { name: "다시 시도" });
    expect(enabledRetry).toBeEnabled();
    fireEvent.click(enabledRetry);
    await flushAsyncSearch();
    expect(playerRequests()).toHaveLength(3);
    const failedParams = stablePlayerParams(playerRequests()[1]);
    const retriedParams = stablePlayerParams(playerRequests()[2]);
    expect(retriedParams.toString()).toBe(failedParams.toString());
    expect(Object.fromEntries(retriedParams)).toMatchObject({
      nickname: "FixturePlayer",
      platform: "steam",
      season: "division.bro.official.pc-2026-08",
      refresh: "true",
    });
    expect(screen.queryByText("refresh exact fail")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "FixturePlayer" })).toBeInTheDocument();
    expect(screen.queryByText("전적을 새로고침하는 중")).not.toBeInTheDocument();
  });
});
