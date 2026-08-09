// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatSearch from "@/components/stat/StatSearch";
import { STORAGE_KEY_RECENT } from "@/lib/pubg-analysis/constants";
import playerReady from "./fixtures/stats/player-ready.json";
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

vi.mock("@/components/stat/MatchCard", () => ({
  MatchCard: () => null,
}));

vi.mock("@/components/stat/StatSummaryPanel", () => ({
  StatSummaryPanel: () => null,
}));

vi.mock("@/components/stat/RecentAISummary", () => ({
  RecentAISummary: () => null,
}));

vi.mock("@/components/stat/SquadAnalysisPanel", () => ({
  default: () => createElement("div", null, "squad-panel"),
}));

vi.mock("@/components/ads/AdSenseBanner", () => ({
  default: () => null,
}));

vi.mock("@/components/ads/AdfitBanner", () => ({
  default: () => null,
}));

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(call: unknown[]) {
  return String(call[0]);
}

describe("StatSearch baseline", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let pushStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", localStorageMock);
    window.history.replaceState(null, "", "/stats");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    pushStateSpy = vi.spyOn(window.history, "pushState");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const playerRequests = () => fetchMock.mock.calls.filter((call) =>
    requestUrl(call).startsWith("/api/pubg/player?"),
  );

  async function searchFor(platform: string, nickname: string) {
    fireEvent.change(screen.getByRole("combobox", { name: "" }), {
      target: { value: platform },
    });
    fireEvent.change(screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요"), {
      target: { value: nickname },
    });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    await screen.findByText(nickname);
  }

  it("빈 닉네임은 요청하지 않는다", () => {
    render(createElement(StatSearch));

    fireEvent.click(screen.getByRole("button", { name: "검색" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("검색 성공은 canonical URL과 string[] 최근검색을 한 번만 갱신한다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(playerReady));
    fetchMock.mockResolvedValueOnce(jsonResponse(summaryReady));
    render(createElement(StatSearch));

    await searchFor("steam", "FixturePlayer");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/stats/steam/FixturePlayer");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT)!)).toEqual(["FixturePlayer"]);
    expect(playerRequests()).toHaveLength(1);
  });

  it("로딩과 쿨다운 중 추가 submit을 차단한다", async () => {
    let resolvePlayer!: (response: Response) => void;
    const playerResponse = new Promise<Response>((resolve) => {
      resolvePlayer = resolve;
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      return playerResponse;
    });
    render(createElement(StatSearch));
    const input = screen.getByPlaceholderText("정확한 대소문자 닉네임을 입력하세요");
    fireEvent.change(input, { target: { value: "FixturePlayer" } });

    const searchButton = screen.getByRole("button", { name: "검색" });
    fireEvent.click(searchButton);
    fireEvent(searchButton, createEvent.click(searchButton));
    expect(playerRequests()).toHaveLength(1);

    resolvePlayer(jsonResponse(playerReady));
    await screen.findByText("FixturePlayer");
    const cooldownButton = screen.getByRole("button", { name: "쿨타임" });
    fireEvent(cooldownButton, createEvent.click(cooldownButton));

    expect(playerRequests()).toHaveLength(1);
  });

  it("시즌 변경이 성공하면 overview 탭으로 돌아간다", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/pubg/matches-summary")) {
        return Promise.resolve(jsonResponse(summaryReady));
      }
      return Promise.resolve(jsonResponse(playerReady));
    });
    render(createElement(StatSearch));
    await searchFor("steam", "FixturePlayer");

    fireEvent.click(screen.getByRole("button", { name: "스쿼드 시너지" }));
    expect(screen.getByRole("button", { name: "스쿼드 시너지" })).toHaveClass("border-purple-500");

    const seasonSelect = screen.getAllByRole("combobox")[1];
    fireEvent.change(seasonSelect, {
      target: { value: "division.bro.official.pc-2026-07" },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "개인 분석 개요" })).toHaveClass("border-amber-500");
    });
    expect(playerRequests()).toHaveLength(2);
  });
});
