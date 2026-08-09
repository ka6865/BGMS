// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function playerRequests() {
    return fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/pubg/player?"),
    );
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

    fireEvent.change(screen.getAllByRole("combobox")[1], {
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
});
